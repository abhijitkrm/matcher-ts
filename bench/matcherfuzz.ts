//! matcherfuzz <corpus.cmd.jsonl> — replay a fuzzgen corpus, print the
//! canonical event stream (symbol-tagged for engine corpora) to stdout.
//! scripts/diffuzz.sh byte-diffs this output across implementations.

import { readLines } from "./lines";
import { BookConfig, OrderBook } from "../src/book";
import { Engine } from "../src/engine";
import { IndexKind } from "../src/priceindex";
import { Command, OType, Side, Symbol, Tif, eventCanonical, sideFromStr } from "../src/types";
import { getI64, getStr } from "../src/jsonflat";

function parseCommand(line: string): [Symbol, Command] {
  const sym = getI64(line, "symbol") ?? 0;
  const cmd = getStr(line, "cmd");
  switch (cmd) {
    case "new": {
      const t = getStr(line, "tif") ?? "gtc";
      return [sym, {
        kind: "new",
        orderId: getI64(line, "order_id")!,
        side: sideFromStr(getStr(line, "side")) ?? Side.Bid,
        otype: getStr(line, "otype") === "market" ? OType.Market : OType.Limit,
        price: getI64(line, "price") ?? 0,
        qty: getI64(line, "qty")!,
        tif: t === "ioc" ? Tif.Ioc : t === "fok" ? Tif.Fok : t === "post_only" ? Tif.PostOnly : Tif.Gtc,
      }];
    }
    case "cancel":
      return [sym, { kind: "cancel" as const, orderId: getI64(line, "order_id")! }] as const;
    case "replace":
      return [sym, {
        kind: "replace" as const,
        orderId: getI64(line, "order_id")!,
        price: getI64(line, "price") ?? 0,
        qty: getI64(line, "qty")!,
      }] as const;
    default:
      throw new Error(`bad command line: ${line}`);
  }
}

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: matcherfuzz <cmd.jsonl>");
    process.exit(2);
  }
  const lines = readLines(path, true);
  const hdr = lines[0];
  const cfg: BookConfig = {
    priceMin: getI64(hdr, "pmin") ?? 0,
    priceMax: getI64(hdr, "pmax") ?? 1_000_000,
    maxOrders: getI64(hdr, "max_orders") ?? 65536,
    index: IndexKind.Ladder,
  };
  const engine = getStr(hdr, "engine") === "true";
  const chunks: string[] = [];

  if (engine) {
    const eng = new Engine(cfg);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const [sym, cmd] = parseCommand(line);
      eng.apply(sym, cmd, {
        onEvent: (seq, ev) => chunks.push(eventCanonical(seq, ev, sym)),
      });
    }
  } else {
    // Book corpora go through applyBatch with the look-ahead forced on, so
    // differential runs also cover the batch path (identical by contract).
    const book = new OrderBook(cfg);
    const cmds: Command[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line) cmds.push(parseCommand(line)[1]);
    }
    book.setPrefetchThreshold(0);
    book.applyBatch(cmds, { onEvent: (seq, ev) => chunks.push(eventCanonical(seq, ev)) });
  }
  process.stdout.write(chunks.join("\n") + (chunks.length ? "\n" : ""));
}

main();
