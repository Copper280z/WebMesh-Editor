// Verify the saved browser result, including the retained side of every seam.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../../..');
const H = require(root + '/app/hex-mapping');
const L = require(root + '/app/cad-local-mesh');
const blades = [15, 21, 43, 44, 53, 55, 57, 59];

function read(file) {
  const p = JSON.parse(fs.readFileSync(file));
  const d = p.ownership.project.objects.find(o => o.definition.generator === 'cad-mapped-v1').definition;
  const t = p.ownership.project.objects.find(o => 'topology' in o.definition).definition.topology;
  const cards = new Map(d.cards.map(c => [c.family + ':' + c.id, c]));
  const members = new Map(d.volumeElements.map(v => [v.id, v.elements]));
  const nodes = new Map(d.cards.filter(c => c.family === 'nodes').map(c => [c.id, [c.value.x, c.value.y, c.value.z]]));
  const elements = d.cards.filter(c => c.family === 'elems');
  const checks = [];
  for (const f of t.faces.filter(f => f.volumes.length === 2)) {
    const ns = d.faces.find(x => x.id === f.id).nodes;
    const signatures = f.volumes.map(v => L.faceSignatures(members.get(v).map(id => ({ nodes: cards.get('elems:' + id).value.n })), ns));
    assert.ok(signatures[0].length, 'Missing face ' + f.id);
    assert.deepEqual(...signatures, 'Nonconforming face ' + f.id);
    checks.push({ face: f.id, solids: f.volumes, quads: signatures[0].length });
  }
  const q = elements.map(c => H.hexQuality(c.value.n.map(id => nodes.get(id))));
  const parent = new Map([...nodes.keys()].map(id => [id, id]));
  function find(id) { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); } return id; }
  for (const e of elements) for (const id of e.value.n) parent.set(find(id), find(e.value.n[0]));
  return { p, d, t, cards, members, nodes, elements, checks, metrics: {
    elements: elements.length, nodes: nodes.size, sharedCadFaces: checks.length,
    sharedQuads: checks.reduce((n, c) => n + c.quads, 0),
    connectedComponents: new Set([...nodes.keys()].map(find)).size,
    minScaledJacobian: Math.min(...q.map(x => x.scaledJacobian)),
    maxAspect: Math.max(...q.map(x => x.aspect)),
    invertedElements: q.filter(x => x.scaledJacobian <= 0).length,
  } };
}

const before = read(process.argv[2] || root + '/test-results/flexure-hex/flexure-bulk-coarsened.webmesh');
const after = read(process.argv[3] || root + '/test-results/flexure-hex/flexure-all-blades.webmesh');
assert.deepEqual(before.t, after.t);
assert.deepEqual(before.d.settings.mesh.solidMethods, after.d.settings.mesh.solidMethods);
const analysis = H.analyze(after.t);
const impact = L.impact(analysis, before.d.settings, after.d.settings, before.d.targets);
assert.equal(impact.conflicts.length, 0);
assert.ok(after.d.layout.patchGeneration > before.d.layout.patchGeneration);
const keep = before.d.volumeElements.filter(v => !impact.affected.includes(v.id)).flatMap(v => v.elements);
const keepSet = new Set(keep);
const kn = new Set(before.elements.filter(c => keepSet.has(c.id)).flatMap(c => c.value.n));
for (const c of before.d.cards) if (c.family === 'elems' ? keepSet.has(c.id) : kn.has(c.id)) assert.deepEqual(after.cards.get(c.family + ':' + c.id), c);
const solved = [before, after].map(x => L.solve(analysis, x.d.settings));
const bladeCounts = blades.map(id => {
  const dims = solved.map(s => {
    const out = [];
    for (const axis of [0, 1, 2]) {
      const e = analysis.volumes.get(id).block.logicalEdges.find(e => e.axis === axis);
      const [p, q] = e.corners.map(v => analysis.index.vertices.get(v));
      const physicalAxis = [0, 1, 2].find(k => Math.abs(p[k]-q[k]) > 1e-6);
      out[physicalAxis] = e.edges.reduce((n, e) => n + s.counts.get(e), 0);
    }
    return out;
  });
  assert.deepEqual(dims[1], [7, 6, 3], 'Blade XYZ counts: ' + id);
  assert.deepEqual(dims[0], [7, 6, id === 15 ? 3 : 1]);
  assert.equal(after.members.get(id).length, 126);
  const meshNodes = new Set(after.members.get(id).flatMap(eid => after.cards.get('elems:' + eid).value.n));
  const actualPlanes = [0, 1, 2].map(axis => new Set([...meshNodes].map(n => after.nodes.get(n)[axis].toFixed(8))).size);
  assert.deepEqual(actualPlanes, [8, 7, 4], 'Actual blade node planes: ' + id);
  return { solid: id, beforeXYZ: dims[0], afterXYZ: dims[1], beforeElements: before.members.get(id).length, afterElements: after.members.get(id).length };
});
const protectedSolids = [15, ...before.d.settings.sizing.solids.map(v => v.id), ...Array.from({length:56}, (_,i) => 106+i)];
for (const id of protectedSolids) {
  assert.ok(!impact.affected.includes(id), 'Protected solid changed: ' + id);
  assert.deepEqual(before.members.get(id), after.members.get(id));
}
for (const control of before.d.settings.sizing.solids) assert.deepEqual(after.d.settings.sizing.solids.find(c => c.id === control.id), control);
for (const control of before.d.settings.sizing.edges) assert.deepEqual(after.d.settings.sizing.edges.find(c => c.id === control.id), control);
assert.equal(after.d.settings.sizing.size, before.d.settings.sizing.size);
assert.ok(after.metrics.minScaledJacobian >= before.metrics.minScaledJacobian - 1e-10);
assert.equal(after.metrics.connectedComponents, 1);
assert.equal(after.metrics.invertedElements, 0);
assert.equal(after.metrics.sharedCadFaces, 297);
const result = {
  before: before.metrics, after: after.metrics,
  localPatchOperations: after.d.layout.patchGeneration - before.d.layout.patchGeneration,
  changePercent: 100 * (after.elements.length / before.elements.length - 1),
  direct: impact.direct, dependent: impact.propagated,
  retainedSolids: impact.unchanged.length, retainedElements: keep.length, retainedNodes: kn.size,
  protectedSolids, blades: bladeCounts, sizing: after.d.settings.sizing,
  patchBoundaryCadFaces: after.checks.filter(c => c.solids.some(id => impact.affected.includes(id)) && c.solids.some(id => !impact.affected.includes(id))).length,
  checks: after.checks,
};
console.log(JSON.stringify(result, null, 2));
