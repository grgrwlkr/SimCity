# Дизайн: левые повороты + разворот по ПДД на lanelet, единая центр-геометрия, снос legacy

> Дата: 2026-06-28. База: HEAD `2ae7c39`. Источник фактов: `docs/superpowers/intersection-current-state-map.md` + верификация живого кода (workflow `wf_04165c0f-974`, 7 агентов).
> Throughput/gridlock — **вне этого spec** (отдельный документ после замеров фаз 0–6).

---

## 1. Цель и не-цели

**Цель.** Довести КАЖДЫЙ манёвр через перекрёсток (прямо / направо / налево / разворот) до корректного resolved-lanelet'а так, чтобы:
- ни одна машина не выезжала на встречную полосу выездной дороги (ПДД 8.6);
- левый поворот работал и в permissive (зелёный, уступает встречным — ПДД 13.4), и в protected (стрелка, встречка на красном — ПДД 13.5) режимах;
- разворот (ПДД 8.6 — вокруг центра) строился как полноценный lanelet;
- поворачивающий уступал пешеходам на выходном переходе (ПДД 13.1);
- геометрия всех поворотов считалась единообразно через центр перекрёстка;
- модель полос+направлений была реально populated на каждой дороге (autogen активен);
- legacy-путь перекрёстков был удалён полностью (one-way, без флага).

**Не-цели (вне scope).**
- Throughput/gridlock (Inv8-девиация «Approaching держит точки», inbox-wedge каскад) — отдельный spec.
- Реалистичная попарная «помеха справа» (ПДД 13.11) — оставляем детерминированный тотальный порядок арбитра (by-construction deadlock-free).
- Знаки приоритета (StopSign/YieldSign/MainRoad) и команды их установки — мёртвое scaffolding, удаляется, не реализуется.
- Апгрейд дорог до многополосных в генераторе города — отдельная map-gen задача. Здесь: однополосная дорога остаётся однополосной, её единственная полоса = `Regular`-allows-all.

---

## 2. ПДД-основа (синхронизировано с заказчиком)

| Пункт | Правило | Как ложится на модель |
|---|---|---|
| 8.5 | Перед поворотом занять крайнее положение (налево/разворот — крайнее левое) | Дисциплина входа: левый/разворот из `LeftTurnOnly` (многополосные) или единственной `Regular` (однополосные) |
| 8.6 | При выезде с пересечения **не оказаться на стороне встречного движения**; правый — ближе к правому краю; повороты — вокруг центра | «Встречка» = выходная полоса со встречным потоком (`road.dir` внутрь бокса). Exit корректен **по построению** (см. §4.1). Геометрия — центр-pivot |
| 13.1 | Уступить пешеходам/велосипедистам при повороте | Phase 5: turn → бит выходного перехода в `ped_mask` |
| 13.4 | Левый на зелёный — уступить встречным прямо/направо | permissive-левый: ConflictMatrix режет о встречный-прямой геометрически |
| 13.5 | Движение по стрелке доп.секции — уступить с других направлений | protected-левый: выделенная фаза, встречка на красном, матрица свободна |
| 13.11 | Равнозначные — помеха справа | **Намеренно** заменено детерминированным `dir_precedence` (N>E>S>W) + ширина дороги (анти-deadlock). Не меняем |
| 13.12 | Левый/разворот на равнозначной — уступить встречным | то же permissive-поведение на нерегулируемом |

**«Выезд на встречку» — точное определение:** завершение поворота (чаще левого/разворота) так, что машина приземляется на полосу выездной дороги, по которой идёт встречный поток. В тайловой модели «сторона встречного движения» = полосы, чей `road.dir` смотрит **внутрь** перекрёстка. Внутренняя дуга (траектория в боксе) — вторична: от столкновений защищает ConflictMatrix.

---

## 3. Корневая причина (из верификации, подтверждено кодом)

Единственная незавершённая миграция на lanelet породила обе проблемы («недоделанный ПДД» и «выезд на встречку»):

