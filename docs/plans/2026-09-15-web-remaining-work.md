# Что осталось перенести из Rust в TS-порт — 2026-09-15

> Документ длиннее 250 строк (около 300): у каждой единицы есть пути и критерии, без них работу не разложить параллельно. Здесь то, что из Rust-игры (тег `rust-final` = `edad8fb`) ещё не перенесено в TS-порт `main` @ `4bd2094`, и порядок работ: 26 единиц в пяти этапах плюс девять открытых вопросов. Программа — `docs/plans/2026-09-11-ts-threejs-migration-plan.md`. Хвосты этапов 3½ и 4 даны только ссылкой.

**Как сверялось.** Rust читался из дерева `rust-final`. `git diff --stat rust-final HEAD -- crates src assets` показывает отличия только в `Cargo.toml` и в двух строках `transport/lanelet/{mod,pathfinding}.rs`, так что пути ниже совпадают с `rust-final:<путь>`. Портирован ли тест, решал поиск его имени в camelCase словом по `packages/` и `e2e/`, всего 638 имён. Тест, который при порте переименовали, этот поиск считает непортированным; такие случаи оговорены. «Нет в TS» подтверждено `rg` по `packages/` и `e2e/`, команда приведена в строке.

Размер: S — один коммит с тестами, M — 2–4 коммита, L — под-этап со своими воротами. Общие ворота каждого этапа: `bun run typecheck && bun run lint && bun run test && bun run e2e` (Chromium). Ниже перечислены только добавочные.

## Объём

- Строки программы 5 (раздел «Встраивание, после 3½» в `2026-09-14-web-phase-5-render-math.md`), 6 и 7.
- Геймплей, который появился в Rust после старта программы: `rust-final:docs/plans/2026-09-09-gameplay-goals.md`, `rust-final:docs/plans/2026-09-10-f1…f4-*.md`, 109 коммитов `git log rust-final --since=2026-09-08`.
- Вне объёма:
  - закрытие этапа 4 — задача `dev-stage4-close`, раздел «Ворота» в `2026-09-14-web-phase-4-services.md`;
  - хвосты 3½: жители, которые работают за городом, и худший тик мегаполиса 221–315 мс (`2026-09-12-web-phase-3_5-scale.md`, «Хвосты»);
  - цели Ф5–Ф6 из `rust-final:docs/plans/2026-09-09-gameplay-goals.md` §5 — в Rust их не было;
  - инспектор `ui/building_popup.rs` — dev-панель egui в `DevUiPlugin` (`crates/simcity_frontend/src/game/ui/mod.rs:136-160`).

## Геймплей Rust после 2026-09-08 против TS

| Rust: коммиты и тесты | В TS | Единица |
|---|---|---|
| Бюджет: журнал, налоги по зонам и классам, содержание, финансирование, займы (`fc1cbbf`…`5528d6d`, `economy.rs` 18) | симуляция есть: `packages/sim/src/economy/economy.ts`, 18/18 | U6, Q4, P1 |
| Экран бюджета `d4a81c9` (`hud/budget_panel.rs` 5) | нет | U6 |
| Оболочка UI Ф1 `485cc0b`…`3135608` (`hud/*` 50) | нет, `Hud.tsx` — одна шапка | U1–U8 |
| Коммуналка и мощность станций `936996a`, `e18cb0d` (`utilities.rs` 8) | есть, 8/8 | слои — U4 |
| Плотность и классы `11e9854`, `105a91b`, `f541afe` | есть: `blockers.rs` 16/16, `buildings/tests.rs` 17/21 (4 заменены в 3½) | кнопки — U2 |
| Поля города `74c084c`, `faf482c` (`city_fields.rs` 9, `map/data_map.rs` 11) | поля 9/9; легенды и слои 0/11 | U4 |
| Школа, университет, парк `4f03a09`, `9ceb273` (`civic_coverage.rs` 5) | есть, 5/5 | палитра — U2 |
| Вехи `2256cd9` (`milestones.rs` 2) | нет | S1 |
| Советник `3ddac25`, `9965ea2` (`advisor.rs` 11) | нет | S3, U7 |
| Лента `c5aeb25`, `6e20a34`, `09952b4` (`notifications.rs` 9) | `notifications.ts` есть, тестов 0/9 | S2, U5 |
| observe-инструменты `e9e1fb3`, `1b041a1`, `9a6c725`, `71a3ded` (`live/observe.rs` 21) | в `__sim` нет этих разделов | E3 |
| Пауза — не новая игра `3cfc3f1` | есть: `pauseRoundTripKeepsCity`, `packages/sim/test/sim.test.ts:81` | — |
| Ф0: одностороннее движение в UI, гейт хоткеев по фокусу, старт с меню `1163880` | меню есть (`Hud.tsx:103`); хоткеев инструментов и гейта нет | U2, U8 |
| Визуал 09-09: ACES/SSAO/виньетка `8f9d1a4`, атлас `379667c`, камера `c6acbbf`, уличная мебель `0f74425` | математика этапа 5 есть, в кадре её нет | R1–R4 |
| Перф-режим `bc777fe`, `51c1780` (`perf_run.rs` 8), present mode (`src/main.rs` 1) | его заменяют `bun run bench` и fps в `desktop:e2e` | не переносится |

