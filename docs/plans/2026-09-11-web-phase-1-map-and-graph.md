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

## Сделано / Отклонения / Замеры

Заполняется при закрытии каждого под-этапа.
