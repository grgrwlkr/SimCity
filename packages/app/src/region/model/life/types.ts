import type {LaneRoute, LanePose} from '../../../city/trafficRoutes';
import type {TrafficSave} from '../../../city/trafficFlow';
import type {Point, RegionState, ZoneKind} from '../types';

export type BuildingKind = ZoneKind | 'warehouse';
export interface RegionalBuilding {
  id: string;
  lotId: string;
  settlementId: string;
  kind: BuildingKind;
  ownerId: string;
  stage: 'constructing' | 'ready';
  startedAt: number;
  progressSeconds: number;
  durationSeconds: number;
  capacity: number;
  jobs: number;
  qualification: number;
  parking: number;
  inventory: number;
  inventoryCapacity: number;
  cash: number;
  productionWork: number;
}
export interface RegionalFamilyFinance {
  sinceSeconds: number;
  construction: number;
  goods: number;
  travel: number;
  wages: number;
}
export interface RegionalFamily {
  finance?: RegionalFamilyFinance;
  id: string;
  memberIds: string[];
  cash: number;
  homeId: string | null;
  status: 'waiting' | 'arriving' | 'settled';
  availableAt: number;
  carId: string | null;
  goods: number;
  lastShopDay: number;
  reason: string | null;
}
export type ResidentActivity =
  | 'outside'
  | 'home'
  | 'work'
  | 'shopping'
  | 'walking'
  | 'driving'
  | 'passenger'
  | 'waiting';
export interface RegionalPerson {
  id: string;
  familyId: string;
  name: string;
  age: number;
  qualification: number;
  jobId: string | null;
  placeId: string | null;
  tripId: string | null;
  activity: ResidentActivity;
  reason: string | null;
  workedSeconds: number;
  wageSeconds: number;
}
export interface RegionalInvestor {
  id: string;
  cash: number;
}
export interface RegionalCar {
  id: string;
  familyId: string;
  driverId: string | null;
  parkedAt: string | null;
  parkingSlot: number | null;
  tripId: string | null;
  trafficIndex: number;
}
export type TripPurpose =
  'arrival' | 'work' | 'home' | 'shop' | 'delivery' | 'leisure';
export type TravelMode = 'car' | 'walk' | 'truck';
export interface RegionalRoute {
  lane: LaneRoute;
  roadIds: string[];
  roadRevision: number;
  crossings: Array<{from: Point; to: Point}>;
}
export interface RegionalTrip {
  id: string;
  actorId: string;
  passengerIds: string[];
  vehicleId: string | null;
  trafficIndex: number | null;
  fromId: string;
  toId: string;
  mode: TravelMode;
  purpose: TripPurpose;
  phase: 'approach' | 'travel' | 'exit';
  approach?: {lane: LaneRoute; distance: number};
  exit?: {lane: LaneRoute; distance: number};
  route: RegionalRoute;
  distance: number;
  pose: LanePose;
  startedAt: number;
  waitingSeconds: number;
  parkingSlot: number | null;
}
export interface RegionalDelivery {
  id: string;
  sourceId: string | null;
  targetId: string;
  quantity: number;
  cargo: number;
  state: 'waiting' | 'loading' | 'in-transit' | 'unloading' | 'delivered';
  tripId: string | null;
  phaseSeconds: number;
  unitPrice: number;
  reason: string | null;
}
export interface RegionalEconomy {
  initialMoney: number;
  initialGoods: number;
  externalMoney: number;
  externalGoods: number;
  produced: number;
  consumed: number;
  taxesPaid: number;
  maintenancePaid: number;
  maintenanceDebt: number;
  constructionPaid: number;
  wagesPaid: number;
  salesValue: number;
  importsPaid: number;
}
/** Only the simulation's owned draft mutates these records; snapshots cross the worker boundary. */
export interface RegionalLifeState {
  elapsedSeconds: number;
  remainderSeconds: number;
  initialized: boolean;
  nextId: number;
  families: RegionalFamily[];
  people: RegionalPerson[];
  investors: RegionalInvestor[];
  buildings: RegionalBuilding[];
  cars: RegionalCar[];
  trips: RegionalTrip[];
  deliveries: RegionalDelivery[];
  economy: RegionalEconomy;
  traffic: TrafficSave | null;
  junctionKeys: string[];
  closingRoadIds: string[];
  completedTrips: number;
  completedDeliveries: number;
}
export type LifeRegion = Omit<RegionState, 'schemaVersion' | 'life'> & {
  readonly schemaVersion: 3;
  readonly life: RegionalLifeState;
};
export type MutableRegion = {-readonly [K in keyof LifeRegion]: LifeRegion[K]};
export interface TripRequest {
  actorId: string;
  passengerIds?: readonly string[];
  vehicleId?: string;
  fromId: string;
  toId: string;
  mode: TravelMode;
  purpose: TripPurpose;
}
export interface RegionMobilityPort {
  createCar(familyId: string, entryId: string): RegionalCar | null;
  route(fromId: string, toId: string, mode: TravelMode): RegionalRoute | null;
  start(request: TripRequest): RegionalTrip | null;
  step(seconds: number): RegionalTrip[];
  save(): void;
}
