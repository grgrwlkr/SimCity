# План реализации основы региона и редактора

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Инструкции проекта и разрешения пользователя имеют приоритет.

_Статус: этап A реализован и проверен в изолированном worktree._

**Goal:** Создать работающий редактор непрерывного региона: пустая карта 4 × 4 км, несколько поселений, свободные дороги, зоны, ручное размещение склада и восстановление всей планировки.

**Architecture:** Чистая модель в отдельном worker владеет подтверждённой планировкой и бюджетом. Изменяемый дорожный граф выводится из реально построенных дорог. Three.js отображает снимки модели и локальный предпросмотр; обновляется затронутая геометрия, а модель сохраняет ID и состояние.

**Tech Stack:** TypeScript, Three.js, Web Worker, IndexedDB, Vite, Vitest, Playwright Chromium, Electron; существующий bun toolchain без новых зависимостей.

**Spec:** [Регион с несколькими городами](../specs/2026-10-02-regional-game-design.md).

## Границы этого плана и следующих частей

Утверждённая концепция разбита по зависимостям. Этот план реализует части 1 и 2 раздела «Порядок проверки первого этапа»: основу региона и редактор. Его результат можно использовать и проверить отдельно. Завершение редактора не означает завершение всей региональной игры.

| Часть | Проверяемый результат | Зависимость |
| --- | --- | --- |
| A — этот план | Игрок основывает два поселения, строит произвольную сеть, размечает зоны и сохраняет мир | Текущие графические модули |
| B — развитие застройки | Заявки приезжих и инвесторов запускают строительство с нулевого населения | Подтверждённые участки и сеть A |
| C — жители и движение | Семьи заселяются, работают и совершают реальные межгородские поездки | Вместимость зданий B и маршруты A |
| D — товары и экономика | Предприятия, склады и магазины обмениваются реальными доставками | Предприятия B и движение C |
| E — полное прохождение | Сохранение поездок и грузов, неделя развития и нагрузка двух поселений | B, C и D |

Для B–E составляются отдельные конкретные планы на уже работающие интерфейсы. Никакая часть спецификации не объявляется выполненной по результату A. В редакторе зоны остаются разрешениями на будущую застройку; он не создаёт декоративных жителей, машин или фиктивные поставки. Склад представлен размещённым строительным объектом; его ввод и доставка относятся к B и D.

## Global Constraints

- Только desktop Electron/Chromium; Y-up и `WebGLRenderer`; никакой мобильной версии или замены стека.
- Карта 4 × 4 км, координаты в метрах; суша плоская, присутствуют вода, берег и растительность; готовых городов и дорог нет.
- Дороги двухполосные, двусторонние, прямые и ломаные произвольного направления. Один бюджет региона; низкая плотность зон.
- Сохранять палитру и составную графику текущего города. Не запускать архивный движок, не менять fixtures и не восстанавливать старое меню сценариев.
- Модель не импортирует Three.js, DOM, Node, host clocks или global randomness. Вводить время и seed явно; renderer потребляет снимки.
- Команды атомарны; отказ не меняет бюджет, ID counters или топологию. Отмена предпросмотра не отправляет команду.
- Стабильные ID сохраняются при добавлении и удалении других объектов. Планировка сохраняется явно, а не восстанавливается готовым городом из seed.
- Камера: левое перетаскивание в выборе перемещает; правое вращает; колесо масштабирует. В строительстве Space + левое перетаскивание перемещает; Escape отменяет предпросмотр.
- Сохранения региона имеют отдельную версию и ключи; сохранения существующего города не перезаписываются.
- Использовать `bun run test`, а не `bun test`. Новое поведение проходит RED → GREEN; рефакторинг графики проходит существующие проверки.
- Не менять чужие правки `AGENTS.md` и `.codex/legacy-memory-index.md`. Не коммитить, не пушить и не менять основную ветку без отдельной авторизации. Изоляция реализации определяется по актуальному Git status и worktrees перед началом исполнения.

## Review Focus

