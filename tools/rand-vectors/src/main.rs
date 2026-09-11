//! Reference vectors for the TS port of `rand::rngs::StdRng` (rand 0.10.1, ChaCha12).
//!
//! Every op below mirrors a sampler call shape the Rust SimCity sim uses. The op at index `i`
//! is chosen by `op_for(i)`; the TS test replays the same schedule and compares each output
//! string verbatim. Regenerate with:
//! `cargo run --release --offline > ../../packages/sim/test/fixtures/rand-0.10.1-vectors.json`

use rand::rngs::StdRng;
use rand::seq::{IndexedRandom, SliceRandom};
use rand::{Rng, RngExt, SeedableRng};

const SEEDS: [u64; 9] = [
    0,
    1,
    2,
    7,
    42,
    424_242,
    1_000_003,
    u64::MAX,
    0x0123_4567_89ab_cdef,
];
const OPS_PER_SEED: u32 = 800;
const OP_KINDS: u32 = 17;

fn op_for(i: u32) -> u32 {
    i.wrapping_mul(7).wrapping_add(3) % OP_KINDS
}

fn run_op(rng: &mut StdRng, i: u32) -> String {
    match op_for(i) {
        0 => format!("u32:{}", rng.next_u32()),
        1 => format!("u64:{}", rng.next_u64()),
        2 => {
            let len = (i % 97) as usize + 1;
            format!("usize_lt:{len}:{}", rng.random_range(0..len))
        }
        3 => format!("i32:3:10:{}", rng.random_range(3..10i32)),
        4 => format!("i32:0:128:{}", rng.random_range(0..128i32)),
        5 => format!("u8_incl:0:255:{}", rng.random_range(0..=u8::MAX)),
        6 => format!("u64_incl:1:max:{}", rng.random_range(1..=u64::MAX)),
        7 => format!("f32:1:3:{}", rng.random_range(1.0f32..3.0f32).to_bits()),
        8 => format!("f64:0:10:{}", rng.random_range(0.0f64..10.0f64).to_bits()),
        9 => format!("bool:0.35:{}", rng.random_bool(0.35)),
        10 => {
            let n = i % 20;
            let mut v: Vec<u32> = (0..n).collect();
            v.shuffle(rng);
            let joined: Vec<String> = v.iter().map(u32::to_string).collect();
            format!("shuffle:{n}:{}", joined.join(","))
        }
        11 => {
            let n = i % 5;
            let v: Vec<u32> = (0..n).collect();
            let picked = v
                .choose(rng)
                .map_or_else(|| "none".to_string(), u32::to_string);
            format!("choose:{n}:{picked}")
        }
        12 => format!("f32:0:1:{}", rng.random_range(0.0f32..1.0f32).to_bits()),
        13 => format!(
            "f32:0.85:1.15:{}",
            rng.random_range(0.85f32..1.15f32).to_bits()
        ),
        14 => format!(
            "f64:0:37.3:{}",
            rng.random_range(0.0f64..37.3f64).to_bits()
        ),
        15 => format!("bool:0.05:{}", rng.random_bool(0.05)),
        _ => format!("bool:1:{}", rng.random_bool(1.0)),
    }
}

fn main() {
    let mut cases = Vec::new();
    for seed in SEEDS {
        let mut rng = StdRng::seed_from_u64(seed);
        let ops: Vec<String> = (0..OPS_PER_SEED)
            .map(|i| format!("\"{}\"", run_op(&mut rng, i)))
            .collect();
        cases.push(format!(
            "    {{ \"seed\": \"{seed}\", \"ops\": [{}] }}",
            ops.join(", ")
        ));
    }

    // Buffer-boundary pins: `k` u32 draws on a fresh generator, then one u64. Covers the
    // 64-word block edge (k = 63 straddles, k = 64 starts a fresh block).
    let boundary: Vec<String> = (0..130u32)
        .map(|k| {
            let mut rng = StdRng::seed_from_u64(7);
            for _ in 0..k {
                rng.next_u32();
            }
            format!("\"{}\"", rng.next_u64())
        })
        .collect();

    println!("{{");
    println!("  \"rand\": \"0.10.1\",");
    println!("  \"opKinds\": {OP_KINDS},");
    println!("  \"cases\": [");
    println!("{}", cases.join(",\n"));
    println!("  ],");
    println!("  \"boundarySeed\": \"7\",");
    println!("  \"boundary\": [{}]", boundary.join(", "));
    println!("}}");
}
