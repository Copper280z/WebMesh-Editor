const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const H = require('../app/hex-mapping.js');
const F = require('../app/cad-features.js');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mapping', name + '.json'), 'utf8')).topology;
const clone = value => JSON.parse(JSON.stringify(value));

test('a through hole is recognized with its diameter, axis and center', () => {
  const t = fixture('plate-hole');
  const { features } = F.recognize(t);
  const hole = features.find(f => f.kind === 'hole');
  assert.ok(hole);
  assert.equal(hole.through, true);
  assert.ok(Math.abs(hole.diameter - 6) < 1e-6);
  assert.ok(Math.abs(Math.abs(hole.axis[2]) - 1) < 1e-9);
  assert.ok(Math.abs(hole.center[0] - 10) < 1e-6 && Math.abs(hole.center[1] - 10) < 1e-6);
  assert.match(hole.label, /Ø6 through hole/);
});

test('picking a hole face infers removal, radial splits to the corners and a passage', () => {
  const t = fixture('plate-hole');
  const recognized = F.recognize(t), analysis = H.analyze(t);
  const hole = recognized.features.find(f => f.kind === 'hole');
  const info = F.infer(t, recognized, analysis, { kind: 'face', ids: [hole.faces[0]] });
  const keys = info.actions.map(a => a.key);
  assert.deepEqual(keys.slice(0, 4), ['remove-feature', 'split-hole', 'split-hole-ring', 'passage']);
  const split = info.actions.find(a => a.key === 'split-hole').operation;
  assert.equal(split.kind, 'slice');
  assert.equal(split.rays.length, 4);
  // Each radial cut ends at a corner of the 20 x 20 plate.
  const ends = split.rays.map(r => r.origin.map((v, i) => v + r.direction[i] * r.length)).map(p => [Math.round(p[0]), Math.round(p[1])].join(','));
  assert.deepEqual(ends.sort(), ['0,0', '0,20', '20,0', '20,20']);
  assert.equal(info.actions.find(a => a.key === 'split-hole-ring').operation.cylinders[0].radius, 3 * 1.8);
  const passage = info.actions.find(a => a.key === 'passage').passage;
  assert.equal(passage.axis, 'z');
  assert.ok(Math.abs(passage.width - 6 / Math.SQRT2) < 1e-6);
});

test('a face plane that crosses a solid infers a slice along it; an exterior face a parallel slice', () => {
  const l = fixture('l-shape');
  const inner = l.faces.find(f => f.surface.kind === 'plane' && Math.abs(f.surface.normal[0]) === 1 && Math.abs(f.surface.origin[0] - 5) < 1e-9);
  const along = F.infer(l, F.recognize(l), H.analyze(l), { kind: 'face', ids: [inner.id] }).actions.find(a => a.key === 'slice-face');
  assert.ok(along, 'the inner face plane of the L crosses the solid');
  assert.deepEqual(along.slice.normal, [1, 0, 0]);
  assert.match(along.detail, /through 1 solid/);
  const box = fixture('box');
  const outer = box.faces.find(f => f.surface.kind === 'plane');
  const actions = F.infer(box, F.recognize(box), H.analyze(box), { kind: 'face', ids: [outer.id] }).actions;
  assert.equal(actions.some(a => a.key === 'slice-face'), false);
  const parallel = actions.find(a => a.key === 'slice-parallel');
  assert.equal(parallel.slice.normal.filter(v => v === 1).length, 1);
  assert.deepEqual(parallel.slice.origin, [5, 3, 2]);
});

test('fillets are removed first; re-entrant edges get slices along both adjacent faces', () => {
  const filleted = fixture('filleted-block');
  const recognized = F.recognize(filleted);
  assert.ok(recognized.features.some(f => f.kind === 'fillet'));
  const fixes = F.fixes(recognized.ctx, recognized, H.analyze(filleted).volumes.get(1));
  assert.equal(fixes[0].operation.kind, 'defeature');
  assert.equal(fixes[0].feature, 'fillet');
  const l = fixture('l-shape');
  const lr = F.recognize(l);
  const slices = F.fixes(lr.ctx, lr, H.analyze(l).volumes.get(1)).filter(a => a.operation?.kind === 'slice');
  assert.equal(slices.length, 2);
  const normals = slices.map(a => a.operation.planes[0].normal.join(',')).sort();
  assert.deepEqual(normals, ['0,1,0', '1,0,0']);
  for (const a of slices) assert.deepEqual(a.operation.volumeIds, [1]);
});

