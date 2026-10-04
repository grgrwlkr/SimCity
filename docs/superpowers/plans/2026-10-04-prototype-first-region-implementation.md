# Регион на исходном движке — исполнительный план

> **For agentic workers:** Use `superpowers:executing-plans`. Архитектура выбрана пользователем 2026-10-04: исходный `CityLife` — основа всей игры, регион — его мир и редактор. Основной исполнитель ведёт интеграцию и приёмку; пользователь 2026-10-04 разрешил агентов для ограниченных задач.

**Goal:** Расширить работающий «Город у воды» до большой редактируемой карты с несколькими городами, сохранив уже существующие механики на протяжении перехода.

**Architecture:** Один исходный `CityLife`, его `Population`, `ParkingBook` и `CityTraffic` обслуживают весь регион. Региональные данные описывают geography, поселения, дороги, зоны и инфраструктуру. Исходный renderer получает сущности того же движка; пригодные редактор, хранилище и реальная логистика используются как компоненты и адаптеры.

**Tech Stack:** TypeScript, Three.js, Web Worker, Bun, Vitest, Chromium, Electron.

**Spec:** `docs/superpowers/specs/2026-10-04-prototype-first-region-design.md` — выбранная архитектура; `docs/reference/waterfront/README.md` — неизменяемый эталон.

**Checkout:** `/Users/xawkay/.codex/worktrees/prototype-first/SimCity` ведёт переход от clean baseline. `/Users/xawkay/.codex/worktrees/waterfront-parity/SimCity` хранит восстановимый предыдущий WIP и пригодный код для адаптеров. Непроверенная реализация остаётся изолированной. После каждого принятого игрового этапа его проверенный checkpoint публикуется в основную ветку и основную игру на `http://localhost:5197/`.

## Неподвижные требования

- Исходные целые модели и участки остаются в масштабе1; no invented front parking pads, no squash/scale-to-fit.
- Все основные экраны работают на `/` в одном приложении; `/city/` остаётся эталонным входом в общую реализацию.
- Семьи, автобус, поезд, порт, школа и досуг сохраняются в исходном управляющем ядре. Не создавать их вторую региональную реализацию.
- На весь мир одна симуляция/clock/traffic allocator; несколько городов — данные внутри неё.
- Авторские дороги и города определяет игрок. Новая карта в конечной игре может быть пустой.
- Региональная экономика фактических товаров сохраняется; default prototype остаётся контрольным сценарием, его timed restock не применяется к региональной игре.
- Сохранять старые деньги, ID, собственность, машины и исходные сейвы. Не заменять несовместимый сейв пустой картой.
- Дубли удаляются только после их замены, проверки и сохранения восстановимого снимка.

## Поставка после каждого этапа

Пользователь явно потребовал 2026-10-04 видеть этапы в основной сборке. Обновление основной игры после принятого этапа уже разрешено; повторно спрашивать разрешение на каждую такую публикацию не требуется.

- Подготовительный Task1 отражается в отчёте. После каждого игрового Task2–Task8 обновляется основная сборка на стабильном адресе `http://localhost:5197/`; Task9 выполняет окончательную приёмку этой же игры.
- В публикуемый checkpoint входят только законченные изменения этапа и их проверенные зависимости. Не включать незавершённые соседние правки только потому, что они лежат в том же worktree.
- Перед публикацией проходят typecheck, необходимые model/save tests, production build и затронутый Chromium сценарий. Если проверка не проходит, этап остаётся открытым и исправляется; непроверенный код не выдаётся за завершённую сборку.
- Перед обновлением затронутой живой игры поставить симуляцию на паузу, сохранить активный мир его текущим форматом и проверить успешную запись. Сохранить восстановимый исходник перед миграцией. Не перезапускать Codex/браузер целиком и не закрывать другие пользовательские вкладки.
- После проверок выполнить ранее запрошенную scoped Git-интеграцию этапа: commit, merge/push в основную ветку без чужих незавершённых изменений. Основной сервер должен обслуживать именно опубликованный checkpoint, а не произвольное изменяемое состояние старого worktree. Сохранить возможность возврата предыдущей сборки.
- Обновить основной сервер/страницу в рамках разрешённой поставки; origin и URL `/` сохраняются. Восстановить совместимый активный сейв. Если его importer ещё не завершён, сохранить оригинал и явно сообщить об этом ограничении, а новый native этап показать на обычном контрольном сейве; не имитировать успешный импорт.
- Проверить уже поставленную игру на основном адресе: запуск, актуальная версия кода, основной сценарий этапа и save/load. Только после этого отметить этап закрытым.
- Сообщить пользователю номер этапа, что теперь доступно в основной игре, короткий способ проверки и оставшиеся ограничения. Приложить ссылку и фактический кадр, когда изменение видно на экране.
- Отдельные preview/worktree остаются средствами разработки. Они не заменяют обновление основной игры после этапа. Открытый старый снимок5199 сам по себе не подтверждает публикацию.

