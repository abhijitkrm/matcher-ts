//! matcherbench — spec/BENCH.md measurement protocol (v2).
//!
//!   matcherbench <corpus-prefix> [--tag name] [--mode latency|throughput|scale]
//!                [--threads N] [--reps R] [--lookahead on|off|auto]
//!
//!   latency    (default) per-op timed apply(); row as BENCH.md §3.
//!   throughput untimed applyBatch() over the whole run, best/median of R reps.
//!   scale      N worker_threads, each loading the corpus and owning a private
//!              book replaying it as its own symbol partition (SCALING.md);
//!              aggregate ops/s = N*ops / slowest worker's wall time.
//!
//! Loads `<prefix>.setup.cmd.jsonl` (untimed) + `<prefix>.run.cmd.jsonl`.

import { availableParallelism, cpus } from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { readLines } from "./lines";
import { BookConfig, OrderBook } from "../src/book";
import { IndexKind } from "../src/priceindex";
import { NullSink } from "../src/sink";
import { Command, OType, Side, Tif, sideFromStr } from "../src/types";
import { getI64, getStr } from "../src/jsonflat";

function parseCommand(line: string): Command {
  const cmd = getStr(line, "cmd");
  if (cmd === "new") {
    const tifStr = getStr(line, "tif") ?? "gtc";
    return {
      kind: "new",
      orderId: getI64(line, "order_id")!,
      side: sideFromStr(getStr(line, "side")) ?? Side.Bid,
      otype: getStr(line, "otype") === "market" ? OType.Market : OType.Limit,
      price: getI64(line, "price") ?? 0,
      qty: getI64(line, "qty")!,
      tif: tifStr === "ioc" ? Tif.Ioc : tifStr === "fok" ? Tif.Fok : tifStr === "post_only" ? Tif.PostOnly : Tif.Gtc,
    };
  }
  if (cmd === "cancel") return { kind: "cancel", orderId: getI64(line, "order_id")! };
  return { kind: "replace", orderId: getI64(line, "order_id")!, price: getI64(line, "price") ?? 0, qty: getI64(line, "qty")! };
}

function load(path: string): { cfg: BookConfig; cmds: Command[] } {
  const lines = readLines(path);
  const h = lines[0];
  const cfg: BookConfig = {
    priceMin: getI64(h, "pmin") ?? 0,
    priceMax: getI64(h, "pmax") ?? 0,
    maxOrders: getI64(h, "max_orders") ?? 65536,
    index: getStr(h, "index") === "tree" ? IndexKind.Tree : IndexKind.Ladder,
  };
  return { cfg, cmds: lines.slice(1).map(parseCommand) };
}

function loadCorpus(prefix: string) {
  const { cfg, cmds: setup } = load(`${prefix}.setup.cmd.jsonl`);
  const { cmds: run } = load(`${prefix}.run.cmd.jsonl`);
  return { cfg, setup, run };
}

const now = (): number => Number(process.hrtime.bigint());

// Full GC before each timed section. Building a book allocates large
// ArrayBuffers; the external-memory pressure starts incremental marking of
// the (large) parsed corpus, which would otherwise finalize inside the timed
// run. Exposed without a command-line flag via the usual vm trick.
setFlagsFromString("--expose-gc");
// TurboFan stops inlining into replace()/cross() at its default cumulative
// budget (920 bytecodes); 2000 is +5-13% on W3/W4/W5 (see docs/RESULTS.md).
setFlagsFromString("--max-inlined-bytecode-size-cumulative=2000");
const fullGc = runInNewContext("gc") as () => void;

function pct(s: Float64Array, p: number): number {
  if (s.length === 0) return 0;
  const i = Math.floor((s.length - 1) * p + 0.999999);
  return s[Math.min(i, s.length - 1)];
}

