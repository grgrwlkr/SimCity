# Карта системы перекрёстков, приоритетов и трафика SimCity — состояние «как есть»

> Дата снимка: 2026-06-27. HEAD: `2ae7c39 feat(traffic): enable lanelet intersection arbiter by default`.
> Это **исследование, не ремонт** — карта поведения «как есть», включая баги, мёртвые ветки и расхождения кода с документами.
> Источник истины (по убыванию): прочитанный код + `assets/config/` + git log → live-наблюдение через BRP → тесты.
> Все факты подкреплены инструментом. Догадки помечены `(не проверено)`.

---

## 0. TL;DR

1. **Активен lanelet-арбитр.** `config.rs:107` даёт `Default=false`, но `assets/config/traffic.ron:14` ставит `experimental_lanelet_intersections: true`; RON переопределяет дефолт → живой путь — `arbitrate_lanelet_reservations` (`arbiter.rs:696`). Legacy `collect_/apply_intersection_reservation_candidates` **мёртв в рантайме** (`run_if(legacy_intersection_pipeline_enabled)`).
2. **Перекрёсток — производные данные**, не сущность: flood-fill blob тайлов с `road.dir == RoadDir::None` (`index.rs:184-295`, предикат `traffic.rs:654-662`). На тестовом городе: 18 перекрёстков, 6 со светофорами, 12 нерегулируемых, 160 тайлов перекрёстков.
3. **Главный механизм правил проезда** — не ПДД-знаки (мёртвое scaffolding), а: светофорная `lanelet_readiness` (зелёный/жёлтый/protected-left/RTOR) + **геометрическая конфликт-матрица** (`try_admit` ↔ `rows_overlap`) + capacity-гейты + детерминированный grant-свип `priority → dist → помеха-справа → entity`.
4. **Светофор**: 8 фаз, цикл 34с (без спроса) / 42с (с обоими protected-left); длительности зашиты в `Default` `TrafficLight` (НЕ в конфиге): green 10с, yellow 3с, all-red 4с, protected-left 4с.
5. **Где ломается (live-подтверждено):** арбитр хронически недопускает — **admission rate ~2.9%**, **82% тиков admit=0**, доминирует `refused_matrix` (33.8%) при `yield≈0` (свет зелёный) и низкой плотности. Каскад: `frozen` 0→26, `max_stopped_secs` 12с→164с, осциллирует (recovery разбивает и формирует заново). Collection-фаза машины НЕ теряет; coarse-fallback теперь маргинален (3.7%, не историч. 94%). Узкое место — точные матрица-отказы: удержанные `active_mask` + `inbox_mask` от заклинивших in-box машин.
6. **11 инвариантов deadlock-freedom спеки**: 3 реализованы, 1 substrate, 5 partial, **2 противоречат коду** (Inv4 «coarse never admits», Inv8 «Approaching holds no points»).

---

## 1. КАК МАШИНА ПРОЕЗЖАЕТ ПЕРЕКРЁСТОК СЕЙЧАС

Это позитивный путь — что должно сложиться, чтобы машина успешно прошла. Всё на `FixedUpdate` (10 Гц), порядок систем фиксирован.

### 1.1 Порядок 4 систем за тик (`GameSet::Sim`, `traffic.rs:436-528`)

```
 update_traffic_lights          двигает фазу света (1 раз/тик, дальше стабильна)   intersections/mod.rs:56-62
        │
        ▼
 update_vehicle_traffic_state    решает состояние машины по свету:                  movement/state.rs
        │                          green→Accelerating/FreeFlow | red→WaitingForGreen
        │                          yellow→dilemma | uncontrolled→FreeFlow | RTOR→Accelerating
        ▼
 arbitrate_lanelet_reservations  ПДД-готовность + матрица + capacity → выдаёт       intersection/arbiter.rs:696
        │                          IntersectionReservation (Approaching)
        ▼
 move_vehicles                   entry-gate: НЕ WaitingForGreen И есть резервация → въезд  movement/drive.rs
        │                          IDM-динамика, пересечение internal_path тайлов
        ▼
 cleanup_intersection_reservations  релизит при выходе / timeout 6с / stale 1.5с     intersection/reservations.rs
```

Ключ: состояние решается ПЕРВЫМ, арбитр выдаёт резервацию ВТОРЫМ (используя то же состояние и тот же кэшированный свет), `move_vehicles` перепроверяет состояние ТРЕТИЙ раз на entry-gate.

### 1.2 «Гонка препятствий» одной машины — все гейты, которые надо пройти

