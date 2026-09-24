//! vectorgen — deterministic benchmark corpus generator (spec/BENCH.md).
//!
//! Emits `<out>.setup.cmd.jsonl` (untimed book-build) and
//! `<out>.run.cmd.jsonl` (measured ops). Same seed => byte-identical corpora.
//!
//! Invariant maintained by construction: every generated resting add is
//! non-crossing (bids < MID <= asks), so live-id tracking for cancel/replace
//! is exact — no simulate-the-book needed.

use std::io::Write as _;

mod types;
use types::{Command, OType, Side, Tif};

const MID: i64 = 500_000;
const PMIN: i64 = 0;
const PMAX: i64 = 1_000_000;

/// xorshift64* — deterministic, dependency-free.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + self.below((hi - lo) as u64) as i64
    }
}

struct Gen {
    rng: Rng,
    next_id: u64,
    live: Vec<u64>, // ids known to be resting
    out: String,
}

impl Gen {
    fn emit(&mut self, cmd: Command) {
        self.out.clear();
        cmd.write_canonical(&mut self.out);
        self.out.push('\n');
    }
    /// Non-crossing GTC add; records id as live.
    fn add(&mut self, side: Side, lo: i64, hi: i64, qmax: u64) -> String {
        let id = self.next_id;
        self.next_id += 1;
        let price = self.rng.range(lo, hi);
        let qty = self.rng.below(qmax) + 1;
        self.emit(Command::new(id, side, price, qty, Tif::Gtc));
        self.live.push(id);
        self.out.clone()
    }
    fn pick_live(&mut self) -> u64 {
        let i = self.rng.below(self.live.len() as u64) as usize;
        self.live[i]
    }
    fn kill_live(&mut self) -> u64 {
        let i = self.rng.below(self.live.len() as u64) as usize;
        self.live.swap_remove(i)
    }
}

fn rand_side(r: &mut Rng) -> Side {
    if r.below(2) == 0 {
        Side::Bid
    } else {
        Side::Ask
    }
}

/// Non-crossing add parameters for a side.
fn add_cmd(g: &mut Gen, side: Side, spread_lo: i64, spread_hi: i64, qmax: u64) -> String {
    match side {
        // bids sit below MID, asks above
        Side::Bid => g.add(side, MID - spread_hi, MID - spread_lo, qmax),
        Side::Ask => g.add(side, MID + spread_lo, MID + spread_hi, qmax),
    }
}

fn header(workload: &str, seed: u64, max_orders: usize) -> String {
    format!(
        "{{\"format\":\"matcher-vector/1\",\"name\":\"{workload}\",\"pmin\":{PMIN},\"pmax\":{PMAX},\"max_orders\":{max_orders},\"index\":\"ladder\",\"workload\":\"{workload}\",\"seed\":{seed}}}\n"
    )
}

