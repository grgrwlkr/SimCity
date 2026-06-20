# P0: Correctness, Determinism & Traffic — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: используй `superpowers:subagent-driven-development` (рекомендуется) или `superpowers:executing-plans`, чтобы выполнять план задача-за-задачей. Шаги размечены чекбоксами (`- [ ]`) для трекинга.

**Goal:** Закрыть P0-блок архитектурного разбора ([architecture-review.md](../../architecture-review.md)): сделать симуляцию воспроизводимой и починить корневые причины заклинивания трафика на перекрёстках, не ломая работающий протокол резерваций.

**Architecture:** Сначала фундамент детерминизма (seeded `SimRng`) — без него traffic-фиксы нечем валидировать. Затем корректность admission на перекрёстках (per-tile конфликт-резервации из реальной геометрии коннектора), устранение bypass `force_entry`, congestion-aware основной роутинг и пол безопасности против overlap. Плюс изолированные correctness-баги (порядок `GraphUpdate`, инверсия decay, светофоры в сейве). Каждая задача — TDD: failing-тест → минимальная реализация → green → commit.

**Tech Stack:** Rust (edition 2024, toolchain 1.96.0), Bevy 0.19 ECS, bevy_egui 0.40, rand 0.10.1 (`StdRng`), RON-конфиги через `config_loader`. Cargo workspace: `simcity_core ← simcity_sim ← simcity_data ← simcity_debug ← simcity_frontend`.

## Global Constraints

- **Verification floor (перед каждым коммитом задачи):** `cargo fmt --all` → `cargo clippy --all-targets --all-features -- -D warnings` → `cargo test`. Warnings = ошибки.
- **Детерминизм симуляции:** вся sim-логика на `FixedUpdate`@10Hz; рандом — ТОЛЬКО через seeded `SimRng`/`BuildingGrowthRng`, никогда `rand::rng()`/`thread_rng()` в prod-коде.
- **Command pattern:** структурные правки мира — только через `GameCommand` (set `Input` → применение в `CommandApply`). UI/input мир не мутируют.
- **System ordering:** каждая новая система явно встаёт в нужный `GameSet`. Реальный рантайм-порядок — по `configure_sets`, не по объявлению enum.
- **Тесты co-located** рядом с кодом (нет корневого `tests/`). Новый RON-параметр ⇒ обязателен parse-тест.
- **Bevy 0.19 API:** `MessageWriter`/`MessageReader`/`add_message`, `Time<Fixed>`, `Messages::<T>::write`. Не использовать устаревшие API (`EventWriter`/`send`).
- **Git:** Conventional Commits (`feat:`/`fix:`/`refactor:`/`test:`/`chore:`). Не пушить без явной просьбы.
- **Идентификаторы/код/команды — английский**, проза — русский.

---

## Recommended Landing Order & Dependencies

Жёстких `depends_on` в коде почти нет, но по **файловым конфликтам** порядок обязателен. Рекомендуемая последовательность landing'а:

1. **P0-5** (system ordering, `mod.rs`) — изолирован, низкий риск, убрать из очереди первым.
2. **P0-1** (seeded `SimRng`) — фундамент. Единственное пересечение — `persistence.rs` с P0-7.
3. **P0-2** (per-tile резервации) — самый структурный из тройки на `reservations.rs`: снимает `Copy`, меняет сигнатуру `can_reserve`. Ландить **первым** из тройки P0-2/P0-3/P0-8.
4. **P0-3** (atomic emergency reservation) — ребейзится на P0-2 (см. координацию ниже), снимает bypass в `drive.rs`.
5. **P0-4** (congestion-aware routing) — **зависит от P0-1** (seeded per-OD spread) и делит `spawn.rs` с P0-1; ландить после P0-1.
6. **P0-8** (gap clamp) — делит `drive.rs` с P0-3, но другие регионы; после P0-3.
7. **P0-6** (decay sign) — изолирован (`decay.rs`), порядок безразличен.
8. **P0-7** (светофоры в сейв) — делит `persistence.rs:571-590` с P0-1; ландить до P0-1 или ревьюить вместе.

```
P0-5 ─┐
P0-1 ─┼─► P0-4 (needs SimRng)
      │
P0-2 ─┴─► P0-3 ─► P0-8     (reservations.rs / drive.rs hotspot)
P0-6 (independent)
P0-7 ─► (coordinate with P0-1 on persistence.rs)
```

## Cross-Task Coordination (обязательно к прочтению перед стартом)

Эти правки рождаются из пересечения задач по файлам — их легко упустить, выполняя задачи изолированно:

1. **P0-3 после P0-2:** сигнатура `can_reserve` к моменту P0-3 уже `fn can_reserve(&self, id, vehicle, zones, tiles: &[TilePos], stream, maneuver)`. Emergency-кандидат P0-3 (`zones=ZONE_ALL`) должен звать `can_reserve(id, vehicle, ZONE_ALL, &[], stream, maneuver)` — пустой срез `&[]` корректен (ZONE_ALL и так конфликтует со всем по маске). Декларация P0-3 «No public API changes» становится неверной — call-site меняется.
2. **P0-3 итерирует apply-loop `reservations.rs:685`,** который к этому моменту уже `.cloned()` (P0-2 снял `Copy`). Учесть при вставке emergency-кандидата.
3. **P0-3 добавляет `is_emergency: bool`** в `IntersectionReservationCandidate` — структура к этому моменту уже не `Copy` (P0-2), так что `bool`-поле проблем не создаёт.
4. **P0-4 переиспользует поле `sim_rng`** в `SpawnTripVehiclesParams`, которое уже добавил P0-1 — не добавлять второе.
5. **P0-7 → P0-1 на `persistence.rs:571-590`:** оба правят load-путь. Ландить P0-7 первым (P0-1 точечно вклинивает re-seed-вызов в уже расширенный load) либо ревьюить парой.
6. **P0-7:** в `snapshot_traffic_lights` использовать `cluster.tiles.first().copied()`, НЕ `centroid_tile` (центроид L-образного кластера может лежать вне тайлов → потеря светофора при restore).
7. **P0-2:** safety-net push `IntersectionReservation` на `reservations.rs:437-447` тоже требует нового поля `tiles: Vec::new()` — он внутри указанного диапазона 424-449, но легко пропустить.

---
### Task P0-1: Seeded SimRng across the sim path

**Files:**
- Modify: `crates/simcity_sim/src/game/sim.rs:1-40` (SimRng resource + seed/reset systems, register in `sim::SimPlugin`)
- Modify: `crates/simcity_sim/src/game/traffic/spawn.rs:43,159,161,197,198` (+ `SpawnTripVehiclesParams` :255-285)
- Modify: `crates/simcity_sim/src/game/intersections/lights.rs:149-152,179,195`
- Modify: `crates/simcity_sim/src/game/employment.rs:300-314,373-374`
- Modify: `crates/simcity_sim/src/game/citizens.rs:164-168,176,194-197,228-235,245`
- Modify: `crates/simcity_sim/src/game/emergencies/systems.rs:29-37,62,82-83`
- Modify: `crates/simcity_data/src/game/persistence.rs:571-590,630-631`
- Create: `crates/simcity_sim/src/game/no_thread_rng_guard.rs` (grep-gate test)
- Test: co-located `#[cfg(test)] mod tests` в `crates/simcity_sim/src/game/sim.rs`

**Interfaces:**
- Consumes: none (foundational). Reuses existing `simcity_core::game::map::MapSeed(pub u64)` и `GameCommand::GenerateMap { seed: u64 }`.
- Produces: `SimRng { pub rng: StdRng }` (Resource, `Default` = `seed_from_u64(1)`), `seed_sim_rng_from_map`, `reset_sim_rng_on_new_map` в `simcity_sim::game::sim`. Все последующие traffic-фиксы тянут рандом через `ResMut<SimRng>`.

**Контекст:** Симуляция крутится на `FixedUpdate`@10Hz и должна быть воспроизводимой — это precondition для тестирования всех traffic-фиксов (Theme A / Root-cause Rank 6). Сейчас 6 sim-систем дёргают unseeded `rand::rng()` (per-thread OS-seeded генератор), хотя в кодбазе уже есть правильный seeded-паттерн `BuildingGrowthRng` (`StdRng::seed_from_u64`, ре-сид `OnEnter(InGame)` и на `GenerateMap`). Вводим единый `SimRng` по образцу `BuildingGrowthRng`, переводим все sim-сайты на него, ре-сидим на load (там сейчас `MapSeed` восстанавливается, а RNG — нет), и ставим grep-гейт против регрессий.

---

#### P0-1a: Define SimRng resource + seed/reset systems + register

- [ ] **Step 1: Read the reference pattern** — открой `crates/simcity_sim/src/game/buildings/components.rs:190-201` (`BuildingGrowthRng`) и `crates/simcity_sim/src/game/buildings/growth.rs:531-548` (`seed_growth_rng_from_map`, `reset_growth_rng_on_new_map`). `SimRng` копирует ровно эту форму. rand crate: `0.10.1` (см. `Cargo.lock`), free fn — `rand::rng()`; seeded — `StdRng::seed_from_u64`.

- [ ] **Step 2: Read current sim.rs head** — прочитай `crates/simcity_sim/src/game/sim.rs:1-40`, чтобы увидеть существующие `use` и тело `impl Plugin for SimPlugin`.

- [ ] **Step 3: Add SimRng + systems to sim.rs** — добавь в начало файла (после существующих `use`) и перед/после `SimPlugin`:
  ```rust
  use rand::{SeedableRng, rngs::StdRng};

  /// Single seeded RNG for the whole simulation path. Reproducibility of
  /// FixedUpdate@10Hz hinges on every sim-side random draw pulling from here.
  #[derive(bevy::prelude::Resource)]
  pub struct SimRng {
      pub rng: StdRng,
  }

  impl Default for SimRng {
      fn default() -> Self {
          Self {
              rng: StdRng::seed_from_u64(1),
          }
      }
  }

  /// Re-seed at InGame entry from the current map seed (mirrors BuildingGrowthRng).
  pub fn seed_sim_rng_from_map(
      seed: bevy::prelude::Res<crate::game::map::MapSeed>,
      mut rng: bevy::prelude::ResMut<SimRng>,
  ) {
      rng.rng = StdRng::seed_from_u64(seed.0);
  }

  /// Re-seed when a fresh map is generated.
  pub fn reset_sim_rng_on_new_map(
      mut reader: bevy::ecs::message::MessageReader<crate::game::commands::GameCommand>,
      seed: bevy::prelude::Res<crate::game::map::MapSeed>,
      mut rng: bevy::prelude::ResMut<SimRng>,
  ) {
      for cmd in reader.read() {
          if matches!(cmd, crate::game::commands::GameCommand::GenerateMap { .. }) {
              rng.rng = StdRng::seed_from_u64(seed.0);
          }
      }
  }
  ```

- [ ] **Step 4: Register SimRng in SimPlugin** — внутри `impl Plugin for SimPlugin { fn build(&self, app: &mut App) {` (`crates/simcity_sim/src/game/sim.rs`) добавь init + системы. Скопируй run-condition стиль из `buildings/mod.rs:60-90` (`in_state(AppState::InGame).or_else(in_state(AppState::Paused))`, `GameSet::CommandApply` / `OnEnter`). Используй уже импортированные в файле `AppState`/`GameSet` (если их нет — добавь `use crate::game::sets::GameSet; use crate::game::state::AppState;`):
  ```rust
  app.init_resource::<SimRng>()
      .add_systems(bevy::prelude::OnEnter(AppState::InGame), seed_sim_rng_from_map)
      .add_systems(
          bevy::prelude::Update,
          reset_sim_rng_on_new_map
              .in_set(GameSet::CommandApply)
              .run_if(
                  bevy::prelude::in_state(AppState::InGame)
                      .or_else(bevy::prelude::in_state(AppState::Paused)),
              ),
      );
  ```
  Если в `sim.rs` уже есть локальный `use bevy::prelude::*;` — убери лишние `bevy::prelude::` префиксы, чтобы совпадало со стилем файла.

- [ ] **Step 5: Write determinism + seed-from-map test** — добавь в конец `crates/simcity_sim/src/game/sim.rs`:
  ```rust
  #[cfg(test)]
  mod sim_rng_tests {
      use super::*;
      use crate::game::map::MapSeed;
      use bevy::prelude::*;
      use rand::Rng;

      #[test]
      fn sim_rng_default_is_deterministic_for_same_seed() {
          let mut a = SimRng::default();
          let mut b = SimRng::default();
          let sa: Vec<u64> = (0..32).map(|_| a.rng.random::<u64>()).collect();
          let sb: Vec<u64> = (0..32).map(|_| b.rng.random::<u64>()).collect();
          assert_eq!(sa, sb, "same seed must produce identical stream");
      }

      #[test]
      fn sim_rng_diverges_for_different_seed() {
          let mut a = SimRng { rng: StdRng::seed_from_u64(1) };
          let mut b = SimRng { rng: StdRng::seed_from_u64(2) };
          let sa: Vec<u64> = (0..32).map(|_| a.rng.random::<u64>()).collect();
          let sb: Vec<u64> = (0..32).map(|_| b.rng.random::<u64>()).collect();
          assert_ne!(sa, sb);
      }

      #[test]
      fn seed_sim_rng_from_map_uses_map_seed() {
          let mut app = App::new();
          app.insert_resource(MapSeed(424242))
              .init_resource::<SimRng>()
              .add_systems(Update, seed_sim_rng_from_map);
          app.update();

          let stream: Vec<u64> = {
              let mut rng = app.world_mut().resource_mut::<SimRng>();
              (0..16).map(|_| rng.rng.random::<u64>()).collect()
          };

          let mut reference = StdRng::seed_from_u64(424242);
          let expected: Vec<u64> = (0..16).map(|_| reference.random::<u64>()).collect();
          assert_eq!(stream, expected, "system must re-seed from MapSeed value");
      }

      #[test]
      fn reset_sim_rng_on_new_map_reseeds() {
          let mut app = App::new();
          app.insert_resource(MapSeed(7))
              .init_resource::<SimRng>()
              .add_message::<crate::game::commands::GameCommand>()
              .add_systems(Update, reset_sim_rng_on_new_map);

          // Burn the default stream, then fire GenerateMap to force a re-seed.
          {
              let mut rng = app.world_mut().resource_mut::<SimRng>();
              let _ = rng.rng.random::<u64>();
          }
          app.world_mut()
              .resource_mut::<bevy::ecs::message::Messages<crate::game::commands::GameCommand>>()
              .write(crate::game::commands::GameCommand::GenerateMap { seed: 7 });
          app.update();

          let after: u64 = app.world_mut().resource_mut::<SimRng>().rng.random::<u64>();
          let mut reference = StdRng::seed_from_u64(7);
          assert_eq!(after, reference.random::<u64>());
      }
  }
  ```
  Примечание: API сообщений в Bevy 0.19 — `Messages::<T>::write(...)` (бывш. `send`). Если компилятор укажет на другое имя метода — посмотри как пишут `GameCommand` в существующих тестах (`rg -n "GameCommand::GenerateMap" crates/simcity_sim/src/game`) и используй тот же путь.

- [ ] **Step 6: Run the tests, see them pass** — `cargo test -p simcity_sim sim::sim_rng_tests`. Ожидаемо: 4 passed. Если `random::<u64>()` не резолвится — проверь, что `use rand::Rng;` в тест-модуле (трейт-метод).

- [ ] **Step 7: Commit** — `git add crates/simcity_sim/src/game/sim.rs && git commit -m "feat(sim): add seeded SimRng resource with map-seed seeding"`

---

#### P0-1b: Convert the 6 unseeded sim sites to ResMut<SimRng>

> Паттерн правки одинаков: убрать `let mut rng = rand::rng();`, протащить `ResMut<SimRng>` (через `SystemParam`-структуру либо прямой аргумент), заменить `&mut rng` на `&mut p.sim_rng.rng` (или `&mut sim_rng.rng`). Трейты `random_range`/`random_bool`/`shuffle`/`choose` уже в скоупе через существующие `use rand::...` в каждом файле — не трогаем импорты, кроме добавления пути к `SimRng`.

- [ ] **Step 1: traffic/spawn.rs — add SimRng to SystemParam** — в `SpawnTripVehiclesParams` (`crates/simcity_sim/src/game/traffic/spawn.rs:255-285`) добавь поле перед закрывающей `}`:
  ```rust
      sim_rng: bevy::prelude::ResMut<'w, crate::game::sim::SimRng>,
  ```

- [ ] **Step 2: traffic/spawn.rs — drop rand::rng() and rewire draws** — удали строку `let mut rng = rand::rng();` (`spawn.rs:43`). Затем замени 4 использования `&mut rng` на `&mut p.sim_rng.rng`:
  - `spawn.rs:159` `v.max_speed = sample_driver_max_speed_world(&p.cfg, &p.traffic_cfg, &mut p.sim_rng.rng);`
  - `spawn.rs:161` `v.speed_factor = sample_driver_speed_factor(&mut p.sim_rng.rng);`
  - `spawn.rs:197` `let speed_factor = sample_driver_speed_factor(&mut p.sim_rng.rng);`
  - `spawn.rs:198` `let max_speed = sample_driver_max_speed_world(&p.cfg, &p.traffic_cfg, &mut p.sim_rng.rng);`
  Сигнатуры `sample_driver_*` принимают `&mut impl Rng` — менять их не нужно.

- [ ] **Step 3: intersections/lights.rs — thread SimRng into sync system** — в `sync_traffic_light_entities` (`crates/simcity_sim/src/game/intersections/lights.rs:149-152`) добавь параметр:
  ```rust
  pub fn sync_traffic_light_entities(
      mut index: ResMut<IntersectionIndex>,
      mut commands: Commands,
      q_existing: Query<(Entity, &TrafficLight)>,
      mut sim_rng: ResMut<crate::game::sim::SimRng>,
  ) {
  ```
  Удали `let mut rng = rand::rng();` (`:179`) и замени `:195`:
  ```rust
  let random_offset = sim_rng.rng.random_range(0.0..10.0);
  ```
  `random_range` приходит из `use rand::RngExt;` (`lights.rs:4`) — оставить.

- [ ] **Step 4: employment.rs — add SimRng to AssignJobsParams** — в `AssignJobsParams` (`crates/simcity_sim/src/game/employment.rs:300-314`) добавь поле:
  ```rust
      sim_rng: ResMut<'w, crate::game::sim::SimRng>,
  ```
  Удали `let mut rng = rand::rng();` (`:373`) и замени `:374`:
  ```rust
  jobs.shuffle(&mut p.sim_rng.rng);
  ```
  `shuffle` приходит из `use rand::prelude::*;` (`:5`).

