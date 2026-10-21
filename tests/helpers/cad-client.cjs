// Headless client for the local CAD service, using the browser's own modules.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const H = require('../../app/hex-mapping.js');
const F = require('../../app/cad-features.js');
const M = require('../../app/modeling.js');

const ROOT = path.join(__dirname, '..', '..');
const PYTHON = process.env.PYTHON || 'python3';

function kernelAvailable() {
  const probe = spawnSync(PYTHON, ['-c', 'import sys; sys.path.insert(0, "."); import cad_kernel; cad_kernel.geometry_module()'], { cwd: ROOT, encoding: 'utf8' });
  return probe.status === 0;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on('error', reject);
  });
}

async function startServer() {
  const port = await freePort();
  const child = spawn(PYTHON, ['server.py', '--port', String(port)], { cwd: ROOT, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return { base, stop: () => child.kill() }; } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw Error('The CAD server did not start.');
}

class CadSession {
  constructor(base) { this.base = base; this.steps = []; }
  async api(endpoint, payload) {
    const response = await fetch(`${this.base}/api/cad/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok || data.error) throw Error(data.error || `${endpoint} failed`);
    return data;
  }
  accept(data) { this.data = data; this.topology = data.topology; this.analysis = H.analyze(this.topology); this.recognized = F.recognize(this.topology); return this; }
  get token() { return { cadId: this.data.cadId, revision: this.data.revision }; }
  async import(file) {
    const content = fs.readFileSync(path.join(ROOT, file)).toString('base64');
    const format = path.extname(file).slice(1).toLowerCase().replace('stp', 'step');
    return this.accept(await this.api('import', { filename: path.basename(file), format, content }));
  }
  async apply(operation) { this.accept(await this.api('prepare', { ...this.token, operation })); this.steps.push(operation.label || operation.kind); return this; }
  async autoFix(options) {
    return F.autoFix({
      state: () => ({ topology: this.topology, preview: this.data.preview, revision: this.data.revision }),
      preview: (operation, { lite } = {}) => this.api('preview', { ...this.token, operation, ...(lite ? { lite: true } : {}) }),
      apply: operation => this.apply(operation),
      undo: async () => { this.accept(await this.api('undo', this.token)); }
    }, { mapping: H, ...options });
  }
  features(kind) { return this.recognized.features.filter(f => f.kind === kind); }
  /** The largest planar face with normal ±n whose center passes `test`. */
  planarFace(n, test = () => true) {
    const u = n.map(v => v / Math.hypot(...n));
    const list = this.topology.faces.filter(f => f.surface?.kind === 'plane' && Math.abs(Math.abs(f.surface.normal.reduce((s, v, i) => s + v * u[i], 0)) - 1) < 1e-4 && test(f.center));
    if (!list.length) throw Error(`No planar face with normal ${n}.`);
    return list.sort((a, b) => b.area - a.area)[0];
  }
  vertexNear(point) {
    const [best] = this.topology.vertices.map(v => [Math.hypot(...v.point.map((x, i) => x - point[i])), v.id]).sort((a, b) => a[0] - b[0]);
    if (best[0] > 0.5) throw Error(`No vertex near ${point}.`);
    return best[1];
  }
  /** The operation of the first fix (by key prefix) offered for a solid, as the context card lists it. */
  fix(volumeId, prefix) {
    const list = F.fixes(this.recognized.ctx, this.recognized, this.analysis.volumes.get(Number(volumeId)));
    const action = list.find(a => a.key.startsWith(prefix));
    if (!action) throw Error(`Solid ${volumeId} offers no ${prefix} fix (${list.map(a => a.key).join(', ')}).`);
    return action.operation;
  }
  /** Apply a kind of fix to blocked solids until none offers it. */
  async applyEach(prefix) {
    for (let guard = 0; guard < 40; guard++) {
      const solid = [...this.analysis.volumes.values()].find(v => !v.mappable && F.fixes(this.recognized.ctx, this.recognized, v).some(a => a.key.startsWith(prefix)));
      if (!solid) return this;
      await this.apply(this.fix(solid.id, prefix));
    }
    throw Error(`${prefix} fixes did not converge.`);
  }
  mesh(size, order = 1) {
    const intervals = H.solveIntervals(this.analysis, { size });
    const mesh = H.generateMesh(this.analysis, intervals, H.createGeometry(this.topology, this.data.preview), { order });
    return { mesh, intervals, report: M.validateMesh(mesh) };
  }
}

module.exports = { kernelAvailable, startServer, CadSession, H, F };