## Review Focus

1. Меню→продолжение не создаёт нового worker/населения и не продвигает скрытый мир — Task2.
2. Инъекция того же исходного world definition даёт прежние geometry/snapshots/default mechanics — Tasks3–4.
3. Пустая карта/отсутствующая инфраструктура не запускают скрытую старую сетку и не ломают исходный scheduler — Tasks3–5.
4. Изменение topology не пересоздаёт жильё, людей, автомобили, маршруты и занятые места — Tasks5–6.
5. Импорт старого save не теряет активные операции, средства и идентичности; unsupported исходник остаётся восстановимым — Tasks7–8.

## Что больше не выполняется

`2026-10-04-waterfront-region-remaining.md` и первый parity-план сохраняются как история и список проверок. Их последовательность «дописать отдельные regional railway/bus/school/population controllers» отменена. Существующие helpers оттуда используются только при явной роли в новой архитектуре; standalone `RegionMobility`/региональный population scheduler не расширяются дальше.

## Task1. Сохранить текущую работу и контрольные примеры

**Files/artifacts:** ignored `.scratch/recovery/`; текущие tracked/untracked файлы; известные `.scratch/region-playthrough/*.json`; reference fixtures. Git history не переписывать.

- [x] Создать восстановимый snapshot файлов текущей рабочей копии, binary diff, baseline revision и manifest. Проверить состав архива и checksum; отдельно указать, какие filesystem saves включены. Не копировать браузерный профиль/credentials.
- [ ] Зафиксировать состояние исходных и региональных проверок; результаты связывать с конкретной версией кода. Сохранить уже известные failures, не выдавать старые логи за текущую приёмку.
- [ ] Проверить, какие source extractions действительно сохраняют default результаты. Всё спорное сверять с `e5c87830485f954f710c489d8837efa6b39031fc`/seed689856; полезные правки не откатывать на предположении.

**Done:** снимок можно восстановить без потери незакоммиченных файлов и имеющихся тестовых сейвов; нет массового удаления.

**Snapshot evidence:** `.scratch/recovery/2026-10-04-prototype-first-23656fc7/receipt.json`: 741 files, archive verified by contents/hash; SHA-256 `7caf665e6c462f9aeb2746086f39de123cf7add20bc74ff2a4246e0a4ecd1263`. Included filesystem saves: `living-region-save.json`, `performance.json`, `working-save.json`. Browser IndexedDB/profile is not included; existing browser records and running previews were not changed.

## Task2. Исходная игра на корне, целиком

**Modify:** `packages/app/src/main.ts`, `packages/app/index.html`, `city/main.ts`, `city/style.css`, `city/life/client.ts` lifecycle, root save catalogue. **Create:** `city/runtime.ts`, `city/viewTemplate.ts`, `game/runtime.ts`, `game/save.ts` — тонкие оболочки, не новые игровые контроллеры.

**Planned shell interface:** `GameRuntime {ready: Promise<void>; setVisible(visible: boolean): void; save(): Promise<unknown>; load(value: unknown): Promise<void>; dispose(): void}`. Реализация делегирует исходному `LifeClient` и shared city runtime. `city/main.ts` остаётся standalone bootstrap этого же runtime, а не копией его тела.

