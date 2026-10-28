//! Order store — per-level chunked FIFOs, orders inline (docs/LAYOUT.md §1).
//!
//! There is no per-order record. A resting order lives in a slot of its price
//! level's queue: an unrolled doubly-linked list of 128-byte chunks holding
//! up to 6 {id, qty} slots each. All chunks share one ArrayBuffer viewed as
//! f64 / i32 / u8, so a chunk's header and slots sit on one 128-byte line
//! (the C++ `struct Chunk`, rather than one array per field):
//!
//!   byte  0  price  f64          F[c<<4]
//!         8  prev   i32          I[(c<<5)+2]
//!        12  next   i32          I[(c<<5)+3]
//!        16  head   u8           B[(c<<7)+16]   first slot that may be live
//!        17  tail   u8           B[(c<<7)+17]   next free slot
//!        18  live   u8           B[(c<<7)+18]
//!        19  side   u8           B[(c<<7)+19]
//!        20  tif    u8[6]        B[(c<<7)+20+slot]
//!        32  slots  {id f64, qty f64}[6]   id F[2*loc+4], qty F[2*loc+5]
//!
//! loc = chunk << 3 | slot is the order-map value. Dead slot ⇔ qty == 0.
//! Chunk 0 is a reserved sentinel so NIL = 0 and zero-filled memory is a
//! valid empty state (levels need no initialisation pass).

import { LevelArena } from "./priceindex";

export const NIL = 0;
export const CHUNK_SLOTS = 6;

export class Store {
  /// Chunks [1, cap] are usable; chunks in use never exceed live orders.
  readonly cap: number;
  readonly buf: ArrayBuffer;
  readonly F: Float64Array;
  readonly I: Int32Array;
  readonly B: Uint8Array;
  used = 1;
  freeChunk = NIL;
  live = 0;

  constructor(maxOrders: number) {
    this.cap = Math.max(1, maxOrders);
    // Zero-filled and committed lazily by the OS; prefault() touches it all.
    this.buf = new ArrayBuffer((this.cap + 1) * 128);
    this.F = new Float64Array(this.buf);
    this.I = new Int32Array(this.buf);
    this.B = new Uint8Array(this.buf);
  }

  /// Touch every page now so no page fault lands on the hot path.
  prefault(): void {
    const B = this.B;
    for (let i = 0; i < B.length; i += 4096) B[i] = 0;
  }

  allocChunk(side: number, price: number): number {
    let c = this.freeChunk;
    if (c !== NIL) this.freeChunk = this.I[(c << 5) + 3];
    else c = this.used++;
    this.F[c << 4] = price;
    this.I[(c << 5) + 2] = NIL;
    this.I[(c << 5) + 3] = NIL;
    const b = c << 7;
    this.B[b + 16] = 0;
    this.B[b + 17] = 0;
    this.B[b + 18] = 0;
    this.B[b + 19] = side;
    return c;
  }

  /// Unlink chunk `c` from level `li` and return it to the free list.
  dropChunk(lev: LevelArena, li: number, c: number): void {
    const I = this.I;
    const LI = lev.I;
    const p = I[(c << 5) + 2];
    const n = I[(c << 5) + 3];
    if (p !== NIL) I[(p << 5) + 3] = n;
    else LI[(li << 2) + 2] = n;
    if (n !== NIL) I[(n << 5) + 2] = p;
    else LI[(li << 2) + 3] = p;
    I[(c << 5) + 3] = this.freeChunk;
    this.freeChunk = c;
  }

  /// Append an order at the back of level `li`; returns its loc.
  push(lev: LevelArena, li: number, side: number, price: number, id: number, qty: number, tif: number): number {
    const LI = lev.I;
    const B = this.B;
    let c = LI[(li << 2) + 3];
    if (c === NIL || B[(c << 7) + 17] === CHUNK_SLOTS) {
      const n = this.allocChunk(side, price);
      this.I[(n << 5) + 2] = c;
      if (c !== NIL) this.I[(c << 5) + 3] = n;
      else LI[(li << 2) + 2] = n;
      LI[(li << 2) + 3] = n;
      c = n;
    }
    const b = c << 7;
    const s = B[b + 17];
    B[b + 17] = s + 1;
    B[b + 18]++;
    B[b + 20 + s] = tif;
    const loc = (c << 3) | s;
    this.F[2 * loc + 4] = id;
    this.F[2 * loc + 5] = qty;
    lev.F[li << 1] += qty;
    this.live++;
    return loc;
  }

  /// Remove a live order from level `li`.
  unlink(lev: LevelArena, li: number, loc: number): void {
    const F = this.F;
    const c = loc >> 3;
    lev.F[li << 1] -= F[2 * loc + 5];
    F[2 * loc + 5] = 0;
    this.live--;
    const b = (c << 7) + 18;
    const l = this.B[b] - 1;
    this.B[b] = l;
    if (l === 0) this.dropChunk(lev, li, c);
  }

  /// First live order of non-empty level `li` (advances the head chunk's
  /// cursor past dead slots).
  front(lev: LevelArena, li: number): number {
    const c = lev.I[(li << 2) + 2];
    const b = (c << 7) + 16;
    let h = this.B[b];
    const q = (c << 4) + 5;
    while (this.F[q + 2 * h] === 0) h++;
    this.B[b] = h;
    return (c << 3) | h;
  }

  // ---- field accessors (cold paths) ----
  price(loc: number): number { return this.F[(loc >> 3) << 4]; }
  side(loc: number): number { return this.B[((loc >> 3) << 7) + 19]; }
  tif(loc: number): number { return this.B[((loc >> 3) << 7) + 20 + (loc & 7)]; }
  id(loc: number): number { return this.F[2 * loc + 4]; }
  qty(loc: number): number { return this.F[2 * loc + 5]; }

  /// Visit live orders of level `li` in FIFO order.
  forEach(lev: LevelArena, li: number, f: (loc: number) => void): void {
    for (let c = lev.I[(li << 2) + 2]; c !== NIL; c = this.I[(c << 5) + 3]) {
      const b = c << 7;
      for (let s = this.B[b + 16]; s < this.B[b + 17]; s++) {
        const loc = (c << 3) | s;
        if (this.F[2 * loc + 5] !== 0) f(loc);
      }
    }
  }
}
