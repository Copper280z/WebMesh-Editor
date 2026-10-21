// End-to-end mapped hex workflows against the real CAD service (skipped when
// the Gmsh/OpenCASCADE kernel is not installed). The same planner and mesher
// run in the browser.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { kernelAvailable, startServer, CadSession, F } = require('./helpers/cad-client.cjs');

const available = kernelAvailable();
let server;
before(async () => { if (available) server = await startServer(); });
after(() => server?.stop());
const cad = { skip: available ? false : 'Gmsh/OpenCASCADE kernel is not installed', timeout: 600000 };

function assertMesh(session, size, minimumQuality) {
  for (const order of [1, 2]) {
    const { mesh, report, intervals } = session.mesh(size, order);
    assert.equal(intervals.conflicts.length, 0);
    assert.equal(report.valid, true, report.errors.join('\n'));
    assert.equal(report.stats.nonManifoldFaces, 0);
    assert.equal(mesh.quality.inverted, 0);
    assert.ok(mesh.quality.minScaledJacobian >= minimumQuality, `order ${order}: minimum scaled Jacobian ${mesh.quality.minScaledJacobian}`);
    assert.equal(mesh.elements[0].nodes.length, order === 2 ? 20 : 8);
  }
}

test('L-bracket keeps its bore: fillet removed, web sliced, bore boxed and split into sectors', cad, async () => {
  const session = await new CadSession(server.base).import('examples/l-bracket.step');
  assert.equal(session.features('hole').length, 1);
  const result = await session.autoFix({ blends: true, holes: true, size: 4 });
  assert.deepEqual(result.end, { volumes: 7, mappable: 7, blocked: 0 });
  assert.equal(session.features('hole').length, 1, 'the bore is still there');
  assertMesh(session, 4, 0.65);
});

test('L-bracket with the bore removed maps as two blocks', cad, async () => {
  const session = await new CadSession(server.base).import('examples/l-bracket.step');
  const [hole] = session.features('hole');
  await session.apply({ kind: 'defeature', faceIds: hole.faces, label: 'Removed bore' });
  const result = await session.autoFix({ blends: true, holes: false, size: 4 });
  assert.equal(result.end.blocked, 0);
  assert.equal(session.features('hole').length, 0);
  assertMesh(session, 4, 0.9);
});

test('corner bracket with every hole removed maps with its chamfers kept', cad, async () => {
  const session = await new CadSession(server.base).import('long corner bracket.step');
  const holes = session.features('hole');
  assert.equal(holes.length, 12, 'six Ø8.5 bores and six Ø4.6 holes');
  await session.apply({ kind: 'defeature', faceIds: [...new Set(holes.flatMap(f => f.faces))], label: 'Removed holes' });
  assert.equal(session.topology.faces.length, 13, 'a clean tray');
  const result = await session.autoFix({ blends: false, holes: false, size: 4 });
  // One cut separates the floor from the walls and splits the wall ring at its corners.
  assert.deepEqual(result.end, { volumes: 5, mappable: 5, blocked: 0 });
  assert.equal(result.steps, 1);
  assertMesh(session, 4, 0.55);
});

test('corner bracket keeps its holes with Auto-fix after the passage step', cad, async () => {
  const s = await new CadSession(server.base).import('long corner bracket.step');
  const bores = s.features('hole').filter(f => f.diameter > 8);
  await s.apply({ kind: 'passages', faceIds: bores.flatMap(f => f.faces), passages: bores.map(f => F.squarePassage(s.recognized.ctx, f)), label: 'Square passages' });
  const result = await s.autoFix({ blends: false, holes: true, size: 4 });
  assert.deepEqual(result.end, { volumes: 64, mappable: 64, blocked: 0 });
  assert.ok(result.steps <= 20, `${result.steps} steps`);
  assert.equal(s.features('hole').length, 6, 'every Ø4.6 hole is kept round');
  assertMesh(s, 2.5, 0.25);
});