test('re-entrant edge selection proposes the resolving slices', () => {
  const l = fixture('l-shape');
  const analysis = H.analyze(l);
  const edge = analysis.volumes.get(1).reasons.find(r => r.code === 'reentrant').edges[0];
  const info = F.infer(l, F.recognize(l), analysis, { kind: 'edge', ids: [edge] });
  assert.ok(info.actions.filter(a => a.key.startsWith('slice-reentrant')).length === 2);
  assert.match(info.facts.find(([k]) => k === 'Dihedral')[1], /270°/);
});

test('slices that would graze a cylinder are never suggested', () => {
  const t = clone(fixture('l-shape'));
  // Place a cylinder tangent to the plane x = 5 inside solid 1.
  const extra = { id: 999, type: 'Cylinder', area: 1, volumes: [1], loops: [], corners: [], surface: { kind: 'cylinder', origin: [6, 2, 0], axis: [0, 0, 1], radius: 1 } };
  t.faces.push(extra); t.volumes[0].faces.push(999);
  const recognized = F.recognize(t);
  const fixes = F.fixes(recognized.ctx, recognized, H.analyze(t).volumes.get(1)).filter(a => a.operation?.kind === 'slice');
  assert.ok(fixes.every(a => a.operation.planes[0].normal[0] !== 1), 'plane x = 5 is tangent to the cylinder');
});

