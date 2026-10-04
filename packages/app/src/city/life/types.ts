import type {CityBuilding, CityLayout} from '../generator';
import type {LanePose, LaneRoute} from '../trafficRoutes';
import type {RailwaySnapshot, RailwayStatus} from '../railway';
import type {HarborSnapshot, HarborStatus} from '../harbor';

export interface Point {
  x: number;
  z: number;
  y?: number;
}
export interface GridWalkAccess {
  point: Point;
  chain: Point[];
  a: number;
  b: number;
}
export interface GraphWalkAccess {
  kind: 'graph';
  point: Point;
  chain: Point[];
  roadId: string;
  segment: number;
  offset: number;
  side: 1 | -1;
}
export type WalkAccess = GridWalkAccess | GraphWalkAccess;

export interface GridRoadAccess {
  point: Point;
  direction: number;
  nextColumn: number;
  nextRow: number;
}
export interface GraphRoadAccess {
  kind: 'graph';
  point: Point;
  roadId: string;
  segment: number;
  offset: number;
  direction: 1 | -1;
}
export type RoadAccess = GridRoadAccess | GraphRoadAccess;
export type PlaceKind =
  | 'home'
  | 'office'
  | 'factory'
  | 'shop'
  | 'cafe'
  | 'park'
  | 'school'
  | 'station';
export interface LifePlace {
  id: string;
  name: string;
  kind: PlaceKind;
  building?: CityBuilding;
  blockId: string;
  door: Point;
  access: WalkAccess;
  capacity: number;
  parking: number | null;
  price: number;
  wage: number;
  education: number;
  open: number;
  close: number;
  municipalityId?: string;
}
export type ParkingKind = 'private' | 'street' | 'underground';
export interface ParkingFacility {
  id: number;
  kind: ParkingKind;
  name: string;
  buildingId: string | null;
  blockId: string;
  entrance: Point;
  yaw: number;
  road: RoadAccess;
  access: WalkAccess;
  residentsOnly: boolean;
  fee: number;
  slots: number[];
  key?: string;
}
export interface ParkingSlot {
  id: number;
  facility: number;
  position: Point;
  yaw: number;
  length: number;
  width: number;
  household: number | null;
  occupant: number | null;
  reserved: number | null;
  key?: string;
}
export interface StreetBay {
  x: number;
  z: number;
  yaw: number;
  facility: number;
  blockId: string | null;
  sidewalk: Point[];
}
export interface LifeProfile {
  seed: string;
  layout: CityLayout;
  places: LifePlace[];
  facilities: ParkingFacility[];
  slots: ParkingSlot[];
  bays: StreetBay[];
  garageBuildings: Record<string, number>;
  arrival: RoadAccess | null;
}
export interface HousingUnit {
  id: number;
  building: string;
  capacity: number;
  price: number;
  rent: number;
  tenant: number | null;
  owner: number | null;
  retired?: boolean;
}
export interface LifeEvent {
  at: number;
  text: string;
}
export interface Household {
  id: number;
  surname: string;
  members: number[];
  home: number;
  balance: number;
  food: number;
  cars: number[];
  babyDueDay: number | null;
  goal: string;
  arrived: boolean;
}
export interface Job {
  building: string;
  title: string;
  wage: number;
  start: number;
  shift: number;
}
export type Activity =
  | 'train'
  | 'home'
  | 'walk'
  | 'drive'
  | 'work'
  | 'shop'
  | 'leisure'
  | 'school'
  | 'garage'
  | 'dead';
export type Purpose = 'work' | 'shop' | 'leisure' | 'school' | 'home' | 'move';
export interface Trip {
  purpose: Purpose;
  destination: string;
  started: number;
  reason: string;
  leg: 'train' | 'walk' | 'to-car' | 'driving' | 'parking' | 'from-car';
  car: number | null;
  points: Point[];
  distance: number;
  length: number;
  facility: number | null;
}
export interface Resident {
  id: number;
  name: string;
  family: number;
  birthDay: number;
  parents: number[];
  education: number;
  lifespan: number;
  preference: number;
  job: Job | null;
  activity: Activity;
  location: string;
  position: Point;
  dx: number;
  dz: number;
  nextAt: number;
  trip: Trip | null;
  workStarted: number;
  paidDay: number;
  errandsDay: number;
  leisureDay: number;
  earnings: number;
  history: LifeEvent[];
}
export interface OwnedCar {
  id: number;
  owner: number;
  driver: number | null;
  slot: number | null;
  status: 'parked' | 'reserved' | 'driving' | 'parking';
  facility: number | null;
  targetSlot: number | null;
  waitUntil: number;
  price: number;
  tier: number;
}
export interface Business {
  building: string;
  balance: number;
  stock: number;
  jobs: number;
  workers: number[];
}
export interface CitizenPose {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  visible: boolean;
  child: boolean;
}
export interface CarPose {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  visible: boolean;
  driver: number | null;
  tier: number;
}
export interface CitizenDetails {
  person: Resident;
  family: Household;
  members: Array<{id: number; name: string; age: number; activity: Activity}>;
  age: number;
  home: LifePlace;
  ownsHome: boolean;
  cars: Array<OwnedCar & {place: string; name: string}>;
  destination: string;
  next: string;
}
export interface TownGrowth {
  families: number;
  residents: number;
  employed: number;
  freeHousing: number;
  freeJobs: number;
}
export interface GrowthFrame {
  freeHousing: number;
  totalHousing: number;
  freeJobs: number;
  totalJobs: number;
  unemployed: number;
  arrivalBlock: string | null;
  nextArrivalIn: number;
  towns: Record<string, TownGrowth>;
  treasuryFlowToday: number;
  upkeepPerDay: number;
  taxRate: number;
}
export interface LifeFrame {
  ports?: Array<{id: string; snapshot: HarborSnapshot}>;
  railways?: Array<{
    id: string;
    snapshot: RailwaySnapshot;
    status: RailwayStatus;
  }>;
  treasury?: number;
  construction?: Record<string, number>;
  seconds: number;
  day: number;
  minute: number;
  population: number;
  families: number;
  employed: number;
  born: number;
  arrived: number;
  walking: number;
  driving: number;
  growth: GrowthFrame;
  people: CitizenPose[];
  cars: CarPose[];
  carOwners: Record<number, number>;
  freight: LanePose[];
  bus: LanePose & {visible: boolean};
  parking: Array<{
    id: number;
    occupant: number | null;
    reserved: number | null;
    household: number | null;
  }>;
  catalog: Array<{id: number; name: string; family: number}>;
  selected: CitizenDetails | null;
  harbor: HarborSnapshot;
  harborStatus: HarborStatus;
  railway: RailwaySnapshot;
  railwayStatus: RailwayStatus;
}
export interface PlannedDrive {
  route: LaneRoute;
  stops: number[];
}
