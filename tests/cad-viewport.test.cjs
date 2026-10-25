const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { normalizeCadPreview, createCadViewport } = require('../app/cad-viewport.js');
const vendor = vm.createContext({ window: {}, console, performance });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'vendor', 'three-runtime.js'), 'utf8'), vendor);
const THREE = vendor.window.WebMeshThree;
const plain = value => JSON.parse(JSON.stringify(value));
const square = z => [-1,-1,z, 1,-1,z, 1,1,z, -1,-1,z, 1,1,z, -1,1,z];
const preview = () => ({
  positions: [...square(0), ...square(-1)], triangleFaceIds: [10,10,20,20],
  faces: [{ id: 10, type: 'Plane', area: 4 }, { id: 20, type: 'Plane', area: 4 }],
  edges: [{ id: 101, points: [-1,-1,0, 1,-1,0, 1,1,0, -1,1,0, -1,-1,0] },
    { id: 102, points: [-1,0,-1, 1,0,-1] }]
});
function fixture() {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-2,2,2,-2,0.01,100);
  camera.position.set(0,0,5); camera.up.set(0,1,0); camera.lookAt(0,0,0); camera.updateMatrixWorld(true);
  const events = [], changes = [];
  const viewport = createCadViewport({ THREE, scene, getCamera: () => camera,
    getViewport: () => ({ left: 0, top: 0, width: 400, height: 400 }),
    onSelection: event => events.push(event), onChange: change => changes.push(change) });
  return { scene, camera, events, changes, viewport };
}

test('CAD preview validates topology ownership and preserves metadata', () => {
  const result = normalizeCadPreview(preview());
  assert.equal(result.triangleCount, 4); assert.equal(result.segmentCount, 5);
  assert.equal(result.faces.get(10).area, 4);
  assert.deepEqual(Array.from(result.triangleFaceIds), [10,10,20,20]);
});

for (const [name, mutate] of [
  ['missing ownership', data => { data.triangleFaceIds.pop(); }],
  ['invalid owner tag', data => { data.triangleFaceIds[0] = -3; }],
  ['incomplete triangles', data => { data.positions.pop(); }],
  ['nonfinite positions', data => { data.positions[0] = NaN; }],
  ['duplicate face metadata', data => { data.faces.push({ id: 10 }); }],
  ['duplicate edges', data => { data.edges.push({ id: 101, points: [] }); }],
  ['incomplete edge coordinates', data => { data.edges[0].points.pop(); }]
]) {
  test(`invalid ${name} rejects before replacing visible CAD`, () => {
    const { viewport } = fixture(); viewport.load(preview(), { name: 'kept.step', revision: 1 });
    viewport.select({ faces: [10] });
    const bad = preview(); mutate(bad);
    assert.throws(() => viewport.load(bad, { name: 'broken.step', revision: 2 }));
    assert.equal(viewport.getState().name, 'kept.step');
    assert.deepEqual(viewport.getState().faces, [10]);
  });
}

test('CAD loads as visible surfaces and topology edges without finite element data', () => {
  const { viewport, scene, events } = fixture();
  const state = viewport.load(preview(), { name: 'plate.step', cadId: 'session-1', revision: 3 });
  assert.equal(scene.children.length, 1);
  assert.equal(scene.children[0].children.filter(object => object.isMesh).length, 1);
  assert.equal(scene.children[0].children.filter(object => object.isLineSegments).length, 1);
  assert.deepEqual(state.counts, { faces: 2, edges: 2, triangles: 4, segments: 5 });
  assert.deepEqual(plain(state.bounds), { min: [-1,-1,-1], max: [1,1,0] });
  assert.equal(events.at(-1).revision, 3);
});

