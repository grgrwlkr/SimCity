# Этап 5 — рендер: чистая математика

> Программа: `docs/plans/2026-09-11-ts-threejs-migration-plan.md`, строка этапа 5. Эта часть этапа не встраивает ничего в кадр: только функции и данные в `packages/render`, которые сцена этапа 5 возьмёт после слияния с 3½. `debugRenderer.ts`, `interpolate.ts`, `packages/bridge` и `packages/sim` не трогаются.

**Цель:** инварианты Rust-тестов рендера живут в Vitest над функциями без сцены: кэш материалов, процедурный атлас, день-ночь, план проекции камеры, разрешение настроек рендера, виньетка, перерисовка слоёв данных и превью инструмента. Параметры из `assets/config/render.ron` и `day_night.ron` лежат константами с именем файла в комментарии, как `defaultTrafficConfig` и `economy.ron`: загрузчик RON появится на этапе 6.

## Инварианты Rust-тестов

Выписаны до чтения реализации. Порт — `packages/render/test/<модуль>.test.ts`, имя теста в camelCase.

### `crates/simcity_sim/src/game/render_primitives.rs` (8) → `renderPrimitives.ts`

1. `material_cache_keys_on_the_atlas_cell_too` — ячейка атласа входит в ключ материала: плоский, асфальт и тротуар одного цвета — три разных материала, повторный запрос асфальта отдаёт тот же.
2. `vertex_mapped_materials_are_their_own_thing` — материал с UV из вершин отличается и от плоского, и от ячеечного, дедуплицируется, привязывает атлас и не сдвигает UV (тождественное преобразование).
3. `the_plain_cell_is_what_the_old_call_gives` — `material(c)` — это `materialIn(c, Plain, 1)`.
4. `the_repeat_count_is_part_of_the_key` — число повторов текстуры входит в ключ: асфальт ×1 и ×3 — разные материалы.
5. `material_cache_dedups_same_color` — один цвет — один общий материал, в кэше одна запись.
6. `material_cache_quantizes_to_u8` — цвета, различающиеся меньше кванта u8, дают один материал.
7. `translucent_gets_own_blend_material` — альфа входит в ключ, полупрозрачный цвет получает материал со смешиванием.
8. `car_and_meeple_caches_dedup` — одна сетка машины на габарит, одна сетка человечка на цвет одежды.

### `crates/simcity_sim/src/game/atlas.rs` (9) → `atlas.ts`

1. `vertex_mapped_uvs_land_inside_their_cell_and_span_it` — UV из вершин любой ячейки в углах и центре грани остаются в её столбце и строке и покрывают не меньше 98 % ячейки.
2. `two_cells_never_overlap_in_vertex_space` — центр фасада и центр гравийной крыши — разные UV.
3. `every_ground_kind_gets_a_surface_and_none_stays_flat` — каждый вид тайла получает текстурную ячейку, не `Plain`; дорога — асфальт, вода — вода, коммерческая зона — та же поверхность, что жилая.
4. `every_cell_sits_in_its_own_corner_of_the_atlas` — каждая ячейка в пределах сетки атласа и в своём слоте.
5. `a_cells_uv_transform_stays_inside_that_cell` — UV-преобразование ячейки переводит единичный квадрат внутрь ячейки.
6. `the_plain_cell_is_flat_and_the_others_are_not` — `Plain` целиком 255, у остальных размах красного канала больше 20.
7. `cell_detail_survives_being_minified` — после усреднения блоками 8×8 размах средних больше 8 у каждой непустой ячейки.
8. `cells_average_near_white_so_colours_survive` — среднее по ячейке в 215..256, иначе атлас темнит палитру.
9. `the_atlas_is_the_same_every_run` — два построения атласа побайтно равны.

### `crates/simcity_sim/src/game/day_night.rs` (7) → `dayNight.ts`