## Этап 6a — прогрессия в симуляции (`packages/sim`)

Ворота: портированные тесты зелёные, `fingerprintCoversEveryStateField` зелёный, в `bun run bench metropolis` у новых систем записан p99 по системам.

**S1. Вехи** · S · дизайнер не нужен · зависит: —
- Rust: `crates/simcity_sim/src/game/milestones.rs` (223 строки, 2 теста). Ещё тесты: `milestone_a_locked_school_is_refused_by_the_placement_command` и `milestone_a_new_map_starts_its_milestones_over` (`map/tests.rs`), `milestone_locked_building_preview_says_when_it_unlocks` (`map/preview.rs`), `milestone_loading_the_test_city_starts_milestones_over` (`crates/simcity_data/src/game/mod.rs`).
- TS: нет. `rg -i milestone packages e2e` находит только комментарии в `packages/render/src/toolPreview.ts:3`, `packages/render/test/toolPreview.test.ts:3`, `packages/sim/test/map/apply.test.ts:2`.
- Критерии: четыре теста из `simcity_sim` по именам (тест тестового города — в S4); при населении 249 `PlaceBuilding` школы отказан, при 250 проходит; достигнутая веха даёт одну строку ленты вида `Achievement`; вехи входят в секцию фингерпринта.
- Пути: `packages/sim/src/milestones.ts` (новый), `map/apply.ts`, `world.ts`, `fingerprint.ts`, `schedule.ts`, `packages/sim/test/milestones.test.ts`, `packages/render/src/toolPreview.ts` и его тест.

**S2. Лента событий: тесты** · S · нет · —
- Rust: `crates/simcity_sim/src/game/notifications.rs` (9 тестов: `notification_dedup_*` 7, `advisor_feed_*` 2), `notification_dedup_every_construction_is_the_same_line` (`buildings/growth.rs`), `notification_dedup_every_upgrade_is_the_same_line` (`buildings/upgrade.rs`).
- TS: реализация есть — `packages/sim/src/notifications.ts` со счётом повторов и `HISTORY_LINES = 30`. Тестов нет: `rg -l 'Notifications|HISTORY_LINES' packages/sim/test packages/bridge/test` ничего не находит.
- Критерии: 11 тестов по именам. При расхождении с Rust правится код, пин не ослабляется.
- Пути: `packages/sim/test/notifications.test.ts` (новый), при необходимости `notifications.ts`.

**S3. Советник** · M · нет · S1, S2
- Rust: `crates/simcity_sim/src/game/advisor.rs` (894 строки, 11 тестов `advisor_*`); пересчёт раз в игровой час.
- TS: нет, `rg -i -w advisor packages e2e` пусто.
- Критерии: 11 тестов; система в `FIXED_UPDATE` с `everyGameNs`, равным игровому часу; в разбивке bench мегаполиса у советника записан p99.
- Пути: `packages/sim/src/advisor.ts` (новый), `world.ts`, `schedule.ts`, `packages/sim/test/advisor.test.ts`.

**S4. Команды-заглушки и тестовый город** · M · нет · S1 (общий `apply.ts`)
- Rust: светофоры — `crates/simcity_sim/src/game/intersections/lights.rs:157`. `LoadTestCity` — `crates/simcity_data/src/game/mod.rs:157` и `test_city.rs` (1 тест). В том же `mod.rs` 9 тестов: `load_test_city_*` 4, `demo_bus_*` 2, `milestone_loading_…`, `no_mass_freeze_by_day_18`, `utility_network_test_city_supplies_every_zoned_block_with_a_road`.
- TS: кодек команды разбирает, но в `packages/sim/src/map/apply.ts:323-329` на `DumpSaveContract`, `SaveGame`, `LoadGame`, `LoadTestCity`, `PlaceTrafficLight` и `RemoveTrafficLight` стоит `break`. Тестовый город существует только как фикстура `packages/sim/test/testCity.ts`.
- Критерии: светофор по команде ставится на перекрёсток и снимается с него; вне перекрёстка — отказ, как в `previewToolAt`. `LoadTestCity` строит город и очищает историю правок (`loadTestCityClearsCommandHistory`). Тесты `mod.rs`, которые применимы к TS, переносятся по именам; остальные получают в плане строку «не переносится» с причиной.
- Пути: `packages/sim/src/map/apply.ts`, `intersections/index.ts`, `packages/sim/src/scenarios/testCity.ts` (фикстура переезжает из `test/`), тесты.

