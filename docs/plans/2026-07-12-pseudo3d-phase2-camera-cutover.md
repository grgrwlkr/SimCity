# Фаза 2: Camera3d cutover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** игра рендерится `Camera3d` + наклонная ортографика; весь мир — плоские Mesh3d-квады (вид «как раньше, но под углом»); пикинг/куллинг/миникарта работают. Высота зданий — фаза 5.

**Architecture (решения развилки из роадмапа):**
1. **Земля = плоскость XY, высота = +Z, камера смотрит с наклоном, up = +Z.** Все записи `translation.x/y` остаются валидными; z-слои (0/3/…/50) становятся малыми высотами над землёй (см. таблицу). `Quat::from_rotation_z` — вращение в плоскости земли, не трогается.
2. **Никаких двух камер и никаких chunk-мешей в этой фазе.** Sprite → общий unit-quad `Mesh3d` (`Rectangle`-примитив, XY-плоскость) + `MeshMaterial3d` из кэша общих unlit-материалов, ключ = quantized RGBA. Перекраска (`sprite.color = c`) → swap хендла материала. Размер (`custom_size`) → `Transform.scale`. Батчинг: mesh+material инстансинг, ~десятки материалов на 16k+ тайлов. Chunk-culling через Visibility остаётся.
3. Градиентные оверлеи (LandValue/Pollution/Height/Traffic heat) квантуются в бакеты, чтобы кэш материалов был ограничен.
4. Материалы unlit (плоская палитра как сейчас) — свет/тени приходят в фазе 5 вместе с объёмом. `Tonemapping::None` на камере сразу.
5. Route-гизмосы: `linestrip_2d`/`line_2d` (z=0, конфликт с землёй) → 3D `linestrip`/`line` на высоте.

**Высоты (бывшие z-слои), world units (tile=16):** земля 0.0; zone overlay 0.15; coverage 0.20/0.22; traffic heat 0.25; разметка 0.30 (+эпсилоны как были ×0.01); здания 0.4; глиф здания +0.05; остановки 0.45; машины/автобусы 0.5 (roof/глиф +0.05); highlight 0.55; сервисные машины/пешеходы/светофоры 0.6; маркеры ЧС 0.8; preview 0.9/0.95; day/night 40.0; route-гизмосы 0.7. Констант-модуль: `simcity_sim::game::render_primitives::layer`.

## Global Constraints

- Симуляция не меняется; determinism-пин зелёный; ambiguity-пины зелёные.
- Каждый таск: `cargo test -p simcity_sim` (или workspace) → коммит. Финал: fmt + clippy floor + workspace + запуск игры + BRP-скриншот.
- Тесты, пинившие Sprite (emergencies, services visual_tests, glyphs, харнесы), обновляются В ТОМ ЖЕ таске, что ломает их, с сохранением поведенческого смысла (цвет маркера = цвет вида ЧС и т.д.).

---

### Task 1: `render_primitives` — общий quad + кэш материалов

**Files:** Create `crates/simcity_sim/src/game/render_primitives.rs`; Modify `crates/simcity_sim/src/game/mod.rs` (регистрация).

**Produces:**
```rust
pub struct RenderPrimitives {           // Resource
    pub quad: Handle<Mesh>,             // Rectangle(1x1) в XY-плоскости
    cache: HashMap<[u8; 4], Handle<StandardMaterial>>,
}
impl RenderPrimitives {
    /// Shared unlit material for a color; alpha<255 -> AlphaMode::Blend. Quantizes to u8 RGBA.
    pub fn material(&mut self, mats: &mut Assets<StandardMaterial>, color: Color) -> Handle<StandardMaterial>;
}
pub mod layer { pub const GROUND: f32 = 0.0; /* ... вся таблица высот ... */ }
/// Bundle-хелпер: (Mesh3d, MeshMaterial3d, Transform{translation:(xy,layer), scale:(size,1)})
pub fn flat_quad(...) -> impl Bundle;
```
Init в Startup (нужны `Assets<Mesh>`). Тест: два запроса одного цвета → один хендл; разный alpha → разные.

### Task 2: камера (frontend) + Tonemapping

**Files:** `crates/simcity_frontend/src/game/camera.rs`.

