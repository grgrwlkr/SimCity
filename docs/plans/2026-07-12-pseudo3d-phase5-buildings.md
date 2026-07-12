# Фаза 5: объёмные здания + свет/тени — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans.

**Goal:** здания — процедурные vertex-colored коробки (высота = f(kind, level), полосы окон, глиф на крыше), визуал строится ОДНОЙ RenderSync-системой; decay-тинты через компонент `BuildingTint`; глобальный свет (солнце + ambient), материалы lit, тени.

**Architecture:**
1. Новый `buildings/visual.rs`: `BuildingMeshCache` (ключ kind+level+footprint), генератор `building_mesh` (Z-up: 4 стены полосами этаж/окно + крыша, vertex colors), `BuildingTint(Color)`, системы `rebuild_building_visuals` (`Added/Changed<Building>` → пересобрать child-детей: body-меш + глиф службы на крыше) и `apply_building_tint` (`Changed<BuildingTint>` + `RemovedComponents` → swap материала body: белый lit ↔ tint). Чейн rebuild→tint в `GameSet::RenderSync`.
2. **Консолидация спавна**: 4 сайта (buildings/spawn.rs, map/commands.rs ×2 undo, persistence.rs) больше НЕ создают визуал — только `Building` + `Transform` (z=layer::BUILDING). Сигнатуры теряют prims/meshes/materials (откат вчерашнего трединга). Баг «глиф теряется при загрузке» умирает архитектурно: `Added<Building>` после загрузки строит визуал сам.
3. **Decay** пишет/снимает `BuildingTint` (только при изменении значения — гейт от Changed-шторма), не трогает Assets в FixedUpdate. upgrade.rs не трогает меш (визуал перестроит система по `Changed<Building>`).
4. **Свет**: солнце (`DirectionalLight` + cascade под орто-дистанцию, позиция с +Z — мир Z-up!) + `AmbientLight` на камере; `RenderPrimitives::material` → lit (roughness 1.0); `flat_quad` получает `NotShadowCaster`. Тюнинг ambient/illuminance по in-game скриншоту.

**Tests:** пины на mesh cache (same key → same handle), высоту (level растит), rebuild (spawn Building → body-ребёнок есть; service → есть глиф), tint (insert → материал не белый, remove → белый). Существующие 262 — зелёные; determinism-пин не трогается.

**Выход фазы:** in-game скриншот с объёмными зданиями и тенями; floor зелёный; roadmap/memory обновлены.