## Этап 6b — сейвы, конфиги, сценарии

Ворота: сейв и загрузка в новый мир дают тот же `fingerprint` на «Живом городе» после 3 000 тиков и на мегаполисе 256 после 1 200 тиков; каждый сценарий меню открывается в e2e без ошибок систем.

**P1. Сейв v1** · L · нет · S1 (поле вех), Q2
- Rust: `crates/simcity_data/src/game/persistence.rs` (1 037 строк, 3 теста) и контракт `persistence_contract.rs:126` `SaveGameV3`. В нём seed, map, city, buildings, citizens, next_citizen_id, service_stations, emergency_stats, traffic_light_tiles, tax_rates, service_funding, loans, milestones. Ещё три теста сейва в `config_loader.rs`: `savegame_v3_roundtrips_through_ron`, `savegame_v3_old_save_compat_missing_traffic_lights`, `zone_density_survives_the_save_and_an_old_save_zones_at_medium`.
- TS: нет, `apply.ts:324-325`. Мир TS шире `SaveGameV3`: жители в SoA, очереди мезо, парковки, регион, флот — все они есть в секциях `fingerprintSections`.
- Критерии:
  - ворота этапа;
  - тест, что восстанавливается каждая секция `fingerprintSections`: новая секция без сейва роняет его так же, как `fingerprintCoversEveryStateField`;
  - zod-схема отвергает битый файл с понятной ошибкой, мир при этом не меняется;
  - в сейве есть поле версии;
  - смысл 6 Rust-тестов перенесён, имена сохранены.
- Пути: `packages/sim/src/save/` (новый), `packages/sim/test/save/`, запросы save/load в `packages/bridge/src/protocol.ts` и `host.ts`.

**P2. Конфиги** · S–M · нет · Q5
- Rust: `crates/simcity_data/src/game/config_loader.rs` грузит 9 файлов `assets/config/*.ron` и `assets/scenarios/scenarios.ron`, тест `ron_assets_parse`.
- TS: загрузчика нет, значения — константы. Это `packages/render/src/renderConfig.ts` (его тест читает сами `.ron`), `packages/sim/src/economy/economy.ts`, `traffic/config.ts`, `pedestrians/graph.ts`, `transport/pathfinding.ts`. На момент сверки `assets/config/` в рабочем дереве `dev-rust-removal` на месте.
- Критерии зависят от ответа на Q5. Вариант (a): загрузчик плюс zod и тест «каждый `.ron` разбирается и совпадает с константой». Вариант (c): `.ron` удалены, тесты паритета заменены пинами констант.
- Пути: `assets/config/`, конфиги в `packages/{sim,render}/src/`, их тесты.

**P3. Сценарии: каталог, цели, сид** · M · нет · Q7, U0 (общий `host.ts`)
- Rust: `crates/simcity_data/src/game/scenarios.rs` — стартовые деньги и день, начальные команды, цели `PopulationAtLeast` / `MoneyAtLeast` / `HappinessAtLeast`, прогресс; 1 тест `a_scenario_starts_on_its_own_seed_unless_one_is_given`. В `assets/scenarios/scenarios.ron` два сценария: `sandbox` и `starter` («Starter Town»: население 50, счастье 0,6).
- TS: в `packages/bridge/src/scenarios.ts` пять сценариев-сборщиков: `city`, `livingCity`, `metropolis`, `signalizedCross`, `signalizedCross4`. Целей и прогресса нет, `rg -i 'objective|startingMoney|starting_money' packages` пусто.
- Критерии: тест сида; цели считаются в симуляции и видны в снимке; e2e «каждый сценарий открывается» — ворота программы «все сценарии грузятся».
- Пути: `packages/sim/src/scenarios/catalog.ts` (новый), `packages/bridge/src/scenarios.ts`, `host.ts`, `e2e/scenarios.spec.ts` (новый).

## Этап 6c — HUD игрока (`packages/ui`, `packages/bridge`)

Ворота: у каждой панели есть e2e в Chromium на кликах Playwright. Без `?debug=1` в DOM нет FPS, тика и строк трафика — это порт `dev_ui_gated_*`, 5 тестов.

