export interface NativePoint {
  readonly x: number;
  readonly z: number;
  readonly y?: number;
}

export interface NativeInfrastructurePlacement {
  readonly id: string;
  readonly center: NativePoint;
  readonly yaw: number;
  readonly source?: NativePoint;
}

export interface NativePlacementTransform {
  readonly yaw: number;
  toWorld<T extends NativePoint>(point: T): T;
  toLocal<T extends NativePoint>(point: T): T;
  vector<T extends {dx: number; dz: number}>(direction: T): T;
  localVector<T extends {dx: number; dz: number}>(direction: T): T;
}

/** A scalar Y-up rigid transform usable by the pure worker and native renderer. */
export function nativePlacementTransform(
  placement: NativeInfrastructurePlacement,
  source: NativePoint,
): NativePlacementTransform {
  const pivot = placement.source ?? source;
  const center = placement.center;
  const c = Math.cos(placement.yaw);
  const s = Math.sin(placement.yaw);

  return {
    yaw: placement.yaw,
    toWorld(point) {
      const x = point.x - pivot.x;
      const z = point.z - pivot.z;

      return {
        ...point,
        x: center.x + c * x + s * z,
        z: center.z - s * x + c * z,
      };
    },
    toLocal(point) {
      const x = point.x - center.x;
      const z = point.z - center.z;

      return {...point, x: pivot.x + c * x - s * z, z: pivot.z + s * x + c * z};
    },
    vector(direction) {
      return {
        ...direction,
        dx: c * direction.dx + s * direction.dz,
        dz: -s * direction.dx + c * direction.dz,
      };
    },
    localVector(direction) {
      return {
        ...direction,
        dx: c * direction.dx - s * direction.dz,
        dz: s * direction.dx + c * direction.dz,
      };
    },
  };
}
