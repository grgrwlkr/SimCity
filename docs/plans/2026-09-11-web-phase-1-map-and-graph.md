# Этап 1 — карта и транспортный граф: план

> Программа: `docs/plans/2026-09-11-ts-threejs-migration-plan.md`. Этап крупный (138 тестов в таблице программы, ~8 тыс. строк Rust), поэтому он делится на три под-этапа со своими воротами. 1a детализирован ниже, 1b и 1c детализируются перед своим стартом. Исполняется inline, код в коммитах.

**Цель:** тайловая карта, команды правки, undo/redo, дорожный граф, road-A*, lane graph и лейнлеты в `packages/sim`, совпадающие с Rust на тех же входах.

## Под-этапы и ворота

| | Что | Тесты | Ворота |
|---|---|---|---|
| 1a | карта, генерация, координаты, применение команд, стоимость и отказы, undo/redo, дорожный инструмент, глубина зоны | 17 | `GenerateMap` на 4 сидах даёт `height` и `water`, совпадающие с Rust байт-в-байт (`examples/dump_map.rs`) |
| 1b | дорожный граф (рёбра, one-way, U-turn, пруннинг в боксе), автоген полос поворота, lane graph, якоря у дороги, road-A* с загрузкой и кэшем, оракул встречки | 31 | road-A* на тестовом городе: 200 пар старт/цель совпадают с Rust тайл-в-тайл |
| 1c | кластеры перекрёстков, построение лейнлетов, матрицы конфликтов, `find_route` с sidecar | 43 | ворота этапа из программы: `find_route` на 200 парах совпадает с Rust вместе с sidecar |

Тестовый город для 1b и 1c приходит фикстурой сетки из Rust-примера (`LoadTestCity` → JSON). Порт `test_city.rs` остаётся на этапе 6.

## Тесты, переданные другим этапам (48)

Подсистема, от которой зависит тест, в этапе 1 не существует, поэтому тест уходит туда, где она появляется:
- **Этап 3 (11):** размещение и снос зданий с undo, стоимость и вместимость служб, мощность станций, вехи (2), строка стройки в бюджете (`map/tests.rs`).
- **Этап 4 (1):** `report_oncoming_offenders_on_real_city` — нужны машины, автобусы и службы.
- **Этап 5 (8):** picking в двух проекциях (2), размещение пропсов (6).
- **Этап 6 (25):** имена оверлеев (3) и скоростей (2), хоткеи при захвате клавиатуры (5), hovered-тайл (2), гейт покраски под интерфейсом (2), все 11 тестов `data_map.rs` (легенды и чтения оверлеев поверх индексов этапов 3–4).
- **Этап 1½ (3):** `ray_ground_t` — пересечение луча с землёй для picking отладочного рендера.

Добавлен 1 тест сверх таблицы программы: `zone_density_zoning_reaches_as_deep_as_buildings_grow` из `zone_placement.rs`. Правило глубины зоны — часть применения команд 1a.

## Отклонения от программы

1. **Rust-правка этапа — не одна утилита, а примеры в `examples/`:** `dump_map` для 1a и `dump_routes` для 1b–1c. `dump_trajectory` остаётся за этапом 2. Крейты не правятся: примеры собирают headless-приложение сами, потому что `headless_sim` в `simcity_data` приватный.
2. **Контракт `World`:** вместо `tiles { kind, zone, road, landValue, pollution }` появляется `grid: MapGrid`, SoA по полям `MapCell` с произвольными шириной и высотой (Rust-тесты берут сетки 5×5…32×32). `landValue` и `pollution` уходят в индексы этапа 3. Добавляются `dirty`, `roadDirty`, `mapEditVersion`, `graphVersion`, `history`, `undoRedo`. В `COMMAND_APPLY` система `applyMapSeed` заменяется на `applyGameCommandsToGrid`.
3. **Протокол:** сообщение `undoRedo { redo }`. В Rust это `UndoRedoRequested`, не `GameCommand`.

## 1a: инварианты из Rust-тестов

