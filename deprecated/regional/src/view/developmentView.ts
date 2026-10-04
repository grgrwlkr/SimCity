import * as THREE from 'three';
import {
  Batch,
  type BatchPart,
} from '../../../../packages/app/src/city/primitives';
import {Construction} from '../../../../packages/app/src/city/construction';
import {
  pointInPolygon,
  rectangle,
} from '../../../../packages/app/src/region/model/geometry';
import type {
  Point,
  RegionState,
} from '../../../../packages/app/src/region/model/types';
import {createBuildingRecipe, lotDimensions} from './buildingView';
import {disposeLayer} from '../../../../packages/app/src/region/view/resources';

/** Ready buildings share draw calls; only changing construction has a clipped copy. */
export class DevelopmentView {
  readonly group = new THREE.Group();
  private readonly staticGroup = new THREE.Group();
  private readonly constructions = new Map<string, Construction>();
  private signature = '';
  private state: RegionState | null = null;

  constructor() {
    this.group.name = 'development';
    this.staticGroup.name = 'completed-buildings';
    this.group.add(this.staticGroup);
  }

  update(state: RegionState): void {
    this.state = state;
    const lots = new Map(
      [...state.parcels, ...state.warehouses].map(lot => [lot.id, lot]),
    );
    const geometry = state.life.buildings.flatMap(building => {
      const lot = lots.get(building.lotId);

      return lot
        ? [{id: building.id, kind: building.kind, lot, seed: state.seed}]
        : [];
    });
    const signature = JSON.stringify(geometry);

    const restoredConstruction = state.life.buildings.some(
      building =>
        building.stage === 'constructing' &&
        lots.has(building.lotId) &&
        !this.constructions.has(building.id),
    );

    if (signature !== this.signature || restoredConstruction) {
      this.clear();
      const batch = new Batch();

      for (const building of state.life.buildings) {
        const lot = lots.get(building.lotId);

        if (!lot) {
          continue;
        }

        const recipe = createBuildingRecipe(building, lot, state.seed);
        const transform = new THREE.Matrix4().makeRotationY(lot.heading);

        transform.setPosition(lot.center.x, 0, lot.center.z);
        const object = batch.capture(sink => {
          for (const part of recipe.parts) {
            addTransformedPart(sink, part, transform);
          }
        });

        if (building.stage === 'constructing') {
          const construction = new Construction(
            new Map([
              [
                building.id,
                {parts: recipe.parts, setVisible: object.setVisible},
              ],
            ]),
            new Map([[building.id, recipe.plot]]),
          );

          // start() runs after finish(), when the original instances can actually be hidden.
          construction.group.position.set(lot.center.x, 0, lot.center.z);
          construction.group.rotation.y = lot.heading;
          this.constructions.set(building.id, construction);
          this.group.add(construction.group);
        }
      }

      batch.finish(this.staticGroup);

      for (const [id, construction] of this.constructions) {
        construction.start(id, false);
      }

      this.signature = signature;
    }

    for (const building of state.life.buildings) {
      const construction = this.constructions.get(building.id);

      if (!construction) {
        continue;
      }
      if (building.stage === 'ready') {
        construction.seek(1);
        construction.dispose();
        construction.group.removeFromParent();
        this.constructions.delete(building.id);
      } else {
        construction.seek(building.progressSeconds / building.durationSeconds);
      }
    }
  }

  pick(point: Point): string | null {
    if (!this.state) {
      return null;
    }

    for (const building of this.state.life.buildings) {
      const lot =
        this.state.parcels.find(candidate => candidate.id === building.lotId) ??
        this.state.warehouses.find(
          candidate => candidate.id === building.lotId,
        );

      if (lot) {
        const dimensions = lotDimensions(lot);

        if (
          pointInPolygon(
            point,
            rectangle(
              lot.center,
              dimensions.width,
              dimensions.depth,
              lot.heading,
            ),
          )
        ) {
          return building.id;
        }
      }
    }

    return null;
  }

  syncLighting(): void {
    for (const construction of this.constructions.values()) {
      construction.syncLighting();
    }
  }

  private clear(): void {
    for (const construction of this.constructions.values()) {
      construction.dispose();
      construction.group.removeFromParent();
    }

    this.constructions.clear();

    for (const child of [...this.staticGroup.children]) {
      disposeLayer(child);
    }
  }

  dispose(): void {
    this.clear();
    disposeLayer(this.group);
    this.state = null;
    this.signature = '';
  }
}

function addTransformedPart(
  batch: Batch,
  part: BatchPart,
  transform: THREE.Matrix4,
): void {
  const matrix = transform.clone().multiply(part.matrix);
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  matrix.decompose(position, rotation, scale);
  const euler = new THREE.Euler().setFromQuaternion(rotation);

  batch.add(
    part.shape,
    part.color,
    position.x,
    position.y,
    position.z,
    scale.x,
    scale.y,
    scale.z,
    euler.y,
    euler.x,
    euler.z,
  );
}
