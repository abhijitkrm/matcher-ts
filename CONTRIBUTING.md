# Contributing

The contract that keeps this package honest is `spec/` + `vectors/` (vendored
from the [matcher spec repo](https://github.com/abhijitkrm/matcher)):

- **Semantics changes** start upstream in `spec/SPEC.md` plus a golden vector
  (`vectors/**.cmd.jsonl`) with its canonical `.evt.jsonl`. The implementation
  must emit that stream byte-identically — in every index mode the vector
  declares.
- **Verify**: `npm test` builds and replays all golden vectors.
- **Style**: `tsc --strict`, zero runtime dependencies, CommonJS out.
- **Performance**: hot-path state lives in typed arrays; pooled orders,
  intrusive levels, direct-indexed ladder. Benchmarks use `tools/vectorgen`
  workloads per `spec/BENCH.md` — report CPU/OS/Node version, no unattributed
  numbers.
