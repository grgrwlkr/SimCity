import { describe, expect, it } from 'vitest';
import { Railway } from '../src/city/railway';
import { RAILWAY_STATION_X, RAILWAY_Z } from '../src/city/railwayLayout';

const empty = { vehicles: [], walkers: [] };

describe('railway', () => {
  it('arrives, opens doors at the platform and departs in alternating directions', () => {
    const rail = new Railway();
    expect(rail.snapshot().train.phase).toBe('away');
    rail.advance(40, empty);
    const train = rail.snapshot().train;
    expect(train.phase).toBe('boarding');
    expect(train.x).toBe(RAILWAY_STATION_X);
    expect(train.doorsOpen).toBe(true);
    expect(rail.boardingSerial()).toBe(1);
    rail.recordPassengers(3);
    expect(rail.status().passengers).toBe(3);
    expect(rail.status().crossingsClosed).toBe(0);
    rail.advance(210, empty);
    expect(rail.snapshot().train.phase).toBe('away');
    rail.advance(330, empty);
    expect(rail.snapshot().train.direction).toBe(-1);
    expect(rail.status().trains).toBe(2);
  });

  it('waits for a car in either lane and lets occupants escape while new entry is closed', () => {
    const rail = new Railway(0, true, [-119]);
    const car = { id: 1, x: -121, z: RAILWAY_Z, dx: 0, dz: 1, length: 3.8, width: 1.5 };
    rail.advance(100, { vehicles: [car], walkers: [] });
    expect(rail.snapshot().train.phase).toBe('arriving');
    expect(rail.snapshot().train.x + 11).toBeLessThan(-124.5);
    expect(rail.snapshot().crossings[0]?.state).toBe('closing');
    expect(rail.snapshot().crossings[0]?.occupied).toBe(true);
    expect(rail.blocksVehicle({ ...car, z: RAILWAY_Z + 14 }, car, car)).toBe(false);
    expect(rail.blocksVehicle({ ...car, z: RAILWAY_Z - 8 }, { ...car, z: RAILWAY_Z - 14 }, car)).toBe(true);
    rail.advance(160, empty);
    expect(rail.status().arrivals).toBe(1);
  });

  it('uses full vehicle footprints, pedestrian clearance and crossing sweep', () => {
    const rail = new Railway(0, true, [-119]);
    const walker = { x: -114.55, z: RAILWAY_Z };
    rail.advance(80, { vehicles: [], walkers: [walker] });
    expect(rail.snapshot().train.phase).toBe('arriving');
    expect(rail.blocksWalker({ x: -119, z: -125 }, { x: -119, z: -147 })).toBe(true);
    expect(rail.blocksWalker({ x: -119, z: -120 }, { x: -119, z: -136 })).toBe(false);
    expect(rail.blocksWalker({ x: -119, z: -125, y: 5 }, { x: -119, z: -147, y: 5 })).toBe(false);
    rail.advance(81, { vehicles: [{ id: 2, x: -119, z: -124, dx: 0, dz: 1, length: 8.6, width: 1.9 }], walkers: [] });
    expect(rail.snapshot().crossings[0]?.occupied).toBe(true);
    rail.advance(120, empty);
    expect(rail.status().arrivals).toBe(1);
  });

  it('signals and blocks new entries while holding arms raised until occupants clear', () => {
    const rail = new Railway(0, true, [-119]);
    const walker = { x: -119, z: RAILWAY_Z };
    rail.advance(10, { vehicles: [], walkers: [walker] });
    expect(rail.snapshot().crossings[0]?.state).toBe('closing');
    expect(rail.snapshot().crossings[0]?.openness).toBe(1);
    expect(rail.blocksWalker({ x: -119, z: -143 }, { x: -119, z: -148 })).toBe(true);
    expect(rail.blocksWalker({ x: -119, z: -120 }, walker)).toBe(false);
    const stopped = rail.snapshot().train.x;
    rail.advance(11, empty);
    expect(rail.snapshot().crossings[0]?.state).toBe('closing');
    expect(rail.snapshot().crossings[0]?.openness).toBeCloseTo(0.6);
    expect(rail.snapshot().train.x).toBe(stopped);
    rail.advance(13, empty);
    expect(rail.snapshot().crossings[0]?.state).toBe('closed');
    expect(rail.snapshot().train.x).toBeGreaterThan(stopped);
  });

  it('records arriving passengers before doors open and preserves them until the platform', () => {
    const rail = new Railway();
    expect(() => rail.recordPassengers(3)).toThrow();
    rail.advance(6, empty);
    rail.recordPassengers(3);
    expect(rail.snapshot().train.doorsOpen).toBe(false);
    expect(rail.snapshot().train.passengers).toBe(3);
    rail.advance(40, empty);
    expect(rail.snapshot().train.passengers).toBe(3);
    expect(rail.status().passengers).toBe(3);
    expect(() => rail.recordPassengers(-1)).toThrow();
  });

  it('disembarks one passenger through open doors without losing the cumulative arrival count', () => {
    const rail = new Railway();
    rail.advance(6, empty);
    rail.recordPassengers(3);
    expect(() => rail.disembarkPassenger()).toThrow();
    rail.advance(40, empty);
    rail.disembarkPassenger();
    expect(rail.snapshot().train.passengers).toBe(2);
    rail.disembarkPassenger();
    rail.disembarkPassenger();
    expect(rail.snapshot().train.passengers).toBe(0);
    expect(rail.status().passengers).toBe(3);
    expect(() => rail.disembarkPassenger()).toThrow();
  });

  it('closes the next gate before leaving the platform and waits for clearance', () => {
    const rail = new Railway(0, true, [-17]);
    rail.advance(15, empty);
    expect(rail.snapshot().train.phase).toBe('boarding');
    const car = { id: 1, x: -15, z: RAILWAY_Z, dx: 0, dz: -1, length: 3.8, width: 1.5 };
    rail.advance(40, { vehicles: [car], walkers: [] });
    expect(rail.snapshot().train.phase).toBe('leaving');
    expect(rail.status().departures).toBe(1);
    expect(rail.snapshot().train.x + 11).toBeLessThan(-22.5);
    expect(rail.snapshot().crossings[0]?.state).toBe('closing');
    rail.advance(60, empty);
    expect(rail.status().departures).toBe(1);
  });

  it('tests an existing vehicle footprint separately from its larger proposed maneuver sweep', () => {
    const rail = new Railway(0, true, [-119]);
    rail.advance(12, empty);
    const current = { x: -121, z: -150, dx: 0, dz: 1 };
    const proposed = { ...current, z: -141 };
    expect(rail.blocksVehicle(proposed, current, { length: 12, width: 4 }, { length: 3, width: 1.5 })).toBe(true);
  });

  it('preserves gates, dwell and timetable across save, pause and frame partitioning', () => {
    const a = new Railway();
    const b = new Railway();
    a.advance(90, empty);
    for (let i = 1; i <= 900; i++) {
      b.advance(i / 10, empty);
    }
    expect(a.save()).toEqual(b.save());
    const saved = JSON.parse(JSON.stringify(a.save())) as ReturnType<Railway['save']>;
    b.restore(saved);
    b.advance(90, empty);
    expect(b.save()).toEqual(a.save());
    a.advance(380, empty);
    b.advance(380, empty);
    expect(a.save()).toEqual(b.save());
    const disabled = new Railway(0, false);
    disabled.advance(1000, empty);
    expect(disabled.snapshot().train.phase).toBe('away');
    expect(disabled.status().trains).toBe(0);
  });

  it.each([8, 40, 75, 235])('resumes the same train and gate motion from second %s', (seconds) => {
    const rail = new Railway();
    rail.advance(seconds, empty);
    const saved = JSON.parse(JSON.stringify(rail.save())) as ReturnType<Railway['save']>;
    const restored = new Railway();
    restored.restore(saved);
    expect(restored.snapshot()).toEqual(rail.snapshot());
    for (let i = 1; i <= 500; i++) {
      restored.advance(seconds + i / 10, empty);
    }
    rail.advance(seconds + 50, empty);
    expect(restored.save()).toEqual(rail.save());
  });

  it('starts on the supplied world clock without replaying earlier visits', () => {
    const rail = new Railway(1000);
    rail.advance(1004, empty);
    expect(rail.status().trains).toBe(0);
    rail.advance(1040, empty);
    expect(rail.status().trains).toBe(1);
    expect(rail.snapshot().train.phase).toBe('boarding');
    rail.reset(2000);
    expect(rail.status().trains).toBe(0);
    expect(rail.status().nextInSeconds).toBe(5);
  });
});