1. NaN, бесконечные координаты, нулевые отрезки и частично попадающий в воду контур: отказ оставляет всё состояние прежним — задачи 1 и 3.
2. Двойное подтверждение, два быстрых действия и запоздалый ответ worker: одна команда списывает стоимость один раз, последнее состояние не откатывается — задачи 2 и 6.
3. Удаление дороги с привязанными зонами: участки и их ID сохраняются, доступность становится ложной и восстанавливается при новой связи — задачи 3 и 4.
4. Повреждённое сохранение, неизвестная версия и одинаковый seed у двух разных регионов: загрузка атомарна, ключи и существующий город не смешиваются — задачи 5 и 6.
5. Space, Escape, смена инструмента и потеря pointer capture во время жеста: камера не строит объекты, отменённый жест не списывает деньги — задачи 7 и 8.

## Файлы и ответственность

Новые чистые модули находятся в `packages/app/src/region/model/`: `types.ts`, `rules.ts`, `random.ts`, `terrain.ts`, `geometry.ts`, `roads.ts`, `parcels.ts`, `world.ts`, `commands.ts`, `save.ts`. `world.ts` создаёт начальное состояние, а `commands.ts` связывает специализированные модели при изменениях; геометрические алгоритмы не превращаются в ещё один монолит.

Новые `packages/app/src/region/{protocol,worker,client,storage,editor,main}.ts` обеспечивают worker, последовательную передачу команд, хранилище и интерфейс. `packages/app/src/region/view/{scene,terrainView,roadView,parcelView,warehouseView}.ts` отвечают за отображение. Новая страница — `packages/app/region/index.html`, стили — `packages/app/src/region/style.css`.

Из существующих файлов меняются только необходимые точки: экспорт `industry` в `city/model.ts`; записи входа Vite и worker tsconfig; правило чистой модели ESLint; меню и его тесты; fingerprint HTML в desktop build-info; README и связанные Electron e2e. Текущие `CityLife`, городская сеть, порт и железная дорога продолжают обслуживать прототип.

## Общие контракты

Следующие имена определяют границу задач. Типы объявляются в задаче 1; никаких производственных функций сейчас не реализуется.

```ts
type EntityId = string;
interface Point { readonly x: number; readonly z: number }
interface Bounds { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number }
interface Terrain { readonly bounds: Bounds; readonly water: readonly (readonly Point[])[]; readonly seed: string }
interface RegionRules { readonly startingCash: number; readonly roadCostPerMeter: number; readonly warehouseCost: number; readonly roadWidth: number; readonly snapDistance: number }
interface Settlement { readonly id: EntityId; readonly name: string; readonly center: Point }
interface Road { readonly id: EntityId; readonly points: readonly Point[] }
type ZoneKind = 'residential' | 'commercial' | 'industrial';
interface Parcel { readonly id: EntityId; readonly settlementId: EntityId; readonly center: Point; readonly heading: number; readonly width: number; readonly depth: number; readonly zone: ZoneKind; readonly access: RoadAccess | null }
interface RoadAccess { readonly roadId: EntityId; readonly segment: number; readonly offset: number }
interface Warehouse { readonly id: EntityId; readonly settlementId: EntityId; readonly center: Point; readonly heading: number; readonly access: RoadAccess | null }
interface ExternalEntry { readonly id: EntityId; readonly roadId: EntityId; readonly endpoint: 'start' | 'end' }
interface RegionState {
  readonly schemaVersion: 1; readonly id: EntityId; readonly seed: string; readonly terrain: Terrain; readonly rules: RegionRules;
  readonly revision: number; readonly roadRevision: number; readonly nextId: number; readonly cash: number;
  readonly settlements: readonly Settlement[]; readonly roads: readonly Road[]; readonly parcels: readonly Parcel[];
  readonly warehouses: readonly Warehouse[]; readonly externalEntries: readonly ExternalEntry[];
}
type RegionAction =
  | { readonly type: 'found'; readonly name: string; readonly center: Point }
  | { readonly type: 'road'; readonly points: readonly Point[] }
  | { readonly type: 'zone'; readonly settlementId: EntityId; readonly kind: ZoneKind; readonly selection: Bounds }
  | { readonly type: 'warehouse'; readonly settlementId: EntityId; readonly center: Point }
  | { readonly type: 'external-entry'; readonly roadId: EntityId; readonly endpoint: 'start' | 'end' }
  | { readonly type: 'remove'; readonly id: EntityId };
type RejectReason = 'invalid-input' | 'outside' | 'water' | 'occupied' | 'overlap' | 'no-road' | 'no-settlement' | 'insufficient-funds' | 'stale-revision' | 'not-found' | 'has-parcels' | 'not-boundary';
type CommandResult = { readonly ok: true; readonly state: RegionState; readonly created: readonly EntityId[]; readonly cost: number }
  | { readonly ok: false; readonly state: RegionState; readonly reason: RejectReason };
interface Preview { readonly valid: boolean; readonly cost: number; readonly reason: RejectReason | null; readonly contours: readonly (readonly Point[])[] }
```

