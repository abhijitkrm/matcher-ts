//! The matching core. Single-writer, deterministic: commands in through
//! `apply` / `applyBatch`, sequenced events out through the sink seam.
//! Mirrors spec/SPEC.md; memory layout per docs/LAYOUT.md (v0.3).

import { NIL, Store } from "./store";
import { OrderMap } from "./ordermap";
import { IndexKind, LevelArena, PriceIndex } from "./priceindex";
import {
  CloseReason,
  Command,
  OType,
  OrderId,
  Price,
  Qty,
  RejectReason,
  Side,
  Tif,
} from "./types";
import { AnySink, EventAdapter, FlatSink, isFlat } from "./sink";

export interface BookConfig {
  priceMin: Price;
  priceMax: Price;
  maxOrders: number;
  index: IndexKind;
}

export const defaultConfig = (): BookConfig => ({
  priceMin: 0,
  priceMax: 1_000_000,
  maxOrders: 65_536,
  index: IndexKind.Ladder,
});

export interface OrderInfo {
  id: OrderId;
  side: Side;
  price: Price;
  qty: Qty;
}

/// One live order, for snapshot serialization (spec/JOURNAL.md).
export interface RestingOrder {
  orderId: OrderId;
  side: Side;
  price: Price;
  qty: Qty;
  tif: Tif;
}

// Look-ahead distances for applyBatch (LAYOUT.md §4).
const D_MAP = 16;
const D_CHUNK = 8;
const D_LEVEL = 4;

export class OrderBook {
  private readonly store: Store;
  private readonly map: OrderMap;
  private readonly bids: PriceIndex;
  private readonly asks: PriceIndex;
  private seq = 0;
  private readonly cfg: BookConfig;
  private readonly ladder: boolean;
  private readonly pmin: number;
  private readonly pmax: number;
  private readonly maxOrders: number;
  private readonly adapter = new EventAdapter({ onEvent: () => {} });
  private prefetchMinLive = 1 << 19;
  /// Sink for look-ahead loads (keeps them from being optimised away).
  private touch = 0;

  constructor(cfg: BookConfig) {
    if (!(cfg.priceMax > cfg.priceMin) && cfg.index !== IndexKind.Tree) {
      throw new Error("price range must be non-empty");
    }
    this.store = new Store(cfg.maxOrders);
    this.map = new OrderMap(cfg.maxOrders);
    const mk = (side: Side) =>
      cfg.index === IndexKind.Ladder
        ? PriceIndex.ladder(side, cfg.priceMin, cfg.priceMax)
        : PriceIndex.tree(side);
    this.bids = mk(Side.Bid);
    this.asks = mk(Side.Ask);
    this.cfg = cfg;
    this.ladder = cfg.index === IndexKind.Ladder;
    this.pmin = cfg.priceMin;
    this.pmax = cfg.priceMax;
    this.maxOrders = cfg.maxOrders;
  }

  /// Touch all bounded storage now (order store, map, ladder levels) — it is
  /// otherwise committed lazily as the book grows. Costs ~128 B per
  /// max_orders for the store plus the map and ladder arrays.
  prefault(): void {
    this.store.prefault();
    this.map.prefault();
    if (this.ladder) {
      this.bids.lev.prefault();
      this.asks.lev.prefault();
    }
  }

  /// applyBatch runs its look-ahead loads only once this many orders rest
  /// (a cache-resident book gains nothing from them). Tests set 0 to force
  /// the pipeline on; a huge value turns it off.
  setPrefetchThreshold(live: number): void {
    this.prefetchMinLive = live;
  }

  private flat(sink: AnySink): FlatSink {
    if (isFlat(sink)) return sink;
    this.adapter.inner = sink;
    return this.adapter;
  }

  /// Apply one command, emitting its event stream through `sink`.
  apply(cmd: Command, sink: AnySink): void {
    this.exec(cmd, this.flat(sink));
  }

