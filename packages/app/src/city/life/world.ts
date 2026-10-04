import {Harbor, freightPlans} from '../harbor';
import {
  AMBIENT_VEHICLES,
  cityVehicleKits,
  freightJunctions,
} from '../harborLayout';
import {Railway} from '../railway';
import {RAILWAY_STATION_X, RAILWAY_SPEED} from '../railwayLayout';
import {gridForLayout} from '../cityGrid';
import {CityTraffic} from '../trafficFlow';
import {CITY_ROAD_CENTERS, type LanePose} from '../trafficRoutes';
import {
  createLifeProfile,
  departureAccess,
  distance,
  LifeNetwork,
  parkingRoute,
  parkingWalkAccess,
  pathLength,
  roadAccess,
  RouteBuilder,
  sampleWalk,
} from './network';
import {ParkingBook} from './parking';
import {
  createPrototypeDefinition,
  completeAuthoredConstruction,
  parseWorldDefinition,
} from './definition';
import {NoNativeRoute, RegionRouting} from './regionRouting';
import {reconcileWorldDefinition} from './worldReconciliation';
import {NativeGoodsEconomy} from './goodsEconomy';
import {
  createNativePortConfiguration,
  nativePortJunctionAliases,
  createNativeRailwayConfiguration,
} from './nativeInfrastructure';
import type {
  NativePortConfiguration,
  NativeRailwayConfiguration,
} from './nativeInfrastructure';
import type {
  CityLifeDefinitionOptions,
  CityWorldDefinition,
} from './definition';
import {
  carName,
  INITIAL_MINUTE,
  lifeCarKit,
  MINUTE_SECONDS,
  Population,
} from './population';
import type {
  CitizenDetails,
  LifeFrame,
  LifePlace,
  OwnedCar,
  ParkingFacility,
  ParkingSlot,
  RoadAccess,
  PlannedDrive,
  Point,
  Purpose,
  Resident,
  WalkAccess,
} from './types';

const STEP = 0.05;
const WALK_SPEED = 1.3;

export const BUS_INDEX = AMBIENT_VEHICLES + 4;
export const CAR_OFFSET = BUS_INDEX + 1;

export const onRoad = (
  p: Point,
  roads: readonly number[] = CITY_ROAD_CENTERS,
) => {
  const first = roads[0]!;
  const last = roads.at(-1)!;

  return (
    (p.x >= first - 4 &&
      p.x <= last + 4 &&
      p.z >= first - 4 &&
      p.z <= last + 4 &&
      roads.some(r => Math.abs(p.x - r) < 4 || Math.abs(p.z - r) < 4)) ||
    (p.x >= first - 24 && p.x < first - 4 && Math.abs(p.z + 85) < 4)
  );
};

interface BusState {
  phase: 'idle' | 'approach' | 'parking' | 'unloading' | 'leaving';
  family: number | null;
  slot: number | null;
  until: number;
  terminal: number | null;
}
interface RailArrival {
  serial: number;
  family: number;
  released: number;
  nextAt: number | null;
}

export class CityLife {
  private currentDefinition: CityWorldDefinition;
  readonly profile;
  readonly network: LifeNetwork | RegionRouting;
  readonly parking;
  readonly population;
  readonly harbor = new Harbor();
  readonly traffic: CityTraffic;
  readonly economy: NativeGoodsEconomy | undefined;
  private readonly nativePorts = new Map<string, NativePortConfiguration>();
  private readonly nativeRailways = new Map<
    string,
    NativeRailwayConfiguration
  >();
  private readonly nativeRailArrivals = new Map<string, RailArrival | null>();
  readonly railway: Railway;
  readonly errors: string[] = [];
  private tick = 0;
  private requested = 0;
  private dayDone = 0;
  private carsAdded = 0;
  private crossings: Point[] = [];
  private portals = new Map<number, number>();
  private nextImmigration = 20;
  private nextAssets = 60;
  private bus: BusState = {
    phase: 'idle',
    family: null,
    slot: null,
    until: 0,
    terminal: null,
  };
  private railArrival: RailArrival | null = null;
  private terminal: ParkingFacility | null;
  private busVehicleId: number | null = BUS_INDEX;
  private readonly carVehicleIds: number[] = [];
  private readonly expanded: boolean;

  get definition(): CityWorldDefinition {
    return this.currentDefinition;
  }

  static fromDefinition(
    definition: CityWorldDefinition,
    options: CityLifeDefinitionOptions = {},
  ): CityLife {
    return new CityLife(
      definition,
      options.initialFamilies,
      definition.expanded,
      options.network,
    );
  }

  constructor(
    seedOrDefinition: string | CityWorldDefinition,
    families?: number,
    expanded = true,
    network?: LifeNetwork,
    restoringAuthored = false,
  ) {
    this.currentDefinition =
      typeof seedOrDefinition === 'string'
        ? createPrototypeDefinition(seedOrDefinition, expanded)
        : seedOrDefinition;
    const definition = parseWorldDefinition(this.definition);
    const authored = definition.kind === 'authored';
    const seed = definition.seed;

    if (definition.version !== 1 || definition.layout.seed !== seed) {
      throw new Error('Некорректное описание исходного мира');
    }

    this.expanded = definition.expanded;
    this.network = authored
      ? new RegionRouting(definition.layout, definition.roads)
      : (network ?? new LifeNetwork(definition.layout));

    if (this.network.layout !== definition.layout) {
      throw new Error('Дорожная сеть относится к другой планировке');
    }

    this.profile =
      definition.kind === 'authored'
        ? structuredClone(definition.profile)
        : createLifeProfile(
            definition.layout,
            network ??
              (this.network instanceof LifeNetwork
                ? this.network
                : new LifeNetwork(definition.layout)),
          );

    if (this.network instanceof RegionRouting) {
      this.network.validateProfile(this.profile);
    }

    this.railway = new Railway(0, this.expanded, this.network.roads);
    this.parking = new ParkingBook(this.profile);
    this.population = new Population(
      this.profile,
      this.parking,
      families ?? (authored ? 0 : 180),
      true,
      definition.kind === 'authored'
        ? {
            calendar: definition.calendar,
            deliveredGoods: true,
            startingCash: definition.startingCash ?? 1_000_000,
          }
        : {},
    );
    const sizes = authored
      ? []
      : [...cityVehicleKits(seed), {length: 4.2, width: 1.9}];

    this.traffic = new CityTraffic(sizes, {
      initiallyInactive: new Set([
        ...Array.from({length: AMBIENT_VEHICLES}, (_, i) => i),
        BUS_INDEX,
      ]),
      ...(authored ? {} : {plans: freightPlans()}),
      roads: this.network.roads,
      junctions:
        this.network instanceof RegionRouting
          ? this.network.junctions()
          : freightJunctions(this.network.roads.length ** 2),
      blocked: (proposed, current, size, currentSize) =>
        this.railway.blocksVehicle(proposed, current, size, currentSize) ||
        [...this.nativeRailways.values()].some(configuration =>
          configuration.railway.blocksVehicle(
            proposed,
            current,
            size,
            currentSize,
          ),
        ),
      pedestrians: () => this.crossings,
      ...(authored
        ? {}
        : {
            onStep: (time: number, traffic: CityTraffic) =>
              this.harbor.advance(time, traffic),
          }),
    });
    this.terminal =
      definition.kind === 'authored'
        ? (this.profile.facilities[
            definition.entries[0]?.terminalFacilityId ?? -1
          ] ?? null)
        : this.profile.facilities
            .filter(f => f.kind === 'street' && f.road.direction === 1)
            .sort(
              (a, b) =>
                distance(a.road.point, this.profile.arrival!.point) -
                distance(b.road.point, this.profile.arrival!.point),
            )[0]!;

    if (authored) {
      this.busVehicleId =
        !restoringAuthored && this.terminal && this.profile.arrival
          ? this.traffic.addCar({length: 4.2, width: 1.9})
          : null;
      const state = this.harbor.save();

      this.harbor.restore({
        ...state,
        cargo: [],
        jobs: [],
        homes: [],
        phase: 'away',
        nextId: 0,
        created: 0,
        production: [],
        waitingSince: [],
      });
    }

    this.syncCars();
    this.economy =
      definition.kind === 'authored' && this.network instanceof RegionRouting
        ? new NativeGoodsEconomy(
            this.population,
            this.traffic,
            this.network,
            definition,
          )
        : undefined;

    if (this.economy) {
      this.population.setEconomicProvider(this.economy);
    }
    if (authored && !restoringAuthored) {
      this.configureInfrastructure();
    }
  }

