# Gameplay

Это текущий implemented surface проекта, а не wishlist.

## Boot Flow

Сейчас проект загружается в dev-friendly режиме:

- приложение стартует в `MainMenu`
- затем автоматически переводится в `InGame`
- после этого отправляется `LoadTestCity`

Из-за этого test city остаётся основным default flow, даже при наличии scenario system.

## Map And Building Tools

Что есть сейчас:

- процедурная карта `128x128`
- вода, высота и базовые terrain данные в `MapGrid`
- cursor hover / cursor highlight
- point-to-point road building
- drag-paint для зон и erase
- отдельные инструменты для service buildings и `TrafficLight`
- inspect tool через UI

Практический UX:

- road tool работает в два клика: старт и конец сегмента
- `Esc` или `Right click` отменяют текущую дорожную заготовку
- зоны и другие paint-friendly инструменты работают через удержание ЛКМ
- строительство разрешено даже на паузе

## Roads And Mobility

Текущий mobility stack включает:

- дороги `2/4/6` полос
- `one-way` режим
- lane graph + region graph + road graph
- cached pathfinding
- traffic occupancy / congestion / heatmap
- intersection reservations
- traffic lights
- pedestrian graph и walking logic
- parking / parked vehicle index

Current implementation shape:

- транспортная инфраструктура уже зрелая и составляет самый сложный кусок проекта
- pathfinding infra поддерживает shared path storage и caching

## Zones, Buildings, Economy

Сейчас реализованы:

- R/C/I zoning
- рост зданий и уровни
- construction / operational phases
- occupancy и target occupancy
- decay по нескольким причинам
- land value
- pollution
- базовая экономика города
- employment и commute stats

Service buildings:

- fire station
- police station
- hospital

## Citizens, Trips, Traffic

Игровой loop уже не абстрактный:

- граждане существуют как отдельные агенты
- поездки оформлены через `TripRequested` / `TripFinished`
- транспорт и пешеходные leg-ы встроены в симуляцию
- congestion влияет на дорожный слой
- emergency/service vehicles тоже участвуют в общей транспортной картине

Public transport тоже есть, но пока как MVP:

- `PublicTransportPlugin`
- `BusRouteManager`
- default route spawn при пустом route manager
- одна базовая автобусная логика на маршрут

То есть public transport уже есть в коде, но это пока не зрелая player-facing система.

## Scenarios And Saves

В проекте уже есть:

- scenario catalog из `assets/scenarios/scenarios.ron`
- стартовые условия, seed, starting money/day
- optional `initial_commands`
- objectives по population / money / happiness
- save/load в `saves/slot{N}.ron`

Текущий practical nuance:

- сценарии существуют
- но default startup path всё ещё подчинён auto-loaded test city
- это надо считать известным UX debt

## UI And Observability

В проекте уже есть полноценный debug-friendly UI:

- top status bar
- bottom toolbar
- right sidebar
- stats window
- building popup
- shortcuts panel
- debug dump window
- MCP activity indicator
- telemetry-backed debug dump copy/save flow

## Current Limitations

- main menu / scenario selection пока не являются главным фактическим boot flow
- save/load есть, но help text в UI уже расходится с фактическими биндами
- public transport пока MVP-уровня
- traffic correctness ещё не закрыта полностью: остаются TODO вокруг wrong-way detection и ПДД edge cases
- производительность уже целенаправленно оптимизируется, но roadmap для масштабирования всё ещё активен

## Next Improvements

- Добить correctness транспортного слоя: wrong-way detection, priority logic, right-of-way integration tests.
- Дорастить public transport из MVP до нормальной gameplay-подсистемы.
- Развязать default boot flow с auto test city, чтобы scenarios и main menu стали реальным entrypoint.
- Подчистить UX-долги: актуальные help/shortcuts, честные save/load affordances, меньше dev-only поведения на старте.
