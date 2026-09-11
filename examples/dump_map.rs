//! Reference maps for the TypeScript port: runs `GameCommand::GenerateMap` through the composed
//! headless game (the same path a player's "new map" takes) and dumps per-cell height and water.
//!
//! Run: `cargo run --example dump_map > packages/sim/test/fixtures/map-generation.json`

#[path = "common/mod.rs"]
mod common;

use simcity_sim::game::commands::GameCommand;
use simcity_sim::game::map::MapGrid;

const SEEDS: [u64; 4] = [1, 7, 42, 1_000_003];

fn main() {
    let mut maps = Vec::new();
    for seed in SEEDS {
        let mut app = common::headless_app();
        common::enter_game(&mut app);
        common::send(&mut app, GameCommand::GenerateMap { seed });
        app.update();

        let grid = app.world().resource::<MapGrid>();
        maps.push(format!(
            "    {{ \"seed\": \"{seed}\", \"width\": {}, \"height\": {}, \"heightHex\": \"{}\", \"waterHex\": \"{}\" }}",
            grid.width,
            grid.height,
            common::hex(grid.cells.iter().map(|c| c.height)),
            common::hex(grid.cells.iter().map(|c| u8::from(c.water))),
        ));
    }
    println!("{{\n  \"maps\": [\n{}\n  ]\n}}", maps.join(",\n"));
}