**U0. Снимок и запросы HUD** · M · нет · S1–S3 (поля добавляются по мере готовности)
- TS: в снимке нет бюджета, ставок, займов, ленты, вех и советника: `rg -i 'tax|funding|loan|toast|history|advisor|milestone' packages/bridge/src packages/ui/src packages/app/src` пусто.
- Критерии: тест хоста показывает, что снимок несёт отчёт текущего и прошлого месяца, ставки, финансирование, займы, тосты и историю, вехи и первые проблемы советника, а диагноз и превью клетки приходят по запросу. Размер снимка замерен на мегаполисе и не растёт с числом жителей.
- Пути: `packages/bridge/src/protocol.ts`, `host.ts`, `packages/bridge/test/host.test.ts`, `packages/ui/src/store.ts`.

**U1. Каркас: токены, стекло, HUD-бар** · M · дизайнер нужен (визуальный язык, D11) · U0
- Rust (пути от `crates/simcity_frontend/src/game/`): `hud/theme.rs` (3 теста контраста и прозрачности), `hud/glass.rs` и `glass.wgsl`, `hud/hud_bar.rs` (5), `hud/pointer.rs` (3), `ui/dev_ui_gate.rs` (2), `ui/window_title.rs` (1).
- TS: `packages/ui/src/Hud.tsx:126-163` — одна шапка: рядом с казной тик, FPS и две строки dev-статистики.
- Критерии: деньги с разрядами, день и час, население; скорость ставится одной кнопкой. Контраст текста на токенах не ниже, чем в `ui_shell_body_text_is_readable_on_glass_over_any_world`, над светлым и тёмным миром (юнит-тест). Клик по панели не доходит до карты.
- Пути: `packages/ui/src/theme.ts` и `HudBar.tsx` (новые), `Hud.tsx`, `packages/app/src/styles.css`, `e2e/hud.spec.ts` (новый).

**U2. Палитра инструментов и рисование по карте** · L · дизайнер нужен (иконки) · U1, S1
- Rust: `hud/tool_palette.rs` (8). В `map/tests.rs`: хоткеи и гейт фокуса `build_mode_hotkey_*`, `one_way_hotkey_*`, `undo_hotkey_is_ignored_while_keyboard_is_captured` (5), `map_paint_stands_down_*` (2), `hovered_tile_*` (2).
- TS: в интерфейсе инструментов нет, `rg 'SetZone|SetRoad|PlaceBuilding|EraseTile|tool' packages/app/src packages/ui/src` пусто. `packages/render/src/controls.ts:33-36` слушает pointer и wheel, но команд мира не шлёт (`rg 'cmd|request'` пусто). Готовые части: `roadSegmentCommands` (`packages/sim/src/map/roadTool.ts:70`) и `ToolMode` (`packages/render/src/toolPreview.ts:20`).
- Критерии (e2e):
  - кнопка и хоткей выбирают инструмент;
  - после мазка дорогой `__sim.tile` показывает дорогу;
  - зона красится с плотностью, одностороннее движение включается;
  - кнопка, закрытая вехой, выключена и подписана;
  - ввод в поле не переключает инструмент;
  - Ctrl+Z отменяет правку;
  - клик по HUD не красит карту.
- Пути: `packages/ui/src/ToolPalette.tsx` (новый), `packages/render/src/controls.ts`, `packages/app/src/main.tsx`, `e2e/tools.spec.ts` (новый).

**U3. Подсказка у клетки** · M · нет · U2, U0
- Rust: `hud/tile_tooltip.rs` (5).
- TS: `previewToolAt` есть (`toolPreview.ts:102`, 8 из 9 тестов), но импортируется только из `packages/render/src/index.ts:19` и на экран не выводится.
- Критерии: при наведении с инструментом видны цена, эффект, вердикт и радиус; у зоны, которая не растёт, — причина из `packages/sim/src/buildings/blockers.ts`; над HUD и в режиме Inspect подсказки нет.
- Пути: `packages/ui/src/TileTooltip.tsx` (новый), `e2e/tools.spec.ts` (после U2).

**U4. Карты данных** · L · дизайнер нужен (легенда) · U0, U1, R2 (общий `debugRenderer.ts`)
- Rust: `crates/simcity_sim/src/game/map/data_map.rs` (922 строки, 11 тестов легенд, шкал и чтений), `hud/data_map_panel.rs` (5).
- TS: есть `OVERLAY_MODES` (`packages/render/src/overlays.ts`) и `overlayRepaint.ts`. Кадр рисует только отладочный слой лейнлетов (`debugRenderer.ts:255`, `setOverlay(DebugOverlayReply)`). Легенд нет: `rg -i 'legend|reading' packages/render/src/overlays.ts` пусто.
- Критерии: 11 тестов `data_map.rs`. В e2e включённый слой красит тайл цветом легенды; отладочный рендер выводит цвета без цветового менеджмента, поэтому цвет читается со скриншота. Значение под курсором показано числом. Пока открыта карта данных, свет полуденный и виньетки нет (`dayNight.ts`, `vignette.ts`).
- Пути: `packages/render/src/dataMap.ts` (новый), `mapChunks.ts`, `debugRenderer.ts`, `packages/ui/src/DataMapPanel.tsx` (новый), слой полей в `protocol.ts`.

