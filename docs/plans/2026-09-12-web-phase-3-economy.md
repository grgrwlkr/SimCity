# Этап 3 — экономика и здания: план

> Программа: `docs/plans/2026-09-11-ts-threejs-migration-plan.md`. В Rust на этап приходится около 9 тыс. строк и 115 тестов в 13 файлах, поэтому этап делится на три под-этапа, у каждого свои ворота. 3a детализирован ниже, 3b и 3c детализируются перед своим стартом. Исполняется inline, код в коммитах.

**Цель:** зоны застраиваются, здания заселяются, растут в уровнях и приходят в упадок. Город платит за дороги и станции, собирает налоги по классам, берёт кредиты. Жители работают и ездят сами, советник называет проблемы города.

**Ворота этапа вместо сверки с Rust** (по поправке программы: ворота — инварианты и поведение):
- город, построенный командами, живёт 30 игровых дней;
- здания всех трёх зон растут, население больше нуля и растёт первые 10 дней;
- месячный отчёт бюджета каждый месяц сходится с изменением казны;
- фингерпринт двух прогонов совпадает;
- тик тестового города с экономикой замерен в `bench`.

## Под-этапы и ворота

| | Что | Тесты | Ворота |
|---|---|---|---|
| 3a | здание и его фазы, футпринт, досягаемость дороги, заселение, стройка, рост, апгрейд, упадок, парковка, причины не расти, сеть электричества, воды и мусора | `buildings/tests.rs` 21, `blockers.rs` 16, `utilities.rs` 8 | карта из команд: дороги, три вида зон, электростанция, насос. За 10 игровых дней вырастают здания всех трёх зон, население больше нуля. Квартал без электричества не растёт |
| 3b | бюджет, налоги по классам, содержание, финансирование служб, кредиты, спрос RCI и по классам, стоимость земли, загрязнение, занятость, жители и их поездки | `economy.rs` 18, `demand.rs` 9, `land_value.rs` 3, `pollution.rs` 2, `employment.rs` 5, `citizens.rs` 2 | 30 дней на том же городе: отчёты сходятся с казной, занятые больше нуля, машины ездят по поездкам жителей, а не по сценарию |
| 3c | поля города (преступность, пожароопасность, здоровье, образование, привлекательность), советник, вехи, лента событий | `city_fields.rs` 9, `advisor.rs` 11, `milestones.rs` 2, `notifications.rs` 9 | ворота этапа выше |

## Решения, общие для этапа

1. **Здания — записи с устойчивым id в `World.buildings`.** Обход по возрастанию id. Правда о тайлах — слой `building` сетки, как в Rust. Порядок сущностей Bevy не повторяется.
2. **Входы, которые считают следующие под-этапы**, в 3a появляются как ресурсы мира: спрос RCI, поля города, стоимость земли. У них значения по умолчанию и сеттеры для тестов, а считающие системы приходят в 3b и 3c.
3. **`exp` и `ln`.** Lint запрещает float-функции `Math.*`, потому что их результат зависит от движка. Логистика давления заселения и аннуитет кредита считаются функциями `math.ts` только на `+ − × ÷` с фиксированным числом шагов. Такой расчёт одинаков в любом движке, и тест сверяет его с таблицей значений.
4. **Конфиги экономики и занятости** — константы TS со значениями из `assets/config/*.ron`. Загрузчик RON приходит на этапе 6.
5. **Вид здания** (высота и цвет по плотности и классу) — чистые функции в `packages/render`, туда же переносится тест. Отрисовка зданий — этап 5; в отладочном рендере здания уже видны по слою `building`.
6. **Жители.** `CityCommuteScenario` остаётся временным источником поездок до 3b. В 3b поездки создают жители `citizens.rs`, и сценарий города переходит на них.
7. **Службы.** Станции и покрытие служб приходят в 3b как данные. Расчёт покрытия (`services/coverage.rs`) переносится туда же, если ему не нужны машины служб, иначе ждёт этапа 4. Решу, прочитав файл.

