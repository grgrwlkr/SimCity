// Port of crates/simcity_sim/src/game/traffic/intersection/zones.rs (`ManeuverKind`, `maneuver_kind`).
import type { RoadDir } from '../commands';
import { dirLeft, dirOpposite, dirRight } from '../map/roads';
import type { TrafficConfig } from './config';

export const MANEUVER_KINDS = ['Straight', 'RightTurn', 'LeftTurn', 'UTurn', 'Other'] as const;
/** Movement type through an intersection cluster. */
export type ManeuverKind = (typeof MANEUVER_KINDS)[number];

export function maneuverKind(cfg: Pick<TrafficConfig, 'driveOnRight'>, entry: RoadDir, exit: RoadDir): ManeuverKind {
  if (entry === 'None' || exit === 'None') return 'Other';
  if (exit === entry) return 'Straight';
  if (exit === dirOpposite(entry)) return 'UTurn';
  const right = cfg.driveOnRight ? dirRight(entry) : dirLeft(entry);
  const left = cfg.driveOnRight ? dirLeft(entry) : dirRight(entry);
  if (exit === right) return 'RightTurn';
  if (exit === left) return 'LeftTurn';
  return 'Other';
}