Начальные настройки редактора в `rules.ts`: 1 000 000 ₽, 100 ₽/м дороги, 20 000 ₽ за склад, ширина дороги 8 м, snapDistance 2 м. Это предложенные стартовые цены для A, не завершённый экономический баланс. Основание и разметка бесплатны; снос не возвращает деньги. Содержание и доходы вводятся совместно в D. Правила сохраняются в состоянии и не заменяются новыми defaults при загрузке.

Принимаемые координаты нормализуются до 0,01 м, имена — trim, длина 1–64 символа. Валидатор не принимает NaN/Infinity или ссылки на отсутствующие сущности. Целочисленный `nextId` увеличивается только после успешной команды; префикс ID обозначает тип. Топология — производные данные из `roads`, не второй источник истины. Камера, активное поселение и локальный предпросмотр не входят в `RegionState`.

### Задача 1: Пустой регион и воспроизводимая местность

**Files:** создать `region/model/{types,rules,random,terrain,geometry,world}.ts`; тесты `packages/app/test/region-terrain.test.ts`; helper `packages/app/test/helpers/regionFixture.ts`.

**Interfaces:** `createRegion(id: EntityId, seed: string, rules?: RegionRules): RegionState`; `generateTerrain(seed: string, size: number): Terrain`; `containsPoint(bounds: Bounds, point: Point): boolean`; `isDryFootprint(terrain: Terrain, contour: readonly Point[]): boolean`. `createRegion` использует size=4000, bounds −2000…2000 по X/Z и пустые коллекции. Fixture создаёт плоскую карту с водным квадратом x=200…400, z=200…400 и теми же rules; это test helper, не режим продукта.

- [x] Написать тесты `same_seed_repeats_terrain`, `new_region_is_empty`, `different_ids_do_not_share_state`, `footprint_rejects_water_even_with_dry_corners`. Основные assertions:

```ts
expect(generateTerrain('region-a', 4000)).toEqual(generateTerrain('region-a', 4000));
expect(createRegion('a', 'region-a').terrain.bounds).toEqual({ minX: -2000, maxX: 2000, minZ: -2000, maxZ: 2000 });
expect(createRegion('a', 'region-a').roads).toEqual([]);
expect(createRegion('a', 'region-a').settlements).toEqual([]);
expect(isDryFootprint(flatFixture().terrain, [{ x: 100, z: 100 }, { x: 500, z: 100 }, { x: 500, z: 500 }, { x: 100, z: 500 }])).toBe(false);
```
- [x] Выполнить `bun run test packages/app/test/region-terrain.test.ts`: RED из-за отсутствующих экспортов, затем после первых экспортов проверить поведенческий RED для воды и пустого мира.
- [x] Реализовать seeded RNG, воспроизводимый водный polygon с берегом и проверки point/polygon и polygon/polygon. Вода остаётся в границах карты; генератор оставляет связную пригодную территорию для двух поселений. Проверять пересечение всей площади контура с водой, а не только его углов; не добавлять mesh в чистую модель.
- [x] Повторить указанные тесты: GREEN. Расширить запреты чистой модели в `eslint.config.js` на `packages/app/src/region/model/*.ts` и тест `code-quality.test.ts` вторым существующим filePath `region/model/world.ts`; отдельно получить и закрыть RED для host clocks и rendering imports.
- [x] Проверить `bun run typecheck` и `bun run lint`. Записать фактические RED/GREEN результаты; Git не менять.

### Задача 2: Поселения и атомарные команды

**Files:** изменить `region/model/world.ts`; создать `region/model/commands.ts`; тест `packages/app/test/region-commands.test.ts`.

