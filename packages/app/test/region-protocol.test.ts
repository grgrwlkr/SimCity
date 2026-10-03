import {describe, expect, it, vi} from 'vitest';
import {RegionClient} from '../src/region/client';
import {handleRegionRequest} from '../src/region/protocol';
import {serializeRegion} from '../src/region/model/save';
import type {RegionState} from '../src/region/model/types';
import {flatFixture} from './helpers/regionFixture';
import {ControlledRegionPort} from './helpers/regionPort';

async function initialized() {
  const port = new ControlledRegionPort();
  const states: RegionState[] = [];
  const failures: string[] = [];
  const client = new RegionClient(
    'region-one',
    'fixture',
    state => states.push(state),
    message => failures.push(message),
    port,
  );

  port.deliver();
  await client.ready;
  const load = client.load(serializeRegion(flatFixture()));

  await deliver(port);
  await load;

  return {client, port, states, failures};
}

async function deliver(port: ControlledRegionPort) {
  await vi.waitFor(() => expect(port.replies.length).toBeGreaterThan(0));

  return port.deliver();
}

const found = (name: string, x: number) => ({
  type: 'found' as const,
  name,
  center: {x, z: 0},
});

describe('region protocol', () => {
  it('failed_load_keeps_previous_state', () => {
    const previous = flatFixture();
    const handled = handleRegionRequest(previous, {
      id: 7,
      type: 'load',
      value: {kind: 'simcity-region', version: 99, state: previous},
    });

    expect(handled.state).toBe(previous);
    expect(handled.response).toEqual({
      id: 7,
      error: 'Неподдерживаемая версия сохранения региона',
    });
  });
  it('refuses commands before initialization', () => {
    const handled = handleRegionRequest(null, {id: 1, type: 'save'});

    expect(handled.state).toBeNull();
    expect(handled.response).toHaveProperty('error');
  });
  it('returns current state on stale refusal without consuming an ID', () => {
    const previous = {...flatFixture(), revision: 3};
    const handled = handleRegionRequest(previous, {
      id: 8,
      type: 'apply',
      action: found('Север', 0),
      expectedRevision: 2,
    });

    expect(handled.state).toBe(previous);
    expect(handled.response).toMatchObject({
      id: 8,
      state: previous,
      result: {ok: false, reason: 'stale-revision'},
    });
  });
  it('actions_keep_response_order and save includes both mutations', async () => {
    const {client, port, states} = await initialized();
    const north = client.apply(found('Север', 0));
    const south = client.apply(found('Юг', 500));
    const save = client.save();

    await deliver(port);
    expect((await north).ok).toBe(true);
    await deliver(port);
    expect((await south).ok).toBe(true);
    await deliver(port);
    const saved: unknown = JSON.parse(await save);

    expect(saved).toMatchObject({
      state: {
        revision: 2,
        settlements: [{name: 'Север'}, {name: 'Юг'}],
      },
    });
    expect(client.state?.settlements.map(s => s.name)).toEqual(['Север', 'Юг']);
    expect(states.map(s => s.revision)).toEqual([0, 0, 1, 2, 2]);
    client.dispose();
  });
  it('a rejected load leaves the client usable', async () => {
    const {client, port, failures} = await initialized();
    const previous = client.state;
    const loading = client.load('broken JSON');
    const rejection = expect(loading).rejects.toThrow();

    await deliver(port);
    await rejection;
    expect(client.state).toBe(previous);
    expect(failures).toHaveLength(1);
    const action = client.apply(found('Север', 0));

    await deliver(port);
    expect((await action).ok).toBe(true);
    client.dispose();
  });
  it('does not apply an old duplicate response after a load', async () => {
    const {client, port, states} = await initialized();
    const action = client.apply(found('Север', 0));
    const old = await deliver(port);

    await action;
    const loading = client.load(
      serializeRegion({...flatFixture(), id: 'loaded-region', revision: 5}),
    );

    await deliver(port);
    await loading;
    const count = states.length;

    port.listener?.(old);
    expect(client.state?.id).toBe('loaded-region');
    expect(client.state?.revision).toBe(5);
    expect(states).toHaveLength(count);
    client.dispose();
  });
  it('dispose_rejects_pending_requests including queued work', async () => {
    const {client, port, states} = await initialized();
    const action = client.apply(found('Север', 0));
    const save = client.save();
    const loading = client.load(serializeRegion(flatFixture()));
    const rejected = [
      expect(action).rejects.toThrow('закрыт'),
      expect(save).rejects.toThrow('закрыт'),
      expect(loading).rejects.toThrow('закрыт'),
    ];

    await vi.waitFor(() => expect(port.replies.length).toBe(1));
    const lateListener = port.listener;
    const lateResponse = port.replies[0]!;
    const previous = client.state;
    const count = states.length;

    client.dispose();
    await Promise.all(rejected);
    lateListener?.(lateResponse);
    expect(client.state).toBe(previous);
    expect(states).toHaveLength(count);
    await expect(client.save()).rejects.toThrow('закрыт');
  });
  it('refreshes a stale client from the refusal and uses the confirmed revision next', async () => {
    const {client, port} = await initialized();
    const previous = client.state!;

    port.state = {...previous, revision: 4};
    const stale = client.apply(found('Север', 0));

    await deliver(port);
    expect(await stale).toMatchObject({ok: false, reason: 'stale-revision'});
    expect(client.state?.revision).toBe(4);
    expect(client.state?.cash).toBe(previous.cash);
    expect(client.state?.nextId).toBe(1);
    const retry = client.apply(found('Север', 0));

    await deliver(port);
    expect(await retry).toMatchObject({ok: true});
    expect(client.state?.revision).toBe(5);
    client.dispose();
  });
  it('queues load and mutations before ready without sending an old revision', async () => {
    const port = new ControlledRegionPort();
    const client = new RegionClient(
      'fresh-region',
      'fixture',
      () => {},
      () => {},
      port,
    );
    const loaded = {...flatFixture(), revision: 7};
    const loading = client.load(serializeRegion(loaded));
    const action = client.apply(found('Север', 0));

    expect(client.state).toBeNull();
    port.deliver();
    await client.ready;
    await deliver(port);
    await loading;
    await deliver(port);
    expect(await action).toMatchObject({ok: true, state: {revision: 8}});
    expect(client.state?.id).toBe('test-region');
    client.dispose();
  });
  it('disposal rejects initialization and operations before ready', async () => {
    const port = new ControlledRegionPort();
    const client = new RegionClient(
      'fresh-region',
      'fixture',
      () => {},
      () => {},
      port,
    );
    const saving = client.save();
    const readyRejection = expect(client.ready).rejects.toThrow('закрыт');
    const saveRejection = expect(saving).rejects.toThrow('закрыт');

    client.dispose();
    await Promise.all([readyRejection, saveRejection]);
    expect(client.state).toBeNull();
  });
  it('transport failure rejects both active and queued commands', async () => {
    const {client, port, failures} = await initialized();
    const action = client.apply(found('Север', 0));
    const save = client.save();
    const rejected = [
      expect(action).rejects.toThrow('transport failed'),
      expect(save).rejects.toThrow('transport failed'),
    ];

    await vi.waitFor(() => expect(port.replies.length).toBe(1));
    port.errorListener?.('transport failed');
    await Promise.all(rejected);
    expect(failures).toEqual(['transport failed']);
    client.dispose();
  });
});
