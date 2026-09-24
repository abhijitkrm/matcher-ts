# @abhijitkrm/matcher

[![ci](https://github.com/abhijitkrm/matcher-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/abhijitkrm/matcher-ts/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@abhijitkrm/matcher.svg)](https://www.npmjs.com/package/@abhijitkrm/matcher)
[![license](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](LICENSE-MIT)

Deterministic FIFO limit order book and matching engine core for Node.js /
TypeScript — measured at up to **~5M orders/sec** (see `spec/BENCH.md`).

Single-writer book per symbol, commands in, monotonically sequenced events out.
All I/O hangs off the `Sink` seam; there is no networking, persistence, or
clock dependence in the core. Runtime dependencies: none.

```ts
import { OrderBook, defaultConfig, newLimit, Side, Tif, VecSink } from "@abhijitkrm/matcher";

const book = new OrderBook(defaultConfig());
const sink = new VecSink();

book.apply(newLimit(1, Side.Ask, 100, 10, Tif.Gtc), sink);
book.apply(newLimit(2, Side.Bid, 100, 4, Tif.Gtc), sink);
// order 2 filled 4 @100 against order 1 and closed; order 1 keeps 6 resting.
```

```bash
npm install @abhijitkrm/matcher
# or straight from the repo:
npm install github:abhijitkrm/matcher-ts
```

## Features

- Limit + Market orders, New / Cancel / Replace
- GTC, IOC, FOK, Post-Only
- FIFO price-time priority, maker-price execution, partial fills, sweeps
- Pooled orders in typed arrays, intrusive FIFO price levels, bitmap ladder
  index with sorted-map fallback for unbounded prices
- Thin multi-symbol `Engine` router
- Deterministic event streams — verified byte-identically against the shared
  golden vector corpus (`vectors/`)

## Layout

```
src/        library (book, engine, priceindex, pool, ordermap, sink, types)
tests/      golden vector runner
bench/      matcherbench harness
vectors/    shared golden corpus (spec repo: github.com/abhijitkrm/matcher)
spec/       semantics contract (SPEC.md, SCHEMA.md, BENCH.md)
tools/      vectorgen — deterministic workload generator
```

## Test & bench

```bash
npm install        # dev deps: typescript + @types/node only
npm test           # build + 41 golden vectors

# benchmark (see spec/BENCH.md)
mkdir -p bench/corpora
cargo run --release --manifest-path tools/vectorgen/Cargo.toml -- \
  --workload w2 --n 200000 --setup-n 100000 --out bench/corpora/w2
npm run bench -- bench/corpora/w2
```

## License

MIT OR Apache-2.0
