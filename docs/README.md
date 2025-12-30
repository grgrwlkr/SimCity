# Docs index

Основные документы проекта.

> ⚠️ **Важно:** При реализации новых функций и изменении существующих систем:
> 1. **Изучите** соответствующие файлы архитектуры перед началом работы
> 2. **Проверьте** зависимости в `system-dependencies.md` — изменения могут затронуть другие системы
> 3. **Обновите** документацию после внесения изменений, чтобы она оставалась актуальной

## 📋 Статус реализации (Обновлено: Январь 2025)

### ✅ Выполненные улучшения (2025-01)

**UI и UX:**
- ✅ UI Redesign (status bar, toolbar, sidebar)
- ✅ Undo/Redo система (Ctrl+Z, Ctrl+Y)
- ✅ Tooltips для всех элементов
- ✅ Shortcuts panel (клавиша ?)
- ✅ Notifications система
- ✅ UI Settings панель (F10)
- ✅ Улучшенные графики с hover

**Дороги и трафик:**
- ✅ Односторонние дороги (RoadFlow)
- ✅ Полосы поворота (LaneType)
- ✅ Остановка на красный свет
- ✅ Учёт светофоров в pathfinding
- ✅ Жёлтый сигнал светофора
- ✅ Правила приоритета перекрёстков

**Здания и экономика:**
- ✅ Уровни зданий (до 3 уровней)
- ✅ Land Value система
- ✅ Pollution система

### 🔲 Приоритетные улучшения (следующие шаги)

1. **Weighted Pathfinding** — учёт пробок в маршрутизации
2. **RCI Demand System** — расширение логики спроса
3. **Building Demolition/Decay** — система разрушения зданий
4. **Persistence v2** — сохранение новых фич
5. **Interactive Minimap** — клик для перемещения камеры
6. **Context Menu** — контекстное меню по правому клику

## Общая архитектура

- `master-plan.md` — **архитектура + MVP/эпики + детальный план реализации**
- `project-status-and-roadmap.md` — **текущее состояние проекта + план дальнейших улучшений**
- `persistence-contract.md` — **контракт сохранения: что является истиной, что сохраняем**
- `system-dependencies.md` — **взаимосвязи и зависимости всех систем**
  - Карта зависимостей модулей (17 модулей)
  - Порядок выполнения систем (GameSet: Input → CommandApply → GraphUpdate → Sim → PostSim → RenderSync → Ui)
  - Ключевые точки синхронизации (GraphVersion, has_adjacent_road, TrafficOccupancy)
  - Критические зависимости и контракты между системами
  - Матрица влияния изменений
  - Типичные проблемы и их решения
  - Безопасные и опасные модификации
  - Рекомендации для улучшений с учётом зависимостей

## Производительность и масштабирование

- `performance-audit.md` — **Performance & Architecture Audit**: узкие места, guardrails и roadmap до **1,000,000 агентных машин** + рендер 1M инстансов.

## Перекрёстки

- `intersections-architecture.md` — **детальная документация системы перекрёстков**
  - Архитектура модуля и структуры данных
  - Автоматическое создание перекрёстков при пересечении дорог
  - Алгоритм обнаружения перекрёстков
  - Правила движения через перекрёсток (въезд, циркуляция, выезд)
  - Светофоры: управление, фазы, визуализация
  - **Выполненные улучшения (2025-01):**
    - ✅ **Остановка на красный свет** — через VehicleTrafficState компонент
    - ✅ **Учёт светофоров в pathfinding** — penalty за задержку на перекрёстках
    - ✅ **Жёлтый сигнал светофора** — LightPhase enum с жёлтой фазой
    - ✅ **Правила приоритета** — IntersectionPriority компонент (yield/stop signs)
  - **Планируемые улучшения:**
    - Стрелки светофора
    - Адаптивные светофоры и "зелёная волна"
    - Круговое движение (roundabout)
    - Пешеходные переходы
    - Многоуровневые развязки
    - ИИ-оптимизация и V2I коммуникация

## Трафик и транспортные средства

- `traffic-vehicles-architecture.md` — **детальная документация системы трафика и машин**
  - Архитектура модулей (traffic.rs, transport.rs, roads.rs, trips.rs)
  - Структуры данных (Vehicle, TrafficOccupancy, TrafficIndex, RoadGraph, PathCache)
  - Жизненный цикл машины (создание → движение → прибытие)
  - A* маршрутизация с иерархическим поиском (RegionGraph)
  - Кеширование путей (TTL + LRU + версионирование)
  - Метрики трафика (congestion, EMA heatmap)
  - Визуализация и LOD culling
  - Текущие ограничения системы
  - **15 возможных улучшений** с приоритетами и реализацией:
    - Динамическая скорость от типа дороги
    - Замедление при загруженности
    - Car Following Model (IDM)
    - Плавное ускорение/торможение
    - Типы транспортных средств (Car, Truck, Motorcycle, Bus)
    - Система парковок
    - Время суток (Peak Hours)
    - ДТП и аварии
    - Погодные условия
    - Экстренный транспорт с приоритетом
    - GPS-навигация с пересчётом маршрута
    - Очереди на въезд/выезд
    - ML оптимизация потоков
    - Автономные транспортные средства
    - GPU-ускоренная симуляция