1. `night_factor_extremes` — полночь > 0.99, полдень < 0.01, 18 часов в 0.3..0.7.
2. `lighting_follows_game_hour` — в полночь окна светятся (эмиссия > 1), солнце < 15 % дневного; в полдень окна тёмные (< 0.01), солнце > 90 % дневного.
3. `shop_signs_light_up_after_dark_and_go_out_at_noon` — вывески светятся в полночь (> 1) и гаснут в полдень (< 0.01), общим с окнами значением.
4. `daytime_anchors_come_from_the_config` — полуденные солнце и ambient равны значениям конфига, ночные — долям конфига.
5. `illuminance_scale_multiplies_the_sun_at_every_hour` — `illuminanceScale` умножает солнце в полдень и в полночь и не трогает ambient.
6. `lighting_levels_interpolate_between_the_configured_night_floor_and_full_day` — уровни линейны между ночным полом и полным днём (половина пути — 0.55 при поле 0.10), пол — живая ручка, вход вне 0..1 зажимается.
7. `a_data_map_is_read_in_daylight_whatever_the_hour` — пока включена карта данных, свет полуденный; выключена — снова час часов.

### `crates/simcity_frontend/src/game/camera_projection.rs` (7) → `cameraProjection.ts`

1. `close_zoom_is_perspective_and_far_zoom_is_orthographic` — ниже `orthoAboveZoom` перспектива, на пороге и выше — орто.
2. `the_orthographic_side_frames_what_bevy_frames` — орто-план кадрирует ту же высоту, что настоящая орто-камера движка при том же масштабе; в TS спрашивается `THREE.OrthographicCamera`.
3. `visible_height_does_not_jump_at_the_threshold` — видимая высота по обе стороны порога отличается меньше чем на 1 %.
4. `visible_height_tracks_zoom_everywhere` — видимая высота равна `viewport × zoom` с точностью 2 % на 0.05..1.0.
5. `the_orthographic_boom_stays_where_the_shadow_cascades_expect_it` — орто-камера стоит на `orthoDistance`, а не на пределе перспективы.
6. `the_boom_never_leaves_the_configured_range` — дистанция камеры в `minDistance..maxDistance` на всём диапазоне зума.
7. `perspective_weakens_as_the_camera_pulls_back` — FOV монотонно убывает с зумом, у порога уже меньше 25°.

### `crates/simcity_frontend/src/game/render_settings.rs` (8) → `renderSettings.ts`

1. `tonemapping_maps_every_configured_curve` — каждая кривая конфига отображается в тонмаппинг движка.
2. `ssao_quality_maps_every_configured_level` — каждый уровень SSAO отображается в свой уровень качества движка.
3. `config_reaches_the_camera_and_the_sun` — разрешённые настройки несут тонмаппинг конфига, bloom с его интенсивностью и размером мипа, SSAO Medium, экспозицию, контраст и насыщенность, направление солнца из высоты и азимута и каскады теней.
4. `soft_shadow_size_reaches_the_sun_and_zero_means_hard_edges` — `softSize` 2.5 доходит до солнца, 0 — жёсткие тени (`null`), а не полутень нулевой ширины.
5. `ssao_forces_msaa_off_and_falls_back_to_fxaa` — SSAO с запрошенным MSAA выключает MSAA и включает FXAA.
6. `msaa_survives_when_ssao_is_off` — без SSAO MSAA 4 остаётся, FXAA нет.
7. `disabled_effects_are_removed_not_merely_ignored` — выключенные bloom и SSAO отсутствуют в настройках.
8. `sun_direction_points_down_from_overhead_and_sideways_from_the_horizon` — солнце в зените светит в −Z, на горизонте на севере — в −Y, на 15° единичный вектор с z в −0.3..−0.2.

### `crates/simcity_frontend/src/game/vignette.rs` (4) → `vignette.ts`

1. `vignette_is_clear_in_the_middle_and_darkest_in_the_corners` — в центре и внутри чистого радиуса альфа 0, в углу равна силе, между ними монотонно растёт.
2. `vignette_strength_zero_is_fully_transparent` — при силе 0 альфа везде 0.
3. `vignette_image_has_a_transparent_centre_and_opaque_corner` — текстура виньетки: центр прозрачен, угол при силе 1 — альфа > 200.
4. `vignette_steps_aside_while_a_data_map_is_on` — пока включена карта данных, виньетка скрыта; без неё возвращается.

