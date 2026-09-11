// Worker ↔ main thread messages. Requests carry an id so `window.__sim` can await each reply.
import type { AppState, City } from '@simcity/sim';
import type { SimSpeed } from './driver';

export interface WorldSnapshot {
  readonly tick: number;
  readonly appState: AppState;
  readonly speed: SimSpeed;
  /** `u64` as a decimal string: structured clone keeps bigint, JSON and Playwright do not. */
  readonly mapSeed: string;
  readonly city: City;
}

export interface FingerprintReply {
  readonly tick: number;
  /** 16 hex digits. */
  readonly fingerprint: string;
}

export type Request =
  /** `GameCommand` in its serde-JSON form, validated in the worker. */
  | { readonly t: 'cmd'; readonly cmd: unknown }
  /** Manual stepping, one fixed tick per frame, regardless of speed (as the headless harness does). */
  | { readonly t: 'step'; readonly ticks: number }
  | { readonly t: 'snapshot' }
  | { readonly t: 'fingerprint' }
  | { readonly t: 'setState'; readonly state: AppState }
  | { readonly t: 'setSpeed'; readonly speed: SimSpeed }
  | { readonly t: 'rngProbe'; readonly seed: string; readonly draws: number };

export interface ReplyByRequest {
  readonly cmd: null;
  readonly step: FingerprintReply;
  readonly snapshot: WorldSnapshot;
  readonly fingerprint: FingerprintReply;
  readonly setState: null;
  readonly setSpeed: null;
  readonly rngProbe: string;
}

export type Reply = ReplyByRequest[keyof ReplyByRequest];

export interface ToWorker {
  readonly id: number;
  readonly req: Request;
}

export type FromWorker =
  | { readonly t: 'ready'; readonly render: SharedArrayBuffer }
  | { readonly t: 'frame'; readonly snapshot: WorldSnapshot }
  | { readonly t: 'reply'; readonly id: number; readonly value: Reply }
  | { readonly t: 'error'; readonly id: number; readonly message: string };
