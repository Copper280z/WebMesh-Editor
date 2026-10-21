// End-to-end shell meshing against the real CAD service: pick one face of a
// sheet, grow it to the whole side, find the opposite side, mesh the midsurface.
// Skipped when the Gmsh/OpenCASCADE kernel or the quadmesh library is missing.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { kernelAvailable, startServer, CadSession, F } = require('./helpers/cad-client.cjs');

const quadmesh = spawnSync(process.env.PYTHON || 'python3', ['-c', 'import quadmesh_bridge, sys; sys.exit(0 if quadmesh_bridge.status()["available"] else 1)'], { cwd: path.join(__dirname, '..') }).status === 0;
const available = kernelAvailable() && quadmesh;
let server;
before(async () => { if (available) server = await startServer(); });
after(() => server?.stop());
const cad = { skip: available ? false : 'Gmsh/OpenCASCADE kernel or quadmesh is not available', timeout: 300000 };

async function midsurface(file, size) {
  const s = await new CadSession(server.base).import(file);
  const seed = s.topology.faces.slice().sort((a, b) => b.area - a.area)[0].id;
  const sideA = F.tangentSide(s.topology, [seed]);
  const sideB = F.oppositeSide(s.topology, sideA);
  assert.deepEqual(sideB.missing, [], 'every face of side A has an opposite face');
  const result = await s.api('shell', { ...s.token, size, faceIds: sideA, placement: 'midsurface', facesB: sideB.faces });
  return { s, sideA, sideB: sideB.faces, result, quality: result.quality };
}

test('a bent bracket with holes meshes at its midsurface from one picked face', cad, async () => {
  const { sideA, sideB, quality } = await midsurface('examples/shells/bent_bracket_holes.step', 3);
  assert.equal(sideA.length, 5, 'base, two bends and two flanges');
  assert.equal(sideB.length, 5);
  assert.ok(Math.abs(quality.placement.minThickness - 3) < 1e-6 && Math.abs(quality.placement.maxThickness - 3) < 1e-6, 'a 3 mm sheet');
  assert.equal(quality.nonManifoldEdges, 0);
  assert.ok(quality.minScaledJacobian > 0.5, `min scaled Jacobian ${quality.minScaledJacobian}`);
});

test('square and round tubes with holes mesh at their midsurface', cad, async () => {
  for (const [file, wall] of [['examples/shells/square_tube_35x4_holes.step', 4], ['examples/shells/round_tube_75x10_holes.step', 10]]) {
    const { quality } = await midsurface(file, 3);
    assert.ok(Math.abs(quality.placement.thickness - wall) < 1e-6, `${file}: wall ${quality.placement.thickness}`);
    assert.equal(quality.nonManifoldEdges, 0, file);
    assert.ok(quality.minScaledJacobian > 0.3, `${file}: min scaled Jacobian ${quality.minScaledJacobian}`);
  }
});

test('picked holes in a bent sheet get pads at the midsurface through the service', cad, async () => {
  const s = await new CadSession(server.base).import('examples/shells/bent_bracket_holes.step');
  const seed = s.topology.faces.slice().sort((a, b) => b.area - a.area)[0].id;
  const sideA = F.tangentSide(s.topology, [seed]), sideB = F.oppositeSide(s.topology, sideA).faces;
  const holes = s.features('hole');
  assert.equal(holes.length, 4);
  const result = await s.api('shell', { ...s.token, size: 3, mesher: 'paved', faceIds: sideA, placement: 'midsurface', facesB: sideB, pads: holes.map(h => ({ faces: h.faces })) });
  const { pads, minScaledJacobian, nonManifoldEdges } = result.quality;
  assert.equal(pads.length, 4, 'each hole is in one face of side A');
  assert.ok(pads.every(p => p.minScaledJacobian > 0.69), JSON.stringify(pads));
  assert.equal(nonManifoldEdges, 0);
  assert.ok(minScaledJacobian > 0.55, `min scaled Jacobian ${minScaledJacobian}`);
  await assert.rejects(s.api('shell', { ...s.token, size: 3, mesher: 'quadtree', pads: [{ faces: holes[0].faces }] }), /Recombined or Paved/);
});
