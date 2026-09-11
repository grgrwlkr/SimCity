// What the worker hands the debug renderer about the map: copies of the layers a tile's colour
// depends on, keyed by the versions that say when to ask again.
import type { MapConfig, MapGrid, World } from '@simcity/sim';
import type { DebugOverlayReply, MapLayersReply } from './protocol';

export function renderLayersOf(
  grid: MapGrid,
  cfg: MapConfig,
  mapEditVersion: number,
  graphVersion: number,
): MapLayersReply {
  return {
    width: grid.width,
    height: grid.height,
    tileSize: cfg.tileSize,
    mapEditVersion,
    graphVersion,
    layers: {
      water: grid.water.slice(),
      roadKind: grid.roadKind.slice(),
      roadDir: grid.roadDir.slice(),
      zone: grid.zone.slice(),
      building: grid.building.slice(),
    },
  };
}

export function debugOverlayOf(w: World): DebugOverlayReply {
  return {
    graphVersion: w.graphVersion,
    laneletsBuiltFor: w.laneletGraph.builtFor,
    clusters: w.intersections.clusters.map((c) => ({ id: c.id, tiles: c.tiles.flatMap((p) => [p.x, p.y]) })),
    lanelets: w.laneletGraph.lanelets.map((ll) => {
      const entry = w.laneGraph.getLane(ll.entryLane)?.pos;
      const exit = w.laneGraph.getLane(ll.exitLane)?.pos;
      const tiles = [...(entry ? [entry] : []), ...ll.internalPath, ...(exit ? [exit] : [])];
      return { intersection: ll.intersection, maneuver: ll.maneuver, path: tiles.flatMap((p) => [p.x, p.y]) };
    }),
  };
}