1. **`autogen_turn_lanes` мёртв** (`turn_lanes.rs:27`) — не зарегистрирован ни в одном `add_systems`, `TurnLaneAutogenState` не `init_resource`. → каждый тайл в рантайме `lane_type = Regular` (default).
2. **Левый lanelet не строится:** `lane_allows_maneuver(Regular, LeftTurn, drive_on_right=true)` = `!drive_on_right` = `false` (`build.rs:43`) → `continue` (`build.rs:452`) → в графе **ноль** lanelet'ов с `maneuver==LeftTurn`.
3. **Разворот не строится:** `maneuver_kind` для `exit==entry.opposite()` → `ManeuverKind::Other` (`zones.rs:60`) → отвергается всеми арками; `build_l_path` требует перпендикулярности (`dot==0`, `build.rs:137`), у разворота `exit_delta=-entry_delta` → проваливается в BFS.
4. **Каскад coarse:** нерезолвнутый манёвр → coarse (`arbiter.rs:864-868`): `coarse=true, internal_path=[], maneuver=Straight` (мислейбл!). Coarse едет whole-box по сырому маршруту без полосной дисциплины → **встречка**. Плюс мислейбл `Straight` глушит `LeftTurnDemand` (ставится только при `maneuver==LeftTurn`, `arbiter.rs:919-931`) → protected-фаза не актуируется (`left_protected_active=0`).
5. **Шов state↔drive:** `update_vehicle_traffic_state` не имеет ветки `is_left_protected` (`state.rs:192-201`) → при protected-фазе держит левого в `WaitingForGreen`; `drive.rs:279-281` безусловно блокирует `WaitingForGreen` до чтения резервации → даже допущенный арбитром protected-левый стоит.
6. **`try_admit_coarse` ДОПУСКАЕТ** в пустой бокс (`reservations.rs:186-195`) — единственный путь машины на встречку.

**Ключевой факт корректности:** resolved-lanelet физически **не может** выехать на встречку — `exit_tiles` содержит только соседей, чей `road.dir` смотрит наружу бокса (`cluster_tiles.contains(&back)`, `build.rs:419-421`); встречная полоса смотрит внутрь → классифицируется как entry. Значит **построить lanelet = починить встречку**; отдельная exit-коррекция (мёртвый `connectors.rs`) не нужна.

---

## 4. Архитектурные решения

### 4.1 Единая центр-геометрия (замена `build_internal_path`)

Один маршрутизатор `build_internal_path`, пивотящий на `cluster.centroid_tile` (`index.rs:266-282`, целочисленное среднее координат). Сторона/радиус параметризованы манёвром:

- **Прямо** (`entry_dir==exit_dir`): прямой сегмент, без пивота.
- **Направо**: тугой near-угол (waypoint смещён от центра к внутреннему углу — ПДД 8.6 «ближе к правому краю»).
- **Налево**: широкая дуга вокруг центра (waypoint у дальней стороны центра).
- **Разворот**: петля вокруг центра (waypoint = центр-смежный тайл со стороны по `drive_on_right`).

**Реализация:** `path = BFS(entry_tile → waypoint) ++ BFS(waypoint → exit_adj)`, где `waypoint = pivot(centroid, maneuver, entry_dir, exit_dir, drive_on_right)`, склейка с дедупом стыка. Переиспользует существующий `build_internal_path_bfs` (4-смежность внутри кластера гарантирована, детерминированный tie-break по `(x,y)`). В вырожденных малых боксах (1–2 тайла) waypoint совпадает с entry/exit → сегменты схлопываются, путь = проезд через единственный центр-тайл (консервативно, но безопасно).

**Контракт сохраняется:** возвращает tile-последовательность внутри кластера, соседние пары Manhattan-расстояние 1, `None` если пути нет.

