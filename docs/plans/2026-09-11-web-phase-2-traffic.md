# Этап 2 — трафик: план

> Программа: `docs/plans/2026-09-11-ts-threejs-migration-plan.md`. Этап крупнейший (~13 тыс. строк Rust, 91 тест в таблице программы), поэтому делится на три под-этапа со своими воротами. 2a детализирован ниже, 2b и 2c — перед своим стартом. Исполняется inline, код в коммитах.

**Цель:** машины в `packages/sim` ездят, стоят на светофорах, проходят перекрёстки через арбитр лейнлетов, паркуются, перепланируют маршрут и выходят из заторов так же, как в Rust.

## Под-этапы и ворота

| | Что | Тесты | Ворота |
|---|---|---|---|
| 2a | модель машины, `PathPool`, светофоры, занятость, пространственный индекс, IDM и жёсткий зажим, стоп-линии, разрыв обменов тайлами, реестр резерваций | 28 | взвод на коридоре без перекрёстков в живой игре Rust и в TS: 400 тиков, курсор, прогресс (1/64 тайла) и скорость каждой машины совпадают |
| 2b | арбитр лейнлетов, гранты и вход в бокс, защищённый левый, пешеходные маски, справедливость подходов | 50 | перекрёсток со светофором: те же траектории, 1500 тиков |
| 2c | спавн поездок, парковка своих машин, перепланирование, застревание и восстановление, смена полос | 15 | ворота программы: оракул 3000 тиков на тестовом городе (поездки из Rust переигрываются командами), 0 расхождений состояний, ≤1 % квантованного прогресса; soak без машин старше 600 тиков в `WaitingForGreen` |

Тесты, переданные другим этапам: `traffic/tests/pedestrians.rs` (1) — этап 4, пешеходов нет; `config.rs::traffic_ron_parses_without_lanelet_flag` (1) — этап 6, вместе с загрузчиком RON.

## Решения, общие для этапа

1. **Машины — SoA в `World.vehicles`** с фиксированной ёмкостью. Порядок обхода — порядок слотов. В Bevy порядок задают архетипы, и он меняется при вставке маркеров. Тай-брейки в Rust идут по `Vehicle.seq`, поэтому порядок слотов влияет только там, где сам Rust зависит от порядка запроса. Такие места я записываю отклонениями, а не повторяю архетипы.
2. **Ссылка на машину — `slot + generation × ёмкость`**, аналог `Entity` с поколением. Реестр резерваций хранит ссылки, и переиспользованный слот не наследует чужую резервацию.
3. **Маркеры компонентов — поля слота:** `role` (поездка, служба, автобус), пассажир, владелец, `Parked`, `RightTurnOnRed`, `StuckTimer`, `SwapDeadlocked`. Сложные значения — `VehicleTrafficState` и план лейнлетов — лежат массивами объектов рядом с typed arrays: меняются редко, а typed-представление ради них не окупается.
4. **Время системы — `dtNs`.** Rust-тест, который не двигает `Time<Fixed>`, в TS получает `dt = 0`, иначе его смысл меняется.
5. **Float-математика.** IDM в Rust берёт `powf(delta)` и `sqrt`. `Math.pow` зависит от движка, поэтому целый `delta` (по умолчанию 4) считается цепочкой умножений f32, а дробный `delta` отклоняется при загрузке конфига. `Math.sqrt` разрешён одной обёрткой: IEEE 754 требует корректно округлённый корень, и все движки берут его из инструкции процессора. Фингерпринт в двух движках проверяет это на каждом прогоне CI.
6. **Телеметрия `VehicleAggSnapshot` не портируется:** это отладочные счётчики, в состояние симуляции они не входят.

## 2a: инварианты из Rust-тестов

