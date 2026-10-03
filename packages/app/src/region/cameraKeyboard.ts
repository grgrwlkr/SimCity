interface CameraPose {
  position: {x: number; y: number; z: number};
  target: {x: number; y: number; z: number};
  zoom: number;
}

const CAMERA_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);
const PAN_SPEED = 1200;
const ROTATION_SPEED = 0.9;
const MAX_FRAME_SECONDS = 0.05;

export class CameraKeyboard {
  private readonly held = new Set<string>();

  get active(): boolean {
    return this.held.size > 0;
  }

  press(code: string, blocked = false): boolean {
    if (blocked) {
      this.clear();

      return false;
    }
    if (!CAMERA_CODES.has(code)) {
      return false;
    }

    this.held.add(code);

    return true;
  }

  release(code: string): void {
    this.held.delete(code);
  }

  clear(): void {
    this.held.clear();
  }

  axis(positive: string, negative: string): number {
    return Number(this.held.has(positive)) - Number(this.held.has(negative));
  }
}

export function stepCameraKeyboard(
  camera: CameraPose,
  keys: CameraKeyboard,
  seconds: number,
): void {
  if (!keys.active) {
    return;
  }

  const dt = Math.max(0, Math.min(MAX_FRAME_SECONDS, seconds));
  const yaw = keys.axis('KeyQ', 'KeyE') * ROTATION_SPEED * dt;
  const right = keys.axis('KeyD', 'KeyA');
  const forward = keys.axis('KeyW', 'KeyS');
  const offsetX = camera.position.x - camera.target.x;
  const offsetZ = camera.position.z - camera.target.z;
  const radius = Math.hypot(offsetX, offsetZ);
  const length = Math.hypot(right, forward);

  if (length > 0 && radius > 0) {
    // Integrate the changing heading so simultaneous pan/orbit is frame-rate independent.
    const midX = offsetX * Math.cos(yaw / 2) + offsetZ * Math.sin(yaw / 2);
    const midZ = offsetZ * Math.cos(yaw / 2) - offsetX * Math.sin(yaw / 2);
    const arcScale = yaw === 0 ? 1 : Math.sin(yaw / 2) / (yaw / 2);
    const scale = (PAN_SPEED * dt * arcScale) / (camera.zoom * radius * length);
    const dx = (right * midZ - forward * midX) * scale;
    const dz = (-right * midX - forward * midZ) * scale;

    camera.target.x += dx;
    camera.target.z += dz;
  }

  camera.position.x =
    camera.target.x + offsetX * Math.cos(yaw) + offsetZ * Math.sin(yaw);
  camera.position.z =
    camera.target.z + offsetZ * Math.cos(yaw) - offsetX * Math.sin(yaw);
}
