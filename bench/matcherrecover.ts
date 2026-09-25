//! matcherrecover — e2e recovery: load a matcher-snap/1 snapshot, replay a
//! command journal tail, emit the canonical tagged event journal to stdout.
//! Exits nonzero on a malformed journal line (truncated tail write).
//!   node dist/bench/matcherrecover.js <snap.jsonl> <cmd-tail.jsonl>
import { readFileSync } from "node:fs";
import { parseSnapshot, restoreEngine } from "../src/snapshot";
import { journalEvent } from "../src/journal";
import { parseCmd } from "./matcherrun";

const [snapPath, tailPath] = [process.argv[2], process.argv[3]];
const eng = restoreEngine(parseSnapshot(readFileSync(snapPath, "utf8")));

const write = (l: string) => process.stdout.write(l);
const lines = readFileSync(tailPath, "utf8").split("\n");
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line === "" || line.includes('"format"')) continue;
  const parsed = parseCmd(line);
  if (parsed === undefined) {
    console.error(`${tailPath}:${i + 1}: malformed journal line: ${line}`);
    process.exit(2);
  }
  eng.applyTagged(parsed[0], parsed[1], (s, seq, ev) => journalEvent(s, seq, ev, write));
}