// --lookahead on|off|auto (default auto = the book's own 524288-live
// threshold). Passed to scale workers through the environment.
function newBook(cfg: BookConfig): OrderBook {
  const book = new OrderBook(cfg);
  const la = process.env.MATCHER_LOOKAHEAD;
  if (la === "on") book.setPrefetchThreshold(0);
  else if (la === "off") book.setPrefetchThreshold(Infinity);
  book.prefault();
  return book;
}

const batch = (book: OrderBook, cmds: Command[], sink: NullSink): void => book.applyBatch(cmds, sink);

/// One untimed batched replay on a fresh book; returns run wall ns.
function replay(cfg: BookConfig, setup: Command[], run: Command[], acc: { v: number }): number {
  const book = newBook(cfg);
  const sink = new NullSink();
  batch(book, setup, sink);
  fullGc();
  const t0 = now();
  batch(book, run, sink);
  const ns = now() - t0;
  acc.v = (acc.v + sink.acc) | 0;
  return ns;
}

function latencyMode(tag: string, cfg: BookConfig, setup: Command[], run: Command[]): void {
  {
    const book = new OrderBook(cfg);
    const sink = new NullSink();
    for (const c of setup) book.apply(c, sink);
    for (let i = 0; i < Math.floor(run.length / 10); i++) book.apply(run[i], sink);
  }
  const book = newBook(cfg);
  const sink = new NullSink();
  for (const c of setup) book.apply(c, sink);
  fullGc();

  const lat = new Float64Array(run.length);
  const hr = process.hrtime.bigint;
  const w0 = hr();
  for (let i = 0; i < run.length; i++) {
    const a = hr();
    book.apply(run[i], sink);
    lat[i] = Number(hr() - a);
  }
  const wallNs = Number(hr() - w0);
  lat.sort();
  let sum = 0;
  for (let i = 0; i < lat.length; i++) sum += lat[i];
  const ops = run.length;
  console.log(
    `| ${tag} | ${ops} | ${(ops / (wallNs / 1e9)).toFixed(0)} | ${Math.floor(sum / ops)} | ` +
      `${pct(lat, 0.5)} | ${pct(lat, 0.9)} | ${pct(lat, 0.99)} | ${pct(lat, 0.999)} | ${lat[lat.length - 1]} |`,
  );
  if (sink.acc === 0x7fffffff) console.error("checksum", sink.acc);
}

function throughputMode(tag: string, cfg: BookConfig, setup: Command[], run: Command[], reps: number): void {
  const acc = { v: 0 };
  const t: number[] = [];
  replay(cfg, setup, run, acc); // warmup
  for (let r = 0; r < reps; r++) t.push(replay(cfg, setup, run, acc));
  t.sort((a, b) => a - b);
  const ops = run.length;
  const med = t[t.length >> 1];
  console.log(
    `| ${tag} | throughput | 1 | ${ops} | ${(ops / (t[0] / 1e9)).toFixed(0)} | ` +
      `${(ops / (med / 1e9)).toFixed(0)} | ${(med / ops).toFixed(2)} |`,
  );
  if (acc.v === 0x7fffffff) console.error("checksum", acc.v);
}

// ---- scale: one worker per shard, barrier on a SharedArrayBuffer -----------
//
// ctl[0] = workers ready for the current rep, ctl[1] = go generation,
// ctl[2] = workers finished. Each worker parses the corpus itself, then per
// rep: build + prefault + setup its own book, check in, wait for `go`, time
// the run.

interface ScaleInit {
  prefix: string;
  reps: number;
  ctl: SharedArrayBuffer;
  wall: SharedArrayBuffer;
  id: number;
}