test('corner bracket keeps its holes when prepared by hand: passages, bounded cuts, boxed holes', cad, async () => {
  // The same operations the Prepare step offers, in the order a user picks them.
  const s = await new CadSession(server.base).import('long corner bracket.step');
  // Features: the Ø8.5 bores graze the floor by 0.25 mm, so they become square passages.
  const bores = s.features('hole').filter(f => f.diameter > 8);
  assert.equal(bores.length, 6);
  await s.apply({ kind: 'passages', faceIds: bores.flatMap(f => f.faces), passages: bores.map(f => F.squarePassage(s.recognized.ctx, f)), label: 'Square passages' });
  // Cut tool: the pocket floor outline (four edges) and one cut across each wall corner (vertex pairs).
  const ctx = s.recognized.ctx;
  const floor = s.planarFace([0, 0, 1], c => Math.abs(c[2] - 6) < 1e-3);
  const outline = F.edgeCut(ctx, floor.orientedLoops[0].map(([e]) => e));
  const corners = [[[0, 10, 20], [6, 12.48, 20]], [[10, 0, 20], [12.48, 6, 20]], [[6, 89.9, 20], [6, 100, 20]], [[67.6, 6, 20], [75, 6, 20]]]
    .map(pair => F.vertexCut(ctx, pair.map(p => s.vertexNear(p))));
  const parts = [outline, ...corners];
  parts.forEach(p => assert.ok(p.operation, p.error));
  await s.apply(F.cutOperation(ctx, parts.flatMap(p => p.segments), [0, 0, 1], parts.flatMap(p => p.volumeIds), 'Cut the walls from the floor', parts.flatMap(p => p.faces)));
  assert.deepEqual(s.analysis.summary, { volumes: 5, mappable: 2, blocked: 3 }, 'core floor, chamfer corner and three walls');
  // Slice along the passage floor and ceiling.
  for (const [lo, hi] of [[6.5, 7.5], [12.5, 13.5]]) {
    const face = s.planarFace([0, 0, 1], c => c[2] > lo && c[2] < hi);
    await s.apply({ kind: 'slice', planes: [{ origin: face.center, normal: [0, 0, 1] }] });
  }
  // Box the Ø4.6 holes of each outer wall in square cells, then split around each hole.
  for (const axis of [0, 1]) await s.apply(s.fix(s.features('hole').find(h => Math.abs(h.axis[axis]) > 0.9).solids[0], 'box-holes'));
  for (const center of s.features('hole').map(h => h.center)) {
    await s.apply(F.holeSplit(s.recognized.ctx, s.features('hole').find(h => Math.hypot(...h.center.map((v, i) => v - center[i])) < 1e-6)));
  }
  // Where the passages cross inside the angled wall: cut along the imprints, then join the re-entrant corners.
  await s.applyEach('cut-imprints');
  await s.applyEach('join:');
  assert.deepEqual(s.analysis.summary, { volumes: 64, mappable: 64, blocked: 0 });
  assert.equal(s.features('hole').length, 6, 'every Ø4.6 hole is kept round');
  assert.equal(s.steps.length, 20);
  assertMesh(s, 2.5, 0.25);
});

test('wheel: the conical chamfers around each spoke slot are one chamfer each and come off together', cad, async () => {
  const s = await new CadSession(server.base).import('examples/wheel.step');
  const chamfers = s.features('chamfer');
  assert.equal(chamfers.length, 6, 'one chamfer per slot outline and side');
  for (const c of chamfers) {
    assert.equal(c.faces.length, 4);
    assert.ok(Math.abs(c.width - 0.7) < 0.05, `chamfer width ${c.width}`);
  }
  assert.ok(!s.recognized.features.some(f => f.kind === 'fillet' && chamfers.some(c => c.faces.some(id => f.faces.includes(id)))), 'no chamfer face is also called a fillet');
  const faces = s.topology.faces.length;
  await s.apply({ kind: 'defeature', faceIds: chamfers.flatMap(c => c.faces).sort((a, b) => a - b), label: 'Removed chamfers' });
  assert.equal(s.features('chamfer').length, 0);
  assert.ok(s.topology.faces.length < faces);
});

test('boxing holes never cuts through one: pairs share the width, and cuts stay clear of holes elsewhere', cad, async () => {
  for (const file of ['examples/plate-hole.step', 'examples/shells/bent_bracket_holes.step']) {
    const s = await new CadSession(server.base).import(file);
    const holes = () => s.features('hole').filter(h => h.through);
    const count = holes().length;
    await s.apply(F.holeCells(s.recognized.ctx, holes()));
    assert.equal(holes().length, count, file);
    for (const hole of holes()) {
      const edges = new Set(hole.faces.flatMap(f => s.recognized.ctx.faceEdges.get(f) || []));
      const hosts = s.topology.faces.filter(f => (f.orientedLoops || []).length > 1 && f.orientedLoops.some(loop => loop.every(([e]) => edges.has(Number(e)))));
      assert.equal(hole.solids.length, 1, `${file}: ${hole.label} at ${hole.center} is not cut`);
      assert.ok(hosts.length === 2 && hosts.every(f => f.orientedLoops.length === 2), `${file}: ${hole.label} at ${hole.center} sits alone in a cell on both sides`);
    }
  }
});