**U5. Тосты** · S · нет · S2, U0, U1
- Rust: `hud/toasts.rs` (7).
- TS: тосты копятся в `Notifications` (`packages/sim/src/notifications.ts:88`), но до интерфейса не доходят.
- Критерии: восемь одинаковых событий дают одну строку «×8»; клик по строке ведёт камеру к месту события (центр `__sim.camera()` у тайла); строки истекают.
- Пути: `packages/ui/src/Toasts.tsx` (новый), `e2e/hud.spec.ts` (после U1).

**U6. Экран бюджета** · M · дизайнер нужен · U0, U1, Q4
- Rust: `hud/budget_panel.rs` (734 строки, 5 тестов `ui_shell_budget_*`).
- TS: модель есть — `TaxRates`, `ServiceFunding`, `Loans`, `BudgetLedger` в `packages/sim/src/economy/economy.ts`. Канала правки нет: в `GameCommand` (`packages/sim/src/commands.ts:58-69`) нет ни ставок, ни займов, как нет их и в `crates/simcity_core/src/game/commands.rs`.
- Критерии: ставка меняется на ±1 пункт, финансирование на ±10 %, займ кладёт деньги в казну; строки месяца на экране в сумме равны изменению казны; два прогона с одинаковыми правками дают одинаковый фингерпринт.
- Пути: `packages/ui/src/BudgetPanel.tsx` (новый); остальное по ответу на Q4 — `commands.ts`, `commandCodec.ts`, `map/apply.ts` или `protocol.ts`.

**U7. Панель советника** · S · нет · S3, U0, U1
- Rust: `hud/advisor_panel.rs` (3). TS: нет (см. S3).
- Критерии: худшая проблема крупно и ещё две ниже; на здоровом городе — «ничего не требует внимания»; последние события ленты с днём.
- Пути: `packages/ui/src/AdvisorPanel.tsx` (новый).

**U8. Стартовый экран** · S · нет · S4, P3, U1
- Rust: `hud/start_screen.rs` (6), `menu_first_startup_waits_in_the_main_menu_on_an_empty_map` (`crates/simcity_data/src/game/headless_sim.rs`).
- TS: меню в `Hud.tsx:103-121` — кнопка «Новая игра» и ссылки на сценарии. Нет новой карты на свежем сиде и тестового города.
- Критерии: новая карта на новом сиде; тестовый город из меню; все сценарии в списке; в меню нет dev-элементов.
- Пути: `packages/ui/src/StartScreen.tsx` (новый), `Hud.tsx`.

## Этап 5 — сцена (`packages/render`)

Ворота: снимки Chromium, 4 ракурса × 2 времени суток — по ответу на Q1; `theTestCityHoldsItsFrameRate` (`packages/desktop/e2e/shell.spec.ts`) зелёный.

Математика этапа портирована, но в кадр не встроена. `atlas`, `dayNight`, `vignette`, `renderSettings`, `cameraProjection`, `toolPreview` и `overlayRepaint` экспортируются только из `packages/render/src/index.ts:10-19`, `debugRenderer.ts` их не импортирует. Камера — `THREE.OrthographicCamera` (`debugRenderer.ts:98`).

**R1. Камера: перспектива и орто, пикинг** · M · нет · —
- Rust: `crates/simcity_frontend/src/game/camera_projection.rs` (7, портированы). В `map/tests.rs`: `picking_round_trips_in_both_projections`, `the_frame_centre_picks_the_same_tile_in_both_projections`.
- TS: только орто; `rg PerspectiveCamera packages/render/src` находит его лишь в `cameraProjection.ts`.
- Критерии: 2 теста пикинга; в e2e зум через `orthoAboveZoom` меняет видимую высоту не больше чем на 1 %; `__sim.pickTile` по центру кадра одинаков в обеих проекциях.
- Пути: `packages/render/src/camera.ts`, `picking.ts`, `debugRenderer.ts`.

