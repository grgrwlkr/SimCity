import {
  CARGO_CAPACITY,
  CARGO_HEIGHT,
  ORIGINAL_HARBOR_LAYOUT,
  type HarborLayout,
} from './harborLayout';
import type {CityTraffic, TrafficPlan} from './trafficFlow';
import type {LanePose} from './trafficRoutes';
import {nativePlacementTransform} from './nativeInfrastructurePlacement';
import type {
  NativeInfrastructurePlacement,
  NativePlacementTransform,
} from './nativeInfrastructurePlacement';

export type HarborFlow = 'import' | 'export';
type Place =
  | {kind: 'ship'; bay: number}
  | {kind: 'yard'; berth: number; flow: HarborFlow; bay: number}
  | {kind: 'warehouse'; warehouse: number; bay: number}
  | {kind: 'truck'; truck: number}
  | {kind: 'hoist'; hoist: number}
  | {kind: 'receiving'; warehouse: number; started: number};
export interface HarborShipment {
  id: string;
  quantity: number;
  unitPrice: number;
  warehouse: 0 | 1;
}

export interface HarborSupplyProvider {
  nextVisit?(after: number): number | null;
  exportTarget?(warehouse: 0 | 1): number;
  idle?(): boolean;
  imports(visit: number, warehouse: 0 | 1): readonly HarborShipment[] | null;
  takeExport(warehouse: 0 | 1): HarborShipment | null;
  receive(shipment: HarborShipment, warehouse: 0 | 1): boolean;
  exported(shipments: readonly HarborShipment[]): boolean;
}

export type HarborTraffic = Pick<CityTraffic, 'pose' | 'atStop' | 'release'>;

export interface HarborNavigation {
  readonly speed: number;
  readonly arrivals: readonly [
    ReadonlyArray<{x: number; z: number}>,
    ReadonlyArray<{x: number; z: number}>,
  ];
  readonly departures: readonly [
    ReadonlyArray<{x: number; z: number}>,
    ReadonlyArray<{x: number; z: number}>,
  ];
}

export interface HarborOptions {
  placement?: NativeInfrastructurePlacement;
  layout?: HarborLayout;
  provider?: HarborSupplyProvider;
  navigation?: HarborNavigation | undefined;
}

interface Cargo {
  id: number;
  slot: number;
  flow: HarborFlow;
  place: Place;
  shipment?: HarborShipment;
}
export interface CargoPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}
interface Job {
  cargo: Cargo;
  from: Place;
  to: Place;
  source: CargoPose;
  target: CargoPose;
  home: CargoPose;
  started: number;
  picked: boolean;
  dropped: boolean;
  truck: number | null;
}
export interface HarborStatus {
  shipPhase: 'arriving' | 'unloading' | 'loading' | 'leaving' | 'away';
  berth: number;
  shipCargo: number;
  yardCargo: number;
  freightTrucks: number;
  delivered: number;
  exported: number;
  departedEmpty: number;
  departedLoaded: number;
  created: number;
  activeCargo: number;
}
export interface HarborSnapshot {
  ship: {
    x: number;
    z: number;
    visible: boolean;
    mode: HarborFlow;
    yaw?: number;
  };
  cargo: Array<{
    id: number;
    slot: number;
    flow: HarborFlow;
    place: Place;
    pose: CargoPose;
    shipment?: HarborShipment;
  }>;
  hooks: CargoPose[];
  status: HarborStatus;
}

const JOB_SECONDS = 8;
const ARRIVE_SECONDS = 18;
const LEAVE_SECONDS = 14;
const smooth = (t: number) => {
  const x = Math.max(0, Math.min(1, t));

  return x * x * (3 - 2 * x);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const yawLerp = (a: number, b: number, t: number) =>
  a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const mix = (a: CargoPose, b: CargoPose, t: number): CargoPose => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
  yaw: yawLerp(a.yaw, b.yaw, t),
});

export function freightPlans(
  layout: HarborLayout = ORIGINAL_HARBOR_LAYOUT,
): Map<number, TrafficPlan> {
  return new Map(
    Array.from({length: 4}, (_, i) => [
      layout.truckIds[i]!,
      {...layout.freightRoutes[i % 2]!, initialStop: Math.floor(i / 2)},
    ]),
  );
}