## 3a: инварианты из Rust-тестов

| Rust-тест (файл) | Инвариант |
|---|---|
| `building_footprint_tiles_returns_correct_tiles` (buildings/tests.rs) | футпринт 3×4 — 12 тайлов от якоря, последний (x+2, y+3) |
| `building_area_calculates_correctly` | площадь = ширина × длина |
| `building_is_operational_returns_correct_phase` | в работе только фаза `Operational` |
| `building_calculate_construction_days_scales_with_area` | дни стройки = base(уровень) × √(площадь / 9), не больше 3: L1 3×3 — 2, L1 6×6 — 3, L3 3×3 — 3 |
| `is_within_zone_depth_finds_road_at_zero_distance` | тайл дороги сам в досягаемости |
| `is_within_zone_depth_finds_road_at_adjacent_tile` | соседняя дорога — в досягаемости |
| `is_within_zone_depth_finds_road_at_max_depth` | дорога ровно в `MAX_ZONE_DEPTH` шагах — в досягаемости |
| `is_within_zone_depth_returns_false_beyond_max_depth` | дальше — нет |
| `is_footprint_within_zone_depth_checks_all_tiles` | каждый тайл футпринта в досягаемости какой-то дороги |
| `calculate_pressure_at_midpoint_returns_approximately_half` | логистика давления в середине ≈ 0.5 |
| `calculate_pressure_above_midpoint_returns_high_value` | выше середины > 0.9 |
| `calculate_pressure_below_midpoint_returns_low_value` | ниже середины < 0.1 |
| `calculate_target_ratio_clamps_correctly` | целевая доля = 2 × давление, зажата в [0, 1] |
| `calculate_fill_days_scales_with_level_and_area` | дни заселения = base(уровень) × √(площадь / 9): 1.0, 3.5, 7.0 |
| `calculate_fill_days_scales_with_pressure` | выше давление — быстрее заселение |
| `capacity_scales_with_area_per_gdd` | вместимость = base(вид, уровень) × площадь / 9: жильё 4 и 8, торговля 3 и 6 |
| `occupancy_increases_even_when_fill_days_gt_two` | за день заселение растёт и при дне заселения больше двух |
| `calculate_parking_spots_single_spot_at_center` | одно место — в центре 3×3 |
| `calculate_parking_spots_multiple_spots_distributed` | 4 места — внутри 6×6 |
| `calculate_parking_spots_respects_footprint_bounds` | 9 мест — внутри 4×4 |
| `economic_decay_abandons_unprofitable_building` | убыточное здание: первый день взводит упадок, при накопленных убытках больше 100 здание сносится |
| `utility_network_growth_blockers_name_the_missing_utility` (blockers.rs) | причины не расти по порядку: нет электричества, нет спроса, нет дороги, нет зоны |
| `utility_network_unpowered_zone_does_not_grow` | без электричества зона не растёт, с ним растёт |
| `utility_network_unpowered_building_loses_its_occupants` | без электричества жильцы уходят, цель заселения 0 |
| `utility_network_tile_diagnosis_names_the_reason_for_a_player` | диагноз тайла словами: «Won't grow: No power», «No power: occupants are leaving», «No water: cannot rise above level 1» |
| `utility_network_feed_reports_buildings_without_power_where_they_are` | на все здания без электричества одна строка Warning с местом первого |
| `zone_density_sets_footprint_levels_capacity_and_height` | стороны по плотности (3,4) / (3,6) / (3,6), уровни (1,2) / (1,3) / (2,3), High вмещает больше Medium, высота растёт с плотностью |
| `zone_density_high_zone_grows_beside_a_single_road` | High-зона глубиной 3 у одной дороги растёт |
| `zone_density_a_large_building_filling_at_the_market_pace_is_not_abandoned` | здание, заполняющееся в темпе рынка, не сносится; пустое через 50 дней или без цели — приходит в упадок |
| `zone_density_high_zone_grows_large_tall_buildings_and_low_zone_small_ones` | размер и стартовый уровень нового здания — по плотности зоны |
| `zone_density_class_changes_how_many_a_building_holds` | жильцов: Low > Middle > High |
| `zone_density_dense_buildings_stand_taller_and_class_shows_in_colour` | высота по плотности, цвет по классу (рендер) |
| `utility_network_building_without_water_stays_at_level_one` | блокер апгрейда: нет электричества, нет воды, нет спроса, верхний уровень |
| `city_fields_fire_hazard_holds_buildings_back` | пожароопасность выше порога не пускает на следующий уровень |
| `city_fields_poor_health_keeps_homes_below_level_three` | плохое здоровье не пускает жильё на уровень 3, первый шаг — пускает |
| `city_fields_unattractive_zone_does_not_grow_and_says_why` | непривлекательная зона не растёт и называет причину |
| `city_fields_uneducated_neighbourhood_grows_no_high_class_jobs` | без образования рабочие места не бывают High |
| `utility_network_power_follows_roads_not_distance` (utilities.rs) | электричество идёт по связной компоненте дорог станции; тайл без дороги рядом тёмный |
| `utility_network_demolishing_the_station_darkens_its_road_component` | снос станции гасит только её компоненту |
| `utility_network_each_kind_comes_from_its_own_station` | вода от насоса, мусор от свалки, у больницы вида нет |
| `utility_network_building_is_served_when_any_footprint_tile_fronts_a_supplied_road` | здание снабжено, если любой тайл футпринта у снабжённой дороги |
| `service_building_a_power_plant_supplies_the_nearest_buildings_up_to_its_capacity` | станция на 5000 единиц снабжает ближайших по дороге, дальше темно; баланс спроса и нехватка |
| `service_building_a_second_power_plant_ends_the_shortage` | вторая станция покрывает спрос |
| `utility_network_demand_follows_the_buildings_day_by_day` | спрос сети перечитывается раз в день |
| `utility_network_recomputes_after_a_map_edit_and_only_then` | сеть пересчитывается после правки карты и по дню, иначе стоит |