| Rust-тест | Инвариант | TS-тест |
|---|---|---|
| `map_generation_is_deterministic_for_seed` | два `GenerateMap` с одним сидом дают одинаковые клетки | `mapGenerationIsDeterministicForSeed` |
| `command_apply_marks_dirty_and_bumps_graph_version_on_road_change` | `SetRoad` пишет дорогу, поднимает `GraphVersion`, помечает клетку грязной | то же в camelCase |
| `water_tiles_are_not_buildable_by_commands` | дорога на воду отклоняется без списания денег и без смены версии | … |
| `undo_removes_built_road_and_restores_downgraded_kind` | undo стройки убирает дорогу, undo апгрейда возвращает прежний тип | … |
| `undo_undo_then_redo_redo_walks_history` | undo идёт по истории назад, redo-стек переживает undo | … |
| `zone_density_zone_command_paints_a_block_as_deep_as_buildings_grow` | зона ложится на глубину 3 от дороги с плотностью инструмента, 4-й ряд отклоняется | … |
| `generate_map_clears_command_history` | `GenerateMap` очищает оба стека | … |
| `zone_density_zone_command_paints_density_and_undo_restores_it` | та же зона с другой плотностью — это правка; undo возвращает плотность | … |
| `road_segment_one_way_stroke_makes_every_lane_flow_one_way` | один `SetRoad` на полосу на тайл, у всех `OneWay(East)` | … |
| `road_segment_two_way_stroke_keeps_lanes_two_way` | без one-way ни одна полоса не one-way | … |
| `road_segment_one_way_stroke_points_every_lane_the_one_way_direction` | у one-way все полосы смотрят в сторону потока при любой ширине и стороне движения | … |
| `roundtrip_all_tiles` | tile → world → tile — тождество | … |
| `roundtrip_survives_subtile_offsets` | смещение меньше полутайла возвращает тот же тайл | … |
| `outside_map_is_none` | за картой — `undefined` | … |
| `map_is_centered_on_origin` | противоположные углы симметричны относительно нуля | … |
| `fractional_matches_integer_at_whole_tiles` | дробные координаты на целых совпадают с целыми, центр 2×2 посередине | … |
| `zone_density_zoning_reaches_as_deep_as_buildings_grow` | `canZoneTile`: рядом и на глубине 3 можно, на 4, на дороге и на воде нельзя | … |

Плюс сверх Rust: `mapGenerationMatchesRust` (4 сида × `height`/`water` против фикстуры из `examples/dump_map.rs`).

## 1a: файлы

- `examples/dump_map.rs` → `packages/sim/test/fixtures/map-generation.json`
- `packages/sim/src/map/`: `grid.ts` (MapGrid SoA, `get/set/idx`), `roads.ts` (типы дорог: полосы, стоимость, апгрейд, направления), `coords.ts` (f32 через `Math.fround`, округление от нуля), `generation.ts`, `dirty.ts`, `history.ts`, `zonePlacement.ts`, `apply.ts` (`applyGameCommandsToGrid` + undo/redo), `roadTool.ts`
- `packages/sim/test/map/`: `grid.test.ts` (генерация и паритет), `apply.test.ts`, `roadTool.test.ts`, `coords.test.ts`, `zonePlacement.test.ts`
- Правки: `world.ts`, `schedule.ts`, `fingerprint.ts` (секция `map`, покрытие новых полей), `map.ts` удаляется (поглощён `apply.ts`), bridge `protocol.ts` + `host.ts` (`undoRedo`)

## 1b: инварианты из Rust-тестов