  private configureInfrastructure(restored?: {
    ports: Array<{
      id: string;
      truckIds: readonly [number, number, number, number];
      harbor: ReturnType<Harbor['save']>;
    }>;
    railways: Array<{
      id: string;
      railway: ReturnType<Railway['save']>;
      arrival: RailArrival | null;
    }>;
  }): void {
    if (
      this.definition.kind !== 'authored' ||
      !(this.network instanceof RegionRouting)
    ) {
      return;
    }

    const definition = this.definition;
    const routing = this.network;

    for (const [id, configuration] of this.nativePorts) {
      if (
        !(definition.infrastructure?.ports ?? []).some(port => port.id === id)
      ) {
        for (const vehicleId of configuration.truckIds) {
          this.traffic.park(vehicleId);
        }

        this.nativePorts.delete(id);
      }
    }

    for (const id of this.nativeRailways.keys()) {
      if (
        !(definition.infrastructure?.railways ?? []).some(
          railway => railway.id === id,
        )
      ) {
        this.nativeRailways.delete(id);
        this.nativeRailArrivals.delete(id);
      }
    }

    for (const placement of definition.infrastructure?.ports ?? []) {
      if (this.nativePorts.has(placement.id)) {
        continue;
      }

      const saved = restored?.ports.find(port => port.id === placement.id);
      const configuration = createNativePortConfiguration(
        placement,
        this.profile,
        routing,
        (size, plan) => {
          const id = this.traffic.addCar(size);

          this.traffic.registerPlan(id, plan);

          return id;
        },
        {
          provider: this.economy!.harborProvider(
            placement.warehouseBuildingIds,
          ),
          ...(placement.navigation ? {navigation: placement.navigation} : {}),
          ...(saved
            ? {
                restoredTruckIds: saved.truckIds,
                restoredHarborSave: saved.harbor,
              }
            : {}),
          allocateJunction: key => routing.allocateJunction(key),
        },
      );

      this.nativePorts.set(placement.id, configuration);
    }

    for (const placement of definition.infrastructure?.railways ?? []) {
      if (this.nativeRailways.has(placement.id)) {
        continue;
      }

      const saved = restored?.railways.find(
        railway => railway.id === placement.id,
      );
      const configuration = createNativeRailwayConfiguration(
        placement,
        this.profile,
        routing,
        {
          startSeconds: this.seconds,
          roads: definition.roads,
          ...(saved ? {restoredSave: saved.railway} : {}),
        },
      );

      this.nativeRailways.set(placement.id, configuration);
      this.nativeRailArrivals.set(placement.id, saved?.arrival ?? null);
    }

    const ports = [...this.nativePorts.values()];
    const graph = routing.junctions();
    const freight = ports.flatMap(configuration => configuration.junctions);
    const aliases = new Map(
      ports.flatMap(configuration => [
        ...nativePortJunctionAliases(configuration, graph),
      ]),
    );

    this.traffic.setJunctions([...freight, ...graph]);

    if (restored) {
      this.traffic.reconcileOrphanReservations();
    }

    this.traffic.setJunctions(
      [
        ...freight,
        ...graph.map(box => ({...box, id: aliases.get(box.id) ?? box.id})),
      ],
      aliases,
    );
    this.economy?.setPortCargoProvider(() =>
      [...this.nativePorts.values()].flatMap(configuration =>
        configuration.harbor.save().cargo.flatMap(cargo =>
          cargo.shipment
            ? [
                {
                  quantity: cargo.shipment.quantity,
                  buildingId:
                    configuration.placement.warehouseBuildingIds[
                      cargo.shipment.warehouse
                    ]!,
                  flow: cargo.flow,
                },
              ]
            : [],
        ),
      ),
    );
  }

  private portPoses(): LanePose[] {
    const poses: LanePose[] = [];

    for (const configuration of this.nativePorts.values()) {
      for (const id of configuration.truckIds) {
        poses[id] = this.traffic.pose(id);
      }
    }

    return poses;
  }

  get seconds(): number {
    return this.tick * STEP;
  }

  private get startingMinute(): number {
    return this.definition.kind === 'authored'
      ? (this.definition.calendar?.startingMinute ?? INITIAL_MINUTE)
      : INITIAL_MINUTE;
  }

  private get secondsPerMinute(): number {
    return this.definition.kind === 'authored'
      ? (this.definition.calendar?.secondsPerMinute ?? MINUTE_SECONDS)
      : MINUTE_SECONDS;
  }

  carVehicleId(id: number): number {
    const index = this.carVehicleIds[id];

    if (index === undefined) {
      throw new Error('Незарегистрированная машина');
    }

    return index;
  }

  private isOnRoad(point: Point): boolean {
    return this.network instanceof RegionRouting
      ? this.network.isOnRoad(point)
      : onRoad(point, this.network.roads);
  }

  private walkParking(
    facility: ParkingFacility,
    slot: ParkingSlot,
  ): WalkAccess {
    return this.network instanceof RegionRouting
      ? this.network.parkingWalkAccess(facility, slot)
      : parkingWalkAccess(this.network, facility, slot);
  }

  private departure(facility: ParkingFacility, slot: ParkingSlot): RoadAccess {
    return this.network instanceof RegionRouting
      ? this.network.departureAccess(facility, slot)
      : departureAccess(facility, slot, this.network.roads);
  }

  private parkingManoeuvre(
    facility: ParkingFacility,
    slot: ParkingSlot,
    entering: boolean,
  ): PlannedDrive {
    return this.network instanceof RegionRouting
      ? this.network.parkingRoute(facility, slot, entering)
      : parkingRoute(facility, slot, entering);
  }

  applyDefinitionUpdate(value: CityWorldDefinition, cost = 0): void {
    if (!Number.isFinite(cost) || cost < 0 || cost > this.population.treasury) {
      throw new Error('Недостаточно средств на изменение мира');
    }

    const definition = parseWorldDefinition(value);

    if (
      this.definition.kind !== 'authored' ||
      definition.kind !== 'authored' ||
      !(this.network instanceof RegionRouting) ||
      definition.seed !== this.profile.seed
    ) {
      throw new Error('Изменение относится к другому миру');
    }

    for (const [id, configuration] of this.nativePorts) {
      if (
        !(definition.infrastructure?.ports ?? []).some(
          port => port.id === id,
        ) &&
        (configuration.harbor.save().cargo.length > 0 ||
          configuration.harbor.save().jobs.some(job => job !== null))
      ) {
        throw new Error('Порт занят действительным грузом');
      }
    }

    for (const [id, configuration] of this.nativeRailways) {
      if (
        !(definition.infrastructure?.railways ?? []).some(
          railway => railway.id === id,
        ) &&
        configuration.railway.snapshot().train.phase !== 'away'
      ) {
        throw new Error('Вокзал занят действительным поездом');
      }
    }

    const active =
      this.population.people.some(person => person.trip !== null) ||
      this.population.cars.some(car => car.status !== 'parked') ||
      this.traffic.movingPoses().length > 0 ||
      this.bus.phase !== 'idle' ||
      (this.economy?.deliveries.some(
        delivery => delivery.state !== 'delivered',
      ) ??
        false);
    const roadRemovedOrChanged = this.definition.roads.some(
      road =>
        !definition.roads.some(
          other =>
            other.id === road.id &&
            JSON.stringify(other.points) === JSON.stringify(road.points),
        ),
    );

    if (active && roadRemovedOrChanged) {
      throw new Error('Дорога занята активной поездкой');
    }

    const candidateRouting = new RegionRouting(
      definition.layout,
      definition.roads,
    );

    candidateRouting.validateProfile(definition.profile);
    const metadata = {
      ...this.definition.metadata,
      ...definition.metadata,
      ...(this.definition.metadata?.['legacyMigration']
        ? {legacyMigration: this.definition.metadata['legacyMigration']}
        : {}),
    };
    const newIds = definition.placements
      .filter(
        placement =>
          !(
            this.definition.kind === 'authored' &&
            this.definition.placements.some(prior => prior.id === placement.id)
          ),
      )
      .map(placement => placement.id);
    const next = reconcileWorldDefinition(
      this.profile,
      this.parking.slots,
      this.population,
      {
        ...definition,
        metadata,
        ...((definition.economy ?? this.definition.economy)
          ? {economy: definition.economy ?? this.definition.economy}
          : {}),
      },
      active,
    );

    for (const place of this.profile.places.filter(
      place => !next.profile.places.some(other => other.id === place.id),
    )) {
      this.population.unregisterPlace(place.id);
    }

    const places = next.profile.places.map(place => {
      const original = this.profile.places.find(other => other.id === place.id);

      if (original) {
        Object.assign(original, place);

        return original;
      }

      this.population.registerPlace(place);

      return place;
    });

    this.profile.places.splice(0, this.profile.places.length, ...places);
    this.profile.facilities.splice(
      0,
      this.profile.facilities.length,
      ...next.profile.facilities,
    );
    this.profile.slots.splice(
      0,
      this.profile.slots.length,
      ...next.profile.slots,
    );
    this.profile.bays.splice(0, this.profile.bays.length, ...next.profile.bays);
    this.profile.layout = next.layout;
    this.profile.arrival = next.profile.arrival;
    this.profile.garageBuildings = next.profile.garageBuildings;

    for (const slot of this.profile.slots.slice(this.parking.slots.length)) {
      this.parking.slots.push(structuredClone(slot));
    }

    this.network.update(next.layout, next.roads);
    this.traffic.setJunctions(this.network.junctions());
    this.currentDefinition = {...next, profile: structuredClone(this.profile)};
    this.terminal =
      this.profile.facilities[next.entries[0]?.terminalFacilityId ?? -1] ??
      null;

    if (this.busVehicleId === null && this.terminal && this.profile.arrival) {
      this.busVehicleId = this.traffic.addCar({length: 4.2, width: 1.9});
    }

    this.population.treasury -= cost;
    this.economy?.recordConstruction(next, newIds, cost);
    this.economy?.syncHiringCapacity();
    this.population.assignJobs(this.day, this.seconds);
    this.configureInfrastructure();
  }

