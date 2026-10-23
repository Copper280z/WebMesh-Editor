const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const H = require('../app/hex-mapping.js');
const M = require('../app/modeling.js');

// Fixtures are real OpenCASCADE topologies produced by cad_mapping.py.
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'mapping', name + '.json'), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
function build(name, settings = { size: 1 }, options = {}) {
  const data = fixture(name);
  const analysis = H.analyze(data.topology);
  const intervals = H.solveIntervals(analysis, settings);
  const geometry = H.createGeometry(data.topology, data.preview);
  return { data, analysis, intervals, geometry, mesh: options.mesh === false ? null : H.generateMesh(analysis, intervals, geometry, options) };
}
function hexVolume(p) {
  let v = 0;
  for (const [a, b, c, d] of [[0, 1, 3, 4], [1, 2, 3, 6], [1, 3, 4, 6], [3, 4, 6, 7], [1, 4, 5, 6]]) {
    const u = [0, 1, 2].map(i => p[b][i] - p[a][i]), w = [0, 1, 2].map(i => p[c][i] - p[a][i]), z = [0, 1, 2].map(i => p[d][i] - p[a][i]);
    v += (u[0] * (w[1] * z[2] - w[2] * z[1]) - u[1] * (w[0] * z[2] - w[2] * z[0]) + u[2] * (w[0] * z[1] - w[1] * z[0])) / 6;
  }
  return v;
}
const points = mesh => new Map(mesh.nodes.map(n => [n.id, [n.x, n.y, n.z]]));
function meshVolume(mesh) {
  const p = points(mesh);
  return mesh.elements.reduce((sum, e) => sum + hexVolume(e.nodes.slice(0, 8).map(id => p.get(id))), 0);
}
function duplicateNodes(mesh) {
  const seen = new Set(); let duplicates = 0;
  for (const n of mesh.nodes) { const key = [n.x, n.y, n.z].map(v => Math.round(v * 1e7)).join(','); if (seen.has(key)) duplicates++; seen.add(key); }
  return duplicates;
}

test('a box is one mapped block whose counts follow the target size', () => {
  const { analysis, intervals, mesh } = build('box');
  assert.deepEqual(analysis.summary, { volumes: 1, mappable: 1, blocked: 0 });
  assert.equal(intervals.groups.length, 3);
  assert.deepEqual(intervals.groups.map(g => g.count).sort((a, b) => a - b), [4, 6, 10]);
  assert.equal(intervals.estimate, 240);
  assert.equal(mesh.elements.length, 240);
  assert.equal(mesh.quality.inverted, 0);
  assert.ok(Math.abs(mesh.quality.minScaledJacobian - 1) < 1e-9);
  assert.ok(Math.abs(meshVolume(mesh) - 240) < 1e-9);
  const report = M.validateMesh(mesh);
  assert.equal(report.valid, true, report.errors.join('\n'));
});

test('split blocks share interface nodes and form one conforming mesh', () => {
  for (const order of [1, 2]) {
    const { mesh, data } = build('split-box', { size: 0.7 }, { order });
    assert.equal(duplicateNodes(mesh), 0);
    const report = M.validateMesh(mesh);
    assert.equal(report.valid, true, report.errors.join('\n'));
    assert.equal(report.stats.nonManifoldFaces, 0);
    assert.ok(Math.abs(meshVolume(mesh) - data.topology.volume) < 1e-8);
    assert.equal(mesh.elements[0].nodes.length, order === 2 ? 20 : 8);
  }
});

test('T-junction imprints become sum equations that the solver satisfies', () => {
  const { intervals, mesh, data } = build('t-junction', { size: 0.9 });
  assert.equal(intervals.sums.length, 2);
  for (const sum of intervals.sums) assert.equal(sum.lhsValue, sum.rhsValue, `face ${sum.face}`);
  assert.equal(intervals.conflicts.length, 0);
  assert.equal(duplicateNodes(mesh), 0);
  assert.ok(Math.abs(meshVolume(mesh) - data.topology.volume) < 1e-8);
});