  /// Apply a run of commands. The event stream is identical to calling
  /// apply() on each in order; the batch only lets the book look ahead and
  /// load the memory upcoming commands will touch (map slot, then the
  /// order's chunk, then its price level) while the current command runs.
  /// Look-ahead reads possibly-stale state and never writes book state.
  applyBatch(cmds: readonly Command[], sink: AnySink): void {
    const fs = this.flat(sink);
    const n = cmds.length;
    if (this.store.live < this.prefetchMinLive) {
      for (let i = 0; i < n; i++) this.exec(cmds[i], fs);
      return;
    }
    let t = 0;
    for (let i = 0; i < n; i++) {
      if (i + D_MAP < n) t += this.aheadMap(cmds[i + D_MAP]);
      if (i + D_CHUNK < n) t += this.aheadChunk(cmds[i + D_CHUNK]);
      if (i + D_LEVEL < n) t += this.aheadLevel(cmds[i + D_LEVEL]);
      this.exec(cmds[i], fs);
    }
    this.touch = t | 0;
  }

  private exec(cmd: Command, sink: FlatSink): void {
    switch (cmd.kind) {
      case "new":
        this.newOrder(cmd.orderId, cmd.side, cmd.otype, cmd.price, cmd.qty, cmd.tif, sink);
        break;
      case "cancel":
        this.cancel(cmd.orderId, sink);
        break;
      case "replace":
        this.replace(cmd.orderId, cmd.price, cmd.qty, sink);
        break;
    }
  }

  // ---- look-ahead (ordinary loads; JS has no prefetch intrinsic) ----------

  private aheadMap(c: Command): number {
    const m = this.map;
    const i = OrderMap.mix(c.orderId) & m.mask;
    return m.tags[i] + m.K[2 * i];
  }

  private aheadChunk(c: Command): number {
    if (c.kind === "new") {
      if (c.otype !== OType.Limit) return 0;
      const own = c.side === Side.Bid ? this.bids : this.asks;
      const li = own.peek(c.price);
      return li < 0 ? 0 : own.lev.I[(li << 2) + 3];
    }
    const loc = this.map.get(c.orderId);
    return loc < 0 ? 0 : this.store.F[(loc >> 3) << 4];
  }

  private aheadLevel(c: Command): number {
    const st = this.store;
    if (c.kind === "new") {
      if (c.otype !== OType.Limit) return 0;
      const own = c.side === Side.Bid ? this.bids : this.asks;
      const li = own.peek(c.price);
      if (li < 0) return 0;
      const tc = own.lev.I[(li << 2) + 3];
      return tc === NIL ? 0 : st.B[(tc << 7) + 17];
    }
    const loc = this.map.get(c.orderId);
    if (loc < 0) return 0;
    const ch = (loc >> 3) << 4;
    const own = st.B[(ch << 3) + 19] === Side.Bid ? this.bids : this.asks;
    const p = st.F[ch];
    let li = own.peek(p);
    let t = li < 0 ? 0 : own.lev.F[li << 1];
    if (c.kind === "replace" && c.price !== p) {
      li = own.peek(c.price);
      if (li >= 0) t += own.lev.F[li << 1];
    }
    return t;
  }

  // ---- commands -----------------------------------------------------------

  private newOrder(
    orderId: OrderId,
    side: Side,
    otype: OType,
    price: Price,
    qty: Qty,
    tif: Tif,
    sink: FlatSink,
  ): void {
    // SPEC §4.3 validation precedence.
    if (qty === 0) {
      return this.reject(sink, orderId, RejectReason.InvalidQty);
    }
    const limit = otype === OType.Limit;
    if (limit && !this.priceOk(price)) {
      return this.reject(sink, orderId, RejectReason.InvalidPrice);
    }
    if (this.map.find(orderId) >= 0) {
      return this.reject(sink, orderId, RejectReason.DuplicateOrderId);
    }
    if (this.store.live >= this.maxOrders) {
      return this.reject(sink, orderId, RejectReason.BookFull);
    }
    if (limit) {
      if (tif === Tif.PostOnly) {
        if (this.wouldCross(side, price)) {
          return this.reject(sink, orderId, RejectReason.PostOnlyWouldCross);
        }
      } else if (tif === Tif.Fok && this.fillable(side, price) < qty) {
        return this.reject(sink, orderId, RejectReason.FokCannotFill);
      }
    }

    const remaining = this.cross(side, limit, price, orderId, qty, sink);

    if (remaining === 0) {
      sink.closed(++this.seq, orderId, CloseReason.Filled);
    } else if (limit && (tif === Tif.Gtc || tif === Tif.PostOnly)) {
      this.rest(orderId, side, price, remaining, tif);
      sink.accepted(++this.seq, orderId, remaining);
    } else {
      sink.closed(++this.seq, orderId, CloseReason.Expired);
    }
  }

