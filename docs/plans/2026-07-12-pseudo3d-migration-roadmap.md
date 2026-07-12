# Миграция рендера в псевдо-3D (Camera3d + orthographic) — мастер-роадмап

> Статус: активен. Детальные TDD-планы пишутся по одной фазе за раз
> (см. `2026-07-12-pseudo3d-phase1-coords.md`). Бэкап 2D-состояния: ветка `backup/2d-topdown` (a33a7ea).

**Цель:** заменить top-down 2D-рендер (процедурные `Sprite`) на настоящий 3D с фиксированной
ортографической камерой под углом: процедурные меши, vertex colors, depth-буфер вместо z-слоёв.
Симуляция (`simcity_sim` логика, `FixedUpdate`, детерминизм) не меняется.

**Выбор варианта (2026-07-12):** вариант C («настоящий 3D + орто-камера») выбран против
oblique-2.5D и честной 2D-изометрии по итогам аудита рендер-поверхностей (9 агентов, 40 файлов)
и валидирующего прототипа `examples/pseudo3d_proto.rs` (коммит cfecff6). Ключевые аргументы:
- мир остаётся в своих логических координатах — наклон делает камера на GPU;
- окклюзию решает depth-буфер: класс проблем ручного y-sort исчезает (в Bevy 0.19 встроенного
  y-sort нет — проверено по исходнику `bevy_sprite_render`, sort_key = translation.z);
- разметка полос и всё плоское на земле не перепроецируется;
- свободный поворот машин (`atan2`) сохраняется — не нужны направленные спрайты;
- батчинг: vertex colors (`Mesh::ATTRIBUTE_COLOR`) + один белый `StandardMaterial`.

**Стилистика:** low-poly flat-shaded, палитра из `TileKind::color()`/`BuildingKind::color()`,
`Tonemapping::None`, солнце с тенями (`CascadeShadowConfigBuilder`, maximum_distance под
дистанцию орто-камеры). Референс — прототип.

## Инварианты (не ломать ни в одной фазе)

1. **Детерминизм**: fingerprint-пин в `simcity_data/determinism.rs` зелёный. Рендер-системы не
   читают/не пишут sim-состояние; позиции агентов — `Vehicle.prev/curr_world_pos` и TilePos.
2. **GameSet-дисциплина**: новые Update-системы явно в `GameSet::RenderSync`; новые
   FixedUpdate-системы — в свой саб-сет (иначе падают ambiguity-пины).
3. **Intersection Traffic Invariants (STRICT)** из `docs/architecture.md` — визуальная миграция
   не трогает траектории/гарды/семантические конфликты.
4. **Логические координаты мира неизменны**: sim живёт в плоскости XY (`Vec2`), tile_size из
   `map.ron`. Маппинг sim(x,y) → render(x, 0, -y)... фиксируется в фазе 2 и живёт в ОДНОМ месте.
5. **Наблюдаемость**: BRP/MCP-дамп и debug_world под `dev` продолжают работать; формат
   `DebugDumpCamera` меняется осознанно (фаза 2), потребители предупреждены.
6. Каждая фаза заканчивается: `cargo fmt --all` → `clippy --all-targets --all-features -D warnings`
   → `cargo test --workspace` → коммит на main.

## Фазы

### Фаза 0 — бэкап и план ✅
Ветка `backup/2d-topdown`, прототип на main, этот роадмап.

### Фаза 1 — централизация координат (детальный план: `...-phase1-coords.md`)
Единственный источник tile↔world: `simcity_core::game::map::coords` (pub). Убить 9 дублей
`fn map_origin` + ~20 inline-формул `origin + Vec2::new(x*ts, ...)` в 16 файлах
(simcity_sim, simcity_data, simcity_frontend). Roundtrip- и equivalence-тесты в simcity_sim.
Семантика floor-мапинга чанк-куллинга (`render.rs`) сохраняется отдельной функцией.
**Выход:** `rg "fn map_origin"` находит только core; поведение бит-в-бит (determinism-пин).

