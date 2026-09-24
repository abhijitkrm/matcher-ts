//! Command types + canonical serialization (spec/SCHEMA.md), vendored so
//! vectorgen builds standalone in every implementation repo. Must stay
//! byte-identical to `src/types.rs` in matcher-rust.

use core::fmt;

pub type OrderId = u64;
pub type Price = i64;
pub type Qty = u64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Side {
    Bid,
    Ask,
}

impl Side {
    #[inline]
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Bid => "bid",
            Side::Ask => "ask",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OType {
    Limit,
    Market,
}

impl OType {
    #[inline]
    pub fn as_str(self) -> &'static str {
        match self {
            OType::Limit => "limit",
            OType::Market => "market",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code)] // full TIF set mirrored from the spec; generator uses a subset
pub enum Tif {
    Gtc,
    Ioc,
    Fok,
    PostOnly,
}

impl Tif {
    #[inline]
    pub fn as_str(self) -> &'static str {
        match self {
            Tif::Gtc => "gtc",
            Tif::Ioc => "ioc",
            Tif::Fok => "fok",
            Tif::PostOnly => "post_only",
        }
    }
}

/// A command submitted to a book.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Command {
    New {
        order_id: OrderId,
        side: Side,
        otype: OType,
        price: Price,
        qty: Qty,
        tif: Tif,
    },
    Cancel {
        order_id: OrderId,
    },
    Replace {
        order_id: OrderId,
        price: Price,
        qty: Qty,
    },
}

impl Command {
    /// New limit order.
    #[inline]
    pub fn new(order_id: OrderId, side: Side, price: Price, qty: Qty, tif: Tif) -> Command {
        Command::New {
            order_id,
            side,
            otype: OType::Limit,
            price,
            qty,
            tif,
        }
    }

    /// New market order (never rests; price/tif ignored).
    #[inline]
    pub fn market(order_id: OrderId, side: Side, qty: Qty) -> Command {
        Command::New {
            order_id,
            side,
            otype: OType::Market,
            price: 0,
            qty,
            tif: Tif::Ioc,
        }
    }

    #[inline]
    pub fn cancel(order_id: OrderId) -> Command {
        Command::Cancel { order_id }
    }

    #[inline]
    pub fn replace(order_id: OrderId, price: Price, qty: Qty) -> Command {
        Command::Replace {
            order_id,
            price,
            qty,
        }
    }

    /// Canonical command line (SCHEMA.md) appended to `out`, no newline.
    /// Inverse of the vector-file parser used by the golden harnesses.
    pub fn write_canonical(&self, out: &mut String) {
        match *self {
            Command::New {
                order_id,
                side,
                otype,
                price,
                qty,
                tif,
            } => {
                let _ = fmt::Write::write_fmt(
                    out,
                    format_args!(
                        "{{\"cmd\":\"new\",\"order_id\":{},\"side\":\"{}\",\"otype\":\"{}\",\"price\":{},\"qty\":{},\"tif\":\"{}\"}}",
                        order_id,
                        side.as_str(),
                        otype.as_str(),
                        price,
                        qty,
                        tif.as_str()
                    ),
                );
            }
            Command::Cancel { order_id } => {
                let _ = fmt::Write::write_fmt(
                    out,
                    format_args!("{{\"cmd\":\"cancel\",\"order_id\":{}}}", order_id),
                );
            }
            Command::Replace {
                order_id,
                price,
                qty,
            } => {
                let _ = fmt::Write::write_fmt(
                    out,
                    format_args!(
                        "{{\"cmd\":\"replace\",\"order_id\":{},\"price\":{},\"qty\":{}}}",
                        order_id, price, qty
                    ),
                );
            }
        }
    }
}
