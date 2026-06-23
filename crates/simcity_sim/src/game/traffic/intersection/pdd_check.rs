//! Проверка соблюдения ПДД на нерегулируемых перекрёстках (GDD 8.1).
//!
//! Согласно GDD, симуляция трафика должна быть основана на физике машин и строгом ПДД.
//! Машины-агенты должны следовать правилам ПДД в игре и соблюдая их перемещаться к нужной точке.
//!
//! Текущая реализация использует систему резерваций (IntersectionReservations), которая:
//! - Проверяет конфликтные зоны для предотвращения столкновений
//! - Использует приоритеты манёвров (Straight > RightTurn > LeftTurn)
//! - Учитывает светофоры для регулируемых перекрёстков
//!
//! Требуется доработка для полного соответствия ПДД:
//! 1. "Помеха справа" для равнозначных дорог (при равном приоритете манёвра)
//! 2. Определение главной дороги по ширине/типу дороги (RoadKind)
//! 3. Учёт знаков приоритета (IntersectionPriority::MainRoad, YieldSign)

use crate::game::intersections::IntersectionPriority;
use crate::game::roads::{RoadDir, RoadKind};

/// Проверить, должна ли машина уступить дорогу на нерегулируемом перекрёстке.
///
/// Правила ПДД:
/// - Если есть знак "Главная дорога" - имеет приоритет
/// - Если есть знак "Уступи дорогу" - уступает
/// - Если дороги равнозначны - применяется "помеха справа"
/// - Главная дорога определяется по ширине/типу (более широкая = главная)
#[allow(dead_code)] // Reserved for future PDD-based admission rules
pub fn should_yield_at_uncontrolled_intersection(
    _entry_dir: RoadDir,
    _entry_road_kind: RoadKind,
    _other_entry_dir: RoadDir,
    _other_road_kind: RoadKind,
    _priority: IntersectionPriority,
) -> bool {
    // TODO: Реализовать полную логику ПДД:
    // 1. Проверить знаки приоритета (MainRoad, YieldSign)
    // 2. Сравнить ширину дорог (более широкая = главная)
    // 3. Если равнозначны - применить "помеху справа"

    // Временная реализация: используем текущую систему приоритетов манёвров
    // из plan_intersection_reservations
    false
}

/// Определить, является ли дорога главной на основе её типа/ширины.
///
/// Правило: более широкая дорога (больше полос) = главная. Если равны — дороги равнозначны
/// (не главная). Сравниваем по `RoadKind::lanes()` (2/4/6), а НЕ по `capacity_per_lane_tile()`:
/// последний округляет capacity/lanes до 2 для всех типов, поэтому никогда не различает ширину.
#[allow(dead_code)] // Reserved for future PDD-based admission rules
pub fn is_main_road(road_kind: RoadKind, other_road_kind: RoadKind) -> bool {
    road_kind.lanes() > other_road_kind.lanes()
}

/// Проверить "помеху справа" для равнозначных дорог.
///
/// Правило ПДД: при равнозначных дорогах уступает тот, у кого помеха справа.
#[allow(dead_code)] // Reserved for future PDD-based admission rules
pub fn has_right_of_way_obstacle(entry_dir: RoadDir, other_entry_dir: RoadDir) -> bool {
    // Определить, находится ли other_entry_dir справа от entry_dir
    let right_dir = entry_dir.right();
    other_entry_dir == right_dir
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::roads::RoadKind;

    #[test]
    fn main_road_is_the_wider_kind() {
        assert!(is_main_road(RoadKind::SixLane, RoadKind::TwoLane));
        assert!(is_main_road(RoadKind::FourLane, RoadKind::TwoLane));
        assert!(is_main_road(RoadKind::SixLane, RoadKind::FourLane));
        assert!(!is_main_road(RoadKind::TwoLane, RoadKind::FourLane));
        // Equal width: not main (равнозначные дороги).
        assert!(!is_main_road(RoadKind::TwoLane, RoadKind::TwoLane));
        assert!(!is_main_road(RoadKind::FourLane, RoadKind::FourLane));
    }
}
