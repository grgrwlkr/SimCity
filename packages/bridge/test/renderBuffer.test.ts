import { createWorld } from '@simcity/sim';
import { describe, expect, it } from 'vitest';
import { PARKED_VEHICLE_KIND, RenderReader, RenderWriter, createRenderBuffer, frameByteRange } from '../src/renderBuffer';

function worldWithVehicles(slots: readonly number[]) {
  const w = createWorld();
  for (const slot of slots) {
    w.vehicles.alive[slot] = 1;
    w.vehicles.x[slot] = slot + 0.5;
    w.vehicles.y[slot] = slot * 2;
    w.vehicles.heading[slot] = Math.fround(slot / 10);
    w.vehicles.kind[slot] = slot % 3;
  }
  return w;
}

function frameBytes(sab: SharedArrayBuffer, capacity: number, index: number): number[] {
  const { offset, length } = frameByteRange(capacity, index);
  return Array.from(new Uint8Array(sab, offset, length));
}

describe('render SharedArrayBuffer', () => {
  it('readerSeesTheLastPublishedFrame', () => {
    const sab = createRenderBuffer(16);
    const writer = new RenderWriter(sab);
    const reader = new RenderReader(sab);
    const out = reader.allocate();

    writer.publish(7, worldWithVehicles([2, 5]).vehicles);
    reader.readInto(out);

    expect(out.tick).toBe(7);
    expect(out.count).toBe(2);
    expect(Array.from(out.x.subarray(0, 2))).toEqual([2.5, 5.5]);
    expect(Array.from(out.y.subarray(0, 2))).toEqual([4, 10]);
    expect(Array.from(out.heading.subarray(0, 2))).toEqual([Math.fround(0.2), Math.fround(0.5)]);
    expect(Array.from(out.kind.subarray(0, 2))).toEqual([2, 2]);
  });

  it('parkedVehiclesArePublishedAsParked', () => {
    // A parked car stands on its lane: drawn like a driving one, a parking lot reads as a jam.
    const sab = createRenderBuffer(16);
    const writer = new RenderWriter(sab);
    const reader = new RenderReader(sab);
    const out = reader.allocate();
    const w = worldWithVehicles([1, 2]);
    w.vehicles.parked[2] = 1;

    writer.publish(1, w.vehicles);
    reader.readInto(out);

    expect(Array.from(out.kind.subarray(0, 2))).toEqual([1, PARKED_VEHICLE_KIND]);
  });

  it('publishingWritesTheFrameTheReaderDoesNotHold', () => {
    const capacity = 16;
    const sab = createRenderBuffer(capacity);
    const writer = new RenderWriter(sab);
    const reader = new RenderReader(sab);

    writer.publish(1, worldWithVehicles([1]).vehicles);
    const held = reader.activeFrameIndex();
    const heldBytes = frameBytes(sab, capacity, held);

    writer.publish(2, worldWithVehicles([3, 4]).vehicles);
    expect(reader.activeFrameIndex()).not.toBe(held);
    expect(frameBytes(sab, capacity, held), 'the previously active frame is untouched').toEqual(heldBytes);

    const out = reader.allocate();
    reader.readInto(out);
    expect(out.tick).toBe(2);
    expect(out.count).toBe(2);
  });

  it('publishRejectsMoreVehiclesThanTheBufferHolds', () => {
    const writer = new RenderWriter(createRenderBuffer(2));
    expect(() => writer.publish(1, worldWithVehicles([0, 1, 2]).vehicles)).toThrow(RangeError);
  });
});