**Interfaces:** `applyAction(state: RegionState, action: RegionAction, expectedRevision: number): CommandResult`; `previewAction(state: RegionState, action: RegionAction): Preview`. Любой успех увеличивает revision на 1; отказ возвращает тот же state. `found` создаёт marker с устойчивым ID и проверяет сушу. Чужие коллекции не перестраиваются и не меняются.

- [x] Написать `found_two_settlements_preserves_first`, `invalid_found_is_atomic`, `stale_revision_rejects_repeated_confirmation`. Указать два dry centers (−100,0) и (400,0), расстояние 500 м; проверять имена, разные ID и неизменность первого поселения.

```ts
const before = flatFixture();
const invalid = applyAction(before, { type: 'found', name: 'A', center: { x: NaN, z: 0 } }, before.revision);
expect(invalid).toEqual({ ok: false, state: before, reason: 'invalid-input' });
expect(before.nextId).toBe(1);
```
- [x] Выполнить `bun run test packages/app/test/region-commands.test.ts`; проверить ожидаемый RED по созданию и атомарному отказу.
- [x] Реализовать единый command boundary, нормализацию координат/имён и `found`; неподдержанные пока action cases возвращают явный отказ. Preview вызывает тот же валидатор, но не расходует ID и деньги. Повтор на старой revision получает `stale-revision`.
- [x] Получить GREEN; добавить проверки имён с пробелами, отсутствующих settlementId и finite coordinates. В тестах проверять содержимое состояния, а не только `ok`.
- [x] Повторить terrain/world/commands tests и типы. Проверить, что модель не использует host UUID: id региона передаёт интерфейс.

### Задача 3: Дороги и производная топология

**Files:** создать `region/model/roads.ts`; расширить `geometry.ts`, `commands.ts`; тесты `region-roads.test.ts` и `region-topology.test.ts`.

**Interfaces:** `buildRoadGraph(roads: readonly Road[]): RoadGraph`; `findRoadPath(graph: RoadGraph, from: Point, to: Point): readonly Point[] | null`; `roadContour(points: readonly Point[], width: number): readonly Point[]`; `nearestRoadAccess(roads: readonly Road[], point: Point, distance: number): RoadAccess | null`. Определить экспортированные `RoadGraph`, `RoadNode` и `RoadEdge` в `roads.ts`: nodes со stable coordinate ID, edges с roadId/segment и диапазоном offset; edges двусторонние. Road nodes строятся из концов, изломов и всех X/T пересечений. Pathfinding минимизирует длину; равенства разрешаются порядком ID.

- [x] Написать RED для 100 м дороги за 10 000 ₽, ломаной, диагонального X, T, несвязных компонентов, нулевой длины и коллинеарного наложения. На fixture использовать дороги x=−100, z=−50…50 и z=0, x=−150…−50.

```ts
expect(findRoadPath(buildRoadGraph(twoCrossingRoads), { x: -100, z: -50 }, { x: -50, z: 0 })).toEqual([{ x: -100, z: -50 }, { x: -100, z: 0 }, { x: -50, z: 0 }]);
expect(findRoadPath(buildRoadGraph(twoDisconnectedRoads), firstEndpoint, secondEndpoint)).toBeNull();
```
- [x] Выполнить `bun run test packages/app/test/region-roads.test.ts packages/app/test/region-topology.test.ts`; убедиться в RED до реализации пересечений, непрерывной проверки воды и оплаты.
- [x] Реализовать геометрию и граф. Принимать минимум 2 distinct points; отвергать самоналожение и повтор сегмента. Проверять весь road contour на воду и occupied footprints. Конец на границе допустим: наружная end cap отсекается границей, иначе внешний въезд нельзя построить. Стоимость `ceil(totalLength * roadCostPerMeter)`, списание после всех проверок; roadRevision +1 только при изменении дорог.
- [x] Реализовать `external-entry` только на начале/конце дороги, лежащем на границе с допуском 0,01 м; сделать тесты для настоящей границы и отказа в середине карты. Добавить тест `failed_polyline_keeps_cash_ids_and_roads` с сухим началом и мокрым продолжением.
- [x] Получить GREEN по roads/topology/commands; сохранять roads как исходные polylines. Удаление road удаляет его ExternalEntry, увеличивает roadRevision, остальные исходные ID сохраняет. Не привязывать nodes к строке/столбцу CityGrid.