## 3a: файлы и контракты

- `packages/sim/src/buildings/`:
  - `building.ts`: запись здания, фазы, профиль (плотность, класс), вместимость;
  - `zoneDepth.ts`, `occupancy.ts`, `construction.ts`, `growth.ts`, `spawn.ts`, `upgrade.ts`, `decay.ts`, `population.ts`;
  - `blockers.ts`: причины не расти, диагноз тайла, строка ленты.
- `packages/sim/src/utilities.ts`: сеть, снабжение по мощности, пересчёт.
- `packages/sim/src/economy/`: в 3a только `WealthClass` и параметры упадка.
- `World`: `buildings`, `utilityNetwork`, `utilitySupply`, `rciDemand`, `cityFields`, `landValue`; все, кроме `rciDemand`, `cityFields` и `landValue`, — в фингерпринте.
- Расписание по Rust: `SimStep::Buildings` после занятости и перед службами и трафиком, `PostSimStep::Utilities` после покрытия.

## 3b: инварианты из Rust-тестов

| Rust-тест (файл) | Инвариант |
|---|---|
| `budget_report_lines_sum_to_the_treasury_change` (economy.rs) | строки бюджета в сумме равны изменению казны |
| `budget_report_a_month_closes_after_its_days_and_the_next_begins` | месяц закрывается на своём последнем дне в отчёт, следующий начинается пустым с казны на конец |
| `budget_report_daily_economy_goes_through_the_ledger` | день экономики двигает деньги только строками: налог жильцов положителен, дороги отрицательны |
| `maintenance_per_building_a_service_station_costs_its_upkeep_once_whatever_its_footprint` | станция службы платит своё содержание один раз, сколько бы тайлов ни занимала |
| `maintenance_per_building_zoned_buildings_cost_the_city_nothing` | здания зон содержания не стоят; без людей, дорог и станций день пуст |
| `maintenance_per_building_roads_cost_per_tile` | 250 тайлов дороги по 10 за сотню — 25 в день, округление один раз |
| `maintenance_per_building_utility_stations_cost_their_upkeep_once_open` | электростанция, насос и свалка платят с открытия; строящаяся — нет |
| `service_building_school_university_and_park_charge_their_upkeep_once_open` | школа 25, университет 60, парк 5 — с открытия |
| `zone_density_tax_comes_from_the_class_a_building_was_built_with` | налог по классу, с которым здание построено, а не по земле сегодня |
| `tax_rate_defaults_to_nine_percent_everywhere_and_is_capped_at_twenty` | ставка 9 % везде, потолок 20, ставки независимы |
| `tax_rate_class_comes_from_the_land_value_under_the_building` | класс земли: 0.33 Low, 0.34 и 0.66 Middle, 0.67 High |
| `tax_rate_residential_tax_follows_residents_class_and_rate` | налог жильцов = люди × доход класса × ставка класса / 100 |
| `tax_rate_commercial_and_industrial_tax_follow_jobs` | налог торговли и промышленности — по рабочим местам и своей ставке |
| `budget_report_funding_defaults_to_full_and_is_capped` | финансирование 100 %, потолок 150; радиус не растёт выше 100 % и не падает ниже половины |
| `maintenance_per_building_service_upkeep_follows_its_funding` | содержание службы масштабируется финансированием |
| `budget_report_monthly_payment_is_the_annuity` | платёж — аннуитет с округлением вверх: 10 000 → 889 |
| `budget_report_a_loan_is_income_the_day_it_is_taken` | кредит — доход в день взятия; только размеры банка, не больше трёх |
| `budget_report_loan_payments_close_every_month_until_repaid` | платежи в последний день месяца, выплаченный кредит уходит |
| `maintenance_per_building_underfunded_station_covers_less` (services/coverage.rs) | при половинном финансировании край полного радиуса не покрыт без правки карты |
| `budget_report_building_a_road_is_a_construction_line` (map/tests.rs) | стоимость дороги — строка «стройка» месяца |
| `zone_density_class_demand_follows_each_class_job_gap` (demand.rs) | разрыв работ и работников класса двигает спрос: жильё туда, где работ больше |
| `rci_demand_default_to_zero` | спрос по умолчанию ноль |
| `commute_bonus_calculated_correctly`, `land_value_penalty_calculated_correctly`, `density_bonus_capped_correctly`, `pollution_saturation_capped_correctly` | в Rust это арифметика внутри теста; в TS формулы вынесены в функции, тест проверяет их |
| `commercial_demand_bootstraps_from_population_with_zero_shops` | город с людьми и без магазинов хочет торговлю |
| `tax_rate_demand_shift_is_neutral_at_the_default_rate` | сдвиг спроса ставкой: 9 % — 0, 20 % — −0.44, 0 % — +0.18 |
| `tax_rate_raising_a_rate_lowers_that_zone_and_class_demand` | ставка класса роняет спрос зоны и сильнее всего своего класса, остальные не трогает |
| `land_value_uses_per_tile_service_coverage` (land_value.rs) | покрытый службами тайл дороже непокрытого |
| `city_fields_crime_lowers_land_value` | преступность дешевит землю |
| `land_value_uses_local_traffic_heat_not_citywide_average` | местная пробка дешевит землю рядом |
| `source_tile_never_reads_zero_after_first_full_pass` (pollution.rs) | после первого прохода тайл у завода не бывает нулём |
| `pollution_clears_within_one_full_pass_after_source_removed` | без завода загрязнение уходит за один проход |
| `zone_density_unemployment_is_counted_by_the_class_of_the_home` (employment.rs) | безработица по классу дома; богатый не берёт бедную работу |
| `unreachable_cache_key_is_directional`, `…_expires_after_ttl_ticks`, `…_enforces_capacity_with_lru_touch`, `…_clears_on_graph_version_change` | кеш недостижимых пар направленный, стареет по TTL, вытесняет давно не тронутые, чистится со сменой графа |
| `recover_stuck_trips_reverts_orphaned_but_keeps_in_progress_and_stable` (citizens.rs) | застрявший дольше 180 с в пути житель возвращается домой, остальные не трогаются |
| `cleanup_despawns_over_capacity_citizens_highest_id_first` | лишние жильцы уходят со старших id |