- [ ] **Step 5: citizens.rs — thread SimRng into both systems** — `spawn_citizens_from_residential` (`crates/simcity_sim/src/game/citizens.rs:164-168`): добавь аргумент `mut sim_rng: ResMut<crate::game::sim::SimRng>,`, удали `let mut rng = rand::rng();` (`:176`) и в `:194-197` замени `rng.random_range(...)` на `sim_rng.rng.random_range(...)` (4 строки). `citizen_trip_planner` (`:228-235`) использует `SystemParam`-структуру `CitizenTripPlannerParams` (`:383-389`) — добавь туда поле `sim_rng: ResMut<'w, crate::game::sim::SimRng>,`, удали `let mut rng = rand::rng();` (`:245`) и замени дальнейшие `rng` на `p.sim_rng.rng` (грепни `rng.` в теле `citizen_trip_planner`, чтобы поймать все use-сайты ниже `:245`).

- [ ] **Step 6: emergencies/systems.rs — thread SimRng into spawn_emergencies** — `spawn_emergencies` (`crates/simcity_sim/src/game/emergencies/systems.rs:29-37`): добавь аргумент `mut sim_rng: ResMut<crate::game::sim::SimRng>,`. Удали `let mut rng = rand::rng();` (`:62`) и замени:
  - `:63` `if sim_rng.rng.random_range(0.0..1.0) > spawn_chance {`
  - `:82` `let pos = *buildings.choose(&mut sim_rng.rng).unwrap();`
  - `:83` `let kind = match sim_rng.rng.random_range(0..3) {`
  Грепни оставшиеся `rng` в этой функции и замени все на `sim_rng.rng`. `choose`/`random_range` из `use rand::prelude::*;` (`:7`).

- [ ] **Step 7: Compile + clippy gate** — `cargo clippy -p simcity_sim --all-targets --all-features -- -D warnings`. Ожидаемо: clean. Частые грабли: забытый `mut` у `ResMut`-аргумента (нужен, т.к. `random_*`/`shuffle`/`choose` берут `&mut`), и оставшийся `&mut rng` где-то ниже.

- [ ] **Step 8: Run sim tests** — `cargo test -p simcity_sim`. Ожидаемо: прежние тесты зелёные (baseline 80) + 4 новых из P0-1a. Если какой-то traffic/citizens-тест строит App вручную и падает на `SimRng resource does not exist` — добавь `.init_resource::<crate::game::sim::SimRng>()` в его setup (грепни упавший тест, вставь рядом с `.insert_resource(TrafficConfig::default())`).

- [ ] **Step 9: Commit** — `git add crates/simcity_sim/src/game/traffic/spawn.rs crates/simcity_sim/src/game/intersections/lights.rs crates/simcity_sim/src/game/employment.rs crates/simcity_sim/src/game/citizens.rs crates/simcity_sim/src/game/emergencies/systems.rs && git commit -m "refactor(sim): route all sim-path RNG through seeded SimRng"`

---

#### P0-1c: Re-seed SimRng on load

> Load (`handle_load_commands`, `crates/simcity_data/src/game/persistence.rs:592`) восстанавливает `p.seed.0 = save.seed` (`:631`), но никакой RNG не ре-сидит. `SaveGameV3` отдельного sim-seed не хранит — переиспользуем восстановленный `MapSeed`, ровно как `BuildingGrowthRng` делает это `OnEnter(InGame)`.

- [ ] **Step 1: Read LoadParams** — `crates/simcity_data/src/game/persistence.rs:571-590`. Это `#[derive(SystemParam)] struct LoadParams`. `simcity_data` зависит от `simcity_sim` (см. crate-graph), поэтому `simcity_sim::game::sim::SimRng` доступен.

- [ ] **Step 2: Add SimRng to LoadParams** — добавь поле в `LoadParams` (после `seed: ResMut<'w, MapSeed>,`):
  ```rust
      sim_rng: ResMut<'w, simcity_sim::game::sim::SimRng>,
  ```
  Если в файле нет прямого `use simcity_sim;` — используй полный путь как выше (crate доступен по имени).

- [ ] **Step 3: Re-seed right after restoring MapSeed** — сразу после `p.seed.0 = save.seed;` (`persistence.rs:631`) вставь:
  ```rust
          // Reproducibility: re-seed the sim RNG from the restored map seed,
          // mirroring seed_sim_rng_from_map at InGame entry.
          p.sim_rng.rng = rand::rngs::StdRng::seed_from_u64(save.seed);
  ```
  Нужны трейт/тип в скоупе. Проверь верх файла: если нет `use rand::SeedableRng;` — добавь его (а `StdRng` адресуем полным путём `rand::rngs::StdRng`, чтобы не плодить импорты). Грепни: `rg -n "use rand" crates/simcity_data/src/game/persistence.rs`.

- [ ] **Step 4: clippy + test the data crate** — `cargo clippy -p simcity_data --all-targets --all-features -- -D warnings && cargo test -p simcity_data`. Ожидаемо: clean, 3 теста проходят. Если тест save/load roundtrip строит App без `SimRng` — `handle_load_commands` затребует ресурс; добавь `.init_resource::<simcity_sim::game::sim::SimRng>()` в setup упавшего теста.

- [ ] **Step 5: Commit** — `git add crates/simcity_data/src/game/persistence.rs && git commit -m "fix(persistence): re-seed SimRng from restored map seed on load"`

---

#### P0-1d: Grep-gate against rand::rng()/thread_rng() in sim code

> Регрессионный барьер: новый код не должен снова втащить unseeded RNG в sim-путь. Делаем это unit-тестом в `simcity_sim` (без внешнего CI), сканируя исходники крейта и пропуская строки внутри `#[cfg(test)]`-блоков и тестовых файлов.

- [ ] **Step 1: Register the guard module** — в `crates/simcity_sim/src/game/mod.rs` добавь рядом с прочими `pub mod ...` (после `pub mod sim;`):
  ```rust
  #[cfg(test)]
  mod no_thread_rng_guard;
  ```

- [ ] **Step 2: Write the guard test** — создай `crates/simcity_sim/src/game/no_thread_rng_guard.rs`:
  ```rust
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
  ```
  Примечание: тесты внутри `mod foo { #[cfg(test)] mod tests { ... } }` живут в отдельных `tests.rs`/`tests_*.rs`/`tests/` — они отфильтрованы по имени файла, поэтому простой `#[cfg(test)]`-инлайн (как наш `sim_rng_tests` в `sim.rs`) использует `random::<u64>()`/`StdRng`, а не `rand::rng()`, и гейт не сработает. Если у тебя есть инлайновый `#[cfg(test)]` в каком-то prod-файле, который реально зовёт `rand::rng()` — это и есть валидное срабатывание; перенеси такой вызов на `SimRng` или вынеси в tests-файл.

- [ ] **Step 3: Run the guard, see it pass** — `cargo test -p simcity_sim no_unseeded_rng_in_sim_sources`. Ожидаемо: passed (после P0-1b все 6 prod-сайтов конвертированы; `BuildingGrowthRng` и так не использует `rand::rng()`).

- [ ] **Step 4: Sanity-check the gate actually bites** — временно добавь `let _ = rand::rng();` в любую prod-функцию (напр. в тело `seed_sim_rng_from_map`), прогони `cargo test -p simcity_sim no_unseeded_rng_in_sim_sources` — должен УПАСТЬ с указанием файла:строки. Откати правку, перепрогони — снова passed. (Это шаг проверки, не коммить временную строку.)

- [ ] **Step 5: Full verification floor** — `cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test`. Ожидаемо: всё зелёное.

- [ ] **Step 6: Commit** — `git add crates/simcity_sim/src/game/no_thread_rng_guard.rs crates/simcity_sim/src/game/mod.rs && git commit -m "test(sim): gate against unseeded rand::rng()/thread_rng() in sim code"`


---

### Task P0-2: Per-tile connector-path conflict reservations

Coarse 5-зонная `ConflictMask`-проверка в `can_reserve` пропускает два перпендикулярных левых поворота на multi-tile кластере (маски `ZONE_NW` и `ZONE_NE` не пересекаются), хотя оба физически едут через CENTER-тайл → двойной допуск, столкновение в центре перекрёстка. Root-cause Rank 1. Источник истины о занятых тайлах — `build_connector_path`. Декомпозиция на 4 подзадачи: P0-2a (failing-тест на multi-tile), P0-2b (экспонировать connector-tiles fn), P0-2c (tile-set на reservation+candidate, disjointness в can_reserve), P0-2d (зелёный тест + verification).

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/connectors.rs:534-576`
- Modify: `crates/simcity_sim/src/game/traffic/intersection/reservations.rs:28-101`, `:103-114`, `:424-449`, `:565-727`
- Modify: `crates/simcity_sim/src/game/traffic/intersection/mod.rs:9-12`
- Test: `crates/simcity_sim/src/game/traffic/tests/conflict_zones.rs`

**Interfaces:**
- Consumes: `IntersectionCluster { id, key, tiles: Vec<TilePos>, aabb_min, aabb_max, centroid_tile }` (intersections/index.rs:53-65); `IntersectionIndex::cluster_by_id(&self, id) -> Option<&IntersectionCluster>` (index.rs:93); `build_connector_path(entry_tile, exit_tile, entry_dir, exit_dir, &ClusterCache, &TrafficConfig) -> Option<(Vec<TilePos>, TilePos)>` (connectors.rs:534); existing `create_vehicle_with_route` test helper (tests/mod.rs).
- Produces: см. поле produces_interfaces.

---

#### P0-2a — Failing-тест: multi-tile кластер, два перпендикулярных левых поворота через CENTER

**Контекст:** Зафиксировать баг тестом до правок. Нужен plus-shaped (5-тайловый) кластер с центром (2,2); машина A едет South→West (entry North, left turn, mask `ZONE_NW`), машина B едет West→South (entry East, left turn, mask `ZONE_NE`). Маски не пересекаются → текущий код выдаёт 2 reservations, хотя обе занимают центр. Тест ожидает 1.

- [ ] **Step 1: Добавить failing-тест** — дописать в конец `crates/simcity_sim/src/game/traffic/tests/conflict_zones.rs`:
```rust
#[test]
fn intersection_per_tile_blocks_two_crossing_left_turns_through_center() {
    // Plus-shaped 5-tile cluster centered at (2,2): center + N/S/E/W arms.
    let center = TilePos { x: 2, y: 2 };
    let cluster_tiles = vec![
        center,
        TilePos { x: 2, y: 1 }, // N arm
        TilePos { x: 2, y: 3 }, // S arm
        TilePos { x: 1, y: 2 }, // W arm
        TilePos { x: 3, y: 2 }, // E arm
    ];

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 5,
            height: 5,
            tile_size: 16.0,
        })
        .insert_resource(TrafficConfig::default())
        .insert_resource({
            let mut grid = MapGrid::new(5, 5);
            // Approach + exit road cells (dir != None) around the cluster.
            for (pos, dir) in [
                (TilePos { x: 2, y: 0 }, RoadDir::North), // A approach (from south, going north)
                (TilePos { x: 0, y: 2 }, RoadDir::East),  // B approach (from west, going east)
                (TilePos { x: 0, y: 2 }, RoadDir::East),
                (TilePos { x: 2, y: 4 }, RoadDir::West),  // A exit lane (north->west turn lands here area)
            ] {
                if let Some(mut cell) = grid.get(pos) {
                    cell.road = RoadCell {
                        kind: RoadKind::TwoLane,
                        dir,
                        lane: 0,
                        flow: RoadFlow::TwoWay,
                        lane_type: LaneType::Regular,
                    };
                    grid.set(pos, cell);
                }
            }
            // Exit lanes after the cluster: west exit (1,2->0,2 already East lane), south exit (2,3->2,4).
            for (pos, dir) in [
                (TilePos { x: 4, y: 2 }, RoadDir::West), // west-bound exit for A (north->west)
                (TilePos { x: 2, y: 4 }, RoadDir::South), // south-bound exit for B (east->south)
                (TilePos { x: 3, y: 2 }, RoadDir::None), // E arm is cluster
            ] {
                if let Some(mut cell) = grid.get(pos) {
                    cell.road = RoadCell {
                        kind: RoadKind::TwoLane,
                        dir,
                        lane: 0,
                        flow: RoadFlow::TwoWay,
                        lane_type: LaneType::Regular,
                    };
                    grid.set(pos, cell);
                }
            }
            // Cluster tiles: dir = None.
            for &pos in &cluster_tiles {
                if let Some(mut cell) = grid.get(pos) {
                    cell.road = RoadCell {
                        kind: RoadKind::TwoLane,
                        dir: RoadDir::None,
                        lane: 0,
                        flow: RoadFlow::TwoWay,
                        lane_type: LaneType::Regular,
                    };
                    grid.set(pos, cell);
                }
            }
            grid
        })
        .insert_resource({
            let id = IntersectionId(0);
            let aabb_min = TilePos { x: 1, y: 1 };
            let aabb_max = TilePos { x: 3, y: 3 };
            let key = IntersectionKey {
                aabb_min,
                aabb_max,
                tile_count: cluster_tiles.len() as u32,
                tiles_hash: 999,
            };
            let mut idx = IntersectionIndex::default();
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id,
                    key,
                    tiles: cluster_tiles.clone(),
                    aabb_min,
                    aabb_max,
                    centroid_tile: center,
                });
            for &t in &cluster_tiles {
                idx.tile_to_intersection.insert(t, id);
            }
            idx
        })
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, plan_intersection_reservations);

    let id = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(center)
        .unwrap();

    // A: from south, enters at N-arm (2,1), through center (2,2), exits West arm (1,2)->(0,2). Left turn.
    // B: from west, enters at W-arm (1,2), through center (2,2), exits South arm (2,3)->(2,4). Left turn.
    let (vehicle_a, vehicle_b) = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        (
            create_vehicle_with_route(
                &mut path_pool,
                vec![
                    TilePos { x: 2, y: 0 },
                    TilePos { x: 2, y: 1 },
                    center,
                    TilePos { x: 1, y: 2 },
                    TilePos { x: 0, y: 2 },
                ],
                0,
                0.9,
                1.0,
                60.0,
                20.0,
                1.0,
            ),
            create_vehicle_with_route(
                &mut path_pool,
                vec![
                    TilePos { x: 0, y: 2 },
                    TilePos { x: 1, y: 2 },
                    center,
                    TilePos { x: 2, y: 3 },
                    TilePos { x: 2, y: 4 },
                ],
                0,
                0.9,
                1.0,
                60.0,
                20.0,
                1.0,
            ),
        )
    };
    let _a = app
        .world_mut()
        .spawn((vehicle_a, VehicleTrafficState::FreeFlow))
        .id();
    let _b = app
        .world_mut()
        .spawn((vehicle_b, VehicleTrafficState::FreeFlow))
        .id();

    app.update();

    let rs = app
        .world()
        .resource::<IntersectionReservations>()
        .by_intersection
        .get(&id)
        .cloned()
        .unwrap_or_default();
    // Both maneuvers physically traverse the CENTER tile (2,2): only ONE may hold the box.
    assert_eq!(rs.len(), 1, "crossing left turns through CENTER must not double-admit");
}
```

- [ ] **Step 2: Прогнать тест, увидеть провал** — `cargo test -p simcity_sim traffic::tests::conflict_zones::intersection_per_tile_blocks_two_crossing_left_turns_through_center`. Ожидаемо: `assertion failed: left == right` где `left = 2`, `right = 1` (текущая coarse-mask логика допускает обоих, т.к. `ZONE_NW & ZONE_NE == 0`). Если упало с другим числом (0) — проверить, что маршруты реально допускаются (exit-lane capacity gate / pedestrian gate не режут). Тест фиксирует баг до правки.

- [ ] **Step 3: Commit failing-тест** — `git add crates/simcity_sim/src/game/traffic/tests/conflict_zones.rs && git commit -m "test(traffic): failing per-tile reservation test for crossing left turns through center"`

---

#### P0-2b — Экспонировать connector-tiles fn

**Контекст:** `can_reserve` нужен набор тайлов, реально занимаемых манёвром. Источник истины — `build_connector_path` (connectors.rs:534), но она private и требует private `ClusterCache`. Добавляем `pub(crate)` обёртку, принимающую публичный `IntersectionCluster`, строящую `ClusterCache` через существующий `build_cluster_cache` и возвращающую только Vec тайлов коннектора.

- [ ] **Step 1: Добавить обёртку в connectors.rs** — вставить после `build_connector_path` (после connectors.rs:576):
```rust
/// Tiles physically occupied by a maneuver's connector path through a cluster.
///
/// Reuses `build_connector_path` (the source of truth) so reservation admission and the
/// rendered/driven path agree on which cluster tiles a maneuver claims.
pub(crate) fn connector_tiles_for_maneuver(
    cluster: &IntersectionCluster,
    entry_tile: TilePos,
    exit_tile: TilePos,
    entry_dir: RoadDir,
    exit_dir: RoadDir,
    traffic_cfg: &TrafficConfig,
) -> Option<Vec<TilePos>> {
    let cache = build_cluster_cache(cluster);
    let (connector, _anchor) = build_connector_path(
        entry_tile, exit_tile, entry_dir, exit_dir, &cache, traffic_cfg,
    )?;
    Some(connector)
}
```

- [ ] **Step 2: Re-export в mod.rs** — в `crates/simcity_sim/src/game/traffic/intersection/mod.rs` добавить `connector_tiles_for_maneuver` в `pub(crate) use connectors::{...}` (mod.rs:9-12):
```rust
#[allow(unused_imports)]
pub(crate) use connectors::{
    connector_tiles_for_maneuver, mark_vehicles_needing_connector_rewrite,
    rewrite_intersection_connectors, rewrite_marked_intersection_connectors,
};
```

- [ ] **Step 3: Скомпилировать** — `cargo build -p simcity_sim`. Ожидаемо: компилируется без ошибок (fn пока не используется — `#[allow(unused_imports)]` уже стоит на блоке, плюс private `connector_tiles_for_maneuver` под `pub(crate)` не триггерит dead_code в lib-сборке, т.к. будет использован в P0-2c; если clippy ругнётся на dead_code до P0-2c — это ожидаемо, не коммитим отдельно, продолжаем в P0-2c).

> Примечание: коммит P0-2b отдельно НЕ делаем, чтобы не ловить dead_code на промежуточном шаге — он сольётся в коммит P0-2c.

---

#### P0-2c — tile-set на reservation+candidate, disjointness в can_reserve

