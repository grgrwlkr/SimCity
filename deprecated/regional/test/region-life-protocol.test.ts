import {describe, expect, it, vi} from 'vitest';
import {RegionClient} from '../src/client';
import {handleRegionRequest} from '../src/protocol';
import {
  parseRegion,
  serializeRegion,
} from '../../../packages/app/src/region/model/save';
import {flatFixture} from '../../../packages/app/test/helpers/regionFixture';
import {ControlledRegionPort} from './helpers/regionPort';

describe('regional life protocol', () => {
  it('rejects invalid advances without replacing state', () => {
    const state = flatFixture();
    const result = handleRegionRequest(state, {
      id: 1,
      type: 'advance',
      seconds: -1,
    });

    expect(result.state).toBe(state);
    expect(result.response).toHaveProperty('error');
  });
  it('serializes advance, save and load using confirmed worker state', async () => {
    const port = new ControlledRegionPort();
    const client = new RegionClient(
      'test',
      'fixture',
      () => {},
      () => {},
      port,
    );

    port.deliver();
    await client.ready;
    const advance = client.advance(120);
    const save = client.save();
    const load = client.load(serializeRegion(flatFixture()));

    await vi.waitFor(() => expect(port.replies.length).toBe(1));
    expect(port.requests.at(-1)?.type).toBe('advance');
    port.deliver();
    await advance;
    await vi.waitFor(() => expect(port.replies.length).toBe(1));
    port.deliver();
    expect(parseRegion(await save).life.elapsedSeconds).toBe(120);
    await vi.waitFor(() => expect(port.replies.length).toBe(1));
    port.deliver();
    await load;
    expect(client.state?.life.elapsedSeconds).toBe(0);
    client.dispose();
  });
});