  get day(): number {
    return Math.floor(
      (this.startingMinute + this.seconds / this.secondsPerMinute) / 1440,
    );
  }

  get minute(): number {
    return (this.startingMinute + this.seconds / this.secondsPerMinute) % 1440;
  }

  private atMinute(minute: number, day = this.day): number {
    return (day * 1440 + minute - this.startingMinute) * this.secondsPerMinute;
  }

  advance(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error('Invalid simulation interval');
    }

    this.requested = Math.round((this.requested + seconds) * 1e8) / 1e8;
    const target = Math.floor(this.requested / STEP + 1e-7);

    while (this.tick < target) {
      this.tick++;
      this.step();
    }
  }

  private syncCars(): void {
    while (this.carsAdded < this.population.cars.length) {
      const car = this.population.cars[this.carsAdded]!;
      const id = this.traffic.addCar(
        lifeCarKit(this.profile.seed, car.id, car.tier),
      );

      const expected =
        this.definition.kind === 'authored' ? id : CAR_OFFSET + car.id;

      this.carVehicleIds.push(id);

      if (id !== expected) {
        throw new Error('Vehicle identity mismatch');
      }

      this.carsAdded++;
    }
  }

  requestDelivery(
    sourceId: string,
    targetId: string,
    quantity?: number,
  ): boolean {
    return this.economy?.requestDelivery(sourceId, targetId, quantity) ?? false;
  }

  private accessAt(p: Resident): WalkAccess {
    return this.population.place(p.location).access;
  }

  private walkStart(
    p: Resident,
    from: WalkAccess,
    to: WalkAccess,
    purpose: Purpose,
    destination: LifePlace,
    leg: 'walk' | 'to-car' | 'from-car',
    car: number | null,
    facility: number | null,
    reason: string,
  ): void {
    const points = this.network.walk(from, to);
    const length = pathLength(points);

    p.activity = 'walk';
    p.position = {...from.point};
    p.nextAt = Infinity;
    p.trip = {
      purpose,
      destination: destination.id,
      started: this.seconds,
      reason,
      leg,
      car,
      points,
      distance: 0,
      length,
      facility,
    };
    this.population.event(p, this.seconds, reason);

    if (length < 0.01) {
      this.walkFinished(p);
    }
  }

  private destinationParking(
    p: Resident,
    destination: LifePlace,
    car: OwnedCar,
  ): ParkingFacility[] {
    const family = this.population.families[p.family]!;
    const homeBlock = this.population.home(family).blockId;

    return this.profile.facilities
      .filter(f => this.parking.available(f.id, family.id, homeBlock, car.id))
      .sort(
        (a, b) =>
          distance(a.access.point, destination.door) -
          distance(b.access.point, destination.door),
      )
      .slice(0, 4);
  }

  startTrip(
    p: Resident,
    destination: LifePlace,
    purpose: Purpose,
    forceCar: number | null = null,
  ): void {
    const family = this.population.families[p.family]!;
    const from = this.accessAt(p);
    let walk;

    try {
      walk = this.network.walk(from, destination.access);
    } catch (error) {
      if (error instanceof NoNativeRoute) {
        p.nextAt = this.seconds + 3;

        return;
      }

      throw error;
    }

    const walkingTime = pathLength(walk) / WALK_SPEED;
    let best:
      | {
          car: OwnedCar;
          facility: ParkingFacility;
          fromCar: WalkAccess;
          cost: number;
          expense: number;
        }
      | undefined;

    if (this.population.age(p, this.day) >= 18) {
      for (const id of family.cars) {
        const car = this.population.cars[id]!;

        if (
          car.owner !== family.id ||
          car.driver !== null ||
          car.status !== 'parked' ||
          car.slot === null
        ) {
          continue;
        }

        const slot = this.parking.slots[car.slot]!;
        const originFacility = this.profile.facilities[slot.facility]!;
        const fromCar = this.walkParking(originFacility, slot);
        const toCarSeconds =
          pathLength(this.network.walk(from, fromCar)) / WALK_SPEED;

        for (const f of this.destinationParking(p, destination, car)) {
          if (f.id === originFacility.id) {
            continue;
          }

          let drive;

          try {
            drive = this.network.drive(
              this.departure(originFacility, slot),
              f.road,
            );
          } catch (error) {
            if (error instanceof NoNativeRoute) {
              continue;
            }

            throw error;
          }

          const expense = Math.ceil(drive.length * 0.55) + f.fee;

          if (family.balance < expense + 160) {
            continue;
          }

          const endSlot = this.parking.available(
            f.id,
            family.id,
            this.population.home(family).blockId,
            car.id,
          )!;
          const tail =
            pathLength(
              this.network.walk(
                this.walkParking(f, endSlot),
                destination.access,
              ),
            ) / WALK_SPEED;
          const cost =
            (toCarSeconds +
              drive.length / 5.5 +
              tail +
              10 +
              expense / Math.max(8, (p.job?.wage ?? 2400) / 160)) *
            (1.2 - p.preference * 0.4);

          if (!best || cost < best.cost) {
            best = {car, facility: f, fromCar, cost, expense};
          }
        }
      }
    }
    if (
      best &&
      (best.car.id === forceCar ||
        (walkingTime > 15 && best.cost < walkingTime))
    ) {
      best.car.driver = p.id;
      best.car.status = 'reserved';
      best.car.facility = best.facility.id;
      this.walkStart(
        p,
        from,
        best.fromCar,
        purpose,
        destination,
        'to-car',
        best.car.id,
        best.facility.id,
        `Идёт к своей машине. Поездка удобнее: ${Math.ceil(best.cost / this.secondsPerMinute)} мин, пешком ${Math.ceil(walkingTime / this.secondsPerMinute)} мин`,
      );
    } else {
      const unavailable = family.cars.some(
        id => this.population.cars[id]!.driver !== null,
      );

      this.walkStart(
        p,
        from,
        destination.access,
        purpose,
        destination,
        'walk',
        null,
        null,
        `Идёт пешком в «${destination.name}»: ${Math.max(1, Math.ceil(walkingTime / this.secondsPerMinute))} мин${unavailable ? '. Семейная машина занята' : best ? '. С учётом парковки так удобнее' : ''}`,
      );
    }
  }

  private driveStart(p: Resident): void {
    const trip = p.trip!;
    const car = this.population.cars[trip.car!]!;
    const family = this.population.families[p.family]!;

    if (car.slot === null || trip.facility === null) {
      throw new Error('Departure without parked vehicle');
    }

    const slot = this.parking.slots[car.slot]!;
    const source = this.profile.facilities[slot.facility]!;
    const destination = this.profile.facilities[trip.facility]!;

    if (this.portals.has(source.id)) {
      p.nextAt = this.seconds + 0.5;

      return;
    }

    const exit = this.parkingManoeuvre(source, slot, false).route;
    const road = this.network.drive(
      this.departure(source, slot),
      destination.road,
    );
    const expense = Math.ceil(road.length * 0.55) + destination.fee;

    if (family.balance < expense) {
      car.driver = null;
      car.status = 'parked';
      this.walkStart(
        p,
        this.walkParking(source, slot),
        this.population.place(trip.destination).access,
        trip.purpose,
        this.population.place(trip.destination),
        'walk',
        null,
        null,
        'Идёт пешком: деньги нужны семье',
      );

      return;
    }

    const route = new RouteBuilder(slot.position)
      .append(exit)
      .append(road)
      .route();

    if (
      !this.traffic.beginTrip(this.carVehicleId(car.id), route, exit.length)
    ) {
      p.nextAt = this.seconds + 0.5;

      return;
    }

    this.portals.set(source.id, car.id);
    family.balance -= expense;
    this.population.treasury += expense;
    this.parking.leave(car.id);
    car.slot = null;
    car.status = 'driving';
    car.waitUntil = 0;
    p.activity = 'drive';
    trip.leg = 'driving';
    trip.reason =
      'Едет на семейной машине. У места назначения найдёт парковку.';
    this.population.event(
      p,
      this.seconds,
      `Выезжает на своей машине в «${this.population.place(trip.destination).name}»`,
    );
  }

  private walkFinished(p: Resident): void {
    const trip = p.trip!;

    if (trip.leg === 'to-car') {
      p.activity = 'garage';
      p.nextAt = this.seconds + 2;

      return;
    }

    this.arrive(p, this.population.place(trip.destination), trip.purpose);
  }

  private arrive(p: Resident, destination: LifePlace, purpose: Purpose): void {
    p.location = destination.id;
    p.position = {...destination.door};
    p.trip = null;
    this.population.event(p, this.seconds, `Прибыл: ${destination.name}`);

    if (purpose === 'work' && p.job) {
      p.activity = 'work';
      p.workStarted = this.seconds;
      p.nextAt = Math.max(
        this.seconds + 1,
        this.atMinute(p.job.start + p.job.shift),
      );
    } else if (purpose === 'school') {
      p.activity = 'school';
      p.paidDay = this.day;
      p.nextAt = Math.max(this.seconds + 1, this.atMinute(15 * 60));
    } else if (purpose === 'shop') {
      p.activity = 'shop';
      this.population.shop(p, destination, this.seconds);
      p.nextAt = this.seconds + 12 * this.secondsPerMinute;
    } else if (purpose === 'leisure') {
      p.activity = 'leisure';
      p.nextAt = this.seconds + (25 + (p.id % 30)) * this.secondsPerMinute;

      if (destination.kind === 'cafe') {
        const f = this.population.families[p.family]!;
        const cost = Math.min(f.balance, 250);

        f.balance -= cost;
        this.population.businesses.find(
          b => b.building === destination.id,
        )!.balance += cost;
        this.economy?.recordRetail(destination.id, cost);
        this.population.event(p, this.seconds, 'Отдыхает в кафе');
      } else {
        this.population.event(p, this.seconds, 'Гуляет в парке');
      }
    } else {
      p.activity = 'home';
      p.nextAt = this.seconds + 1;
      const f = this.population.families[p.family]!;

      if (
        !f.arrived &&
        f.members.every(
          id =>
            this.population.people[id]!.location === destination.id &&
            this.population.people[id]!.activity === 'home',
        )
      ) {
        f.arrived = true;
        this.population.arrivals += f.members.length;
        this.population.familyEvent(
          f,
          this.seconds,
          'Семья заселилась в новый дом',
        );
      }
    }
  }

  private choosePlace(
    p: Resident,
    kinds: Array<LifePlace['kind']>,
  ): LifePlace | undefined {
    const origin = this.population.place(p.location).door;

    return this.profile.places
      .filter(
        place =>
          kinds.includes(place.kind) &&
          this.minute >= place.open &&
          this.minute < place.close - 15 &&
          (place.kind !== 'shop' ||
            this.population.businesses.find(b => b.building === place.id)!
              .stock > 0),
      )
      .sort(
        (a, b) =>
          distance(origin, a.door) - distance(origin, b.door) ||
          a.id.localeCompare(b.id),
      )[0];
  }

  private plan(p: Resident): void {
    const family = this.population.families[p.family]!;

    if (!family.arrived || p.activity === 'dead') {
      return;
    }

    const age = this.population.age(p, this.day);
    const home = this.population.home(family);

    if (p.activity === 'work') {
      this.population.payWage(
        p,
        Math.floor(
          (this.startingMinute + p.workStarted / this.secondsPerMinute) / 1440,
        ),
        this.seconds,
      );
    }

    const weekday = this.day % 7 < 5;

    if (age < 6) {
      p.nextAt = this.atMinute(7 * 60, this.day + 1);

      return;
    }
    if (
      age < 18 &&
      weekday &&
      p.paidDay !== this.day &&
      this.minute < 15 * 60
    ) {
      const school = this.profile.places.find(b => b.kind === 'school');

      if (!school) {
        p.nextAt = this.seconds + 30;

        return;
      }

      const leave =
        this.atMinute(9 * 60) -
        (distance(home.door, school.door) / WALK_SPEED) * 1.5;

      if (this.seconds >= leave) {
        this.startTrip(p, school, 'school');

        return;
      }

      p.nextAt = leave;

      return;
    }
    if (
      p.job &&
      weekday &&
      p.paidDay !== this.day &&
      this.minute < p.job.start + p.job.shift
    ) {
      const work = this.population.place(p.job.building);
      const leave =
        this.atMinute(p.job.start) -
        (distance(home.door, work.door) / WALK_SPEED) * 1.45 -
        12;

      if (this.seconds >= leave) {
        this.startTrip(p, work, 'work');

        return;
      }

      p.nextAt = leave;

      return;
    }
    if (
      age >= 18 &&
      family.food < family.members.length * 3 &&
      p.errandsDay !== this.day &&
      !family.members.some(
        id =>
          this.population.people[id]!.trip?.purpose === 'shop' ||
          this.population.people[id]!.activity === 'shop',
      )
    ) {
      const shop = this.choosePlace(p, ['shop']);

      if (shop) {
        p.errandsDay = this.day;
        this.startTrip(p, shop, 'shop');

        return;
      }
    }

    const outingStart = p.job && weekday ? 16 * 60 : 10 * 60;

    if (
      this.minute >= outingStart &&
      this.minute < 21 * 60 &&
      p.leisureDay !== this.day &&
      (p.id + this.day) % 3 !== 0
    ) {
      const leisure = this.choosePlace(
        p,
        age >= 18 && family.balance >= 500 && p.preference > 0.6
          ? ['cafe', 'park']
          : ['park'],
      );

      if (leisure) {
        p.leisureDay = this.day;
        this.startTrip(p, leisure, 'leisure');

        return;
      }
    }
    if (p.location !== home.id) {
      this.startTrip(p, home, 'home');

      return;
    }

    p.activity = 'home';
    p.nextAt =
      this.minute < outingStart
        ? this.atMinute(outingStart) + (p.id % 60)
        : this.atMinute(6 * 60, this.day + 1);
  }

  private moveWalker(
    p: Resident,
    cars: Array<LanePose & {speed: number; id: number}>,
  ): void {
    const trip = p.trip!;
    const proposed = Math.min(trip.length, trip.distance + WALK_SPEED * STEP);
    const pose = sampleWalk(trip.points, proposed);

    if (
      this.railway.blocksWalker(pose, p.position) ||
      [...this.nativeRailways.values()].some(configuration =>
        configuration.railway.blocksWalker(pose, p.position),
      )
    ) {
      return;
    }
    if (
      this.isOnRoad(pose) &&
      !this.isOnRoad(p.position) &&
      cars.some(car => {
        const x = pose.x - car.x;
        const z = pose.z - car.z;
        const ahead = x * car.dx + z * car.dz;
        const side = Math.abs(-x * car.dz + z * car.dx);

        return side < 1.7 && ahead > -6 && ahead < car.speed * 2 + 8;
      })
    ) {
      return;
    }

    trip.distance = proposed;
    p.position = {
      x: pose.x,
      z: pose.z,
      y: this.isOnRoad(pose) ? 0.88 : (pose.y ?? 1.07),
    };
    p.dx = pose.dx;
    p.dz = pose.dz;

    if (trip.distance >= trip.length - 1e-7) {
      this.walkFinished(p);
    }
  }

  private updateCars(): void {
    for (const car of this.population.cars) {
      if (
        car.owner < 0 ||
        car.driver === null ||
        !['driving', 'parking'].includes(car.status)
      ) {
        continue;
      }

      const p = this.population.people[car.driver]!;
      const trip = p.trip!;

      if (this.traffic.atStop(this.carVehicleId(car.id)) !== 1) {
        continue;
      }

      const family = this.population.families[p.family]!;

      if (car.status === 'driving') {
        if (car.waitUntil === 0) {
          car.waitUntil = this.seconds + 1;
          continue;
        }
        if (this.seconds < car.waitUntil) {
          continue;
        }

        const f = this.profile.facilities[car.facility!]!;
        const slot = this.parking.reserve(
          f.id,
          car.id,
          family.id,
          this.population.home(family).blockId,
        );

        if (!slot) {
          const home = this.population.home(family);
          const alternatives = this.destinationParking(
            p,
            this.population.place(trip.destination),
            car,
          ).filter(candidate => candidate.id !== f.id);
          const next =
            alternatives[0] ?? this.profile.facilities[home.parking!]!;

          if (!next || next.id === f.id) {
            car.waitUntil = this.seconds + 3;
            continue;
          }
          if (
            this.traffic.beginTrip(
              this.carVehicleId(car.id),
              this.network.drive(f.road, next.road),
            )
          ) {
            car.facility = next.id;
            trip.facility = next.id;
            car.waitUntil = 0;
            this.population.event(
              p,
              this.seconds,
              'Парковка занята — едет к другому месту',
            );
          }

          continue;
        }
        if (this.portals.has(f.id)) {
          this.parking.cancel(car.id);
          continue;
        }

        const manoeuvre = this.parkingManoeuvre(f, slot, true);

        if (
          this.traffic.beginTrip(
            this.carVehicleId(car.id),
            manoeuvre.route,
            manoeuvre.route.length,
          )
        ) {
          this.portals.set(f.id, car.id);
          car.status = 'parking';
          car.targetSlot = slot.id;
          trip.leg = 'parking';
          trip.reason = 'Место свободно: выполняет парковочный манёвр';
          this.population.event(p, this.seconds, `Паркуется: ${f.name}`);
        } else {
          this.parking.cancel(car.id);
        }
      } else {
        this.parking.park(car.targetSlot!, car.id);
        this.traffic.park(this.carVehicleId(car.id));
        car.slot = car.targetSlot;
        car.targetSlot = null;
        car.status = 'parked';
        car.driver = null;
        p.activity = 'garage';
        p.nextAt =
          this.seconds +
          (this.profile.facilities[this.parking.slots[car.slot!]!.facility]!
            .kind === 'underground'
            ? 6
            : 2);
        trip.leg = 'from-car';
        this.population.event(p, this.seconds, 'Оставил машину на парковке');
      }
    }
  }

  inviteFamily(): boolean {
    if (
      this.bus.phase !== 'idle' ||
      !this.terminal ||
      !this.profile.arrival ||
      this.busVehicleId === null
    ) {
      return false;
    }

    let route;

    try {
      route = this.network.drive(this.profile.arrival, this.terminal.road);

      if (this.definition.kind === 'authored') {
        const slot = this.parking.slots[this.terminal.slots[0]!];
        const exit = this.definition.entries[0]?.exit;

        if (!slot || !exit) {
          return false;
        }

        this.network.drive(this.departure(this.terminal, slot), exit);
        const home = this.population.nextHome();

        if (!home) {
          return false;
        }

        this.network.walk(this.terminal.access, home.access);
      }
    } catch (error) {
      if (error instanceof NoNativeRoute) {
        return false;
      }

      throw error;
    }

    const family = this.population.createFamily(this.seconds, true);

    if (!family) {
      return false;
    }

    this.economy?.syncHiringCapacity();
    this.population.assignJobs(this.day, this.seconds);

    for (const id of family.members) {
      const p = this.population.people[id]!;

      p.activity = 'drive';
      p.location = this.population.home(family).id;
      p.trip = {
        purpose: 'move',
        destination: p.location,
        started: this.seconds,
        reason: 'Приезжает в город на междугороднем микроавтобусе',
        leg: 'driving',
        car: -1,
        points: [],
        distance: 0,
        length: 0,
        facility: this.terminal.id,
      };
    }

    if (!this.traffic.beginTrip(this.busVehicleId, route)) {
      throw new Error('Arrival entrance is occupied');
    }

    this.bus = {
      phase: 'approach',
      family: family.id,
      slot: null,
      until: 0,
      terminal: this.terminal.id,
    };
    this.nextImmigration = this.seconds + 900;

    return true;
  }

  private updateBus(): void {
    if (this.busVehicleId === null || !this.terminal || !this.profile.arrival) {
      return;
    }

    const terminal =
      this.bus.terminal === null
        ? this.terminal
        : this.profile.facilities[this.bus.terminal]!;

    if (this.bus.phase === 'idle') {
      const trainExpected =
        this.expanded && this.railway.snapshot().train.phase !== 'away';

      if (this.seconds >= this.nextImmigration && !trainExpected) {
        if (!this.inviteFamily() && this.definition.kind === 'authored') {
          this.nextImmigration = this.seconds + 3;
        }
      }

      return;
    }
    if (this.bus.phase === 'unloading') {
      if (this.seconds < this.bus.until) {
        return;
      }

      const slot = this.parking.slots[this.bus.slot!]!;
      const exit = this.parkingManoeuvre(terminal, slot, false).route;
      let road;

      try {
        road = this.network.drive(
          this.departure(terminal, slot),
          this.definition.kind === 'authored'
            ? this.definition.entries[0]!.exit
            : roadAccess(
                {x: this.profile.arrival.point.x, z: -87, y: 0.91},
                2,
                this.network.roads,
              ),
        );
      } catch (error) {
        if (error instanceof NoNativeRoute) {
          return;
        }

        throw error;
      }

      if (
        this.traffic.beginTrip(
          this.busVehicleId,
          new RouteBuilder(slot.position).append(exit).append(road).route(),
          exit.length,
        )
      ) {
        this.parking.leave(-2);
        this.bus.phase = 'leaving';
      }

      return;
    }
    if (this.traffic.atStop(this.busVehicleId) !== 1) {
      return;
    }
    if (this.bus.phase === 'approach') {
      const slot = this.parking.reserve(terminal.id, -2, -1, '');
      const entry = slot
        ? this.parkingManoeuvre(terminal, slot, true).route
        : null;

      if (
        slot &&
        entry &&
        this.traffic.beginTrip(this.busVehicleId, entry, entry.length)
      ) {
        this.bus.phase = 'parking';
        this.bus.slot = slot.id;
      }
    } else if (this.bus.phase === 'parking') {
      this.parking.park(this.bus.slot!, -2);
      this.traffic.park(this.busVehicleId);
      const family = this.population.families[this.bus.family!]!;
      const slot = this.parking.slots[this.bus.slot!]!;
      const from = this.walkParking(terminal, slot);

      for (const id of family.members) {
        this.walkStart(
          this.population.people[id]!,
          from,
          this.population.home(family).access,
          'move',
          this.population.home(family),
          'walk',
          null,
          null,
          'Приехал в город. Идёт заселяться с семьёй',
        );
      }

      this.bus.phase = 'unloading';
      this.bus.until = this.seconds + 8;
    } else {
      this.traffic.park(this.busVehicleId);
      this.bus = {
        phase: 'idle',
        family: null,
        slot: null,
        until: 0,
        terminal: null,
      };
    }
  }

  private updateRailArrivals(configuration?: NativeRailwayConfiguration): void {
    const previous = this.railArrival;

    if (configuration) {
      this.railArrival =
        this.nativeRailArrivals.get(configuration.placement.id) ?? null;
    }

    const railway = configuration?.railway ?? this.railway;

    try {
      if (
        !configuration &&
        (!this.expanded || this.definition.kind === 'authored')
      ) {
        return;
      }

      const train = railway.snapshot().train;
      const localTrain = configuration
        ? configuration.transform.toLocal(train)
        : train;

      if (
        this.railArrival === null &&
        this.bus.phase === 'idle' &&
        this.seconds >= this.nextImmigration &&
        train.phase === 'arriving' &&
        Math.abs(localTrain.x - RAILWAY_STATION_X) / RAILWAY_SPEED < 25
      ) {
        if (configuration) {
          const home = this.population.nextHome();

          if (!home) {
            return;
          }

          try {
            this.network.walk(
              this.population.place(configuration.placement.stationPlaceId)
                .access,
              home.access,
            );
          } catch (error) {
            if (error instanceof NoNativeRoute) {
              return;
            }

            throw error;
          }
        }

        const family = this.population.createFamily(this.seconds, true);

        if (family) {
          this.population.assignJobs(this.day, this.seconds);

          for (const id of family.members) {
            const p = this.population.people[id]!;

            p.activity = 'train';
            p.location =
              configuration?.placement.stationPlaceId ?? 'railway-station';
            p.nextAt = Infinity;
            p.trip = {
              purpose: 'move',
              destination: this.population.home(family).id,
              started: this.seconds,
              reason: 'Приезжает в город поездом',
              leg: 'train',
              car: null,
              points: [],
              distance: 0,
              length: 0,
              facility: null,
            };
            this.population.event(
              p,
              this.seconds,
              'Приезжает с семьёй на городской вокзал',
            );
          }

          railway.recordPassengers(family.members.length);
          this.railArrival = {
            serial: train.serial,
            family: family.id,
            released: 0,
            nextAt: null,
          };
          this.nextImmigration = this.seconds + 900;
        }
      }

      const arrival = this.railArrival;

      if (!arrival || train.serial !== arrival.serial || !train.doorsOpen) {
        return;
      }
      if (arrival.nextAt === null) {
        arrival.nextAt = this.seconds + 1;
      }
      if (this.seconds < arrival.nextAt) {
        return;
      }

      const family = this.population.families[arrival.family]!;
      const id = family.members[arrival.released]!;
      const y = 1.4;
      const chain: Point[] =
        train.direction === 1
          ? [
              {x: -34, z: -130, y},
              {x: -24, z: -130, y},
              {x: -24, z: -126.5},
              {x: -24, z: -123.45},
            ]
          : [
              {x: -34, z: -142, y},
              {x: -33.7, z: -142, y},
              {x: -44.5, z: -142, y: 7.35},
              {x: -44.5, z: -130, y: 7.35},
              {x: -33.7, z: -130, y},
              {x: -24, z: -130, y},
              {x: -24, z: -126.5},
              {x: -24, z: -123.45},
            ];
      const actualChain = configuration?.arrivalChain(train.direction) ?? chain;
      const from = this.network.access(actualChain[0]!, actualChain.slice(1));

      this.walkStart(
        this.population.people[id]!,
        from,
        this.population.home(family).access,
        'move',
        this.population.home(family),
        'walk',
        null,
        null,
        'Вышел из поезда. Идёт с вокзала заселяться с семьёй',
      );
      railway.disembarkPassenger();
      arrival.released++;
      arrival.nextAt = this.seconds + 1.4;

      if (arrival.released >= family.members.length) {
        this.railArrival = null;
      }
    } finally {
      if (configuration) {
        this.nativeRailArrivals.set(
          configuration.placement.id,
          this.railArrival,
        );
        this.railArrival = previous;
      }
    }
  }

  private step(): void {
    if (
      this.definition.kind === 'authored' &&
      [...this.definition.placements, ...(this.definition.spaces ?? [])].some(
        placement =>
          (placement.readyAt ?? 0) > 0 &&
          placement.readyAt! <= this.seconds &&
          !this.population.hasPlace(placement.id),
      )
    ) {
      this.applyDefinitionUpdate(
        completeAuthoredConstruction(this.definition, this.seconds),
      );
    }

    this.railway.advance(this.seconds, {
      vehicles: this.traffic.movingPoses(),
      walkers: this.population.people
        .filter(p => p.activity === 'walk')
        .map(p => p.position),
    });

    for (const configuration of this.nativeRailways.values()) {
      configuration.railway.advance(this.seconds, {
        vehicles: this.traffic.movingPoses(),
        walkers: this.population.people
          .filter(person => person.activity === 'walk')
          .map(person => person.position),
      });
    }

    for (const configuration of this.nativePorts.values()) {
      configuration.harbor.advance(this.seconds, this.traffic);
    }

    for (const [facility, id] of this.portals) {
      const car = this.population.cars[id]!;

      if (
        car.status === 'parked' ||
        distance(
          this.traffic.pose(this.carVehicleId(id)),
          this.profile.facilities[facility]!.entrance,
        ) > 12
      ) {
        this.portals.delete(facility);
      }
    }

    const day = this.day;

    if (day !== this.dayDone) {
      this.population.daily(day, this.seconds);
      this.dayDone = day;
    }
    if (this.seconds >= this.nextAssets) {
      for (const f of this.population.families) {
        if (!f.arrived || !f.members.length) {
          continue;
        }

        const person = f.members
          .map(id => this.population.people[id]!)
          .find(
            p => p.activity === 'home' && this.population.age(p, day) >= 18,
          );

        if (!person) {
          continue;
        }

        const car = this.population.buyCar(f, this.seconds);

        if (car) {
          this.syncCars();
          this.startTrip(person, this.population.home(f), 'home', car.id);
        }
      }

      this.nextAssets = this.seconds + 180;
    }

    const cars = this.traffic.movingPoses();

    for (const p of this.population.people) {
      if (p.activity === 'walk') {
        this.moveWalker(p, cars);
      } else if (p.activity === 'garage' && this.seconds >= p.nextAt) {
        const trip = p.trip!;

        if (trip.leg === 'to-car') {
          this.driveStart(p);
        } else {
          const car = this.population.cars[trip.car!]!;
          const slot = this.parking.slots[car.slot!]!;
          const f = this.profile.facilities[slot.facility]!;

          this.walkStart(
            p,
            this.walkParking(f, slot),
            this.population.place(trip.destination).access,
            trip.purpose,
            this.population.place(trip.destination),
            'from-car',
            null,
            null,
            'Идёт от машины к месту назначения',
          );
        }
      } else if (
        p.activity !== 'drive' &&
        p.activity !== 'dead' &&
        this.seconds >= p.nextAt
      ) {
        this.plan(p);
      }
    }

    this.crossings = this.population.people
      .filter(p => p.activity === 'walk' && this.isOnRoad(p.position))
      .map(p => p.position);
    this.traffic.update(this.seconds);
    this.updateCars();
    this.updateRailArrivals();

    for (const configuration of this.nativeRailways.values()) {
      this.updateRailArrivals(configuration);
    }

    this.updateBus();
    this.economy?.step(this.seconds);
  }

  details(id: number): CitizenDetails | null {
    const p = this.population.people[id];

    if (!p) {
      return null;
    }

    const family = this.population.families[p.family]!;
    const home = this.population.home(family);

    return structuredClone({
      person: p,
      family,
      members: family.members.map(id => {
        const member = this.population.people[id]!;

        return {
          id,
          name: member.name,
          age: this.population.age(member, this.day),
          activity: member.activity,
        };
      }),
      age: this.population.age(p, this.day),
      home,
      ownsHome: this.population.units[family.home]!.owner === family.id,
      cars: family.cars.map(id => {
        const c = this.population.cars[id]!;

        return {
          ...c,
          name: carName(c.tier),
          place:
            c.slot === null
              ? 'В пути'
              : this.profile.facilities[this.parking.slots[c.slot]!.facility]!
                  .name,
        };
      }),
      destination: p.trip
        ? this.population.place(p.trip.destination).name
        : this.population.place(p.location).name,
      next:
        p.trip?.reason ??
        (p.activity === 'work'
          ? `Рабочая смена до ${Math.floor((p.job!.start + p.job!.shift) / 60)}:00`
          : p.activity === 'home'
            ? family.food < family.members.length * 3
              ? 'Нужно купить продукты'
              : 'Дела по расписанию'
            : 'Продолжит день после посещения'),
    });
  }

  frame(selected: number | null = null): LifeFrame {
    const people = this.population.people
      .filter(p => p.activity !== 'dead')
      .map(p => {
        let position = p.position;
        let yaw = Math.atan2(p.dx, p.dz);

        if (
          p.activity === 'drive' &&
          p.trip?.car !== null &&
          p.trip?.car !== undefined
        ) {
          const pose = this.traffic.pose(
            p.trip.car === -1
              ? this.busVehicleId!
              : this.carVehicleId(p.trip.car),
          );

          position = pose;
          yaw = Math.atan2(pose.dx, pose.dz);
        }
        if (p.activity === 'train') {
          const configuration = [...this.nativeRailways.values()].find(
            configuration =>
              this.nativeRailArrivals.get(configuration.placement.id)
                ?.family === p.family,
          );
          const train = (configuration?.railway ?? this.railway).snapshot()
            .train;

          position = {x: train.x, z: train.z, y: 1.4};
          yaw = (train.direction * Math.PI) / 2;
        }

        return {
          id: p.id,
          x: position.x,
          y: position.y ?? 1.07,
          z: position.z,
          yaw,
          visible:
            p.activity === 'walk' ||
            (p.activity === 'leisure' &&
              this.population.place(p.location).kind === 'park'),
          child: this.population.age(p, this.day) < 16,
        };
      });
    const cars = this.population.cars.map(car => {
      const slot = car.slot === null ? undefined : this.parking.slots[car.slot];
      const f = slot ? this.profile.facilities[slot.facility]! : undefined;
      const pose = slot
        ? {...slot.position, dx: Math.sin(slot.yaw), dz: Math.cos(slot.yaw)}
        : this.traffic.pose(this.carVehicleId(car.id));
      const garage =
        f?.kind === 'underground' ||
        (f?.kind === 'private' &&
          this.population.place(f.buildingId!).building?.plot?.annex ===
            'garage');

      return {
        id: car.id,
        x: pose.x,
        z: pose.z,
        y: pose.y ?? 0.91,
        yaw: Math.atan2(pose.dx, pose.dz),
        visible: car.owner >= 0 && !garage && (pose.y ?? 0.91) > -0.8,
        driver: car.driver,
        tier: car.tier,
      };
    });
    const positions = Array.from(
      {length: this.definition.kind === 'authored' ? 0 : AMBIENT_VEHICLES + 4},
      (_, id) => this.traffic.pose(id),
    );
    const busPose =
      this.bus.phase === 'unloading'
        ? {
            ...this.parking.slots[this.bus.slot!]!.position,
            dx: Math.sin(
              this.profile.facilities[this.bus.terminal ?? this.terminal!.id]!
                .yaw,
            ),
            dz: Math.cos(
              this.profile.facilities[this.bus.terminal ?? this.terminal!.id]!
                .yaw,
            ),
          }
        : this.busVehicleId === null
          ? {x: 0, z: 0, dx: 1, dz: 0, y: 0.91}
          : this.traffic.pose(this.busVehicleId);

    return {
      seconds: this.seconds,
      day: this.day + 1,
      minute: this.minute,
      population: people.length,
      families: this.population.families.filter(f => f.members.length).length,
      employed: this.population.people.filter(
        p => p.job && p.activity !== 'dead',
      ).length,
      born: this.population.born,
      arrived: this.population.arrivals,
      walking: this.population.people.filter(p => p.activity === 'walk').length,
      driving: this.population.cars.filter(
        c => c.driver !== null && c.status !== 'reserved',
      ).length,
      people,
      cars,
      carOwners: Object.fromEntries(
        this.population.cars
          .filter(c => c.owner >= 0)
          .map(c => [c.id, this.population.families[c.owner]!.members[0]!]),
      ),
      freight: this.economy
        ? [...this.nativePorts.values()]
            .flatMap(configuration =>
              configuration.truckIds.map(id => this.traffic.pose(id)),
            )
            .concat(this.economy.freight())
        : positions.slice(AMBIENT_VEHICLES),
      bus: {
        ...busPose,
        visible:
          this.bus.phase !== 'idle' &&
          busPose.x >= gridForLayout(this.profile.layout).bounds.minX + 2,
      },
      parking: this.parking.slots.map(
        ({id, occupant, reserved, household}) => ({
          id,
          occupant,
          reserved,
          household,
        }),
      ),
      catalog: this.population.people
        .filter(p => p.activity !== 'dead')
        .map(({id, name, family}) => ({id, name, family})),
      selected: selected === null ? null : this.details(selected),
      harbor: this.nativePorts.size
        ? [...this.nativePorts.values()][0]!.harbor.snapshot(
            this.seconds,
            this.portPoses(),
          )
        : this.definition.kind === 'authored'
          ? {
              ...this.harbor.snapshot(this.seconds, positions),
              ship: {
                ...this.harbor.snapshot(this.seconds, positions).ship,
                visible: false,
              },
              status: {...this.harbor.status(), freightTrucks: 0},
            }
          : this.harbor.snapshot(this.seconds, positions),
      harborStatus: this.nativePorts.size
        ? [...this.nativePorts.values()][0]!.harbor.status()
        : this.definition.kind === 'authored'
          ? {...this.harbor.status(), freightTrucks: 0}
          : this.harbor.status(),
      railway: this.nativeRailways.size
        ? [...this.nativeRailways.values()][0]!.railway.snapshot()
        : this.railway.snapshot(),
      railwayStatus: this.nativeRailways.size
        ? [...this.nativeRailways.values()][0]!.railway.status()
        : this.railway.status(),
      ...(this.definition.kind === 'authored'
        ? {
            ports: [...this.nativePorts].map(([id, configuration]) => ({
              id,
              snapshot: configuration.harbor.snapshot(
                this.seconds,
                this.portPoses(),
              ),
            })),
            railways: [...this.nativeRailways].map(([id, configuration]) => ({
              id,
              snapshot: configuration.railway.snapshot(),
              status: configuration.railway.status(),
            })),
            treasury: this.population.treasury,
            construction: Object.fromEntries(
              [...this.definition.placements, ...(this.definition.spaces ?? [])]
                .filter(placement => (placement.readyAt ?? 0) > 0)
                .map(placement => [
                  placement.id,
                  Math.max(
                    0,
                    Math.min(
                      1,
                      (this.seconds - (placement.startedAt ?? 0)) /
                        (placement.readyAt! - (placement.startedAt ?? 0)),
                    ),
                  ),
                ]),
            ),
          }
        : {}),
    };
  }

  save() {
    const snapshot = {
      version: 2 as const,
      expanded: this.expanded,
      railway: this.railway.save(),
      railArrival: structuredClone(this.railArrival),
      seed: this.profile.seed,
      tick: this.tick,
      requested: this.requested,
      dayDone: this.dayDone,
      carsAdded: this.carsAdded,
      nextImmigration: this.nextImmigration,
      nextAssets: this.nextAssets,
      bus: structuredClone(this.bus),
      portals: [...this.portals],
      population: this.population.save(),
      parking: structuredClone(this.parking.slots),
      traffic: this.traffic.save(),
      harbor: this.harbor.save(),
    };

    if (this.definition.kind === 'authored') {
      return {
        ...snapshot,
        version: 3 as const,
        definition: structuredClone(this.definition),
        vehicleIds: {cars: [...this.carVehicleIds], bus: this.busVehicleId},
        ...(this.economy ? {economy: this.economy.save()} : {}),
        ports: [...this.nativePorts].map(([id, configuration]) => ({
          id,
          truckIds: configuration.truckIds,
          harbor: configuration.harbor.save(),
        })),
        railways: [...this.nativeRailways].map(([id, configuration]) => ({
          id,
          railway: configuration.railway.save(),
          arrival: this.nativeRailArrivals.get(id) ?? null,
        })),
        junctionKeys:
          this.network instanceof RegionRouting
            ? this.network.savedJunctionKeys()
            : [],
      };
    }

    return snapshot;
  }

  static fromSave(value: unknown, definition?: CityWorldDefinition): CityLife {
    const input = value as CurrentSave | LegacySave;

    if (
      !input ||
      (input.version !== 1 && input.version !== 2 && input.version !== 3) ||
      typeof input.seed !== 'string' ||
      !Number.isInteger(input.tick) ||
      input.tick < 0 ||
      !Array.isArray(input.population?.people) ||
      input.population.people.length > 10000
    ) {
      throw new Error('Некорректное сохранение города');
    }

    const savedDefinition =
      input.version === 3 ? parseWorldDefinition(input.definition) : definition;

    if (savedDefinition && savedDefinition.seed !== input.seed) {
      throw new Error('Ключ описания не совпадает с сохранением');
    }
    if (input.version === 3 && savedDefinition?.kind !== 'authored') {
      throw new Error('Сохранение не содержит авторский мир');
    }

    const expanded = input.version === 1 || input.expanded;

    if (definition && definition.seed !== input.seed) {
      throw new Error('Ключ описания не совпадает с сохранённым миром');
    }
    if (definition && definition.expanded !== expanded) {
      throw new Error('Описание относится к другой планировке города');
    }

    const world = new CityLife(
      savedDefinition ?? input.seed,
      0,
      expanded,
      undefined,
      input.version === 3,
    );

    if (input.version === 3 && world.network instanceof RegionRouting) {
      world.network.update(
        world.profile.layout,
        input.definition.roads,
        input.junctionKeys,
      );
      world.traffic.setJunctions(world.network.junctions());
    }

    const s = input.version === 1 ? migrateLegacySave(input, world) : input;

    if (s.parking.length !== world.parking.slots.length) {
      throw new Error('Сохранение относится к другой планировке города');
    }

    world.population.restore(s.population);
    world.parking.slots.splice(
      0,
      world.parking.slots.length,
      ...structuredClone(s.parking),
    );

    if (s.version === 3) {
      const ids = [
        ...s.vehicleIds.cars,
        ...(s.vehicleIds.bus === null ? [] : [s.vehicleIds.bus]),
      ];

      if (
        s.vehicleIds.cars.length !== world.population.cars.length ||
        new Set(ids).size !== ids.length ||
        ids.some(
          id =>
            !Number.isInteger(id) || id < 0 || id >= s.traffic.vehicles.length,
        )
      ) {
        throw new Error('Изменились идентичности транспорта');
      }

      world.carVehicleIds.splice(
        0,
        world.carVehicleIds.length,
        ...s.vehicleIds.cars,
      );
      world.busVehicleId = s.vehicleIds.bus;
      world.carsAdded = s.carsAdded;
    } else {
      world.syncCars();
    }

    world.traffic.restore(s.traffic);

    if (s.version === 3 && s.economy) {
      world.economy?.restore(s.economy);
    } else if (s.version === 3) {
      world.economy?.rebaseExistingAccounts();
    }

    world.harbor.restore(s.harbor);
    world.tick = s.tick;
    world.requested = s.requested;
    world.dayDone = s.dayDone;
    world.carsAdded = s.carsAdded;
    world.nextImmigration = s.nextImmigration;
    world.nextAssets = s.nextAssets;
    world.bus = structuredClone(s.bus);
    world.railway.restore(s.railway);
    world.railArrival = structuredClone(s.railArrival);
    world.portals = new Map(s.portals);

    if (s.version === 3) {
      world.configureInfrastructure({
        ports: s.ports ?? [],
        railways: s.railways ?? [],
      });
    }

    for (const p of world.population.people) {
      if (
        p.id !== world.population.people.indexOf(p) ||
        !world.population.families[p.family] ||
        !Number.isFinite(p.position.x) ||
        !Number.isFinite(p.position.z)
      ) {
        throw new Error('Повреждён житель в сохранении');
      }

      world.population.place(p.location);

      if (p.trip) {
        world.population.place(p.trip.destination);

        if (p.nextAt === null) {
          p.nextAt = Infinity;
        }
      }
    }

    return world;
  }
}

