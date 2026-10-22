import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createMesher } from "../../bindings/javascript/quadmesh.mjs";

const { default: createModule } = await import(pathToFileURL(resolve(process.argv[2])));
const module = await createModule();
const mesh = createMesher(module);
const points = [[0, 0], [10, 0], [10, 10], [0, 10]];
const input = { loops: [{ points, fixedRuns: [{ nodes: points, closed: true }] }],
  options: { targetSize: 3, enableSmoothing: true } };
const first = mesh(input);
assert.equal(first.valid, true, first.issues.join("\n"));
assert.equal(first.boundaryNodes.length, 4);
for (const source of first.boundaryNodes) {
  assert.deepEqual(Array.from(first.nodes.slice(source.node * 2, source.node * 2 + 2)), points[source.fixedNode]);
}
const saved = first.nodes.slice();
const extraMemory = module._malloc(module.HEAPU8.byteLength + 65536);
assert.ok(extraMemory);
module._free(extraMemory);
for (let i = 0; i < 3; ++i) assert.deepEqual(mesh(input), first);
assert.deepEqual(first.nodes, saved);
const odd = Array.from({ length: 9 }, (_, k) => [Math.cos(k * 2 * Math.PI / 9), Math.sin(k * 2 * Math.PI / 9)]);
assert.throws(() => mesh({ loops: [{ points: odd, fixedRuns: [{ nodes: odd, closed: true }] }] }), /odd boundary/);
assert.throws(() => mesh({ loops: [{ points }], options: { elementsPerCircle: 7 } }), /out of range/);
assert.throws(() => mesh({ loops: [{ points: [[0], [1, 1], [0, 1]] }] }), /numeric pairs/);
assert.throws(() => mesh({ loops: [{ points }], options: { toString: 1 } }), /Unknown meshing option/);
assert.deepEqual(mesh(input), first);
for (const name of ["wheel_top", "rover_chassis_face1", "rover_chassis_face2", "rover_chassis_face61",
                    "balancer_chassis_face17", "balancer_chassis_face19", "balancer_chassis_face21"]) {
  const text = readFileSync(new URL(`../fixtures/cad_faces/${name}.txt`, import.meta.url), "utf8");
  const values = text.trim().split(/\s+/).map(Number);
  let at = 0;
  const loopCount = values[at++];
  const loops = Array.from({ length: loopCount }, (_, index) => {
    const count = values[at++];
    const points = Array.from({ length: count }, () => [values[at++], values[at++]]);
    return { points, role: index === 0 ? "outer" : "hole" };
  });
  const result = mesh({ loops, options: { targetSize: 4, finiteElementSizing: true, enableSmoothing: true } });
  assert.equal(result.valid, true, `${name}: ${result.issues.join("\n")}`);
  assert.ok(result.summary.minAngle >= 20, name);
  assert.ok(result.summary.minScaledJacobian >= .3, name);
  if (name === "rover_chassis_face1") assert.ok(result.quads.length / 4 <= 4270, name);
}
console.log("JavaScript binding: fixed nodes, provenance, quality, determinism, ownership, and errors passed");
console.log("WebAssembly: all seven CAD faces pass validity and quality checks");