test('fixed counts propagate through a group and conflicting fixes are explained', () => {
  const data = fixture('split-box');
  const analysis = H.analyze(data.topology);
  const free = H.solveIntervals(analysis, { size: 1 });
  const group = free.groups.find(g => g.edges.length >= 4);
  const [a, b] = group.edges;
  const fixed = H.solveIntervals(analysis, { size: 1, controls: new Map([[a, { count: 7 }]]) });
  for (const e of group.edges) assert.equal(fixed.counts.get(e), 7);
  const conflict = H.solveIntervals(analysis, { size: 1, controls: new Map([[a, { count: 7 }], [b, { count: 5 }]]) });
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.conflicts[0].kind, 'locks');
  assert.ok(conflict.conflicts[0].edges.includes(a) && conflict.conflicts[0].edges.includes(b));
  assert.match(conflict.conflicts[0].message, new RegExp(`Edges ${Math.min(a, b) === a ? a : a}`));
  assert.equal(conflict.solvable, false);
  assert.throws(() => H.generateMesh(analysis, conflict, H.createGeometry(data.topology, data.preview)), /conflicts/);
});

test('fixed counts that break a sum equation are reported with the face', () => {
  const data = fixture('t-junction');
  const analysis = H.analyze(data.topology);
  const base = H.solveIntervals(analysis, { size: 1 });
  const sum = base.sums[0];
  const controls = new Map();
  for (const e of sum.lhs) controls.set(e, { count: 3 });
  sum.rhs.forEach((e, i) => controls.set(e, { count: i ? 2 : 2 }));
  const result = H.solveIntervals(analysis, { size: 1, controls });
  assert.ok(result.conflicts.length >= 1);
  assert.ok(result.conflicts.some(c => (c.faces || []).length && /cannot be satisfied|inconsistent|must match/.test(c.message)));
});

test('a sum that needs more positive elements than a fixed total is an integer conflict', () => {
  const data = fixture('t-junction');
  const analysis = H.analyze(data.topology);
  const sum = H.solveIntervals(analysis, { size: 1 }).sums[0];
  const single = sum.lhs.length === 1 ? sum.lhs[0] : sum.rhs[0];
  const result = H.solveIntervals(analysis, { size: 1, controls: new Map([[single, { count: 1 }]]) });
  assert.ok(result.conflicts.some(c => c.kind === 'integer' || c.kind === 'sum'));
});

test('re-entrant edges, holes and periodic faces block mapping with entity references', () => {
  const l = H.analyze(fixture('l-shape').topology).volumes.get(1);
  assert.equal(l.mappable, false);
  const reentrant = l.reasons.find(r => r.code === 'reentrant');
  assert.ok(reentrant && reentrant.edges.length === 1 && reentrant.faces.length === 2 && reentrant.angle > 260);
  const plate = H.analyze(fixture('plate-hole').topology).volumes.get(1);
  assert.ok(plate.reasons.some(r => r.code === 'face-holes'));
  assert.ok(plate.reasons.some(r => r.code === 'face-periodic'));
  const fillet = H.analyze(fixture('filleted-block').topology).volumes.get(1);
  assert.ok(fillet.reasons.some(r => r.code === 'face-corners'));
});

test('knife edges from tangential slices are degenerate, not block edges', () => {
  const data = fixture('box');
  const t = clone(data.topology);
  t.volumes[0].edgeAngles[0][1] = 0;
  const volume = H.analyze(t).volumes.get(1);
  assert.equal(volume.mappable, false);
  assert.equal(volume.reasons[0].code, 'cusp');
  t.volumes[0].edgeAngles[0][1] = 90;
  t.faces[0].corners[0][0][1] = 3;
  assert.equal(H.analyze(t).faces.get(t.faces[0].id).code, 'cusp');
});

test('radial sectors around a hole put every hole node on the cylinder', () => {
  const { mesh, data } = build('plate-hole-radial', { size: 0.8 });
  const hole = data.topology.faces.find(f => f.surface.kind === 'cylinder').surface;
  const p = points(mesh);
  let onHole = 0;
  for (const [, q] of p) {
    const d = [0, 1, 2].map(i => q[i] - hole.origin[i]);
    const along = d[0] * hole.axis[0] + d[1] * hole.axis[1] + d[2] * hole.axis[2];
    const r = Math.hypot(...d.map((v, i) => v - along * hole.axis[i]));
    if (Math.abs(r - hole.radius) < 1e-6) onHole++;
    assert.ok(r > hole.radius - 1e-9, 'no node inside the hole');
  }
  assert.ok(onHole > 50);
  assert.equal(mesh.quality.inverted, 0);
  assert.equal(M.validateMesh(mesh).valid, true);
  assert.equal(duplicateNodes(mesh), 0);
});

