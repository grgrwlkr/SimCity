import type {RegionalLifeState} from './life/types';

export type EntityId = string;
export interface Point {
  readonly x: number;
  readonly z: number;
}
export interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}
export interface Terrain {
  readonly bounds: Bounds;
  readonly water: ReadonlyArray<readonly Point[]>;
  readonly seed: string;
}
export interface RegionRules {
  readonly startingCash: number;
  readonly roadCostPerMeter: number;
  readonly warehouseCost: number;
  readonly roadWidth: number;
  readonly snapDistance: number;
}
export interface Settlement {
  readonly id: EntityId;
  readonly name: string;
  readonly center: Point;
  readonly townHall?: {
    readonly roadId: EntityId;
    readonly heading: number;
    readonly level?: number;
  };
}
export interface Road {
  readonly id: EntityId;
  readonly points: readonly Point[];
}
export type ZoneKind = 'residential' | 'commercial' | 'industrial';
export interface RoadAccess {
  readonly roadId: EntityId;
  readonly segment: number;
  readonly offset: number;
}
export interface Parcel {
  readonly id: EntityId;
  readonly settlementId: EntityId;
  readonly center: Point;
  readonly heading: number;
  readonly width: number;
  readonly depth: number;
  readonly zone: ZoneKind;
  readonly access: RoadAccess | null;
}
export interface Warehouse {
  readonly id: EntityId;
  readonly settlementId: EntityId;
  readonly center: Point;
  readonly heading: number;
  readonly access: RoadAccess | null;
}
export interface ExternalEntry {
  readonly id: EntityId;
  readonly roadId: EntityId;
  readonly endpoint: 'start' | 'end';
}
export interface RegionState {
  readonly schemaVersion: 3;
  readonly life: RegionalLifeState;
  readonly id: EntityId;
  readonly seed: string;
  readonly terrain: Terrain;
  readonly rules: RegionRules;
  readonly revision: number;
  readonly roadRevision: number;
  readonly nextId: number;
  readonly cash: number;
  readonly settlements: readonly Settlement[];
  readonly roads: readonly Road[];
  readonly parcels: readonly Parcel[];
  readonly warehouses: readonly Warehouse[];
  readonly externalEntries: readonly ExternalEntry[];
}
export type RegionAction =
  | {readonly type: 'found'; readonly name: string; readonly center: Point}
  | {
      readonly type: 'road';
      readonly points: readonly Point[];
      readonly settlementId?: EntityId;
    }
  | {readonly type: 'upgrade-town-hall'; readonly settlementId: EntityId}
  | {
      readonly type: 'zone';
      readonly settlementId: EntityId;
      readonly kind: ZoneKind;
      readonly selection: Bounds;
    }
  | {
      readonly type: 'warehouse';
      readonly settlementId: EntityId;
      readonly center: Point;
    }
  | {
      readonly type: 'external-entry';
      readonly roadId: EntityId;
      readonly endpoint: 'start' | 'end';
    }
  | {readonly type: 'remove'; readonly id: EntityId};
export type RejectReason =
  | 'invalid-input'
  | 'outside'
  | 'outside-city'
  | 'upgrade-requirements'
  | 'max-level'
  | 'water'
  | 'occupied-building'
  | 'busy-entry'
  | 'occupied'
  | 'overlap'
  | 'no-road'
  | 'no-settlement'
  | 'insufficient-funds'
  | 'stale-revision'
  | 'not-found'
  | 'has-parcels'
  | 'not-boundary';
export type CommandResult =
  | {
      readonly ok: true;
      readonly state: RegionState;
      readonly created: readonly EntityId[];
      readonly cost: number;
    }
  | {
      readonly ok: false;
      readonly state: RegionState;
      readonly reason: RejectReason;
    };
export interface Preview {
  readonly valid: boolean;
  readonly cost: number;
  readonly reason: RejectReason | null;
  readonly contours: ReadonlyArray<readonly Point[]>;
}
