import * as THREE from 'three';
import {geometries, materials} from '../../city/primitives';

function isBufferGeometry(value: unknown): value is THREE.BufferGeometry {
  return value instanceof THREE.BufferGeometry;
}

function isMaterial(value: unknown): value is THREE.Material {
  return value instanceof THREE.Material;
}

/** Shared city assets outlive individual regional layers. */
export function disposeLayer(group: THREE.Object3D): void {
  const sharedGeometries = new Set(Object.values(geometries));
  const sharedMaterials = new Set<THREE.Material>(materials.values());
  const ownedGeometries = new Set<THREE.BufferGeometry>();
  const ownedMaterials = new Set<THREE.Material>();

  group.traverse(object => {
    if (object instanceof THREE.InstancedMesh) {
      object.dispose();
    }
    if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
      const geometry: unknown = object.geometry;

      if (isBufferGeometry(geometry) && !sharedGeometries.has(geometry)) {
        ownedGeometries.add(geometry);
      }

      const meshMaterial: unknown = object.material;
      const meshMaterials: unknown[] = Array.isArray(meshMaterial)
        ? meshMaterial
        : [meshMaterial];

      for (const mat of meshMaterials) {
        if (isMaterial(mat) && !sharedMaterials.has(mat)) {
          ownedMaterials.add(mat);
        }
      }
    }
  });

  for (const geometry of ownedGeometries) {
    geometry.dispose();
  }

  for (const mat of ownedMaterials) {
    mat.dispose();
  }

  group.clear();
  group.removeFromParent();
}

export class EntityLayer<T extends {readonly id: string}> {
  readonly group = new THREE.Group();
  private readonly entities = new Map<
    string,
    {signature: string; group: THREE.Group}
  >();

  constructor(
    name: string,
    private readonly build: (entity: T) => THREE.Group,
  ) {
    this.group.name = name;
  }

  update(entities: readonly T[]): void {
    const currentIds = new Set(entities.map(entity => entity.id));

    for (const [id, entry] of this.entities) {
      if (!currentIds.has(id)) {
        disposeLayer(entry.group);
        this.entities.delete(id);
      }
    }

    for (const entity of entities) {
      const signature = JSON.stringify(entity);
      const prior = this.entities.get(entity.id);

      if (prior?.signature === signature) {
        continue;
      }
      if (prior) {
        disposeLayer(prior.group);
      }

      const group = this.build(entity);

      group.name = entity.id;
      this.group.add(group);
      this.entities.set(entity.id, {signature, group});
    }
  }
}