## 3b: файлы и решения

- `packages/sim/src/economy/economy.ts`: конфиг, `TaxRates`, `ServiceFunding`, `Loans`, `BudgetLedger`, `applyDailyEconomy`. Стоимость дорог и зданий идёт строкой `Construction` через тот же журнал, иначе отчёт не сойдётся с казной.
- `packages/sim/src/services/coverage.ts`: станции и покрытие. **Станция — работающее здание службы у дороги**, выводится из записей зданий. В Rust компонент вешался один раз и оставался, в том числе на стройке и после потери дороги. Машины служб — этап 4.
- `pollution.ts`, `landValue.ts`, `demand.ts` (+ `ClassDemand`), `employment.ts`, `citizens.ts`.
- **Дом и работа жителя — id здания, а не тайл якоря.** В Rust работник оставался при новом здании на том же якоре.
- **Режим поездки всегда `Car`**: пешеходы — этап 4.
- **Завершение поездки жители читают в том же тике**, сразу после трафика. События тика в TS не живут два цикла, как сообщения Bevy.
- `CityCommuteScenario` остаётся нагрузкой для ворот трафика. `?scenario=city` строит город со станциями, и поездки там создают жители.
- Расписание по Rust: `SimStep::Citizens` и `Employment` перед зданиями; `PostSimStep` Citizens → TrafficIndex → Pollution → Coverage → Utilities → LandValue → EmploymentStats → Demand → Economy.