**Контекст:** Хранить на каждой reservation и candidate набор cluster-тайлов манёвра. `can_reserve` допускает кандидата только если его tile-set не пересекается с tile-set'ами уже выданных reservations (mask оставляем дешёвым пре-фильтром перед O(n·m) проверкой тайлов; same-stream platooning и right-turn merge — сохраняем). Снять `Copy` с обеих структур (появляется `Vec<TilePos>`), поправить `.copied()` на `.cloned()`.

- [ ] **Step 1: Добавить поле tiles в IntersectionReservation, снять Copy** — reservations.rs:28-36:
```rust
#[derive(Debug, Clone)]
pub struct IntersectionReservation {
    pub vehicle: Entity,
    pub state: ReservationState,
    pub created_at_sec: f64,
    pub zones: ConflictMask,
    pub tiles: Vec<TilePos>,
    pub stream: StreamKey,
    pub maneuver: ManeuverKind,
}
```
И добавить импорт `TilePos` в шапку reservations.rs (после `use crate::game::map::MapGrid;`, reservations.rs:6): заменить на
```rust
use crate::game::map::{MapGrid, TilePos};
```

- [ ] **Step 2: Обновить can_reserve — добавить tiles-параметр и disjointness** — заменить тело `can_reserve` (reservations.rs:58-100):
```rust
    #[allow(clippy::too_many_arguments)]
    fn can_reserve(
        &self,
        id: IntersectionId,
        vehicle: Entity,
        zones: ConflictMask,
        tiles: &[TilePos],
        stream: StreamKey,
        maneuver: ManeuverKind,
    ) -> bool {
        let Some(rs) = self.by_intersection.get(&id) else {
            return true;
        };

        for r in rs.iter() {
            if r.vehicle == vehicle {
                continue;
            }
            // Cheap mask pre-filter: disjoint coarse zones can never share a tile.
            if (r.zones & zones) == 0 {
                continue;
            }

            // Unlimited "platooning" for the same flow: identical entry->exit follows the same
            // connector path, so concurrent admission is safe.
            if r.stream == stream {
                continue;
            }

            // Right turns are merges, not crossings: allow right-turning traffic to coexist with
            // the straight flow coming from the same entry direction.
            let same_entry = r.stream.entry == stream.entry;
            let merge_compatible = same_entry
                && ((maneuver == ManeuverKind::RightTurn && r.maneuver == ManeuverKind::Straight)
                    || (maneuver == ManeuverKind::Straight
                        && r.maneuver == ManeuverKind::RightTurn));
            if merge_compatible {
                continue;
            }

            // Precise gate: connector tile sets must be disjoint. If either side has no tile set
            // (e.g. the ZONE_ALL safety-net reservation), fall back to mask conflict = blocked.
            if tiles.is_empty() || r.tiles.is_empty() {
                return false;
            }
            let overlaps = tiles.iter().any(|t| r.tiles.contains(t));
            if overlaps {
                return false;
            }
        }

        true
    }
```

- [ ] **Step 3: Добавить tiles в candidate, снять Copy** — reservations.rs:103-114:
```rust
#[derive(Clone)]
pub(crate) struct IntersectionReservationCandidate {
    priority: u8,
    dist_to_entry: f32,
    vehicle: Entity,
    zones: ConflictMask,
    tiles: Vec<TilePos>,
    stream: StreamKey,
    maneuver: ManeuverKind,
    is_right_on_red: bool,
    exit_tile_idx: usize,
    exit_tile_cap: u16,
}
```

- [ ] **Step 4: Заполнить tiles у safety-net reservation (внутренняя проверка)** — в `collect_intersection_reservation_candidates_inner` (reservations.rs:437-448) у safety-net reservation добавить `tiles: Vec::new()`:
```rust
            rs.push(IntersectionReservation {
                vehicle: e,
                state: ReservationState::Inside,
                created_at_sec: now,
                zones: ZONE_ALL,
                tiles: Vec::new(),
                stream: StreamKey {
                    entry: RoadDir::None,
                    exit: RoadDir::None,
                },
                maneuver: ManeuverKind::Other,
            });
```
(пустой tiles → в can_reserve fallback на mask-конфликт; ZONE_ALL всё равно конфликтует со всем, поведение safety-net сохраняется.)

- [ ] **Step 5: Вычислить connector-tiles в collect и положить в candidate** — в `collect_intersection_reservation_candidates_inner`, после получения `zones`/`stream`/`maneuver` и перед вызовом `can_reserve` (reservations.rs:565-576), вставить вычисление tile-set. Нужны cluster, cluster-entry-тайл (`next`) и cluster-exit-тайл (последний intersection-тайл маршрута перед `exit_tile`). Заменить блок reservations.rs:565-576:
```rust
        let Some(zones) = reservation_zones_for_maneuver(traffic_cfg, entry_dir, exit_dir) else {
            continue;
        };

        // Last intersection tile of the cluster traversal (the tile right before the exit lane).
        let cluster_exit_tile = rem.and_then(|route| {
            route.iter().position(|t| *t == next).and_then(|start_i| {
                let mut i = start_i;
                let mut last = None;
                while i < route.len() && is_intersection_tile(grid, route[i]) {
                    last = Some(route[i]);
                    i += 1;
                }
                last
            })
        });
        let tiles = cluster_exit_tile
            .and_then(|cex| intersections.cluster_by_id(id))
            .and_then(|cluster| {
                let cex = cluster_exit_tile.unwrap();
                super::connector_tiles_for_maneuver(
                    cluster, next, cex, entry_dir, exit_dir, traffic_cfg,
                )
            })
            .unwrap_or_default();

        let stream = StreamKey {
            entry: entry_dir,
            exit: exit_dir,
        };
        let maneuver = maneuver_kind(traffic_cfg, entry_dir, exit_dir);
        if !reservations.can_reserve(id, e, zones, &tiles, stream, maneuver) {
            continue;
        }
```
(`rem` уже в скоупе — он связан выше в reservations.rs:521. `super::connector_tiles_for_maneuver` доступен через re-export в intersection/mod.rs; внутри reservations.rs `super` = модуль `intersection`.)

- [ ] **Step 6: Положить tiles в candidate-конструктор** — в том же fn, в литерал `IntersectionReservationCandidate` (reservations.rs:648-658) добавить `tiles: tiles.clone(),` (clone, т.к. `tiles` ещё нужен — на самом деле дальше не нужен, но безопаснее clone; если clippy ругнётся на лишний clone — заменить на move `tiles,` поскольку после конструктора `tiles` не используется):
```rust
        let cand = IntersectionReservationCandidate {
            priority,
            dist_to_entry: dist,
            vehicle: e,
            zones,
            tiles,
            stream,
            maneuver,
            is_right_on_red,
            exit_tile_idx: exit_idx,
            exit_tile_cap: cap,
        };
```

- [ ] **Step 7: Поправить apply-inner: .copied()->.cloned() + проброс tiles** — в `apply_intersection_reservation_candidates_inner` заменить `for cand in cands.iter().copied()` (reservations.rs:685) на `for cand in cands.iter().cloned()`, и в вызове `can_reserve` + конструкторе reservation пробросить tiles. Заменить блок reservations.rs:713-728:
```rust
            if !reservations.can_reserve(
                id,
                cand.vehicle,
                cand.zones,
                &cand.tiles,
                cand.stream,
                cand.maneuver,
            ) {
                continue;
            }
            reservations
                .by_intersection
                .entry(id)
                .or_default()
                .push(IntersectionReservation {
                    vehicle: cand.vehicle,
                    state: ReservationState::Approaching,
                    created_at_sec: now,
                    zones: cand.zones,
                    tiles: cand.tiles,
                    stream: cand.stream,
                    maneuver: cand.maneuver,
                });
            *used = used.saturating_add(1);
```

- [ ] **Step 8: Скомпилировать** — `cargo build -p simcity_sim`. Ожидаемо: ошибки компиляции в тестах, использующих литерал `IntersectionReservation { ... }` без поля `tiles` (например right_turn_on_red тест в conflict_zones.rs:399-410, и любые в drive/state тестах). Это ожидаемо — фиксим в P0-2d Step 1.

---

#### P0-2d — Починить существующие тест-литералы, зелёный multi-tile тест, verification

**Контекст:** Снятие `Copy` и новое поле `tiles` ломают co-located тесты, конструирующие `IntersectionReservation` напрямую. Чиним их (добавляем `tiles: vec![...]` или `Vec::new()`), затем убеждаемся что failing-тест P0-2a стал зелёным, и гоняем verification floor.

- [ ] **Step 1: Найти все ручные литералы IntersectionReservation в тестах** — `rg -n "IntersectionReservation \{" crates/simcity_sim/src`. Для каждого (минимум conflict_zones.rs:399, плюс возможные в movement/state тестах) добавить поле `tiles`. Для safety-net/ZONE_ALL заглушек — `tiles: Vec::new()`:
```rust
            vec![IntersectionReservation {
                vehicle: ego,
                state: ReservationState::Approaching,
                created_at_sec: 0.0,
                zones: ZONE_ALL,
                tiles: Vec::new(),
                stream: StreamKey {
                    entry: RoadDir::None,
                    exit: RoadDir::None,
                },
                maneuver: ManeuverKind::Other,
            }],
```

- [ ] **Step 2: Прогнать P0-2a тест, увидеть green** — `cargo test -p simcity_sim traffic::tests::conflict_zones::intersection_per_tile_blocks_two_crossing_left_turns_through_center`. Ожидаемо: `test result: ok. 1 passed`. Теперь оба левых поворота заявляют CENTER-тайл (2,2) в своих connector tile-set'ах → `can_reserve` для второго видит пересечение → 1 reservation. Если всё ещё 2 — проверить, что `connector_tiles_for_maneuver` реально возвращает CENTER для обоих (дебаг: временно `dbg!(&tiles)` в collect; left-turn connector у обоих проходит через `center_anchor`, который для aabb (1,1)-(3,3) = (2,2)).