function scaleWorker(w: ScaleInit): void {
  const ctl = new Int32Array(w.ctl);
  const wall = new Float64Array(w.wall);
  const { cfg, setup, run } = loadCorpus(w.prefix);
  for (let r = 0; r <= w.reps; r++) {
    const book = newBook(cfg);
    const sink = new NullSink();
    batch(book, setup, sink);
    fullGc();
    Atomics.add(ctl, 0, 1);
    Atomics.notify(ctl, 0);
    while (Atomics.load(ctl, 1) <= r) Atomics.wait(ctl, 1, r);
    const t0 = now();
    batch(book, run, sink);
    wall[w.id] = now() - t0;
    if (sink.acc === 0x7fffffff) console.error("checksum", sink.acc);
    Atomics.add(ctl, 2, 1);
    Atomics.notify(ctl, 2);
  }
}

function waitCount(ctl: Int32Array, i: number, want: number): void {
  for (;;) {
    const v = Atomics.load(ctl, i);
    if (v >= want) return;
    Atomics.wait(ctl, i, v, 50);
  }
}

function scaleMode(tag: string, prefix: string, ops: number, threads: number, reps: number): void {
  const ctl = new Int32Array(new SharedArrayBuffer(16));
  const wall = new Float64Array(new SharedArrayBuffer(8 * threads));
  const workers: Worker[] = [];
  for (let t = 0; t < threads; t++) {
    const init: ScaleInit = { prefix, reps, ctl: ctl.buffer as SharedArrayBuffer, wall: wall.buffer as SharedArrayBuffer, id: t };
    const wk = new Worker(__filename, { workerData: init, execArgv: process.execArgv });
    wk.on("error", (e) => {
      console.error(e);
      process.exit(1);
    });
    workers.push(wk);
  }
  const agg: number[] = [];
  for (let r = 0; r <= reps; r++) {
    // rep 0 is warmup
    waitCount(ctl, 0, threads * (r + 1));
    Atomics.store(ctl, 1, r + 1);
    Atomics.notify(ctl, 1);
    waitCount(ctl, 2, threads * (r + 1));
    if (r > 0) {
      let slow = 0;
      for (let t = 0; t < threads; t++) slow = Math.max(slow, wall[t]);
      agg.push((threads * ops) / (slow / 1e9));
    }
  }
  for (const wk of workers) void wk.terminate();
  agg.sort((a, b) => a - b);
  const med = agg[agg.length >> 1];
  console.log(
    `| ${tag} | scale | ${threads} | ${ops} | ${agg[agg.length - 1].toFixed(0)} | ` +
      `${med.toFixed(0)} | ${(med / threads).toFixed(0)} |`,
  );
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error(
      "usage: matcherbench <corpus-prefix> [--tag name] [--mode latency|throughput|scale] [--threads N] [--reps R] [--lookahead on|off|auto]",
    );
    process.exit(2);
  }
  const prefix = args[0];
  let tag = prefix.slice(prefix.lastIndexOf("/") + 1);
  let mode = "latency";
  let threads = typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
  let reps = 5;
  for (let i = 1; i + 1 < args.length; i++) {
    const a = args[i];
    if (a === "--tag") tag = args[i + 1];
    else if (a === "--mode") mode = args[i + 1];
    else if (a === "--threads") threads = Math.max(1, parseInt(args[i + 1], 10));
    else if (a === "--lookahead") process.env.MATCHER_LOOKAHEAD = args[i + 1];
    else if (a === "--reps") reps = Math.max(1, parseInt(args[i + 1], 10));
  }

  if (mode === "scale") {
    // Workers parse the corpus themselves; the main thread only needs the count.
    const ops = readLines(`${prefix}.run.cmd.jsonl`).length - 1;
    scaleMode(tag, prefix, ops, threads, reps);
  } else {
    const { cfg, setup, run } = loadCorpus(prefix);
    if (mode === "throughput") throughputMode(tag, cfg, setup, run, reps);
    else latencyMode(tag, cfg, setup, run);
  }
  console.error(`env: ${process.arch} / ${process.platform} / node ${process.version} (${mode})`);
}

if (isMainThread) main();
else scaleWorker(workerData as ScaleInit);
