// Port of crates/simcity_sim/src/game/transport/path_pool.rs: routes shared between vehicles,
// deduplicated by content and version, refcounted, slots reused LIFO. Handles are dense indices;
// a released slot keeps its old path until it is reused, as in Rust.
import type { TilePos } from '../commands';

export const PATH_INVALID = -1;

interface PathEntry {
  path: readonly TilePos[];
  key: string;
  refcount: number;
  version: number;
}

const pathKey = (path: readonly TilePos[], version: number) => `${version}|${path.map((p) => `${p.x},${p.y}`).join(';')}`;

export class PathPool {
  private readonly entries: PathEntry[] = [];
  private readonly freeSlots: number[] = [];
  private readonly dedup = new Map<string, number[]>();
  private currentVersion = 0;

  bumpVersion(): void {
    this.currentVersion += 1;
  }

  get(handle: number): readonly TilePos[] | undefined {
    return handle < 0 ? undefined : this.entries[handle]?.path;
  }

  len(handle: number): number {
    return this.get(handle)?.length ?? 0;
  }

  getTile(handle: number, index: number): TilePos | undefined {
    return this.get(handle)?.[index];
  }

  /** The route from `cursor` on; `undefined` past the end (an empty slice exactly at the end). */
  remainingFrom(handle: number, cursor: number): readonly TilePos[] | undefined {
    const path = this.get(handle);
    if (path === undefined || cursor > path.length) return undefined;
    return path.slice(cursor);
  }

  /** The handle of an identical live path at the current version, or a new entry. Empty paths are invalid. */
  intern(path: readonly TilePos[]): number {
    if (path.length === 0) return PATH_INVALID;
    const key = pathKey(path, this.currentVersion);
    for (const existing of this.dedup.get(key) ?? []) {
      const entry = this.entries[existing];
      if (entry !== undefined && entry.refcount > 0 && entry.version === this.currentVersion) {
        entry.refcount += 1;
        return existing;
      }
    }
    const entry: PathEntry = { path: [...path], key, refcount: 1, version: this.currentVersion };
    const free = this.freeSlots.pop();
    let handle: number;
    if (free !== undefined) {
      this.entries[free] = entry;
      handle = free;
    } else {
      handle = this.entries.length;
      this.entries.push(entry);
    }
    const handles = this.dedup.get(key);
    if (handles === undefined) this.dedup.set(key, [handle]);
    else handles.push(handle);
    return handle;
  }

  retain(handle: number): void {
    const entry = handle < 0 ? undefined : this.entries[handle];
    if (entry !== undefined) entry.refcount += 1;
  }

  /** Drops one reference; the slot becomes free when none remain. */
  release(handle: number): void {
    const entry = handle < 0 ? undefined : this.entries[handle];
    if (entry === undefined) return;
    const willFree = entry.refcount === 1;
    entry.refcount = Math.max(entry.refcount - 1, 0);
    if (entry.refcount !== 0) return;
    this.freeSlots.push(handle);
    if (!willFree) return;
    const handles = this.dedup.get(entry.key);
    if (handles === undefined) return;
    const kept = handles.filter((h) => h !== handle);
    if (kept.length === 0) this.dedup.delete(entry.key);
    else this.dedup.set(entry.key, kept);
  }

  /** Everything that decides future handles and routes, for the fingerprint. */
  fingerprintState(): unknown {
    return {
      version: this.currentVersion,
      free: this.freeSlots,
      entries: this.entries.map((e) => [e.refcount, e.version, e.key]),
    };
  }
}