**R2. Инстансированный псевдо-3D и атлас на GPU** · L · нет: визуальная цель утверждена в `rust-final:docs/plans/2026-09-09-visual-goal.md` · R1
- Rust: `crates/simcity_sim/src/game/render_primitives.rs`, `atlas.rs`, `buildings/visual.rs`. Из 6 тестов `visual.rs` по имени не найден ни один. Высота и цвет портированы в `buildingLook.ts` (план этапа 5), остальные тесты про сцену: `mesh_cache_dedups_same_shape`, `roof_gravel_tiles_instead_of_stretching_over_the_whole_roof`, `repeats_follow_the_surface_size_and_stay_within_the_cap`, `service_building_gets_roof_glyph`, `tint_applies_and_clears`.
- TS: карта — плоские чанки (`mapChunks.ts`), машины — `InstancedMesh` с `MeshBasicMaterial` (`debugRenderer.ts:499`).
- Критерии:
  - здания, машины и человечки рисуются через `InstancedMesh` с материалами `RenderPrimitives`;
  - атлас — `DataTexture` с мипами по ячейкам и узлом `mapCellUv`; на крупном снимке соседние ячейки на дальнем мипе не протекают;
  - 5 сценовых тестов `visual.rs`;
  - число draw calls в `renderStats` на тестовом городе записано и не растёт с числом зданий.
- Пути: `packages/render/src/scene/` (новый), `debugRenderer.ts`.

**R3. Пост-обработка и свет** · L · нет · R2, Q8
- Rust: `crates/simcity_frontend/src/game/render_settings.rs`, `vignette.rs`, `crates/simcity_sim/src/game/day_night.rs` — их тесты портированы.
- TS: `resolveRenderSettings` есть, в кадр не подключён.
- Критерии: тонмаппинг, bloom, GTAO, FXAA/MSAA, цветокоррекция, виньетка и каскадные тени идут по `renderSettings.ts`; ночью по часам мира светятся окна и вывески; снимки полудня и полуночи различаются средней яркостью; выключенный эффект не даёт прохода в графе.
- Пути: `packages/render/src/scene/post.ts`, `scene/lighting.ts`.

**R4. Уличная мебель** · M · нет · функции — без зависимостей, сцена — после R2
- Rust: `crates/simcity_sim/src/game/map/props.rs` (191 строка), `props_render.rs` (301), `crates/simcity_core/src/game/props_config.rs`, `assets/config/props.ron`. В `map/tests.rs` 6 тестов: `a_lamp_stands_on_the_kerb_and_never_mid_carriageway`, `lamps_keep_the_configured_spacing`, `switching_lamps_off_in_the_config_leaves_the_street_bare`, `parked_cars_draw_from_a_small_fixed_palette`, `shop_furniture_needs_a_shop_and_takes_that_from_the_caller`, `a_roll_is_stable_for_a_tile_and_spread_across_the_map`.
- TS: нет. `packages/render/src/lamps.ts` — сигналы светофора (`lampSignal`), а не фонари. `rg -i 'wire|awning|streetFurniture|props' packages/render/src packages/sim/src` находит только `renderConfig.ts` и `dayNight.ts`.
- Критерии: 6 тестов на чистых функциях; на снимке тестового города фонари, провода, припаркованные машины, вывески, навесы и баки.
- Пути: `packages/render/src/props.ts` (новый), `packages/render/test/props.test.ts`; сцена — после R2.

**R5. Скриншотные ворота** · S · нет · R1–R4, Q1
- Критерии: 4 ракурса × 2 времени суток в двух прогонах Chromium, сравнение по ответу на Q1.
- Пути: `e2e/render.spec.ts`, `e2e/fixtures/`.

## Этап 7 — хвосты упаковки (`packages/desktop`, `packages/app`)

**E1. Файловые сейвы** · M · нет · P1, Q3
- Rust: `persistence.rs:63-69`, файл `saves/slot{n}.ron`.
- TS: нет. В `2026-09-14-web-phase-7-shell.md`, «Зависимости и отложенное», файловые сейвы ждут сейвов v1; в Electron это `ipcMain` с выбором каталога и мост в preload.
- Критерии: `desktop:e2e` с `SIMCITY_TEST_WINDOW=1` сохраняет во временный каталог без диалога на экране и загружает обратно, фингерпринт равен; preload добавляет в `window.simcityDesktop` только save и load.
- Пути: `packages/desktop/src/main.ts`, `preload.ts`, `packages/desktop/e2e/shell.spec.ts`, `packages/app/src/`.

**E2. `__sim` в релизе** · S · нет · Q6
- TS: `installSimApi` вызывается без условия (`packages/app/src/main.tsx:36`), и на нём держится `desktop:e2e` (`packages/desktop/e2e/shell.spec.ts:19-80`).
- Критерии зависят от ответа на Q6. Для варианта (a): в `app.asar` релизной сборки нет строки `__sim`, а `desktop:e2e` зелёный на тестовой сборке.
- Пути: `packages/app/src/main.tsx`, `packages/app/vite.config.ts`, `packages/desktop/package.json`.

