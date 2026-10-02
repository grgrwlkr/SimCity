import * as THREE from 'three';
import { geometries, material, type BatchObject, type BatchPart } from './primitives';
import { createConstructionSite, type ConstructionPlot } from './constructionSite';

export interface ConstructionStatus {
  id: string;
  progress: number;
  height: number;
  targetHeight: number;
  viewHeight: number;
  running: boolean;
}

interface SectionPart {
  vertices: THREE.Vector3[];
  edges: [number, number][];
  bottom: number;
  top: number;
}

function sectionPart(part: BatchPart): SectionPart {
  const geometry = geometries[part.shape],
    positions = geometry.getAttribute('position');
  const vertices = Array.from({ length: positions.count }, (_, i) =>
    new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(part.matrix),
  );
  const edges: [number, number][] = [],
    indices = geometry.index;
  for (let i = 0; i < (indices?.count ?? positions.count); i += 3) {
    const a = indices?.getX(i) ?? i,
      b = indices?.getX(i + 1) ?? i + 1,
      c = indices?.getX(i + 2) ?? i + 2;
    edges.push([a, b], [b, c], [c, a]);
  }
  return { vertices, edges, bottom: Math.min(...vertices.map((v) => v.y)), top: Math.max(...vertices.map((v) => v.y)) };
}

/** Every prototype primitive is convex; the cut closes its actual cross-section. */
function contour(part: SectionPart, height: number): THREE.Vector2[] {
  if (height <= part.bottom || height >= part.top) {
    return [];
  }
  const points: THREE.Vector2[] = [];
  for (const [a, b] of part.edges) {
    const p = part.vertices[a]!,
      q = part.vertices[b]!;
    if (p.y < height === q.y < height) {
      continue;
    }
    const t = (height - p.y) / (q.y - p.y);
    points.push(new THREE.Vector2(p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t));
  }
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (list: THREE.Vector2[]) => {
    const hull: THREE.Vector2[] = [];
    for (const p of list) {
      while (hull.length >= 2 && cross(hull[hull.length - 2]!, hull[hull.length - 1]!, p) <= 1e-8) {
        hull.pop();
      }
      hull.push(p);
    }
    hull.pop();
    return hull;
  };
  return [...half(points), ...half([...points].reverse())];
}