```
                              МАШИНА едет по дороге (FreeFlow)
                                          │
                  cursor+1 == тайл перекрёстка, cursor — не перекрёсток?
                                          │ да  → становится КАНДИДАТОМ (cand_approaching++)
                                          ▼      (порога дистанции НЕТ, бинарно)  arbiter.rs:797-809
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │ ГЕЙТ 1 — СВЕТ (state.rs + lanelet_readiness, оба на одном кэш-свете)           │
   │   • нерегулируемый        → ПРОХОД свободен по свету (ready=true всегда)        │
   │   • зелёный/жёлтый своей оси → ready; state выходит из WaitingForGreen          │
   │   • protected-left, свой левый → ready (АРБИТР), НО state НЕ знает → клин (E17) │
   │   • красный + правый near-side + стоял → RTOR (ready, is_right_on_red)          │
   │   • красный/all-red иначе  → НЕ ready → yield_refusals, ждём                    │
   └──────────────────────────────────────────────────────────────────────────────┘
                                          │ ready
                                          ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │ РЕЗОЛВ LANELET (какую «трубу» через бокс заедем)         arbiter.rs:836-869     │
   │   sidecar VehicleLaneletPlan → иначе geometry-fallback → иначе COARSE whole-box │
   └──────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │ GRANT-СВИП (per кластер, сортировка priority→dist→помеха→entity)               │
   │   ГЕЙТ 2 — downstream headroom (spillback, горизонт 3 тайла)  иначе refused_cap │
   │   ГЕЙТ 3 — RTOR только если кластер иначе чист                                  │
   │   ГЕЙТ 4 — exit-slot: phys_occ + reserved < cap(=2) и < 4    иначе refused_cap  │
   │   ГЕЙТ 5 — КОНФЛИКТ-МАТРИЦА try_admit:                       иначе refused_matrix│
   │            row не пересекает active_mask | ped_mask | inbox_mask | coarse_held  │
   └──────────────────────────────────────────────────────────────────────────────┘
                                          │ всё прошло
                                          ▼
                   ВЫДАНА IntersectionReservation { Approaching } + exit-slot
                   (Approaching УЖЕ держит бит active_mask — девиация Inv8)
                                          │
                                          ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │ ГЕЙТ 6 — move_vehicles entry-gate              drive.rs:273-293                 │
   │   state==WaitingForGreen?  → BLOCKED (даже с резервацией!)                      │
   │   иначе is_reserved_by?  нет→BLOCKED ; да→ВЪЕЗД                                 │
   └──────────────────────────────────────────────────────────────────────────────┘
                                          │ въехал
                                          ▼
              ПЕРЕСЕКАЕТ бокс по internal_path (IDM), don't-block-the-box гарантировал выход
                                          │
                                          ▼
                      ВЫХОД → release(holds + exit-slot)   reservations.rs
```

### 1.3 Четыре реальных режима проезда (сценарии)

```
A. СВЕТОФОР, ПРЯМО / НАПРАВО (массовый случай)
   красный → стоп на стоп-линии (WaitingForGreen)
   зелёный → state.rs: Accelerating ; арбитр: ready → matrix(пусто?) → грант → ВЪЕЗД
   конфликт только с перпендикулярным потоком (тот на красном) → матрица обычно чиста

B. НЕРЕГУЛИРУЕМЫЙ
   света нет → lanelet_readiness ready=true ВСЕГДА
   приоритет решает СОРТ: шире дорога → прямо>направо>лево → помеха-справа (N>E>S>W)
   матрица гарантирует, что физически пересекающиеся манёвры не въедут одновременно
   въезжает первый по сорту; остальные конфликтующие → refused_matrix, ждут освобождения

C. ЛЕВЫЙ ПОВОРОТ
   не-готовый левый на signalized → ставит LeftTurnDemand (актуация protected-фазы)
   protected-left фаза (4с): арбитр допускает ТОЛЬКО левые этой оси (встречный прямой — красный)
   ⚠ НО: state.rs не знает про is_left_protected → держит машину в WaitingForGreen →
        drive.rs:279 блокирует въезд при выданной резервации → 1.5с stale-release → пере-грант
        → ОСЦИЛЛЯЦИЯ; protected-окно для левого фактически теряется (см. E17, live: редко активно)
   на обычном зелёном левый — permissive: ready, но матрица режет о встречный прямой

D. RIGHT-TURN-ON-RED
   красный, правый near-side поворот, машина ОСТАНОВИЛАСЬ на стоп-линии
   арбитр: ready, is_right_on_red — допускает ТОЛЬКО если кластер иначе чист
   тик N: грант RTOR ; тик N+1: state.rs видит reserved → RightTurnOnRed + Accelerating → ВЪЕЗД
   (лаг 1 тик, само-исправляется; скорость кап RIGHT_ON_RED_TURN_MAX_KMH=15 — не ассертится тестом)
```

