# Этап 1½ — отладочный рендер: план

> Программа: `docs/plans/2026-09-11-ts-threejs-migration-plan.md`. Исполняется inline, код в коммитах.

**Цель:** в браузере видно то, что посчитал `packages/sim`: карта чанками, машины кубиками, ортокамера с панорамой, зумом и пикингом, оверлеи под `?debug=1`. Ворота: скриншот тестового города в Playwright совпадает с Rust по раскладке.

## Ворота и как они проверяются

Rust рисует город псевдо-3D ортокамерой с наклоном не круче 1.35 рад, TS — ортокамерой строго сверху. Пиксели двух рендеров сравнивать бессмысленно, сравнивается раскладка: класс каждого тайла (дорога, вода, остальное) там, где его центр попал на экран.

1. **Эталон из Rust, один раз, `tools/rust-layout.ts`.** Скрытый экземпляр игры (skill `simcity-live`) с тестовым городом, пауза, камера на весь город, кадр. Соответствие «тайл → пиксель» кадра Rust не выводится из математики камеры, а измеряется: снять тайл `EraseTile` в трёх известных точках и взять центры изменившихся пикселей. Ортопроекция плоскости земли аффинна, трёх точек хватает. Класс тайла в кадре — ближайший цвет среди медиан классов. Результат — `e2e/fixtures/rust-layout.json` (классы по тайлам, аффинное преобразование, доля совпадения кадра Rust с его же сеткой) и кадры для глаз.
2. **Проверка в CI, `e2e/render.spec.ts`, Chromium и WebKit.** Сетка тестового города грузится из `road-routes.json`, камера показывает карту целиком, скриншот канваса разбирается прямо в странице. Позиция пикселя тайла считается по контракту экрана, а не по внутренностям камеры TS: север вверху, восток справа. Иначе зеркальный рендер прошёл бы сам с собой. Классы TS сверяются с сеткой Rust (100 %) и с классами кадра Rust на уверенных тайлах (≥ 98 %).
3. **Ориентация.** Аффинное преобразование кадра Rust обязано давать восток вправо и север вверх при выбранном yaw; это утверждение в `tools/rust-layout.ts`.

## Тесты

| Тест | Источник | Инвариант |
|---|---|---|
| `straightDownHitsAtCameraHeight`, `tiltedRayLandsOnExpectedGroundPoint`, `parallelAndBackwardRaysMiss` | `map/tests.rs::core_coords_ray` (3, переданы из этапа 1) | луч вниз бьёт на высоте камеры; наклонный под 45° — в начало координат; параллельный и уходящий вверх — мимо |
| `screenToGroundInvertsGroundToScreen`, `pickTileMatchesWorldToTile` | новые | экран → земля обратно земле → экран; пикинг даёт тайл `worldToTile` |
| `fitMapShowsTheWholeMapNorthUp`, `zoomAtKeepsTheGroundPointUnderTheCursor`, `panMovesByScreenPixels` | новые | карта целиком в кадре, север вверху; зум держит точку под курсором; пан сдвигает на пиксели экрана |
| `tileClassFollowsRoadWaterAndBox`, `classColorsAreDistinct` | новые | класс тайла из слоёв сетки; цвета классов различимы после сжатия скриншота |
| `chunkGeometryCoversItsTilesInWorldSpace`, `changedChunksOnlyWhereLayersDiffer`, `edgeChunksClipToTheMap` | новые | квадраты тайлов стоят по `tileToWorld`; пересобираются только изменённые чанки; крайние чанки не выходят за карту |
| `mapLayersReplyCopiesTheGrid`, `loadGridBumpsVersionsAndRebuildsGraphs`, `debugVehiclesArePublished`, `debugOverlayListsClustersAndLanelets` | новые, `bridge/test/host.test.ts` | ответы воркера для рендера |
| `debugRenderMatchesRustLayout`, `vehiclesDrawAsCubes`, `pickingReportsTheTileUnderTheCursor`, `overlaysOnlyWithDebugFlag` | новые, e2e | ворота и поведение в двух движках |

