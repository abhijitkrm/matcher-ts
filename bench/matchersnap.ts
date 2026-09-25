//! snapdump — apply an engine command stream, print the snapshot to stdout.
//! Cross-language snapshot parity check (spec/JOURNAL.md).
//!   node dist/bench/matchersnap.js <engine.cmd.jsonl>
import { readFileSync } from "node:fs";
import { Engine } from "../src/engine";
import { writeEngine } from "../src/snapshot";
import { parseCmd, parseHeader } from "./matcherrun";

const lines = readFileSync(process.argv[2], "utf8")
  .split("\n")
  .filter((l) => l.length > 0);
const eng = new Engine(parseHeader(lines[0]));
for (const line of lines.slice(1)) {
  const parsed = parseCmd(line);
  if (parsed === undefined) {
    console.error(`malformed command: ${line}`);
    process.exit(2);
  }
  eng.applyTagged(parsed[0], parsed[1], () => {});
}
process.stdout.write(writeEngine(eng));