`★ Что физически защищает от столкновений:` геометрическая `ConflictMatrix` — два lanelet'а конфликтуют ⟺ их `internal_path` делят хотя бы один тайл (`conflict.rs:25-52`). `try_admit` атомарно проверяет, что строка кандидата не пересекает биты уже-впущенных (`active_mask`), пешеходных переходов (`ped_mask`) и физически-внутри машин (`inbox_mask`). Светофор и сорт решают ПОРЯДОК и ПРИОРИТЕТ; матрица решает БЕЗОПАСНОСТЬ. Даже force-admit valve не обходит матрицу.

---

## 2. A. Топология и модель перекрёстка

### A1. Перекрёсток как данные; flood-fill

Перекрёсток — производное значение `IntersectionCluster` в ресурсе `IntersectionIndex`; ECS-сущности — только маркеры (`IntersectionPriorityMarker` на тайл) и опционально один `TrafficLight`. Driving-логика геометрию из сущностей не читает.

Тайл перекрёстка = дорога с `road.dir == RoadDir::None` (`traffic.rs:654-662`). Flood-fill — `build_intersection_clusters` (`index.rs:184-295`): итеративный DFS, 4-соседство `[(-1,0),(1,0),(0,-1),(0,1)]` (`index.rs:235`), `visited` при push и pop. На кластер: `tiles.sort_by_key((y,x))`, `tiles_hash` (множитель 31, wrapping, **не collision-free**), `IntersectionKey`, `IntersectionId(next_id)` = индекс в `Vec` (row-major), `centroid_tile` (визуал).

`IntersectionId.0 == индекс в clusters Vec` → нестабилен при ребилде графа.

### A2. Id ↔ Key ↔ GraphVersion; ребилд

- `IntersectionId` (`index.rs:31-39`) — version-local.
- `IntersectionKey` (`index.rs:45-51`) — `{aabb_min, aabb_max, tile_count, tiles_hash}`, переживает ребилд (по нему выживают пользовательские светофоры).
- `GraphVersion` (`version.rs:3-14`) — bump на каждой принятой структурной правке дороги.
- Ребилд `detect_intersections` (`index.rs:154-182`): clusters/tile_to_intersection **полностью пересоздаются** (id пере-минтятся), `traffic_lights` ре-деривится из выживших `traffic_light_keys`.
- **Резервации НЕ выживают**: `reset_for_version` чистит маски/holders «BEFORE any try_admit» (`reservations.rs:114-123`).
- **Машины id не держат** — `path_handle`/`path_cursor` в `PathPool`; принадлежность по тайлу через `intersection_id_at(pos)` каждый тик.

### A3. Кластер ↔ полосы/lanelet'ы; коннекторы

Подходящие/выходные полосы — соседние не-кластерные дорожные тайлы (скан 4 соседей в порядке `[W,E,S,N]`, `build.rs:346+`); `RoadDir` соседа классифицирует entry/exit. Lanelet'ы перечисляются в порядке `IntersectionId`. `connectors.rs` — **мёртв при flag-on** (legacy gate) кроме общей геометрии.

Поля: `IntersectionCluster{id,key,tiles,aabb_min,aabb_max,centroid_tile}`; `IntersectionIndex{version,clusters,tile_to_intersection,traffic_light_keys,traffic_lights,lights_dirty,priorities_dirty}`; `IntersectionPriority{None,YieldSign,StopSign,MainRoad}`.

---

## 3. B. Светофоры

### B4. Цикл фаз и длительности

8 вариантов `LightPhase` (`lights.rs:13-29`). Базовый 6-фазный цикл: `NSGreen→NSYellow→AllRedToEW→EWGreen→EWYellow→AllRedToNS→…` (`next_light_phase` `lights.rs:251-274`). Protected-left вставляется только на выходах из all-red и только при спросе на нужную ось.

| Фаза | Длительность | Источник |
|---|---|---|
| Green NS/EW | **10.0с** | `light.green_duration` (Default `lights.rs:81`) |
| Yellow NS/EW | **3.0с** | `light.yellow_duration` (`lights.rs:82`) |
| AllRed ×2 | **4.0с** | `light.all_red_duration` (`lights.rs:83`) |
| LeftProtected ×2 | **4.0с** | `const LEFT_PROTECTED_DURATION` (`lights.rs:32`) |

Длительности — поля компонента из `Default`-impl; **ни один config/RON их не пишет** (противоречит паттерну config-driven). `update_traffic_lights` на `FixedUpdate`/`GameSet::Sim`, `.before(update_vehicle_traffic_state)`, **только `in_state(InGame)`** (на паузе свет замирает). Catch-up до 8 переходов/тик.

### B5. Protected-left через LeftTurnDemand

`LeftTurnDemand{ns,ew: HashSet<Id>}` (`lights.rs:38-44`). **Единственный не-тестовый писатель — арбитр** (`arbiter.rs:919-931`): чистит каждый тик, вставляет id оси для каждого signalized левого с `!readiness.ready`. **Порога/кворума нет** (set-membership). Читатель — `update_traffic_lights` (`lights.rs:299-303`).