/** Containers have one owner at a time. Ship, hoist, yard, truck and warehouse share the same cargo. */
export class Harbor {
  private cargo: Cargo[] = [];
  private jobs: Array<Job | null> = [null, null, null, null];
  private homes: CargoPose[] = [];
  private visit = 0;
  private phase: 'approach' | 'moored' | 'depart' | 'away' = 'moored';
  private phaseStarted = 0;
  private nextId = 0;
  private created = 0;
  private delivered = 0;
  private exported = 0;
  private departedEmpty = 0;
  private departedLoaded = 0;
  private production = [12, 12];
  private waitingSince: Array<number | null> = [null, null, null, null];

  private readonly placement: NativePlacementTransform | undefined;
  private readonly layout: HarborLayout;
  private readonly provider: HarborSupplyProvider | undefined;
  private readonly navigation: HarborNavigation | undefined;

  constructor(options: HarborOptions = {}) {
    this.placement = options.placement
      ? nativePlacementTransform(options.placement, {x: 85, z: 135})
      : undefined;
    this.layout = options.layout ?? ORIGINAL_HARBOR_LAYOUT;
    this.provider = options.provider;
    this.navigation = options.navigation;
    this.reset();
  }

  get berth(): number {
    return [0, 1, 1, 0][this.visit % 4]!;
  }

  get mode(): HarborFlow {
    return this.visit % 2 === 0 ? 'import' : 'export';
  }

  reset(): void {
    this.cargo = [];
    this.jobs = [null, null, null, null];
    this.visit = 0;
    this.phase = 'moored';
    this.phaseStarted = 0;
    this.nextId = 0;
    this.created = 0;
    this.delivered = 0;
    this.exported = 0;
    this.departedEmpty = 0;
    this.departedLoaded = 0;
    this.production = [12, 12];
    this.waitingSince = [null, null, null, null];
    this.homes = [
      ...this.layout.berths.map(x => ({x, y: 11, z: 138, yaw: Math.PI / 2})),
      ...this.layout.warehouses.map(yard => ({
        x: yard.x,
        y: 8.8,
        z: yard.z + 6,
        yaw: Math.PI / 2,
      })),
    ];

    if (this.provider) {
      this.phase = 'away';
      this.visit = 3;

      return;
    }

    for (let berth = 0; berth < 2; berth++) {
      for (let bay = 0; bay < 2; bay++) {
        this.create('export', {kind: 'yard', berth, flow: 'export', bay});
        this.create('export', {kind: 'warehouse', warehouse: berth, bay});
      }
    }

    for (let bay = 0; bay < 3; bay++) {
      this.create('import', {kind: 'ship', bay});
    }
  }

  private create(
    flow: HarborFlow,
    place: Place,
    shipment?: HarborShipment,
  ): Cargo {
    let slot = 0;

    while (this.cargo.some(c => c.slot === slot)) {
      slot++;
    }

    if (slot >= CARGO_CAPACITY) {
      throw new Error('Harbor cargo capacity exceeded');
    }

    const cargo: Cargo = {
      id: this.nextId++,
      slot,
      flow,
      place,
      ...(shipment ? {shipment} : {}),
    };

    this.cargo.push(cargo);
    this.created++;

    return cargo;
  }

  private count(predicate: (cargo: Cargo) => boolean): number {
    return this.cargo.filter(predicate).length;
  }

  private onShip(): Cargo[] {
    return this.cargo.filter(c => c.place.kind === 'ship');
  }

  private truckCargo(truck: number): Cargo | undefined {
    return this.cargo.find(
      c => c.place.kind === 'truck' && c.place.truck === truck,
    );
  }

  private truckBusy(truck: number): boolean {
    return this.jobs.some(job => job?.truck === truck);
  }

  private yard(berth: number, flow: HarborFlow): Cargo[] {
    return this.cargo.filter(
      c =>
        c.place.kind === 'yard' && c.place.berth === berth && c.flow === flow,
    );
  }

  private yardSlot(berth: number, flow: HarborFlow): number {
    for (let bay = 0; bay < 3; bay++) {
      if (
        !this.cargo.some(
          c =>
            c.place.kind === 'yard' &&
            c.place.berth === berth &&
            c.place.flow === flow &&
            c.place.bay === bay,
        )
      ) {
        return bay;
      }
    }

    return -1;
  }

  private voyageSeconds(arriving: boolean): number {
    if (!this.navigation) {
      return arriving ? ARRIVE_SECONDS : LEAVE_SECONDS;
    }

    const points = (
      arriving ? this.navigation.arrivals : this.navigation.departures
    )[this.berth]!;

    return (
      points
        .slice(1)
        .reduce(
          (length, point, i) =>
            length + Math.hypot(point.x - points[i]!.x, point.z - points[i]!.z),
          0,
        ) / this.navigation.speed
    );
  }