/** Only the building being constructed needs a clipped copy; the city stays batched. */
export class Construction {
  readonly group = new THREE.Group();
  readonly plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  private active:
    { id: string; object: BatchObject; sections: SectionPart[]; top: number; originalVisible: boolean } | undefined;
  private progress = 1;
  private running = false;
  private site: ReturnType<typeof createConstructionSite> | undefined;
  private readonly copies = new Map<string, THREE.MeshStandardMaterial>();
  private readonly capGeometry = new THREE.BufferGeometry();
  private readonly capMaterial = new THREE.MeshStandardMaterial({
    color: 0xd0ccba,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  private readonly cap = new THREE.Mesh(this.capGeometry, this.capMaterial);

  constructor(
    private readonly objects: Map<string, BatchObject>,
    private readonly plots = new Map<string, ConstructionPlot>(),
    private readonly clearance: (id: string, x: number, z: number, radius: number) => number = () => 0,
  ) {
    this.group.name = 'building-construction';
    this.cap.name = 'construction-surface';
    this.cap.receiveShadow = true;
    this.cap.frustumCulled = false;
  }

  start(id: string, running = true): void {
    const object = this.objects.get(id);
    if (!object) {
      return;
    }
    this.clear();
    const sections = object.parts.map(sectionPart);
    this.active = { id, object, sections, top: Math.max(...sections.map((part) => part.top)), originalVisible: true };
    const bounds = new THREE.Box3().setFromPoints(sections.flatMap((part) => part.vertices));
    const center = bounds.getCenter(new THREE.Vector3()),
      size = bounds.getSize(new THREE.Vector3());
    const plot = this.plots.get(id) ?? {
      x: center.x,
      z: center.z,
      width: size.x,
      depth: size.z,
      minX: bounds.min.x - 1,
      maxX: bounds.max.x + 1,
      minZ: bounds.min.z - 1,
      maxZ: bounds.max.z + 1,
    };
    this.site = createConstructionSite(plot, this.active.top, (x, z, radius) => this.clearance(id, x, z, radius));
    this.group.add(this.site.group);
    const groups = new Map<string, BatchPart[]>();
    for (const part of object.parts) {
      const key = `${part.shape}:${part.color}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(part);
    }
    for (const parts of groups.values()) {
      const first = parts[0]!;
      let copy = this.copies.get(first.color);
      if (!copy) {
        copy = material(first.color).clone();
        copy.clippingPlanes = [this.plane];
        copy.clipShadows = true;
        this.copies.set(first.color, copy);
      }
      const mesh = new THREE.InstancedMesh(geometries[first.shape], copy, parts.length);
      parts.forEach((part, i) => mesh.setMatrixAt(i, part.matrix));
      mesh.castShadow = !['window', 'litWindow', 'headlight', 'water'].includes(first.color);
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }
    // Reuse a fixed buffer while the work surface moves up through the original geometry.
    const capacity = sections.reduce((sum, part) => sum + part.edges.length * 9, 0);
    this.capGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(capacity), 3).setUsage(THREE.DynamicDrawUsage),
    );
    const normals = new Float32Array(capacity);
    for (let i = 1; i < normals.length; i += 3) {
      normals[i] = 1;
    }
    this.capGeometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    this.group.add(this.cap);
    this.seek(0);
    this.running = running;
  }

  seek(progress: number): void {
    if (!this.active) {
      return;
    }
    this.progress = THREE.MathUtils.clamp(progress, 0, 1);
    this.running = false;
    const originalVisible = this.progress === 1;
    if (originalVisible !== this.active.originalVisible) {
      this.active.object.setVisible(originalVisible);
      this.active.originalVisible = originalVisible;
    }
    this.group.visible = this.progress < 1;
    this.plane.constant = this.active.top * this.progress;
    this.site?.update(this.plane.constant, this.progress * this.duration());
    const positions = this.capGeometry.getAttribute('position') as THREE.BufferAttribute;
    let count = 0;
    for (const part of this.active.sections) {
      const points = contour(part, this.plane.constant);
      for (let i = 1; i < points.length - 1; i++) {
        for (const p of [points[0]!, points[i + 1]!, points[i]!]) {
          positions.setXYZ(count++, p.x, this.plane.constant, p.y);
        }
      }
    }
    this.capGeometry.setDrawRange(0, count);
    positions.clearUpdateRanges();
    if (count) {
      positions.addUpdateRange(0, count * 3);
      positions.needsUpdate = true;
    }
  }

  play(): void {
    if (this.active && this.progress < 1) {
      this.running = true;
    }
  }
  pause(): void {
    this.running = false;
  }
  private duration(): number {
    return THREE.MathUtils.clamp((this.active?.top ?? 0) / 6, 10, 24);
  }
  advance(seconds: number): void {
    if (!this.active || !this.running) {
      return;
    }
    this.seek(this.progress + Math.max(0, seconds) / this.duration());
    this.running = this.progress < 1;
  }
  status(): ConstructionStatus | undefined {
    return this.active
      ? {
          id: this.active.id,
          progress: this.progress,
          height: this.plane.constant,
          targetHeight: this.active.top,
          viewHeight: this.site?.viewHeight ?? this.active.top,
          running: this.running,
        }
      : undefined;
  }
  syncLighting(): void {
    for (const [name, copy] of this.copies) {
      const source = material(name);
      copy.color.copy(source.color);
      copy.emissive.copy(source.emissive);
      copy.emissiveIntensity = source.emissiveIntensity;
    }
  }
  clear(): void {
    this.active?.object.setVisible(true);
    this.active = undefined;
    this.running = false;
    this.group.traverse((child) => {
      if (child instanceof THREE.InstancedMesh) {
        child.dispose();
      }
    });
    this.group.clear();
    this.group.visible = false;
    this.site = undefined;
    for (const copy of this.copies.values()) {
      copy.dispose();
    }
    this.copies.clear();
    this.capGeometry.dispose();
  }
  dispose(): void {
    this.clear();
    this.capMaterial.dispose();
  }
}
