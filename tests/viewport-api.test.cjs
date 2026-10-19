const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.join(__dirname, '..');
const vendor = vm.createContext({ window: {}, console, performance });
vm.runInContext(fs.readFileSync(path.join(root, 'vendor', 'three-runtime.js'), 'utf8'), vendor);
const three = vendor.window.WebMeshThree;
const source = fs.readFileSync(path.join(root, 'app', 'editor-engine.js'), 'utf8');
const start = source.indexOf('  function workbenchSetView(');
const functions = source.slice(start, source.indexOf('  function extractDeckAssignmentInteger(', start));

function fixture(orthographic = true, aspect = 1.5) {
  const { Vector3, Box3, PerspectiveCamera, OrthographicCamera } = three;
  const perspectiveCamera = new PerspectiveCamera(45, aspect, 0.01, 100000);
  const orthographicCamera = new OrthographicCamera(-5, 5, 5, -5, 0.01, 100000);
  const context = vm.createContext({
    Vector3, Box3, perspectiveCamera, orthographicCamera,
    camera: orthographic ? orthographicCamera : perspectiveCamera,
    model: { bbox: new Box3(new Vector3(-7, -2, 3), new Vector3(9, 4, 10)) },
    workbenchPreview: null, controls: { target: new Vector3(), update() {} },
    canvas: { clientWidth: 600 * aspect, clientHeight: 600 },
    recreateOrbitControls() {}, updateCameraClipping() {}, emitWorkbenchChange() {},
    bgColorPicker: { value: '#000000' }, filledEdgeColor: { value: '#111111' }, freeEdgeColor: { value: '#ffff00' },
    solidBackgroundHex: '#000000', skyboxEnabled: true, skyboxToggle: {},
    setToggleBtn() {}, applySolidBackground() {}, buildGeometries() {},
    getFilledEdgeColorValue() { return context.filledEdgeColor.value; },
    getFreeEdgeColorValue() { return context.freeEdgeColor.value; }
  });
  vm.runInContext(functions, context);
  return context;
}

for (const [view, position, up] of [
  ['front', [0, -1, 0], [0, 0, 1]], ['back', [0, 1, 0], [0, 0, 1]],
  ['right', [1, 0, 0], [0, 0, 1]], ['left', [-1, 0, 0], [0, 0, 1]],
  ['top', [0, 0, 1], [0, 1, 0]], ['bottom', [0, 0, -1], [0, -1, 0]],
  ['iso', [1, -1, 1], [0, 0, 1]]
]) {
  test(`${view} sets the engineering orientation in both projections`, () => {
    const c = fixture();
    assert.equal(c.workbenchSetView(view).direction, view);
    const target = c.model.bbox.getCenter(new three.Vector3());
    assert.ok(c.controls.target.distanceTo(target) < 1e-10);
    for (const cam of [c.orthographicCamera, c.perspectiveCamera]) {
      const outward = cam.position.clone().sub(target).normalize();
      assert.ok(outward.distanceTo(new three.Vector3(...position).normalize()) < 1e-10);
      assert.ok(cam.getWorldDirection(new three.Vector3()).dot(outward) < -0.999999);
      assert.deepEqual(Array.from(cam.up.toArray()), up);
    }
    assert.equal(c.camera, c.orthographicCamera, 'view buttons must preserve projection');
  });
}

for (const orthographic of [true, false]) {
  test(`${orthographic ? 'orthographic' : 'perspective'} view framing contains every bounding corner in a narrow viewport`, () => {
    const c = fixture(orthographic, 0.3);
    c.workbenchSetView('iso');
    const box = c.model.bbox;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = new three.Vector3(x, y, z).project(c.camera);
      assert.ok(Math.abs(p.x) < 0.85 && Math.abs(p.y) < 0.85, `corner projects inside viewport: ${p.toArray()}`);
    }
  });
}

test('unknown views reject before moving the camera', () => {
  const c = fixture(), original = c.camera.position.toArray();
  assert.throws(() => c.workbenchSetView('diagonal'), /Unknown view/);
  assert.deepEqual(c.camera.position.toArray(), original);
});

test('theme updates background and edge controls while disabling the skybox', () => {
  const c = fixture();
  const theme = c.workbenchSetTheme({ background: '#e7ebf0', edges: '#637080', freeEdges: '#e8c600' });
  assert.deepEqual(JSON.parse(JSON.stringify(theme)), { background: '#e7ebf0', edges: '#637080', freeEdges: '#e8c600' });
  assert.equal(c.bgColorPicker.value, '#e7ebf0');
  assert.equal(c.skyboxEnabled, false);
});

test('invalid theme colors reject before changing display state', () => {
  const c = fixture();
  assert.throws(() => c.workbenchSetTheme({ background: '#eeeeee', edges: 'blue' }), /six-digit hex/);
  assert.equal(c.bgColorPicker.value, '#000000');
  assert.equal(c.skyboxEnabled, true);
});
