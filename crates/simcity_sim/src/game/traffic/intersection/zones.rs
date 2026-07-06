use crate::game::roads::RoadDir;

use super::super::TrafficConfig;

/// Movement type through an intersection cluster.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Hash)]
pub enum ManeuverKind {
    Straight,
    RightTurn,
    LeftTurn,
    UTurn,
    Other,
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
