use crate::game::roads::RoadDir;

use super::super::TrafficConfig;

/// Conflict zones within an intersection cluster (coarse approximation).
///
/// This is a pragmatic step towards doc 5.4 / 7.4: allow non-conflicting maneuvers to proceed in
/// parallel without implementing full connector geometry yet.
pub type ConflictMask = u32;

pub(crate) const ZONE_CENTER: ConflictMask = 1 << 0;
pub(crate) const ZONE_NW: ConflictMask = 1 << 1;
pub(crate) const ZONE_NE: ConflictMask = 1 << 2;
pub(crate) const ZONE_SW: ConflictMask = 1 << 3;
pub(crate) const ZONE_SE: ConflictMask = 1 << 4;
pub(crate) const ZONE_ALL: ConflictMask = ZONE_CENTER | ZONE_NW | ZONE_NE | ZONE_SW | ZONE_SE;

/// Movement type through an intersection cluster.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum ManeuverKind {
    Straight,
    RightTurn,
    LeftTurn,
    UTurn,
    Other,
}

#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub struct StreamKey {
    pub entry: RoadDir,
    pub exit: RoadDir,
}

pub(crate) fn maneuver_kind(
    traffic_cfg: &TrafficConfig,
    entry: RoadDir,
    exit: RoadDir,
) -> ManeuverKind {
    if entry == RoadDir::None || exit == RoadDir::None {
        return ManeuverKind::Other;
    }
    if exit == entry {
        return ManeuverKind::Straight;
    }
    if exit == entry.opposite() {
        return ManeuverKind::UTurn;
    }
    let right = if traffic_cfg.drive_on_right {
        entry.right()
    } else {
        entry.left()
    };
    let left = if traffic_cfg.drive_on_right {
        entry.left()
    } else {
        entry.right()
    };
    if exit == right {
        return ManeuverKind::RightTurn;
    }
    if exit == left {
        return ManeuverKind::LeftTurn;
    }
    ManeuverKind::Other
}

pub(crate) fn right_turn_zone(entry_dir: RoadDir) -> ConflictMask {
    match entry_dir {
        RoadDir::North => ZONE_SE, // coming from South, turning to East uses SE corner
        RoadDir::East => ZONE_SW,  // coming from West, turning to South uses SW corner
        RoadDir::South => ZONE_NW, // coming from North, turning to West uses NW corner
        RoadDir::West => ZONE_NE,  // coming from East, turning to North uses NE corner
        RoadDir::None => ZONE_CENTER,
    }
}

pub(crate) fn left_turn_zone(entry_dir: RoadDir) -> ConflictMask {
    // Left turns cross opposing straight traffic, but NOT opposing left turns!
    // On two-way roads, opposing left turns use different corners and don't conflict.
    //
    // Real-world behavior:
    // - Northbound left turn uses NW corner
    // - Southbound left turn uses SE corner
    // - These don't overlap, so both can turn simultaneously
    match entry_dir {
        RoadDir::North => ZONE_NW, // Coming from South, turning West: uses NW corner
        RoadDir::East => ZONE_NE,  // Coming from West, turning North: uses NE corner
        RoadDir::South => ZONE_SE, // Coming from North, turning East: uses SE corner
        RoadDir::West => ZONE_SW,  // Coming from East, turning South: uses SW corner
        RoadDir::None => ZONE_CENTER,
    }
}

pub(crate) fn straight_zone(entry_dir: RoadDir) -> ConflictMask {
    // Approximate "keep right" straight-through paths by assigning them to the corresponding side
    // of the intersection, so that opposite-direction straights can proceed in parallel.
    //
    // This is still a coarse model, but it improves throughput while keeping perpendicular
    // straights conflicting.
    match entry_dir {
        RoadDir::North => ZONE_NE | ZONE_SE, // northbound (from South): use east side
        RoadDir::East => ZONE_SW | ZONE_SE,  // eastbound (from West): use south side
        RoadDir::South => ZONE_NW | ZONE_SW, // southbound (from North): use west side
        RoadDir::West => ZONE_NW | ZONE_NE,  // westbound (from East): use north side
        RoadDir::None => ZONE_CENTER,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::roads::RoadDir;

    #[test]
    fn maneuver_kind_classifies_uturn() {
        let cfg = TrafficConfig {
            drive_on_right: true,
            ..Default::default()
        };
        // Entering heading North, exiting heading South == U-turn.
        assert_eq!(
            maneuver_kind(&cfg, RoadDir::North, RoadDir::South),
            ManeuverKind::UTurn
        );
        assert_eq!(
            maneuver_kind(&cfg, RoadDir::East, RoadDir::West),
            ManeuverKind::UTurn
        );
        // Sanity: a left is still a left, straight still straight.
        assert_eq!(
            maneuver_kind(&cfg, RoadDir::North, RoadDir::West),
            ManeuverKind::LeftTurn
        );
        assert_eq!(
            maneuver_kind(&cfg, RoadDir::North, RoadDir::North),
            ManeuverKind::Straight
        );
    }
}

pub(crate) fn reservation_zones_for_maneuver(
    traffic_cfg: &TrafficConfig,
    entry_dir: RoadDir,
    exit_dir: RoadDir,
) -> Option<ConflictMask> {
    if entry_dir == RoadDir::None || exit_dir == RoadDir::None {
        return None;
    }
    if exit_dir == entry_dir {
        return Some(straight_zone(entry_dir));
    }
    let right = if traffic_cfg.drive_on_right {
        entry_dir.right()
    } else {
        entry_dir.left()
    };
    let left = if traffic_cfg.drive_on_right {
        entry_dir.left()
    } else {
        entry_dir.right()
    };
    if exit_dir == right {
        return Some(right_turn_zone(entry_dir));
    }
    if exit_dir == left {
        return Some(left_turn_zone(entry_dir));
    }
    // U-turn / unknown: be conservative.
    Some(ZONE_CENTER)
}