## Сделано / Отклонения / Замеры

### 3a

- **Портировано 45 тестов 3a и 8 соседних из `map/tests.rs`.**
  - Из `map/tests.rs`: размещение станции по команде и её цена, отказ без дороги, снос здания целиком по любому тайлу, отмена и повтор с восстановлением записи, отмена зоны под выросшим зданием, таблицы служб и станций.
  - Тест вида здания живёт в `packages/render`.
  - Добавлен тест `expF64` против движка.
- **Ворота — `gate3a.test.ts`.** Город из команд: дорога, три зоны, электростанция и насос по `PlaceBuilding`. За 10 игровых дней здания всех трёх зон работают, население больше нуля, квартал на дороге без станции пуст. Спрос в тесте задан руками, расчёт спроса приходит в 3b.
- **Прогон:** vitest 67 файлов / 395 тестов, typecheck, lint — зелёные.

**Отклонения от Rust**

1. **Рост и снос здания поднимают `mapEditVersion`.** Rust версию не трогал, но отладочный рендер и сеть снабжения перечитывают слой зданий именно по ней.
2. **Стройка, заселение, население и строка ленты про электричество стоят в конце `FIXED_UPDATE`.** В Rust это `Update` после фиксированных тиков кадра, порядок внутри тика тот же.
3. **Размещение школы и университета пока не проверяет вехи** — они приходят в 3c.
4. **Системы упадка идут каждый тик, как в Rust.** Результат меняется только с днём, но так нарушение дороги ловится в тот же тик.

**Замеры:** на тестовом городе с 300 жителями за 1500 тиков `updateUtilityNetwork` берёт 77 мс из 1,7 с: пересчёт раз в игровой день, около 13 мс на карту 128×128. `growBuildings` берёт 4 мс. Остальное — трафик.