test('face picking resolves the nearest CAD face tag and highlights its triangles', () => {
  const { viewport, scene, events } = fixture(); viewport.load(preview()); viewport.setMode('face');
  const surface = scene.children[0].children.find(object => object.isMesh);
  const before = surface.geometry.getAttribute('color').getX(0);
  const hit = viewport.pickAt(200,200);
  assert.equal(hit.kind, 'face'); assert.equal(hit.id, 10);
  assert.deepEqual(viewport.getState().faces, [10]);
  assert.notEqual(surface.geometry.getAttribute('color').getX(0), before);
  assert.deepEqual(events.at(-1).faces, [10]);
  viewport.pickAt(200,200,{ additive: true });
  assert.deepEqual(viewport.getState().faces, []);
});

test('edge picking uses topology tags and excludes edges behind front surfaces', () => {
  const { viewport } = fixture(); viewport.load(preview()); viewport.setMode('edge');
  const hit = viewport.pickAt(300,200);
  assert.equal(hit.id, 101); assert.equal(hit.kind, 'edge');
  assert.deepEqual(viewport.getState().edges, [101]);
  assert.equal(viewport.hitAt(200,200,'edge'), null, 'back edge is occluded by the front CAD face');
});

test('CAD visibility controls picking and fitting bounds without deleting geometry', () => {
  const { viewport, scene } = fixture(); viewport.load(preview()); viewport.setMode('face');
  viewport.setVisible(false);
  assert.equal(viewport.isPicking(), false); assert.equal(viewport.getBounds(), null);
  assert.equal(viewport.hitAt(200,200,'face'), null);
  assert.equal(scene.children.length, 1);
  viewport.setVisible(true); assert.equal(viewport.isPicking(), true); assert.ok(viewport.getBounds());
});

test('new CAD revisions clear selection and dispose only the replaced CAD group', () => {
  const { viewport, scene } = fixture(); viewport.load(preview()); viewport.select({ faces: [10], edges: [101] });
  const old = scene.children[0], surface = old.children.find(object => object.isMesh);
  let disposed = 0; surface.geometry.addEventListener('dispose', () => disposed++);
  const unrelatedMeshGroup = new THREE.Group(); scene.add(unrelatedMeshGroup);
  viewport.load(preview(), { revision: 2 });
  assert.equal(disposed, 1); assert.equal(old.parent, null);
  assert.ok(scene.children.includes(unrelatedMeshGroup));
  assert.deepEqual(viewport.getState().faces, []); assert.deepEqual(viewport.getState().edges, []);
  viewport.clear(); assert.equal(scene.children.length, 1); assert.equal(scene.children[0], unrelatedMeshGroup);
});

test('split plane guide is visible geometry but never expands source fitting bounds', () => {
  const { viewport, scene } = fixture(); viewport.load(preview());
  const original = plain(viewport.getState().bounds);
  viewport.setSplitPlane({ axis: 'x', position: 100 });
  assert.equal(scene.children[0].children.find(object => object.name === 'CAD split plane guide').children.length, 2);
  assert.deepEqual(plain(viewport.getState().bounds), original);
  assert.deepEqual(Array.from(viewport.getBounds().max.toArray()), [1,1,0]);
  viewport.setSplitPlane(null);
  assert.equal(scene.children[0].children.some(object => object.name === 'CAD split plane guide'), false);
  assert.throws(() => viewport.setSplitPlane({ axis: 'bad', position: 0 }), /Split plane/);
});


test('comparison outlines opt into fitting and discard restores ordinary CAD bounds',()=>{
 const {viewport}=fixture();viewport.load(preview());const original=viewport.getBounds().clone();
 viewport.setOverlay('old-source',{type:'lines',positions:[0,0,0,9,8,7],includeInFit:true});assert.deepEqual(Array.from(viewport.getBounds().max.toArray()),[9,8,7]);
 viewport.clearOverlay('old-source');assert.deepEqual(Array.from(viewport.getBounds().max.toArray()),Array.from(original.max.toArray()));
 viewport.setOverlay('tool-ray',{type:'lines',positions:[0,0,0,99,88,77]});assert.deepEqual(Array.from(viewport.getBounds().max.toArray()),Array.from(original.max.toArray()));
});