  private shipPose(seconds: number): HarborSnapshot['ship'] {
    const destination = this.layout.berths[this.berth]!;
    const t = seconds - this.phaseStarted;

    if (
      this.navigation &&
      (this.phase === 'approach' || this.phase === 'depart')
    ) {
      const points = (
        this.phase === 'approach'
          ? this.navigation.arrivals
          : this.navigation.departures
      )[this.berth]!;
      let distance = Math.max(0, t) * this.navigation.speed;

      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!;
        const b = points[i]!;
        const length = Math.hypot(b.x - a.x, b.z - a.z);

        if (distance <= length || i === points.length - 1) {
          const fraction = length ? Math.min(1, distance / length) : 1;

          return {
            x: lerp(a.x, b.x, fraction),
            z: lerp(a.z, b.z, fraction),
            yaw: Math.atan2(a.z - b.z, b.x - a.x),
            visible: true,
            mode: this.mode,
          };
        }

        distance -= length;
      }
    }

    const x =
      this.phase === 'approach'
        ? lerp(this.layout.shipEntryX, destination, smooth(t / ARRIVE_SECONDS))
        : this.phase === 'depart'
          ? lerp(destination, this.layout.shipExitX, smooth(t / LEAVE_SECONDS))
          : destination;

    return {x, z: 151, visible: this.phase !== 'away', mode: this.mode};
  }

  private point(
    place: Place,
    seconds: number,
    pose: (id: number) => LanePose,
  ): CargoPose {
    if (place.kind === 'ship') {
      const ship = this.shipPose(seconds);
      const yaw = ship.yaw ?? 0;

      return {
        x: ship.x + Math.cos(yaw) * (place.bay - 1) * 5,
        y: 2.4,
        z: ship.z - Math.sin(yaw) * (place.bay - 1) * 5,
        yaw: yaw + Math.PI / 2,
      };
    }
    if (place.kind === 'yard') {
      return {
        x: this.layout.berths[place.berth]! + (place.bay - 1) * 5,
        y: 1.25,
        z: place.flow === 'import' ? 142.8 : 145.8,
        yaw: Math.PI / 2,
      };
    }
    if (place.kind === 'warehouse') {
      const yard = this.layout.warehouses[place.warehouse]!;

      return {
        x: yard.x + (place.bay ? 6 : -6),
        y: 0.9,
        z: yard.z + 2,
        yaw: Math.PI / 2,
      };
    }
    if (place.kind === 'truck') {
      const p = pose(this.layout.truckIds[place.truck]!);

      return {
        x: p.x - p.dx * 1.2,
        y: 1.96,
        z: p.z - p.dz * 1.2,
        yaw: Math.atan2(p.dx, p.dz),
      };
    }
    if (place.kind === 'receiving') {
      const yard = this.layout.warehouses[place.warehouse]!;

      return {
        x: yard.x,
        y: 0.9,
        z: yard.z + lerp(2, -4.2, smooth((seconds - place.started) / 2)),
        yaw: 0,
      };
    }

    const hook = this.hook(place.hoist, seconds);

    return {...hook, y: hook.y - CARGO_HEIGHT};
  }

  private hook(index: number, seconds: number): CargoPose {
    const job = this.jobs[index];

    if (!job) {
      return this.homes[index]!;
    }

    const elapsed = Math.max(0, seconds - job.started);
    const clear = index < 2 ? 11 : 8.8;
    const sourceTop = {...job.source, y: job.source.y + CARGO_HEIGHT};
    const targetTop = {...job.target, y: job.target.y + CARGO_HEIGHT};
    const sourceHigh = {...sourceTop, y: clear};
    const targetHigh = {...targetTop, y: clear};

    if (elapsed < 1) {
      return mix(job.home, sourceHigh, smooth(elapsed));
    }
    if (elapsed < 2) {
      return mix(sourceHigh, sourceTop, smooth(elapsed - 1));
    }
    if (elapsed < 3.25) {
      return mix(sourceTop, sourceHigh, smooth((elapsed - 2) / 1.25));
    }
    if (elapsed < 5.25) {
      return mix(sourceHigh, targetHigh, smooth((elapsed - 3.25) / 2));
    }
    if (elapsed < 6.5) {
      return mix(targetHigh, targetTop, smooth((elapsed - 5.25) / 1.25));
    }

    return mix(targetTop, targetHigh, smooth((elapsed - 6.5) / 1.5));
  }

  private start(
    hoist: number,
    cargo: Cargo,
    to: Place,
    now: number,
    traffic: HarborTraffic,
    truck: number | null = null,
  ): void {
    const source = this.point(cargo.place, now, id => traffic.pose(id));
    const target = this.point(to, now, id => traffic.pose(id));

    this.jobs[hoist] = {
      cargo,
      from: cargo.place,
      to,
      source,
      target,
      home: this.homes[hoist]!,
      started: now,
      picked: false,
      dropped: false,
      truck,
    };
  }

  advance(now: number, traffic: HarborTraffic): void {
    const placement = this.placement;

    if (placement) {
      const original = traffic;

      traffic = {
        pose: id => placement.localVector(placement.toLocal(original.pose(id))),
        atStop: id => original.atStop(id),
        release: id => original.release(id),
      };
    }

    this.cargo = this.cargo.filter(cargo => {
      if (cargo.place.kind === 'receiving' && now - cargo.place.started >= 2) {
        if (
          cargo.shipment &&
          this.provider &&
          !this.provider.receive(cargo.shipment, cargo.place.warehouse as 0 | 1)
        ) {
          return true;
        }

        this.delivered++;

        return false;
      }

      return true;
    });
    this.jobs.forEach((job, hoist) => {
      if (!job) {
        return;
      }

      const elapsed = now - job.started;

      if (elapsed >= 2 && !job.picked) {
        job.cargo.place = {kind: 'hoist', hoist};
        job.picked = true;
      }
      if (elapsed >= 6.5 && !job.dropped) {
        job.cargo.place =
          job.to.kind === 'receiving' ? {...job.to, started: now} : job.to;
        job.dropped = true;
      }
      if (elapsed >= JOB_SECONDS) {
        this.homes[hoist] = {...job.target, y: hoist < 2 ? 11 : 8.8};
        this.jobs[hoist] = null;

        if (job.truck !== null) {
          this.waitingSince[job.truck] = now;
        }
      }
    });
    const elapsed = now - this.phaseStarted;

    if (this.phase === 'approach' && elapsed >= this.voyageSeconds(true)) {
      this.phase = 'moored';
      this.phaseStarted = now;
    }
    if (
      this.phase === 'moored' &&
      !this.jobs[this.berth] &&
      this.onShip().length ===
        (this.mode === 'import'
          ? 0
          : (this.provider?.exportTarget?.(this.berth as 0 | 1) ?? 3))
    ) {
      this.phase = 'depart';
      this.phaseStarted = now;
    } else if (
      this.phase === 'depart' &&
      elapsed >= this.voyageSeconds(false)
    ) {
      if (this.mode === 'import') {
        this.departedEmpty++;
      } else {
        const shipments = this.onShip().flatMap(c =>
          c.shipment ? [c.shipment] : [],
        );

        if (this.provider && !this.provider.exported(shipments)) {
          return;
        }

        if (this.onShip().length > 0) {
          this.departedLoaded++;
        } else {
          this.departedEmpty++;
        }

        this.exported += this.onShip().length;
        this.cargo = this.cargo.filter(c => c.place.kind !== 'ship');
      }

      this.phase = 'away';
      this.phaseStarted = now;
    } else if (this.phase === 'away' && elapsed >= 3) {
      const nextVisit = this.provider?.nextVisit
        ? this.provider.nextVisit(this.visit)
        : this.visit + 1;
      const imports =
        this.provider && nextVisit !== null && nextVisit % 2 === 0
          ? this.provider.imports(
              nextVisit,
              [0, 1, 1, 0][nextVisit % 4]! as 0 | 1,
            )
          : null;
      const admitted =
        nextVisit !== null &&
        (!this.provider || nextVisit % 2 !== 0 || !!imports?.length);

      if (imports && imports.length > 3) {
        throw new Error('Too many harbor import containers');
      }
      if (admitted) {
        this.visit = nextVisit;
        this.phase = 'approach';
        this.phaseStarted = now;

        if (this.mode === 'import') {
          for (let bay = 0; bay < (imports?.length ?? 3); bay++) {
            this.create('import', {kind: 'ship', bay}, imports?.[bay]);
          }
        }
      }
    }

    for (let warehouse = 0; warehouse < 2; warehouse++) {
      if (now >= this.production[warehouse]!) {
        for (let bay = 0; bay < 2; bay++) {
          const reserved = this.jobs[warehouse + 2]?.from;
          const used =
            this.cargo.some(
              c =>
                c.place.kind === 'warehouse' &&
                c.place.warehouse === warehouse &&
                c.place.bay === bay,
            ) ||
            (reserved?.kind === 'warehouse' &&
              reserved.warehouse === warehouse &&
              reserved.bay === bay);

          if (!used) {
            const shipment = this.provider?.takeExport(warehouse as 0 | 1);

            if (!this.provider || shipment) {
              this.create(
                'export',
                {kind: 'warehouse', warehouse, bay},
                shipment ?? undefined,
              );
            }

            break;
          }
        }

        this.production[warehouse] = now + 12;
      }
    }

    for (let truck = 0; truck < 4; truck++) {
      if (traffic.atStop(this.layout.truckIds[truck]!) === null) {
        this.waitingSince[truck] = null;
      } else if (this.waitingSince[truck] === null) {
        this.waitingSince[truck] = now;
      }
    }

    for (let berth = 0; berth < 2; berth++) {
      if (this.jobs[berth]) {
        continue;
      }
      if (this.phase === 'moored' && this.berth === berth) {
        const bay = this.yardSlot(berth, 'import');
        const incoming = this.onShip()[0];

        if (this.mode === 'import' && incoming && bay >= 0) {
          this.start(
            berth,
            incoming,
            {kind: 'yard', berth, flow: 'import', bay},
            now,
            traffic,
          );
          continue;
        }

        const outgoing = this.yard(berth, 'export')[0];

        if (this.mode === 'export' && outgoing && this.onShip().length < 3) {
          const bay = [0, 1, 2].find(
            bay =>
              !this.onShip().some(
                c => c.place.kind === 'ship' && c.place.bay === bay,
              ),
          )!;

          this.start(berth, outgoing, {kind: 'ship', bay}, now, traffic);
          continue;
        }
      }

      for (let truck = berth; truck < 4; truck += 2) {
        if (
          traffic.atStop(this.layout.truckIds[truck]!) !== 1 ||
          this.truckBusy(truck)
        ) {
          continue;
        }

        const load = this.truckCargo(truck);
        const incoming = this.yard(berth, 'import')[0];
        const bay = this.yardSlot(berth, 'export');

        if (load?.flow === 'export' && bay >= 0) {
          this.start(
            berth,
            load,
            {kind: 'yard', berth, flow: 'export', bay},
            now,
            traffic,
            truck,
          );
          break;
        }
        if (!load && incoming) {
          this.start(
            berth,
            incoming,
            {kind: 'truck', truck},
            now,
            traffic,
            truck,
          );
          break;
        }
      }
    }

    for (let warehouse = 0; warehouse < 2; warehouse++) {
      if (
        this.jobs[warehouse + 2] ||
        (this.provider &&
          this.cargo.some(
            c =>
              c.place.kind === 'receiving' && c.place.warehouse === warehouse,
          ))
      ) {
        continue;
      }

      for (let truck = warehouse; truck < 4; truck += 2) {
        if (
          traffic.atStop(this.layout.truckIds[truck]!) !== 0 ||
          this.truckBusy(truck)
        ) {
          continue;
        }

        const load = this.truckCargo(truck);

        if (load?.flow === 'import') {
          this.start(
            warehouse + 2,
            load,
            {kind: 'receiving', warehouse, started: now},
            now,
            traffic,
            truck,
          );
          break;
        }

        const stock = this.cargo.find(
          c => c.place.kind === 'warehouse' && c.place.warehouse === warehouse,
        );
        const exportsInTransit = this.count(
          c =>
            c.flow === 'export' &&
            c.place.kind === 'truck' &&
            c.place.truck % 2 === warehouse,
        );

        if (
          !load &&
          stock &&
          this.yard(warehouse, 'import').length === 0 &&
          this.yard(warehouse, 'export').length + exportsInTransit < 3
        ) {
          this.start(
            warehouse + 2,
            stock,
            {kind: 'truck', truck},
            now,
            traffic,
            truck,
          );
          break;
        }
      }
    }

    if (
      this.phase === 'away' &&
      this.provider?.idle?.() &&
      this.layout.truckIds.every(id => traffic.atStop(id) !== null)
    ) {
      return;
    }

    for (let truck = 0; truck < 4; truck++) {
      const stop = traffic.atStop(this.layout.truckIds[truck]!);

      if (stop === null || this.truckBusy(truck)) {
        continue;
      }

      if (
        this.phase === 'away' &&
        this.provider?.idle?.() &&
        stop === Math.floor(truck / 2)
      ) {
        continue;
      }

      const load = this.truckCargo(truck);
      const finished =
        stop === 0 ? load?.flow === 'export' : load?.flow === 'import';

      if (this.provider && !finished) {
        if (load) {
          // Real cargo waits for its receiving hoist instead of circulating past a blocked delivery.
          continue;
        }

        const warehouse = truck % 2;
        const peer = truck < 2 ? truck + 2 : truck - 2;
        const peerLoad = this.truckCargo(peer);
        const incomingFlow = stop === 0 ? 'import' : 'export';
        const peerDelivering =
          peerLoad?.flow === incomingFlow ||
          this.jobs.some(
            job =>
              job?.truck === peer &&
              job.to.kind === 'truck' &&
              job.cargo.flow === incomingFlow,
          );
        const pickupWaiting =
          stop === 0
            ? this.yard(warehouse, 'import').length > 0
            : this.cargo.some(
                cargo =>
                  cargo.flow === 'export' &&
                  cargo.place.kind === 'warehouse' &&
                  cargo.place.warehouse === warehouse,
              );
        const peerAtPickup =
          traffic.atStop(this.layout.truckIds[peer]!) === 1 - stop;

        // The opposite truck clears this stop while a real load is claimed. With no demand,
        // the pair remains balanced at the two original stops instead of deadlocking all loops.
        if (peerDelivering || (pickupWaiting && !peerAtPickup)) {
          traffic.release(this.layout.truckIds[truck]!);
        }

        continue;
      }

      if (finished || now - (this.waitingSince[truck] ?? now) >= 4) {
        traffic.release(this.layout.truckIds[truck]!);
      }
    }
  }

  status(): HarborStatus {
    return {
      shipPhase:
        this.phase === 'approach'
          ? 'arriving'
          : this.phase === 'depart'
            ? 'leaving'
            : this.phase === 'away'
              ? 'away'
              : this.mode === 'import'
                ? 'unloading'
                : 'loading',
      berth: this.berth + 1,
      shipCargo: this.onShip().length,
      yardCargo: this.count(c => c.place.kind === 'yard'),
      freightTrucks: 4,
      delivered: this.delivered,
      exported: this.exported,
      departedEmpty: this.departedEmpty,
      departedLoaded: this.departedLoaded,
      created: this.created,
      activeCargo: this.cargo.length,
    };
  }

  snapshot(seconds: number, poses: readonly LanePose[]): HarborSnapshot {
    const placement = this.placement;
    const snapshot: HarborSnapshot = {
      ship: this.shipPose(seconds),
      hooks: this.homes.map((_, i) => this.hook(i, seconds)),
      cargo: this.cargo.map(cargo => ({
        ...cargo,
        pose: this.point(cargo.place, seconds, id => {
          const pose = poses[id]!;

          return placement
            ? placement.localVector(placement.toLocal(pose))
            : pose;
        }),
      })),
      status: this.status(),
    };

    if (!placement) {
      return snapshot;
    }

    const worldPose = (pose: CargoPose): CargoPose => ({
      ...placement.toWorld(pose),
      yaw: pose.yaw + placement.yaw,
    });

    return {
      ...snapshot,
      ship: {
        ...placement.toWorld(snapshot.ship),
        yaw: (snapshot.ship.yaw ?? 0) + placement.yaw,
      },
      hooks: snapshot.hooks.map(worldPose),
      cargo: snapshot.cargo.map(cargo => ({
        ...cargo,
        pose: worldPose(cargo.pose),
      })),
    };
  }

  save() {
    return structuredClone({
      cargo: this.cargo,
      jobs: this.jobs.map(job => (job ? {...job, cargo: job.cargo.id} : null)),
      homes: this.homes,
      visit: this.visit,
      phase: this.phase,
      phaseStarted: this.phaseStarted,
      nextId: this.nextId,
      created: this.created,
      delivered: this.delivered,
      exported: this.exported,
      departedEmpty: this.departedEmpty,
      departedLoaded: this.departedLoaded,
      production: this.production,
      waitingSince: this.waitingSince,
    });
  }

  restore(saved: ReturnType<Harbor['save']>): void {
    const {jobs, ...state} = structuredClone(saved);

    Object.assign(this, state);
    this.jobs = jobs.map(job => {
      if (!job) {
        return null;
      }

      const cargo = this.cargo.find(cargo => cargo.id === job.cargo);

      if (!cargo) {
        throw new Error('Missing cargo in saved harbor job');
      }

      return {...job, cargo};
    });
  }
}