## Файлы и контракты

- `packages/render/src/`: `picking.ts` (`rayGroundT`, экран ↔ земля), `camera.ts` (`OrthoView`: центр, мир на пиксель, `fitMap`, `panBy`, `zoomAt`), `palette.ts` (`tileClass`, цвета), `mapChunks.ts` (чанк 16×16, геометрия и diff слоёв), `vehicles.ts` (инстансы кубов из кадра SAB с интерполяцией), `overlays.ts` (сетка, боксы, лейнлеты), `debugRenderer.ts` (сцена Three.js, цикл кадра).
- `packages/bridge/src/protocol.ts`: запросы `mapLayers` (слои сетки и версии), `loadGrid` (слои целиком: отладка и тесты, как запись мира через BRP), `debugVehicles` (машины в слоты `vehicles` до этапа 2), `debugOverlay` (кластеры и пути лейнлетов). `WorldSnapshot` получает `mapEditVersion` и `graphVersion`: главный поток перезапрашивает слои, когда версия сдвинулась.
- `packages/app`: канвас под HUD; `window.__sim` получает `loadGrid`, `debugVehicles`, `camera`, `fitMap`, `pickTile`, `renderStats`.
- Three.js 0.185.1 и `@types/three` 0.185.4, точный пин: у 0.186.0 типов ещё нет. Рендерер — `WebGPURenderer` из `three/webgpu`, в браузерах без WebGPU он сам уходит на WebGL2.
- Замер, пропущенный на этапе 1: `bun run bench` на тестовом городе, тик p50 и p99 на 3000 тиках.

## Сделано / Отклонения / Замеры

**2026-09-11.** Ворота пройдены в Chromium и WebKit. На скриншоте тестового города все 16 384 тайла совпадают с сеткой Rust. С кадром живой игры Rust совпадение не ниже 98 % на читаемых тайлах: кадр читается на 16 366 тайлах, и 99.8 % из них совпадают с сеткой Rust. Тест не пустой: перевёрнутая вверх ногами картинка расходится с сеткой на 12 758 тайлах. Калибровка кадра Rust: 5.33 пикселя на тайл по x и 5.20 по y (наклон камеры 1.35 рад), остаток 0 пикселей, восток вправо и север вверх подтверждены. Глазами кадры тоже сходятся: пруд вверху справа, полоса воды внизу, те же дороги.

Отклонения:
- Headless Chromium рисует через WebGL2, WebKit через WebGPU, так что оба бэкенда `WebGPURenderer` проверены одними тестами.
- Три теста `ray_ground_t` лежат в `render/test/camera.test.ts` рядом с камерой.
- Сверх таблицы добавлены `loadGridRejectsTheWrongSize`, `updateReportsAMapEditWithoutATick` и `debugOverlayDrawsEveryLanelet`. Последний выделен из `overlaysOnlyWithDebugFlag`: в WebKit второй `page.goto` внутри одного теста зависал на `__sim.ready`. Причину я не разбирал.
- `RenderReader.readInto` теперь возвращает номер кадра: кубы машин по нему замечают новый кадр, даже если тик и число машин не сдвинулись.
- `packages/sim` экспортирует модули лейнлетов, потому что их типы нужны протоколу.
- Цвета экземпляров `InstancedMesh` создаются заранее: материал, скомпилированный до первого `setColorAt`, игнорировал их, и кубы выходили белыми.
- Порог разницы пикселей в `tools/rust-layout.ts` — 24, а не 90: асфальт и трава отличаются по сумме каналов всего на ~70, и при 90 стёртый тайл не находился.

Замеры:
- `bun run bench`, 3000 тиков: пустая карта p50 0.0005 мс, p99 0.0036 мс; тестовый город p50 0.0004 мс, p99 0.0012 мс. Машин до этапа 2 нет, это тик с построенными графами.
- Vitest 176 тестов за 1.8 с, e2e 18 тестов за 21 с.
