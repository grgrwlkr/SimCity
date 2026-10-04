import {handleRegionRequest} from './protocol';
import type {RegionRequest} from './protocol';
import type {RegionState} from '../../../packages/app/src/region/model/types';

let state: RegionState | null = null;

self.onmessage = (event: MessageEvent<RegionRequest>) => {
  const handled = handleRegionRequest(state, event.data);

  state = handled.state;
  self.postMessage(handled.response);
};
