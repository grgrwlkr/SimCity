// Every class whose instances live in the world, under a name that survives minification: the save names an
// instance's class so a load can give it its prototype back. An instance of a class missing here fails `saveWorld`.
import { Advisor } from '../advisor';
import { Buildings } from '../buildings/building';
import { MinuteQueue, Citizens } from '../citizens';
import { CityFields } from '../cityFields';
import { CivicCoverage } from '../civicCoverage';
import { ClassDemand } from '../demand';
import { BudgetLedger, BudgetLines, Loans, ServiceFunding, TaxRates } from '../economy/economy';
import { Emergencies } from '../emergencies';
import { Fleet } from '../fleet';
import { IntersectionIndex } from '../intersections/index';
import { LandValueIndex } from '../landValue';
import { DirtyTiles } from '../map/dirty';
import { MapGrid } from '../map/grid';
import { CommandHistory } from '../map/history';
import { DistrictTimes, LinkHeap } from '../meso/districts';
import { MesoGraph } from '../meso/graph';
import { MesoTraffic } from '../meso/traffic';
import { Milestones } from '../milestones';
import { NearestBuildings } from '../nearest';
import { Notifications } from '../notifications';
import { Parking } from '../parking';
import { PedestrianGraph } from '../pedestrians/graph';
import { PollutionIndex } from '../pollution';
import { RegionalTrips } from '../regional';
import { StdRng } from '../rng';
import { ServiceCoverageIndex } from '../services/coverage';
import { Timer } from '../timer';
import { ArbiterIndexCache } from '../traffic/arbiter';
import { TrafficOccupancy, TrafficRoadCache } from '../traffic/occupancy';
import { PathPool } from '../traffic/pathPool';
import { IntersectionLedger, IntersectionReservations } from '../traffic/reservations';
import { TrafficSpatialIndex } from '../traffic/spatialIndex';
import { BusRoutes } from '../transit/buses';
import { LaneGraph } from '../transport/laneGraph';
import { LaneletConflictMatrices, TileSet } from '../transport/lanelet/build';
import { ConflictMatrix } from '../transport/lanelet/conflict';
import { LaneletGraph } from '../transport/lanelet/graph';
import { NodeSpace } from '../transport/lanelet/pathfinding';
import { OpenSet } from '../transport/openSet';
import { PathCache } from '../transport/pathfinding';
import { RegionGraph } from '../transport/regionGraph';
import { RoadGraph } from '../transport/roadGraph';
import { CityCommuteScenario } from '../scenarios/cityCommute';
import { CitizenTripCounter, LivingCityScenario } from '../scenarios/livingCity';
import { MetropolisScenario } from '../scenarios/metropolis';
import { SignalizedCrossScenario } from '../scenarios/signalizedCross';
import { UtilityNetwork, UtilitySupply } from '../utilities';

/** A name is written into every save: renaming one breaks the saves that carry it. */
export const SAVED_CLASSES: Readonly<Record<string, { readonly prototype: object }>> = {
  Advisor,
  ArbiterIndexCache,
  BudgetLedger,
  BudgetLines,
  Buildings,
  BusRoutes,
  CitizenTripCounter,
  Citizens,
  CityCommuteScenario,
  CityFields,
  CivicCoverage,
  ClassDemand,
  CommandHistory,
  ConflictMatrix,
  DirtyTiles,
  DistrictTimes,
  Emergencies,
  Fleet,
  IntersectionIndex,
  IntersectionLedger,
  IntersectionReservations,
  LandValueIndex,
  LaneGraph,
  LaneletConflictMatrices,
  LaneletGraph,
  LinkHeap,
  LivingCityScenario,
  Loans,
  MapGrid,
  MesoGraph,
  MesoTraffic,
  MetropolisScenario,
  Milestones,
  MinuteQueue,
  NearestBuildings,
  NodeSpace,
  Notifications,
  OpenSet,
  Parking,
  PathCache,
  PathPool,
  PedestrianGraph,
  PollutionIndex,
  RegionGraph,
  RegionalTrips,
  RoadGraph,
  ServiceCoverageIndex,
  ServiceFunding,
  SignalizedCrossScenario,
  StdRng,
  TaxRates,
  TileSet,
  Timer,
  TrafficOccupancy,
  TrafficRoadCache,
  TrafficSpatialIndex,
  UtilityNetwork,
  UtilitySupply,
};
