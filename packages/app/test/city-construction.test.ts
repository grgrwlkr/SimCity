import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Batch, material } from '../src/city/primitives';
import { Construction } from '../src/city/construction';
import { craneCycle } from '../src/city/constructionSite';

function fixture() {
  const batch = new Batch(),
    scene = new THREE.Group();
  batch.add('box', 'cream', -5, 3, 0, 3, 6, 3);
  const house = batch.capture((sink) => {
    sink.add('box', 'cream', 0, 5, 0, 8, 10, 8);
    sink.add('box', 'litWindow', 0, 4, 4.05, 2, 2, 0.1);
    sink.add('roof', 'roof', 0, 12, 0, 9, 4, 9);
    sink.add('cylinder', 'metal', 0, 16, 0, 0.2, 4, 0.2);
  });
  const factory = batch.capture((sink) => sink.add('cylinder', 'cream', 20, 15, 0, 2, 30, 2));
  batch.finish(scene);
  const construction = new Construction(
    new Map([
      ['house', house],
      ['factory', factory],
    ]),
  );
  const matrices = () => scene.children.map((m) => Array.from((m as THREE.InstancedMesh).instanceMatrix.array));
  return { scene, construction, matrices };
}

describe('building construction', () => {
  it('starts empty, reaches the actual roof equipment height and restores every original instance', () => {
    const { construction, matrices } = fixture();
    const original = matrices();
    construction.start('house', false);
    expect(construction.status()).toMatchObject({ progress: 0, height: 0, targetHeight: 18, running: false });
    expect(construction.group.visible).toBe(true);
    expect(construction.group.getObjectByName('construction-crane')).toBeDefined();
    expect(matrices()).not.toEqual(original);
    // The neighbouring building shares the same cream batch and must remain untouched.
    expect(matrices()[0]!.slice(0, 16)).toEqual(original[0]!.slice(0, 16));
    construction.play();
    let previous = 0;
    for (let i = 0; i < 101; i++) {
      construction.advance(0.1);
      const status = construction.status()!;
      expect(status.height).toBeGreaterThanOrEqual(previous);
      expect(status.height).toBeLessThanOrEqual(18);
      previous = status.height;
    }
    expect(construction.status()).toMatchObject({ progress: 1, height: 18, running: false });
    expect(construction.group.visible).toBe(false);
    expect(matrices()).toEqual(original);
    construction.dispose();
  });

  it('clips the facade without rescaling its windows and closes the real roof cross-section', () => {
    const { construction } = fixture();
    construction.start('house');
    const windows = construction.group.children.find(
      (m) =>
        m instanceof THREE.InstancedMesh &&
        (m.material as THREE.MeshStandardMaterial).emissive.equals(material('litWindow').emissive) &&
        m.geometry instanceof THREE.BoxGeometry &&
        m.count === 1 &&
        (m.material as THREE.MeshStandardMaterial).color.equals(material('litWindow').color),
    ) as THREE.InstancedMesh;
    const before = Array.from(windows.instanceMatrix.array);
    construction.seek(12 / 18);
    expect(Array.from(windows.instanceMatrix.array)).toEqual(before);
    expect((windows.material as THREE.MeshStandardMaterial).clippingPlanes).toEqual([construction.plane]);
    expect((windows.material as THREE.MeshStandardMaterial).clipShadows).toBe(true);
    const cap = construction.group.getObjectByName('construction-surface') as THREE.Mesh;
    const positions = cap.geometry.getAttribute('position');
    const vertices = Array.from({ length: cap.geometry.drawRange.count }, (_, i) =>
      new THREE.Vector3().fromBufferAttribute(positions, i),
    );
    expect(vertices.length).toBeGreaterThan(0);
    expect(vertices.every((v) => v.y === 12)).toBe(true);
    // The gable tapers to half its width halfway up, instead of a full-footprint slab.
    expect(Math.max(...vertices.map((v) => Math.abs(v.x)))).toBeCloseTo(2.25);
    expect(Math.max(...vertices.map((v) => Math.abs(v.z)))).toBeCloseTo(4.5);
    construction.dispose();
  });

  it('freezes on pause and seek, and restores the old building when switching or closing', () => {
    const { construction, matrices } = fixture(),
      original = matrices();
    construction.start('house');
    construction.advance(2);
    construction.pause();
    const paused = construction.status();
    construction.advance(20);
    expect(construction.status()).toEqual(paused);
    construction.seek(0.8);
    construction.advance(20);
    expect(construction.status()?.progress).toBe(0.8);
    construction.start('factory', false);
    expect(construction.status()).toMatchObject({ height: 0, targetHeight: 30 });
    // Switching restores the facade batch of the previous building.
    expect(matrices()[0]).toEqual(original[0]);
    construction.clear();
    expect(matrices()).toEqual(original);
    expect(construction.status()).toBeUndefined();
    construction.dispose();
  });

  it('hoists a load before turning, releases it at the building and returns empty', () => {
    const pickup = craneCycle(0),
      lifted = craneCycle(1.2),
      placed = craneCycle(4.3),
      returned = craneCycle(6.9);
    expect(pickup).toEqual({ turn: 0, lift: 0, loaded: true });
    expect(lifted.lift).toBe(1);
    expect(placed).toMatchObject({ turn: 1, lift: 0, loaded: true });
    expect(craneCycle(4.6).loaded).toBe(false);
    expect(returned.turn).toBe(0);
    expect(returned.loaded).toBe(false);
    expect(craneCycle(7)).toEqual(pickup);
  });

  it('animates the crane with construction and freezes the whole site on pause', () => {
    const { construction } = fixture();
    construction.start('house');
    const jib = construction.group.getObjectByName('crane-jib')!;
    const hook = construction.group.getObjectByName('crane-hook')!;
    const initial = hook.position.clone();
    construction.advance(1.8);
    expect(hook.position.equals(initial)).toBe(false);
    expect(jib.rotation.y).not.toBe(-Math.PI);
    const hookPaused = hook.position.clone(),
      jibPaused = jib.rotation.y;
    construction.pause();
    construction.advance(20);
    expect(hook.position.equals(hookPaused)).toBe(true);
    expect(jib.rotation.y).toBe(jibPaused);
    construction.seek(1);
    expect(construction.group.visible).toBe(false);
    construction.dispose();
  });
});