### `crates/simcity_sim/src/game/map/render.rs` (5) → `overlayRepaint.ts`

Скриншотные тесты из задачи оказались тестами системы `mark_dirty_on_index_publish`: какие тайлы перерисовать, когда индекс данных опубликовал порцию. Это функция без Bevy.

1. `utility_network_overlay_repaints_when_the_network_changes` — новая версия сети снабжения перекрашивает всю карту на слоях снабжения; слой стоимости земли её не замечает.
2. `pollution_overlay_tiles_refresh_when_index_publishes_a_chunk` — публикация порции загрязнения помечает тайлы этой порции и только их.
3. `land_value_overlay_tiles_refresh_when_index_publishes_a_chunk` — публикация последней порции стоимости земли (индекс перешёл на порцию 0) помечает последнюю порцию.
4. `city_fields_overlay_tiles_refresh_when_the_fields_publish_a_chunk` — порция городских полей помечается на слое преступности; слой стоимости земли её не замечает.
5. `index_publish_does_not_mark_tiles_when_overlay_is_off` — без слоя данных публикации ничего не помечают.

### `crates/simcity_sim/src/game/map/preview.rs` (9) → `toolPreview.ts`

Тоже функция без Bevy: цена, радиус, эффект и вердикт инструмента под курсором из сетки и казны.

1. `tool_preview_prices_a_road_tile_its_upgrade_and_a_crossing` — новая дорога стоит цену полосы-тайла, апгрейд — разницу, та же дорога — 0; эффект говорит «road».
2. `tool_preview_refuses_a_road_on_water_and_a_downgrade_but_not_debt` — дорога на воде и даунгрейд отказаны с причиной, долг не мешает.
3. `tool_preview_zone_verdict_is_the_zoning_rule` — вердикт зоны совпадает с `canZoneTile` на каждом тайле, зонирование бесплатно, отказ всегда с причиной, вдали от дороги причина про дорогу.
4. `tool_preview_service_shows_price_and_radius_and_why_it_cannot_go_here` — служба показывает цену и радиус; отказ вдали от дороги, без денег, на занятом месте и у края карты — с причиной.
5. `utility_network_station_tools_show_price_and_supply_not_a_radius` — станции снабжения: цена, без радиуса, эффект называет ресурс, вдали от дороги отказ.
6. `milestone_locked_building_preview_says_when_it_unlocks` — закрытое вехой здание говорит, при каком населении откроется; парк открыт сразу.
7. `service_building_tools_show_price_and_radius` — школа, университет, парк: цена > 0 и радиус.
8. `tool_preview_service_verdict_is_the_placement_rule` — вердикт службы совпадает с `validateBuildingPlacement` 3×3 на каждом тайле.
9. `tool_preview_signal_bulldozer_inspect_and_off_the_map` — светофор только на перекрёстке, снос пустого и воды отказан, дороги — можно, инспектор превью не даёт, вне карты — отказ.

## Встраивание, после 3½

Требует сцены или GPU и в эту часть не входит:
- инстансированный псевдо-3D: здания, машины, человечки и пропсы как `InstancedMesh` с материалами из кэша `renderPrimitives.ts`;
- текстура атласа в `THREE.DataTexture` с мипами и UV-преобразованием ячейки на материале;
- пост-обработка на GPU: тонмаппинг, bloom, GTAO, FXAA/MSAA, цветокоррекция, виньетка поверх кадра, каскадные тени солнца по разрешённым настройкам `renderSettings.ts`;
- переключение камеры между перспективой и орто по `projectionPlan` и управление зумом этой камеры;
- эмиссия окон и вывесок и уровни света из `dayNight.ts` по часам мира;
- слои данных на карте, которые перерисовываются по `overlayRepaint.ts`, и призрак инструмента с подписью из `toolPreview.ts`;
- скриншотные ворота этапа: Chromium и WebKit, 4 ракурса × 2 времени суток;
- остальные сетки `render_primitives.rs` без тестов (светофор, дерево, фонарь, провод, вывеска, урна, маркиза, припаркованная машина, квадрат заданного размера) и высоты слоёв `layer::*`: портируются вместе со сценой, которая их ставит.