- [x] Написать RED shell test: вход в игру создаёт ровно один native client; меню/возврат сохраняют тот же world и камеру; hidden view не получает controls/advance.
- [x] Механически вынести существующий city runtime, сохранив renderer, панели, управление, `LifeView`, `ParkingView`, стройку, порт и вокзал. Не собирать упрощённый интерфейс с нуля и не использовать iframe/новый URL для основной игры.
- [x] Root оболочка запускает native runtime. `region/main.ts`/региональный life worker не являются управляющим runtime нового мира.
- [x] Подключить save/load native world к обычному списку сохранений через versioned game envelope: `{kind:'simcity-game', version:1, id, name, seed, world}`. Legacy региональные записи сохраняются и распознаются; до импортера не открывать их как пустой native world и не менять их байты.
- [x] Перенести существующий придуманный знак валюты в presentation основной игры. Изменение формата не меняет цены/счета или эталонный default prototype.
- [x] Пройти через `/`: семьи/жильё/покупка машины, parking, автобусное прибытие, поезд/переезды, school/leisure, port cargo, construction, день/ночь, карточки, меню, save-mid-trip.

**Checks:** source city-life/parking/railway/population/world tests; существующие source Chromium scenes через shared runtime; новые `game-runtime.test.ts`, `game-save.test.ts`, `e2e/native-root.spec.ts`.

**Done:** исходный город работает на `/` со всеми уже существующими системами. Это первый предъявляемый результат. Готовый исходный город пока служит приёмочным сохранением; не добавлять продуктовый demo mode.

**Delivered:** `0f4d814`, main and origin/main, primary5197. Full check375tests/nativeweek/build; Chromium6cases; primary observed screenshot `.scratch/prototype-first/stage2-primary.jpg`. Legacy saves retained pending importer.

## Task3. World definition и routing вместо зашитого создания карты

**Modify:** `city/life/world.ts`, `network.ts`, `types.ts`, protocol/worker/save. **Create:** `city/worldDefinition.ts`, `city/life/routing.ts`, `city/life/legacyRouting.ts`.

**Planned interfaces:**
- `createPrototypeDefinition(seed: string, expanded: boolean): CityWorldDefinition` сохраняет прежние layout/profile/infrastructure values.
- `LifeRouting.access(Point, Point[]): WalkAccess`, `.walk(WalkAccess, WalkAccess): Point[]`, `.drive(RoadAccess, RoadAccess): LaneRoute`; добавить явные `.isOnRoad`, arrival/departure access operations вместо чтения grid coordinates в `CityLife`.
- `CityLife.fromDefinition(definition, options)` — новый путь создания. Старый `new CityLife(seed, families, expanded)` остаётся совместимым и использует prototype definition.
- Региональный road-access использует отдельный graph variant с edge/offset; native grid variant сохраняет прежние значения. Не подставлять фиктивные column/row/direction вместо фактического graph access. Parking enter/exit routes и walk access также проходят через routing adapter, который использует исходные кривые в их настоящем placement frame.
- World definition содержит profile/asset references, routing definition, bounds/terrain, infrastructure configuration и стабильные identities. Описание сохраняется; runtime functions из сохранения восстанавливаются адаптерами.

- [x] RED: explicit prototype definition должен дать тот же frame/save, что прежний constructor, на нескольких временах и после restore.
- [x] Убрать `generateCity` из единственного обязательного пути constructor, сохранив default constructor façade.
- [x] Вынести grid-only access/onRoad/arrival bindings в legacy adapter; Native scheduler и `Population` остаются теми же.
- [x] Ввести стабильный vehicle allocator, совместимый с прежними default indices. Не выделять112 фиктивных региональных машин ради старого offset.
- [x] Настроить инфраструктурные registries на исходные `Harbor`/`Railway` процедуры; default definition по-прежнему создаёт прежний порт/станцию/автобус.
- [x] Обработать отсутствие homes/school/terminal/entry/port/rail без скрытых grid defaults, новых fake actors или exception в scheduler. Для пустого мира используются0 начальных семей и действительные условия миграции.

**Checks:** default source snapshot/geometry equality; empty-definition and missing-infrastructure tests; allocator/save continuity.

**Done:** native world создаётся из данных, а контрольный прототип остаётся прежним по поведению и визуалу.

## Task4. Большая карта вокруг исходного города

**Modify:** shared native renderer/runtime, camera/bounds/shadow targeting. **Reuse:** региональные terrain generation, river/lakes/vegetation и пригодный terrain view.