### Задача 4: Участки, зоны и размещённый склад

**Files:** создать `region/model/parcels.ts`; изменить `commands.ts`; тесты `region-parcels.test.ts` и `region-warehouse.test.ts`.

**Interfaces:** `zoneCandidates(state: RegionState, selection: Bounds): readonly ParcelDraft[]`; `refreshAccess(state: RegionState): RegionState`; `warehouseDraft(state: RegionState, center: Point): WarehouseDraft | null`. Объявить `ParcelDraft` как `Omit<Parcel,'id'|'settlementId'|'zone'>`, `WarehouseDraft` как `Omit<Warehouse,'id'|'settlementId'>`. Draft не получает ID до принятия команды.

- [x] Написать тесты oriented frontage, zone membership, overlap, water footprint и `removing_road_keeps_parcel_id_and_disconnects_access`.

```ts
expect(zoned.parcels[0]?.settlementId).toBe(settlement.id);
expect(disconnected.parcels[0]?.id).toBe(zoned.parcels[0]?.id);
expect(disconnected.parcels[0]?.access).toBeNull();
expect(reconnected.parcels[0]?.id).toBe(zoned.parcels[0]?.id);
expect(reconnected.parcels[0]?.access).not.toBeNull();
```
- [x] Выполнить `bun run test packages/app/test/region-parcels.test.ts packages/app/test/region-warehouse.test.ts`; получить поведенческий RED, включая смену зоны без удаления участка.
- [x] Реализовать oriented участки 16 × 24 м с фронтом по дороге, отступом 6 м от оси до ближнего края и шагом frontage 16 м. Кисть выбирает участки по попаданию их центра в selection; весь footprint проверяется на сушу, границы, дороги и существующие участки. Все части одной zone action принимаются целиком; отсутствие кандидатов получает `no-road`. Повторная разметка существующего свободного участка сохраняет его ID и обновляет kind/принадлежность выбранному городу.
- [x] Размещать warehouse на footprint 20 × 24 м с ориентацией по ближайшему подходящему road segment и подъездом. Preview показывает окончательно snapped центр; подтверждение сохраняет тот же центр. Списывать 20 000 ₽ только после успешной проверки. Зоны не накрывают warehouse; удаление склада допустимо, так как в A в нём нет жителей или груза. Удаление settlement с участками/warehouse возвращает `has-parcels`.
- [x] Получить GREEN. После road mutation запускать `refreshAccess`, сохраняющий footprint/ID и пересчитывающий roadId/segment/offset. Проверить detached warehouse и восстановление доступа; не назначать ближайшую дорогу сквозь воду или занятый участок.

### Задача 5: Формат сохранения редактора

**Files:** создать `region/model/save.ts`; тест `region-save.test.ts`.

**Interfaces:** `serializeRegion(state: RegionState): string`; `parseRegion(value: unknown): RegionState`. Сохранение — `{ kind:'simcity-region', version:1, state:RegionState }`; данные immutable после проверки. Использовать существующий Zod для shape validation, отдельные семантические проверки ID, ссылок, bounds, счетов, контуров и nextId. Derived topology заново строится из roads.

- [x] Написать roundtrip двух поселений, диагональных дорог, трёх зон, склада, external-entry и изменённых тарифов; после загрузки следующая команда не повторяет ID. Добавить rejected unknown version/duplicate ID/orphan settlement/NaN geometry. Проверять, что `simcity city` payload не принимается как регион.

```ts
expect(parseRegion(JSON.parse(serializeRegion(edited)))).toEqual(edited);
expect(() => parseRegion({ kind: 'simcity-region', version: 99, state: edited })).toThrow('Неподдерживаемая версия сохранения региона');
```
- [x] Запустить `bun run test packages/app/test/region-save.test.ts`; подтвердить RED roundtrip и семантических проверок.
- [x] Реализовать формат и проверки, сохранив rules из файла. Восстановленная карта не вызывает `generateCity`. Данные загрузки проверяются полностью до замены текущего мира.
- [x] Получить GREEN; после загрузки повторить `findRoadPath` и сравнить с исходным графом. Не сохранять THREE objects, Maps с неявным JSON или текущие array indices.
- [x] Повторить все `region-*.test.ts` командой `bun run test packages/app/test/region-*.test.ts`; типы и lint зелёные.

