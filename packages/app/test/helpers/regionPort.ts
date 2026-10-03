import {handleRegionRequest} from '../../src/region/protocol';
import type {RegionRequest, RegionResponse} from '../../src/region/protocol';
import type {RegionPort} from '../../src/region/client';
import type {RegionState} from '../../src/region/model/types';

/** Delays transport delivery while running the real model request handler. */
export class ControlledRegionPort implements RegionPort {
  state: RegionState | null = null;
  readonly requests: RegionRequest[] = [];
  readonly replies: RegionResponse[] = [];
  listener: ((response: RegionResponse) => void) | null = null;
  errorListener: ((message: string) => void) | null = null;

  post(request: RegionRequest): void {
    this.requests.push(request);
    const handled = handleRegionRequest(this.state, request);

    this.state = handled.state;
    this.replies.push(handled.response);
  }

  subscribe(
    response: (value: RegionResponse) => void,
    error: (message: string) => void,
  ): () => void {
    this.listener = response;
    this.errorListener = error;

    return () => {
      this.listener = null;
      this.errorListener = null;
    };
  }

  terminate(): void {}

  deliver(): RegionResponse {
    const reply = this.replies.shift();

    if (!reply) {
      throw new Error('No buffered reply');
    }

    this.listener?.(reply);

    return reply;
  }
}
