//! matcherbench — spec/BENCH.md measurement protocol.
//!
//!   matcherbench <corpus-prefix> [--tag name]
//!
//! Loads `<prefix>.setup.cmd.jsonl` (untimed) + `<prefix>.run.cmd.jsonl`
//! (measured ops). Reports ops/s and p50/p99/max per-command latency.

import { readFileSync } from "node:fs";
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
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  const h = lines[0];
  const cfg: BookConfig = {
    priceMin: getI64(h, "pmin") ?? 0,
    priceMax: getI64(h, "pmax") ?? 0,
    maxOrders: getI64(h, "max_orders") ?? 65536,
    index: getStr(h, "index") === "tree" ? IndexKind.Tree : IndexKind.Ladder,
  };
  return { cfg, cmds: lines.slice(1).map(parseCommand) };
}

function pct(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("usage: matcherbench <corpus-prefix> [--tag name]");
    process.exit(2);
  }
  const prefix = args[0];
  const tagI = args.indexOf("--tag");
  const tag = tagI >= 0 ? args[tagI + 1] : "matcher-ts";

  const { cfg, cmds: setup } = load(`${prefix}.setup.cmd.jsonl`);
  const { cmds: run } = load(`${prefix}.run.cmd.jsonl`);

  // Warmup: throwaway book, setup + first 10% of run.
  {
    const book = new OrderBook(cfg);
    const sink = new NullSink();
    for (const c of setup) book.apply(c, sink);
    for (const c of run.slice(0, Math.floor(run.length / 10))) book.apply(c, sink);
  }

  const book = new OrderBook(cfg);
  const sink = new NullSink();
  for (const c of setup) book.apply(c, sink);

  const lat = new Float64Array(run.length);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < run.length; i++) {
    const a = process.hrtime.bigint();
    book.apply(run[i], sink);
    lat[i] = Number(process.hrtime.bigint() - a);
  }
  const totalNs = Number(process.hrtime.bigint() - t0);

  lat.sort();
  const ops = (run.length / totalNs) * 1e9;
  console.log(
    `${tag}: ${run.length} ops in ${(totalNs / 1e6).toFixed(1)}ms` +
      ` => ${Math.round(ops).toLocaleString("en-US")} ops/s` +
      ` p50=${pct(lat, 50).toFixed(0)}ns p99=${pct(lat, 99).toFixed(0)}ns` +
      ` max=${pct(lat, 100).toFixed(0)}ns checksum=${sink.acc}`,
  );
}

main();
