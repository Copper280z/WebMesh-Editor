// Exercise the same feature selection used by the UI against real CAD,
// including partial blind ends where a drilled hole breaks through a wall.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { kernelAvailable, startServer, CadSession, F } = require('./helpers/cad-client.cjs');

const available = kernelAvailable();
let server;
before(async () => { if (available) server = await startServer(); });
after(() => server?.stop());
const cad = { skip: available ? false : 'OpenCASCADE is unavailable', timeout: 120000 };

test('balancer hole removal includes crescent floors and preserves surrounding holes and walls', cad, async () => {
  const s = await new CadSession(server.base).import('examples/balancer_chassis.step');
  const before = s.topology, holeCount = s.features('hole').length;
  const holes = s.features('hole').filter(h => h.radius === 1.5 && h.depth > 9 && h.axis[1] === 1);
  assert.equal(holes.length, 2);
  for (const hole of holes) {
    assert.equal(hole.through, false);
    assert.equal(hole.faces.length, 2, 'cylinder plus partial floor, excluding the adjoining large wall');
    const floor = before.faces.find(f => hole.faces.includes(f.id) && f.surface.kind === 'plane');
    assert.ok(floor.area < 1, 'only the crescent is selected');
    const bowed = structuredClone(before), boundary = bowed.edges.find(e => floor.edges.includes(e.id) && e.curve.kind === 'line');
    boundary.curve = { kind: 'circle', center: hole.center, axis: hole.axis, radius: 20 };
    assert.ok(!F.recognize(bowed).byFace.get(hole.faces[0]).faces.includes(floor.id), 'boundary vertices inside the bore do not authorize removing a face that curves outside it');
    // Selecting either the cylinder or its floor offers the complete feature.
    for (const id of hole.faces) {
      const action = F.infer(before, s.recognized, s.analysis, { kind: 'face', ids: [id] }).actions.find(a => a.key === 'remove-feature');
      assert.deepEqual(action.operation.faceIds, hole.faces);
    }
    const preview = await s.api('preview', { ...s.token, operation: { kind: 'defeature', faceIds: hole.faces } });
    assert.ok(Math.abs(preview.topology.volume - before.volume - 63.4599415) < 1e-4);
    assert.equal(preview.topology.faces.length, before.faces.length - 2);
    assert.equal(s.data.revision, 0, 'previews do not commit changes');
  }
  const operation = { kind: 'defeature', faceIds: holes.flatMap(h => h.faces), label: 'Removed two rear blind bores' };
  await s.apply(operation);
  assert.equal(s.topology.volumes.length, 1);
  assert.ok(s.topology.bounds.every((v, i) => Math.abs(v - before.bounds[i]) < 1e-4), 'bounds unchanged within CAD tessellation tolerance');
  assert.ok(Math.abs(s.topology.volume - before.volume - 126.919883) < 1e-4);
  assert.equal(s.topology.faces.length, before.faces.length - 4);
  assert.equal(s.features('hole').length, holeCount - 2, 'all other bores remain');
  for (const face of before.faces.filter(f => f.surface.kind === 'cylinder' && !operation.faceIds.includes(f.id))) {
    assert.ok(s.topology.faces.some(f => f.surface.kind === 'cylinder' && Math.abs(f.area - face.area) < 1e-6 && f.center.every((v, i) => Math.abs(v - face.center[i]) < 1e-6)), 'unselected curved features are unchanged');
  }
  s.accept(await s.api('undo', s.token));
  assert.ok(Math.abs(s.topology.volume - before.volume) < 1e-6);
  assert.equal(s.features('hole').length, holeCount);
  s.accept(await s.api('redo', s.token));
  assert.equal(s.features('hole').length, holeCount - 2);
});
