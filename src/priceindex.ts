//! Price index: direct-indexed bitmap ladder for bounded ranges (O(1) best
//! price via a top-of-book cursor), sorted-keys Map fallback for unbounded
//! prices. Enum-dispatched — no virtuals in the match loop.
//!
//! Levels (docs/LAYOUT.md §2) are 16-byte records {total f64, head i32,
//! tail i32} in a LevelArena, addressed by a level index. head/tail are
//! store chunk indices; empty ⇔ head == NIL (0), so zero-filled memory is a
//! valid all-empty ladder.

import { Price, Qty, Side } from "./types";

const NIL = 0;

export class LevelArena {
  /// Level i: total at F[2i], head at I[4i+2], tail at I[4i+3].
  F: Float64Array;
  I: Int32Array;
  size: number;

  constructor(n: number) {
    this.size = Math.max(1, n);
    const buf = new ArrayBuffer(this.size * 16);
    this.F = new Float64Array(buf);
    this.I = new Int32Array(buf);
  }

  grow(n: number): void {
    const old = new Uint8Array(this.F.buffer);
    const buf = new ArrayBuffer(n * 16);
    new Uint8Array(buf).set(old);
    this.F = new Float64Array(buf);
    this.I = new Int32Array(buf);
    this.size = n;
  }

  prefault(): void {
    const b = new Uint8Array(this.F.buffer);
    for (let i = 0; i < b.length; i += 4096) b[i] = b[i];
  }

  head(i: number): number { return this.I[(i << 2) + 2]; }
  tail(i: number): number { return this.I[(i << 2) + 3]; }
  total(i: number): number { return this.F[i << 1]; }
  isEmpty(i: number): boolean { return this.I[(i << 2) + 2] === NIL; }
  /// Test hook: mark level i occupied (head = 1) or empty (head = NIL).
  setHead(i: number, h: number): void { this.I[(i << 2) + 2] = h; }
}

export interface LevelDepth {
  price: Price;
  qty: Qty;
}

export enum IndexKind {
  Ladder,
  Tree,
}

const low = (x: number) => 31 - Math.clz32(x & -x); // lowest set bit
const high = (x: number) => 31 - Math.clz32(x); // highest set bit

// ---------------------------------------------------------------------------
// Ladder: level index = p - base + occupancy bitmap + best-price cursor.
// summary bit w is set iff bits[w] !== 0, so rescan skips 1024 empty ticks
// per word.
// ---------------------------------------------------------------------------

export class LadderIndex {
  readonly side: Side;
  readonly base: Price;
  readonly span: number;
  readonly lev: LevelArena;
  readonly bits: Uint32Array;
  readonly summary: Uint32Array;
  best = -1;
  count = 0;

  constructor(side: Side, pmin: Price, pmax: Price) {
    this.side = side;
    this.base = pmin;
    const span = pmax - pmin + 1;
    this.span = span;
    this.lev = new LevelArena(span);
    this.bits = new Uint32Array((span + 31) >> 5);
    this.summary = new Uint32Array((this.bits.length + 31) >> 5);
  }

  bestPrice(): Price | undefined {
    if (this.best < 0) return undefined;
    return this.base + this.best;
  }

  /// Best price, or NaN if this side is empty.
  bestPx(): number {
    return this.best < 0 ? NaN : this.base + this.best;
  }

  /// Level index at `p` if non-empty, else -1.
  levelMut(p: Price): number {
    const i = p - this.base;
    if (i < 0 || i >= this.span) return -1;
    return this.lev.I[(i << 2) + 2] === NIL ? -1 : i;
  }

  /// Level index at `p` (in range), marking it occupied if it was empty.
  /// The caller pushes an order right after.
  levelInsert(p: Price): number {
    const i = p - this.base;
    if (this.lev.I[(i << 2) + 2] === NIL) {
      this.bits[i >> 5] |= 1 << (i & 31);
      this.summary[i >> 10] |= 1 << ((i >> 5) & 31);
      this.count++;
      if (this.best < 0 || (this.side === Side.Ask ? i < this.best : i > this.best)) {
        this.best = i;
      }
    }
    return i;
  }

  /// Level index at `p` for look-ahead reads (no emptiness check), or -1.
  peek(p: Price): number {
    const i = p - this.base;
    return i >= 0 && i < this.span ? i : -1;
  }