### B6. Зелёный/жёлтый/all-red

Предикаты `is_green/is_yellow/is_all_red/is_left_protected` (`lights.rs:88-144`). `is_red()` — **мёртв** (`#[allow(dead_code)]`). **Обе LeftProtected дают `is_green==false`** для through.

- `update_vehicle_traffic_state`: green → выход в Accelerating (`state.rs:249-264`); yellow → dilemma (`v²/2a > dist` → CrossingIntersection, `state.rs:267-285`); red/all-red → stop. **Ветки `is_left_protected` НЕТ** (корень шва E).
- `lanelet_readiness` (`arbiter.rs:168-231`): `!signalized→ready` → нет света→not-ready → `is_left_protected&&LeftTurn→ready` → `green||yellow→ready` → `all_red→not-ready` → красный→RTOR-only.

All-red: through стоит, RTOR запрещён (`!is_all_red` guard, `state.rs:306`).

### B7. random_phase_offset

`sim_rng.random_range(0.0..10.0)` на спавне (`lights.rs:231`), seeded из `MapSeed`. **Рандомизирует только начальный `phase_timer`, НЕ фазу** — все стартуют в `NorthSouthGreen`. Эффект: расфазировка против green-wave.

---

## 4. C. Правила проезда / приоритеты

### C8. lanelet_readiness

Потребитель арбитра (см. B6). Uncontrolled → безусловно ready (`arbiter.rs:168-173`). Fairness aging НЕ в readiness — он в `priority`.

### C9. Помеха справа / главная дорога — мёртвое scaffolding

- **`pdd_check.rs` — 100% мёртв**: 3 pub-fn с `#[allow(dead_code)]`, ноль не-тестовых вызовов; модуль-док признаёт «требуется доработка».
- **`IntersectionPriority::{StopSign,YieldSign,MainRoad}` — live-but-inert**: единственный writer `assign_intersection_priorities` всегда пишет `None` (`index.rs:316-319`); читатели `==StopSign` в state.rs крутятся, но ветка не срабатывает; YieldSign/MainRoad не читает никто.
- Помеха-справа/main-road **реализованы заново внутри арбитра**: ширина via `road.kind.lanes()` (`arbiter.rs:933`) → `candidate_priority`; помеха via `dir_precedence` (N=3>E=2>S=1>W=0, `arbiter.rs:238-245`). Дублирование `is_main_road` — smell.

### C10. Порядок сортировки grant-свипа

`arbiter.rs:498-506`: `priority DESC → dist_to_entry ASC → dir_precedence DESC → vehicle.to_bits ASC`, где `priority = width_rank*64 + maneuver_rank*16 + aging.min(15)` (Straight=2>Right=1>Left=0; aging capped 15, не пересекает класс). **Дистанция — вторичный ключ, работает как tiebreak ВНУТРИ класса priority** (лексикографика). Помеха-справа — строго post-distance.

### C11. Right-turn-on-red

Допуск (арбитр `arbiter.rs:202-230`): красный (не all-red) + `stopped_for_this` + `exit==near_side` → ready+is_right_on_red. В свипе: только если кластер чист (`arbiter.rs:524`). Маркер `RightTurnOnRed` ставит **state.rs** при `light_is_red && !is_all_red && is_right_turn && reserved && stopped_or_waiting` → +Accelerating (`state.rs:306-312`). Снимает `cleanup_right_on_red_markers` + remove'ы в state.rs. Кламп `RIGHT_ON_RED_TURN_MAX_KMH=15.0` существует, тест ассертит лишь `speed<=max_speed` `(не проверено что кап применяется)`.

---

## 5. D. Резервирование и пропуск

### D12. Жизненный цикл резервации

Кандидат: `cursor+1`==перекрёсток, текущий — нет (`arbiter.rs:797-808`), порога дистанции нет. Грант → `IntersectionReservation{state:Approaching, created_at_sec, zones:ZONE_ALL, tiles, stream, maneuver}` (`arbiter.rs:572-580`). Approaching→Inside в cleanup при физическом занятии. Освобождение: выход; timeout **6.0с** (`reservations.rs:1454`); **flag-on stale-claim 1.5с** для неподвижного Approaching (`reservations.rs:1363`, flag-off=INFINITY).

`zones: ZONE_ALL` при flag-on **не читается** admission'ом — vestigial; реальный гейт — `active_mask`/`inbox_mask`/exit-slot.

### D13. Резолв lanelet: sidecar → geometry → coarse

`arbiter.rs:836-869`: (1) sidecar `upcoming_lanelet_at(cursor)` с `plan_id==id`; иначе (2) `resolve_lanelet_fallback` по геометрии (`cur→entry_lane`, `exit_tile→exit_lane`, `arbiter.rs:268-281`); иначе (3) coarse whole-box (`coarse=true`, `drop_unresolved++`).

