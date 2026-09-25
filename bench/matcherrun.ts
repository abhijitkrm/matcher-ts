//! matcherrun — e2e runner: apply an engine command stream, emit the canonical
//! tagged event journal to stdout, optionally write a snapshot at the end.
//!   node dist/bench/matcherrun.js <engine.cmd.jsonl> [--snap <path>]
import { readFileSync, writeFileSync } from "node:fs";
import { Engine } from "../src/engine";
import { BookConfig } from "../src/book";
import { IndexKind } from "../src/priceindex";
import { writeEngine } from "../src/snapshot";
import { journalEvent } from "../src/journal";
import { Command, Symbol, Side, OType, Tif } from "../src/types";
import { getI64, getStr } from "../src/jsonflat";

export function parseCmd(line: string): [Symbol, Command] | undefined {
  const sym = getI64(line, "symbol") ?? 0;
  switch (getStr(line, "cmd")) {
    case "new": {
      const t = getStr(line, "tif") ?? "gtc";
      const tif =
        t === "ioc" ? Tif.Ioc : t === "fok" ? Tif.Fok : t === "post_only" ? Tif.PostOnly : Tif.Gtc;
      return [sym, {
        kind: "new",
        orderId: getI64(line, "order_id")!,
        side: getStr(line, "side") === "ask" ? Side.Ask : Side.Bid,
        otype: getStr(line, "otype") === "market" ? OType.Market : OType.Limit,
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
      return undefined;
  }
}

export function parseHeader(line: string): BookConfig {
  return {
    priceMin: getI64(line, "pmin") ?? 0,
    priceMax: getI64(line, "pmax") ?? 1_000_000,
    maxOrders: getI64(line, "max_orders") ?? 65_536,
    index: getStr(line, "index") === "tree" ? IndexKind.Tree : IndexKind.Ladder,
  };
}

if (require.main === module) {
  const path = process.argv[2];
  const snapIdx = process.argv.indexOf("--snap");
  const snapPath = snapIdx >= 0 ? process.argv[snapIdx + 1] : undefined;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
  const eng = new Engine(parseHeader(lines[0]));
  const write = (l: string) => process.stdout.write(l);
  for (let i = 1; i < lines.length; i++) {
    const parsed = parseCmd(lines[i]);
    if (parsed === undefined) {
      console.error(`${path}:${i + 1}: malformed command: ${lines[i]}`);
      process.exit(2);
    }
    eng.applyTagged(parsed[0], parsed[1], (s, seq, ev) => journalEvent(s, seq, ev, write));
  }
  if (snapPath !== undefined) writeFileSync(snapPath, writeEngine(eng));
}
