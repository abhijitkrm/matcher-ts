//! Open-addressed order-id → loc map (docs/LAYOUT.md §3). Linear probing,
//! power-of-two capacity ≥ 2 × max_orders, backward-shift deletion (no
//! tombstones). Storage is split: a dense 1-byte tag array (0 = empty, else
//! 0x80 | 7 hash bits) and 16-byte {key f64, val i32} entries in one buffer.
//! Absent-id probes (every New's duplicate check) touch only the tags.
//!
//! Hash: 32-bit Fibonacci multiply of the id's low 32 bits with a high-half
//! fold (LAYOUT.md specifies the 64-bit multiply; a 64-bit product needs
//! BigInt in JS, and the hash only affects probe lengths, never events).
//! Slot = low bits, tag = top 7 bits.

export class OrderMap {
  readonly tags: Uint8Array;
  /// Entry i: key at K[2i], val at V[4i+2] (same buffer).
  readonly K: Float64Array;
  readonly V: Int32Array;
  readonly mask: number;
  len = 0;
  /// Bumped by every removal: an entry index from find() stays valid until
  /// the next removal (insertion never moves existing entries).
  removes = 0;

  constructor(maxLive: number) {
    let cap = 16;
    while (cap < maxLive * 2) cap <<= 1;
    this.tags = new Uint8Array(cap);
    const buf = new ArrayBuffer(cap * 16);
    this.K = new Float64Array(buf);
    this.V = new Int32Array(buf);
    this.mask = cap - 1;
  }

  static mix(id: number): number {
    const h = Math.imul(id | 0, 0x9e3779b1);
    return h ^ (h >>> 16);
  }

  prefault(): void {
    const t = this.tags;
    for (let i = 0; i < t.length; i += 4096) t[i] = t[i];
    const k = new Uint8Array(this.K.buffer);
    for (let i = 0; i < k.length; i += 4096) k[i] = k[i];
  }

  /// Entry index holding `id`, or -1.
  find(id: number): number {
    const h = OrderMap.mix(id);
    const t = (h >>> 25) | 0x80;
    const tags = this.tags;
    const mask = this.mask;
    let i = h & mask;
    for (;;) {
      const ti = tags[i];
      if (ti === 0) return -1;
      if (ti === t && this.K[2 * i] === id) return i;
      i = (i + 1) & mask;
    }
  }

  contains(id: number): boolean {
    return this.find(id) >= 0;
  }

  /// Value for `id`, or -1.
  get(id: number): number {
    const i = this.find(id);
    return i < 0 ? -1 : this.V[4 * i + 2];
  }

  valAt(i: number): number {
    return this.V[4 * i + 2];
  }

  setValAt(i: number, v: number): void {
    this.V[4 * i + 2] = v;
  }

  /// Insert or overwrite. Capacity is fixed: live ≤ max_orders ≤ cap / 2.
  insert(id: number, v: number): void {
    const h = OrderMap.mix(id);
    const t = (h >>> 25) | 0x80;
    const tags = this.tags;
    const mask = this.mask;
    let i = h & mask;
    for (;;) {
      const ti = tags[i];
      if (ti === 0) break;
      if (ti === t && this.K[2 * i] === id) {
        this.V[4 * i + 2] = v;
        return;
      }
      i = (i + 1) & mask;
    }
    tags[i] = t;
    this.K[2 * i] = id;
    this.V[4 * i + 2] = v;
    this.len++;
  }

  remove(id: number): void {
    const i = this.find(id);
    if (i >= 0) this.removeAt(i);
  }

  /// Delete entry `i` (from find()). Backward-shift deletion (Knuth 6.4R):
  /// scan forward from the hole, moving back any entry whose probe chain
  /// crosses it.
  removeAt(i: number): void {
    const tags = this.tags;
    const K = this.K;
    const V = this.V;
    const mask = this.mask;
    tags[i] = 0;
    this.len--;
    this.removes++;
    let hole = i;
    let j = i;
    for (;;) {
      j = (j + 1) & mask;
      const tj = tags[j];
      if (tj === 0) return;
      const home = OrderMap.mix(K[2 * j]) & mask;
      const inInterval = hole < j ? home > hole && home <= j : home > hole || home <= j;
      if (!inInterval) {
        tags[hole] = tj;
        K[2 * hole] = K[2 * j];
        V[4 * hole + 2] = V[4 * j + 2];
        tags[j] = 0;
        hole = j;
      }
    }
  }
}