fn main() {
    let mut workload = "w1".to_string();
    let mut out = "bench/w1".to_string();
    let mut seed = 42u64;
    let mut n: usize = 1_000_000;
    let mut setup_n: usize = 0;

    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        let need = |i: usize| -> &String {
            args.get(i + 1).unwrap_or_else(|| {
                eprintln!("missing value for {}", args[i]);
                std::process::exit(2)
            })
        };
        match args[i].as_str() {
            "--workload" => workload = need(i).clone(),
            "--out" => out = need(i).clone(),
            "--seed" => seed = need(i).parse().unwrap(),
            "--n" => n = need(i).parse().unwrap(),
            "--setup-n" => setup_n = need(i).parse().unwrap(),
            _ => {
                eprintln!("unknown arg {}", args[i]);
                std::process::exit(2);
            }
        }
        i += 2;
    }
    if setup_n == 0 {
        setup_n = match workload.as_str() {
            "w1" => 0,
            "w2" => 200_000,
            "w5" => 100_000,
            _ => 100_000,
        };
    }

    let mut g = Gen {
        rng: Rng(seed | 1),
        next_id: 1,
        live: Vec::with_capacity(setup_n + n / 4 + 16),
        out: String::with_capacity(96),
    };

    let mut setup = String::with_capacity(setup_n * 80);
    let mut run = String::with_capacity(n * 80);
    let max_orders = setup_n + n + 16;

    // --- setup phase: dense non-crossing book around MID ---
    for _ in 0..setup_n {
        let side = rand_side(&mut g.rng);
        setup.push_str(&add_cmd(&mut g, side, 1, 5_000, 100));
    }

    // --- run phase per workload ---
    for _ in 0..n {
        match workload.as_str() {
            // W1: pure non-crossing GTC adds
            "w1" => {
                let side = rand_side(&mut g.rng);
                run.push_str(&add_cmd(&mut g, side, 1, 5_000, 100));
            }
            // W2: aggressive sweeps — marketable limits + markets
            "w2" => {
                let id = g.next_id;
                g.next_id += 1;
                let side = rand_side(&mut g.rng);
                let qty = g.rng.below(50) + 1;
                let cmd = if g.rng.below(10) < 3 {
                    Command::market(id, side, qty)
                } else {
                    // limit priced through 1..200 levels
                    let through = g.rng.range(1, 200);
                    let (price, tif) = match side {
                        Side::Bid => (MID + through, Tif::Ioc),
                        Side::Ask => (MID - through, Tif::Ioc),
                    };
                    Command::New {
                        order_id: id,
                        side,
                        otype: OType::Limit,
                        price,
                        qty,
                        tif,
                    }
                };
                g.emit(cmd);
                run.push_str(&g.out.clone());
            }
            // W3: ~80% cancel/replace churn on live ids, ~20% adds
            "w3" => {
                let r = g.rng.below(100);
                if r < 40 && !g.live.is_empty() {
                    let id = g.kill_live();
                    g.emit(Command::cancel(id));
                    run.push_str(&g.out.clone());
                } else if r < 80 && !g.live.is_empty() {
                    let id = g.pick_live();
                    let side = if g.rng.below(2) == 0 { Side::Bid } else { Side::Ask };
                    let (price, qty) = match side {
                        Side::Bid => (g.rng.range(MID - 5_000, MID - 1), g.rng.below(100) + 1),
                        Side::Ask => (g.rng.range(MID + 1, MID + 5_000), g.rng.below(100) + 1),
                    };
                    g.emit(Command::replace(id, price, qty));
                    run.push_str(&g.out.clone());
                } else {
                    let side = rand_side(&mut g.rng);
                    run.push_str(&add_cmd(&mut g, side, 1, 5_000, 100));
                }
            }
            // W4/W5: exchange-ish mix 9% GTC / 3% IOC / 6% cancel / 82% replace
            "w4" | "w5" => {
                let r = g.rng.below(100);
                if r < 82 && !g.live.is_empty() {
                    let id = g.pick_live();
                    let side = if g.rng.below(2) == 0 { Side::Bid } else { Side::Ask };
                    let (price, qty) = match side {
                        Side::Bid => (g.rng.range(MID - 5_000, MID - 1), g.rng.below(100) + 1),
                        Side::Ask => (g.rng.range(MID + 1, MID + 5_000), g.rng.below(100) + 1),
                    };
                    g.emit(Command::replace(id, price, qty));
                    run.push_str(&g.out.clone());
                } else if r < 88 && !g.live.is_empty() {
                    let id = g.kill_live();
                    g.emit(Command::cancel(id));
                    run.push_str(&g.out.clone());
                } else if r < 91 {
                    let id = g.next_id;
                    g.next_id += 1;
                    let side = rand_side(&mut g.rng);
                    let qty = g.rng.below(50) + 1;
                    let price = match side {
                        Side::Bid => MID + g.rng.range(1, 100),
                        Side::Ask => MID - g.rng.range(1, 100),
                    };
                    g.emit(Command::New {
                        order_id: id,
                        side,
                        otype: OType::Limit,
                        price,
                        qty,
                        tif: Tif::Ioc,
                    });
                    run.push_str(&g.out.clone());
                } else {
                    let side = rand_side(&mut g.rng);
                    run.push_str(&add_cmd(&mut g, side, 1, 5_000, 100));
                }
            }
            w => {
                eprintln!("unknown workload {w}");
                std::process::exit(2);
            }
        }
    }

    let mut f = std::fs::File::create(format!("{out}.setup.cmd.jsonl")).unwrap();
    f.write_all(header(&workload, seed, max_orders).as_bytes()).unwrap();
    f.write_all(setup.as_bytes()).unwrap();
    let mut f = std::fs::File::create(format!("{out}.run.cmd.jsonl")).unwrap();
    f.write_all(header(&workload, seed, max_orders).as_bytes()).unwrap();
    f.write_all(run.as_bytes()).unwrap();
    eprintln!(
        "vectorgen {workload}: setup={setup_n} run={n} seed={seed} -> {out}.{{setup,run}}.cmd.jsonl"
    );
}