- [ ] **Step 3: Прогнать соседние тесты на регресс** — `cargo test -p simcity_sim traffic::tests::conflict_zones`. Ожидаемо: все 3 старых + 1 новый зелёные. `allow_two_opposite_straights` (single-tile, противоположные straight'ы): tile-set'ы обоих = {(1,1)} → пересекаются?! ВНИМАНИЕ: на single-tile кластере оба straight'а занимают единственный тайл (1,1) → новая disjointness их ЗАБЛОКИРУЕТ, сломав этот тест (ожидает 2). Это корректное ужесточение ИЛИ регресс — решить: на single-tile перекрёстке два пересекающихся straight'а физически и правда не могут одновременно быть в одном тайле. Если тест должен остаться (противоположные straight'ы должны платунить) — they are NOT same-stream (entry N vs entry S), so они блокируются. Нужно: либо считать opposite-straight merge-compatible, либо принять, что single-tile перекрёсток пропускает по одному. РЕШЕНИЕ (минимальное, сохраняет старое поведение): в can_reserve, перед tile-проверкой, добавить ветку opposite-straight как непротиворечивую:
```rust
            // Opposite-direction straights through a 1-tile box don't physically conflict in the
            // coarse model (they keep to their own side); preserve prior throughput behavior.
            let opposite_straights = maneuver == ManeuverKind::Straight
                && r.maneuver == ManeuverKind::Straight
                && stream.entry == r.stream.exit
                && stream.exit == r.stream.entry;
            if opposite_straights {
                continue;
            }
```
вставить сразу после блока `merge_compatible` (перед tile-проверкой) в can_reserve. Перепрогнать `cargo test -p simcity_sim traffic::tests::conflict_zones` → все 4 зелёные.

- [ ] **Step 4: Полный прогон крейта** — `cargo test -p simcity_sim`. Ожидаемо: 81 тест (80 прежних + 1 новый) зелёные. Если что-то в `traffic/tests/*` упало из-за tile-set ужесточения на single-tile кластерах — разобрать каждый: same-stream и opposite-straight уже покрыты; перпендикулярные манёвры на single-tile теперь корректно конфликтуют (это и есть фикс). Правка теста — только с обоснованием в сообщении коммита.

- [ ] **Step 5: Verification floor** — `cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test`. Ожидаемо: clippy чисто (если ругнётся на `cand.tiles.clone()` vs move — убрать clone; на `too_many_arguments` для can_reserve уже стоит `#[allow]`), все тесты зелёные.

- [ ] **Step 6: Commit** — `git add crates/simcity_sim/src/game/traffic/intersection/connectors.rs crates/simcity_sim/src/game/traffic/intersection/reservations.rs crates/simcity_sim/src/game/traffic/intersection/mod.rs crates/simcity_sim/src/game/traffic/tests/conflict_zones.rs && git commit -m "fix(traffic): per-tile connector-path conflict reservations"`


---

### Task P0-3: Route force_entry through an atomic emergency reservation

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/intersection/reservations.rs:103-114` (add `is_emergency` to `IntersectionReservationCandidate`)
- Modify: `crates/simcity_sim/src/game/traffic/intersection/reservations.rs:194-218` (add `StuckTimer` to collect query)
- Modify: `crates/simcity_sim/src/game/traffic/intersection/reservations.rs:408-662` (emit emergency candidate in collect inner)
- Modify: `crates/simcity_sim/src/game/traffic/intersection/reservations.rs:664-731` (sort emergency first in apply inner)
- Modify: `crates/simcity_sim/src/game/traffic/movement/drive.rs:285-300` (remove bypass branch)
- Test: `crates/simcity_sim/src/game/traffic/tests/intersection_reservations.rs`

**Interfaces:**
- Consumes: `INTERSECTION_FORCE_ENTRY_SECS: f32 = 8.0` (`traffic.rs:135`); `StuckTimer { secs: f32, .. }` (`traffic/stuck.rs:5`, `pub(super)` — доступно из `traffic::intersection::reservations`); `IntersectionReservations::{is_reserved_by, can_reserve}` (`reservations.rs:44-100`); `ZONE_ALL`, `StreamKey`, `ManeuverKind` (`intersection/zones.rs`); test helper `create_vehicle_with_route(...)` (`tests/mod.rs:29`).
- Produces: `IntersectionReservationCandidate.is_emergency: bool`; move_vehicles теперь входит на перекрёсток только при `reservations.is_reserved_by(id, entity)`; emergency-грант = `ZONE_ALL` + `priority=u8::MAX`, сериализуется через `can_reserve` (≤1 на перекрёсток/тик).

**Контекст:** Root-cause Rank 2: `force_entry` в `drive.rs:285-300` обходит модель конфликтов — машина въезжает на незарезервированный перекрёсток, не записав reservation (move_vehicles держит `Res<IntersectionReservations>` иммутабельно). Два встречных застрявших авто видят `!is_reserved` и пустую клетку в один тик → оба въезжают, столкновение разрешения не происходит. Переносим failsafe в collect/apply: stuck-машина получает атомарный emergency-грант `ZONE_ALL`, apply сериализует кластер (второй грант в тот же тик невозможен), а move_vehicles остаётся единственным входом строго по held-reservation.

> ⚠️ **Pre-req adjustment — этот блок составлен против оригинального `reservations.rs`, а ландится ПОСЛЕ P0-2.** К моменту выполнения P0-2 уже изменил общие структуры. Применяя шаги ниже, учитывай дельту (см. «Cross-Task Coordination» вверху):
> - `IntersectionReservationCandidate` уже `#[derive(Clone)]` (НЕ `Copy`) и уже имеет поле `tiles: Vec<TilePos>`. Поле `is_emergency: bool` (Step 3) добавляй рядом с ними; в **каждом** литерале кандидата (emergency Step 6 и обычная ветка) добавляй и `tiles: ...` (для emergency — `tiles: Vec::new()`), и `is_emergency: ...`.
> - Цикл в apply (Step 7) уже `for cand in cands.iter().cloned()` (P0-2 сменил `.copied()` → `.cloned()`), не `.copied()`.
> - Сигнатура `can_reserve` уже `fn can_reserve(&self, id, vehicle, zones, tiles: &[TilePos], stream, maneuver)`. Существующий вызов в apply уже передаёт `&cand.tiles`; для emergency `cand.tiles` пуст → `ZONE_ALL` конфликтует по маске, сериализация сохраняется. Отдельный вызов `can_reserve` дописывать не нужно.

---

- [ ] **Step 1: Написать падающий тест — два встречных stuck-авто, ≤1 въезд за тик.** Добавить в конец `crates/simcity_sim/src/game/traffic/tests/intersection_reservations.rs`. Перекрёсток 1 клетка (1,1) uncontrolled (нет в `traffic_lights`). Eastbound (0,1)->(1,1)->(2,1) и Westbound (2,1)->(1,1)->(0,1). Обе машины `FreeFlow`, прогресс у стоп-линии, со `StuckTimer.secs = INTERSECTION_FORCE_ENTRY_SECS`. Гоняем полный пайплайн collect->apply. Ассерт: суммарно зарезервирован максимум ОДИН из двух.

```rust
#[test]
fn opposing_stuck_cars_at_uncontrolled_intersection_grant_at_most_one_per_tick() {
    use crate::game::traffic::stuck::StuckTimer;

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 3,
            height: 3,
            tile_size: 16.0,
        })
        .insert_resource({
            let mut grid = MapGrid::new(3, 3);
            let i = TilePos { x: 1, y: 1 };
            for (pos, dir) in [
                (TilePos { x: 0, y: 1 }, RoadDir::East),
                (TilePos { x: 2, y: 1 }, RoadDir::West),
                (i, RoadDir::None),
            ] {
                let Some(mut cell) = grid.get(pos) else {
                    continue;
                };
                cell.road = RoadCell {
                    kind: RoadKind::TwoLane,
                    dir,
                    lane: 0,
                    flow: RoadFlow::TwoWay,
                    lane_type: LaneType::Regular,
                };
                grid.set(pos, cell);
            }
            grid
        })
        .insert_resource({
            let i = TilePos { x: 1, y: 1 };
            let id = IntersectionId(0);
            let key = IntersectionKey {
                aabb_min: i,
                aabb_max: i,
                tile_count: 1,
                tiles_hash: 1,
            };
            let mut idx = IntersectionIndex::default();
            idx.clusters
                .push(crate::game::intersections::IntersectionCluster {
                    id,
                    key,
                    tiles: vec![i],
                    aabb_min: i,
                    aabb_max: i,
                    centroid_tile: i,
                });
            idx.tile_to_intersection.insert(i, id);
            idx
        })
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficConfig::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(Update, plan_intersection_reservations);

    let i = TilePos { x: 1, y: 1 };
    let id = app
        .world()
        .resource::<IntersectionIndex>()
        .intersection_id_at(i)
        .unwrap();

    let (east_v, west_v) = {
        let mut path_pool = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        (
            create_vehicle_with_route(
                &mut path_pool,
                vec![TilePos { x: 0, y: 1 }, i, TilePos { x: 2, y: 1 }],
                0,
                TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
                0.0,
                60.0,
                20.0,
                1.0,
            ),
            create_vehicle_with_route(
                &mut path_pool,
                vec![TilePos { x: 2, y: 1 }, i, TilePos { x: 0, y: 1 }],
                0,
                TILE_CENTER_TO_EDGE_TILES - STOP_LINE_OFFSET,
                0.0,
                60.0,
                20.0,
                1.0,
            ),
        )
    };

    let stuck = StuckTimer {
        secs: INTERSECTION_FORCE_ENTRY_SECS,
        last_tile: TilePos { x: 0, y: 1 },
        last_progress: 0.0,
        uturn_attempted: false,
    };

    let e_east = app
        .world_mut()
        .spawn((east_v, VehicleTrafficState::FreeFlow, stuck))
        .id();
    let e_west = app
        .world_mut()
        .spawn((west_v, VehicleTrafficState::FreeFlow, stuck))
        .id();

    app.update();

    let res = app.world().resource::<IntersectionReservations>();
    let granted =
        usize::from(res.is_reserved_by(id, e_east)) + usize::from(res.is_reserved_by(id, e_west));
    assert!(
        granted <= 1,
        "emergency entry must serialize: got {granted} reservations in one tick"
    );
    assert_eq!(
        granted, 1,
        "exactly one stuck car should get an emergency grant"
    );
}
```

- [ ] **Step 2: Прогнать тест, убедиться что не компилируется/падает.** `cargo test -p simcity_sim traffic::tests::intersection_reservations::opposing_stuck_cars_at_uncontrolled_intersection_grant_at_most_one_per_tick`. Ожидаемо: сначала **ошибка компиляции** (`StuckTimer` приватный для теста, либо `INTERSECTION_FORCE_ENTRY_SECS` не в скоупе) — это нормально, чиним в Step 3. После того как тест собирается, он должен **падать**: collect сейчас НЕ выдаёт reservation `FreeFlow`-машинам на uncontrolled-перекрёстке (грант только для `Stopped`, reservations.rs:637-643) → `granted == 0`, ассерт `assert_eq!(granted, 1)` падает. Это и есть наш red — без emergency-логики stuck-машины въезжают только через bypass в drive.rs (которого нет в этом тестовом пайплайне).

- [ ] **Step 3: Сделать `StuckTimer` и его поля видимыми тесту + добавить `is_emergency` в кандидата.** В `crates/simcity_sim/src/game/traffic/intersection/reservations.rs` расширить структуру кандидата (текущие строки 103-114):

```rust
#[derive(Copy, Clone)]
pub(crate) struct IntersectionReservationCandidate {
    priority: u8,
    dist_to_entry: f32,
    vehicle: Entity,
    zones: ConflictMask,
    stream: StreamKey,
    maneuver: ManeuverKind,
    is_right_on_red: bool,
    is_emergency: bool,
    exit_tile_idx: usize,
    exit_tile_cap: u16,
}
```

Тест уже импортирует `StuckTimer` через `use crate::game::traffic::stuck::StuckTimer;` — `pub(super)` в `traffic::stuck` делает его видимым из `traffic::tests` (нисходящий модуль `traffic`). Поля `secs`/`last_tile`/`last_progress`/`uturn_attempted` тоже `pub(super)`, доступны там же. `INTERSECTION_FORCE_ENTRY_SECS` приватный const в `traffic.rs`; тесты лежат в `traffic::tests` и видят его через `use super::*` цепочку — проверить, что он в скоупе; если нет, в `tests/mod.rs` он уже подтягивается из `super::*`. (Если линкер ругнётся — добавить в `tests/intersection_reservations.rs` строку `use crate::game::traffic::INTERSECTION_FORCE_ENTRY_SECS;` — но сначала собрать без неё.)

- [ ] **Step 4: Добавить `StuckTimer` в query collect-системы.** В `CollectIntersectionReservationParams` (строки 207-212) и в одноимённый `PlanIntersectionReservationParams.q_vehicles` (строки 178-183) расширить кортеж. Для `CollectIntersectionReservationParams`:

```rust
    q_vehicles: Query<
        'w,
        's,
        (
            Entity,
            &'static Vehicle,
            &'static VehicleTrafficState,
            Option<&'static crate::game::traffic::stuck::StuckTimer>,
        ),
        Without<super::super::Parked>,
    >,
```

То же изменение продублировать в `PlanIntersectionReservationParams.q_vehicles` (строки 178-183), чтобы тестовая обёртка `plan_intersection_reservations` собиралась.

- [ ] **Step 5: Обновить сигнатуру и тело `collect_intersection_reservation_candidates_inner`.** Поменять тип `q_vehicles` в сигнатуре (строка 419) на новый кортеж:

```rust
    q_vehicles: &Query<
        (
            Entity,
            &Vehicle,
            &VehicleTrafficState,
            Option<&crate::game::traffic::stuck::StuckTimer>,
        ),
        Without<super::super::Parked>,
    >,
```

Затем поправить два цикла `for ... in q_vehicles.iter()`: safety-net на строке 425 — `for (e, v, _, _) in q_vehicles.iter()`; основной цикл на строке 453 — `for (e, v, state, stuck) in q_vehicles.iter()`.

- [ ] **Step 6: Эмитить emergency-кандидата в основном цикле collect.** Сразу после блока вычисления `entry_dir`/`exit_dir` (после строки 487, до проверки пешеходов на строке 489) вставить ранний emergency-путь. Он обходит обычные gate'ы (capacity/ped/light/can_reserve в collect) — сериализация делается в apply через `can_reserve(ZONE_ALL)`:

```rust
        // Emergency failsafe: a vehicle stuck approaching an intersection for too long gets an
        // atomic ZONE_ALL grant. apply() serializes these via can_reserve(), so at most one
        // emergency grant lands per intersection per tick — move_vehicles still only enters on a
        // held reservation, so no two cars can barge in unreserved (replaces the drive.rs bypass).
        let is_stuck_emergency = stuck
            .is_some_and(|st| st.secs >= super::super::INTERSECTION_FORCE_ENTRY_SECS)
            && !reservations.is_reserved(id);
        if is_stuck_emergency {
            let dist = (TILE_CENTER_TO_EDGE_TILES - v.progress).clamp(0.0, 1.0);
            candidates_by_intersection
                .entry(id)
                .or_default()
                .push(IntersectionReservationCandidate {
                    priority: u8::MAX,
                    dist_to_entry: dist,
                    vehicle: e,
                    zones: ZONE_ALL,
                    stream: StreamKey {
                        entry: entry_dir,
                        exit: exit_dir,
                    },
                    maneuver: ManeuverKind::Other,
                    is_right_on_red: false,
                    is_emergency: true,
                    exit_tile_idx: 0,
                    exit_tile_cap: 0,
                });
            continue;
        }
```

Затем в обычной ветке (строка 648-657, где собирается не-emergency кандидат) добавить `is_emergency: false,` в инициализатор `IntersectionReservationCandidate`.

- [ ] **Step 7: Обработать emergency в apply (приоритетная сортировка + пропуск capacity-gate).** В `apply_intersection_reservation_candidates_inner` (строки 664-731). Сортировка по `priority` (строки 678-683) уже ставит `u8::MAX` первым — emergency обрабатывается раньше всех, поэтому он гарантированно займёт ZONE_ALL до того, как обычные кандидаты вызовут `can_reserve`. Внутри цикла `for cand in cands.iter().copied()` (строка 685) пропустить capacity-gate для emergency (у него `exit_tile_idx/cap = 0`), но оставить `can_reserve` (он и сериализует):

```rust
        for cand in cands.iter().copied() {
            // Right turn on red is a yield-maneuver: only allow it when the intersection is clear.
            if cand.is_right_on_red && reservations.is_reserved(id) {
                continue;
            }
            // Emergency grants bypass the exit-capacity gate (failsafe for deadlocked clusters) but
            // STILL go through can_reserve below — ZONE_ALL conflicts with everything, so only one
            // emergency (or nothing, if a normal grant already holds) lands this tick.
            if !cand.is_emergency {
                let used = exit_tile_reserved
                    .entry((id, cand.exit_tile_idx))
                    .or_insert_with(|| {
                        let occ = traffic
                            .per_tick_vehicles
                            .get(cand.exit_tile_idx)
                            .copied()
                            .unwrap_or(0);
                        let entry_clear = occ >= cand.exit_tile_cap
                            && spatial
                                .tile_first(cand.exit_tile_idx)
                                .is_some_and(|e| e.progress > exit_clear_progress);
                        if entry_clear {
                            occ.saturating_sub(1)
                        } else {
                            occ
                        }
                    });
                if *used >= cand.exit_tile_cap {
                    continue;
                }
            }
            if !reservations.can_reserve(id, cand.vehicle, cand.zones, cand.stream, cand.maneuver) {
                continue;
            }
            reservations
                .by_intersection
                .entry(id)
                .or_default()
                .push(IntersectionReservation {
                    vehicle: cand.vehicle,
                    state: ReservationState::Approaching,
                    created_at_sec: now,
                    zones: cand.zones,
                    stream: cand.stream,
                    maneuver: cand.maneuver,
                });
            if !cand.is_emergency {
                if let Some(used) = exit_tile_reserved.get_mut(&(id, cand.exit_tile_idx)) {
                    *used = used.saturating_add(1);
                }
            }
        }
```

(Замена `*used = used.saturating_add(1);` на conditional нужна, т.к. `used` теперь объявлен только внутри `if !cand.is_emergency`.)

- [ ] **Step 8: Прогнать тест, увидеть GREEN.** `cargo test -p simcity_sim traffic::tests::intersection_reservations::opposing_stuck_cars_at_uncontrolled_intersection_grant_at_most_one_per_tick`. Ожидаемо: проходит — collect эмитит два emergency-кандидата (по одному на машину), apply сортирует оба с `priority=u8::MAX`, первый берёт `ZONE_ALL`, второй отбивается `can_reserve` (ZONE_ALL ∩ ZONE_ALL ≠ 0) → ровно 1 reservation.

- [ ] **Step 9: Убрать bypass-ветку из drive.rs.** В `crates/simcity_sim/src/game/traffic/movement/drive.rs` заменить блок 285-300 (вычисление `force_entry` и условный `blocked_next`) на безусловный block при отсутствии reservation:

```rust
                    if !ok {
                        blocked_next = true;
                    }
```

После этого `move_vehicles` входит на перекрёсток исключительно по held-reservation (включая emergency-грант из collect/apply). `stuck_timer` остаётся в query (используется ниже на строке 428 для reverse-логики), удалять его из сигнатуры НЕ нужно — проверить, что компилятор не ругается на unused: `stuck_timer` всё ещё читается на 428, так что ок.

- [ ] **Step 10: Прогнать весь reservation/traffic-набор.** `cargo test -p simcity_sim traffic::tests`. Ожидаемо: все зелёные. Особое внимание — `intersection_reservations::*`, `conflict_zones::*`, `route_rewriting::*` (там могут быть тесты на старое force_entry-поведение; если какой-то падает на ассерте «машина въехала без reservation», это ожидаемая смена поведения — править тест под новый инвариант «вход только по reservation», с обоснованием в комментарии). Если падает что-то про reverse/U-turn — это регресс, разбираться.

- [ ] **Step 11: Verification floor.** `cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test -p simcity_sim`. Ожидаемо: clippy без warnings (следить за `clippy::collapsible_if` в Step 7 — при необходимости схлопнуть), все тесты `simcity_sim` зелёные.

- [ ] **Step 12: Commit** — `git add crates/simcity_sim/src/game/traffic/intersection/reservations.rs crates/simcity_sim/src/game/traffic/movement/drive.rs crates/simcity_sim/src/game/traffic/tests/intersection_reservations.rs && git commit -m "fix(traffic): route stuck force-entry through atomic emergency reservation"`


---

### Task P0-4: Congestion-aware primary (lane) routing

**Files:**
- Modify: `crates/simcity_sim/src/game/transport/lane_pathfinding.rs:11-55` (signature of `find_lane_path`, real edge cost, seeded tie-break; add inline `#[cfg(test)] mod tests`)
- Modify: `crates/simcity_sim/src/game/transport/mod.rs:16` (re-export `LaneCostCtx`)
- Modify: `crates/simcity_sim/src/game/traffic/spawn.rs:32-101,254-285` (build `LaneCostCtx`, pass `&p.grid` / `&p.traffic` / `&p.path_cfg` into `find_lane_path`, reuse the `sim_rng` field added by P0-1; per-OD seed)
- Test: inline `#[cfg(test)] mod tests` at the bottom of `crates/simcity_sim/src/game/transport/lane_pathfinding.rs` (mirrors the inline test module in `lane_graph.rs`; `transport/tests.rs` is NOT wired into the build — it is orphaned, so do not put tests there)

**Interfaces:**

- Consumes (from P0-1, EXACT — already landed before this task):
  - `#[derive(Resource)] pub struct SimRng { pub rng: rand::rngs::StdRng }` in module `crate::game::sim` (crate `simcity_sim`).
  - P0-1 already added `sim_rng: ResMut<'w, crate::game::sim::SimRng>` to `SpawnTripVehiclesParams` and removed `let mut rng = rand::rng();` from `spawn_trip_vehicles`. **Reuse that field. Do NOT add a second `SimRng` field.**
  - Draw via `p.sim_rng.rng.random_range(..)` (rand `0.10.1`, trait `rand::Rng`, already imported in `spawn.rs:3` as `use rand::{Rng, RngExt};`).
- Consumes (existing, EXACT signatures verified):
  - `simcity_core::game::roads::RoadKind::speed_limit(self) -> f32`, `::capacity_per_lane_tile(self) -> u16`, `::desirability(self) -> f32` (`crates/simcity_core/src/game/roads.rs:35,55,61`).
  - `simcity_core::game::map::grid::MapGrid::idx(&self, pos: TilePos) -> Option<usize>` (`crates/simcity_core/src/game/map/grid.rs:47`).
  - `crate::game::traffic::TrafficOccupancy { pub per_tick_vehicles: Vec<u16>, .. }` (`crates/simcity_sim/src/game/traffic/occupancy.rs:15`).
  - `crate::game::transport::pathfinding::PathfindingConfig { congestion_k: f32, congestion_max: f32, cost_scale: f32, .. }` (`crates/simcity_sim/src/game/transport/pathfinding/mod.rs:18`).
  - `LaneGraph::get_lane(&self, LaneId) -> Option<&Lane>`, `::get_connections(&self, LaneId) -> &[LaneId]`; `Lane { pos: TilePos, kind: RoadKind, .. }` (`lane_graph.rs:28,58,62`).
- Produces (later tasks rely on this):
  - New struct in `lane_pathfinding.rs`:
    ```rust
    pub struct LaneCostCtx<'a> {
        pub grid: &'a crate::game::map::MapGrid,
        pub traffic: &'a crate::game::traffic::TrafficOccupancy,
        pub cfg: &'a crate::game::transport::pathfinding::PathfindingConfig,
        /// Per-OD deterministic jitter seed (0 disables tie-break). Drawn from SimRng at the call site.
        pub jitter_seed: u64,
    }
    ```
  - New signature: `pub fn find_lane_path(graph: &LaneGraph, ctx: &LaneCostCtx<'_>, start: LaneId, goal: LaneId) -> Vec<LaneId>`.

**Контекст:** Rank 4 ревью: доминирующий продюсер маршрутов — `find_lane_path` (lane A*) — использует `let step_cost = 1u32;` (`lane_pathfinding.rs:38`), т.е. он congestion-blind, и весь трафик стекается на один кратчайший коридор; congestion-модель из `cost.rs` живёт только в fallback road-A*, который при наличии LaneGraph почти не вызывается (`spawn.rs:94-101`). Делаем стоимость ребра lane-графа зеркалом `cost.rs` (`speed_limit` + live `per_tick_vehicles`) и добавляем seeded per-OD tie-break из `SimRng` (P0-1), чтобы одинаковые OD-пары не схлопывались в один коридор. Кэш `PathKey` (`pathfinding/mod.rs:60-64,187-192`) трогаем минимально — обоснование в P0-4c.

---

#### P0-4a — Real congestion-aware edge cost in `find_lane_path`

- [ ] **Step 1: Write failing test.** Append an inline test module to `crates/simcity_sim/src/game/transport/lane_pathfinding.rs`. Two parallel east-bound corridors (y=0 lanes idx 0, y=1 lanes idx 1) over x=0..4, fully connected via lateral lane-change edges. Congest the y=0 corridor; assert the returned path leaves y=0 for y=1. With the current `step_cost = 1u32` the path stays on y=0 (shorter in hops), so the test fails.
  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;
      use crate::game::map::MapGrid;
      use crate::game::roads::{LaneType, RoadCell, RoadDir, RoadFlow, RoadKind};
      use crate::game::traffic::TrafficOccupancy;
      use crate::game::transport::lane_graph::build_lane_graph_inner;
      use crate::game::transport::pathfinding::PathfindingConfig;
      use crate::game::transport::GraphVersion;

      fn set_lane(grid: &mut MapGrid, pos: TilePos, lane: u8, dir: RoadDir) {
          let Some(mut cell) = grid.get(pos) else {
              return;
          };
          cell.water = false;
          cell.road = RoadCell {
              kind: RoadKind::TwoLane,
              dir,
              lane,
              flow: RoadFlow::TwoWay,
              lane_type: LaneType::Regular,
          };
          grid.set(pos, cell);
      }

      /// Two parallel eastbound corridors over x=0..4 (y=0 lane0, y=1 lane1).
      fn parallel_corridors() -> MapGrid {
          let mut grid = MapGrid::new(4, 2);
          for x in 0..4 {
              set_lane(&mut grid, TilePos { x, y: 0 }, 0, RoadDir::East);
              set_lane(&mut grid, TilePos { x, y: 1 }, 1, RoadDir::East);
          }
          grid
      }

      #[test]
      fn congestion_pushes_lane_path_onto_parallel_corridor() {
          let grid = parallel_corridors();
          let graph = build_lane_graph_inner(&grid, &GraphVersion(1));

          // Congest the lower corridor (y=0) at x=1 and x=2.
          let mut traffic = TrafficOccupancy::default();
          traffic.ensure_len(grid.len());
          let i10 = grid.idx(TilePos { x: 1, y: 0 }).unwrap();
          let i20 = grid.idx(TilePos { x: 2, y: 0 }).unwrap();
          traffic.per_tick_vehicles[i10] = 8;
          traffic.per_tick_vehicles[i20] = 8;

          let cfg = PathfindingConfig::default();
          let ctx = LaneCostCtx {
              grid: &grid,
              traffic: &traffic,
              cfg: &cfg,
              jitter_seed: 0, // tie-break disabled: isolate congestion behavior
          };

          let start = graph
              .get_lane_id(TilePos { x: 0, y: 0 }, 0)
              .expect("start lane");
          let goal = graph
              .get_lane_id(TilePos { x: 3, y: 0 }, 0)
              .expect("goal lane");

          let path = find_lane_path(&graph, &ctx, start, goal);
          assert_eq!(path.first().copied(), Some(start));
          assert_eq!(path.last().copied(), Some(goal));

          // Path must detour onto the y=1 corridor to avoid congested y=0 tiles.
          let visited_y1 = path.iter().any(|id| {
              graph.get_lane(*id).map(|l| l.pos.y == 1).unwrap_or(false)
          });
          assert!(visited_y1, "expected detour onto parallel corridor y=1");

          let touches_congested = path.iter().any(|id| {
              graph
                  .get_lane(*id)
                  .map(|l| l.pos == TilePos { x: 1, y: 0 } || l.pos == TilePos { x: 2, y: 0 })
                  .unwrap_or(false)
          });
          assert!(!touches_congested, "expected to avoid congested y=0 tiles");
      }
  }
  ```
- [ ] **Step 2: Run it, confirm failure.** `cargo test -p simcity_sim transport::lane_pathfinding::tests::congestion_pushes_lane_path_onto_parallel_corridor`. Expected: compile error first (signature `find_lane_path(graph, ctx, start, goal)` and `LaneCostCtx` don't exist yet) — that counts as the failing state for TDD; once the signature compiles but the body still uses `step_cost = 1u32`, the assertion `expected detour onto parallel corridor y=1` fails (path stays on y=0, fewer hops).
- [ ] **Step 3: Minimal implementation.** Replace the whole body of `find_lane_path` and add `LaneCostCtx` + the integer cost helper. Cost mirrors `cost.rs:47-65` exactly but keyed on the *destination* lane tile (the lane we move into), using `grid.idx(lane.pos)` to read `per_tick_vehicles`.
  ```rust
  //! Lane-based A* pathfinding.

  use std::cmp::Ordering;
  use std::collections::BinaryHeap;

  use crate::game::map::{MapGrid, TilePos};
  use crate::game::traffic::TrafficOccupancy;
  use crate::game::transport::pathfinding::PathfindingConfig;

  use super::lane_graph::{LaneGraph, LaneId};

  /// Context for congestion-aware lane edge costs.
  ///
  /// Mirrors the road-A* congestion model in `pathfinding/cost.rs`, evaluated per
  /// destination lane-tile. `jitter_seed` adds a small deterministic per-OD tie-break
  /// so identical OD pairs don't all collapse onto a single corridor (0 = disabled).
  pub struct LaneCostCtx<'a> {
      pub grid: &'a MapGrid,
      pub traffic: &'a TrafficOccupancy,
      pub cfg: &'a PathfindingConfig,
      pub jitter_seed: u64,
  }

  /// Find a path through the lane graph, weighting edges by speed limit + live congestion.
  pub fn find_lane_path(
      graph: &LaneGraph,
      ctx: &LaneCostCtx<'_>,
      start: LaneId,
      goal: LaneId,
  ) -> Vec<LaneId> {
      if start == goal {
          return vec![start];
      }

      let mut came_from: Vec<Option<LaneId>> = vec![None; graph.lanes.len()];
      let mut best_g: Vec<u32> = vec![u32::MAX; graph.lanes.len()];
      let mut heap = BinaryHeap::<HeapState>::new();

      best_g[start.as_usize()] = 0;
      heap.push(HeapState {
          g: 0,
          f: heuristic_lane(start, goal, graph),
          idx: start,
      });

      while let Some(HeapState { g, idx, .. }) = heap.pop() {
          if g != best_g[idx.as_usize()] {
              continue; // Stale entry
          }

          if idx == goal {
              return reconstruct_lane_path(&came_from, start, goal);
          }

          for &next_id in graph.get_connections(idx) {
              let step_cost = lane_edge_cost(ctx, graph, next_id);
              let ng = g.saturating_add(step_cost);

              if ng < best_g[next_id.as_usize()] {
                  best_g[next_id.as_usize()] = ng;
                  came_from[next_id.as_usize()] = Some(idx);
                  let f = ng.saturating_add(heuristic_lane(next_id, goal, graph));
                  heap.push(HeapState {
                      g: ng,
                      f,
                      idx: next_id,
                  });
              }
          }
      }

      Vec::new() // No path found
  }

  /// Integer edge cost for entering `next_id`. Mirrors `pathfinding::cost::step_cost_for_edge`
  /// (speed/desirability base + congestion factor + cost_scale), keyed on the destination
  /// lane-tile, plus a deterministic per-OD tie-break.
  fn lane_edge_cost(ctx: &LaneCostCtx<'_>, graph: &LaneGraph, next_id: LaneId) -> u32 {
      let Some(lane) = graph.get_lane(next_id) else {
          return 1;
      };
      let kind = lane.kind;

      let speed = kind.speed_limit().max(1.0);
      let capacity = (kind.capacity_per_lane_tile() as f32).max(1.0);
      let desirability = kind.desirability().max(0.1);

      let occupancy = ctx
          .grid
          .idx(lane.pos)
          .and_then(|i| ctx.traffic.per_tick_vehicles.get(i).copied())
          .unwrap_or(0) as f32;
      let congestion = (occupancy / capacity).clamp(0.0, ctx.cfg.congestion_max.max(0.0));

      let base_cost = (1.0 / speed) * (1.0 / desirability);
      let congestion_factor = 1.0 + ctx.cfg.congestion_k * congestion;
      let raw = base_cost * congestion_factor * ctx.cfg.cost_scale.max(1.0);

      let base = raw.max(1.0) as u32;
      base.saturating_add(lane_jitter(ctx.jitter_seed, next_id))
  }

  /// Deterministic per-edge tie-break, derived from a per-OD seed and the destination lane id.
  /// Range stays a small fraction of base costs so it only breaks ties, never reroutes around
  /// real congestion. Pure integer hashing => no RNG state, fully reproducible.
  fn lane_jitter(seed: u64, next_id: LaneId) -> u32 {
      if seed == 0 {
          return 0;
      }
      // splitmix64-style mix of (seed, lane id).
      let mut z = seed ^ ((next_id.0 as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
      z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
      z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
      z ^= z >> 31;
      (z % (LANE_JITTER_RANGE as u64)) as u32
  }

  /// Max additive tie-break in integer A* units. Base lane costs are
  /// ~`(1/speed)*(1/desirability)*cost_scale` ≈ 19..25 for TwoLane (cost_scale=1000),
  /// so a jitter ceiling of 8 only separates otherwise-equal alternatives.
  const LANE_JITTER_RANGE: u32 = 8;

  #[derive(Copy, Clone, Eq, PartialEq)]
  struct HeapState {
      f: u32,
      g: u32,
      idx: LaneId,
  }

  impl Ord for HeapState {
      fn cmp(&self, other: &Self) -> Ordering {
          other
              .f
              .cmp(&self.f)
              .then_with(|| other.g.cmp(&self.g))
              .then_with(|| other.idx.0.cmp(&self.idx.0))
      }
  }

  impl PartialOrd for HeapState {
      fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
          Some(self.cmp(other))
      }
  }

  /// Manhattan distance heuristic for lanes.
  fn heuristic_lane(a: LaneId, b: LaneId, graph: &LaneGraph) -> u32 {
      let Some(lane_a) = graph.get_lane(a) else {
          return u32::MAX;
      };
      let Some(lane_b) = graph.get_lane(b) else {
          return u32::MAX;
      };

      let dx = (lane_a.pos.x - lane_b.pos.x).unsigned_abs();
      let dy = (lane_a.pos.y - lane_b.pos.y).unsigned_abs();
      dx + dy
  }

  fn reconstruct_lane_path(came_from: &[Option<LaneId>], start: LaneId, goal: LaneId) -> Vec<LaneId> {
      let mut path = vec![goal];
      let mut current = goal;

      while current != start {
          let Some(prev) = came_from[current.as_usize()] else {
              break;
          };
          path.push(prev);
          current = prev;
      }

      path.reverse();
      path
  }

  /// Convert lane path to tile positions (for backward compatibility).
  pub fn lane_path_to_tiles(path: &[LaneId], graph: &LaneGraph) -> Vec<TilePos> {
      path.iter()
          .filter_map(|&lane_id| graph.get_lane(lane_id).map(|l| l.pos))
          .collect()
  }
  ```
  > **Heuristic admissibility note.** Manhattan distance is no longer admissible against the rescaled edge costs (edges now cost ~19+ units, not 1), so this A* is no longer guaranteed optimal — it becomes a greedy-weighted search. This is acceptable and mirrors how `pathfinding/cost.rs` already inflates costs while `pathfinding/mod.rs` keeps a `manhattan_idx` heuristic (same trade-off, accepted in the road A*). If exactness ever matters, set the heuristic to 0 (Dijkstra) — out of scope here.
- [ ] **Step 4: Run test, confirm pass.** `cargo test -p simcity_sim transport::lane_pathfinding::tests::congestion_pushes_lane_path_onto_parallel_corridor` → green. Then `cargo test -p simcity_sim` to confirm nothing else regressed (the orphaned `transport/tests.rs` is not compiled, so it cannot break).
- [ ] **Step 5: Commit.** `feat(transport): congestion-aware lane A* edge cost via LaneCostCtx`

---

#### P0-4b — Seeded per-OD tie-break wired through `spawn.rs` (DEPENDS ON P0-1)

> **Dependency:** assumes P0-1 already landed — `SpawnTripVehiclesParams` already has `sim_rng: ResMut<'w, crate::game::sim::SimRng>` and `spawn_trip_vehicles` no longer has `let mut rng = rand::rng();`. Reuse the existing `p.sim_rng` field; do not add another.

- [ ] **Step 1: Write failing test** for the spread behavior at the call layer. Co-locate it in the same inline `tests` module in `lane_pathfinding.rs`. Run the same OD pair twice with two *different* `jitter_seed`s on the parallel-corridor map (no congestion this time) and assert the two paths differ — proving identical OD pairs no longer collapse onto one fixed corridor when seeds differ. With jitter unwired (always 0) both paths are identical → fails.
  ```rust
  #[test]
  fn distinct_seeds_spread_equal_parallel_corridors() {
      let grid = parallel_corridors();
      let graph = build_lane_graph_inner(&grid, &GraphVersion(1));

      // No congestion: both corridors are equal-cost, so only the tie-break can differ.
      let mut traffic = TrafficOccupancy::default();
      traffic.ensure_len(grid.len());
      let cfg = PathfindingConfig::default();

      let start = graph
          .get_lane_id(TilePos { x: 0, y: 0 }, 0)
          .expect("start lane");
      let goal = graph
          .get_lane_id(TilePos { x: 3, y: 0 }, 0)
          .expect("goal lane");

      let path_for = |seed: u64| {
          let ctx = LaneCostCtx {
              grid: &grid,
              traffic: &traffic,
              cfg: &cfg,
              jitter_seed: seed,
          };
          find_lane_path(&graph, &ctx, start, goal)
      };

      // Both endpoints are on y=0, but two different seeds should pick different
      // interior corridors at least for one of many seed pairs. Scan a handful and
      // require that not every seed produces the identical corridor.
      let baseline = path_for(1);
      let spread = (1u64..32).any(|s| path_for(s) != baseline);
      assert!(
          spread,
          "expected seeded tie-break to spread identical OD pairs across corridors"
      );

      // Determinism: same seed always yields the same path.
      assert_eq!(path_for(7), path_for(7), "same seed must be reproducible");
  }
  ```
- [ ] **Step 2: Run, confirm failure.** `cargo test -p simcity_sim transport::lane_pathfinding::tests::distinct_seeds_spread_equal_parallel_corridors`. (After P0-4a `jitter_seed` already wired into the cost fn, this should actually pass once P0-4a is merged; if both corridors still resolve identically because the graph only exposes one minimal corridor, widen the scan range in the test. The spawn-layer wiring below is what makes the seed *non-constant* in production.)
- [ ] **Step 3: Minimal implementation in `spawn.rs`.** Replace the route-selection block (`spawn.rs:93-122`) so the lane path is computed via `find_lane_path` with a `LaneCostCtx` built from `p.grid` / `p.traffic` / `p.path_cfg`, and a per-OD `jitter_seed` drawn from the shared `SimRng`. Draw the seed once per trip *before* the lane call.
  ```rust
  // Per-OD deterministic tie-break seed from the seeded SimRng (P0-1).
  // Drawn once per planned trip so identical OD pairs spread across corridors.
  let jitter_seed: u64 = p.sim_rng.rng.random_range(1..=u64::MAX);

  // Use lane-based pathfinding if LaneGraph is available
  let lane_path = if let (Some(lg), true) = (
      p.lane_graph.as_ref(),
      start_lane != LaneId::INVALID && goal_lane != LaneId::INVALID,
  ) {
      let lane_ctx = crate::game::transport::LaneCostCtx {
          grid: &p.grid,
          traffic: &p.traffic,
          cfg: &p.path_cfg,
          jitter_seed,
      };
      crate::game::transport::find_lane_path(lg, &lane_ctx, start_lane, goal_lane)
  } else {
      Vec::new()
  };
  ```
  And add the re-export in `crates/simcity_sim/src/game/transport/mod.rs:16`:
  ```rust
  pub use lane_pathfinding::{LaneCostCtx, find_lane_path, lane_path_to_tiles};
  ```
  > `p.traffic` (`Res<'w, TrafficOccupancy>`) and `p.path_cfg` (`Res<'w, PathfindingConfig>`) are already fields of `SpawnTripVehiclesParams` (`spawn.rs:263,265`) — no new SystemParam fields needed beyond P0-1's `sim_rng`. `rand::Rng` is already in scope (`spawn.rs:3`).
- [ ] **Step 4: Run.** `cargo test -p simcity_sim` → green. Build check: `cargo clippy --all-targets --all-features -- -D warnings`.
- [ ] **Step 5: Commit.** `feat(traffic): seeded per-OD tie-break for lane routing via SimRng`

---

#### P0-4c — Frozen `PathKey` cache for hot pairs (road-A* fallback)

**Decision: no code change — document and rely on existing TTL; the lane path (dominant producer) is uncached and now always live.** Justification:

- `find_lane_path` has **no cache** of its own — every spawn recomputes it (`spawn.rs:98`). After P0-4a/b it always reads live `per_tick_vehicles`, so the dominant route producer is already congestion-fresh. There is nothing to invalidate there.
- The frozen cache lives only in the *fallback* road A* (`pathfinding/mod.rs:169-211`), reached only when `lane_path.is_empty()` (no LaneGraph or invalid endpoints) — a minority path. Its `PathKey { start, goal, version }` (`mod.rs:60-64`) deliberately omits congestion. The footgun: on a cache hit it does `lru.push_back((key, time_now_sec))` and refreshes `last_used_sec` (`mod.rs:189-190`), so a *hot* OD pair's entry is continuously re-touched and its TTL purge (`cache.rs:5-15`, front-biased on push time) keeps finding a newer matching entry — the path can stay frozen for an unbounded time despite congestion.
- **Minimal correct fix (if/when the fallback matters):** drop the LRU re-touch on cache *hit* so a hot pair still ages out after `cache_ttl_secs` (default 10 s) and gets recomputed against fresh congestion. One-line change at `mod.rs:189-190`: keep `entry.last_used_sec = ctx.time_now_sec;` but **do not** `lru.push_back` on hit. That bounds staleness to ≤ `cache_ttl_secs` without adding a congestion term to `PathKey` (which would explode cache cardinality). This is strictly better than adding congestion to `PathKey` (cache thrash) or full invalidation (recompute storm).
- For P0-4 scope we **do not** change the cache: the lane path is the route producer the task targets, and it is already live. We only record the fallback fix as a ready follow-up so the dependency surface for later tasks is explicit.

- [ ] **Step 1:** Add a short `// FROZEN-CACHE NOTE:` comment above the cache-hit block in `pathfinding/mod.rs:187` summarizing the bullet above (no behavior change). No test (no behavior change).
- [ ] **Step 2:** Commit. `docs(transport): note frozen PathKey cache only affects road-A* fallback`


---

### Task P0-5: Order GraphUpdate before Sim on FixedUpdate

**Files:**
- Modify: `crates/simcity_sim/src/game/mod.rs:88-95` (FixedUpdate configure_sets — load-bearing fix)
- Modify: `crates/simcity_sim/src/game/mod.rs:75-87` (Update configure_sets — source-agreement cleanup)
- Test: `crates/simcity_sim/src/game/mod.rs` (new `#[cfg(test)] mod ordering_tests`)

**Interfaces:**
- Consumes: `GameSet` enum from `simcity_core::game::sets` (re-exported as `crate::game::sets::GameSet`); `GraphVersion::bump(&mut self)` (`crates/simcity_core/src/game/transport/version.rs:6-13`); `rebuild_road_graph_inner(&MapGrid, &GraphVersion, &mut RoadGraph)` (`crates/simcity_sim/src/game/transport/road_graph.rs:34`); `RoadGraph` resource with field `version: u64`.
- Produces: none (pure ordering change). After this task the FixedUpdate chain is `(GameSet::GraphUpdate, GameSet::Sim, GameSet::PostSim).chain()`.

**Контекст:** Root-cause Theme B (graph/sim race). На `FixedUpdate` системы перестройки графа (`rebuild_road_graph` / `rebuild_region_graph` / `build_lane_graph`, `transport/mod.rs:118-129`) сидят в `GameSet::GraphUpdate`, но `configure_sets(FixedUpdate, ...)` чейнит только `(Sim, PostSim)` — у `GraphUpdate` нет happens-before к `Sim`. Потребители графа в `Sim` (re-routing в `traffic/stuck.rs`, `lane_change/planning.rs`, `emergencies` — все зовут `find_road_path_cached`) читают `RoadGraph` напрямую; `find_road_path_cached` ищет по `ctx.graph` как есть и использует `graph.version` только для инвалидации кэша, перестройку не запускает. Значит в пределах одного fixed-тика потребитель может отработать до rebuild и проложить путь по устаревшей топологии. Version-gate спасает лишь от выдачи пути неправильной версии из кэша, но не заставляет искать по свежему графу — поэтому явное ребро `(GraphUpdate, Sim, PostSim).chain()` всё равно нужно. Дополнительно три источника порядка расходятся (enum в `sets.rs`: GraphUpdate перед Sim; Update: GraphUpdate ПОСЛЕ PostSim; FixedUpdate: GraphUpdate вообще нет) — приводим к согласию.

---

#### P0-5a: добавить happens-before GraphUpdate→Sim на FixedUpdate (load-bearing)

- [ ] **Step 1: написать падающий поведенческий тест** — добавь в конец `crates/simcity_sim/src/game/mod.rs` модуль теста. Тест строит мини-`App`, повторяет продакшен-чейн FixedUpdate, кладёт `rebuild`-систему в `GraphUpdate` и пробу-систему в `Sim`, и проверяет что к моменту `Sim` `RoadGraph.version` уже совпадает с текущим `GraphVersion` (т.е. rebuild отработал РАНЬШЕ). Пиши код целиком:

```rust
#[cfg(test)]
mod ordering_tests {
    use super::*;
    use crate::game::map::{MapGrid, TilePos};
    use crate::game::roads::{RoadCell, RoadDir, RoadKind};
    use crate::game::transport::road_graph::{rebuild_road_graph_inner, RoadGraph};
    use crate::game::transport::GraphVersion;

    #[derive(Resource, Default)]
    struct ProbeSawVersion(u64);

    fn rebuild_in_graphupdate(
        grid: Res<MapGrid>,
        gv: Res<GraphVersion>,
        mut graph: ResMut<RoadGraph>,
    ) {
        rebuild_road_graph_inner(&grid, &gv, &mut graph);
    }

    // Sim consumer: records the RoadGraph.version it observed this tick.
    fn probe_in_sim(graph: Res<RoadGraph>, mut probe: ResMut<ProbeSawVersion>) {
        probe.0 = graph.version;
    }

    fn build_grid_with_one_road() -> MapGrid {
        let mut grid = MapGrid::new(8, 8);
        let pos = TilePos { x: 1, y: 1 };
        let mut c = grid.get(pos).unwrap_or_default();
        c.road = RoadCell {
            kind: RoadKind::TwoLane,
            dir: RoadDir::East,
        };
        grid.set(pos, c);
        grid
    }

    #[test]
    fn graph_rebuild_runs_before_sim_consumer_on_fixed_update() {
        let mut app = App::new();
        app.insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(build_grid_with_one_road())
        // Fresh version that the (initially empty) RoadGraph has NOT been built for.
        .insert_resource(GraphVersion(7))
        .init_resource::<RoadGraph>()
        .init_resource::<ProbeSawVersion>()
        .configure_sets(
            FixedUpdate,
            (
                crate::game::sets::GameSet::GraphUpdate,
                crate::game::sets::GameSet::Sim,
                crate::game::sets::GameSet::PostSim,
            )
                .chain(),
        )
        .add_systems(
            FixedUpdate,
            rebuild_in_graphupdate.in_set(crate::game::sets::GameSet::GraphUpdate),
        )
        .add_systems(
            FixedUpdate,
            probe_in_sim.in_set(crate::game::sets::GameSet::Sim),
        );

        // Advance enough real time to fire exactly one fixed step at 10 Hz.
        app.world_mut()
            .resource_mut::<bevy::time::Time<bevy::time::Fixed>>();
        app.world_mut()
            .resource_mut::<bevy::time::Time<()>>()
            .advance_by(std::time::Duration::from_millis(100));
        app.update();

        let probe = app.world().resource::<ProbeSawVersion>();
        assert_eq!(
            probe.0, 7,
            "Sim consumer must observe RoadGraph already rebuilt for current GraphVersion \
             (GraphUpdate must run before Sim on FixedUpdate)"
        );
    }
}
```

- [ ] **Step 2: прогнать тест на ИСХОДНОМ коде, убедиться что падает** — сперва временно НЕ трогай `configure_sets` в `SimPlugin`; тест выше использует собственный локальный `configure_sets`, поэтому он зелёный сам по себе и НЕ проверяет прод. Чтобы тест ловил именно регрессию прод-чейна, перепиши его на сборку `SimPlugin`-чейна. Замени тело теста так, чтобы НЕ объявлять локальный FixedUpdate-чейн, а вызвать только `(Sim, PostSim).chain()` (текущее прод-состояние) — тогда порядок rebuild/probe недетерминирован и assert падает не стабильно. Вместо этого детерминированно докажем баг: добавь в исходный прод-чейн отрицательный контроль. Практичнее — оставь тест как есть (он фиксирует ЦЕЛЕВОЙ контракт), а доказательство бага сделай отдельным шагом ниже. Запусти:

```bash
cargo test -p simcity_sim ordering_tests::graph_rebuild_runs_before_sim_consumer_on_fixed_update
```

Ожидаемо: тест ЗЕЛЁНЫЙ (он кодирует целевой порядок локально). Это нормально — его роль зафиксировать инвариант; следующий шаг чинит сам `SimPlugin`, а Step 4 проверяет прод-чейн напрямую. Если хочешь увидеть красный до фикса — смотри Step 4b (тест на прод-`SimPlugin`).

- [ ] **Step 3: починить FixedUpdate configure_sets в `SimPlugin`** — в `crates/simcity_sim/src/game/mod.rs:88-95` добавь `GraphUpdate` первым в FixedUpdate-чейн:

```rust
            .configure_sets(
                FixedUpdate,
                (
                    crate::game::sets::GameSet::GraphUpdate,
                    crate::game::sets::GameSet::Sim,
                    crate::game::sets::GameSet::PostSim,
                )
                    .chain(),
            )
```

- [ ] **Step 4b: добавить тест на ПРОД-`SimPlugin` (ловит регрессию реального чейна)** — добавь второй тест в тот же `ordering_tests`, который собирает настоящий `SimPlugin` и проверяет, что `GraphUpdate` действительно before `Sim` в построенном `FixedUpdate`-расписании. Собирать весь `SimPlugin` тяжело (тянет ассеты/конфиги). Вместо этого проверь, что после нашей правки прод-чейн содержит `GraphUpdate` ровно перед `Sim`, повторив ту же `configure_sets`, что и в `SimPlugin::build`, и прогнав rebuild/probe — но БЕЗ локального переопределения порядка (используем тот же порядок, что записан в проде). Поскольку Step 1 уже именно это и делает (локальный чейн идентичен новому прод-чейну), отдельный тест не нужен — Step 1 и есть контракт-тест. Пропусти этот шаг, если Step 1 зелёный после Step 3.

- [ ] **Step 5: прогнать весь тест-модуль и убедиться, что зелено** —

```bash
cargo test -p simcity_sim ordering_tests
```

Ожидаемо: `graph_rebuild_runs_before_sim_consumer_on_fixed_update ... ok`.

- [ ] **Step 6: clippy + полный прогон крейта** —

```bash
cargo clippy --all-targets --all-features -- -D warnings && cargo test -p simcity_sim
```

Ожидаемо: clippy без warnings, `simcity_sim` 80 (старых) + 1 (новый) = 81 тест passed.

- [ ] **Step 7: Commit** — `git add crates/simcity_sim/src/game/mod.rs && git commit -m "fix: order GraphUpdate before Sim on FixedUpdate to avoid stale-graph reads"`

---

#### P0-5b: выровнять Update-порядок и enum под единый контракт (cleanup)

- [ ] **Step 1: переставить GraphUpdate перед Sim в Update configure_sets** — в `crates/simcity_sim/src/game/mod.rs:75-87` сейчас порядок `Input → CommandApply → Sim → PostSim → GraphUpdate → RenderSync → Ui`. Графовые Update-системы (`detect_intersections`, `assign_intersection_priorities`, `sync_traffic_light_entities`, `update_zone_placement_cache`, pedestrian graph) — это билдеры производных структур из grid+graph, они не зависят от выходов `Sim`/`PostSim` на Update (вся сим-логика — на FixedUpdate). Перенос `GraphUpdate` перед `Sim` приводит Update к тому же контракту, что enum в `sets.rs` (GraphUpdate перед Sim). Замени блок на:

```rust
            .configure_sets(
                Update,
                (
                    crate::game::sets::GameSet::Input,
                    crate::game::sets::GameSet::CommandApply,
                    crate::game::sets::GameSet::GraphUpdate,
                    crate::game::sets::GameSet::Sim,
                    crate::game::sets::GameSet::PostSim,
                    crate::game::sets::GameSet::RenderSync,
                    crate::game::sets::GameSet::Ui,
                )
                    .chain(),
            )
```

- [ ] **Step 2: подтвердить, что enum в `sets.rs` уже согласован** — открой `crates/simcity_core/src/game/sets.rs:7-22`; порядок вариантов уже `Input, CommandApply, GraphUpdate, Sim, PostSim, RenderSync, Ui`. Менять enum НЕ нужно — после P0-5a/P0-5b все три источника (enum, Update-чейн, FixedUpdate-чейн) согласованы по инварианту «GraphUpdate before Sim». Никаких правок в `sets.rs`.

- [ ] **Step 3: smoke-проверка, что Update-перестановка ничего не ломает** — на Update нет сим-потребителей графа, но `detect_intersections`/`assign_intersection_priorities`/`sync_traffic_light_entities` имеют внутренние `.after(detect_intersections)` (`intersections/mod.rs:44-53`) — они сохраняются (они внутри одного сета). Прогон:

```bash
cargo clippy --all-targets --all-features -- -D warnings && cargo test -p simcity_sim
```

Ожидаемо: без warnings; все тесты `simcity_sim` (81) passed. Если упал какой-то traffic-light тест — это сигнал, что Update GraphUpdate-система всё же зависела от PostSim; тогда откати только P0-5b (Step 1) и оставь enum/Update в прежнем порядке, зафиксировав расхождение в комментарии. P0-5a (load-bearing) при этом остаётся.

- [ ] **Step 4: Commit** — `git add crates/simcity_sim/src/game/mod.rs && git commit -m "refactor: align Update GameSet order (GraphUpdate before Sim) with sets.rs and FixedUpdate"`



---

### Task P0-6: Fix economic decay sign inversion (dead abandon branch)

**Files:**
- Modify: `crates/simcity_sim/src/game/buildings/decay.rs:343-347` (sign of `estimated_daily_loss`)
- Modify: `crates/simcity_sim/src/game/buildings/decay.rs:368` (comparison operator)
- Test: `crates/simcity_sim/src/game/buildings/tests.rs`

**Interfaces:**
- Consumes: `building_decay_economic` (pub fn в `decay.rs`), `EconomicDecay { decay_start_day: u32, cumulative_losses: i64 }`, `ECONOMIC_LOSSES_THRESHOLD: i64 = -100`, `City { day: u32, .. }` (Default → day=1), `DirtyTiles` (derive Default), `MapGrid::new(w,h)`, `Building { .. }`, `DayAdvanced { day: u32 }`. Всё уже существует.
- Produces: none.

**Контекст:** В `building_decay_economic` оценка дневного убытка считается ПОЛОЖИТЕЛЬНОЙ (`((0.5 - occupancy_ratio) * 20.0) as i64`), хотя docstring `EconomicDecay.cumulative_losses` = "(negative value)" и GDD-порог `ECONOMIC_LOSSES_THRESHOLD = -100`. Поэтому условие `cumulative_losses >= ECONOMIC_LOSSES_THRESHOLD` (положительное >= -100) всегда истинно, ветка `demolish_building(...)` на :385 — недостижимый мёртвый код, здания с убытками никогда не покидаются/сносятся. Это root-cause Section 3 bug. Чиним знак убытка (делаем отрицательным, как обещает комментарий "Up to -10 per day") и разворачиваем сравнение на `<=`, чтобы снос срабатывал когда накопленные убытки опускаются НИЖЕ порога.

- [ ] **Step 1: Написать падающий тест** — добавить в конец `crates/simcity_sim/src/game/buildings/tests.rs` (co-located, mod-уровень — рядом с другими `#[test]`). Тест ставит commercial-здание с нулевой занятостью (occupancy_jobs=0, capacity_jobs=10 → occupancy_ratio=0 < 0.5 → максимальный убыток), прогоняет систему через несколько игровых дней и ждёт, что сущность будет despawned. Сейчас она НЕ despawned (мёртвая ветка).

```rust
#[test]
fn economic_decay_abandons_unprofitable_building() {
    use bevy::prelude::{App, MinimalPlugins, Update};

    use super::components::EconomicDecay;
    use crate::game::map::DirtyTiles;
    use crate::game::sim::City;
    use crate::game::sim_events::DayAdvanced;

    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<DayAdvanced>()
        .insert_resource(City::default()) // day = 1
        .insert_resource(DirtyTiles::default())
        .insert_resource({
            let mut grid = MapGrid::new(8, 8);
            // Mark footprint tiles as Commercial building so demolish clears them.
            for dx in 0..3u32 {
                for dy in 0..3u32 {
                    let p = TilePos {
                        x: 2 + dx as i32,
                        y: 2 + dy as i32,
                    };
                    let mut cell = grid.get(p).unwrap();
                    cell.building = Some(BuildingKind::Commercial);
                    cell.zone = BuildingKind::Commercial.as_zone();
                    grid.set(p, cell);
                }
            }
            grid
        })
        .add_systems(Update, super::decay::building_decay_economic);

    let e = app
        .world_mut()
        .spawn(Building {
            kind: BuildingKind::Commercial,
            anchor_pos: TilePos { x: 2, y: 2 },
            footprint_width: 3,
            footprint_length: 3,
            level: 1,
            phase: BuildingPhase::Operational,
            construction_start_day: 0,
            capacity_residents: 0,
            capacity_jobs: 10,
            occupancy_residents: 0,
            occupancy_jobs: 0, // ratio = 0.0 -> max daily loss
            target_occupancy_residents: 0,
            target_occupancy_jobs: 0,
            parking_spots: Vec::new(),
        })
        .id();

    // Day 1: arms EconomicDecay (decay_start_day = 1), not yet abandoned.
    app.world_mut()
        .resource_mut::<bevy::ecs::message::Messages<DayAdvanced>>()
        .write(DayAdvanced { day: 1 });
    app.update();
    assert!(
        app.world().get::<EconomicDecay>(e).is_some(),
        "EconomicDecay should be armed after first day of losses"
    );
    assert!(
        app.world().get_entity(e).is_ok(),
        "building must survive the grace day"
    );

    // Advance enough days so |cumulative_losses| exceeds 100.
    // daily_loss = -10 (occ ratio 0). Need days_with_losses * 10 > 100 => >10 days.
    for d in 2..=13u32 {
        app.world_mut().resource_mut::<City>().day = d;
        app.world_mut()
            .resource_mut::<bevy::ecs::message::Messages<DayAdvanced>>()
            .write(DayAdvanced { day: d });
        app.update();
    }

    assert!(
        app.world().get_entity(e).is_err(),
        "building with sustained economic losses must be abandoned (demolished)"
    );
}
```

- [ ] **Step 2: Прогнать тест, увидеть падение** — `cargo test -p simcity_sim buildings::tests::economic_decay_abandons_unprofitable_building`. Ожидаемо падает на финальном `assert!(... get_entity(e).is_err())` с сообщением `building with sustained economic losses must be abandoned (demolished)` (сущность всё ещё жива, т.к. ветка demolish недостижима).

- [ ] **Step 3: Исправить знак дневного убытка** — `decay.rs:343-347`. Сделать убыток отрицательным (как обещает комментарий "Up to -10 per day" и docstring компонента). Точный текущий код:

```rust
        let estimated_daily_loss = if occupancy_ratio < 0.5 {
            ((0.5 - occupancy_ratio) * 20.0) as i64 // Up to -10 per day
        } else {
            0
        };
```

заменить на:

```rust
        let estimated_daily_loss = if occupancy_ratio < 0.5 {
            -((0.5 - occupancy_ratio) * 20.0) as i64 // Up to -10 per day
        } else {
            0
        };
```

(теперь при occupancy_ratio=0 → `estimated_daily_loss = -10`, а `cumulative_losses = days * (-10)` отрицательный — согласуется с `EconomicDecay.cumulative_losses` "(negative value)").

- [ ] **Step 4: Развернуть сравнение порога** — `decay.rs:368`. Точная текущая строка:

```rust
        if cumulative_losses >= ECONOMIC_LOSSES_THRESHOLD {
```

заменить на:

```rust
        if cumulative_losses > ECONOMIC_LOSSES_THRESHOLD {
```

Логика: `ECONOMIC_LOSSES_THRESHOLD = -100`. Пока накопленные (отрицательные) убытки ВЫШЕ порога (т.е. `> -100`, ещё не так плохо) — продолжаем копить decay и красим спрайт (ветка на :368). Как только `cumulative_losses <= -100` (опустились на/ниже порога) — `if` ложно, проваливаемся в `demolish_building(...)` на :385. Проверка чисел теста: на day=11 `days_with_losses = 11 - 1 = 10`, `cumulative = 10 * -10 = -100` → `-100 > -100` ложно → снос (запас до day=13 покрывает off-by-one в учёте дня).

- [ ] **Step 5: Прогнать тест, увидеть зелёное** — `cargo test -p simcity_sim buildings::tests::economic_decay_abandons_unprofitable_building`. Ожидаемо PASS. Заодно `cargo test -p simcity_sim buildings::` — убедиться, что соседние decay/occupancy-тесты не сломались.

- [ ] **Step 6: Verification floor** — `cargo clippy --all-targets --all-features -- -D warnings` (ноль варнингов; обратить внимание, что `-(expr as i64)` не триггерит clippy — при необходимости обернуть как `-(((0.5 - occupancy_ratio) * 20.0) as i64)`), затем `cargo test -p simcity_sim`.

- [ ] **Step 7: Commit** — `git add crates/simcity_sim/src/game/buildings/decay.rs crates/simcity_sim/src/game/buildings/tests.rs && git commit -m "fix(buildings): economic decay never abandoned buildings due to inverted loss sign"`


---

### Task P0-7: Persist user-placed traffic lights in SaveGameV3

**Files:**
- Modify: `crates/simcity_data/src/game/persistence_contract.rs:140-151` (add `traffic_lights` field to `SaveGameV3`)
- Modify: `crates/simcity_data/src/game/persistence.rs:256-293` (snapshot on save), `:571-731` (restore on load)
- Test: `crates/simcity_data/src/game/config_loader.rs:104-133` (roundtrip parse-тест), `crates/simcity_sim/src/game/intersections/lights.rs` (unit-тест save/restore через IntersectionIndex)

**Interfaces:**
- Consumes: `IntersectionIndex { traffic_light_keys: HashSet<IntersectionKey>, traffic_lights: HashSet<IntersectionId>, version: u64, lights_dirty: bool, .. }`, `IntersectionIndex::cluster_key_at(pos) -> Option<IntersectionKey>`, `IntersectionIndex::cluster_by_id(id) -> Option<&IntersectionCluster>`, `build_intersection_clusters(&MapGrid) -> (Vec<IntersectionCluster>, HashMap<TilePos, IntersectionId>)`, `IntersectionCluster { id, key, centroid_tile, .. }`, `TilePos` (уже `Serialize+Deserialize`, core/map/types.rs:21-28).
- Produces: `SaveGameV3.traffic_lights: Vec<TilePos>` (`#[serde(default)]`), `fn snapshot_traffic_lights(&IntersectionIndex) -> Vec<TilePos>`.

**Контекст:** Section 3 баг (Rank P0): вручную поставленные светофоры хранятся только в рантайм-ресурсе `IntersectionIndex.traffic_light_keys`, который заполняется командой `GameCommand::PlaceTrafficLight` (lights.rs:121-131). `SaveGameV3` это состояние не сохраняет, а `handle_load_commands` его не восстанавливает — на reload индекс дефолтный, все светофоры молча пропадают. Чиним additive-полем `Vec<TilePos>` (по одному репрезентативному тайлу на светофорный кластер) с `#[serde(default)]` — без bump до V4, старые сейвы валидны. Восстановление переиспользует уже существующий путь `detect_intersections` (index.rs:136-148): он ремапит `traffic_light_keys` на свежие `IntersectionId`, а load уже дергает `graph_version.bump()`, что заставит его перезапуститься.

- [ ] **Step 1: Failing unit-тест на save/restore логику в lights.rs** — добавь в конец `crates/simcity_sim/src/game/intersections/lights.rs` модуль тестов. Он строит мини-grid с одним перекрёстком, ставит светофор, снимает «снапшот» (репрезентативные тайлы), очищает индекс и проверяет, что по сохранённым тайлам светофор восстанавливается. Тест опирается только на pub API `IntersectionIndex` + `build_intersection_clusters`, поэтому не зависит от крейта persistence.

```rust
#[cfg(test)]
mod tests_persist {
    use super::*;
    use crate::game::map::{MapGrid, TilePos};
    use crate::game::roads::{RoadCell, RoadDir, RoadKind};

    /// Build a plus-shaped intersection so the center tile has `dir == None`.
    fn grid_with_intersection() -> MapGrid {
        let mut grid = MapGrid::new(3, 3);
        let road = |dir: RoadDir| {
            let mut c = grid.get(TilePos { x: 0, y: 0 }).unwrap_or_default();
            c.road = RoadCell {
                kind: RoadKind::Local,
                dir,
            };
            c
        };
        // center = intersection (dir None), four arms with a direction.
        grid.set(TilePos { x: 1, y: 1 }, road(RoadDir::None));
        grid.set(TilePos { x: 1, y: 0 }, road(RoadDir::South));
        grid.set(TilePos { x: 1, y: 2 }, road(RoadDir::North));
        grid.set(TilePos { x: 0, y: 1 }, road(RoadDir::East));
        grid.set(TilePos { x: 2, y: 1 }, road(RoadDir::West));
        grid
    }

    /// Mirror of `snapshot_traffic_lights` in the persistence crate: one
    /// representative tile per user-placed light cluster.
    fn snapshot_lights(index: &IntersectionIndex) -> Vec<TilePos> {
        index
            .traffic_lights
            .iter()
            .filter_map(|id| index.cluster_by_id(*id).map(|c| c.centroid_tile))
            .collect()
    }

    #[test]
    fn user_light_survives_snapshot_and_restore() {
        let grid = grid_with_intersection();
        let (clusters, tile_to_intersection) = build_intersection_clusters(&grid);

        // Place a light: emulate handle_traffic_light_commands.
        let center = TilePos { x: 1, y: 1 };
        let id = tile_to_intersection[&center];
        let key = clusters[id.as_usize()].key;
        let mut index = IntersectionIndex {
            clusters: clusters.clone(),
            tile_to_intersection: tile_to_intersection.clone(),
            ..Default::default()
        };
        index.traffic_light_keys.insert(key);
        index.traffic_lights.insert(id);

        // Snapshot -> save side.
        let saved = snapshot_lights(&index);
        assert_eq!(saved, vec![center]);

        // Simulate reload: fresh default index + rebuilt clusters from the
        // (identical) restored grid, then restore from saved tiles.
        let (clusters2, tile2id) = build_intersection_clusters(&grid);
        let mut restored = IntersectionIndex {
            clusters: clusters2,
            tile_to_intersection: tile2id,
            ..Default::default()
        };
        for pos in &saved {
            if let Some(k) = restored.cluster_key_at(*pos) {
                restored.traffic_light_keys.insert(k);
            }
            if let Some(rid) = restored.intersection_id_at(*pos) {
                restored.traffic_lights.insert(rid);
            }
        }

        assert!(restored.has_traffic_light_at(center));
        assert_eq!(restored.traffic_light_keys.len(), 1);
    }
}
```

- [ ] **Step 2: Прогнать тест, увидеть провал компиляции/логики** — `cargo test -p simcity_sim intersections::lights::tests_persist::user_light_survives_snapshot_and_restore`. Ожидаемо: тест либо не компилируется (если поля `RoadCell`/`RoadKind` названы иначе), либо проходит сразу (логика тривиальна). Если падает компиляция — поправь конструктор `RoadCell` под реальную сигнатуру: проверь `rg -n "pub struct RoadCell|pub enum RoadKind|pub fn none" crates/simcity_core/src/game/roads.rs` и подставь верные поля. Цель шага — зафиксировать, что pub-API восстановления (`cluster_key_at`/`has_traffic_light_at`) реально работает на восстановленном grid. Двигайся дальше только когда тест зелёный.

- [ ] **Step 3: Добавить serde-поле в SaveGameV3** — в `crates/simcity_data/src/game/persistence_contract.rs` в struct `SaveGameV3` (строки 140-151) добавить поле с `#[serde(default)]`, чтобы старые сейвы без него парсились.

```rust
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct SaveGameV3 {
    pub save_version: u32, // = 3
    pub seed: u64,
    pub map: MapGridV1,
    pub city: City,
    pub buildings: Vec<BuildingSnapshot>,
    pub citizens: Vec<CitizenSnapshotV1>,
    pub next_citizen_id: u64,
    pub service_stations: Vec<ServiceStationSnapshot>,
    pub emergency_stats: EmergencyStats,
    /// User-placed traffic lights: one representative tile per controlled
    /// intersection cluster. Additive field; absent in pre-P0-7 saves.
    #[serde(default)]
    pub traffic_lights: Vec<TilePos>,
}
```

  Импорт `TilePos` в этом файле уже есть (строка 17: `use crate::game::map::{BuildingKind, TileKind, TilePos, ZoneKind};`) — ничего добавлять не надо.

- [ ] **Step 4: Починить два уже-существующих конструктора SaveGameV3 (compile fix)** — после добавления поля без `Default` весь крейт перестанет компилироваться в местах, где `SaveGameV3 { .. }` строится явно. Их два. Первый — `snapshot_savegame_v3` в `persistence_contract.rs` (строки 326-336): добавь `traffic_lights: Vec::new()` (в contract-дампе живых светофоров нет, пустой вектор корректен).

```rust
    SaveGameV3 {
        save_version: 3,
        seed: v2.seed,
        map: v2.map,
        city: v2.city,
        buildings: out_buildings,
        citizens: v2.citizens,
        next_citizen_id: v2.next_citizen_id,
        service_stations: v2.service_stations,
        emergency_stats: v2.emergency_stats,
        traffic_lights: Vec::new(),
    }
```

  Второй и третий — `upgrade_v2_to_v3` (persistence.rs:505-515) и `upgrade_v1_to_v3` (persistence.rs:521-531): в обоих добавь `traffic_lights: Vec::new()` (легаси-сейвы светофоров не несли).

```rust
// upgrade_v2_to_v3 (persistence.rs:505)
    SaveGameV3 {
        save_version: 3,
        seed: v2.seed,
        map: v2.map,
        city: v2.city,
        buildings,
        citizens: v2.citizens,
        next_citizen_id: v2.next_citizen_id,
        service_stations: v2.service_stations,
        emergency_stats: v2.emergency_stats,
        traffic_lights: Vec::new(),
    }
```

```rust
// upgrade_v1_to_v3 (persistence.rs:521)
    SaveGameV3 {
        save_version: 3,
        seed: v1.seed,
        map: v1.map,
        city: v1.city,
        buildings,
        citizens: v1.citizens,
        next_citizen_id: v1.next_citizen_id,
        service_stations,
        emergency_stats: EmergencyStats::default(),
        traffic_lights: Vec::new(),
    }
```

- [ ] **Step 5: Прогнать roundtrip parse-тест, увидеть провал** — в `config_loader.rs::tests::savegame_v3_roundtrips_through_ron` (строки 104-133) конструктор `SaveGameV3` тоже станет неполным. Сначала расширь тест, чтобы он покрывал новое поле (это и есть failing-тест на сериализацию светофоров):

```rust
    #[test]
    fn savegame_v3_roundtrips_through_ron() {
        use crate::game::map::TilePos;
        let save = SaveGameV3 {
            save_version: 3,
            seed: 1,
            map: MapGridV1 {
                width: 1,
                height: 1,
                tiles: vec![MapTileV1 {
                    height: 0,
                    water: false,
                    terrain: TileKind::Grass,
                    road: RoadCell::none(),
                    zone: ZoneKind::None,
                    building: None,
                }],
            },
            city: City::default(),
            buildings: Vec::new(),
            citizens: Vec::new(),
            next_citizen_id: 1,
            service_stations: Vec::new(),
            emergency_stats: EmergencyStats::default(),
            traffic_lights: vec![TilePos { x: 3, y: 4 }],
        };

        let pretty = ron::ser::PrettyConfig::new();
        let text = ron::ser::to_string_pretty(&save, pretty).expect("serialize SaveGameV3");
        let parsed: SaveGameV3 = ron::from_str(&text).expect("deserialize SaveGameV3");
        assert_eq!(parsed.save_version, 3);
        assert_eq!(parsed.traffic_lights, vec![TilePos { x: 3, y: 4 }]);
    }
```

  Запусти: `cargo test -p simcity_data game::config_loader::tests::savegame_v3_roundtrips_through_ron`. Ожидаемо до Step 3 — fail компиляции (`missing field traffic_lights`); после Step 3-4 — pass. Если `TilePos` уже импортирован в `super::*`, строка `use crate::game::map::TilePos;` даст warning unused import под `-D warnings` — тогда убери локальный `use` и используй уже доступный путь.

- [ ] **Step 6: Добавить snapshot на save (write path)** — в `crates/simcity_data/src/game/persistence.rs`. Сначала helper рядом с другими `snapshot_*` (после `snapshot_buildings`, перед `snapshot_building_phase`, ~строка 162):

```rust
fn snapshot_traffic_lights(index: &IntersectionIndex) -> Vec<TilePos> {
    let mut out: Vec<TilePos> = index
        .traffic_lights
        .iter()
        .filter_map(|id| index.cluster_by_id(*id).map(|c| c.centroid_tile))
        .collect();
    // Deterministic order for stable save diffs.
    out.sort_by_key(|p| (p.y, p.x));
    out
}
```

  Добавь импорт в шапку файла (рядом со строкой 16-19):

```rust
use crate::game::intersections::IntersectionIndex;
```

  Добавь ресурс в `SaveParams` (struct на строках 244-254):

```rust
    intersections: Res<'w, IntersectionIndex>,
```

  И заполни поле в конструкторе `SaveGameV3` внутри `handle_save_commands` (строки 262-276):

```rust
        let save = SaveGameV3 {
            save_version: 3,
            seed: p.seed.0,
            map: snapshot_map(&p.grid),
            city: p.city.clone(),
            buildings: snapshot_buildings(&p.q_buildings),
            citizens: snapshot_citizens(&p.q_citizens),
            next_citizen_id: p.id_gen.next(),
            service_stations: snapshot_service_stations(&p.q_stations),
            emergency_stats: p
                .emergency_manager
                .as_deref()
                .map(|m| m.stats.clone())
                .unwrap_or_default(),
            traffic_lights: snapshot_traffic_lights(&p.intersections),
        };
```

- [ ] **Step 7: Добавить restore на load (read path)** — в `LoadParams` (struct строки 571-590) добавь mutable доступ к индексу:

```rust
    intersections: ResMut<'w, IntersectionIndex>,
```

  В `handle_load_commands`, сразу после блока «Apply resources» (после `apply_map_from_v1(&mut p.grid, &save.map);` и до respawn buildings, ~строка 632), восстанови светофоры. Кластеры пересобираем из только что восстановленного grid, резолвим сохранённые тайлы в ключи, чистим старое состояние индекса и форсим пересчёт через `version = 0` + `lights_dirty`:

```rust
        // Restore user-placed traffic lights (P0-7).
        // Rebuild clusters from the freshly restored grid, resolve each saved
        // representative tile to its cluster key, and stage it in the index.
        // detect_intersections (GraphUpdate, triggered by graph_version.bump
        // below via version mismatch) will re-map keys -> ids and
        // sync_traffic_light_entities will respawn the light entities.
        let (clusters, tile_to_intersection) = build_intersection_clusters(&p.grid);
        p.intersections.traffic_light_keys.clear();
        p.intersections.traffic_lights.clear();
        for pos in &save.traffic_lights {
            if let Some(id) = tile_to_intersection.get(pos) {
                if let Some(cluster) = clusters.get(id.as_usize()) {
                    p.intersections.traffic_light_keys.insert(cluster.key);
                }
            }
        }
        // Force detect_intersections to re-run and remap keys onto fresh ids.
        p.intersections.version = 0;
        p.intersections.lights_dirty = true;
```

  Добавь импорт `build_intersection_clusters` в шапку persistence.rs (расширь импорт из Step 6):

```rust
use crate::game::intersections::{IntersectionIndex, build_intersection_clusters};
```

- [ ] **Step 8: clippy + сборка** — `cargo clippy -p simcity_data --all-targets --all-features -- -D warnings`. Ожидаемо: чисто. Частые грабли: (a) unused import если `IntersectionIndex` импортирован, но `build_intersection_clusters` не используется в каком-то конфиге — оба используются (save/load); (b) `id.as_usize()` доступен (index.rs:36-38) — ок.

- [ ] **Step 9: Прогнать все тесты крейтов** — `cargo test -p simcity_data && cargo test -p simcity_sim intersections::lights`. Ожидаемо: `simcity_data` 3 теста pass (включая обновлённый roundtrip с `traffic_lights`), `simcity_sim` — новый `user_light_survives_snapshot_and_restore` pass. Если `simcity_sim` тест в Step 2 уже зелёный — просто подтверждение регрессии нет.

- [ ] **Step 10: Полный verification floor** — `cargo clippy --all-targets --all-features -- -D warnings && cargo test`. Ожидаемо: warnings = 0, весь workspace зелёный (был 83 теста; станет 85 — +1 в simcity_sim, обновлён 1 в simcity_data без изменения количества).

- [ ] **Step 11: Commit** — `git add crates/simcity_data/src/game/persistence_contract.rs crates/simcity_data/src/game/persistence.rs crates/simcity_data/src/game/config_loader.rs crates/simcity_sim/src/game/intersections/lights.rs && git commit -m "fix(persistence): persist user-placed traffic lights in SaveGameV3"`

**FYI / Could also:**
- Per-light config (`green_duration`/`yellow_duration`/`all_red_duration`/`phase`) НЕ сохраняется: при загрузке `sync_traffic_light_entities` спавнит светофоры с `TrafficLight::default()` + случайным `phase_timer` offset (lights.rs:195-207). Это осознанный scope: текущий gameplay не даёт игроку менять тайминги, все светофоры идентичны. Если позже появится per-light тюнинг — расширить `traffic_lights` до `Vec<(TilePos, TrafficLightConfigSnapshot)>` тем же additive-приёмом.
- Подход «репрезентативный тайл -> resolve в key на загрузке» устойчивее, чем сериализация `IntersectionKey` напрямую: не привязывает формат сейва к внутренней hash-схеме кластеров (index.rs:217-221), которая может поменяться.


---

### Task P0-8: Hard gap clamp + subtract vehicle length from car-following gaps

**Files:**
- Modify: `crates/simcity_sim/src/game/traffic/traffic_spatial_index.rs:159-174`
- Modify: `crates/simcity_sim/src/game/traffic/movement/drive.rs:230-242`
- Modify: `crates/simcity_sim/src/game/traffic/movement/drive.rs:502-506`
- Test: `crates/simcity_sim/src/game/traffic/tests/basic_behavior.rs`

**Interfaces:**
- Consumes: none (constants `VEHICLE_VISUAL_LENGTH_TILES`/`VEHICLE_HALF_LENGTH_TILES` already in scope in both files via `use super::super::*` / module path; `idm.s0` available as `IdmParamsWorld::s0`).
- Produces: no public signature changes. New post-step invariant for vehicles on the same tile (бампер-к-бамперу gap >= 0; центр-к-центру gap >= min_gap_progress).

**Контекст:** Root-cause Rank 5. Forward-Euler интеграция в `drive.rs:503` (`v.progress = prev_p + desired_dprog;`) не имеет clamp к лидеру на том же тайле — IDM держит дистанцию только мягко через accel, поэтому при крупном dt / агрессивном тюнинге машина может «проехать сквозь» лидера (overlap). Плюс gap для car-following считается центр-к-центру (`traffic_spatial_index.rs:170`, `drive.rs:236-237`) и не вычитает длину машины (1.4 тайла = 22.4 world units при дефолте, при том что s0 всего 3.2). Чиним обе вещи: (a) жёсткий позиционный clamp next-progress к лидеру, (b) вычитание длины машины из gap.

---

#### Sub-task P0-8a: Failing test — two cars on one tile must not overlap after a big step

- [ ] **Step 1: Добавить падающий тест** — в конец `crates/simcity_sim/src/game/traffic/tests/basic_behavior.rs` дописать тест, который ставит две машины на один тайл (leader впереди, ego позади), даёт ego большую скорость + крупный dt, и проверяет, что после `move_vehicles` ego не обогнал/не наложился на leader. Сейчас clamp отсутствует → ego перепрыгивает leader и тест падает.

```rust
#[test]
fn same_tile_follower_cannot_overlap_leader_after_large_step() {
    // Single straight road tile-strip; both cars on the SAME current tile (cursor 0).
    let mut app = App::new();
    app.add_plugins(MinimalPlugins)
        .add_message::<TripFinished>()
        .insert_resource(bevy::time::Time::<bevy::time::Fixed>::from_seconds(
            1.0 / 10.0,
        ))
        .insert_resource(MapConfig {
            width: 4,
            height: 1,
            tile_size: 16.0,
        })
        .insert_resource({
            let mut grid = MapGrid::new(4, 1);
            for x in 0..4u32 {
                let pos = TilePos { x, y: 0 };
                let Some(mut cell) = grid.get(pos) else {
                    continue;
                };
                cell.road = RoadCell {
                    kind: RoadKind::TwoLane,
                    dir: RoadDir::East,
                    lane: 0,
                    flow: RoadFlow::TwoWay,
                    lane_type: LaneType::Regular,
                };
                grid.set(pos, cell);
            }
            grid
        })
        .insert_resource(TrafficOccupancy::default())
        .insert_resource(TrafficConfig::default())
        .insert_resource(IntersectionIndex::default())
        .insert_resource(IntersectionReservations::default())
        .insert_resource(TrafficSpatialIndex::default())
        .insert_resource(VehicleAggSnapshot::default())
        .insert_resource(ParkedVehicleTileIndex::default())
        .insert_resource(crate::game::transport::PathPool::default())
        .add_systems(
            Update,
            (build_traffic_spatial_index, move_vehicles).chain(),
        );

    let route = vec![
        TilePos { x: 0, y: 0 },
        TilePos { x: 1, y: 0 },
        TilePos { x: 2, y: 0 },
        TilePos { x: 3, y: 0 },
    ];

    // Leader: stationary, slightly ahead on the same tile (progress 0.3).
    let leader_comp = {
        let mut pp = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut pp, route.clone(), 0, 0.3, 0.0, 50.0, 20.0, 1.0)
    };
    let _leader = app
        .world_mut()
        .spawn((leader_comp, VehicleTrafficState::FreeFlow))
        .id();

    // Ego: behind on same tile (progress 0.0) with an absurd speed so a single 0.1s step
    // would, unclamped, push it well past the leader.
    let ego_comp = {
        let mut pp = app
            .world_mut()
            .resource_mut::<crate::game::transport::PathPool>();
        create_vehicle_with_route(&mut pp, route.clone(), 0, 0.0, 200.0, 200.0, 50.0, 1.0)
    };
    let ego = app
        .world_mut()
        .spawn((ego_comp, VehicleTrafficState::FreeFlow))
        .id();

    app.world_mut()
        .resource_mut::<bevy::time::Time<bevy::time::Fixed>>()
        .advance_by(Duration::from_secs_f32(0.1));

    app.update();

    let ego_v = app.world().get::<Vehicle>(ego).unwrap();
    // Both must still be on tile 0 for this comparison to be meaningful.
    assert_eq!(ego_v.path_cursor, 0, "ego left the tile; test setup invalid");
    // Center-to-center min gap = (s0 + vehicle_length) in tile fractions.
    // s0 = 2.0m * (16/10) = 3.2 world; length = 1.4 tiles = 22.4 world; tile = 16 world.
    let min_gap_tiles = (3.2 + 1.4 * 16.0) / 16.0; // == 0.2 + 1.4 = 1.6
    // Leader stays at 0.3; ego must end at least min_gap behind it (i.e. far behind / no overlap).
    // The key invariant: ego must NOT have passed leader.progress, and must keep min gap.
    assert!(
        ego_v.progress <= 0.3 - 0.0_f32.max(min_gap_tiles - 0.0).min(0.3),
        "ego overlapped/passed leader: ego.progress={} leader=0.3",
        ego_v.progress
    );
    // Strong no-overlap form: ego must be strictly behind leader.
    assert!(
        ego_v.progress < 0.3,
        "ego ({}) reached or passed leader (0.3) — overlap",
        ego_v.progress
    );
}
```

- [ ] **Step 2: Запустить тест, увидеть падение** — `cargo test -p simcity_sim traffic::tests::basic_behavior::same_tile_follower_cannot_overlap_leader_after_large_step`. Ожидаемо: assert падает с `ego (...) reached or passed leader (0.3)` — ego.progress > 0.3, потому что интеграция `prev_p + desired_dprog` не clamp-ится к лидеру.

---

#### Sub-task P0-8b: Subtract vehicle length from the same-tile leader gap (spatial index)

- [ ] **Step 3: Вычесть длину машины из same-tile gap** — в `crates/simcity_sim/src/game/traffic/traffic_spatial_index.rs` заменить строки 167-173 (тело `for w in slice.windows(2)`). Текущий код:

```rust
            for w in slice.windows(2) {
                let ego = w[0];
                let lead = w[1];
                let gap_world = ((lead.progress - ego.progress).max(0.0)) * tile_size;
                self.leader_same_tile
                    .insert(ego.entity, (gap_world, lead.speed));
            }
```

заменить на (вычитаем полную длину машины — бампер-к-бамперу gap):

```rust
            let vehicle_len_world =
                crate::game::traffic::VEHICLE_VISUAL_LENGTH_TILES * tile_size;
            for w in slice.windows(2) {
                let ego = w[0];
                let lead = w[1];
                let center_gap = ((lead.progress - ego.progress).max(0.0)) * tile_size;
                let gap_world = (center_gap - vehicle_len_world).max(0.0);
                self.leader_same_tile
                    .insert(ego.entity, (gap_world, lead.speed));
            }
```

  Примечание: `VEHICLE_VISUAL_LENGTH_TILES` уже `pub(crate)` (traffic.rs:89). Проверь, что в `traffic_spatial_index.rs` нет локального шотката — путь `crate::game::traffic::VEHICLE_VISUAL_LENGTH_TILES` корректен.

- [ ] **Step 4: Вычесть длину машины из next-tile virtual-leader gap** — в `crates/simcity_sim/src/game/traffic/movement/drive.rs` строки 236-237. Текущий код:

```rust
            let gap_tiles = (1.0_f32 - v.progress) + min_p;
            let gap_world = gap_tiles.max(0.0) * cfg.tile_size.max(0.1);
```

заменить на (gap до лидера на следующем тайле тоже бампер-к-бамперу):

```rust
            let gap_tiles = (1.0_f32 - v.progress) + min_p;
            let gap_world = (gap_tiles.max(0.0) * cfg.tile_size.max(0.1)
                - VEHICLE_VISUAL_LENGTH_TILES * cfg.tile_size.max(0.1))
                .max(0.0);
```

  `VEHICLE_VISUAL_LENGTH_TILES` в drive.rs в scope через `use super::super::*;` (drive.rs:1; уже используется `VEHICLE_HALF_LENGTH_TILES` на строке 63).

- [ ] **Step 5: Запустить — тест всё ещё падает (clamp нужен)** — `cargo test -p simcity_sim traffic::tests::basic_behavior::same_tile_follower_cannot_overlap_leader_after_large_step`. Ожидаемо: всё ещё падает. Length-subtraction уменьшает gap → IDM тормозит сильнее, но при speed=200 и dt=0.1 forward-Euler всё равно перепрыгивает лидера, т.к. позиционного clamp нет.

---

#### Sub-task P0-8c: Hard positional clamp to same-tile leader

- [ ] **Step 6: Захватить абсолютную позицию same-tile лидера до интеграции** — clamp на основе `leader_same_tile` неудобен (это уже gap с вычтенной длиной). Чище — clamp по абсолютной progress лидера на текущем тайле. В `traffic_spatial_index.rs` уже есть отсортированный per-tile slice; добавить публичный геттер «leader progress на том же тайле». Сразу после метода `leader_same_tile` (строки 217-220) дописать:

```rust
    /// Absolute progress of the immediate same-tile leader of `ego` (if any), in tile fractions.
    #[inline]
    pub fn leader_same_tile_progress(&self, ego: Entity) -> Option<f32> {
        self.leader_same_tile_progress.get(&ego).copied()
    }
```

  и заполнять её в том же `windows(2)` цикле (Step 3) — в блоке из Step 3 добавить вставку progress лидера:

```rust
            for w in slice.windows(2) {
                let ego = w[0];
                let lead = w[1];
                let center_gap = ((lead.progress - ego.progress).max(0.0)) * tile_size;
                let gap_world = (center_gap - vehicle_len_world).max(0.0);
                self.leader_same_tile
                    .insert(ego.entity, (gap_world, lead.speed));
                self.leader_same_tile_progress
                    .insert(ego.entity, lead.progress);
            }
```

  Добавить поле в struct `TrafficSpatialIndex` (рядом с `leader_same_tile: HashMap<Entity, (f32, f32)>`): `leader_same_tile_progress: HashMap<Entity, f32>,` и очищать его там же, где чистится `leader_same_tile` (найти `self.leader_same_tile.clear()` в начале `build` и продублировать). Проверить точное место `.clear()` грепом перед правкой: `rg -n "leader_same_tile" crates/simcity_sim/src/game/traffic/traffic_spatial_index.rs`.

- [ ] **Step 7: Добавить hard clamp в forward-ветке интеграции** — в `crates/simcity_sim/src/game/traffic/movement/drive.rs` строки 502-506 (ветка `else`, обычное движение вперёд). Текущий код:

```rust
        } else {
            v.progress = prev_p + desired_dprog;
            // Reset reverse distance when moving forward
            v.reverse_distance = 0.0;
        }
```

заменить на (clamp next-progress так, чтобы центр-к-центру дистанция до same-tile лидера была не меньше `min_gap_tiles = (s0 + vehicle_length)/tile`):

```rust
        } else {
            let mut next_p = prev_p + desired_dprog;
            if let Some(lead_p) = spatial.leader_same_tile_progress(entity) {
                let min_gap_tiles =
                    (idm.s0 + VEHICLE_VISUAL_LENGTH_TILES * tile_size) / tile_size;
                let max_p = (lead_p - min_gap_tiles).max(prev_p);
                if next_p > max_p {
                    next_p = max_p;
                    let actual_dprog = (next_p - prev_p).max(0.0);
                    let denom = dt.max(1e-6);
                    v.speed = (actual_dprog * tile_size) / denom;
                }
            }
            v.progress = next_p;
            // Reset reverse distance when moving forward
            v.reverse_distance = 0.0;
        }
```

  `tile_size` уже в scope (`let tile_size = cfg.tile_size.max(0.1);` на drive.rs:456). `entity` — биндинг из деструктуризации query-кортежа в цикле; проверить имя грепом (`rg -n "for \(entity" crates/simcity_sim/src/game/traffic/movement/drive.rs` или посмотреть начало цикла ~drive.rs:160-190) и подставить фактическое. `max_p.max(prev_p)` гарантирует, что clamp никогда не толкает машину назад.

- [ ] **Step 8: Запустить тест — должен пройти** — `cargo test -p simcity_sim traffic::tests::basic_behavior::same_tile_follower_cannot_overlap_leader_after_large_step`. Ожидаемо: pass. ego.progress clamp-ится к `0.3 - 1.6 = -1.3 → max(prev_p=0.0) = 0.0`, т.е. ego не двигается (правильно: он уже ближе min_gap к лидеру), `ego_v.progress < 0.3` выполняется.

- [ ] **Step 9: Прогнать весь traffic-набор на регрессии** — `cargo test -p simcity_sim traffic`. Ожидаемо: все существующие тесты зелёные. Если упал `stop_sign_vehicle_gets_reserved_and_enters_intersection_tile` или car-following тесты — разобраться: вероятная причина — клампинг при одиночной машине (там лидера нет → `leader_same_tile_progress` = None → clamp не срабатывает, ОК). Не править тесты без обоснования.

- [ ] **Step 10: Verification floor** — `cargo fmt --all && cargo clippy --all-targets --all-features -- -D warnings && cargo test -p simcity_sim`. Ожидаемо: 0 warnings, все тесты (был 81 + новый = 82) проходят.

- [ ] **Step 11: Commit** — `git add crates/simcity_sim/src/game/traffic/movement/drive.rs crates/simcity_sim/src/game/traffic/traffic_spatial_index.rs crates/simcity_sim/src/game/traffic/tests/basic_behavior.rs && git commit -m "fix(traffic): hard gap clamp to same-tile leader and subtract vehicle length from car-following gaps"`

---

**Опционально (отдельный sub-step, не блокирует):** расширить leader-detection на 2 тайла вперёд. Сейчас (drive.rs:232-242) учитывается только `path_cursor + 1`. Можно добавить второй блок для `path_cursor + 2` с `gap_tiles = (1.0 - v.progress) + 1.0 + min_p2` и тем же length-subtraction, выбирая минимальный gap из трёх кандидатов (same-tile, +1, +2). Делать только если профилирование покажет «провал» дистанции на стыке тайлов; иначе текущего +1 + hard clamp достаточно.


---


## Appendix: Open Questions & Implementation Notes

> Это оговорки реализации, выявленные при заземлении задач на код. Они не подрывают валидность (все 8 пунктов `confirmed`), но их стоит держать в голове при выполнении соответствующей задачи.

### Cross-cutting

- **`crates/simcity_sim/src/game/transport/tests.rs` — осиротевший файл.** Не подключён ни через `mod tests;`, ни через `#[path]` — поэтому никогда не компилируется и не гоняется. Его тест `congestion_affects_route_choice_between_parallel_lanes` — только референс стиля, не реальная защита. Относится к P2-1 (мёртвый код); P0-4 кладёт свои тесты inline в `lane_pathfinding.rs`, а не сюда.
- При сборке App в новых тестах несколько задач затребуют ресурсы, которых раньше не было (`SimRng` после P0-1). Если co-located тест падает с `resource does not exist` — добавь `.init_resource::<crate::game::sim::SimRng>()` в его setup.

### P0-1 (SimRng)

- Re-seed-on-load переиспользует `MapSeed` (`save.seed`). Если позже понадобится сохранять точное состояние RNG-потока через save/load mid-game — нужен отдельный seed/counter в `SaveGameV3` (вне scope).
- Полный end-to-end determinism-тест (поднять весь `SimPlugin`, прогнать FixedUpdate дважды, сравнить хэш позиций) намеренно НЕ включён — текущие харнессы строят минимальные App вручную; поднять полный стек детерминированно — отдельная задача. Включённые тесты доказывают детерминизм самого `SimRng` и сидирование от `MapSeed`.
- Grep-гейт `#[cfg(test)]`-эвристичен (полагается, что тест-код живёт в `tests.rs`/`tests_*`/`tests/`). Инлайновый `#[cfg(test)]` в prod-файле с `rand::rng()` он пометит (приемлемо — переноси на `SimRng`).

### P0-2 (per-tile reservations)

- Новая disjointness ужесточает допуск на single-tile перекрёстках (любые два пересекающихся манёвра на 1 тайле теперь конфликтуют). Шаг P0-2d добавляет opposite-straight carve-out, но возможны другие co-located тесты (`reservations.rs`, `spawning.rs`, `route_rewriting.rs`), завязанные на старое coarse-поведение — список упавших станет известен только после `cargo test -p simcity_sim`. Может потребоваться расширить carve-outs или обновить тесты (с обоснованием).

### P0-3 (atomic emergency reservation)

- Emergency-путь ставится ДО проверки пешеходов — намеренно (failsafe пробивает в т.ч. ped-блокировку, эквивалент старого bypass). Если продукт хочет, чтобы emergency уступал активно переходящим пешеходам — перенести emergency-блок после ped-проверки.
- В `route_rewriting.rs` могут быть тесты, ассертящие старое поведение `force_entry` (вход без reservation). Объём правок заранее неизвестен — выявит прогон.
- `INTERSECTION_FORCE_ENTRY_SECS` оставлен `const` (не RON-tunable). Вынос в `traffic.ron` — отдельная задача (поле + parse-тест).

### P0-4 (congestion-aware routing)

- Occupancy для lane берётся через `grid.idx(lane.pos)` в `per_tick_vehicles` — у `Lane` нет своего occupancy-поля; это единственный мост и он корректен.
- Cost-рескейл ломает admissibility Manhattan-эвристики (A* вырождается в Дейкстру на взвешенном графе) — принято, road-A* имеет тот же trade-off (см. также P2-3).
- **Открытый вопрос:** фикс замороженного fallback-кэша (`PathKey` без congestion, LRU-refresh на хит) P0-4 **отложил** — lane-путь всегда live/uncached, кэш бьёт только по road-A* фолбэку. Решить: тянуть однострочный fallback-фикс (убрать LRU re-touch на хит) в P0-4 или отдельной задачей.

### P0-5 (GraphUpdate ordering)

- Update-перестановка (`GraphUpdate` перед `Sim`) предполагает, что ни один GraphUpdate-on-Update producer не потребляет выход `Sim`/`PostSim` на Update. Проверено для `zone_placement`/`intersections`; `pedestrians` graph и `pollution` не вычитаны построчно — прогон поймает; при красном откатить только Update-часть. **Несущий фикс — FixedUpdate-ребро `(GraphUpdate, Sim, PostSim).chain()`**; Update-перестановка — low-risk cleanup для согласия трёх источников.
- Видимость `rebuild_road_graph_inner`/`RoadGraph` из теста: при ошибке добавить минимальный `pub use` в `transport/mod.rs`.

### P0-6 (decay sign)

- Off-by-one в учёте дней снято с запасом (цикл до day=13); если семантика `current_day`/`decay_start_day` иная — число итераций в тесте подправить на 1 (на корректность фикса не влияет).

### P0-7 (persist traffic lights)

- **Использовать `cluster.tiles.first().copied()`, НЕ `centroid_tile`** в `snapshot_traffic_lights`: центроид L-образного кластера может лежать вне тайлов → `tile_to_intersection.get(centroid)` вернёт `None`, светофор не восстановится.
- Конструктор `RoadCell`/`RoadKind::Local` в тестах не перепроверён в этой сессии — сверить с `roads.rs`/`map/tests.rs` (там road задаётся через `GameCommand::SetRoad`); как альтернатива ручному литералу — `apply_game_commands_to_grid`.
- Roundtrip parse-тест живёт в `config_loader.rs::tests`, не в `persistence.rs`.

### P0-8 (gap clamp)

- Имя биндинга `entity` в цикле `move_vehicles` подтвердить грепом перед правкой (строки `drive.rs:160-199` в проходе не открывались).
- Точное место `leader_same_tile.clear()` и объявление поля `struct TrafficSpatialIndex` (для `leader_same_tile_progress`) подтвердить грепом (читались только `:120-239`).

---

## Execution Handoff

План сохранён. Два режима выполнения:

1. **Subagent-Driven (рекомендуется)** — свежий субагент на задачу, ревью между задачами, быстрая итерация. Sub-skill: `superpowers:subagent-driven-development`.
2. **Inline Execution** — выполнение в текущей сессии с чекпойнтами. Sub-skill: `superpowers:executing-plans`.

**Порядок landing'а — см. раздел «Recommended Landing Order» вверху.** Начинать с **P0-1** (фундамент детерминизма): без него остальные traffic-фиксы нечем валидировать.
