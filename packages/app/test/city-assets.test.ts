import { describe, expect, it } from 'vitest';
import { generateCity } from '../src/city/generator';
import { personKit, propKit, treeKit, vehicleKit } from '../src/city/assetKits';
import { personParts, propParts, treeParts, vehicleParts } from '../src/city/assetParts';
import * as THREE from 'three';
import { geometries, type Batch } from '../src/city/primitives';
import { lowriseModules, roofModules } from '../src/city/buildingModules';

describe('modular city assets', () => {
  it('reserves separate roof slots for solar panels and equipment on a small tower cap', () => {
    const building = generateCity('kit-test').buildings.find((b) => b.district === 'downtown')!;
    for (const rooftop of ['antenna', 'vents', 'skylight'] as const) {
      const parts: Array<Parameters<Batch['add']>> = [];
      roofModules({ add: (...p) => { parts.push(p); } }, { ...building, kit: { ...building.kit, roof: 'solar', rooftop, equipmentCount: 3 } }, 5.5, 4.6, 0);
      const boxes = parts.filter(([shape, color]) => shape === 'box' && color === 'steel').map(([, , x, y, z, w, h, d, ry = 0, rx = 0, rz = 0]) => {
        const transform = new THREE.Object3D();
        transform.position.set(x, y, z); transform.scale.set(w, h, d); transform.rotation.set(rx, ry, rz); transform.updateMatrix();
        return { panel: h < 0.2, bounds: new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)).applyMatrix4(transform.matrix) };
      });
      expect(boxes.filter((b) => b.panel)).toHaveLength(4);
      for (const panel of boxes.filter((b) => b.panel)) for (const gear of boxes.filter((b) => !b.panel)) {
        expect(panel.bounds.max.x < gear.bounds.min.x || panel.bounds.min.x > gear.bounds.max.x || panel.bounds.max.z < gear.bounds.min.z || panel.bounds.min.z > gear.bounds.max.z).toBe(true);
      }
    }
  });
  it('keeps three dormer roof modules separate on a narrow house', () => {
    const building = generateCity('kit-test').buildings.find((b) => b.district === 'residential')!;
    const parts: Array<Parameters<Batch['add']>> = [];
    lowriseModules({ add: (...part) => { parts.push(part); } }, { ...building, width: 5.7, kit: { ...building.kit, roof: 'gable', rooftop: 'dormers', equipmentCount: 3 } });
    const roofs = parts.filter(([shape, , , , , width]) => shape === 'roof' && width < 2).sort((a, b) => a[2] - b[2]);
    expect(roofs).toHaveLength(3);
    for (let i = 1; i < roofs.length; i++) expect(roofs[i]![2] - roofs[i - 1]![2]).toBeGreaterThanOrEqual((roofs[i]![5] + roofs[i - 1]![5]) / 2);
  });

  it('changes actual facade and roof geometry while retaining the building footprint', () => {
    const building = generateCity('kit-test').buildings[0]!;
    const original: Array<Parameters<Batch['add']>> = [], changed: Array<Parameters<Batch['add']>> = [];
    lowriseModules({ add: (...p) => { original.push(p); } }, { ...building, kit: { ...building.kit, roof: 'gable', rooftop: 'chimney', facade: 'classic' } });
    lowriseModules({ add: (...p) => { changed.push(p); } }, { ...building, kit: { ...building.kit, roof: 'solar', rooftop: 'vents', facade: 'ribbon' } });
    expect(original).not.toEqual(changed);
    for (const parts of [original, changed]) for (const [, , x, y, z, w, h, d] of parts) {
      expect([x, y, z, w, h, d].every(Number.isFinite)).toBe(true);
      expect([w, h, d].every((size) => size > 0)).toBe(true);
      expect(Math.abs(x - building.x) + w / 2).toBeLessThanOrEqual(building.width / 2 + 0.6);
      expect(Math.abs(z - building.z) + d / 2).toBeLessThanOrEqual(building.depth / 2 + 1.4);
    }
  });

  it('composes varied trees and street furniture from valid visible parts', () => {
    for (const family of ['bench', 'lamp', 'fountain', 'container', 'crane', 'boat', 'tree'] as const) {
      const unique = new Set<string>();
      for (let id = 0; id < 60; id++) {
        const parts = family === 'tree' ? treeParts(treeKit('props', id)) : propParts(family, propKit('props', family, id));
        expect(parts.length).toBeGreaterThan(2);
        expect(parts.every((p) => [p.x, p.y, p.z, p.w, p.h, p.d].every(Number.isFinite) && p.w > 0 && p.h > 0 && p.d > 0)).toBe(true);
        unique.add(JSON.stringify(parts));
      }
      expect(unique.size, family).toBeGreaterThan(5);
    }
  });
  it('builds varied vehicle assemblies without exceeding the lane-safe footprint', () => {
    const signatures = new Set<string>();
    for (let id = 0; id < 128; id++) {
      const kit = vehicleKit('traffic', id), parts = vehicleParts(kit);
      expect(parts.filter((p) => p.slot === 'chassis')).toHaveLength(1);
      expect(parts.filter((p) => p.slot === 'wheel')).toHaveLength(4);
      expect(parts.some((p) => p.slot === 'cabin')).toBe(true);
      const transform = new THREE.Object3D();
      for (const part of parts) {
        transform.position.set(part.x, part.y, part.z); transform.scale.set(part.w, part.h, part.d);
        transform.rotation.set(part.rx, part.ry, part.rz); transform.updateMatrix();
        const geometry = geometries[part.shape]; geometry.computeBoundingBox();
        const bounds = geometry.boundingBox!.clone().applyMatrix4(transform.matrix);
        expect(Math.max(Math.abs(bounds.min.x), Math.abs(bounds.max.x))).toBeLessThanOrEqual(kit.width / 2 + 0.001);
        expect(Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z))).toBeLessThanOrEqual(kit.length / 2 + 0.001);
        expect([part.w, part.h, part.d].every((size) => Number.isFinite(size) && size > 0)).toBe(true);
      }
      signatures.add(JSON.stringify(parts));
    }
    expect(signatures.size).toBeGreaterThan(100);
    expect(vehicleParts(vehicleKit('traffic', 7))).toEqual(vehicleParts(vehicleKit('traffic', 7)));
  });

  it('assembles people from body, clothing, hair and accessory parts reproducibly', () => {
    const signatures = new Set<string>();
    for (let id = 0; id < 100; id++) {
      const parts = personParts(personKit('people', id));
      expect(parts.filter((p) => p.slot === 'leg')).toHaveLength(2);
      expect(parts.some((p) => p.slot === 'head')).toBe(true);
      expect(parts.some((p) => p.slot === 'hair')).toBe(true);
      expect(parts.every((p) => [p.w, p.h, p.d].every((size) => Number.isFinite(size) && size > 0))).toBe(true);
      signatures.add(JSON.stringify(parts));
    }
    expect(signatures.size).toBeGreaterThan(90);
    expect(personParts(personKit('people', 0))).toEqual(personParts(personKit('people', 0)));
  });
  it('gives each building a reproducible assembly with independently chosen parts', () => {
    const first = generateCity('689856');
    expect(first.buildings.every((building) => building.kit && Object.keys(building.kit).length >= 6)).toBe(true);
    expect(first).toEqual(generateCity('689856'));
    const homes = first.buildings.filter((building) => building.district === 'residential');
    expect(new Set(homes.map((building) => JSON.stringify(building.kit))).size).toBeGreaterThan(70);
  });

  it('keeps pitched-roof equipment compatible with the roof', () => {
    for (const seed of ['689856', 'harbor', 'kit-test']) {
      for (const building of generateCity(seed).buildings) {
        expect(building.kit).toBeDefined();
        if (building.kit.roof === 'gable' || building.kit.roof === 'hip') {
          expect(['chimney', 'dormers']).toContain(building.kit.rooftop);
        }
      }
    }
  });
});
