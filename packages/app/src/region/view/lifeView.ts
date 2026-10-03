import * as THREE from 'three';
import {
  MovingAssets,
  personParts,
  vehicleParts,
  type AssetPart,
} from '../../city/assetParts';
import {personKit, vehicleKit} from '../../city/assetKits';
import type {LanePose} from '../../city/trafficRoutes';
import {distance} from '../model/geometry';
import {parkingPoint, resolvePlace} from '../model/life/routes';
import type {Point, RegionState} from '../model/types';
import {disposeLayer} from './resources';

interface Actor {
  id: string;
  kind: 'person' | 'car' | 'truck';
  trafficIndex: number | null;
}
interface VisibleActor {
  id: string;
  point: Point;
  radius: number;
}

/** Saved actors own all positions; instances contain no autonomous traffic or population. */
export class LifeView {
  readonly group = new THREE.Group();
  private assets: MovingAssets | null = null;
  private actors: Actor[] = [];
  private poses: THREE.Matrix4[] = [];
  private visible: VisibleActor[] = [];
  private signature = '';
  private state: RegionState | null = null;
  private center: Point = {x: 0, z: 0};
  private radius = Infinity;
  private readonly transform = new THREE.Object3D();

  constructor() {
    this.group.name = 'regional-life';
  }

  update(state: RegionState): void {
    this.state = state;
    const carIndices = new Set(state.life.cars.map(car => car.trafficIndex));
    const truckIndices = (state.life.traffic?.vehicles ?? []).flatMap(
      (_, index) => (carIndices.has(index) ? [] : [index]),
    );
    const signature = JSON.stringify([
      state.seed,
      state.life.people.map(person => [person.id, person.age]),
      state.life.cars.map(car => [car.id, car.trafficIndex]),
      truckIndices,
    ]);

    if (signature !== this.signature) {
      for (const child of [...this.group.children]) {
        disposeLayer(child);
      }

      const recipes: AssetPart[][] = [];

      this.actors = [];

      for (const person of state.life.people) {
        const kit = personKit(state.seed, person.id);

        if (person.age < 18) {
          kit.height *= 0.7;
        }

        recipes.push(personParts(kit));
        this.actors.push({id: person.id, kind: 'person', trafficIndex: null});
      }

      state.life.cars.forEach(car => {
        recipes.push(
          vehicleParts({
            ...vehicleKit(`${state.seed}:${car.id}`, 0),
            body: 'sedan',
            length: 4.2,
            width: 1.8,
          }),
        );
        this.actors.push({
          id: car.id,
          kind: 'car',
          trafficIndex: car.trafficIndex,
        });
      });

      for (const index of truckIndices) {
        recipes.push(
          vehicleParts({
            ...vehicleKit(state.seed, index),
            body: 'truck',
            roof: 'bare',
            length: 6.5,
            width: 2.3,
          }),
        );
        this.actors.push({
          id: `truck-${index}`,
          kind: 'truck',
          trafficIndex: index,
        });
      }

      this.assets = new MovingAssets(this.group, recipes);
      this.poses = this.actors.map(() => new THREE.Matrix4());
      this.signature = signature;
    }

    this.updatePoses();
  }

  private updatePoses(): void {
    const state = this.state;

    if (!state || !this.assets) {
      return;
    }

    const trips = new Map(state.life.trips.map(trip => [trip.actorId, trip]));
    const cars = new Map(state.life.cars.map(car => [car.id, car]));
    const people = new Map(
      state.life.people.map(person => [person.id, person]),
    );
    const trucks = new Map(
      state.life.trips
        .filter(trip => trip.mode === 'truck')
        .map(trip => [trip.trafficIndex, trip]),
    );

    this.visible = [];
    this.actors.forEach((actor, index) => {
      let pose: LanePose | null = null;
      let id = actor.id;

      if (actor.kind === 'person') {
        const person = people.get(actor.id);
        const trip = trips.get(actor.id);

        if (
          person &&
          person.activity !== 'outside' &&
          person.activity !== 'passenger' &&
          trip &&
          (trip.mode === 'walk' || trip.phase !== 'travel')
        ) {
          pose = trip.pose;
        }
      } else if (actor.kind === 'car') {
        const car = cars.get(actor.id);
        const parked = car?.parkedAt ? resolvePlace(state, car.parkedAt) : null;

        if (car && parked && car.parkingSlot !== null) {
          const point = parkingPoint(parked, car.parkingSlot);

          pose = {
            ...point,
            dx: Math.sin(parked.heading),
            dz: Math.cos(parked.heading),
          };
        } else if (actor.trafficIndex !== null) {
          pose = state.life.traffic?.vehicles[actor.trafficIndex]?.pose ?? null;
        }
      } else if (actor.trafficIndex !== null) {
        const trip = trucks.get(actor.trafficIndex);

        if (trip) {
          pose =
            state.life.traffic?.vehicles[actor.trafficIndex]?.pose ?? trip.pose;
          id = trip.id;
        }
      }
      if (!pose || distance(this.center, pose) > this.radius) {
        this.poses[index]!.makeScale(0, 0, 0);

        return;
      }

      this.transform.position.set(pose.x, 1.13, pose.z);
      this.transform.rotation.set(0, Math.atan2(pose.dx, pose.dz), 0);
      this.transform.scale.set(1, 1, 1);
      this.transform.updateMatrix();
      this.poses[index]!.copy(this.transform.matrix);
      this.visible.push({
        id,
        point: pose,
        radius:
          actor.kind === 'person' ? 1 : actor.kind === 'truck' ? 3.5 : 2.5,
      });
    });
    this.assets.update(this.poses, state.life.elapsedSeconds / 60);
  }

  setDetail(center: Point, radius: number): void {
    if (
      center.x === this.center.x &&
      center.z === this.center.z &&
      radius === this.radius
    ) {
      return;
    }

    this.center = {...center};
    this.radius = radius;
    this.updatePoses();
  }

  // Snapshot poses and game time drive movement and gait; real time never advances either.
  readonly animate: (seconds: number, paused: boolean) => void = () => {};

  pick(point: Point): string | null {
    let best: VisibleActor | null = null;
    let nearest = Infinity;

    for (const actor of this.visible) {
      const separation = distance(point, actor.point);

      if (separation <= actor.radius && separation < nearest) {
        best = actor;
        nearest = separation;
      }
    }

    return best?.id ?? null;
  }

  dispose(): void {
    disposeLayer(this.group);
    this.assets = null;
    this.actors = [];
    this.poses = [];
    this.visible = [];
    this.state = null;
    this.signature = '';
  }
}