**При провале машина НЕ выбрасывается** — становится coarse-кандидатом, `candidates_built++` всё равно. Тождество: `cand_approaching = candidates_built + drop_other_collection`, `drop_unresolved ⊆ candidates_built`. Это противоречит doc-комментарию поля (`arbiter.rs:368-371`). **Live: coarse = 3.7%** (fix re-population sidecar 2a62318 снизил с ~94%). Coarse допускается только в пустой бокс (`try_admit_coarse → box_is_clear`); отказы → `refused_matrix`.

### D14. ConflictMatrix + ledger masks

`try_admit` (`reservations.rs:155-172`): refuse если `coarse_held` ИЛИ `rows_overlap(row, active_mask|ped_mask|inbox_mask)`. `ConflictMatrix::from_paths` (`conflict.rs:25-52`): конфликт ⟺ общий тайл `internal_path`. `rows_overlap` = `any(x&y!=0)`. Точная матрица — для resolved; coarse whole-box — для unresolved. Грубый 5-зонный `ConflictMask` (`zones.rs`) при flag-on — vestigial.

### D15. Capacity-гейты

- Don't-block-the-box: `downstream_link_has_headroom`, горизонт `DOWNSTREAM_LINK_HORIZON_TILES=3` (`arbiter.rs:894-905`) → refused_capacity.
- Exit-slot: `phys_occ + slots < cap` И `slots < EXIT_SLOT_CAP(4)` (`reservations.rs:318-332`); `cap=capacity_per_lane_tile()`=**2 для всех дорог**.
- drain-aware: `entry_clear = occ==cap && front.progress>exit_clear_progress(0.75)` (`drive.rs:386-389`).
- Slots персистентны, релиз при физическом занятии.

### D16. Liveness — что реализовано

| Механизм | Значение | Где |
|---|---|---|
| Ацикличный порядок | возр. `id.0` | `arbiter.rs:482` |
| Force-admit valve | `ARBITER_FORCE_ADMIT_TICKS=30`; обходит capacity, НЕ матрицу/красный; 1/кластер/тик | `arbiter.rs:131,592-637` |
| Fairness aging | `ApproachFairness`, capped 15 | `arbiter.rs:111-114` |
| Lanelet-stall reroute | `LANELET_STALL_REROUTE_TICKS=20` | `arbiter.rs:144,1086-1097` |
| Stale-claim release | 1.5с | `reservations.rs:1363` |
| In-box safety net | wedged → ZONE_ALL Inside + inbox_mask | `arbiter.rs:458-480` |
| Ring-free topology | **WARN-only, не блокирует** | `arbiter.rs:1056-1080` |

---

## 6. E. Стык арбитра и движения (источник gridlock)

### E17. WaitingForGreen-шов

Entry-gate (`drive.rs:273-293`): безусловный блок `WaitingForGreen` **до** чтения резервации. `is_reserved_by` — presence-проверка (Approaching/Inside, без проверки света).

**Реальная дивергенция** — арбитр ШИРЕ state.rs:
1. **Protected-left (генуинный клин):** арбитр допускает LeftTurn при `is_left_protected` (`arbiter.rs:184`), но `update_vehicle_traffic_state` **не имеет ветки `is_left_protected`** (`state.rs:193-201`) → видит `is_green=false` → держит в `WaitingForGreen` → drive.rs:279 блокирует → 1.5с stale-release → пере-грант → осцилляция. Protected-окно для левого теряется.
2. **RTOR:** лаг 1 тик (само-исправляется).

**Live опровергает это как главный механизм:** `left_protected_active=0`, `reservation_left=0`, `reservation_total≈8` при `admitted≈0`. Доминирует **refusal** (не получают резервацию), не wedge-while-holding. Protected-шов реален в коде, но в этом городе почти не активен.

### E18. Где теряются машины (live-разбивка)

Live-ряд (watch, 14571 сэмплов/~325с; абсолюты завышены частотой рендера ~45/с, **соотношения точны**):

| Фаза | доля от cand_approaching |
|---|---|
| collection выжило (`candidates_built==cand_approaching`) | **100%** (drop_other=0) |
| → упало в coarse | 3.7% |
| **admitted** | **2.9%** |
| **refused_matrix** | **33.8%** ← ДОМИНАНТ |
| yield (красный) | 19.9% |
| refused_capacity | 8.2% |
| force-admits | 0.1% |

**82% тиков → admit=0.** Каскад: frozen 0→26→0, max_stopped 12с→164с→27с (осцилляция, recovery разбивает), при `max_congestion=1` (низкая плотность). В gridlock-окне `yield≈0` (зелёный) но `refused_matrix=2-5`/тик — режет **матрица**.