- [x] RED world-bounds test: исходный город существует на карте4×4км; его native geometry и поведение не меняются от размера окружающего мира.
- [x] Подключить geography и региональный camera range; сохранить физический размер объектов, source materials/light/shadows и useful native close-up scale.
- [x] Убрать из renderer единственную обязательную sea/port/rail position; world definition определяет окружение и размещение. Не копировать `createCity` несколько раз целиком для разных городов.
- [x] Пройти исходный город на большой карте: port, поезд, автобус, school/leisure, residents/parking/строительство. Проверить последовательные кадры и pause.

**Done:** сначала один полный исходный город на большой geography, без утраченных механизмов. Этот fixture не является обязательной застройкой при создании новых регионов.

## Task5. Авторские дороги, редактор и несколько городов

**Reuse:** `region/editor.ts`, pure commands/rules/terrain/roads/parcels, townHall/territory, UI modes. **Create:** `game/regionDocument.ts`, `city/life/regionRouting.ts`, `city/life/worldReconciliation.ts`.

**Planned operations:** `applyWorldEdit(document, command)` возвращает validated document change; `CityLife.applyDefinitionUpdate(update)` применяет только согласованную topology/place change со стабильными IDs. Один profile/Population/ParkingBook обслуживает все municipalities.

- [x] Реализовать regional routing как адаптер тех же native операций к авторскому road graph; использовать пригодные graph/connection algorithms, без второго контроллера поездок.
- [x] Подключить region/city mode, ратушу с её дорогой, radius и manual upgrades к общему документу native мира.
- [x] Регистрировать native building/plot/units/business/parking по одной сущности. Render asset reference не выбирается независимо от сущности симуляции; template identity сохраняет исходный kit/сад при переносе.
- [x] Подключить исходную стройку к actual building lifecycle: готовое native место появляется в Population только после завершения. Topology update не пересоздаёт существующую Population/traffic.
- [x] Закрытие/удаление дороги проверяет текущие routes/parking; либо дождаться завершения, либо отказать. Снос ратуши/дороги остаётся согласованным действием.
- [x] Проверить две player-founded cities и межгородскую поездку/работу в одной native simulation. Новый регион запускается пустым и растёт через editor/native lifecycle.

**Checks:** graph adapter equality на prototype network; arbitrary road angles; dynamic places/finite parking; two-city trips; old controls/menu/source behaviours.

**Done:** игрок редактирует большой мир, а все жители и машины по-прежнему управляются исходным движком.

## Task6. Размещаемые native объекты и реальные товары

**Reuse after review:** existing `Harbor` parameterization, navigation, full native port views, railway placement helpers, `drawNativeBlock`, regional logistics/accounting. **Modify:** native world registries/profile/account provider, shared renderer/editor.

- [x] Зарегистрировать размещаемые native порт/вокзал/школу/парк в общем world definition. Исходные schedules/controllers не писать заново; зависимость от одного координатного адреса заменять данными.
- [x] Сохранить исходный микроавтобус, arrival selection и rail disembarkation. Native функции выбирают действительный городской entry/terminal и не забирают семью двумя транспортами.
- [x] Подключить реальную региональную логистику к native `Business`/складским inventory и одним счетам. Ни второй population model, ни зеркальный inventory не допускаются.
- [x] Account provider поддерживает уже согласованную семейную/инвесторскую/публичную собственность, цены и учёт transfers. Default prototype provider сохраняет прежний результат.
- [x] В региональном provider запретить timer shop restock; товар приходит реальным грузом. Полный port chain имеет одного владельца cargo на каждом участке.
- [x] Проверить placement/physical access/full footprint, school/leisure, cargo shipment, occupied demolition и save-mid-operation всех объектов через UI.

**Done:** каждая исходная система доступна в авторском мире, сохраняет свой механизм и участвует в общей симуляции/экономике.


**Delivered Tasks5–6:** `028e39e`, main/origin/main and primary5197 immutable checkpoint. Main fullcheck449tests/source8days; source+root/native Chromium13 cases accepted across reruns, current ordinary1000-world24s; infrastructure UI2cases16.3s and full living clone1case1.1min. Primary ordinary file import observed207buildings/1000people/250families/two towns/paused; save id native-living-region-with-services. Source9JSON snapshots and4render geometry snapshots unchanged. Screenshot `.scratch/prototype-first/stage5-6-primary.png`.