  private cancel(orderId: OrderId, sink: FlatSink): void {
    const map = this.map;
    const mi = map.find(orderId);
    if (mi < 0) {
      return this.reject(sink, orderId, RejectReason.UnknownOrderId);
    }
    const st = this.store;
    const loc = map.valAt(mi);
    const ch = loc >> 3;
    const price = st.F[ch << 4];
    const own = st.B[(ch << 7) + 19] === Side.Bid ? this.bids : this.asks;
    const li = own.levelMut(price);
    if (li >= 0) st.unlink(own.lev, li, loc);
    own.unlinkLevel(price);
    map.removeAt(mi);
    sink.closed(++this.seq, orderId, CloseReason.Cancelled);
  }

  private replace(orderId: OrderId, price: Price, qty: Qty, sink: FlatSink): void {
    // SPEC §4.3: unknown -> invalid_qty -> invalid_price.
    const map = this.map;
    const mi = map.find(orderId);
    if (mi < 0) {
      return this.reject(sink, orderId, RejectReason.UnknownOrderId);
    }
    if (qty === 0) {
      return this.reject(sink, orderId, RejectReason.InvalidQty);
    }
    if (!this.priceOk(price)) {
      return this.reject(sink, orderId, RejectReason.InvalidPrice);
    }
    const st = this.store;
    const loc = map.valAt(mi);
    const ch = loc >> 3;
    const oldPrice = st.F[ch << 4];
    const oldQty = st.F[2 * loc + 5];
    const side: Side = st.B[(ch << 7) + 19];
    const tif = st.B[(ch << 7) + 20 + (loc & 7)];
    const own = side === Side.Bid ? this.bids : this.asks;

    if (price === oldPrice && qty <= oldQty) {
      // Quantity decrease (or no-op): keeps time priority.
      const li = own.levelMut(price);
      if (li >= 0) own.lev.F[li << 1] -= oldQty - qty;
      st.F[2 * loc + 5] = qty;
      sink.replaced(++this.seq, orderId, price, qty);
      return;
    }

    // Leave the book (losing time priority), re-cross at the new price, rest
    // any remainder at the back of the new level. The map entry is kept
    // across cross() so the id stays reserved; it is rewritten (or removed)
    // afterwards.
    const oli = own.levelMut(oldPrice);
    if (oli >= 0) st.unlink(own.lev, oli, loc);
    own.unlinkLevel(oldPrice);

    const removes = map.removes;
    const remaining = this.cross(side, true, price, orderId, qty, sink);

    if (remaining === 0) {
      map.remove(orderId);
      sink.closed(++this.seq, orderId, CloseReason.Filled);
      return;
    }
    const nli = own.levelInsert(price);
    const nloc = st.push(own.lev, nli, side, price, orderId, remaining, tif);
    if (map.removes === removes) map.setValAt(mi, nloc); // no entry moved: skip the re-probe
    else map.insert(orderId, nloc);
    sink.replaced(++this.seq, orderId, price, remaining);
  }

  // ---- matching core ------------------------------------------------------

  /// Aggressive walk of the opposite side. `hasBound` false means market
  /// (match all available depth). Returns what is left of `qty`.
  private cross(side: Side, hasBound: boolean, bound: Price, taker: OrderId, qty: Qty, sink: FlatSink): Qty {
    const opp = side === Side.Bid ? this.asks : this.bids;
    const st = this.store;
    const F = st.F;
    const B = st.B;
    const lev: LevelArena = opp.lev;
    const map = this.map;

    for (;;) {
      const bp = opp.bestPx();
      if (bp !== bp) break; // NaN: side empty
      if (hasBound && (side === Side.Bid ? bp > bound : bp < bound)) break;
      const li = opp.levelMut(bp);
      if (li < 0) break;
      const LF = lev.F;
      const LI = lev.I;
      const hx = (li << 2) + 2;
      while (LI[hx] !== NIL) {
        // front(): advance the head chunk's cursor past dead slots.
        const c = LI[hx];
        const cb = c << 7;
        let h = B[cb + 16];
        const q0 = (c << 4) + 5;
        while (F[q0 + 2 * h] === 0) h++;
        B[cb + 16] = h;
        const loc = (c << 3) | h;
        const mid = F[2 * loc + 4];
        const mqty = F[2 * loc + 5];
        const q = qty < mqty ? qty : mqty;
        sink.trade(++this.seq, mid, taker, bp, q);
        LF[li << 1] -= q;
        F[2 * loc + 5] = mqty - q;
        qty -= q;
        if (mqty === q) {
          // Slot is now dead (qty 0): retire it in place.
          st.live--;
          const l = B[cb + 18] - 1;
          B[cb + 18] = l;
          if (l === 0) st.dropChunk(lev, li, c);
          map.remove(mid);
          sink.closed(++this.seq, mid, CloseReason.Filled);
        }
        if (qty === 0) break;
      }
      if (LI[hx] === NIL) opp.unlinkLevel(bp);
      if (qty === 0) break;
    }
    return qty;
  }