test('solid and vertex selections describe the entity and offer slices', () => {
  const t = fixture('l-shape');
  const analysis = H.analyze(t), recognized = F.recognize(t);
  const solid = F.infer(t, recognized, analysis, { kind: 'solid', ids: [1] });
  assert.equal(solid.subtitle, 'Not mappable yet');
  assert.ok(solid.actions.length >= 2);
  const vertex = F.infer(t, recognized, analysis, { kind: 'vertex', ids: [t.vertices[0].id] });
  assert.deepEqual(vertex.actions.map(a => a.slice.normal), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
});

test('a triangular prism splits into three blocks whose cuts meet at 120°', () => {
  const t = fixture('triangle-prism');
  const r = F.recognize(t), volume = H.analyze(t).volumes.get(1);
  const split = F.fixes(r.ctx, r, volume).find(a => a.key.startsWith('split-mid'));
  assert.ok(split);
  const rays = split.operation.rays;
  assert.equal(rays.length, 3);
  for (let i = 0; i < 3; i++) {
    const a = rays[i].direction, b = rays[(i + 1) % 3].direction;
    const angle = Math.acos(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * 180 / Math.PI;
    assert.ok(Math.abs(angle - 120) < 0.5, `cut angle ${angle}`);
  }
});

test('holes sharing a face are boxed (or separated) before any is split around', () => {
  const t = fixture('holed-wall');
  const r = F.recognize(t), volume = H.analyze(t).volumes.get(1);
  const fixes = F.fixes(r.ctx, r, volume);
  assert.equal(fixes[0].key.split(':')[0], 'box-holes');
  const separate = fixes.find(a => a.key.startsWith('separate-holes'));
  const positions = separate.operation.planes.map(p => p.origin[1]).sort((a, b) => a - b);
  assert.deepEqual(positions.map(v => Math.round(v * 10) / 10), [32.5, 57.5]);
  assert.ok(separate.operation.planes.every(p => p.normal[1] === 1));
  assert.ok(fixes.findIndex(a => a.key.startsWith('split-hole')) > fixes.indexOf(separate));
});

test('a tapered block is squared up through the chamfer end, across its long edge', () => {
  const t = fixture('chamfer-strip');
  const r = F.recognize(t), volume = H.analyze(t).volumes.get(1);
  const fixes = F.shapeFixes(r.ctx, volume);
  assert.ok(fixes.some(a => a.operation.planes[0].normal[1] === 1 && Math.abs(a.operation.planes[0].origin[1] - 10) < 1e-6), 'plane y = 10 through the chamfer end');
});

const endpoints = ray => [ray.origin, ray.origin.map((v, i) => v + ray.direction[i] * ray.length)];
const onSegment = (p, [a, b]) => {
  const d = b.map((v, i) => v - a[i]), t = Math.max(0, Math.min(1, d.reduce((s, v, i) => s + v * (p[i] - a[i]), 0) / d.reduce((s, v) => s + v * v, 0)));
  return Math.hypot(...p.map((v, i) => v - (a[i] + t * d[i]))) < 1e-9;
};

test('an L-shaped imprint is cut where it runs, not along whole planes', () => {
  const t = fixture('l-footprint');
  const recognized = F.recognize(t), analysis = H.analyze(t);
  const slab = t.volumes.find(v => v.bounds[5] < 2.01);
  const fixes = F.fixes(recognized.ctx, recognized, analysis.volumes.get(slab.id));
  assert.match(fixes[0].key, /^cut-imprints:/, 'one bounded cut ranks before the two whole-plane slices');
  const { rays, volumeIds } = fixes[0].operation;
  assert.deepEqual(volumeIds, [slab.id]);
  assert.equal(rays.length, 2);
  for (const ray of rays) assert.deepEqual(ray.axis, [0, 0, 1]);
  // Both legs pass through the inner corner, where they meet without overshoot; the free ends reach past the slab.
  const ends = rays.flatMap(endpoints);
  assert.equal(ends.filter(p => Math.hypot(p[0] - 4, p[1] - 4) < 1e-9).length, 2);
  assert.ok(ends.some(p => p[1] > 10) && ends.some(p => p[0] > 10));
  assert.ok(ends.every(p => p[0] > 4 - 1e-9 && p[1] > 4 - 1e-9), 'nothing is cut through the L itself');
});

test('two re-entrant corners that see each other are joined by one straight cut', () => {
  const t = fixture('s-prism');
  const recognized = F.recognize(t), analysis = H.analyze(t);
  const [fix] = F.fixes(recognized.ctx, recognized, analysis.volumes.get(1));
  assert.match(fix.key, /^join:/);
  assert.equal(fix.primary, true);
  const [ray] = fix.operation.rays;
  assert.equal(fix.operation.rays.length, 1);
  assert.ok(Math.abs(Math.abs(ray.axis[2]) - 1) < 1e-12);
  const segment = endpoints(ray);
  for (const corner of [[3, 1], [1, 2]]) assert.ok(onSegment([...corner, ray.origin[2]], segment), `passes corner ${corner}`);
});

test('edge and vertex picks infer bounded cuts swept along the face they lie in', () => {
  const t = fixture('t-junction');
  const recognized = F.recognize(t), analysis = H.analyze(t), ctx = recognized.ctx;
  const imprint = t.edges.find(e => e.curve?.kind === 'line' && e.vertices.every(v => { const p = ctx.vertices.get(v); return Math.abs(p[0] - 4) < 1e-9 && Math.abs(p[2] - 2) < 1e-9; }));
  const base = t.volumes.find(v => v.bounds[5] < 2.01);
  const cut = F.edgeCut(ctx, [imprint.id]);
  assert.deepEqual(cut.axis, [0, 0, 1]);
  assert.deepEqual(cut.volumeIds, [base.id], 'only the solid the imprint lies across');
  const info = F.infer(t, recognized, analysis, { kind: 'edge', ids: [imprint.id] });
  assert.ok(info.actions.some(a => a.key === 'cut-edges' && a.tool === 'cut'));

  const box = fixture('box'), boxCtx = F.context(box);
  const at = p => box.vertices.find(v => v.point.every((x, i) => Math.abs(x - p[i]) < 1e-9)).id;
  const diagonal = F.vertexCut(boxCtx, [at([0, 0, 4]), at([10, 6, 4])]);
  assert.deepEqual(diagonal.axis, [0, 0, 1]);
  assert.equal(diagonal.operation.rays.length, 1);
  assert.ok(diagonal.operation.rays[0].length > Math.hypot(10, 6), 'both ends reach past the boundary');
  assert.match(F.vertexCut(boxCtx, [at([0, 0, 0]), at([10, 6, 4])]).error, /planar face/);
  const multi = F.infer(box, F.recognize(box), H.analyze(box), { kind: 'vertex', ids: [at([0, 0, 4]), at([10, 6, 4])] });
  assert.equal(multi.actions[0].key, 'cut-vertices');
});

test('holes in a long wall are boxed in square cells as wide as the wall is high', () => {
  const t = fixture('holed-wall');
  const recognized = F.recognize(t);
  const holes = recognized.features.filter(f => f.kind === 'hole');
  const op = F.holeCells(recognized.ctx, holes);
  assert.equal(op.kind, 'slice');
  assert.ok(op.planes.every(p => p.normal[1] === 1));
  assert.deepEqual(op.planes.map(p => Math.round(p.origin[1] * 1e6) / 1e6).sort((a, b) => a - b), [10, 30, 35, 55, 60, 80]);
  const fixes = F.fixes(recognized.ctx, recognized, H.analyze(t).volumes.get(1));
  assert.ok(fixes.some(a => a.key.startsWith('box-holes:')));
  // Holes closer than a cell share the plane midway between them.
  const close = holes.map((h, i) => ({ ...h, center: [h.center[0], 20 + 10 * i, h.center[2]] }));
  const shared = F.holeCells(recognized.ctx, close).planes.map(p => Math.round(p.origin[1] * 1e6) / 1e6).sort((a, b) => a - b);
  assert.deepEqual(shared, [10, 25, 35, 50]);
});

test('holes side by side across a wall share its height, and no cell plane passes through a hole', () => {
  const t = fixture('holed-wall');
  const recognized = F.recognize(t);
  const round = v => Math.round(v * 1e6) / 1e6;
  const [first, middle] = recognized.features.filter(f => f.kind === 'hole').sort((a, b) => a.center[1] - b.center[1]);
  // Two holes level along the wall, one above the other: each gets half the height, with a cut between them.
  const low = { ...middle, center: [3, 45, 5] }, high = { ...middle, id: 'high', center: [3, 45, 15] };
  const op = F.holeCells({ ...recognized.ctx, features: [first, low, high] }, [first, low, high]);
  assert.deepEqual(op.planes.map(p => round(p.origin[1])).sort((a, b) => a - b), [10, 30, 40, 50], 'no plane through the pair');
  assert.equal(op.rays.length, 1);
  assert.deepEqual([...op.rays[0].origin.slice(1), op.rays[0].length].map(round), [40, 10, 10], 'the cut between them ends on their cell planes');
  assert.deepEqual(op.rays[0].direction, [0, 1, 0]);
  // A plane that would cross another hole of the solid moves just clear of it.
  const near = { ...middle, id: 'near', center: [3, 31, 3] };
  const moved = F.holeCells({ ...recognized.ctx, features: [first, near] }, [first]).planes.map(p => round(p.origin[1])).sort((a, b) => a - b);
  assert.deepEqual(moved, [10, 28.125]);
});

test('walls around a pocket floor are separated, with mitered cuts across the corners', () => {
  const t = fixture('tray');
  const recognized = F.recognize(t);
  const [fix] = F.fixes(recognized.ctx, recognized, H.analyze(t).volumes.get(1));
  assert.match(fix.key, /^pocket:/);
  const { rays, volumeIds } = fix.operation;
  assert.deepEqual(volumeIds, [1]);
  assert.equal(rays.length, 8);
  assert.ok(rays.every(r => r.axis[2] === 1));
  const ends = rays.map(r => r.origin.map((v, i) => v + r.direction[i] * r.length));
  // Four cuts follow the floor outline; four run from its corners to the outer corners.
  const outline = rays.filter(r => r.origin[0] >= 3 - 1e-9 && r.origin[0] <= 17 + 1e-9 && ends[rays.indexOf(r)].every((v, i) => i === 2 || (v >= 3 - 1e-9 && v <= (i ? 11 : 17) + 1e-9)));
  assert.equal(outline.length, 4);
  for (const corner of [[0, 0], [20, 0], [20, 14], [0, 14]]) assert.ok(ends.some(p => Math.hypot(p[0] - corner[0], p[1] - corner[1]) < 0.05), `a miter reaches ${corner}`);
});

test('square openings are sliced at their floor and ceiling before their sides', () => {
  const t = fixture('windowed-wall');
  const recognized = F.recognize(t);
  const fixes = F.fixes(recognized.ctx, recognized, H.analyze(t).volumes.get(1)).filter(a => a.key.startsWith('levels:'));
  assert.equal(fixes.length, 2);
  const levels = p => p.operation.planes.map(q => Math.round(q.origin[p.operation.planes[0].normal.indexOf(1)] * 1e6) / 1e6).sort((a, b) => a - b);
  assert.deepEqual(fixes[0].operation.planes[0].normal, [0, 0, 1]);
  assert.deepEqual(levels(fixes[0]), [7, 13]);
  assert.deepEqual(levels(fixes[1]), [12, 18]);
  assert.match(fixes[0].label, /⟂ Z/);
});

test('picking neighboring solids offers to fuse them; separated ones explain why not', () => {
  const t = fixture('plate-hole-radial');
  const recognized = F.recognize(t), analysis = H.analyze(t);
  const touching = (a, b) => t.faces.some(f => (f.volumes || []).includes(a) && (f.volumes || []).includes(b));
  const ids = t.volumes.map(v => v.id);
  const [a] = ids, b = ids.find(id => id !== a && touching(a, id)), far = ids.find(id => id !== a && !touching(a, id));
  const info = F.infer(t, recognized, analysis, { kind: 'solid', ids: [a, b] });
  assert.equal(info.title, '2 solids');
  assert.equal(info.actions[0].key, 'fuse');
  assert.deepEqual(info.actions[0].operation, { kind: 'fuse', volumeIds: [a, b].sort((x, y) => x - y), label: `Fused solids ${[a, b].sort((x, y) => x - y).join(', ')}` });
  const apart = F.infer(t, recognized, analysis, { kind: 'solid', ids: [a, far] });
  assert.ok(!apart.actions.some(x => x.key === 'fuse'));
  assert.match(apart.facts.find(([k]) => k === 'Fuse')[1], /share faces/);
});

test('when Auto-fix stops short or fails, it reports why and keeps every applied step', async () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mapping', 'l-shape.json'), 'utf8'));
  const split = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mapping', 'l-split.json'), 'utf8'));
  const state = () => ({ topology: data.topology, preview: data.preview, revision: 0 });
  // No candidate previews: nothing changes, and it says so.
  const stuck = await F.autoFix({ state, preview: async () => { throw Error('kernel refused'); }, apply: async () => {} }, { mapping: H, blends: false, size: 2 });
  assert.equal(stuck.reason, 'stuck');
  assert.equal(stuck.steps, 0);
  assert.deepEqual(stuck.blocked, [1]);
  // A failing apply ends the run with the error instead of throwing.
  const failed = await F.autoFix({ state, preview: async () => split, apply: async () => { throw Error('disk full'); } }, { mapping: H, blends: false, size: 2 });
  assert.equal(failed.reason, 'error');
  assert.equal(failed.error, 'disk full');
  assert.deepEqual(failed.end, { volumes: 1, mappable: 0, blocked: 1 });
  // One good step, then nothing more: the step is reported and kept.
  let current = data;
  const partial = await F.autoFix({ state: () => ({ topology: current.topology, preview: current.preview, revision: 0 }), preview: async () => split, apply: async () => { current = split; } },
    { mapping: H, blends: false, size: 2, shape: false });
  assert.equal(partial.reason, 'done');
  assert.equal(partial.steps, 1);
});

test('Auto-fix keeps fillets and chamfers unless asked to remove small ones', async () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mapping', 'filleted-block.json'), 'utf8'));
  const run = async options => {
    const kinds = [];
    const result = await F.autoFix({ state: () => ({ topology: data.topology, preview: data.preview, revision: 0 }),
      preview: async operation => { kinds.push(operation.kind); throw Error('no improvement'); }, apply: async () => {} }, { mapping: H, size: 2, shape: false, ...options });
    return { result, kinds };
  };
  const kept = await run({});
  assert.ok(kept.kinds.length, 'it still tries cuts');
  assert.ok(!kept.kinds.includes('defeature'), 'no feature is removed by default');
  const removing = await run({ blends: true });
  assert.ok(removing.kinds.includes('defeature'), 'the opt-in removes the small fillet');
});