Spawn: `Camera3d`, `Projection::Orthographic(OrthographicProjection { scale (как было), ..default_3d() })`, `Tonemapping::None`, `MainCamera`, `PrimaryEguiContext`. Transform: `focus + tilt * dist`, `looking_at(focus, Vec3::Z)`;
`const CAMERA_YAW: f32 = -45°; const CAMERA_PITCH: f32 = ~55°` (подбор по скриншоту), dist = 2000 (орто — влияет только на клип; far default_3d достаточен, проверить near/far).
Pan: input-вектор повернуть на CAMERA_YAW и двигать focus в XY (translation минус tilt-офсет — хранить focus в компоненте `CameraFocus(Vec2)` на камере, transform пересчитывать). Zoom: `Orthographic.scale` — код не меняется. `debug_dump` (Transform+Projection) — совместим.

### Task 3: пикинг/куллинг/миникарта через ray-plane

**Files:** `crates/simcity_core/src/game/map/coords.rs` (+тест в sim), `crates/simcity_sim/src/game/map/coords.rs` (cursor_tile), `map/render.rs` (углы вьюпорта), `crates/simcity_frontend/src/game/ui/mod.rs` (миникарта).

Core:
```rust
/// Viewport point -> logical ground (z=0 plane). None if ray is parallel/away.
pub fn viewport_to_ground(camera: &Camera, cam_gt: &GlobalTransform, viewport: Vec2) -> Option<Vec2> {
    let ray = camera.viewport_to_world(cam_gt, viewport).ok()?;
    let d = ray.direction.z;
    if d.abs() < 1e-6 { return None; }
    let t = -ray.origin.z / d;
    if t < 0.0 { return None; }
    Some((ray.origin + *ray.direction * t).truncate())
}
```
`cursor_tile` = `viewport_to_ground` → `world_to_tile`. Куллинг: 4 угла через `viewport_to_ground` (fallback как сейчас: не куллить при None), AABB по 4 проекциям — трапеция накрывается консервативно. Миникарта: те же 4 угла → min/max tile — прямоугольная аппроксимация трапеции, осознанно.
Тест: чистая математика луча (сконструировать GlobalTransform камеры руками нельзя headless без Camera — тестировать ray-plane выражение отдельной pub fn `ray_ground_t(origin: Vec3, dir: Vec3) -> Option<f32>` + roundtrip в игре глазами).

### Task 4: тайлы земли + весь recolor-конвейер

**Files:** `map/render.rs`.

Спавн тайла: `Sprite::from_color(kind.color(), splat(ts-1))` → `flat_quad(quad, material(kind.color()), tile_to_world, layer::GROUND, Vec2::splat(ts-1))`. `SyncDirtyTilesParams.q_tiles`: `(&mut Sprite, &mut TileKind)` → `(&mut MeshMaterial3d<StandardMaterial>, &mut Transform, &mut TileKind)`; тело: `sprite.color=c; sprite.custom_size=s` → `mat.0 = prims.material(&mut materials, c); tf.scale = s.extend(1.0)`. Градиенты Height/LandValue/Pollution: квантовать значение до 1/32 ПЕРЕД формированием цвета. CursorHighlight — quad.

### Task 5: статичные оверлеи и превью

**Files:** `map/lane_markings.rs`, `map/road_preview.rs`, `zone_placement.rs`, `services/overlay.rs`, `traffic/overlay.rs` (heat: квант 1/16), `day_night.rs`, `map/render.rs` (route-гизмосы → 3D на layer::ROUTE).
Механика та же; пулы хранят Entity — меняется только спавн-бандл и мутация цвета→материала.

### Task 6: агенты и маркеры

**Files:** `traffic/spawn.rs`, `public_transport.rs` (car_body_sprite → car_body_quad), `services/systems.rs`, `services/glyphs.rs`, `pedestrians/agents.rs`, `emergencies/systems.rs` (blink: два кэшированных материала), `intersections/render.rs` (светофор: 3 материала R/Y/G + серый).
Обновить тесты: emergencies (цвет через материал), services visual_tests (scale вместо custom_size), glyphs, харнесы `Sprite::default()` → квад-бандл или голый Transform, если система больше не требует Sprite.

### Task 7: верификация

fmt + clippy floor + `cargo test --workspace`; `rg "Sprite" crates/simcity_sim` → ноль боевых вхождений (кроме, возможно, комментариев); запуск `cargo run --features dev` + BRP-скриншот; глазами: наклон, пикинг (постройка дороги кликами), оверлеи, миникарта. Обновить роадмап (фаза 3 → «перф-контроль, chunk-меши только если батчинг не вытянул») и `docs/architecture.md` при расхождениях. Коммит.