**Замечание о риске:** смена тайлов `internal_path` для left/right перетряхивает `ConflictMatrix::from_paths` (конфликт = общий тайл) → меняет, какие манёвры идут параллельно → **throughput-эффект**. Collision-safety сохраняется при любых тайлах. Эффект **измеряется** (Phase 0), тюнится в throughput-спеке.

### 4.2 Модель полос: autogen — core

Завести `autogen_turn_lanes` в `TransportPlugin` (`transport/mod.rs:138`), set `GameSet::GraphUpdate`, `.before(build_lane_graph)`, `init_resource::<TurnLaneAutogenState>()`, снять `#[allow(dead_code)]`. Ребилд по bump `GraphVersion` (уже есть guard `state.version == gv.0`).

**Политика полос** (`lane_allows_maneuver`, `build.rs:30-47`):
- `LeftTurnOnly` → `LeftTurn` **+ `UTurn`** (ПДД: разворот из крайней левой).
- `RightTurnOnly` → `RightTurn`.
- `StraightOnly` → `Straight`.
- `Regular` → **всё** (`Straight + RightTurn + LeftTurn + UTurn`) — обслуживает однополосные дороги и недедицированные полосы.

Многополосные: autogen дедицирует крайние (left→LeftTurnOnly, right→RightTurnOnly, middle→StraightOnly/Regular). Однополосные: единственная полоса `Regular`-allows-all = «крайнее левое» по 8.5. Строгая дисциплина «левый только из крайней левой» на многополосных — refinement для throughput-спеки (не баг корректности).

### 4.3 Разворот как класс манёвра

- `ManeuverKind::UTurn` — новый вариант (`zones.rs:19-25`), отделён от `Other`.
- `maneuver_kind` (`zones.rs:33-61`): после straight/right/left добавить `if exit == entry.opposite() { return UTurn }`; остальное (диагонали) — `Other` (по-прежнему отвергается).
- Exit корректен по построению: обратная полоса той же дороги классифицируется как exit (`back` в кластере). `entry_lane_id != exit_lane_id` (разные полосы) → не блокируется само-связь (`build.rs`).
- Матрица: путь разворота через центр → конфликтует почти со всем → безопасно.

### 4.4 Шов protected-левого (state.rs)

В `update_vehicle_traffic_state` (`state.rs:192-201`) добавить ветку: при `light.is_left_protected(info.entry_dir)` И планируемый манёвр — левый своей оси → отпускать в `Accelerating`/`CrossingIntersection` как зелёная ветка (`state.rs:249-264`). Манёвр выводится из `entry_dir`/`exit_dir` (`compute_approach_info` уже считается; для RTOR `state.rs:294-299` уже выводит поворот так же). **Permissive-левый на обычном зелёном уже работает** (state отпускает на зелёном) — чиним только protected-интервал. `drive.rs` не трогаем (presence-gate; стейл-claim 1.5с мог бы втащить реально красную машину).

### 4.5 Запрет coarse

- Машину с turn-геометрией (`entry_dir != exit_dir`) в coarse **не допускать**: вместо `try_admit_coarse` (`arbiter.rs:547-548`) → reroute через `LaneletStallTracker`/`nudge_lanelet_stall_reroute` (`arbiter.rs:1086-1097`).
- Остаточный coarse — только истинный no-lanelet прямой; заменить мислейбл `ManeuverKind::Straight` (`arbiter.rs:866`) на геометрический манёвр из `entry_dir/exit_dir`, чтобы demand/priority/RTOR были верны.
- Гарантия: путь на встречку (whole-box без полосной дисциплины) исчезает.

### 4.6 Пешеходы при повороте (13.1)

Поворачивающий уступает пешеходам на **выходном** переходе. `seed_ped_masks` (`arbiter.rs:392-423`) уже ставит crosswalk-биты по оси пешехода; досвязать: lanelet поворота должен конфликтовать с переходом дороги, **на которую** выезжает (не только пересекаемой). Проверить, что `ped_mask` бит выходного перехода входит в строку конфликта поворотного lanelet'а.