**E3. `live/*` как Playwright-хелперы, навык `simcity-live`** · M · нет · U0, S1–S3
- Rust: в `crates/simcity_debug/src/game/live/` 94 теста: `capture.rs` 22, `observe.rs` 21, `input.rs` 18, `control.rs` 13, `agent_tools.rs` 8, `runtime.rs` 7, `stats.rs` 5. Там же, в `map/tests.rs`, имена оверлеев и скоростей для BRP: `every_overlay_the_toolbar_offers_can_be_named`, `every_speed_the_toolbar_offers_can_be_named`, `names_are_forgiving_about_case_and_spacing_but_not_about_nonsense`, `city_fields_overlays_can_be_named`.
- TS:
  - `__sim` (`packages/app/src/simApi.ts:31-70`) закрывает шаг, скорость, команды, камеру, пикинг, сценарий и сбой системы;
  - часы не выставляются: `rg -i "setClock|setHour|timeOfDay|'hour'" packages/bridge/src/protocol.ts packages/bridge/src/host.ts` пусто;
  - разделов observe нет: бюджет, советник, вехи, поля, снабжение, покрытие, превью клетки, здания области;
  - каталога `e2e/helpers` нет;
  - навыка в дереве нет: `rust-final:.claude/skills/simcity-live/SKILL.md` описывал `cargo run` и BRP (строки 8 и 25).
- Критерии: `e2e/helpers/live.ts` с `observe(sections)`, `setClock(hour)`, `capture({ ui })`; на каждый смысл `observe.rs` и `control.rs` — e2e-тест хелпера; навык написан заново на `bun run dev`, `desktop:e2e` и `__sim`. `agent_tools.rs`, `runtime.rs` и `stats.rs` описывают каталог BRP, порт и режим окна; аналога в TS у них нет, они не переносятся.
- Пути: `e2e/helpers/` (новый), `packages/app/src/simApi.ts`, `packages/bridge/src/protocol.ts`, `.claude/skills/simcity-live/SKILL.md` (новый).

**E4. Иконка и фьюзы Electron, перемер обфускации** · S · дизайнер нужен (иконка) · —
- TS: иконка стандартная; фьюзы не заданы, обфускацию на Electron не перемеряли (план этапа 7, «Зависимости и отложенное»).
- Критерии: у `SimCity.app` своя иконка; выбранный набор фьюзов прочитан с собранного бинарника; числа `desktop:build:obfuscated` с `desktop:e2e` записаны в план.
- Пути: `packages/desktop/package.json`, `packages/desktop/build/` (новый).

**E5. `.exe`, подпись, нотаризация** · M · нет · учётные данные пользователя, Q9
- Подпись и нотаризация macOS требуют Apple Developer ID пользователя, подпись Windows — его сертификат. Можно ли собрать `.exe` на macOS arm64 — Q9.
- Критерии: `.exe` собирается и на Windows доходит до `__sim.ready`; `spctl -a -vv` для `.app` отвечает accepted, Notarized Developer ID.
- Пути: `packages/desktop/package.json`, `.github/workflows/`.

## Непортированные тесты, не вошедшие в единицы

| Rust | Почему не работа этого плана |
|---|---|
| `simcity_sim/src/game/mod.rs` 7, `determinism.rs` 2 из 3, `soak.rs` 2, `debug_world.rs` 5, `perf_run.rs` 8, `src/main.rs` 1 | пины планировщика Bevy, soak и перф-режим: программа (примечание к таблице этапов) заменила их CI-проверками этапа 0 и `bench` |
| `buildings/tests.rs`: `building_calculate_construction_days_scales_with_area`, `calculate_parking_spots_*` 3 | заменены стройкой в часах (3½a) и вместимостью парковок (3½b) |
| `employment.rs`: `unreachable_cache_*` 4 | кэш удалён вместе с тестами в 3½b |
| `traffic/stuck.rs`: `wedged_enroute_service_vehicle_abandons_mission_and_returns_home` | этап 4, задача `dev-stage4-close` |
| `camera_projection.rs`: `the_orthographic_side_frames_what_bevy_frames` | портирован как `theOrthographicSideFramesWhatThreeFrames` (план этапа 5) |
| `intersection/reservations.rs` 2, `tests/lanelet_arbiter.rs` 1, `lanelet/conflict.rs` 1, `lane_graph.rs` 2, `traffic/config.rs` 1, `route_oncoming_pins.rs` 1, `citizens.rs` 1 | этапы 1–3: по имени не найдены, могли быть переименованы — проверить владельцу этапа |

## Общие пути и порядок

