import { AMBIENT_VEHICLES, BERTHS, CARGO_CAPACITY, CARGO_HEIGHT, FREIGHT_ROUTES, WAREHOUSES } from './harborLayout';
import type { CityTraffic, TrafficPlan } from './trafficFlow';
import type { LanePose } from './trafficRoutes';

type Flow = 'import' | 'export';
type Place =
  | { kind: 'ship'; bay: number }
  | { kind: 'yard'; berth: number; flow: Flow; bay: number }
  | { kind: 'warehouse'; warehouse: number; bay: number }
  | { kind: 'truck'; truck: number }
  | { kind: 'hoist'; hoist: number }
  | { kind: 'receiving'; warehouse: number; started: number };
interface Cargo { id: number; slot: number; flow: Flow; place: Place }
export interface CargoPose { x: number; y: number; z: number; yaw: number }
interface Job {
  cargo: Cargo; from: Place; to: Place; source: CargoPose; target: CargoPose;
  home: CargoPose; started: number; picked: boolean; dropped: boolean; truck: number | null;
}
export interface HarborStatus {
  shipPhase: 'arriving' | 'unloading' | 'loading' | 'leaving' | 'away';
  berth: number; shipCargo: number; yardCargo: number; freightTrucks: number;
  delivered: number; exported: number; departedEmpty: number; departedLoaded: number;
  created: number; activeCargo: number;
}
export interface HarborSnapshot {
  ship: { x: number; z: number; visible: boolean; mode: Flow };
  cargo: Array<{ id: number; slot: number; flow: Flow; place: Place; pose: CargoPose }>;
  hooks: CargoPose[];
  status: HarborStatus;
}

const JOB_SECONDS = 8;
const ARRIVE_SECONDS = 18;
const LEAVE_SECONDS = 14;
const smooth = (t: number) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const yawLerp = (a: number, b: number, t: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
const mix = (a: CargoPose, b: CargoPose, t: number): CargoPose => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t), yaw: yawLerp(a.yaw, b.yaw, t) });

