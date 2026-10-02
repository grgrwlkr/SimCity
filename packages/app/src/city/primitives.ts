import * as THREE from 'three';

export type Shape = 'box' | 'leaf' | 'cylinder' | 'roof' | 'sphere' | 'cone' | 'hip';
export const geometries: Record<Shape, THREE.BufferGeometry> = {
  box: new THREE.BoxGeometry(1, 1, 1),
  leaf: new THREE.IcosahedronGeometry(0.5, 1),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
  sphere: new THREE.SphereGeometry(0.5, 12, 8),
  roof: roofGeometry(),
  cone: new THREE.ConeGeometry(0.5, 1, 8),
  hip: new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1, false, Math.PI / 4),
};

function roofGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0, 0.5, 0.5],
      3,
    ),
  );
  geometry.setIndex([0, 2, 1, 3, 4, 5, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 4, 0, 1, 4, 0, 4, 3]);
  const flat = geometry.toNonIndexed();
  flat.computeVertexNormals();
  geometry.dispose();
  return flat;
}

const palette: Record<string, number> = {
  cream: 0xf0e5ca,
  trim: 0xf9efd7,
  sage: 0x91ad8c,
  coral: 0xd77c60,
  yellow: 0xe9be6c,
  teal: 0x528d8a,
  brick: 0xac614b,
  roof: 0x586772,
  dark: 0x344d4d,
  window: 0x426873,
  litWindow: 0x56777a,
  asphalt: 0x566366,
  paving: 0xd0ccba,
  path: 0xe3dbc5,
  grass: 0x96b581,
  grassDark: 0x80a475,
  green: 0x5f9258,
  lime: 0x97b968,
  forest: 0x47765a,
  trunk: 0x8a7357,
  water: 0x62b8b7,
  metal: 0x435754,
  rubber: 0x303b3c,
  white: 0xf7ecd5,
  red: 0xdf715a,
  blue: 0x6f9eac,
  gold: 0xe7b554,
  headlight: 0xfff3c6,
};

export const materials = new Map<string, THREE.MeshStandardMaterial>();
for (const [name, color] of Object.entries(palette)) {
  materials.set(
    name,
    new THREE.MeshStandardMaterial({
      color,
      roughness: name === 'water' ? 0.26 : 0.82,
      metalness: name === 'metal' ? 0.2 : 0,
    }),
  );
}
export function material(name: string): THREE.MeshStandardMaterial {
  const found = materials.get(name);
  if (!found) {
    throw new Error(`Unknown city material: ${name}`);
  }
  return found;
}

/** Repeated facade details share a draw call per shape and material. */
export interface BatchPart {
  shape: Shape;
  color: string;
  matrix: THREE.Matrix4;
}
export interface BatchObject {
  parts: BatchPart[];
  setVisible: (visible: boolean) => void;
}

export class Batch {
  private readonly groups = new Map<
    string,
    { shape: Shape; color: string; matrices: THREE.Matrix4[]; mesh?: THREE.InstancedMesh }
  >();
  private readonly transform = new THREE.Object3D();

  add(
    shape: Shape,
    color: string,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    ry = 0,
    rx = 0,
    rz = 0,
  ): void {
    const key = `${shape}:${color}`;
    let group = this.groups.get(key);
    if (!group) {
      group = { shape, color, matrices: [] };
      this.groups.set(key, group);
    }
    this.transform.position.set(x, y, z);
    this.transform.scale.set(w, h, d);
    this.transform.rotation.set(rx, ry, rz);
    this.transform.updateMatrix();
    group.matrices.push(this.transform.matrix.clone());
  }

  /** Keep ownership while preserving the original shared batches and draw order. */
  capture(draw: (batch: Batch) => void): BatchObject {
    const starts = new Map([...this.groups].map(([key, group]) => [key, group.matrices.length]));
    draw(this);
    const entries = [...this.groups].flatMap(([key, group]) =>
      group.matrices.slice(starts.get(key) ?? 0).map((matrix, offset) => ({
        group,
        matrix,
        index: (starts.get(key) ?? 0) + offset,
      })),
    );
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    return {
      parts: entries.map(({ group, matrix }) => ({ shape: group.shape, color: group.color, matrix })),
      setVisible(visible) {
        for (const { group, matrix, index } of entries) {
          if (group.mesh) {
            group.mesh.setMatrixAt(index, visible ? matrix : hidden);
            group.mesh.instanceMatrix.needsUpdate = true;
          }
        }
      },
    };
  }

  finish(parent: THREE.Object3D): void {
    for (const group of this.groups.values()) {
      const { shape, color, matrices } = group;
      const mesh = new THREE.InstancedMesh(geometries[shape], material(color), matrices.length);
      group.mesh = mesh;
      matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
      mesh.castShadow = !['window', 'litWindow', 'headlight', 'water'].includes(color);
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      parent.add(mesh);
    }
  }
}

export function roadLoop(halfWidth: number, halfDepth: number, radius: number): THREE.CurvePath<THREE.Vector3> {
  const curve = new THREE.CurvePath<THREE.Vector3>();
  const v = (x: number, z: number) => new THREE.Vector3(x, 0.91, z);
  const x = halfWidth,
    z = halfDepth,
    r = radius,
    k = 0.5522847498;
  const line = (a: THREE.Vector3, b: THREE.Vector3) => curve.add(new THREE.LineCurve3(a, b));
  const arc = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) =>
    curve.add(new THREE.CubicBezierCurve3(a, b, c, d));
  line(v(-x + r, -z), v(x - r, -z));
  arc(v(x - r, -z), v(x - r + r * k, -z), v(x, -z + r - r * k), v(x, -z + r));
  line(v(x, -z + r), v(x, z - r));
  arc(v(x, z - r), v(x, z - r + r * k), v(x - r + r * k, z), v(x - r, z));
  line(v(x - r, z), v(-x + r, z));
  arc(v(-x + r, z), v(-x + r - r * k, z), v(-x, z - r + r * k), v(-x, z - r));
  line(v(-x, z - r), v(-x, -z + r));
  arc(v(-x, -z + r), v(-x, -z + r - r * k), v(-x + r - r * k, -z), v(-x + r, -z));
  return curve;
}
