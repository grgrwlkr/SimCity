// Buildings under a data map (review F4): a built-up city covers most zoned tiles with rooftops, so a data map tints each
// building instance with its tile's map colour and gives the plain colour back when the map closes. The tint rides the
// instance through the edits that move instances between slots.
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { InstanceBatch } from '../../src/scene/instanceBatch';

const at = new THREE.Matrix4();

describe('instance tint', () => {
  it('aDataMapTintsEachInstanceByItsOwnerAndTheTintFollowsItThroughEdits', () => {
    const batch = new InstanceBatch(new THREE.Group(), new THREE.BoxGeometry(), new THREE.MeshBasicNodeMaterial(), 'buildings', 2);
    for (const owner of [5, 7, 9]) batch.put(owner, at); // the third grows the buffer
    batch.tint((owner) => (owner === 7 ? [1, 0, 0] : owner === 9 ? [0, 0.5, 0] : null));
    batch.flush();
    expect([5, 7, 9].map((o) => batch.tintOf(o))).toEqual([[1, 1, 1], [1, 0, 0], [0, 0.5, 0]]);
    expect(batch.drawn.instanceColor, 'the instances carry a colour attribute').not.toBeNull();

    // An edit moves the last instance into the freed slot: its tint moves with it, and a new instance starts plain.
    batch.remove(5);
    batch.put(11, at);
    batch.flush();
    expect([7, 9, 11].map((o) => batch.tintOf(o))).toEqual([[1, 0, 0], [0, 0.5, 0], [1, 1, 1]]);
    expect(batch.tintOf(5), 'gone').toBeNull();

    // The map closes: every instance plain again.
    batch.tint(null);
    expect([7, 9, 11].map((o) => batch.tintOf(o))).toEqual([[1, 1, 1], [1, 1, 1], [1, 1, 1]]);
  });

  it('underADataMapTheBodiesDrawWhiteSoTheTintIsTheMapsColourNotAShadeOfTheRoof', () => {
    // A blue roof times a yellow map is black: the body swaps to a white material while the map is open.
    const own = new THREE.MeshBasicNodeMaterial();
    const white = new THREE.MeshBasicNodeMaterial();
    const batch = new InstanceBatch(new THREE.Group(), new THREE.BoxGeometry(), own, 'buildings', 1);
    batch.put(3, at);
    batch.useMaterial(white);
    batch.put(4, at); // grows the buffer: the new mesh keeps the swap
    expect(batch.drawn.material).toBe(white);
    batch.useMaterial(null);
    expect(batch.drawn.material, 'its own material back').toBe(own);
  });
});