`buildings/visual.rs` (6) из строки этапа в эту задачу не входит: высота и цвет здания уже портированы в `buildingLook.ts`.

## Сделано / Отклонения / Замеры

**2026-09-14.** Все модули портированы, коммит на модуль. Тесты по файлам `packages/render/test`:

| Модуль | Rust | Vitest |
|---|---|---|
| `atlas.ts` | 9 | 10 |
| `renderPrimitives.ts` | 8 | 8 |
| `dayNight.ts` | 7 | 8 |
| `renderConfig.ts` | — | 3 |
| `cameraProjection.ts` | 7 | 7 |
| `renderSettings.ts` | 8 | 8 |
| `vignette.ts` | 4 | 4 |
| `overlayRepaint.ts` | 5 | 5 |
| `toolPreview.ts` | 9 | 8 |

Отклонения:
- Атлас портирован раньше `render_primitives.rs`: ключ материала содержит `AtlasCell`.
- `aRepeatedCellWrapsInsideItsCell` — новый тест. В Rust `uv_transform` умножал размер ячейки на число повторов, и квадрат на три тайла читал две соседние ячейки. Здесь повтор заворачивается внутри ячейки (`mapCellUv`); шейдер сцены делает то же через `fract`.
- Параметры `render.ron`, `day_night.ron` и `props.ron` (`sign.night_emissive`) — константы в `renderConfig.ts`, как `defaultTrafficConfig`. Тесты `renderConfig.test.ts` читают сами файлы и падают, если значение разошлось или появился ключ без константы. Где файл расходится с дефолтами Rust-кода, взят файл: bloom выключен, ночные полы 0.30 / 1.0.
- `lightingFollowsGameHour` и `aDataMapIsReadInDaylightWhateverTheHour` идут с ночными полами 0.10 / 0.45. Rust-тесты не вставляли `RenderConfig` и работали на дефолтах кода, а не на `render.ron`. С полом 0.30 из файла солнце в полночь — 30 % дня, пин «< 15 %» к нему не относится. Пороги не менялись.
- `theLightMovesWithinAnHour` — новый тест: при времени 1:1 свет учитывает минуты и не прыгает раз в игровой час.
- `theOrthographicSideFramesWhatThreeFrames` вместо проверки против Bevy: высоту кадра считают матрицы проекции `THREE.OrthographicCamera` и `THREE.PerspectiveCamera`. Перспективная камера проверена тоже, потому что Three.js принимает FOV в градусах.
- `TonyMcMapface` → `NeutralToneMapping`: такой кривой в Three.js нет, а PBR Neutral подходит под описание в конфиге («нейтральная, мягче ACES»). Уровни SSAO → число сэмплов GTAO 4 / 8 / 16 / 32. Тест требует, чтобы уровни были разными и цена росла.
- Настройки рендера и превью — значения, а не компоненты Bevy: `resolveRenderSettings` и `previewToolAt` (`refusal: string | null` вместо `Result`).
- `milestone_locked_building_preview_says_when_it_unlocks` не портирован: в `packages/sim` нет вех. Замок добавится в `previewToolAt` вместе с ними.
- `overlayRepaint.ts` помечает тайлы в `DirtyTiles` из `packages/sim`. Версия индекса ниже виденной считается новым индексом и перекрашивает всю карту; в Rust это давал `wrapping_sub`.
- Найдено рядом, не правилось (`packages/sim` чужой): `CityFields.version` растёт только в `resetValues`, пересчёта полей порциями в порте нет, так что слои полей города пока нечем освежать.
- Коммит `f26ffa6` объявил второй `Vec3`, и `tsc -p packages/render` падал до исправления `60649a5`.
- Пины не ослаблялись, `docs/oracle-deviations.md` не менялся.

Замеры:
- B до правок: Vitest 86 файлов, 520 тестов, 26.5 с.
- G: `bun run typecheck`, `bun run lint`, `bun run test` зелёные, 95 файлов, 581 тест, 41.0 с. e2e не гонялся: `packages/app` не тронут.
