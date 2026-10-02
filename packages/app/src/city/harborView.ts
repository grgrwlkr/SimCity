import * as THREE from 'three';
import { Batch, geometries, material } from './primitives';
import { propKit } from './assetKits';
import { addParts, MovingAssets, propParts } from './assetParts';
import { BERTHS, CARGO_CAPACITY, CARGO_SCALE, WAREHOUSES } from './harborLayout';
import type { CargoPose, HarborSnapshot } from './harbor';

export function createHarborView(seed: string) {
  const group = new THREE.Group(); group.name = 'working-harbor';
  const clipped: Array<{ copy: THREE.MeshStandardMaterial; source: THREE.MeshStandardMaterial }> = [];
  const boundaries = [new THREE.Plane(new THREE.Vector3(1, 0, 0), 138.4), new THREE.Plane(new THREE.Vector3(-1, 0, 0), 138.4)];
  function clip(root: THREE.Object3D): void {
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return;
      const source = object.material, copy = source.clone();
      copy.clippingPlanes = boundaries; copy.clipShadows = true; object.material = copy;
      clipped.push({ copy, source });
    });
  }
  const ships = ['import', 'export'].map((mode) => {
    const root = new THREE.Group(); root.name = `harbor-ship-${mode}`;
    const batch = new Batch();
    addParts(batch, propParts('boat', propKit(seed, 'boat', mode)).filter((p) => p.slot !== 'cargo'), 0, 0, 0);
    batch.add('sphere', 'headlight', 11.5, 1.75, -2.7, 0.28, 0.28, 0.28);
    batch.add('sphere', 'headlight', 11.5, 1.75, 2.7, 0.28, 0.28, 0.28);
    batch.finish(root); clip(root); group.add(root); return root;
  });
  const cargoRoot = new THREE.Group(); cargoRoot.name = 'harbor-containers'; group.add(cargoRoot);
  const cargo = new MovingAssets(cargoRoot, Array.from({ length: CARGO_CAPACITY }, (_, slot) => propParts('container', propKit(seed, 'container', `logistics-${slot}`))));
  clip(cargoRoot);
  const cargoPoses = Array.from({ length: CARGO_CAPACITY }, () => new THREE.Matrix4());
  const transform = new THREE.Object3D();

  function hoist(index: number) {
    const port = index < 2, warehouse = WAREHOUSES[index - 2];
    const x = port ? BERTHS[index]! : warehouse!.x;
    const z = port ? 143 : warehouse!.z + 2.5;
    const root = new THREE.Group(); root.position.set(x, 0, z); root.name = `${port ? 'port' : 'warehouse'}-crane-${index}`;
    const frame = new Batch();
    const kit = propKit(seed, 'crane', port ? x : `warehouse-${index}`);
    const beam = port ? 18.6 + kit.details * 2 : 10.4;
    if (port) {
      const parts = propParts('crane', kit).filter((p) => !['boom', 'cab', 'cable', 'hook'].includes(p.slot)).map((p) => ({
        ...p, x: p.slot === 'tower' || p.slot === 'brace' ? Math.sign(p.x) * 8.5 : p.x,
        w: p.slot === 'crossbeam' ? 19.5 : p.w, z: p.slot === 'crossbeam' ? 0 : p.z,
      }));
      addParts(frame, parts, 0, 1, 0);
    } else {
      for (const side of [-1, 1]) {
        frame.add('box', 'metal', side * 9, 5.6, 0, 0.4, 9.5, 0.5);
        frame.add('box', 'cream', side * 9, 1, 0, 1, 0.3, 1);
      }
      frame.add('box', kit.color, 0, beam, 0, 19, 0.55, 0.65);
    }
    frame.finish(root);
    const bridge = new THREE.Group(), bridgeParts = new Batch();
    bridgeParts.add('box', kit.color, 0, beam, 1, port ? 0.9 : 0.55, 0.7, port ? 28 : 7);
    bridgeParts.add('box', 'window', 0, beam - 1, 0, port ? 2.3 : 1.4, 1.3, 1.8);
    bridgeParts.finish(bridge); root.add(bridge);
    const trolley = new THREE.Mesh(geometries.box, material('metal'));
    trolley.scale.set(1.2, 0.35, 1.4); root.add(trolley);
    const cable = new THREE.Mesh(geometries.box, material('metal')); root.add(cable);
    const spreader = new THREE.Group(), grab = new Batch();
    grab.add('box', kit.color, 0, 0.12, 0, 2, 0.2, 4.95);
    for (const dx of [-0.97, 0.97]) for (const dz of [-2.35, 2.35]) grab.add('box', 'metal', dx, -0.07, dz, 0.08, 0.42, 0.12);
    grab.finish(spreader); root.add(spreader); group.add(root);
    return (pose: CargoPose) => {
      const px = pose.x - x, pz = pose.z - z;
      bridge.position.x = px; trolley.position.set(px, beam - 0.2, pz);
      const length = Math.max(0.1, beam - pose.y - 0.3);
      cable.position.set(px, pose.y + 0.3 + length / 2, pz); cable.scale.set(0.065, length, 0.065);
      spreader.position.set(px, pose.y, pz); spreader.rotation.y = pose.yaw;
    };
  }
  const hoists = Array.from({ length: 4 }, (_, index) => hoist(index));
  return {
    group,
    update(snapshot: HarborSnapshot, seconds: number) {
      ships.forEach((ship, index) => {
        ship.visible = snapshot.ship.visible && index === (snapshot.ship.mode === 'import' ? 0 : 1);
        ship.position.set(snapshot.ship.x, 0.8, snapshot.ship.z);
      });
      for (const matrix of cargoPoses) matrix.makeTranslation(0, -2000, 0);
      for (const container of snapshot.cargo) {
        const p = container.pose;
        transform.position.set(p.x, p.y, p.z); transform.rotation.set(0, p.yaw, 0);
        transform.scale.set(CARGO_SCALE.x, CARGO_SCALE.y, CARGO_SCALE.z); transform.updateMatrix();
        cargoPoses[container.slot]!.copy(transform.matrix);
      }
      cargo.update(cargoPoses, seconds);
      hoists.forEach((update, i) => update(snapshot.hooks[i]!));
    },
    syncLighting() {
      for (const { copy, source } of clipped) { copy.color.copy(source.color); copy.emissive.copy(source.emissive); copy.emissiveIntensity = source.emissiveIntensity; }
    },
    dispose() { clipped.forEach(({ copy }) => copy.dispose()); },
  };
}