export function freightPlans(): Map<number, TrafficPlan> {
  return new Map(Array.from({ length: 4 }, (_, i) => [AMBIENT_VEHICLES + i, { ...FREIGHT_ROUTES[i % 2]!, initialStop: Math.floor(i / 2) }]));
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

  constructor() { this.reset(); }
  get berth(): number { return [0, 1, 1, 0][this.visit % 4]!; }
  get mode(): Flow { return this.visit % 2 === 0 ? 'import' : 'export'; }

  reset(): void {
    this.cargo = []; this.jobs = [null, null, null, null]; this.visit = 0; this.phase = 'moored'; this.phaseStarted = 0;
    this.nextId = 0; this.created = 0; this.delivered = 0; this.exported = 0; this.departedEmpty = 0; this.departedLoaded = 0;
    this.production = [12, 12]; this.waitingSince = [null, null, null, null];
    this.homes = [
      ...BERTHS.map((x) => ({ x, y: 11, z: 138, yaw: Math.PI / 2 })),
      ...WAREHOUSES.map((yard) => ({ x: yard.x, y: 8.8, z: yard.z + 6, yaw: Math.PI / 2 })),
    ];
    for (let berth = 0; berth < 2; berth++) for (let bay = 0; bay < 2; bay++) {
      this.create('export', { kind: 'yard', berth, flow: 'export', bay });
      this.create('export', { kind: 'warehouse', warehouse: berth, bay });
    }
    for (let bay = 0; bay < 3; bay++) this.create('import', { kind: 'ship', bay });
  }

  private create(flow: Flow, place: Place): Cargo {
    let slot = 0;
    while (this.cargo.some((c) => c.slot === slot)) slot++;
    if (slot >= CARGO_CAPACITY) throw new Error('Harbor cargo capacity exceeded');
    const cargo = { id: this.nextId++, slot, flow, place };
    this.cargo.push(cargo); this.created++; return cargo;
  }

  private count(predicate: (cargo: Cargo) => boolean): number { return this.cargo.filter(predicate).length; }
  private onShip(): Cargo[] { return this.cargo.filter((c) => c.place.kind === 'ship'); }
  private truckCargo(truck: number): Cargo | undefined { return this.cargo.find((c) => c.place.kind === 'truck' && c.place.truck === truck); }
  private truckBusy(truck: number): boolean { return this.jobs.some((job) => job?.truck === truck); }
  private yard(berth: number, flow: Flow): Cargo[] { return this.cargo.filter((c) => c.place.kind === 'yard' && c.place.berth === berth && c.flow === flow); }
  private yardSlot(berth: number, flow: Flow): number {
    for (let bay = 0; bay < 3; bay++) if (!this.cargo.some((c) => c.place.kind === 'yard' && c.place.berth === berth && c.place.flow === flow && c.place.bay === bay)) return bay;
    return -1;
  }

  private shipPose(seconds: number): HarborSnapshot['ship'] {
    const destination = BERTHS[this.berth]!;
    const t = seconds - this.phaseStarted;
    const x = this.phase === 'approach' ? lerp(-158, destination, smooth(t / ARRIVE_SECONDS))
      : this.phase === 'depart' ? lerp(destination, 160, smooth(t / LEAVE_SECONDS)) : destination;
    return { x, z: 151, visible: this.phase !== 'away', mode: this.mode };
  }

  private point(place: Place, seconds: number, pose: (id: number) => LanePose): CargoPose {
    if (place.kind === 'ship') return { x: this.shipPose(seconds).x + (place.bay - 1) * 5, y: 2.4, z: 151, yaw: Math.PI / 2 };
    if (place.kind === 'yard') return { x: BERTHS[place.berth]! + (place.bay - 1) * 5, y: 1.25, z: place.flow === 'import' ? 142.8 : 145.8, yaw: Math.PI / 2 };
    if (place.kind === 'warehouse') {
      const yard = WAREHOUSES[place.warehouse]!;
      return { x: yard.x + (place.bay ? 6 : -6), y: 0.9, z: yard.z + 2, yaw: Math.PI / 2 };
    }
    if (place.kind === 'truck') {
      const p = pose(AMBIENT_VEHICLES + place.truck);
      return { x: p.x - p.dx * 1.2, y: 1.96, z: p.z - p.dz * 1.2, yaw: Math.atan2(p.dx, p.dz) };
    }
    if (place.kind === 'receiving') {
      const yard = WAREHOUSES[place.warehouse]!;
      return { x: yard.x, y: 0.9, z: yard.z + lerp(2, -4.2, smooth((seconds - place.started) / 2)), yaw: 0 };
    }
    const hook = this.hook(place.hoist, seconds);
    return { ...hook, y: hook.y - CARGO_HEIGHT };
  }

  private hook(index: number, seconds: number): CargoPose {
    const job = this.jobs[index];
    if (!job) return this.homes[index]!;
    const elapsed = Math.max(0, seconds - job.started), clear = index < 2 ? 11 : 8.8;
    const sourceTop = { ...job.source, y: job.source.y + CARGO_HEIGHT };
    const targetTop = { ...job.target, y: job.target.y + CARGO_HEIGHT };
    const sourceHigh = { ...sourceTop, y: clear }, targetHigh = { ...targetTop, y: clear };
    if (elapsed < 1) return mix(job.home, sourceHigh, smooth(elapsed));
    if (elapsed < 2) return mix(sourceHigh, sourceTop, smooth(elapsed - 1));
    if (elapsed < 3.25) return mix(sourceTop, sourceHigh, smooth((elapsed - 2) / 1.25));
    if (elapsed < 5.25) return mix(sourceHigh, targetHigh, smooth((elapsed - 3.25) / 2));
    if (elapsed < 6.5) return mix(targetHigh, targetTop, smooth((elapsed - 5.25) / 1.25));
    return mix(targetTop, targetHigh, smooth((elapsed - 6.5) / 1.5));
  }

  private start(hoist: number, cargo: Cargo, to: Place, now: number, traffic: CityTraffic, truck: number | null = null): void {
    const source = this.point(cargo.place, now, (id) => traffic.pose(id));
    const target = this.point(to, now, (id) => traffic.pose(id));
    this.jobs[hoist] = { cargo, from: cargo.place, to, source, target, home: this.homes[hoist]!, started: now, picked: false, dropped: false, truck };
  }

  advance(now: number, traffic: CityTraffic): void {
    this.cargo = this.cargo.filter((cargo) => {
      if (cargo.place.kind === 'receiving' && now - cargo.place.started >= 2) { this.delivered++; return false; }
      return true;
    });
    this.jobs.forEach((job, hoist) => {
      if (!job) return;
      const elapsed = now - job.started;
      if (elapsed >= 2 && !job.picked) { job.cargo.place = { kind: 'hoist', hoist }; job.picked = true; }
      if (elapsed >= 6.5 && !job.dropped) {
        job.cargo.place = job.to.kind === 'receiving' ? { ...job.to, started: now } : job.to;
        job.dropped = true;
      }
      if (elapsed >= JOB_SECONDS) {
        this.homes[hoist] = { ...job.target, y: hoist < 2 ? 11 : 8.8 };
        this.jobs[hoist] = null;
        if (job.truck !== null) this.waitingSince[job.truck] = now;
      }
    });
    const elapsed = now - this.phaseStarted;
    if (this.phase === 'approach' && elapsed >= ARRIVE_SECONDS) { this.phase = 'moored'; this.phaseStarted = now; }
    if (this.phase === 'moored' && !this.jobs[this.berth] && this.onShip().length === (this.mode === 'import' ? 0 : 3)) {
      this.phase = 'depart'; this.phaseStarted = now;
    } else if (this.phase === 'depart' && elapsed >= LEAVE_SECONDS) {
      if (this.mode === 'import') this.departedEmpty++;
      else { this.departedLoaded++; this.exported += this.onShip().length; this.cargo = this.cargo.filter((c) => c.place.kind !== 'ship'); }
      this.phase = 'away'; this.phaseStarted = now;
    } else if (this.phase === 'away' && elapsed >= 3) {
      this.visit++; this.phase = 'approach'; this.phaseStarted = now;
      if (this.mode === 'import') for (let bay = 0; bay < 3; bay++) this.create('import', { kind: 'ship', bay });
    }
    for (let warehouse = 0; warehouse < 2; warehouse++) if (now >= this.production[warehouse]!) {
      for (let bay = 0; bay < 2; bay++) {
        const reserved = this.jobs[warehouse + 2]?.from;
        const used = this.cargo.some((c) => c.place.kind === 'warehouse' && c.place.warehouse === warehouse && c.place.bay === bay)
          || (reserved?.kind === 'warehouse' && reserved.warehouse === warehouse && reserved.bay === bay);
        if (!used) { this.create('export', { kind: 'warehouse', warehouse, bay }); break; }
      }
      this.production[warehouse] = now + 12;
    }
    for (let truck = 0; truck < 4; truck++) {
      if (traffic.atStop(AMBIENT_VEHICLES + truck) === null) this.waitingSince[truck] = null;
      else if (this.waitingSince[truck] === null) this.waitingSince[truck] = now;
    }
    for (let berth = 0; berth < 2; berth++) {
      if (this.jobs[berth]) continue;
      if (this.phase === 'moored' && this.berth === berth) {
        const bay = this.yardSlot(berth, 'import'), incoming = this.onShip()[0];
        if (this.mode === 'import' && incoming && bay >= 0) { this.start(berth, incoming, { kind: 'yard', berth, flow: 'import', bay }, now, traffic); continue; }
        const outgoing = this.yard(berth, 'export')[0];
        if (this.mode === 'export' && outgoing && this.onShip().length < 3) {
          const bay = [0, 1, 2].find((bay) => !this.onShip().some((c) => c.place.kind === 'ship' && c.place.bay === bay))!;
          this.start(berth, outgoing, { kind: 'ship', bay }, now, traffic); continue;
        }
      }
      for (let truck = berth; truck < 4; truck += 2) {
        if (traffic.atStop(AMBIENT_VEHICLES + truck) !== 1 || this.truckBusy(truck)) continue;
        const load = this.truckCargo(truck), incoming = this.yard(berth, 'import')[0], bay = this.yardSlot(berth, 'export');
        if (load?.flow === 'export' && bay >= 0) { this.start(berth, load, { kind: 'yard', berth, flow: 'export', bay }, now, traffic, truck); break; }
        if (!load && incoming) { this.start(berth, incoming, { kind: 'truck', truck }, now, traffic, truck); break; }
      }
    }
    for (let warehouse = 0; warehouse < 2; warehouse++) {
      if (this.jobs[warehouse + 2]) continue;
      for (let truck = warehouse; truck < 4; truck += 2) {
        if (traffic.atStop(AMBIENT_VEHICLES + truck) !== 0 || this.truckBusy(truck)) continue;
        const load = this.truckCargo(truck);
        if (load?.flow === 'import') { this.start(warehouse + 2, load, { kind: 'receiving', warehouse, started: now }, now, traffic, truck); break; }
        const stock = this.cargo.find((c) => c.place.kind === 'warehouse' && c.place.warehouse === warehouse);
        const exportsInTransit = this.count((c) => c.flow === 'export' && c.place.kind === 'truck' && c.place.truck % 2 === warehouse);
        if (!load && stock && this.yard(warehouse, 'import').length === 0 && this.yard(warehouse, 'export').length + exportsInTransit < 3) {
          this.start(warehouse + 2, stock, { kind: 'truck', truck }, now, traffic, truck); break;
        }
      }
    }
    for (let truck = 0; truck < 4; truck++) {
      const stop = traffic.atStop(AMBIENT_VEHICLES + truck);
      if (stop === null || this.truckBusy(truck)) continue;
      const load = this.truckCargo(truck);
      const finished = stop === 0 ? load?.flow === 'export' : load?.flow === 'import';
      if (finished || now - (this.waitingSince[truck] ?? now) >= 4) traffic.release(AMBIENT_VEHICLES + truck);
    }
  }

  status(): HarborStatus {
    return {
      shipPhase: this.phase === 'approach' ? 'arriving' : this.phase === 'depart' ? 'leaving' : this.phase === 'away' ? 'away' : this.mode === 'import' ? 'unloading' : 'loading',
      berth: this.berth + 1, shipCargo: this.onShip().length, yardCargo: this.count((c) => c.place.kind === 'yard'), freightTrucks: 4,
      delivered: this.delivered, exported: this.exported, departedEmpty: this.departedEmpty, departedLoaded: this.departedLoaded,
      created: this.created, activeCargo: this.cargo.length,
    };
  }

  snapshot(seconds: number, poses: readonly LanePose[]): HarborSnapshot {
    return { ship: this.shipPose(seconds), hooks: this.homes.map((_, i) => this.hook(i, seconds)),
      cargo: this.cargo.map((cargo) => ({ ...cargo, pose: this.point(cargo.place, seconds, (id) => poses[id]!) })), status: this.status() };
  }
}
