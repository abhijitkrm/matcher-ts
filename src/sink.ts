//! The only I/O seam: every book event flows through the sink. Journals,
//! market-data fan-out and gateways attach here — the core never does I/O.
//!
//! Two shapes are accepted wherever a sink is:
//!   - `Sink`     — `onEvent(seq, ev)` with an `Event` object per event.
//!   - `FlatSink` — one method per event kind taking the fields as numbers;
//!                  no per-event allocation (the hot-path form). Marked by
//!                  `flat: true`.
//! A plain `Sink` is fed through an adapter that builds the `Event` objects,
//! so the stream is identical either way.

import { CloseReason, Event, RejectReason, eventCanonical, eventFold } from "./types";

export interface Sink {
  onEvent(seq: number, ev: Event): void;
}

export interface FlatSink {
  readonly flat: true;
  accepted(seq: number, orderId: number, leavesQty: number): void;
  rejected(seq: number, orderId: number, reason: RejectReason): void;
  trade(seq: number, maker: number, taker: number, price: number, qty: number): void;
  closed(seq: number, orderId: number, reason: CloseReason): void;
  replaced(seq: number, orderId: number, price: number, qty: number): void;
}

export type AnySink = Sink | FlatSink;

export function isFlat(s: AnySink): s is FlatSink {
  return (s as FlatSink).flat === true;
}

/// Adapts a `Sink` to the `FlatSink` calls the book makes.
export class EventAdapter implements FlatSink {
  readonly flat = true as const;
  constructor(public inner: Sink) {}
  accepted(seq: number, orderId: number, leavesQty: number): void {
    this.inner.onEvent(seq, { kind: "accepted", orderId, leavesQty });
  }
  rejected(seq: number, orderId: number, reason: RejectReason): void {
    this.inner.onEvent(seq, { kind: "rejected", orderId, reason });
  }
  trade(seq: number, maker: number, taker: number, price: number, qty: number): void {
    this.inner.onEvent(seq, { kind: "trade", maker, taker, price, qty });
  }
  closed(seq: number, orderId: number, reason: CloseReason): void {
    this.inner.onEvent(seq, { kind: "closed", orderId, reason });
  }
  replaced(seq: number, orderId: number, price: number, qty: number): void {
    this.inner.onEvent(seq, { kind: "replaced", orderId, price, qty });
  }
}

/// Records (seq, event) pairs for tests and replay.
export class VecSink implements Sink {
  readonly seqs: number[] = [];
  readonly events: Event[] = [];
  onEvent(seq: number, ev: Event): void {
    this.seqs.push(seq);
    this.events.push(ev);
  }
  /// Canonical stream (one JSON line per event) — the golden-comparable form.
  canonical(): string {
    return this.seqs.map((s, i) => eventCanonical(s, this.events[i])).join("\n") + "\n";
  }
}

const M = 0x9e3779b1;
const mix = (a: number, b: number) => (Math.imul(a, M) + b) | 0;

/// Folds each event into a checksum — keeps the stream "consumed" during
/// benchmarks without storing it. Implements both sink shapes with the same
/// fold, so `acc` does not depend on which one the book used.
export class NullSink implements Sink, FlatSink {
  readonly flat = true as const;
  acc = 0;
  onEvent(seq: number, ev: Event): void {
    this.acc = (this.acc + seq * M + eventFold(ev)) | 0;
  }
  accepted(seq: number, orderId: number, leavesQty: number): void {
    this.acc = (this.acc + seq * M + mix(orderId, leavesQty)) | 0;
  }
  rejected(seq: number, orderId: number, reason: RejectReason): void {
    this.acc = (this.acc + seq * M + mix(orderId, reason)) | 0;
  }
  trade(seq: number, maker: number, taker: number, price: number, qty: number): void {
    this.acc = (this.acc + seq * M + mix(mix(maker, taker), mix(price, qty))) | 0;
  }
  closed(seq: number, orderId: number, reason: CloseReason): void {
    this.acc = (this.acc + seq * M + mix(orderId, reason)) | 0;
  }
  replaced(seq: number, orderId: number, price: number, qty: number): void {
    this.acc = (this.acc + seq * M + mix(orderId, mix(price, qty))) | 0;
  }
}

/// Emits canonical lines to a callback (e.g. process.stdout.write).
export class LinesSink implements Sink {
  constructor(private readonly write: (line: string) => void) {}
  onEvent(seq: number, ev: Event): void {
    this.write(eventCanonical(seq, ev));
  }
}