## Task7. Старые сохранения и устойчивые identities

**Create:** `game/saveMigration.ts`, import tests. **Modify:** shared storage/catalogue, native world restore and game envelope.

- [x] Составить mapping legacy regional IDs→native stable identities, сохраняя исходные внешние ID в document. Native числовые внутренние indices не должны менять принадлежность/историю.
- [x] Перенести семьи, units/ownership, people, cars/parking, business stocks/accounts, native-compatible traffic routes/reservations и живые deliveries.
- [x] Согласовать calendar anchor и physical clock: старый регион не прыгает на90минут/много суток из-за иных старых epochs. Default prototype сохраняет исходный clock.
- [x] Проверить пакет поддерживаемых старых сейвов, active arrival/parking/loaded truck/hoist. Балансы до/после равны; input record не меняется.
- [x] Unsupported payload получает ясное сообщение и сохраняемый оригинал, а не пустой мир/поддельную «успешную» загрузку.
- [x] Пересобрать только разрешённый тестовый мир под native размеры, сохранив backup. «Приозёрск» и другие ручные миры автоматически не переделывать.

**Done:** новый game envelope и допустимые legacy saves открываются обычным меню, процесс загрузки доказан на реальном мире.

## Task8. Вывести дубли из эксплуатации

**Candidates:** standalone `region/model/life/{population,residents,mobility,simulation}.ts`, regional life worker/controller и дубли renderer. Полезные validators, migration code, graph/account adapters сохраняются в соответствующих компонентах.

- [x] Доказать runtime dependency graph: root использует native `CityLife`/Population/ParkingBook/traffic; никакой второй life worker не запускается.
- [x] Удалять заменённые modules/exports/tests по coherent группам после reference/import/route checks. Не выполнять global reset каталога.
- [x] Сохранить tests настоящих региональных требований, перенаправив их к единому native core. Не сохранить тесты только потому, что они подтверждали ошибочную implementation-specific модель.
- [x] Проверить `/city/` и `/`: один renderer/runtime и default reference route, без зависимости от архивного регионального игрового ядра.

**Done:** регион остаётся редактором и данными, а не второй игрой рядом с прототипом.

## Task9. Полная приёмка и поставка

- [ ] Исходный город: все native reference checks, день/ночь/движение/карточки, source week и сохранение середины событий.
- [ ] Регион: минимум7 игровых суток с несколькими городами, работой, покупками, arrival/bus/rail, school/leisure, стройкой, портом и изменением roads.
- [ ] Достичь нагрузочного fixture >=1000 real residents и >=200 ready buildings настоящей симуляцией; не менять source composition/cadence и не вставлять fake actors. Продолжать больше недели, если требуется.
- [ ] Проверить geometry baseline, FPS>=30 на принятой desktop scene, actual worker backlog и cold/warm UI loads. Тяжёлые тесты выполнять последовательно; известный source harbor timeout сравнить с baseline и исправить подтверждённую регрессию.
- [ ] `bun run lint:fix`, `bun run format`, review diff, `bun run check`, `bun run build`, relevant Chromium and Electron gates. Electron test только `SIMCITY_TEST_WINDOW=1`, закрыть свой instance.
- [ ] Предоставить актуальную игру на `/` и обычный живой сейв без demo mode, соответствующие одной проверенной версии.
- [ ] После общей приёмки проверить, что все завершённые этапы уже интегрированы в основную ветку и опубликованы, финальный checkpoint находится в remote и основной сервер обслуживает ту же версию. Git-интеграция выполняется поэтапно по правилу выше, а не откладывается до Task9.

## Правило приёмки

Каждый этап сохраняет работоспособность уже имеющихся native механик. Контрольный исходный сценарий остаётся исполняемым; region scenarios добавляются к нему, а не подменяют его. Этап закрывается реализацией, meaningful tests, наблюдением UI/движения, save continuation и проверенной поставкой в основную сборку по правилу выше, а не наличием helper или похожих картинок.

Первый предъявляемый результат — полный исходный город на `/`. Финальный — тот же native core, обслуживающий большой редактируемый регион с несколькими городами и действительными поставками.
