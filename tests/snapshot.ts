//! Snapshot/journal round-trip checks (spec/JOURNAL.md):
//!   snap → restore → snap  = byte-identical
//!   restore → continue     = byte-identical event stream vs uninterrupted run
//!   cmd journal → replay   = identical event journal
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BookConfig } from "../src/book";
import { Engine } from "../src/engine";
import { IndexKind } from "../src/priceindex";
import { CmdJournal, journalEvent } from "../src/journal";
import { parseSnapshot, restoreEngine, writeEngine } from "../src/snapshot";
import { Command, Symbol, Side, OType, Tif, eventCanonical, newLimit, cancel, replace } from "../src/types";
import { getI64, getStr } from "../src/jsonflat";

const VECTORS_DIR = join(__dirname, "..", "..", "vectors");

function parseCommand(line: string): [Symbol, Command] {
  const sym = getI64(line, "symbol") ?? 0;
  switch (getStr(line, "cmd")) {
    case "new": {
      const tifStr = getStr(line, "tif") ?? "gtc";
      const tif =
        tifStr === "ioc" ? Tif.Ioc :
        tifStr === "fok" ? Tif.Fok :
        tifStr === "post_only" ? Tif.PostOnly : Tif.Gtc;
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

function loadEngineCmds(): [Symbol, Command][] {
  const text = readFileSync(join(VECTORS_DIR, "engine", "001_multisymbol.cmd.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((l) => l.length > 0 && !l.includes('"format"'))
    .map(parseCommand);
}

function runTagged(e: Engine, cmds: [Symbol, Command][], lo: number, hi: number): string {
  const out: string[] = [];
  for (let i = lo; i < hi; i++) {
    const [sym, cmd] = cmds[i];
    e.applyTagged(sym, cmd, (s, seq, ev) => out.push(eventCanonical(seq, ev, s)));
  }
  return out.join("\n") + (out.length > 0 ? "\n" : "");
}

let fails = 0;
function check(ok: boolean, name: string, detail = ""): void {
  if (!ok) {
    fails++;
    console.log(`FAIL ${name}\n${detail}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const cmds = loadEngineCmds();
const cfg: BookConfig = { priceMin: 0, priceMax: 1_000_000, maxOrders: 65_536, index: IndexKind.Ladder };
const split = Math.floor(cmds.length / 2);

// 1. Reference: uninterrupted run.
const expected = runTagged(new Engine(cfg), cmds, 0, cmds.length);

// 2. Split run: snapshot at midpoint, restore, continue.
const eng = new Engine(cfg);
let out = runTagged(eng, cmds, 0, split);
const snap = writeEngine(eng);
const eng2 = restoreEngine(parseSnapshot(snap));

const snap2 = writeEngine(eng2);
check(snap === snap2, "re-snapshot byte-identical", `left:\n${snap}\nright:\n${snap2}`);

out += runTagged(eng2, cmds, split, cmds.length);
check(out === expected, "continuation byte-identical");

// 3. Journal replay: journal commands + events, replay cmds, compare evts.
let cmdLog = "";
let evtLog = "";
const eng3 = new Engine(cfg);
for (const [sym, cmd] of cmds) {
  new CmdJournal((l) => (cmdLog += l), sym).record(cmd);
  eng3.applyTagged(sym, cmd, (s, seq, ev) => journalEvent(s, seq, ev, (l) => (evtLog += l)));
}
const eng4 = new Engine(cfg);
let replayed = "";
for (const line of cmdLog.split("\n").filter((l) => l.length > 0)) {
  const [sym, cmd] = parseCommand(line);
  eng4.applyTagged(sym, cmd, (s, seq, ev) => (replayed += eventCanonical(seq, ev, s) + "\n"));
}
check(replayed === evtLog, "journal replay byte-identical");

// 4. Empty engine snapshot round-trips.
const esnap = writeEngine(new Engine(cfg));
check(parseSnapshot(esnap).books.length === 0, "empty snapshot has no books");

// 5. Mid-fuzz stream: xorshift64* same as fuzzgen, duplicated locally.
{
  const fcfg: BookConfig = { priceMin: 0, priceMax: 1000, maxOrders: 4096, index: IndexKind.Ladder };
  // Deterministic LCG (32-bit state is plenty; exact stream parity with
  // fuzzgen isn't needed — just adversarial command mix).
  let lcg = 0xc0ffee;
  const below = (n: number): number => {
    lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
    return lcg % n;
  };
  const fcmds: [Symbol, Command][] = [];
  for (let i = 0; i < 4000; i++) {
    const sym = below(6);
    const id = below(256);
    let cmd: Command;
    switch (below(3)) {
      case 0: {
        const tif = [Tif.Ioc, Tif.Fok, Tif.PostOnly, Tif.Gtc][below(4)];
        cmd = newLimit(id, below(2) === 0 ? Side.Bid : Side.Ask, below(999) + 1, below(200) + 1, tif);
        break;
      }
      case 1:
        cmd = cancel(id);
        break;
      default:
        cmd = replace(id, below(999) + 1, below(200) + 1);
    }
    fcmds.push([sym, cmd]);
  }
  const fexp = runTagged(new Engine(fcfg), fcmds, 0, fcmds.length);
  const feng = new Engine(fcfg);
  let fout = runTagged(feng, fcmds, 0, 2000);
  const feng2 = restoreEngine(parseSnapshot(writeEngine(feng)));
  fout += runTagged(feng2, fcmds, 2000, fcmds.length);
  check(fout === fexp, "mid-fuzz restore byte-identical");
}

if (fails > 0) process.exit(1);
console.log("snapshot: all checks passed");