  /// Insert a resting order (capacity guaranteed by the book-full check).
  private rest(orderId: OrderId, side: Side, price: Price, qty: Qty, tif: Tif): void {
    const own = side === Side.Bid ? this.bids : this.asks;
    const li = own.levelInsert(price);
    this.map.insert(orderId, this.store.push(own.lev, li, side, price, orderId, qty, tif));
  }

  // ---- queries ------------------------------------------------------------

  order(id: OrderId): OrderInfo | undefined {
    const loc = this.map.get(id);
    if (loc < 0) return undefined;
    const st = this.store;
    return { id: st.id(loc), side: st.side(loc), price: st.price(loc), qty: st.qty(loc) };
  }

  bestBid(): Price | undefined { return this.bids.bestPrice(); }
  bestAsk(): Price | undefined { return this.asks.bestPrice(); }
  orderCount(): number { return this.store.live; }
  seqNo(): number { return this.seq; }
  levelCount(side: Side): number {
    return (side === Side.Bid ? this.bids : this.asks).len();
  }
  depth(side: Side, n: number) {
    return (side === Side.Bid ? this.bids : this.asks).depth(n);
  }

  // ---- snapshot surface (spec/JOURNAL.md) -----------------------------------

  /// All live orders in book order: bids best→worst then asks best→worst,
  /// FIFO within each level.
  restingOrders(): RestingOrder[] {
    const out: RestingOrder[] = [];
    const st = this.store;
    for (const side of [Side.Bid, Side.Ask]) {
      const idx = side === Side.Bid ? this.bids : this.asks;
      for (const li of idx.levels(Number.MAX_SAFE_INTEGER)) {
        st.forEach(idx.lev, li, (loc) => {
          out.push({ orderId: st.id(loc), side, price: st.price(loc), qty: st.qty(loc), tif: st.tif(loc) });
        });
      }
    }
    return out;
  }

  /// Rebuild a book from a snapshot: same config, explicit seq, resting
  /// orders replayed in snapshot order (bids then asks, FIFO per level).
  static restore(cfg: BookConfig, seq: number, orders: RestingOrder[]): OrderBook {
    const b = new OrderBook(cfg);
    b.seq = seq;
    for (const o of orders) {
      if (b.store.live >= cfg.maxOrders) break;
      b.rest(o.orderId, o.side, o.price, o.qty, o.tif);
    }
    return b;
  }

  config(): BookConfig {
    return this.cfg;
  }

  // ---- internals ------------------------------------------------------------

  private priceOk(price: Price): boolean {
    return this.ladder ? price >= this.pmin && price <= this.pmax : price > 0;
  }

  private wouldCross(side: Side, price: Price): boolean {
    if (side === Side.Bid) {
      const bp = this.asks.bestPx();
      return bp === bp && price >= bp;
    }
    const bp = this.bids.bestPx();
    return bp === bp && price <= bp;
  }

  /// Quantity available on the opposite side within `price` (FOK pre-check).
  private fillable(side: Side, price: Price): Qty {
    const lo = this.ladder ? this.pmin : Number.MIN_SAFE_INTEGER;
    const hi = this.ladder ? this.pmax : Number.MAX_SAFE_INTEGER;
    return side === Side.Bid ? this.asks.sumRange(lo, price) : this.bids.sumRange(price, hi);
  }

  private reject(sink: FlatSink, orderId: OrderId, reason: RejectReason): void {
    sink.rejected(++this.seq, orderId, reason);
  }
}