### Задача 6: Worker, последовательность команд и локальное хранилище

**Files:** создать `region/{protocol,worker,client,storage}.ts`; изменить app/worker tsconfigs; тесты `region-protocol.test.ts` и `region-storage.test.ts`.

**Interfaces:** `RegionRequest` — union `{id,type:'init',regionId,seed}`, `{id,type:'apply',action,expectedRevision}`, `{id,type:'load',value:unknown}`, `{id,type:'save'}`. `RegionResponse` — `{id,state:RegionState,result?:CommandResult,save?:string}` или `{id,error:string}`. Определить `handleRegionRequest(state: RegionState | null, request: RegionRequest): { state: RegionState | null; response: RegionResponse }` в protocol.ts для теста без worker runtime. `RegionClient` предоставляет `ready`, `state`, `apply(action):Promise<CommandResult>`, `save():Promise<string>`, `load(value:unknown):Promise<void>`, `dispose():void`. Constructor: `(regionId:string, seed:string, changed:(state:RegionState)=>void, failed:(message:string)=>void, port?:RegionPort)`. Тестируемый `RegionPort` предоставляет `post(request:RegionRequest):void`, `subscribe(response:(value:RegionResponse)=>void,error:(message:string)=>void):()=>void` и `terminate():void`; реальный adapter создаёт browser Worker.

Storage exports: `storeRegion(id:string,save:string,port?:RegionStoragePort):Promise<void>`, `readRegion(id:string,port?:RegionStoragePort):Promise<unknown|null>`, `listRegions(port?:RegionStoragePort):Promise<readonly RegionSaveInfo[]>`, где `RegionSaveInfo = { readonly id:string; readonly label:string }`. Новый DB — `simcity-regions`, store — `regions`, key — regionId. `RegionStoragePort` предоставляет `put(id:string,value:string):Promise<void>`, `get(id:string):Promise<unknown|null>` и `list():Promise<readonly { readonly id:string; readonly value:unknown }[]>`; по умолчанию используется IndexedDB, в unit-тестах Map adapter.

- [x] Написать `failed_load_keeps_previous_state`, `actions_keep_response_order`, `dispose_rejects_pending_requests`, `same_seed_different_region_ids_have_separate_keys`, `saved_regions_are_selectable_after_new_game`. Использовать управляемый RegionPort, который выполняет handler и позволяет задержать ответ, и Map-backed RegionStoragePort; настоящий worker и IndexedDB проверяются browser e2e задачи 8.
- [x] Запустить protocol/storage tests, получить RED ожидаемых ошибок и порядка ответов.
- [x] Реализовать handler и worker; client выполняет mutations/load/save в одной последовательной очереди, берёт expectedRevision из последнего подтверждения. Коррелировать ответы по id; не применять старый ответ после load/dispose. Preview локально использует последний state; stale refusal обновляет вид из актуального состояния, но не списывает средства повторно.
- [x] Добавить region worker в include `tsconfig.worker.json`, исключить его из DOM app target. Модель protocol не использует DOM; client/storage остаются DOM modules. ID нового региона создаётся UI через `crypto.randomUUID()` и передаётся в чистую модель. После save/load адрес содержит подтверждённые seed и regionId; «Загрузить» предлагает список listRegions, поэтому сохранение доступно после возвращения в меню или создания другой карты. Несовместимая запись видна в списке с соответствующей подписью и выдаёт ошибку при загрузке. `ready`/все Promise имеют обработку отказа.
- [x] Получить GREEN, проверить `bun run typecheck` и `bun run lint`. Не копировать CityLife или его IndexedDB DB/store.

### Задача 7: Региональная сцена и строительные инструменты

**Files:** создать `packages/app/region/index.html`, `region/{main,editor}.ts`, `region/style.css`, все перечисленные `region/view/*.ts`; экспортировать `industry` из `city/model.ts` без изменения её тела и регистрации материалов; добавить `region` input в app Vite; тесты `region-editor.test.ts`, `region-view.test.ts`.

