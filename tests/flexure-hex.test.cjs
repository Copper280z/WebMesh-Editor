const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { test } = require('node:test');
const H = require('../app/hex-mapping.js');
const F = require('../app/cad-features.js');
const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/flexure-hex/prepared.json.gz'))));

// Exact preparation checkpoint supplied with the defect: 121 solids, formerly
// 99 mappable. Keep the geometry unchanged when evaluating the classifier.
test('four-sided tangent fillets map without admitting five-sided or straight knife-edge blocks', () => {
  const a = H.analyze(data.topology);
  assert.deepEqual(a.summary, { volumes: 121, mappable: 111, blocked: 10 });
  const tangent = [...a.volumes.values()].filter(v => v.warnings?.some(w => w.code === 'curved-tangency'));
  assert.equal(tangent.length, 12);
  assert.ok(tangent.some(v => v.id === 19));
  assert.equal(a.volumes.get(49).mappable, false, 'five-sided cap still needs preparation');
  assert.equal(a.volumes.get(88).mappable, false, 'closed bore still needs a split');
  for (const order of [1, 2]) {
    const mesh = H.generateMesh(a, H.solveIntervals(a, { size: 1 }), H.createGeometry(data.topology, data.preview), { order });
    assert.equal(mesh.quality.inverted, 0);
    assert.ok(mesh.quality.minScaledJacobian > (order === 1 ? 0.4 : 0.09));
    assert.equal(mesh.quality.perVolume.length, 111);
  }
});

test('curve divisions change the finite HEX8 corner angle at an exact CAD tangency', () => {
  const a = H.analyze(data.topology), geometry = H.createGeometry(data.topology, data.preview);
  const qualities = [0.5, 0.125].map(size => H.generateMesh(a, H.solveIntervals(a, { size, volumes: [19] }), geometry).quality);
  assert.ok(qualities.every(q => q.inverted === 0 && q.minScaledJacobian > 0));
  assert.ok(qualities[1].elements > qualities[0].elements);
  assert.ok(qualities[1].minScaledJacobian < qualities[0].minScaledJacobian);
});

test('HEX20 quality detects a folded midside mapping despite a perfect corner box', () => {
  const corners = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const points = [...corners, ...H.constants.HEX20_EDGES.map(([a,b]) => corners[a].map((x,k) => (x + corners[b][k]) / 2))];
  assert.ok(Math.abs(H.hexQuality(points).scaledJacobian - 1) < 1e-12);
  points[8] = [0.5, 1.2, 0];
  assert.equal(H.hexQuality(points.slice(0,8)).scaledJacobian, 1);
  assert.ok(H.hexQuality(points).scaledJacobian < 0);
  const moved = points.map(p => p.map((x,k) => x + [1000,-2000,3000][k]));
  assert.ok(Math.abs(H.hexQuality(moved).scaledJacobian - H.hexQuality(points).scaledJacobian) < 1e-10);
});

test('a picked blind-bore segment offers corner splitting scoped to its surrounding block', () => {
  const a = H.analyze(data.topology), r = F.recognize(data.topology);
  for (const [face, solid] of [[23,4],[35,6],[447,87],[453,88]]) {
    assert.equal(r.byFace.get(face).through, false);
    const info = F.infer(data.topology, r, a, { kind: 'face', ids: [face] });
    const split = info.actions.find(x => x.key === 'split-hole');
    assert.ok(split);
    assert.deepEqual(split.operation.volumeIds, [solid]);
    assert.equal(split.operation.rays.length, 4);
    assert.match(split.detail, /blind-end cap/);
    assert.equal(info.actions.some(x => x.key === 'passage'), false, 'do not silently turn a blind bore into a passage');
    const box = r.ctx.volumes.get(solid).bounds;
    for (const ray of split.operation.rays) {
      const end = ray.origin.map((x,k) => x + ray.length * ray.direction[k]);
      for (const axis of [0,1]) assert.ok(Math.min(Math.abs(end[axis]-box[axis]),Math.abs(end[axis]-box[axis+3])) < 0.001);
    }
    const suggested = F.fixes(r.ctx, r, a.volumes.get(solid)).find(x => x.key.startsWith('split-hole:'));
    assert.deepEqual(suggested.operation, split.operation);
    assert.equal(info.actions.find(x => x.key === 'remove-feature').faces.length, 3, 'removal still addresses the complete feature');
  }
  assert.equal(F.infer(data.topology, r, a, {kind:'face', ids:[42]}).actions.some(x => x.key === 'split-hole'), false, 'the separate cap is not a through segment');
});
