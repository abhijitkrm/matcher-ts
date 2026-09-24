//! Thin multi-symbol router: symbol → OrderBook. Sequencing stays per-book
//! (same contract as the single-symbol core).

import { BookConfig, OrderBook } from "./book";
import { Command, Symbol } from "./types";
import { Sink } from "./sink";

export class Engine {
  private readonly books = new Map<Symbol, OrderBook>();

  constructor(private readonly cfg: BookConfig) {}

  /// Book for `symbol`, created on first use.
  book(symbol: Symbol): OrderBook {
    let b = this.books.get(symbol);
    if (b === undefined) {
      b = new OrderBook(this.cfg);
      this.books.set(symbol, b);
    }
    return b;
  }

  apply(symbol: Symbol, cmd: Command, sink: Sink): void {
    this.book(symbol).apply(cmd, sink);
  }

  symbols(): number {
    return this.books.size;
  }
}