  unlinkLevel(p: Price): void {
    const i = p - this.base;
    if (i < 0 || i >= this.span || this.lev.I[(i << 2) + 2] !== NIL) return;
    const w = i >> 5;
    this.bits[w] &= ~(1 << (i & 31));
    if (this.bits[w] === 0) this.summary[w >> 5] &= ~(1 << (w & 31));
    this.count--;
    if (this.count === 0) this.best = -1;
    else if (i === this.best) this.best = this.rescan(i);
  }

  /// Nearest non-empty level strictly beyond `from`; -1 if the side emptied.
  /// Searches `from`'s word, then finds the next non-empty word through the
  /// summary.
  private rescan(from: number): number {
    const w = from >> 5;
    if (this.side === Side.Ask) {
      const b = (from & 31) + 1;
      const word = this.bits[w] & (b === 32 ? 0 : ~0 << b);
      if (word !== 0) return (w << 5) + low(word);
      for (let s = w + 1; s < this.bits.length; ) {
        const sw = s >> 5;
        const sword = this.summary[sw] & (~0 << (s & 31));
        if (sword !== 0) {
          const nw = (sw << 5) + low(sword);
          return (nw << 5) + low(this.bits[nw]);
        }
        s = (sw << 5) + 32;
      }
    } else {
      const b = from & 31;
      const word = this.bits[w] & (b === 0 ? 0 : ~0 >>> (32 - b));
      if (word !== 0) return (w << 5) + high(word);
      for (let s = w - 1; s >= 0; ) {
        const sw = s >> 5;
        const sword = this.summary[sw] & (~0 >>> (31 - (s & 31)));
        if (sword !== 0) {
          const nw = (sw << 5) + high(sword);
          return (nw << 5) + high(this.bits[nw]);
        }
        s = (sw << 5) - 1;
      }
    }
    return -1;
  }

  /// Sum of level totals over [lo, hi], visiting only occupied levels.
  sumRange(lo: Price, hi: Price): Qty {
    const loI = Math.max(0, lo - this.base);
    const hiI = Math.min(this.span - 1, hi - this.base);
    let sum = 0;
    const F = this.lev.F;
    for (let i = loI; i <= hiI; ) {
      const w = i >> 5;
      const hiBit = Math.min((w << 5) + 31, hiI);
      let word = this.bits[w] & (~0 << (i & 31)) & (~0 >>> (31 - (hiBit & 31)));
      while (word !== 0) {
        sum += F[((w << 5) + low(word)) << 1];
        word &= word - 1;
      }
      i = (w << 5) + 32;
    }
    return sum;
  }

  len(): number {
    return this.count;
  }

  /// Up to `n` occupied level indexes, best first.
  levels(n: number): number[] {
    const out: number[] = [];
    if (this.side === Side.Ask) {
      for (let w = 0; w < this.bits.length && out.length < n; w++) {
        let word = this.bits[w];
        while (word !== 0 && out.length < n) {
          out.push((w << 5) + low(word));
          word &= word - 1;
        }
      }
    } else {
      for (let w = this.bits.length - 1; w >= 0 && out.length < n; w--) {
        let word = this.bits[w];
        while (word !== 0 && out.length < n) {
          const b = high(word);
          out.push((w << 5) + b);
          word &= ~(1 << b);
        }
      }
    }
    return out;
  }

  priceOf(li: number): Price {
    return this.base + li;
  }

  depth(n: number): LevelDepth[] {
    return this.levels(n).map((i) => ({ price: this.base + i, qty: this.lev.F[i << 1] }));
  }
}

// ---------------------------------------------------------------------------
// Tree: Map<price, level index> + sorted key array (unbounded price domain).
// Level records live in a growable arena with a free list.
// ---------------------------------------------------------------------------

export class TreeIndex {
  readonly side: Side;
  readonly map = new Map<Price, number>();
  readonly lev = new LevelArena(16);
  private keys: number[] = [];
  private prices: number[] = [];
  private freeIds: number[] = [];
  private next = 0;

  constructor(side: Side) {
    this.side = side;
  }

