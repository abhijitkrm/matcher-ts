//! Reading line-oriented files without building one string: a 10M-command
//! corpus is over 1 GB, beyond V8's maximum string length.

import { readFileSync } from "node:fs";

/// The file's lines, split on the bytes. Same result as
/// `readFileSync(path, "utf8").split("\n")`, minus empty lines unless
/// `keepEmpty` is set.
export function readLines(path: string, keepEmpty = false): string[] {
  const buf = readFileSync(path);
  const out: string[] = [];
  let at = 0;
  for (;;) {
    let nl = buf.indexOf(10, at);
    const end = nl < 0 ? buf.length : nl;
    if (keepEmpty || end > at) out.push(buf.toString("utf8", at, end));
    if (nl < 0) return out;
    at = nl + 1;
  }
}