type CurrentSave = ReturnType<CityLife['save']>;
type PrototypeSave = Extract<CurrentSave, {version: 2}>;
type LegacySave = Omit<
  PrototypeSave,
  'version' | 'expanded' | 'railway' | 'railArrival'
> & {version: 1};

/** Spatial identities survive map growth; numeric parking and junction slots do not. */
function migrateLegacySave(saved: LegacySave, world: CityLife): PrototypeSave {
  const legacy = createLifeProfile(
    createPrototypeDefinition(saved.seed, false).layout,
  );

  if (saved.parking.length !== legacy.slots.length) {
    throw new Error(
      'Сохранение относится к неподдерживаемой старой планировке',
    );
  }

  const key = (f: ParkingFacility) => `${f.kind}/${f.buildingId ?? f.blockId}`;
  const facilities = new Map(world.profile.facilities.map(f => [key(f), f]));
  const facilityIds = new Map<number, number>();
  const slots = new Map<number, number>();

  for (const old of legacy.facilities) {
    const next = facilities.get(key(old));

    if (!next) {
      throw new Error(`Не удалось перенести парковку: ${old.name}`);
    }

    facilityIds.set(old.id, next.id);
    old.slots.forEach((id, index) => {
      const nextId = next.slots[index];

      if (nextId === undefined) {
        throw new Error('Вместимость старой парковки изменилась');
      }

      slots.set(id, nextId);
    });
  }

  const slotId = (id: number | null) => (id === null ? null : slots.get(id)!);
  const facilityId = (id: number | null) =>
    id === null ? null : facilityIds.get(id)!;
  const data = structuredClone(saved);

  for (const slot of data.parking) {
    const target = world.parking.slots[slots.get(slot.id)!]!;

    target.occupant = slot.occupant;
    target.reserved = slot.reserved;
    target.household = slot.household;
  }

  for (const person of data.population.people) {
    if (person.trip) {
      person.trip.facility = facilityId(person.trip.facility);
    }
  }

  for (const car of data.population.cars) {
    car.slot = slotId(car.slot);
    car.targetSlot = slotId(car.targetSlot);
    car.facility = facilityId(car.facility);
  }

  for (const unit of data.population.units) {
    if (world.population.units[unit.id]?.building !== unit.building) {
      throw new Error('Изменились адреса старого жилья');
    }
  }

  const units = new Set(data.population.units.map(u => u.id));

  data.population.units.push(
    ...structuredClone(world.population.units.filter(u => !units.has(u.id))),
  );
  const businesses = new Set(data.population.businesses.map(b => b.building));

  data.population.businesses.push(
    ...structuredClone(
      world.population.businesses.filter(b => !businesses.has(b.building)),
    ),
  );
  const oldRoads = gridForLayout(legacy.layout).roads;
  const roads = world.network.roads;
  const gateId = (gate: number) => {
    if (gate < 0) {
      return gate;
    }

    const x = oldRoads[gate % oldRoads.length]!;
    const z = oldRoads[Math.floor(gate / oldRoads.length)]!;
    const col = roads.indexOf(x);
    const row = roads.indexOf(z);

    if (col < 0 || row < 0) {
      throw new Error('Не удалось перенести дорожную резервацию');
    }

    return row * roads.length + col;
  };
  const owners = new Array<number>(world.traffic.save().owners.length).fill(-1);

  data.traffic.owners.forEach((owner, gate) => {
    if (owner >= 0) {
      owners[gateId(gate)] = owner;
    }
  });
  data.traffic.owners = owners;
  data.traffic.held = data.traffic.held.map(gateId);
  const terminal =
    saved.bus.slot === null
      ? legacy.facilities
          .filter(f => f.kind === 'street' && f.road.direction === 1)
          .sort(
            (a, b) =>
              distance(a.road.point, legacy.arrival!.point) -
              distance(b.road.point, legacy.arrival!.point),
          )[0]!.id
      : saved.parking[saved.bus.slot]!.facility;
  const railway = new Railway(saved.tick * STEP, true, world.network.roads);

  return {
    ...data,
    version: 2,
    expanded: true,
    railway: railway.save(),
    railArrival: null,
    parking: structuredClone(world.parking.slots),
    bus: {
      ...data.bus,
      slot: slotId(data.bus.slot),
      terminal: facilityId(terminal),
    },
    portals: data.portals.map(([id, car]) => [facilityIds.get(id)!, car]),
  };
}