| Rust-тест (файл) | Инвариант |
|---|---|
| `road_path_smoke_test_on_simple_line` (map/tests.rs) | прямая двухполосная дорога: road-A* возвращает все 5 тайлов от старта до цели |
| `one_way_stroke_across_an_intersection_keeps_the_crossing_drivable` (map/tests.rs) | one-way поверх перекрёстка оставляет бокс боксом, вертикальные рёбра бокса не меняются, горизонтальные все на восток |
| `congestion_affects_route_choice_between_parallel_lanes` (transport/tests.rs) | загрузка на двух тайлах уводит маршрут на параллельную полосу |
| `lane_type_left_turn_only_allows_only_left_entry_into_intersection` | LeftTurnOnly: в бокс только левый въезд |
| `lane_type_right_turn_only_allows_only_right_entry_into_intersection` | RightTurnOnly: только правый |
| `lane_type_straight_only_allows_only_straight_entry_into_intersection` | StraightOnly: только прямо |
| `intersection_exit_requires_lane_dir_alignment` | выезд из бокса только на полосу по направлению движения |
| `lane_entry_blocks_reverse_into_intersection` | въезд в бокс задним ходом запрещён |
| `autogen_turn_lanes_four_lane_two_lanes_assigns_left_and_straight_only` | T без прямого выезда: левая полоса LeftTurnOnly, правая Regular |
| `autogen_turn_lanes_feeds_road_graph_on_fixed_update` | в одном тике автоген полос идёт раньше графа, граф видит свежие метки |
| `road_graph_before_autogen_bakes_stale_lane_marks` | обратный порядок запекает старые метки (негативный контроль пина выше) |
| `lane_graph_skips_rebuild_for_unchanged_graph_version` | lane graph не перестраивается без смены версии и перестраивается после |
| `lane_graph_empty_build_counts_as_built` | пустой lane graph тоже считается построенным |
| `one_way_ignores_opposite_direction_lane_tiles` | на one-way тайл против потока не получает рёбер |
| `one_way_allows_lane_change_between_same_direction_lanes` | смена полосы на one-way разрешена |
| `adjacent_road_anchor_never_prefers_oncoming_lane` | якорь предпочитает перпендикулярную полосу встречной; неправильная половина one-way не якорь |
| `in_box_edges_respect_reconstructed_axis_direction` | внутри бокса шаги против восстановленного направления оси обрезаны, по направлению остаются |
| `road_astar_far_column_p_uturn_still_routes_and_avoids_oncoming_box_half` | разворот П проходит через северную колонну 5, без обхода по краю по колонне 4 |
| `uturn_edge_added_at_two_way_dead_end` | в тупике двусторонней дороги есть ребро разворота на встречную полосу, в середине дороги его нет |
| `no_uturn_edge_on_one_way_dead_end` | в тупике one-way ребра разворота нет |
| `zone_density_building_entrance_is_found_along_the_whole_footprint` | вход ищется по всему периметру пятна, ближайший к цели; якорь у дороги сохраняет свой |
| `autogen_keeps_lanes_regular_when_straight_exit_exists` (turn_lanes.rs) | при прямом выезде все полосы подхода Regular |
| `autogen_marks_left_lane_on_must_turn_approach` | подход «только поворот»: левая LeftTurnOnly, правая Regular |
| `autogen_single_lane_approach_stays_regular` | однополосный подход остаётся Regular |
| `straight_through_box_is_clean` (route_oncoming_pins.rs) | прямой проезд бокса — не встречка |
| `legal_uturn_through_center_passes` | разворот П через центр — не встречка |
| `illegal_edge_hug_uturn_is_flagged` | разворот по краю бокса флагуется на шаге по южной колонне |
| `real_lane_wrong_way_is_flagged` | движение против полосы флагуется |
| `b_side_entering_real_lane_against_dir_is_flagged` | въезд на полосу против направления ловится проверкой второго тайла |
| `one_sided_t_junction_column_still_constrains` | одной стороны оси достаточно для ограничения |
| `disagreeing_sides_yield_no_constraint_known_false_negative` | несогласные стороны оси не ограничивают (задокументированный ложный отрицательный) |

Плюс сверх Rust: `roadAStarMatchesRustOnTestCity` — 200 пар против фикстуры `examples/dump_routes.rs`. В фикстуре сетка тестового города до автогена, тайлы со светофорами, пары, сгенерированные в Rust, и маршрут Rust для каждой пары после одного `FixedUpdate`. TS прогоняет у себя автоген, дорожный и региональный графы.

## 1b: файлы и контракты

- `packages/sim/src/transport/`: `roadGraph.ts` (рёбра W/E/S/N, one-way, пруннинг в боксе, U-turn в тупике), `turnLanes.ts`, `regionGraph.ts`, `laneGraph.ts`, `pathfinding.ts` (конфиг, кэш TTL+LRU, стоимость ребра на f32 через `Math.fround`, A* с порядком кучи `(f, g, idx)`, региональный pre-pass), `anchors.ts`, `oncoming.ts` (оракул встречки); `packages/sim/src/intersections/clusters.ts` (кластеры и `IntersectionIndex` с набором светофоров — сами светофоры на этапе 2).
- `World`: `roadGraph`, `regionGraph`, `laneGraph`, `turnLaneAutogenVersion`, `pathCache`, `pathfindingConfig`, `intersections`, `trafficOccupancy.perTickVehicles` (заполняет этап 2). `FIXED_UPDATE` после `beginTickEvents`: `autogenTurnLanes → rebuildRoadGraph → rebuildRegionGraph → buildLaneGraph` (GraphUpdate; лейнлеты добавит 1c).
- `examples/dump_routes.rs` → `packages/sim/test/fixtures/road-routes.json`.

## Сделано / Отклонения / Замеры

**1a (2026-09-11).** 17 тестов зелёные, ворота пройдены: `GenerateMap` совпадает с Rust байт-в-байт на сидах 1, 7, 42, 1000003 (`height` и `water`, 128×128). Отклонения: `examples/dump_map.rs` потребовал `bevy_egui` в `[dev-dependencies]` корневого пакета (одна строка в `Cargo.toml` и одна в `Cargo.lock`) — системы ввода headless-приложения требуют ресурс egui. Отпечаток мира стал хэшировать typed arrays 32-битными словами: с сеткой и машинами он стоил 9.5 мс на вызов под bun и не укладывался в 5-секундный таймаут пробы расхождения (600 тиков × 2 мира), после — 0.58 мс. Замер: полный Vitest 0.54 с, e2e 8.5 с.