| Rust-тест (файл) | Инвариант |
|---|---|
| `upcoming_lanelet_resolves_at_offset_minus_one` (components.rs) | план лейнлетов отдаёт запись со смещением `cursor + 1` |
| `is_current_requires_matching_version_and_entries` | план актуален только непустым и для той же версии графа |
| `clear_lanelet_plan_on_reroute_clears_and_no_ops` | перепланирование очищает план, пустой план не трогает |
| `vehicles_are_numbered_in_the_order_they_arrive_and_keep_their_number` (vehicle_seq.rs) | номер выдаётся по порядку появления и не меняется |
| `light_cycle_actuates_protected_left_only_on_demand` (lights.rs) | без спроса цикл из 6 фаз; спрос вставляет защищённый левый перед зелёным своей оси |
| `user_light_survives_snapshot_and_restore` | светофор переживает снимок и восстановление по ключу кластера |
| `ledger_atomic_admit_and_or_fold_release` (reservations.rs) | допуск атомарен против держателей, освобождение пересобирает маску OR-свёрткой |
| `ped_mask_blocks_crossing_lanelet` | занятый пешеходами переход закрывает пересекающий лейнлет |
| `inbox_mask_blocks_conflicting_entrant_without_holder` | машина в боксе закрывает конфликт даже без держателя |
| `release_intersection_holds_frees_ledger` | выход из кластера освобождает реестр, неизвестные id безвредны |
| `leaving_box_onto_full_exit_road_is_not_capacity_blocked` (drive.rs) | выезд из бокса не блокируется ёмкостью выезда |
| `road_to_road_onto_full_tile_is_still_capacity_blocked` | шаг дорога→дорога на полный тайл блокируется |
| `entering_box_is_not_capacity_blocked_here` | въезд в бокс не проверяется ёмкостью дороги |
| `interpolates_position_at_overstep_fraction` (vehicle_render.rs) | позиция для кадра — `lerp(prev, curr, доля шага)` |
| `yellow_allows_proceeding_if_too_late_to_stop_comfortably` (vehicle_spawning.rs) | на жёлтом, если комфортно не остановиться, машина пересекает |
| `vehicle_arrival_emits_trip_finished` (basic_behavior.rs) | доехавшая машина пишет `TripFinished` и исчезает |
| `lateral_tile_swap_on_same_direction_lanes_does_not_deadlock_forever` | взаимный обмен тайлами на соседних полосах разрывается за 200 тиков |
| `swap_breaker_is_inert_for_normal_queueing` | обычная очередь маршруты не переписывает |
| `same_tile_follower_cannot_overlap_leader_after_large_step` | ведомый на тайле лидера не наезжает при большом шаге |
| `next_tile_follower_cannot_overlap_boundary_crossing_leader` | ведомый не наезжает на лидера на следующем тайле и доходит до безопасной границы |
| `free_flow_follower_not_throttled_by_clamp` | без лидера зажим не тормозит |
| `stuck_reverse_never_backs_into_intersection_box` | задний ход не пересекает границу тайла |
| `bus_with_exhausted_path_is_not_despawned_by_move_vehicles` | автобус с исчерпанным маршрутом остаётся |
| `intersection_tiles_ignore_tile_capacity_gate_in_move_vehicles` (traffic_lights.rs) | внутри бокса ёмкость тайлов не держит |
| `traffic_light_stop_line_is_on_approach_tile_not_in_intersection` | стоп-линия на тайле подхода, в бокс без допуска не въехать |
| `vehicle_inside_signalized_intersection_is_forced_to_crossing_state` | машина в боксе всегда `CrossingIntersection` |
| `protected_left_releases_left_turner` | защищённая стрелка отпускает левоповоротного в `Accelerating` |
| `right_turn_on_red_speed_is_capped_to_turn_speed` | правый на красный (флаг США) ставит маркер и не превышает свою макс. скорость |

Плюс сверх Rust: `platoonMatchesRust` — ворота 2a против фикстуры `examples/dump_platoon.rs`.

## 2a: файлы и контракты