  private findKey(p: Price): number {
    let lo = 0, hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  bestPrice(): Price | undefined {
    if (this.keys.length === 0) return undefined;
    return this.side === Side.Bid ? this.keys[this.keys.length - 1] : this.keys[0];
  }

  bestPx(): number {
    const b = this.bestPrice();
    return b === undefined ? NaN : b;
  }

  levelMut(p: Price): number {
    const l = this.map.get(p);
    return l === undefined || this.lev.isEmpty(l) ? -1 : l;
  }

  levelInsert(p: Price): number {
    let l = this.map.get(p);
    if (l === undefined) {
      if (this.freeIds.length > 0) l = this.freeIds.pop()!;
      else {
        l = this.next++;
        if (l >= this.lev.size) this.lev.grow(this.lev.size * 2);
      }
      this.lev.I[(l << 2) + 2] = NIL;
      this.lev.I[(l << 2) + 3] = NIL;
      this.lev.F[l << 1] = 0;
      this.prices[l] = p;
      this.map.set(p, l);
      this.keys.splice(this.findKey(p), 0, p);
    }
    return l;
  }

  unlinkLevel(p: Price): void {
    const l = this.map.get(p);
    if (l !== undefined && this.lev.isEmpty(l)) {
      this.map.delete(p);
      this.keys.splice(this.findKey(p), 1);
      this.freeIds.push(l);
    }
  }

  sumRange(lo: Price, hi: Price): Qty {
    let sum = 0;
    for (let i = this.findKey(lo); i < this.keys.length && this.keys[i] <= hi; i++) {
      sum += this.lev.total(this.map.get(this.keys[i])!);
    }
    return sum;
  }

  len(): number {
    return this.map.size;
  }

  levels(n: number): number[] {
    const out: number[] = [];
    if (this.side === Side.Ask) {
      for (let i = 0; i < this.keys.length && out.length < n; i++) out.push(this.map.get(this.keys[i])!);
    } else {
      for (let i = this.keys.length - 1; i >= 0 && out.length < n; i--) out.push(this.map.get(this.keys[i])!);
    }
    return out;
  }

  priceOf(li: number): Price {
    return this.prices[li];
  }

  depth(n: number): LevelDepth[] {
    return this.levels(n).map((l) => ({ price: this.prices[l], qty: this.lev.total(l) }));
  }
}

// ---------------------------------------------------------------------------
// Enum-dispatched index (mirrors Rust `enum PriceIndex` / C++ struct).
// ---------------------------------------------------------------------------

export class PriceIndex {
  readonly kind: IndexKind;
  readonly lad: LadderIndex;
  readonly tree: TreeIndex;
  /// The active implementation's level arena (stable object; a tree arena
  /// may swap its arrays on growth, so re-read `.F` / `.I` after inserts).
  readonly lev: LevelArena;

  constructor(kind: IndexKind, side: Side, pmin: Price, pmax: Price) {
    this.kind = kind;
    this.lad = kind === IndexKind.Ladder ? new LadderIndex(side, pmin, pmax) : new LadderIndex(side, 0, 0);
    this.tree = new TreeIndex(side);
    this.lev = kind === IndexKind.Ladder ? this.lad.lev : this.tree.lev;
  }

  static ladder(side: Side, pmin: Price, pmax: Price): PriceIndex {
    return new PriceIndex(IndexKind.Ladder, side, pmin, pmax);
  }

  static tree(side: Side): PriceIndex {
    return new PriceIndex(IndexKind.Tree, side, 0, 0);
  }

  bestPrice(): Price | undefined {
    return this.kind === IndexKind.Ladder ? this.lad.bestPrice() : this.tree.bestPrice();
  }
  bestPx(): number {
    return this.kind === IndexKind.Ladder ? this.lad.bestPx() : this.tree.bestPx();
  }
  levelMut(p: Price): number {
    return this.kind === IndexKind.Ladder ? this.lad.levelMut(p) : this.tree.levelMut(p);
  }
  levelInsert(p: Price): number {
    return this.kind === IndexKind.Ladder ? this.lad.levelInsert(p) : this.tree.levelInsert(p);
  }
  unlinkLevel(p: Price): void {
    if (this.kind === IndexKind.Ladder) this.lad.unlinkLevel(p);
    else this.tree.unlinkLevel(p);
  }
  /// Ladder level index for look-ahead reads; -1 for tree / out of range.
  peek(p: Price): number {
    return this.kind === IndexKind.Ladder ? this.lad.peek(p) : -1;
  }
  sumRange(lo: Price, hi: Price): Qty {
    return this.kind === IndexKind.Ladder ? this.lad.sumRange(lo, hi) : this.tree.sumRange(lo, hi);
  }
  len(): number {
    return this.kind === IndexKind.Ladder ? this.lad.len() : this.tree.len();
  }
  levels(n: number): number[] {
    return this.kind === IndexKind.Ladder ? this.lad.levels(n) : this.tree.levels(n);
  }
  priceOf(li: number): Price {
    return this.kind === IndexKind.Ladder ? this.lad.priceOf(li) : this.tree.priceOf(li);
  }
  depth(n: number): LevelDepth[] {
    return this.kind === IndexKind.Ladder ? this.lad.depth(n) : this.tree.depth(n);
  }
}