### Фаза 2 — Camera3d + пикинг + миникарта
`Camera2d` → `Camera3d` + `Projection::Orthographic` + наклонный Transform (+`Tonemapping::None`,
солнце и ambient как в прототипе). `PrimaryEguiContext` переезжает на новую камеру (bevy_egui 0.40
это поддерживает — проверено их примером split_screen). Пикинг: `viewport_to_world_2d` →
`viewport_to_world` (луч) + пересечение с плоскостью земли, ТОЛЬКО в `cursor_tile()`.
Чанк-куллинг: AABB по 4 лучам углов вьюпорта (консервативно). Миникарта: видимая область через
те же 4 луча. Пан/зум камеры; `ui_settings` (новые параметры), `DebugDumpCamera`, хоткеи+README.
**Риск:** до фазы 3 мир всё ещё спрайтовый — 2D-спрайты не рендерятся Camera3d; фазы 2+3
идут в одной сессии либо фаза 2 временно держит обе камеры (2D для мира, 3D скрыта) — решить
при написании детального плана.

### Фаза 3 — тайловая сетка → chunk-меши
16 384 tile-Sprite → merged Mesh3d на чанк 16×16 с vertex colors (стиль прототипа: зазор 0.8,
тёмная подложка). Конвейер `DirtyTiles`-перекраски: мутация вершинных цветов чанка вместо
`sprite.color` (плюс пересчёт Aabb не требуется — геометрия не меняется). 5 tint-оверлеев
(Height/Water/Roads/LandValue/Pollution) едут поверх этого механизма без изменения логики.
**Перф-гейт:** Tracy-прогон, полный recolor карты ≤ бюджета кадра.

### Фаза 4 — разметка, оверлеи, превью
`lane_markings` (геометрия НЕ меняется — плоские квады в плоскости земли), светофоры,
road_preview, zone_placement, coverage/traffic-heat оверлеи, CursorHighlight, route-гизмосы
(`linestrip` уже в мировых координатах — проверить работу гизмо-пайплайна с 3D-камерой).
day/night: world-quad → затемнение через свет/экранный оверлей.

### Фаза 5 — здания
Консолидация 4 спавн-сайтов визуала (buildings/spawn.rs, map/commands.rs ×2 undo,
persistence.rs) в одну RenderSync-систему «Building added/changed → построить меш-детей»
(заодно чинится баг: `spawn_building_entity_from_snapshot` теряет глифы сервисных зданий).
Vertex-colored коробки: высота = f(level) (level наконец видим), полосы окон, уступы, глифы
служб на крыше. Decay-тинты: sim пишет компонент `BuildingTint`, RenderSync применяет.
**Внимание:** контраст палитры зона-vs-крыша (урок прототипа); soak-инвариант глиф-маркеров.

### Фаза 6 — агенты
Машины/автобусы/службы/пешеходы → Mesh3d-композиты (прототип). `interpolate_vehicle_position` —
явно в `GameSet::RenderSync` (сейчас без сета — известная гонка), поворот `atan2` остаётся.
Пешеходам — prev/curr-интерполяция как у машин (вынос Transform-записи из sim-системы).
Маркеры ЧП/остановки — билборды или объёмные глифы. Обновить visual-пины
(vehicle_spawning.rs Transform==tile_to_world, emergencies Sprite.color, харнесс-заглушки).

### Фаза 7 — полиш и зачистка
Свет/тени/палитра-тюнинг, перф (Tracy: батчинг, ≤ дистанций каскадов), удаление мёртвого
2D-кода (Sprite-пути), выпил `examples/pseudo3d_proto.rs` или переориентация в витрину,
`day_night.ron`-тюнинг, README/docs синхронизация (`architecture.md`, `debugging-and-observability.md`).

## Известные грабли (из аудита и прототипа)

- **10 копий формулы координат** — фаза 1 обязана пройти ДО любых визуальных правок.
- `viewport_to_world_2d` с 3D-камерой возвращает мусор молча — оба call-site (coords.rs,
  render.rs культинг) мигрируют в фазе 2.
- Тесты пинят текущий рендер: `vehicle_spawning.rs:239-245`, `emergencies/tests.rs` (Sprite.color),
  ~6 харнесов со `Sprite/Transform`-заглушками — править по фазам осознанно.
- Скриншот раньше ~3.5 с после старта — чёрный (прогрев Metal-пайплайнов).
- Дефолтные shadow-каскады не достают до орто-камеры на 500 юнитов.
- Дефолтный тонмаппер гасит плоскую палитру — `Tonemapping::None`.
- Материал на цвет = смерть батчинга; vertex colors + один материал.
- `AmbientLight` в Bevy 0.19 — компонент камеры, не ресурс; `DirectionalLight.shadow_maps_enabled`.

## Оценка

Токены (спекуляция ±50%): ~25-45M суммарно; фазы 1-2 самые дешёвые, фаза 3 — перф-риск,
фазы 5-6 — основной визуальный полиш. Каждая фаза — отдельная сессия с коммитом.