test('quadratic hexes place midside nodes on curved CAD surfaces', () => {
  const { mesh, data } = build('quarter-annulus', { size: 1.2 }, { order: 2 });
  const cylinders = data.topology.faces.filter(f => f.surface.kind === 'cylinder').map(f => f.surface);
  const p = points(mesh);
  const radial = q => Math.hypot(q[0] - cylinders[0].origin[0], q[1] - cylinders[0].origin[1]);
  const radii = cylinders.map(c => c.radius);
  let midsidesOnCurves = 0;
  for (const e of mesh.elements) for (const id of e.nodes.slice(8)) if (radii.some(r => Math.abs(radial(p.get(id)) - r) < 1e-9)) midsidesOnCurves++;
  assert.ok(midsidesOnCurves > 100);
  assert.equal(mesh.quality.inverted, 0);
  const report = M.validateMesh(mesh);
  assert.equal(report.valid, true, report.errors.join('\n'));
  assert.equal(mesh.elements[0].type, 'CHEXA');
  assert.equal(mesh.elements[0].nodes.length, 20);
});

test('every generated hex has positive volume with Nastran corner ordering', () => {
  for (const name of ['split-box', 't-junction', 'l-split', 'plate-hole-radial', 'quarter-annulus']) {
    const { mesh } = build(name, { size: 1.1 });
    const p = points(mesh);
    for (const e of mesh.elements) assert.ok(hexVolume(e.nodes.slice(0, 8).map(id => p.get(id))) > 0, `${name} element ${e.id}`);
  }
});

test('meshing a subset of blocks and the element limit are enforced', () => {
  const { analysis, intervals, geometry } = build('plate-hole-radial', { size: 1 }, { mesh: false });
  const subset = H.generateMesh(analysis, intervals, geometry, { volumes: [analysis.volumes.keys().next().value] });
  assert.equal(new Set(subset.elements.map(e => e.volume)).size, 1);
  const fine = H.solveIntervals(analysis, { size: 0.02 });
  assert.throws(() => H.generateMesh(analysis, fine, geometry), /exceeds/);
});

test('one property per solid is available for multi-block models', () => {
  const { mesh } = build('l-split', { size: 1 }, { pidPerSolid: true });
  assert.equal(new Set(mesh.elements.map(e => e.pid)).size, 2);
});

test('an obtuse corner is promoted so a four-sided face maps', () => {
  const { analysis, mesh } = build('obtuse-strip', { size: 2 });
  const volume = analysis.volumes.get(1);
  assert.equal(volume.mappable, true);
  const cap = [...analysis.faces.values()].find(f => f.promoted?.length);
  assert.ok(cap, 'the 143.5° corner is a block corner');
  assert.equal(mesh.quality.inverted, 0);
  assert.equal(M.validateMesh(mesh).valid, true);
});

test('a chamfered strip maps but is reported as strongly tapered', () => {
  const volume = H.analyze(fixture('chamfer-strip').topology).volumes.get(1);
  assert.equal(volume.mappable, true);
  assert.ok(volume.block.taper < 0.05);
  const taper = volume.warnings.find(w => w.code === 'taper');
  assert.ok(taper && taper.long.edges.length && taper.short.edges.length);
  assert.match(taper.message, /strongly tapered/);
});

test('equal obtuse corners are chosen by position, so both caps of a prism agree', () => {
  // Loop order differs from cap to cap; rotating one cap's loop must not change the block.
  const t = fixture('twin-obtuse').topology;
  const cap = t.faces.find(f => f.surface.kind === 'plane' && Math.abs(f.surface.normal[2]) > 0.99);
  for (let k = 0; k < cap.orientedLoops[0].length; k++) {
    const rotated = clone(t), face = rotated.faces.find(f => f.id === cap.id);
    const turn = list => list.slice(k).concat(list.slice(0, k));
    face.orientedLoops[0] = turn(face.orientedLoops[0]);
    face.corners[0] = turn(face.corners[0]);
    assert.equal(H.analyze(rotated).volumes.get(1).mappable, true, `cap loop starting at corner ${k}`);
  }
});