test('Stop ends Auto-fix promptly and keeps the steps it applied', async () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mapping', 'l-shape.json'), 'utf8'));
  const split = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mapping', 'l-split.json'), 'utf8'));
  // A preview that never answers: Stop does not wait for it.
  const controller = new AbortController();
  const waiting = F.autoFix({ state: () => ({ topology: data.topology, preview: data.preview, revision: 0 }), preview: () => new Promise(() => {}), apply: async () => {} },
    { mapping: H, size: 2, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const stopped = await waiting;
  assert.equal(stopped.reason, 'stopped');
  assert.equal(stopped.steps, 0);
  // Stopped while a step is applied: that step completes and stays.
  let current = data;
  const second = new AbortController();
  const partial = await F.autoFix({ state: () => ({ topology: current.topology, preview: current.preview, revision: 0 }), preview: async () => split,
    apply: async () => { second.abort(); current = split; } }, { mapping: H, size: 2, signal: second.signal });
  assert.equal(partial.reason, 'stopped');
  assert.equal(partial.steps, 1);
  assert.deepEqual(partial.end, H.analyze(split.topology).summary);
});

test('a solid holding a piece of a hole is split by radial cuts to its own corners', () => {
  const t = fixture('plate-hole-quarters');
  const recognized = F.recognize(t), analysis = H.analyze(t);
  const quarter = [...analysis.volumes.values()].find(v => !v.mappable);
  const [fix] = F.fixes(recognized.ctx, recognized, quarter);
  assert.match(fix.key, /^split-arc:/);
  assert.deepEqual(fix.operation.volumeIds, [quarter.id]);
  const record = t.volumes.find(v => v.id === quarter.id);
  const far = [0, 1].map(i => (Math.abs(record.bounds[i] - 10) > Math.abs(record.bounds[i + 3] - 10) ? record.bounds[i] : record.bounds[i + 3]));
  // One cut reaches the plate corner diagonally opposite the hole.
  assert.ok(fix.operation.rays.some(r => Math.hypot(...[0, 1].map(i => r.origin[i] + r.direction[i] * r.length - far[i])) < 0.01));
  assert.ok(fix.operation.rays.every(r => Math.hypot(r.origin[0] - 10, r.origin[1] - 10) < 1e-9), 'cuts start on the hole axis');
});

test('a sheet side grows across tangent faces, and its opposite side is the nearest parallel or coaxial face', () => {
  const box = fixture('box'), filleted = fixture('filleted-block');
  assert.deepEqual(F.tangentSide(box, [1]), [1], 'square edges stop the side');
  assert.deepEqual(F.oppositeSide(box, [1]), { faces: [2], missing: [] });
  // Faces 1 and 6 meet through the tangent fillet 3: one side of three faces.
  assert.deepEqual(F.tangentSide(filleted, [1]), [1, 3, 6]);
  const across = F.oppositeSide(filleted, [1, 3, 6]);
  assert.deepEqual(across.faces, [4, 7]);
  assert.deepEqual(across.missing, [3], 'the fillet has no coaxial partner');
});
