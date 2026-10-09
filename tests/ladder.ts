// The ladder's cursor agrees with a sorted reference under random churn on a
// wide ladder, including whole summary words emptying and refilling.
import { LadderIndex } from "../src/priceindex";
import { NIL } from "../src/pool";
import { Side } from "../src/types";

const SPAN = 1 << 20;
for (const side of [Side.Bid, Side.Ask]) {
  const lad = new LadderIndex(side, 0, SPAN - 1);
  const set: number[] = []; // sorted ascending
  const lowerBound = (p: number) => {
    let lo = 0, hi = set.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (set[m] < p) lo = m + 1; else hi = m;
    }
    return lo;
  };
  let x = 0x9e3779b97f4a7c15n;
  const M = (1n << 64n) - 1n;
  for (let step = 0; step < 100_000; step++) {
    x ^= (x << 13n) & M;
    x ^= x >> 7n;
    x ^= (x << 17n) & M;
    const r = Number(x % 8n), y = x >> 8n;
    const p = r === 0 ? 0 : r === 1 ? SPAN - 1 : r === 2 ? Number(y % BigInt(SPAN)) : SPAN / 2 - 6000 + Number(y % 12000n);
    if (step % 1000 < 520 && set.length > 0) {
      let j: number;
      if ((x & 16n) === 0n) j = side === Side.Bid ? set.length - 1 : 0;
      else j = Math.min(lowerBound(p), set.length - 1);
      const q = set[j];
      set.splice(j, 1);
      lad.levelMut(q)!.head = NIL;
      lad.unlinkLevel(q);
    } else {
      const j = lowerBound(p);
      if (set[j] !== p) {
        set.splice(j, 0, p);
        lad.levelInsert(p).head = 0;
      }
    }
    const want = set.length === 0 ? undefined : side === Side.Bid ? set[set.length - 1] : set[0];
    if (lad.bestPrice() !== want || lad.len() !== set.length) {
      console.error(`side ${side} step ${step}: best ${lad.bestPrice()} want ${want}`);
      process.exit(1);
    }
  }
}
console.log("ladder: ok");