**Механизм:** машины не теряются в collection, coarse маргинален. Узкое место — точные матрица-отказы: удержанные `active_mask` (Approaching держит точки сразу — девиация Inv8) + `inbox_mask` от заклинивших in-box машин (frozen). Один заклинивший на тайле перекрёстка блокирует конфликтующие въезды, пока не уедет; уехать не может (downstream забит) → каскад. Force-admit и recovery разбивают локально, но допуск хронически ~3%.

---

## 7. F. Пешеходы

Две независимые системы (общая только ось `axis_ns`):

**Пешеход → машина (`ped_mask`):** `PedestrianCrossing{intersection_id, axis_ns}` ставится в `move_walkers` (`agents.rs:347-358`). `seed_ped_masks` (инлайн в арбитре, `arbiter.rs:392-423`) чистит ped_mask и ставит crosswalk-биты: `axis_ns=true` (идёт N/S) → West/East переходы; `false` → North/South. `try_admit` рефузит при `rows_overlap(row, ped_mask)` → `refused_matrix`. Force-admit и coarse (`box_is_clear` включает ped_mask) уважают ped_mask. In-box safety-net обходит try_admit.

**Машина → пешеход (НЕ читает ped_mask):**
- Signalized `ped_can_enter_intersection` (`agents.rs:416-431`): N/S-ход ⟺ `NorthSouthGreen`; E/W ⟺ `EastWestGreen` (параллельно зелёному потоку; walk-фазы нет).
- Uncontrolled `ped_can_enter_uncontrolled` (`agents.rs:433-549`): `is_reserved(id)` (любой holder→false) + min-gap + TTC по 4 подходам. Значения config `(не проверено: pedestrians.ron)`.

Live: `ped_blocked=0` (не узкое место в тестовом городе).

---

## 8. G. Конфиг

**Конфигурируемо (traffic.ron):** `experimental_lanelet_intersections=true`, `drive_on_right=true` (читается арбитром), `max_active_vehicles=1500`, `max_route_plans_per_tick=64`, IDM-параметры (`idm_desired_headway_secs=1.1`, `idm_max_accel_mps2=3.2` — агрессивны «для throughput перекрёстков»). 5 IDM-полей + `tile_meters` — serde-defaults.

**Хардкод (НЕ конфигурируемо):** `ARBITER_FORCE_ADMIT_TICKS=30`, `LANELET_STALL_REROUTE_TICKS=20`, `DOWNSTREAM_LINK_HORIZON_TILES=3` (×3), `EXIT_SLOT_CAP=4`, `STALE_APPROACH_RELEASE_SECS=1.5`, `timeout_secs=6.0` (локальный binding), light-длительности (10/3/4/4с), `RIGHT_ON_RED_TURN_MAX_KMH=15.0`, `STUCK_REROUTE_SECS=60.0`, `STUCK_DESPAWN_SECS=180.0`, `VEHICLE_FROZEN_SECS=30.0`, `capacity_per_lane_tile=2` (производное, все дороги).

---

## 9. Тесты как спецификация (ключевой вывод)

**Инверсия покрытия:** ~22 из 24 тестов admission проверяют **мёртвый legacy-путь** через тест-обёртку `plan_intersection_reservations` (`reservations.rs:697`, без flag-dispatch). Живой арбитр покрывают **только 2 теста** в `lanelet_arbiter.rs` (collision-safety + at-least-one + determinism + tripwire-empty + drain), drain симулируется ручным `set_cursor` (не через `move_vehicles`). Поэтому `cargo test` зелёный (traffic:: 72/0, intersections:: 2/0, lanelet 24/0, **0 ignored**) сосуществует с gridlock: инварианты живого пути (opposite-straights, ped-yield, spillback, RTOR-clear, escape-valve) **не перепроверены** против арбитра.

---

## 10. Расхождения: код vs документы vs git

**Git-«качели»:** `9e9c711` enable (14:36) → `ca89844` disable «gridlocks the real city, max_stopped past 2400s» (19:46) → fixes (2a62318 sidecar, 577d1b1 coarse+valve, cee338a unified+stale) → `2ae7c39` re-enable (HEAD, +3 дня).

