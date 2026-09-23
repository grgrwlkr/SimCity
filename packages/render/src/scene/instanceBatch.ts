// One instanced draw whose instances belong to tiles: an edit removes and adds the instances of the tiles it touched
// and leaves the rest of the buffer alone, so a road on the metropolis costs the chunks around it, not the whole map.
import * as THREE from 'three/webgpu';
import { SlotTable } from './slots';

export class InstanceBatch {
  private readonly slots = new SlotTable();
  private mesh: THREE.InstancedMesh;

  constructor(
    private readonly group: THREE.Group,
    private readonly geometry: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    readonly name: string,
    capacity = 64,
  ) {
    this.mesh = this.make(capacity);
  }

  /** Instances on screen once flushed. */
  get count(): number {
    return this.slots.count;
  }

  /** The mesh, for a check of what is actually in the scene graph. */
  get drawn(): THREE.InstancedMesh {
    return this.mesh;
  }

  private make(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.name = this.name;
    mesh.count = 0;
    mesh.visible = false;
    // A batch spans the whole map: culling it as a whole saves nothing and its bounds would need a pass per edit.
    mesh.frustumCulled = false;
    // Created with the mesh, white: a material compiled before the first colour would ignore instance colours.
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    this.group.add(mesh);
    return mesh;
  }

  put(owner: number, matrix: THREE.Matrix4): void {
    const slot = this.slots.add(owner);
    if (slot >= this.mesh.instanceMatrix.count) {
      const grown = this.make(this.mesh.instanceMatrix.count * 2);
      (grown.instanceMatrix.array as Float32Array).set(this.mesh.instanceMatrix.array as Float32Array);
      (grown.instanceColor!.array as Float32Array).set(this.mesh.instanceColor!.array as Float32Array);
      this.group.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = grown;
    }
    this.mesh.setMatrixAt(slot, matrix);
    (this.mesh.instanceColor!.array as Float32Array).fill(1, slot * 3, slot * 3 + 3);
  }

  remove(owner: number): void {
    const m = this.mesh.instanceMatrix.array as Float32Array;
    const c = this.mesh.instanceColor!.array as Float32Array;
    for (const [from, to] of this.slots.remove(owner)) {
      m.copyWithin(to * 16, from * 16, from * 16 + 16);
      c.copyWithin(to * 3, from * 3, from * 3 + 3);
    }
  }

  /**
   * Multiplies every instance by the colour `of` its owner gives (linear rgb), white where it gives `null`; `null` for
   * `of` gives every instance its own colour back. A data map tints the buildings standing on its tiles with this.
   */
  tint(of: ((owner: number) => readonly [number, number, number] | null) | null): void {
    const c = this.mesh.instanceColor!.array as Float32Array;
    for (let slot = 0; slot < this.slots.count; slot++) {
      const rgb = of === null ? null : of(this.slots.ownerOf(slot)!);
      c.set(rgb ?? [1, 1, 1], slot * 3);
    }
    this.mesh.instanceColor!.needsUpdate = true;
  }

  /** The colour the first instance of `owner` is multiplied by; `null` when it has none. */
  tintOf(owner: number): [number, number, number] | null {
    const slot = this.slots.slotsOf(owner)[0];
    if (slot === undefined) return null;
    const c = this.mesh.instanceColor!.array as Float32Array;
    return [c[slot * 3]!, c[slot * 3 + 1]!, c[slot * 3 + 2]!];
  }

  /** Every instance as `owner|matrix`, matrix elements rounded to 1e-3: what the GPU buffer holds, slot by slot. */
  entries(): string[] {
    const m = this.mesh.instanceMatrix.array as Float32Array;
    return Array.from({ length: this.slots.count }, (_, s) => `${this.slots.ownerOf(s)}|${Array.from(m.subarray(s * 16, s * 16 + 16), (v) => Math.round(v * 1000) / 1000).join(',')}`);
  }

  /** Publishes the edits of this pass to the GPU. */
  flush(): void {
    this.mesh.count = this.slots.count;
    this.mesh.visible = this.slots.count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }

  /** Leaves the scene; the geometry and the material are shared and stay. */
  dispose(): void {
    this.group.remove(this.mesh);
    this.mesh.dispose();
  }
}
