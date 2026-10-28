# Changelog

## Unreleased

- New hot-path layout (`../matcher/docs/LAYOUT.md`): resting orders live
  inline in 128-byte per-level chunks on typed arrays (`store.ts`),
  `OrderMap` gets a 1-byte tag array; `pool.ts` is gone.
- `OrderBook.applyBatch()` and `prefault()`. The look-ahead pipeline starts
  at 2^19 live orders (at ~100k it halved W4); `setPrefetchThreshold` and
  `matcherbench --lookahead on|off|auto` control it.
- `matcherbench --mode latency|throughput|scale` (BENCH.md v2).
- Throughput, Apple M1, Node 22: 32M ops/s on one core (1k live orders),
  15M on the mixed workload; 8-worker aggregate 40M (mixed) to 92M (1k
  live). See `../matcher/docs/RESULTS.md`.

## v0.2.0 — 2026-10-10

- Journals and snapshots (`spec/JOURNAL.md`): command/event journal,
  `matcher-snap/1` snapshots, restore; `matcherrun`, `matcherrecover`,
  `matchersnap`; `matcherfuzz` differential-fuzz harness.
- `engine: true` golden vectors (multi-symbol `Engine`).
- Vector `edge/042_dense_map_churn` (43 golden vectors).
- Fix: level totals drifted when an order was unlinked.
- `matcherbench` reports p90 and p99.9.
- The bench and tools read input as bytes, so corpora over V8's maximum
  string length (~512 MB) load.
- The price ladder finds the next best price through a summary bitmap,
  and an emptied side resets at once. A side whose last level emptied
  used to scan the whole ladder: W3 at 1M ops (the book drains) ran at
  0.3M and now runs at 4.8M orders/s. Output unchanged; a randomized
  test checks the cursor against a sorted reference.

## v0.1.0 — 2026-09-24

Initial release.

- `OrderBook` + `Engine`, `Sink` event seam
- Limit/Market, New/Cancel/Replace, GTC/IOC/FOK/Post-Only
- FIFO price-time priority, maker-price execution
- Pooled orders in typed arrays, intrusive FIFO levels, bitmap ladder index,
  sorted-map fallback for unbounded prices
- 41 golden vectors passing — byte-identical event streams
- ~5M orders/sec on shared benchmark workloads
- Zero runtime dependencies
