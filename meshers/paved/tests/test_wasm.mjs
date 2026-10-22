// node tests/test_wasm.mjs path/to/quadmesh_paved.wasm
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadModule, createMesher } from "../bindings/javascript/quadmesh_paved.mjs";

const assert = (cond, msg) => { if (!cond) { throw new Error(msg); } };

const circle = (cx, cy, r, n, ccw = true) =>
  Array.from({ length: n }, (_, i) => {
    const a = (ccw ? 1 : -1) * 2 * Math.PI * i / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });

function rectNodes(w, h, step) {
  const nx = Math.round(w / step), ny = Math.round(h / step), pts = [];
  for (let i = 0; i < nx; i++) pts.push([w * i / nx, 0]);
  for (let i = 0; i < ny; i++) pts.push([w, h * i / ny]);
  for (let i = 0; i < nx; i++) pts.push([w - w * i / nx, h]);
  for (let i = 0; i < ny; i++) pts.push([0, h - h * i / ny]);
  return pts;
}

const outerNodes = rectNodes(40, 20, 2);
const holeNodes = circle(20, 10, 5, 16, false);
const loops = [
  { points: [[0, 0], [40, 0], [40, 20], [0, 20]], fixedRuns: [{ nodes: outerNodes, closed: true }] },
  { points: circle(20, 10, 5, 128, false), role: "hole", fixedRuns: [{ nodes: holeNodes, closed: true }] },
];
const fixed = [...outerNodes, ...holeNodes];

function checkPlate(out) {
  assert(out.valid, `invalid mesh: ${out.issues.join("; ")}`);
  assert(out.summary.minScaledJacobian >= 0.3, `min SJ ${out.summary.minScaledJacobian}`);
  assert(out.boundaryNodes.length === 76, `boundary nodes ${out.boundaryNodes.length}`);
  for (let i = 0; i < 76; i++) {
    assert(out.nodes[2 * i] === fixed[i][0] && out.nodes[2 * i + 1] === fixed[i][1], `fixed node ${i} moved`);
  }
}

const module = await loadModule(readFileSync(process.argv[2]));
const mesh = createMesher(module);
const out = mesh({ loops, options: { targetSize: 2 } });
checkPlate(out);
assert(out.report.allQuads && out.report.conforming && out.report.fixedKept, "paved report");
console.log(`plate with hole: ${out.quads.length / 4} quads, min SJ ${out.summary.minScaledJacobian.toFixed(3)}, ` +
  `irregular ${(100 * out.report.irregularShare).toFixed(1)}%`);

let threw = false;
try {
  mesh({ loops: [{ points: [[0, 0], [10, 0], [10, 10], [0, 10]],
    fixedRuns: [{ nodes: [[0, 0], [10, 0], [10, 10], [5, 10], [0, 10]], closed: true }] }], options: { targetSize: 2 } });
} catch (e) {
  threw = e.status === 2 && /odd number of fixed boundary edges/.test(e.message);
}
assert(threw, "odd boundary not rejected");

// Repeated calls do not leak handles or break memory growth.
for (let i = 0; i < 3; i++) checkPlate(mesh({ loops, options: { targetSize: 2 } }));

// The quadtree mesher's own JavaScript wrapper works unchanged with this module.
const other = join(homedir(), "Documents/quadmesh/cpp2/bindings/javascript/quadmesh.mjs");
if (existsSync(other)) {
  const { createMesher: quadtreeMesher } = await import(pathToFileURL(other).href);
  checkPlate(quadtreeMesher(module)({ loops, options: { targetSize: 2 } }));
  console.log("quadtree mesher's JavaScript wrapper: OK with quadmesh_paved.wasm");
}
// Cross-platform determinism: the wasm mesh is bit-identical to the native CLI's.
if (process.argv[3]) {
  const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const facePath = join(repo, "faces", "rover_chassis_face61.txt");
  const tok = readFileSync(facePath, "utf8").trim().split(/\s+/).map(Number);
  let i = 1;
  const faceLoops = [];
  for (let l = 0; l < tok[0]; l++) {
    const n = tok[i++];
    const pts = [];
    for (let k = 0; k < n; k++) { pts.push([tok[i], tok[i + 1]]); i += 2; }
    faceLoops.push({ points: pts, role: l === 0 ? "outer" : "hole" });
  }
  const res = mesh({ loops: faceLoops, options: { targetSize: 4 } });
  let h = 0xcbf29ce484222325n;
  const mix = bytes => { for (const b of bytes) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; } };
  mix(new Uint8Array(res.nodes.buffer, res.nodes.byteOffset, res.nodes.byteLength));
  mix(new Uint8Array(res.quads.buffer, res.quads.byteOffset, res.quads.byteLength));
  const wasmHash = h.toString(16).padStart(16, "0");
  const native = execFileSync(process.argv[3], [facePath, "4", "--hash"], { encoding: "utf8" });
  const nativeHash = /hash: ([0-9a-f]+)/.exec(native)[1];
  assert(wasmHash === nativeHash, `wasm ${wasmHash} != native ${nativeHash}`);
  console.log(`rover_chassis_face61: wasm and native meshes are bit-identical (hash ${wasmHash})`);
}
// Open curves (ABI 0.3) through the wasm module: a wall from the floor's edge to its middle.
{
  const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const face = JSON.parse(readFileSync(join(repo, "faces", "curves", "tee.json"), "utf8"));
  const curveLoops = face.loops.map(l => l.role === "curve"
    ? { role: "curve", points: l.points, fixedRuns: [{ nodes: l.points, start: [0, 0], end: [l.points.length - 2, 1] }] }
    : { role: l.role, points: l.points, fixedRuns: [{ nodes: l.points, closed: true }] });
  const out = mesh({ loops: curveLoops, options: { targetSize: face.target_size } });
  assert(out.valid, `tee: ${out.issues.join("; ")}`);
  assert(module._mq_abi_version() >= (3 << 12), "ABI 0.3 expected");
  const idx = new Map();
  for (let v = 0; v < out.nodes.length / 2; v++) idx.set(`${out.nodes[2 * v]},${out.nodes[2 * v + 1]}`, v);
  const use = new Map();
  for (let q = 0; q < out.quads.length / 4; q++) for (let k = 0; k < 4; k++) {
    const a = out.quads[4 * q + k], b = out.quads[4 * q + (k + 1) % 4];
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    use.set(key, (use.get(key) ?? 0) + 1);
  }
  const curve = face.loops.find(l => l.role === "curve").points;
  for (let k = 0; k + 1 < curve.length; k++) {
    const a = idx.get(`${curve[k][0]},${curve[k][1]}`), b = idx.get(`${curve[k + 1][0]},${curve[k + 1][1]}`);
    assert(a !== undefined && b !== undefined, "curve node not kept");
    assert(use.get(a < b ? `${a},${b}` : `${b},${a}`) === 2, "curve segment not shared by two quads");
  }
  console.log(`tee (open curve) through wasm: ${out.quads.length / 4} quads, valid`);
}
console.log("wasm tests passed");
