//! Golden vector runner: feeds every `vectors/**\/*.cmd.jsonl` through
//! OrderBook, serializes events canonically, diffs against `*.evt.jsonl`.
//! Vectors with `"index":"both"` must produce identical streams under the
//! ladder and tree indexes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BookConfig, OrderBook } from "../src/book";
import { Engine } from "../src/engine";
import { IndexKind } from "../src/priceindex";
import { VecSink } from "../src/sink";
import {
  Command,
  OType,
  Side,
  Symbol,
  Tif,
  eventCanonical,
  sideFromStr,
} from "../src/types";
import { getI64, getStr } from "../src/jsonflat";

const VECTORS_DIR = join(__dirname, "..", "..", "vectors");

interface VectorMeta {
  file: string;
}

interface Header {
  name: string;
  pmin: number;
  pmax: number;
  maxOrders: number;
  index: IndexKind;
  engine: boolean;
}

function parseHeader(line: string, mode: IndexKind): Header {
  return {
    name: getStr(line, "name") ?? "?",
    pmin: getI64(line, "pmin") ?? 0,
    pmax: getI64(line, "pmax") ?? 0,
    maxOrders: getI64(line, "max_orders") ?? 65536,
    index: mode,
    engine: getStr(line, "engine") === "true",
  };
}

function parseCommand(line: string): [Symbol, Command] {
  const sym = getI64(line, "symbol") ?? 0;
  const cmd = getStr(line, "cmd");
  switch (cmd) {
    case "new": {
      const side = sideFromStr(getStr(line, "side"));
      const otype = getStr(line, "otype") === "market" ? OType.Market : OType.Limit;
      const tifStr = getStr(line, "tif") ?? "gtc";
      const tif =
        tifStr === "ioc" ? Tif.Ioc :
        tifStr === "fok" ? Tif.Fok :
        tifStr === "post_only" ? Tif.PostOnly : Tif.Gtc;
      return [sym, {
        kind: "new",
        orderId: getI64(line, "order_id")!,
        side: side ?? Side.Bid,
        otype,
        price: getI64(line, "price") ?? 0,
        qty: getI64(line, "qty")!,
        tif,
      }];
    }
    case "cancel":
      return [sym, { kind: "cancel", orderId: getI64(line, "order_id")! }];
    case "replace":
      return [sym, {
        kind: "replace",
        orderId: getI64(line, "order_id")!,
        price: getI64(line, "price") ?? 0,
        qty: getI64(line, "qty")!,
      }];
    default:
      throw new Error(`unknown cmd in line: ${line}`);
  }
}

function runVector(cmdPath: string, mode: IndexKind): string {
  const lines = readFileSync(cmdPath, "utf8").split("\n").filter((l) => l.length > 0);
  const h = parseHeader(lines[0], mode);
  const cfg: BookConfig = {
    priceMin: h.pmin,
    priceMax: h.pmax,
    maxOrders: h.maxOrders,
    index: h.index,
  };
  if (h.engine) {
    const eng = new Engine(cfg);
    const out: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const [sym, cmd] = parseCommand(lines[i]);
      eng.apply(sym, cmd, {
        onEvent: (seq, ev) => out.push(eventCanonical(seq, ev, sym)),
      });
    }
    return out.join("\n") + "\n";
  }
  const book = new OrderBook(cfg);
  const sink = new VecSink();
  for (let i = 1; i < lines.length; i++) {
    book.apply(parseCommand(lines[i])[1], sink);
  }
  return sink.canonical();
}

function main(): void {
  const manifest = JSON.parse(readFileSync(join(VECTORS_DIR, "manifest.json"), "utf8"));
  let checked = 0;
  let failed = 0;

  for (const v of manifest.vectors as VectorMeta[]) {
    const cmdPath = join(VECTORS_DIR, v.file + ".cmd.jsonl");
    const evtPath = join(VECTORS_DIR, v.file + ".evt.jsonl");
    const expected = readFileSync(evtPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .slice(1)
      .join("\n") + "\n";

    // Index mode comes from the vector header, not the manifest.
    const headerLine = readFileSync(cmdPath, "utf8").split("\n")[0];
    const mode = getStr(headerLine, "index") ?? "ladder";
    const modes: IndexKind[] =
      mode === "tree" ? [IndexKind.Tree] :
      mode === "both" ? [IndexKind.Ladder, IndexKind.Tree] :
      [IndexKind.Ladder];

    for (const mode of modes) {
      let actual: string;
      try {
        actual = runVector(cmdPath, mode);
      } catch (e) {
        console.log(`FAIL ${v.file} [${IndexKind[mode]}]: threw ${e}`);
        failed++;
        continue;
      }
      if (actual !== expected) {
        console.log(`FAIL ${v.file} [${IndexKind[mode]}]: golden mismatch`);
        const el = expected.split("\n"), al = actual.split("\n");
        for (let i = 0; i < Math.max(el.length, al.length); i++) {
          if (el[i] !== al[i]) {
            console.log(`  line ${i + 2}:\n    expected ${el[i] ?? "<none>"}\n    actual   ${al[i] ?? "<none>"}`);
          }
        }
        failed++;
      } else {
        checked++;
      }
    }
  }

  if (failed > 0) {
    console.log(`golden: ${checked} ok, ${failed} FAILED`);
    process.exit(1);
  }
  console.log(`golden: ${checked} vectors passed`);
}

main();