### 4.7 Снос legacy (one-way)

**Удалить целиком:** `pdd_check.rs`; `connectors.rs` (+ `tests/route_rewriting.rs`); `plan_intersection_reservations` + `collect_/apply_intersection_reservation_candidates_inner` (`reservations.rs:697`).
**Разрегистрировать системы** (`traffic.rs`): `collect_/apply_intersection_reservation_candidates`, `mark_/rewrite_marked_intersection_connectors` (`:480-509`). Переанкорить висячие `.after(apply_intersection_reservation_candidates)` (arbiter `:515`, `break_tile_swaps` `:522`, `move_vehicles` `:524`) → на живые `cache_intersection_light_state`/`cache_pedestrian_crossing_state`.
**Стрип флага** (16 production-сайтов): поле `config.rs:47`+`:107`, `traffic.ron:6-14` (значение + stale-коммент), run-condition fns `traffic.rs:181-195` + тест `:197-224`, внутр. guard'ы `arbiter.rs:700-702`/`build.rs:355`/`reservations.rs:1457-1461` (свернуть тернар в константу), run_if'ы `transport/mod.rs:142`/`traffic.rs:433,520,572`, аргумент флага в `find_route` (`pathfinding.rs:298`, `reroute_planner.rs:44`) + 8 call-сайтов (`spawn.rs:114`, `stuck.rs:189/291`, `swap_break.rs:262`, `lane_change.rs:356`, `lane_change/planning.rs:423`).
**Прунить `zones.rs`:** удалить зональную геометрию (`ZONE_CENTER/NW/NE/SW/SE`, `right_/left_/straight_zone`, `reservation_zones_for_maneuver`); **оставить** `ManeuverKind`, `maneuver_kind`, `StreamKey`, `ZONE_ALL` (живые). Поле `IntersectionReservation.zones` (vestigial) не трогаем — out of scope минимального сноса.
**Тесты:** 21 legacy-сайт `plan_intersection_reservations` (6 файлов) → портировать инвариант-несущие (opposite-straights, ped-yield, spillback, RTOR-clear) на арбитр-харнесс (`lanelet_arbiter.rs` паттерн); `conflict_zones.rs` (старые zone-маски) — удалить.

### 4.8 Наблюдаемость (Phase 0, ПЕРВОЙ)

В `ArbiterTickStats` (`arbiter.rs:347-385`) → `DebugArbiterLedgerState` (`debug_world.rs:2104-2144`):
- `coarse_admits: u32` — прямой счётчик допусков через coarse (сейчас нет; есть только косвенный maneuver-agnostic `drop_unresolved_lanelet`).
- split `admitted`/`refused_matrix` по манёврам (`left/uturn/straight/right`).
`reservation_left` уже есть (`DebugIntersectionSnapshot:189`).

---

## 5. Фазы (порядок по зависимостям; каждая — TDD)

| # | Фаза | Зависит от | Главный verify |
|---|---|---|---|
| 0 | Наблюдаемость + collision-харнесс | — | новый тест: левый + встречный прямой, ассерт `internal_path` левого не входит в oncoming entry, матрица не пускает обоих |
| 1 | autogen core + центр-pivot роутер | 0 | каждая дорога имеет typed-полосы; повороты строят центр-путь; throughput-эффект замерен |
| 2 | Левый поворот end-to-end | 1 | `reservation_left>0`, `left_protected_active>0` при спросе, ноль oncoming |
| 3 | Разворот | 1 | разворот резолвится как `UTurn`-lanelet, exit на обратную полосу, ноль oncoming |
| 4 | Запрет coarse | 2,3 | `coarse_admits→0` для turn-геометрии; остаточный coarse только прямой |
| 5 | Пешеходы (13.1) | 2,3 | поворачивающий ждёт пешехода на выходном переходе (`ped_mask` бит в строке) |
| 6 | Снос legacy (one-way) | 2,3,4 | флага нет, мёртвые файлы удалены, портированные тесты зелёные, `cargo clippy -D warnings` чист |