## Здания и зонирование

- `buildings-zoning-architecture.md` — **детальная документация системы зданий и зонирования**
  - Архитектура модулей (buildings.rs, zone_placement.rs, demand.rs, employment.rs, services.rs, land_value.rs, pollution.rs)
  - Структуры данных (ZoneKind, BuildingKind, Building, MapCell, LandValueIndex, PollutionIndex)
  - Система зонирования (R/C/I зоны, правила размещения, кеширование)
  - Рост зданий (алгоритм, период, проверка спроса, декай)
  - RCI Demand (расчёт спроса, формулы, баланс)
  - Служебные здания (Fire/Police/Hospital, радиус покрытия)
  - Занятость населения (assign_jobs, EmploymentStats)
  - Визуализация (оверлеи зон, покрытие услугами, land value, pollution)
  - **Выполненные улучшения (2025-01):**
    - ✅ **Уровни зданий** (Level 1-3) — система upgrade_buildings()
    - ✅ **Land Value** — система стоимости земли с влиянием на рост зданий
    - ✅ **Pollution** — система загрязнения от промышленных зданий
  - **Планируемые улучшения:**
    - Время строительства
    - Многотайловые здания (2×2, 3×3)
    - Специализация зон (Office, Retail, Heavy/Light Industry)
    - Заброшенные здания (Abandonment)
    - Исторические здания
    - Школы и университеты
    - Плотность застройки (Low/Medium/High Density)
    - Landmark Buildings
    - Procedural Building Generation
    - Экономическая симуляция зданий
    - ИИ-планировщик застройки

## Дороги

- `roads-architecture.md` — **детальная документация системы дорог**
  - Архитектура модулей (roads.rs, map/mod.rs, transport.rs)
  - Структуры данных (RoadKind, RoadDir, RoadCell, RoadFlow, LaneType, RoadGraph, GraphVersion)
  - Система полос (Lane System): размещение, индексация, крайние полосы
  - Построение дорог (point-to-point, compute_road_line, emit_road_commands)
  - Граф дорог (RoadGraph): bitmask связности, rebuild_road_graph
  - Правила движения (прямо, смена полосы, повороты, перекрёстки)
  - Визуализация (разметка, центральная линия, стрелки, превью)
  - **Выполненные улучшения (2025-01):**
    - ✅ **Односторонние дороги** — RoadFlow enum (TwoWay, OneWay)
    - ✅ **Полосы поворота** — LaneType enum (Regular, LeftTurnOnly, RightTurnOnly, StraightOnly)
  - **Планируемые улучшения:**
    - Разные типы дорог (Highway, Arterial, Local)
    - Диагональные дороги
    - Кривые и дуги
    - Мосты и тоннели
    - Разделительные полосы (Median)
    - Износ покрытия
    - Тротуары и велодорожки
    - Парковочные полосы
    - Автобусные полосы (Bus/HOV lanes)
    - Железнодорожные переезды
    - Процедурная генерация сети
    - Динамическая разметка (Variable Message Signs)

## Интерфейс (UI)

- `ui-architecture.md` — **детальная документация системы интерфейса**
  - Архитектура модулей (ui.rs, ui_state.rs, ui_settings.rs, notifications.rs, command_history.rs, camera.rs, commands.rs)
  - Структуры данных (UiState, ToolMode, OverlayMode, SimSpeed, UiMetrics, UiHistory, UiSettings, Notifications)
  - Компоненты интерфейса (Top Status Bar, Bottom Toolbar, Right Sidebar, Inspector, Minimap, Statistics, Building Popup)
  - Система инструментов (Tool → BuildMode → GameCommand)
  - Оверлеи (None, Water, Height, Zones, Roads, Traffic, Path, ServiceCoverage, LandValue, Pollution)
  - Камера и навигация (WASD pan, mouse wheel zoom)
  - Команды и взаимодействие с симуляцией
  - **Выполненные улучшения (2025-01):**
    - ✅ **UI Redesign** — разделение на status bar, toolbar, sidebar
    - ✅ **Undo/Redo система** (Ctrl+Z, Ctrl+Y)
    - ✅ **Tooltips** для всех элементов
    - ✅ **Shortcuts panel** (клавиша ?)
    - ✅ **Notifications** система
    - ✅ **UI Settings** панель (F10)
    - ✅ **Улучшенные графики** с hover
  - **Планируемые улучшения:**
    - Интерактивная миникарта
    - Brush size для зонирования
    - Tutorial система
    - Локализация (i18n)
    - Custom hotkeys
    - UI sounds
    - Context menu (правый клик)
    - Drag & drop строительство

