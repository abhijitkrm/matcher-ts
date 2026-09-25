//! snapdump — apply an engine command stream, print the snapshot to stdout.
//! Cross-language snapshot parity check (spec/JOURNAL.md).
//!   node dist/bench/matchersnap.js <engine.cmd.jsonl>
import { readFileSync } from "node:fs";
import { Engine } from "../src/engine";
import { BookConfig } from "../src/book";
import { IndexKind } from "../src/priceindex";
import { writeEngine } from "../src/snapshot";
import { Command, Symbol, Side, OType, Tif } from "../src/types";
import { getI64, getStr } from "../src/jsonflat";

function parseCommand(line: string): [Symbol, Command] {
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
    default:
      return [sym, {
        kind: "replace",
        orderId: getI64(line, "order_id")!,
        price: getI64(line, "price") ?? 0,
        qty: getI64(line, "qty")!,
      }];
  }
}

const lines = readFileSync(process.argv[2], "utf8")
  .split("\n")
  .filter((l) => l.length > 0);
const h = lines[0];
const cfg: BookConfig = {
  priceMin: getI64(h, "pmin") ?? 0,
  priceMax: getI64(h, "pmax") ?? 1_000_000,
  maxOrders: getI64(h, "max_orders") ?? 65_536,
  index: getStr(h, "index") === "tree" ? IndexKind.Tree : IndexKind.Ladder,
};
const eng = new Engine(cfg);
for (const line of lines.slice(1)) {
  const [sym, cmd] = parseCommand(line);
  eng.applyTagged(sym, cmd, () => {});
}
process.stdout.write(writeEngine(eng));