Legacy последней: меньший blast-radius при итерации поведения; формально `connectors.rs` избыточен (exit корректен по построению), но безопаснее резать после стабилизации поведения.

---

## 6. Стратегия тестирования

- **Харнесс живого пути:** `build_lanelet_graph → arbitrate_lanelet_reservations → cleanup` (паттерн `lanelet_arbiter.rs:144-152`); drain через `move_vehicles`, не ручной `set_cursor`, где проверяется реальный проезд.
- **Net-new инварианты живого арбитра** (сейчас покрыт ~2 тестами): no-oncoming для left/uturn, permissive-left-yield, protected-left-drives, ped-yield-on-turn, coarse-forbidden-for-turns, центр-pivot геометрия (waypoint у центра).
- **Портированные** из legacy: opposite-straights, spillback, RTOR-clear.
- **Floor:** `cargo fmt --all` → `cargo clippy --all-targets --all-features -- -D warnings` → `cargo test`.
- **Live (BRP):** прогон тест-сити, watch `DebugArbiterLedgerState`/`DebugIntersectionSnapshot`; критерии успеха — §7.

---

## 7. Критерии успеха (наблюдаемые через BRP)

1. `reservation_left > 0` при наличии левых (сейчас 0 — мислейбл).
2. `left_protected_active > 0` когда есть спрос на protected-левый.
3. `coarse_admits → ~0` для turn-геометрии (новый счётчик).
4. Net-new collision-тест зелёный: ни один resolved поворот не входит в oncoming entry-полосу.
5. Флаг `experimental_lanelet_intersections` отсутствует в коде; `connectors.rs`/`pdd_check.rs` удалены; clippy чист.

---

## 8. Риски

| Риск | Митигация |
|---|---|
| Центр-геометрия перетряхнёт матрицу → throughput-регресс | Замер в Phase 0 (split-счётчики); тюнинг — throughput-спек. Collision-safety инвариантна |
| `Regular`-allows-all ломает дисциплину «левый из левой» на многополосных | Принято: не баг корректности (exit наружу). Строгая дисциплина — throughput-спек |
| Снос legacy роняет покрытие инвариантов (живой арбитр ~2 теста) | Портировать инвариант-несущие тесты ДО удаления (Phase 6 порядок) |
| Разворот-петля в крошечном боксе вырождается | BFS-склейка грациозно схлопывает сегменты; consurvative проезд через центр |
| Шов `drive.rs` при правке state.rs втащит красную машину | Чиним строго в state.rs (живой свет + известный манёвр), presence-gate не трогаем |

---

## 9. Затронутые файлы (карта)

**Правка:** `transport/lanelet/build.rs` (геометрия, политика полос), `transport/turn_lanes.rs` (снять dead_code), `transport/mod.rs` (регистрация autogen), `traffic/intersection/zones.rs` (UTurn, прун), `traffic/movement/state.rs` (protected-ветка), `traffic/intersection/arbiter.rs` (coarse-демоут, maneuver-fidelity, ped-bit, stats), `traffic/intersection/reservations.rs` (try_admit_coarse, стрип флага, удалить wrapper), `intersections/index.rs` (centroid — чтение), `debug_world.rs` (новые поля), `config.rs`/`assets/config/traffic.ron` (снос флага), `traffic.rs` (разрегистрация систем, переанкор).
**Удаление:** `traffic/intersection/pdd_check.rs`, `traffic/intersection/connectors.rs`, `traffic/tests/route_rewriting.rs`, `traffic/tests/conflict_zones.rs`.
**Тесты:** `traffic/tests/lanelet_arbiter.rs` (расширение), порт из `intersection_reservations.rs`/`right_turn_on_red.rs`/`pedestrians.rs`/`basic_behavior.rs`/`traffic_lights.rs`.
