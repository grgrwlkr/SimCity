import {describe, expect, it} from 'vitest';
import {CameraKeyboard, stepCameraKeyboard} from '../src/region/cameraKeyboard';

const pose = () => ({
  position: {x: 0, y: 100, z: 100},
  target: {x: 0, y: 0, z: 0},
  zoom: 1,
});

function held(...codes: string[]): CameraKeyboard {
  const keys = new CameraKeyboard();

  for (const code of codes) {
    keys.press(code);
  }

  return keys;
}

describe('region keyboard camera', () => {
  it('moves forward along the ground relative to camera yaw', () => {
    const camera = pose();

    camera.position = {x: 100, y: 100, z: 0};
    stepCameraKeyboard(camera, held('KeyW'), 0.05);
    expect(camera.target.x).toBeLessThan(0);
    expect(camera.target.z).toBeCloseTo(0);
    expect(camera.position.x - camera.target.x).toBeCloseTo(100);
    expect(camera.position.y).toBe(100);
  });

  it('normalizes diagonal movement and scales it with zoom', () => {
    const straight = pose();
    const diagonal = pose();
    const zoomed = pose();

    zoomed.zoom = 2;
    stepCameraKeyboard(straight, held('KeyW'), 0.05);
    stepCameraKeyboard(diagonal, held('KeyW', 'KeyD'), 0.05);
    stepCameraKeyboard(zoomed, held('KeyW'), 0.05);
    expect(Math.hypot(diagonal.target.x, diagonal.target.z)).toBeCloseTo(
      Math.abs(straight.target.z),
    );
    expect(zoomed.target.z).toBeCloseTo(straight.target.z / 2);
    expect(diagonal.target.x).toBeGreaterThan(0);
  });

  it('has equal movement over equal time at different frame rates', () => {
    const slow = pose();
    const fast = pose();

    for (let i = 0; i < 30; i++) {
      stepCameraKeyboard(slow, held('KeyW', 'KeyD', 'KeyQ'), 1 / 30);
    }

    for (let i = 0; i < 120; i++) {
      stepCameraKeyboard(fast, held('KeyW', 'KeyD', 'KeyQ'), 1 / 120);
    }

    expect(fast.target.z).toBeCloseTo(slow.target.z);
    expect(fast.target.x).toBeCloseTo(slow.target.x);
    expect(fast.position.x).toBeCloseTo(slow.position.x);
    expect(fast.position.z).toBeCloseTo(slow.position.z);
  });

  it('orbits Q/E around the same target and preserves elevation and distance', () => {
    const left = pose();
    const right = pose();

    stepCameraKeyboard(left, held('KeyQ'), 0.05);
    stepCameraKeyboard(right, held('KeyE'), 0.05);
    expect(left.position.x).toBeGreaterThan(0);
    expect(right.position.x).toBeCloseTo(-left.position.x);
    expect(left.position.z).toBeCloseTo(right.position.z);
    expect(left.target).toEqual({x: 0, y: 0, z: 0});
    expect(left.position.y).toBe(100);
    expect(Math.hypot(left.position.x, left.position.z)).toBeCloseTo(100);
  });

  it('caps resume gaps and ignores negative deltas', () => {
    const resumed = pose();
    const bounded = pose();
    const negative = pose();

    stepCameraKeyboard(resumed, held('KeyW', 'KeyQ'), 30);
    stepCameraKeyboard(bounded, held('KeyW', 'KeyQ'), 0.05);
    stepCameraKeyboard(negative, held('KeyW'), -1);
    expect(resumed).toEqual(bounded);
    expect(negative).toEqual(pose());
  });

  it('cancels opposing keys and stops on key release or focus reset', () => {
    const camera = pose();
    const keys = held('KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE');

    stepCameraKeyboard(camera, keys, 0.05);
    expect(camera).toEqual(pose());
    keys.clear();
    expect(keys.active).toBe(false);
    keys.press('KeyW');
    keys.release('KeyW');
    stepCameraKeyboard(camera, keys, 0.05);
    expect(camera).toEqual(pose());
  });

  it('uses physical key codes, rejects shortcuts, and clears held keys when blocked', () => {
    const keys = new CameraKeyboard();

    expect(keys.press('ц')).toBe(false);
    expect(keys.press('KeyW')).toBe(true);
    expect(keys.press('KeyA', true)).toBe(false);
    expect(keys.active).toBe(false);
    expect(keys.press('Enter')).toBe(false);
    keys.press('KeyQ');
    keys.clear();
    expect(keys.active).toBe(false);
  });
});