**Interfaces:** `createRegionView(state:RegionState):RegionView` с `group:THREE.Group`, `update(state:RegionState):void`, `setNight(night:boolean):void`, `setPreview(preview:Preview|null):void`, `pick(point:Point):EntityId|null`, `dispose():void`; `EditorState { tool:'select'|'found'|'road'|'residential'|'commercial'|'industrial'|'warehouse'|'remove'|'external-entry'; activeSettlementId:EntityId|null; points:readonly Point[]; panning:boolean }`; `reduceEditor(state:EditorState,event:EditorEvent):{state:EditorState; action:RegionAction|null}`. Определить `EditorEvent` для tool change, pointer start/move/end/cancel, Space down/up и Escape; settlement name/selection входят в завершение жеста.

- [x] Написать RED `escape_discards_action`, `space_drag_only_pans`, `pointercancel_does_not_commit`, `tool_change_discards_points`; проверить warehouse rotation и `dispose_keeps_shared_materials_geometries` в view tests.
- [x] Запустить editor/view tests, затем минимальный browser smoke для `/region/?seed=region-a`: RED отсутствующей страницы/готовности.
- [x] Создать страницу с canvas `#region`, `data-ready`, панелью бюджета, активного поселения, инструментами, кнопками «День»/«Ночь» и сохранением/выбором записи для загрузки. Модель worker — единственный источник подтверждённых объектов. Введённые имена показывать через textContent; требуемые подписи: «Основать поселение», «Дорога», «Жилая зона», «Торговая зона», «Производственная зона», «Склад», «Внешний въезд», «Выбор», «Снос», «Сохранить», «Загрузить».
- [x] Реализовать сцену Y-up с общей палитрой/светом. Terrain разбить на 256 м пространственные части, деревья получить через treeKit/treeParts/addParts; воду рисовать по polygon. RoadView показывает настоящее полотно, разметку, перекрёстки и тротуары по geometry. ParcelView показывает oriented зоны и различает отсутствие доступа. WarehouseView получает сохранённый ID и seeded buildingKit; вызывает exported industry в local Group с поворотом и тем же уровнем земли. Не вызывает createCity и не создаёт порт/вокзал.
- [x] Обновлять только dirty spatial parts при mutation; `Batch` пересобирать до finish. При отдалении снижать детализацию растительности/дорог; снимать только собственные meshes и buffers. Общие geometries/materials из primitives не dispose. Renderer не создаёт новые ID, дорожные связи или бюджет.
- [x] Реализовать camera/editor arbitration по EditorEvent; left clicks на UI не попадают на карту. Preview показывает реальные contours, окончательную позицию и цену из previewAction. Отказ отображает конкретную русскую причину; Escape/pointercancel/смена инструмента не применяют pending action. Размер canvas учитывает оба desktop viewport; Space-перемещение проверяется мышью и тачпадом.
- [x] Получить GREEN editor/view/smoke, выполнить соседние `city-assets.test.ts`, `city-construction.test.ts`, `city-houses.test.ts` после экспорта builder. Визуально сравнить вид склада с прототипом; проверить diagonal road, X/T junction, water contour и крупный/общий вид.

### Задача 8: Проверка редактора в Chromium

**Files:** создать `e2e/region-editor.spec.ts`; DEV-only hook в `region/main.ts`.

**Interfaces:** только в `import.meta.env.DEV` определить `window.__regionEditor` с `snapshot():RegionState`, `project(point:Point):{x:number;y:number}`, `terrainProbe():{land:Point;secondLand:Point;water:Point;boundary:Point}`. Две land points разделены 300–600 м и соединяются сухим коридором; probe ищет их в сгенерированной местности и не меняет мир. Hook позволяет читать состояние и переводить мировую точку в экранную; все постройки в e2e выполняются настоящими UI gestures. В production этот hook отсутствует. `#region` сообщает `data-ready` после подтверждения worker и первого кадра.

