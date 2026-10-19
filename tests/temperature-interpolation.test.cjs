const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise the pure numerical helpers shipped inside the standalone editor.
const html = fs.readFileSync(path.join(__dirname, '..', 'WebMeshEditor.html'), 'utf8');
function sourceFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must be embedded in the editor`);
  const body = html.indexOf('{', start);
  let depth = 1, end = body + 1;
  for (; depth && end < html.length; end++) {
    if (html[end] === '{') depth++;
    else if (html[end] === '}') depth--;
  }
  assert.equal(depth, 0, `${name} must have a complete function body`);
  return html.slice(start, end);
}
const names = ['buildTemperatureGradientField', 'temperatureTriangleControls',
  'evaluateTemperatureTriangle', 'nearestTemperatureTriangle'];
const context = vm.createContext({});
vm.runInContext(names.map(sourceFunction).join('\n'), context);
const gradients = vm.runInContext('buildTemperatureGradientField', context);
const controls = vm.runInContext('temperatureTriangleControls', context);
const evaluate = vm.runInContext('evaluateTemperatureTriangle', context);
const nearest = vm.runInContext('nearestTemperatureTriangle', context);
const close = (actual, expected, message = '') => assert.ok(
  Math.abs(actual - expected) < 1e-9 * Math.max(1, Math.abs(expected)),
  `${message}: expected ${expected}, received ${actual}`);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);

for (const [name, positions, triangles, segments] of [
  ['flat shell', [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], [0, 1, 2, 1, 3, 2]],
  ['rotated shell', [0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 2, 1], [0, 1, 2, 1, 3, 2]],
  ['solid surface', [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]],
  ['line elements', [0, 0, 0, 2, 1, 3, 4, 2, 6], [], [0, 1, 1, 2]],
  ['very small mesh', [0, 0, 0, 1e-8, 0, 0, 0, 1e-8, 0], [0, 1, 2]],
]) {
  test(`cubic preserves an affine temperature field on a ${name}`, () => {
    const direction = [2, -3, 5];
    const values = Array.from({ length: positions.length / 3 }, (_, i) => 7 + dot(positions.slice(3 * i, 3 * i + 3), direction));
    const field = gradients(positions, values, triangles, segments);
    for (let i = 0; i + 2 < triangles.length; i += 3) {
      const indices = triangles.slice(i, i + 3);
      const points = indices.map(index => positions.slice(3 * index, 3 * index + 3));
      const triangleValues = indices.map(index => values[index]);
      const triangleGradients = indices.flatMap(index => Array.from(field.slice(3 * index, 3 * index + 3)));
      const patch = controls(...points, triangleValues, triangleGradients);
      for (const bary of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1 / 3, 1 / 3, 1 / 3], [0.2, 0.3, 0.5]]) {
        close(evaluate(bary, patch), dot(bary, triangleValues));
      }
    }
    if (segments) {
      for (let i = 0; i < segments.length; i += 2) {
        const a = segments[i], b = segments[i + 1];
        const edge = positions.slice(3 * b, 3 * b + 3).map((value, k) => value - positions[3 * a + k]);
        close(dot(Array.from(field.slice(3 * a, 3 * a + 3)), edge), values[b] - values[a]);
      }
    }
  });
}

test('cubic is a polynomial interpolation that reproduces quadratic data with exact derivatives', () => {
  const p0 = [0, 0, 0], p1 = [2, 0, 0], p2 = [0, 3, 0];
  const fn = ([x, y]) => x * x + 2 * x * y - y * y + 4;
  const derivative = ([x, y]) => [2 * x + 2 * y, 2 * x - 2 * y, 0];
  const values = [p0, p1, p2].map(fn);
  const patch = controls(p0, p1, p2, values, [p0, p1, p2].flatMap(derivative));
  for (const bary of [[0.2, 0.3, 0.5], [1 / 3, 1 / 3, 1 / 3], [0.1, 0.8, 0.1]]) {
    const point = [0, 1, 2].map(k => bary[0] * p0[k] + bary[1] * p1[k] + bary[2] * p2[k]);
    close(evaluate(bary, patch), fn(point));
  }
  assert.ok(Math.abs(evaluate([0.2, 0.3, 0.5], patch) - dot([0.2, 0.3, 0.5], values)) > 0.1);
});

test('cubic reproduces a true cubic along a Hermite edge', () => {
  const patch = controls([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 1, 0], [0, 0, 0, 3, 0, 0, 0, 0, 0]);
  for (const t of [0, 0.1, 0.3, 0.7, 1]) close(evaluate([1 - t, t, 0], patch), t ** 3);
});

test('adjacent cubic patches agree along their common edge, including reversed winding', () => {
  const p0 = [0, 0, 0], p1 = [2, 0, 1];
  const g0 = [2, 0.5, -1], g1 = [-1, 3, 4];
  const first = controls(p0, p1, [0, 2, 0], [10, 30, 5], [...g0, ...g1, 4, -2, 1]);
  const second = controls(p1, p0, [1, -3, 4], [30, 10, 50], [...g1, ...g0, -3, 5, 2]);
  for (const t of [0, 0.01, 0.2, 0.5, 0.9, 1]) {
    close(evaluate([1 - t, t, 0], first), evaluate([t, 1 - t, 0], second));
  }
});

test('nearest neighbor compares physical distance on a skew 3D triangle', () => {
  const points = [0, 0, 0, 10, 0, 0, 9, 1, 1];
  // Largest barycentric weight belongs to vertex 0. Vertex 2 is nearer.
  assert.equal(nearest([5.7, 0.3, 0.3], points, [10, 20, 30]), 30);
  assert.equal(nearest([9, 0.01, 0.01], points, [10, 20, 30]), 20);
  assert.equal(nearest([0, 0, 0], points, [10, 20, 30]), 10);
});

test('missing data and coincident nodes produce no invented finite temperatures or unstable gradients', () => {
  const field = gradients([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0], [20, 20, NaN, 30], [0, 1, 2, 0, 2, 3]);
  assert.ok(Array.from(field.slice(6, 9)).every(Number.isNaN));
  assert.ok(Array.from(field.slice(0, 6)).every(Number.isFinite));
  close(field[1], 10);
  const patch = controls([0, 0, 0], [1, 0, 0], [0, 1, 0], [20, NaN, 30], [0, 10, 0, NaN, NaN, NaN, 0, 10, 0]);
  assert.ok(Number.isNaN(evaluate([0.2, 0.3, 0.5], patch)));
});