- `packages/sim/src/traffic/`: `config.ts` (`TrafficConfig` целиком, IDM в мировых единицах), `vehicles.ts` (SoA, ссылки, спавн и удаление слота, `VehicleTrafficState`, план лейнлетов), `pathPool.ts`, `seq.ts`, `lights.ts` (фазы, `updateTrafficLights`, `syncTrafficLights`, команды светофора), `occupancy.ts` (расширение 1b: EMA, `TrafficIndex`), `spatialIndex.ts`, `state.ts` (`updateVehicleTrafficState`, `computeExitDirection`), `drive.ts` (`moveVehicles`, `capacityBlocksStep`, IDM), `swapBreak.ts`, `reservations.ts` (реестр, `cleanupIntersectionReservations`).
- `World`: `vehicles` расширяется, `pathPool`, `vehicleSeq`, `trafficLights`, `leftTurnDemand`, `reservations`, `spatialIndex`, `trafficIndex`; `events.tripFinished`.
- Расписание: `updateTrafficLights` (SimStep::Traffic), затем TrafficStep::Flow `updateTrafficOccupancy → updateVehicleTrafficState` и TrafficStep::Movement `assignVehicleSeq → buildSpatialIndex → breakTileSwaps → moveVehicles → cleanupRightOnRedMarkers → cleanupIntersectionReservations`. Спавн, смена полос, арбитр и восстановление встают на свои места в 2b–2c.
- `examples/dump_platoon.rs`: на сгенерированной карте без зон и зданий строится двухполосный коридор, в него ставятся 12 машин с разными скоростными профилями и стартовыми позициями, и игра гонит 400 тиков через `accumulate_overstep`. Пример пишет состояние машин на каждом тике.

## Сделано / Отклонения / Замеры

### 2a (коммиты 0544244, 94b16db, b61b491 и коммит ворот)

- **Ворота пройдены сильнее заявленного.** `platoonMatchesRust`: коридор x 2..50, 12 машин, 400 тиков составной игры Rust. Курсор, прогресс и скорость совпадают бит в бит, а не с точностью 1/64 тайла. Фикстура включает прибытия и despawn.
- Системы стоят в расписании: `updateTrafficLights`, Flow, Movement и `updateTrafficIndex` в `FIXED_UPDATE`; команды светофора и `clearVehicles` в `COMMAND_APPLY`; `syncTrafficLights` в `UPDATE_GRAPH`; teardown трафика на входе в меню. Поверх Rust добавлены 4 теста `trafficSchedule`. Фингерпринт покрывает `tripFinished`, EMA занятости, `trafficIndex`, кэш дорог и счётчики производителей маршрутов. Пространственный индекс в фингерпринт не входит: он пересобирается перед каждым использованием.
- Прогон: vitest 39 файлов / 209 тестов, typecheck, lint, e2e 20 — зелёные.

**Находки и отклонения**

1. `powf(4)` в IDM: цепочка f32-умножений разошлась с libm на 1 ULP скорости (тик 8, машина на `max_speed`). Теперь произведения считаются в f64, и в f32 округляется один раз. Остаточный риск — двойное округление в редком пограничном случае. Эталон — libm macOS, на других платформах `powf` может округлять иначе.
2. Despawn в Rust не освобождает путь в `PathPool` (прибытие, выход в меню, `GenerateMap`), refcount остаётся. Порт повторяет это, чтобы состояние пула совпадало. Debug-размещение в мосту освобождает путь явно.
3. Despawn в `moveVehicles` применяется после цикла, как Bevy `Commands`.
4. Уступка пешеходам во входном гейте бокса отложена до этапа 4.
5. `LaneGraph.getRightmostLane` в модели «полоса = тайл»: полоса тайла, если направление совпадает.

**Замеры:** `bun run bench` — пустая карта p50 0.18 мс, тестовый город p50 0.19 мс. Машин в бенче пока нет, стоимость тика с трафиком замеряется на оракуле 2c.

**Вне порта:** `cargo clippy -D warnings` падает на `derivable_impls` в `crates/simcity_sim/src/game/mod.rs:48` (`AutoStartTestCity`). Это пришло с main и не трогалось; пример `dump_platoon` чистый.