| # | Документ | Код/реальность |
|---|---|---|
| D1 | спека/struct «default false»; `traffic.ron:8-13` «DEFAULT OFF» | `traffic.ron:14 = true` (комментарий выше **stale**) |
| D2 | `handoff-arbiter-throughput.md`: «residual to solve, max_stopped unbounded» | residual-fixы залиты, флаг включён — handoff pre-HEAD |
| D3 | спека: `DebugLaneletRouteState`/`DebugLaneletArbitrationState` | реально `DebugLaneletState`/`DebugArbiterLedgerState` |
| D4 | `ring_force_admits` doc «always 0» | nonzero-capable |
| D5 | `gameplay.md`/`architecture.md`/`README` | **ноль упоминаний** lanelet/arbiter |
| D6 | plan: «round-robin counter» | реализован `ApproachFairness` aging |
| D7 | спека: «LaneType autogen enabled» | `autogen_turn_lanes` dead-code, scaffolding |
| D8 | спека: «break_tile_swaps deleted flag-on» | бежит **без run_if** (`traffic.rs:521-523`) |
| D9 | спека Inv5: «proof заменяет valve» | valve жив и срабатывает |
| D10 (Inv4) | «coarse may only REJECT, never ADMIT» | `try_admit_coarse` **ДОПУСКАЕТ** — противоречие |
| D11 (Inv8) | «Approaching holds NO points» | Approaching держит active_mask+slot — **противоположно** (осознанная девиация `reservations.rs:75-80`) |

**Scorecard 11 инвариантов:** реализованы 2,3,11; substrate 6; partial 1,5,7,9,10; **противоречат 4,8**. Два сильнейших claim'а спеки («deadlock-free by construction», «Approaching без точек») — ровно те, что код откатывает.

**Code-vs-comment:** `drop_unresolved_lanelet` doc устарел; `drive.rs:288-291` про «collect/apply ZONE_ALL» описывает мёртвый legacy; `IntersectionCluster.{tiles,aabb_min,aabb_max}` `#[allow(dead_code)]` устарели; `is_red()`/`pos` в lights.rs мёртвы.

---

## 11. Открытые вопросы / непроверенное

- Точный split `refused_matrix` (active vs inbox vs ped vs coarse) — счётчика нет; вывод «доминирует active+inbox» обоснован (frozen 0→26, ped_blocked=0, coarse 3.7%), доли `(не проверено)`.
- Protected-left wedge реален в коде, но live почти не активен (`left_protected_active=0`); на трафике с интенсивными левыми может быть значимее `(не проверено)`.
- Кламп RTOR-скорости — тест не ассертит точный кап `(не проверено)`.
- `uncontrolled_min_gap_tiles`/`uncontrolled_safety_margin_secs` из `pedestrians.ron` не прочитаны.
- Ordering арбитр↔`update_traffic_lights` (same vs next tick demand) не закреплён `(не проверено)`.
- Город не паниковал за ~11 мин (вопреки memory ~5 мин) — recovery удержал; это конкретный прогон.

---

## 12. Методология

- Код: личное чтение crux (arbiter/reservations/drive/state/ordering) + 13 параллельных reader-агентов по секциям A-G + критик.
- Тесты: `cargo test -p simcity_sim traffic:: intersections:: transport::lanelet` — 98 passed, 0 failed, 0 ignored.
- Live: `cargo run` (debug), BRP `127.0.0.1:15702`, watch на `DebugArbiterLedgerState`/`DebugTrafficSnapshot`/`DebugIntersectionSnapshot` (entity 4294966768), 14571 сэмпл за ~325с симуляции тестового города, агрегация суммами и траекторией.

---

## 13. Глубокий разбор: почему ПДД не дореализованы и почему машины выезжают на встречную

### 13.1 Почему ПДД не дореализованы

Не «забыли», а **слоистая история: ранний scaffolding + сознательный отказ при переходе на арбитр.**

**(1) Реалистичный ПДД-модуль остался заглушкой.** `pdd_check.rs` написан под GDD 8.1 («строгий ПДД»), но все 3 функции мёртвые:
- `should_yield_at_uncontrolled_intersection` → хардкод `false` + `// TODO: Реализовать полную логику ПДД` (`pdd_check.rs:34-41`).
- `is_main_road` / `has_right_of_way_obstacle` — реальные однострочники, **ноль не-тестовых вызовов**.
- Модуль-док сам перечисляет недоделанное: помеха справа, главная дорога по ширине, знаки приоритета.

**(2) Нет команды установки знаков.** `GameCommand` (`commands.rs:8-41`) имеет `PlaceTrafficLight`/`RemoveTrafficLight`, но **ни одной команды для знаков**. Единственный writer `assign_intersection_priorities` (`index.rs:297`) захардкожен на `IntersectionPriority::None` для каждого тайла → `StopSign`/`YieldSign`/`MainRoad` некуда взяться в рантайме.

**(3) «Живой, но инертный» конвейер.** Логика стоп-знака существует и протестирована: `check_intersection_priority` (`state.rs`) каждый тик читает маркеры и обрабатывает `==StopSign`, но ветка не срабатывает (writer всегда `None`). Тесты гоняют её, вручную вставляя маркеры (`basic_behavior.rs:364,507`). Половина моста: данные + читатель есть, входа (команды) и продьюсера — нет.