- [x] Написать e2e `player_builds_two_settlements_and_irregular_network`, `invalid_build_keeps_cash`, `camera_gestures_do_not_build`, `save_load_restores_layout`, `same_seed_new_region_does_not_overwrite_saved_region`. Assertions: два разных names/ID, расстояние 300–600 м, diagonal road и junction, три типа зон, warehouse, одинаковые ID/cash/rules после load и неизменный городской IndexedDB store.
- [x] Запустить `E2E_PORT=5193 bun run e2e e2e/region-editor.spec.ts`; порт предварительно проверить и выбрать другой свободный, если занят. Не использовать текущий preview server для теста. Получить ожидаемый RED для незавершённых gestures/storage до исправления.
- [x] Завершить недостающие связи реальных input/client/view; тесты сохраняют снимки общего региона, двух поселений и oriented warehouse. Проверить 1440 × 1000 и 1280 × 800, дневное и ночное освещение, отмену и повторное действие.
- [x] Получить GREEN. Оценить frame time после прогрева при обзоре всей карты и близком виде; цель редактора — ≥30 кадров/с на рабочем Mac при 1440 × 1000 с `E2E_GPU=1`. Нагрузку 1000 жителей/200 зданий из спецификации проверять в E, а не при пустом редакторе. Отчёт разделяет результаты SwiftShader/GPU и не делает вывод по одиночному screenshot.

### Задача 9: Главное меню, Electron и итоговая проверка

**Files:** изменить app `index.html`, `src/main.ts`, `src/menu.css`, `e2e/main-menu.spec.ts`, `packages/desktop/e2e/shell.spec.ts`, `packages/desktop/scripts/build-info.ts`, README; добавить `packages/desktop/e2e/region.spec.ts`.

**Interfaces:** главный menu link `#open-region` ведёт `/region/?seed=689856`, Enter открывает его. Прототип доступен небольшим вторичным link «Город у воды — прототип» вне основного nav. Старые `/city/` deep links продолжают работать. Desktop scheme обслуживает новое bundled `/region/index.html` существующим handler, без расширения разрешённых origins или DevTools. Build-info включает HTML региона и города в fingerprint входов.

- [x] Обновить e2e меню: primary region, Enter, возврат, отсутствие worker до открытия, один region worker после открытия. Сохранить отдельный сценарий перехода в старый prototype и его life worker. Сначала получить RED по старой primary link.
- [x] Изменить меню и текст подсказок после работающей страницы. В README описать редактор и его текущую границу, доступные инструменты, сохранение и prototype link; не объявлять жителей/доставки нового региона уже готовыми.
- [x] Добавить скрытый packaged Electron сценарий: открыть регион, создать поселение и дорогу через UI, сохранить, загрузить, проверить ID и отсутствие `__regionEditor`/`__sim` в production. Закрывать test app в finally. Существующий hidden city scenario открыть через prototype link и оставить проверку старых saves/fuses.
- [x] Выполнить `bun run check`, все Chromium e2e на отдельном порту и `bun run build`. Убедиться в bundled region HTML и worker. Если есть ошибка, исправить причину и повторить затронутые проверки; не ослаблять общий gate.
- [x] Выполнить `bun run desktop:build`, `bun run desktop:build:test`, затем `SIMCITY_TEST_WINDOW=1 bun run desktop:e2e`. Использовать имеющийся disposable inspectable clone; сохранить release restrictions. Закрыть все запущенные test instances.
- [x] Перечитать diff/status, сохранить снимки и результаты RED/GREEN/check/e2e/build. Показать рабочий редактор и отдельно назвать B–E как оставшуюся работу общей спецификации. Не создавать commit/push/PR без запроса.

## Проверка покрытия и передача

Карта, поселения, изменение сети, принадлежность участков, предпросмотр, атомарные расходы, ручной склад, общая камера, worker и explicit saves покрыты A. Спрос, стадии строительства, семейная жизнь, обслуживание, налоги, перевозки, активные trip saves и полное недельное прохождение принадлежат B–E и имеют явные строки в таблице зависимостей. Свободная железная дорога, порт, услуги и остальные поздние механики остаются следующим развитием, как определено спецификацией.

Пять Review Focus имеют собственные тесты в задачах. Все новые interfaces определяются до потребителей; основная сцена и renderer не используют регулярный CityGrid. Минимальный склад сохраняет geometry через экспорт существующего builder вместо нового визуального рецепта.

Рекомендуемый метод исполнения — основной агент реализует связанные задачи модели и command contracts последовательно в этой сессии; независимые ограниченные работы можно поручать помощникам после фиксации интерфейсов. Итоговая проверка, принятие результата и согласование границ остаются в основном цикле. План выполнен в текущей сессии с ограниченными параллельными задачами и итоговым принятием в основном цикле. Результаты проверки записаны в `.superpowers/sdd/2026-10-02-region-editor/progress.md`.