test('a solid holding a kept open cut is an open ring that needs another cut', () => {
  const data = fixture('box');
  const topology = JSON.parse(JSON.stringify(data.topology));
  const solid = topology.volumes[0].id;
  assert.equal(H.analyze(topology).volumes.get(solid).mappable, true);
  topology.faces.push({ ...JSON.parse(JSON.stringify(topology.faces[0])), id: 999, volumes: [], openIn: solid });
  const v = H.analyze(topology).volumes.get(solid);
  assert.equal(v.mappable, false);
  assert.equal(v.reasons[0].code, 'open-ring');
  assert.deepEqual(v.reasons[0].faces, [999]);
});

test('nodes project exactly onto cones and tori', () => {
  // The box fixture with two of its faces described as a cone and a torus.
  const data = fixture('box'), faces = data.topology.faces;
  faces[0].surface = { kind: 'cone', apex: [0, 0, 10], axis: [0, 0, -1], angle: Math.atan(0.5) };
  faces[1].surface = { kind: 'torus', center: [0, 0, 0], axis: [0, 0, 1], major: 8, minor: 2 };
  const geometry = H.createGeometry(data.topology, data.preview);
  const cone = geometry.surface(faces[0].id).project([3, 4, 2]);
  // On the cone: distance from the axis is (10 - z) * tan(angle).
  assert.ok(Math.abs(Math.hypot(cone[0], cone[1]) - (10 - cone[2]) * 0.5) < 1e-9, String(cone));
  assert.ok(Math.abs(Math.atan2(cone[1], cone[0]) - Math.atan2(4, 3)) < 1e-12, 'it stays on the same side of the axis');
  const torus = geometry.surface(faces[1].id).project([11, 0, 1]);
  assert.ok(Math.abs(Math.hypot(Math.hypot(torus[0], torus[1]) - 8, torus[2]) - 2) < 1e-9, String(torus));
});

for(const order of [1,2])test('mapped face membership contains exactly the referenced boundary nodes for order '+order,()=>{
  const {mesh,data}=build('box',{size:3},{order}),points=new Map(mesh.nodes.map(n=>[n.id,n]));
  assert.equal(Object.keys(mesh.faceNodes).length,6);
  for(const face of data.topology.faces){
    const onPlane=mesh.nodes.filter(n=>Math.abs(['x','y','z'].reduce((s,k,i)=>s+(n[k]-face.center[i])*face.normal[i],0))<1e-8).map(n=>n.id).sort((a,b)=>a-b);
    assert.deepEqual(mesh.faceNodes[face.id],onPlane);
    assert.ok(mesh.faceNodes[face.id].every(id=>points.has(id)));
    if(order===2)assert.ok(mesh.elements.some(e=>e.nodes.slice(8).some(id=>mesh.faceNodes[face.id].includes(id))));
  }
});
test('face membership is limited to meshed solids, with shared interfaces preserving node IDs',()=>{
  const data=fixture('split-box'),analysis=H.analyze(data.topology),intervals=H.solveIntervals(analysis,{size:1}),geometry=H.createGeometry(data.topology,data.preview);
  const full=H.generateMesh(analysis,intervals,geometry,{order:2});
  const one=H.generateMesh(analysis,intervals,geometry,{order:2,volumes:[1]});
  const faces=data.topology.faces.filter(f=>f.volumes.includes(1));
  assert.deepEqual(Object.keys(one.faceNodes).map(Number).sort((a,b)=>a-b),faces.map(f=>f.id).sort((a,b)=>a-b));
  const shared=data.topology.faces.find(f=>f.volumes.length===2);
  assert.ok(shared);assert.equal(one.faceNodes[shared.id].length,full.faceNodes[shared.id].length);
});

test('HEX20 midsides follow solver Nastran order: lower, vertical, upper edges',()=>{
  const {mesh}=build('split-box',{size:2},{order:2});const xyz=new Map(mesh.nodes.map(n=>[n.id,[n.x,n.y,n.z]]));
  // Independent solver convention: G13–G16 lie on G1–G5 ... G4–G8.
  const nastran=[[0,1],[1,2],[2,3],[3,0],[0,4],[1,5],[2,6],[3,7],[4,5],[5,6],[6,7],[7,4]];
  for(const e of mesh.elements)nastran.forEach(([a,b],i)=>xyz.get(e.nodes[8+i]).forEach((v,j)=>assert.ok(Math.abs(v-(xyz.get(e.nodes[a])[j]+xyz.get(e.nodes[b])[j])/2)<1e-8)));
});
