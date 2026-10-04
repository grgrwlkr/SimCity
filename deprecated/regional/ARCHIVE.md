# Архив прежнего регионального runtime

_Перенос согласован main loop 2026-10-04._

Основная игра `/` использует исходный `CityLife` и native worker. Здесь сохранена прежняя региональная цепочка `RegionClient → worker → advanceRegion → RegionMobility`, её renderer/editor, implementation-specific tests и диагностические tools. Архив не импортируется активной игрой и не регистрируется её entry.

22 source-файла перенесены одной группой:

- `src/main.ts`
- `src/client.ts`
- `src/worker.ts`
- `src/protocol.ts`
- `src/editor.ts`
- `src/lifePanel.ts`
- `src/simulationClock.ts`
- `src/style.css`
- `src/model/life/development.ts`
- `src/model/life/economy.ts`
- `src/model/life/logistics.ts`
- `src/model/life/mobility.ts`
- `src/model/life/residents.ts`
- `src/model/life/routes.ts`
- `src/model/life/simulation.ts`
- `src/view/scene.ts`
- `src/view/buildingView.ts`
- `src/view/developmentView.ts`
- `src/view/lifeView.ts`
- `src/view/parcelView.ts`
- `src/view/roadView.ts`
- `src/view/warehouseView.ts`

Вместе с ними перенесены 15 unit test files, два test helpers, 11 исторических E2E specs и два E2E helpers, а также `tools/region-playthrough.ts`/`test-region-week.ts`. Отдельный `region-legacy-point-marker.test.ts` сохраняет прежний fallback marker assertion. Frozen fixture JSON не регенерировались и остаются в исходных местах.

Четыре pure money/goods/clock projection функции выделены в активный `packages/app/src/region/model/life/legacyMetrics.ts`, а `polylineLane` — в `model/pathGeometry.ts`, без изменения тел функций. Архив импортирует/re-exports их; native verifier и native traffic tests не зависят от прежнего scheduler.

Pure terrain/river/topology/schema/storage/command compatibility code остаётся активным. Civic rotation/radius/expansion/disposal tests используют retained native civic builders. Карта требований и runtime граф: [native-region-runtime](../../docs/architecture/native-region-runtime.md).

Из корня репозитория:

```sh
bun run typecheck:legacy-region
bun run test:legacy-region
bun run test:legacy-region-week
```

Последняя команда запускает историческую недельную симуляцию и не подтверждает поведение native игры. Unit suite и worker TS target проверяются отдельно от активного app target. CI запускает архивный unit suite отдельной matrix job.

Исторический браузерный suite требует сохранённый прежний UI:

```sh
LEGACY_REGION_BASE_URL=http://localhost:5200 bun run --cwd deprecated/regional e2e
```

Указанный адрес — пример fixture server; архив сам его не запускает. Прежний DOM и `window.__regionEditor` отсутствуют в текущей native игре, поэтому suite намеренно отказывается запускаться без явно указанного fixture URL. Для текущей игры используются активные native E2E.

Native reconciliation отказывает при редактировании занятой дороги. Старое deferred closure, demand/autorezone и прежняя expense history остаются историческими assertions; перенос кода не объявляет их новыми завершёнными native возможностями.
