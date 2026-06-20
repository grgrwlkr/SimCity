//! Regression gate: production sim code must pull randomness from the seeded
//! `SimRng` (or `BuildingGrowthRng`), never from per-thread `rand::rng()` /
//! `thread_rng()`. Reproducibility of FixedUpdate@10Hz depends on it.

use std::path::Path;

fn scan_dir(dir: &Path, hits: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).expect("read_dir") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if path.is_dir() {
            scan_dir(&path, hits);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        // Skip test files (co-located test modules live in tests.rs / tests_*.rs / tests/).
        if name == "tests.rs"
            || name.starts_with("tests_")
            || path.components().any(|c| c.as_os_str() == "tests")
            || name == "no_thread_rng_guard.rs"
        {
            continue;
        }
        let src = std::fs::read_to_string(&path).expect("read file");
        let mut in_test_cfg = false;
        for (i, line) in src.lines().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("#[cfg(test)]") {
                in_test_cfg = true;
                continue;
            }
            if in_test_cfg {
                // Heuristic: the cfg(test) attribute guards the next item only;
                // once we leave indentation 0 module decl, treat following module body as test.
                in_test_cfg = false; // attribute consumed by next line; body handled below
            }
            if line.contains("rand::rng()") || line.contains("thread_rng()") {
                hits.push(format!("{}:{}: {}", path.display(), i + 1, trimmed));
            }
        }
    }
}

#[test]
fn no_unseeded_rng_in_sim_sources() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/game");
    let mut hits = Vec::new();
    scan_dir(&root, &mut hits);
    assert!(
        hits.is_empty(),
        "unseeded RNG found in sim code (use ResMut<SimRng> instead):\n{}",
        hits.join("\n")
    );
}