Файлы, которые правит больше одной единицы; по ним работа идёт последовательно:
- `packages/sim/src/map/apply.ts`, `world.ts`, `schedule.ts`, `fingerprint.ts`: S1 → S4 → S3. P1 секции только читает.
- `packages/bridge/src/protocol.ts`, `host.ts`: U0 → P1 → P3 → E3; U4 и U6 добавляют свои поля после U0.
- `packages/ui/src/Hud.tsx`, `store.ts`: U1 первым. U2–U8 — отдельные компоненты, в `Hud.tsx` подключаются по одному.
- `packages/render/src/debugRenderer.ts`: R1 → R2 → R3 → сцена R4 → U4.
- `packages/app/src/main.tsx`: U2 → E2. `packages/desktop/`: E1, E4, E5 по очереди.

Порядок волн:
1. S1, S2, R1, функции R4, E4 — без общих путей.
2. S4 и S3, U0, U1, R2; P2 после ответа на Q5.
3. P1 (после S1), U2, U5, U6, U8, R3.
4. P3, U3, U7, U4 (после R2), E1 (после P1).
5. E3 (после U0 и S3), R5, E2 по Q6, E5 по учётным данным.

## Открытые вопросы

1. **Q1 · user · эталон скриншотных ворот этапа 5.** Программа сравнивает с Rust-эталоном, но Rust больше не запускается.
   - (a) Эталоном становятся TS-снимки, принятые пользователем; дальше diff двух прогонов и против принятых не выше назначенного порога.
   - (b) Сравнение с замороженными кадрами Rust `rust-final:docs/plans/perf/2026-09-10-f3-s9/*.png` и `rust-final:docs/plans/perf/2026-09-10-f4-s7/*.png` — там другие ракурсы и UI в кадре.
   - (c) Только приёмка глазами по `rust-final:docs/plans/2026-09-09-visual-goal.md`.

   Рекомендация (a): это единственный повторяемый вариант. От ответа зависят критерии R5.
2. **Q2 · user · формат сейва.**
   - (a) Только TS: JSON плюс zod, версия 1, Rust-сейвы `.ron` не читаются.
   - (b) То же и импорт `SaveGameV3`.

   Рекомендация (a): в `SaveGameV3` нет жителей в SoA, мезо и парковок, так что импорт всё равно пересобирал бы мир. Вариант (b) делает P1 больше на M.
3. **Q3 · user · где хранятся сейвы в вебе.**
   - (a) Только файлы в Electron.
   - (b) OPFS в браузере и файлы в Electron за одним интерфейсом.
   - (c) Экспорт и импорт файла.

   Рекомендация (b): тогда сейв проверяется в обычном e2e Chromium без сборки `.app`. От ответа зависят E1 и часть P1.
4. **Q4 · user · канал правки налогов, финансирования и займов.**
   - (a) Новые варианты `GameCommand`: очередь, фингерпринт, правка раздела контрактов программы.
   - (b) Сообщения протокола, как скорость.

   Рекомендация (a): это состояние мира, и тогда повтор прогона детерминирован. В Rust это была запись в ресурс из UI, `commands.rs` таких команд не содержит. От ответа зависят пути U6.
5. **Q5 · user · `assets/config/*.ron` после удаления Rust.**
   - (a) Загрузчик RON в TS плюс zod, файлы — источник значений.
   - (b) JSON плюс zod.
   - (c) Остаются константы TS, `.ron` удаляются вместе с тестами паритета.

   Рекомендация (c): во время работы игры конфиги никто не читает, а Rust, ради которого файлы были общими, удалён. Программа при этом называла zod для конфигов. От ответа зависит P2.
6. **Q6 · user · `window.__sim` в релизе.**
   - (a) Убрать из релиза, `desktop:e2e` гонять на тестовой сборке.
   - (b) Включать только при `SIMCITY_TEST_WINDOW=1` или `?debug=1`.
   - (c) Оставить как есть.

   Рекомендация (a): программа («Защита кода от разбора») предлагает оставить API только для dev и e2e, и `desktop:e2e` проверял бы сборку, в которой API не выставлен наружу. От ответа зависит E2.
7. **Q7 · user · сценарии Rust `sandbox` и `starter` с целями.**
   - (a) Перенести каталог и цели в меню рядом с пятью сценариями TS.
   - (b) Только «новая карта на свежем сиде», цели не переносить.

   Рекомендация (a): цели — три условия на снимке города. От ответа зависят P3 и U8.
8. **Q8 · researcher.** Работают ли в three.js 0.185.1 (пин `package.json`) узлы пост-обработки `WebGPURenderer` — GTAO, bloom, FXAA и каскадные тени — на запасном бэкенде WebGL2, которым headless Chromium Playwright рисует по `CLAUDE.md`? Если нет, ворота R3 гоняются только с `E2E_GPU=1`.
9. **Q9 · researcher.** Может ли electron-builder 26.15.3 собрать и подписать Windows `.exe` на macOS arm64, или нужен Windows-раннер CI? От ответа зависят пути и размер E5.