**(4) Арбитр СОЗНАТЕЛЬНО заменил настоящий ПДД на детерминированное упрощение.** Ключевая причина. `arbiter.rs:233-237`:
> «True pairwise помеха-справа at a simultaneous-arrival 4-way is undefined in ПДД and a pairwise yield can gridlock a 3-way cycle; a fixed total-order precedence is by-construction deadlock-free… The geometric matrix still guarantees collision-safety.»

Помеху справа намеренно выкинули (попарная уступка зацикливается), заменив фиксированным `dir_precedence` (N>E>S>W, `arbiter.rs:238-245`) + шириной дороги + геометрической матрицей. Размен: **детерминизм и deadlock-freeness вместо реалистичности ПДД**.

**Вывод Q1:** ПДД-знаки — брошенное scaffolding старого направления; арбитр их не читает (не импортирует ни `pdd_check`, ни `IntersectionPriority`), помеху справа заменил deadlock-безопасной заглушкой. Не дореализовали, потому что курс сменился на «корректность по построению через конфликт-матрицу», а не «агенты, соблюдающие ПДД».

### 13.2 Почему машины выезжают на встречную полосу

Это **конкретно левые повороты**. Прямые/правые безопасны по построению; ломаются левые.

**Цепочка (всё подтверждено):**
```
1. autogen_turn_lanes (turn_lanes.rs:174) — ЕДИНСТВЕННЫЙ writer LaneType::LeftTurnOnly —
   МЁРТВ: вызывается только из transport/tests.rs (D7). ⇒ в рантайме ВСЕ полосы = Regular.
2. lane_allows_maneuver(Regular, LeftTurn, drive_on_right=true)  build.rs:40-44:
      Straight→true ; RightTurn→true ; LeftTurn → !drive_on_right = FALSE
   ⇒ для левого lanelet НЕ строится (build.rs:450 continue). LeftTurnOnly-полос нет (шаг 1).
   ⇒ В ГРАФЕ НЕТ НИ ОДНОГО LANELET'А ЛЕВОГО ПОВОРОТА.
3. Левая машина: sidecar пуст/мимо → resolve_lanelet_fallback не находит (entry→left-exit) пары
   → None → COARSE (arbiter.rs:864-868): coarse=true, internal_path=[], maneuver=Straight (мислейбл).
4. Coarse едет через бокс по СЫРОМУ маршруту без internal_path и без дисциплины полос.
5. Коррекция «левый ОБЯЗАН на правую полосу, НЕ на встречную»
   (build_left_turn_connector_correct / find_correct_exit_lane / ensure_correct_exit_lane,
    connectors.rs:532,556-557,610-716) живёт в LEGACY-коннекторе — ОТКЛЮЧЁН при flag-on.
   ⇒ ЛЕВЫЙ ПОВОРОТ ВЫЕЗЖАЕТ НА ВСТРЕЧНУЮ.
```

**Почему прямые/правые НЕ выезжают на встречную:** lanelet-build классифицирует exit-полосу по направлению — тайл является выходом только если `road.dir` указывает **прочь** от бокса (`cluster_tiles.contains(&back)`, `build.rs:419-421`); встречная полоса указывает внутрь → это entry, не exit. Значит resolved lanelet (прямой/правый) физически не может вывести на встречную (направление проверено по построению). Дыра только там, где resolved-lanelet'а нет → coarse → проверка обходится.

**Live-корроборация:** `reservation_left=0` и `left_protected_active=0` весь прогон. Следствие механизма: левые идут как coarse `maneuver=Straight` → (а) считаются прямыми (отсюда `reservation_left=0`), (б) не выставляют `LeftTurnDemand` (он требует `maneuver==LeftTurn`) → protected-left-фаза не актуируется (`left_protected_active=0`). То есть Q2 и «мёртвая protected-left фаза» из E17 — один корень: **левого поворота как класса в lanelet-модели не существует.**

**Вторичные источники встречки:** `break_tile_swaps` бежит при flag-on без `run_if` (D8) и делает боковые перестановки для разбивки заклинивания — может сдвинуть машину на встречную (replanning внутри флаг-aware `swap_break.rs:262`, сам swap-breaking безусловен); любая coarse-машина (3.7% live), если сырой маршрут пришёл из road-A* fallback.

### 13.3 Связь двух вопросов

Оба растут из одного решения — переключиться на lanelet-арбитр «корректный по построению», не достроив две вещи: **(1)** реалистичный ПДД-слой (заброшен как scaffolding), **(2)** автогенерацию поворотных полос `LaneType` (`autogen_turn_lanes` не подключён). Без (2) левых lanelet'ов нет → левые валятся в coarse → встречка + задушенный throughput + неработающая protected-left фаза. То есть «недоделанный ПДД» и «выезд на встречную» — две грани одной незавершённой миграции на lanelet-модель.
