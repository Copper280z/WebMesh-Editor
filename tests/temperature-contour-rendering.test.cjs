const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise the decorator shipped in the editor without a browser or THREE.
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
const helperSource = [
  'buildTemperatureGradientField', 'temperatureTriangleControls', 'evaluateTemperatureTriangle',
  'isTemperatureContourField', 'getSelectedTemperatureSet', 'getTemperatureNodeValues',
  'getTemperatureLoadValue', 'applyTemperatureContourMaterials'
].map(sourceFunction).join('\n');

class Attribute {
  constructor(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.count = array.length / itemSize;
  }
  getX(index) { return this.array[index * this.itemSize]; }
  getY(index) { return this.array[index * this.itemSize + 1]; }
  getZ(index) { return this.array[index * this.itemSize + 2]; }
}
class Geometry {
  constructor(positions, index = null) {
    this.attributes = { position: new Attribute(positions, 3) };
    this.index = index ? { array: Int32Array.from(index) } : null;
    this.disposals = 0;
  }
  getAttribute(name) { return this.attributes[name]; }
  setAttribute(name, attribute) { this.attributes[name] = attribute; }
  clone() { return new Geometry(this.attributes.position.array.slice()); }
  toNonIndexed() {
    const positions = this.attributes.position.array;
    return new Geometry(Float32Array.from(Array.from(this.index.array).flatMap(index =>
      Array.from(positions.slice(index * 3, index * 3 + 3)))));
  }
  dispose() { this.disposals++; }
}
class Material {
  constructor() {
    this.color = { setHex() {} };
    this.disposals = 0;
  }
  clone() { return new Material(); }
  dispose() { this.disposals++; }
}
function mesh(positions, index = null, material = new Material()) {
  return { geometry: new Geometry(positions, index), material, userData: {} };
}
function runDecorator({ positions, temperatures, elements = [], objects,
  kind = 'meshShell', metadata = [], extra = {}, beforeApply = null }) {
  const pos = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  const model = {
    nodeIndex: new Map(temperatures.map((_, index) => [index + 1, index])),
    indexToNid: temperatures.map((_, index) => index + 1),
    elems: { elements },
    temperatures: [{ sid: 7, nodeIds: temperatures.map((_, index) => index + 1),
      values: temperatures, defaultTemperature: null }]
  };
  const context = {
    BufferAttribute: Attribute, model,
    temperatureLoadSid: 7, temperatureValueCache: null, temperatureInterpolation: 'linear',
    showContour: true, contourField: 'temperatureLoad', contourMin: 0, contourMax: 50,
    contourContinuous: true, contourLevels: 8, contourReversePalette: false,
    window: {}, meshShell: null, meshSolid: null, meshSolidChunks: [],
    meshSolidClipSlab: null, mesh1dThick: null, meshLines: null,
    faceToElem: [], solidFaceToElem: [], solidClipFaceToElem: [], thickFaceToElem: [], lineToElem: [],
    getElementNodeIds: element => element.n || [],
    scene: { traverse(fn) { objects.forEach(fn); } },
    ...extra
  };
  if (kind === 'meshSolidChunks') context.meshSolidChunks = objects;
  else context[kind] = objects[0];
  const metadataKey = {
    meshShell: 'faceToElem', meshSolid: 'solidFaceToElem', meshSolidClipSlab: 'solidClipFaceToElem',
    mesh1dThick: 'thickFaceToElem', meshLines: 'lineToElem'
  }[kind];
  if (metadataKey) context[metadataKey] = metadata;
  vm.createContext(context);
  vm.runInContext(helperSource, context);
  if (beforeApply) beforeApply(context);
  context.applyTemperatureContourMaterials(pos);
  return context;
}
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5,
  `expected ${expected}, received ${actual}`);
const quadPositions = Float32Array.from([
  0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
  .5, 0, 0, 1, .5, 0, .5, 1, 0, 0, .5, 0
]);
const quadValues = Array.from({ length: 8 }, (_, index) =>
  10 + 2 * quadPositions[index * 3] + 3 * quadPositions[index * 3 + 1]);
const quadElement = { eid: 42, type: 'CQUAD8', n: [1, 2, 3, 4, 5, 6, 7, 8] };
function decorateQuad(object, options = {}) {
  return runDecorator({ positions: quadPositions, temperatures: quadValues,
    elements: [quadElement], objects: [object], metadata: [{ eid: 42, nodes: quadElement.n }], ...options });
}
const centerTriangle = () => mesh(Float32Array.from([0, 0, 0, .5, 0, 0, .5, .5, 0]));

test('CQUAD8 generated center preserves an affine temperature field and primary grid samples', () => {
  const object = centerTriangle();
  decorateQuad(object);
  const values = object.geometry.attributes.temperatureControl0.array;
  close(values[0], 10);
  close(values[1], 11);
  close(values[2], 12.5);
});

test('cubic controls at generated shell vertices preserve the affine field inside a triangle', () => {
  const object = centerTriangle();
  const context = decorateQuad(object, { extra: { temperatureInterpolation: 'cubic' } });
  const attributes = object.geometry.attributes;
  const controls = [...attributes.temperatureControl0.array.slice(0, 4),
    ...attributes.temperatureControl1.array.slice(0, 4), ...attributes.temperatureControl2.array.slice(0, 2)];
  close(context.evaluateTemperatureTriangle([.2, .3, .5], controls), 11.55);
});

test('an unspecified primary grid remains masked while a generated center can use known owner data', () => {
  const object = centerTriangle();
  decorateQuad(object, { temperatures: [NaN, ...quadValues.slice(1)] });
  const mask = object.geometry.attributes.temperatureMask.array;
  assert.equal(mask[0], 0);
  assert.equal(mask[2], 1);
});

test('solid clipping vertices sample the affine field inside their owner element', () => {
  const positions = Float32Array.from([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1
  ]);
  const temperatures = Array.from({ length: 8 }, (_, index) =>
    10 + 2 * positions[index * 3] + 3 * positions[index * 3 + 1] + 4 * positions[index * 3 + 2]);
  const object = mesh(Float32Array.from([.25, .25, .25, .75, .25, .25, .25, .75, .25]));
  runDecorator({ positions, temperatures, elements: [{ eid: 9, n: [1, 2, 3, 4, 5, 6, 7, 8] }],
    objects: [object], kind: 'meshSolidClipSlab', metadata: [{ eid: 9 }] });
  const values = object.geometry.attributes.temperatureControl0.array;
  close(values[0], 12.25);
  close(values[1], 13.25);
  close(values[2], 13.75);
});

test('indexed solid chunks retain grid identity when independent grids coincide', () => {
  const positions = Float32Array.from([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const object = mesh(positions, [0, 2, 3]);
  object.userData.triOwnerEid = [5];
  runDecorator({ positions, temperatures: [10, 90, 12, 13], elements: [{ eid: 5, n: [1, 3, 4] }],
    objects: [object], kind: 'meshSolidChunks' });
  close(object.geometry.attributes.temperatureControl0.array[0], 10);
  assert.deepEqual(Array.from(object.userData.localToGlobalNodeIndex), [0, 2, 3]);
  assert.deepEqual(object.userData.triOwnerEid, [5]);
});

test('expanded solid chunks compose the previous grid mapping with their source index', () => {
  const positions = Float32Array.from([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const object = mesh(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), [2, 0, 1]);
  object.userData.localToGlobalNodeIndex = Int32Array.from([0, 2, 3]);
  object.userData.triOwnerEid = [5];
  runDecorator({ positions, temperatures: [10, 90, 12, 13], elements: [{ eid: 5, n: [1, 3, 4] }],
    objects: [object], kind: 'meshSolidChunks' });
  assert.deepEqual(Array.from(object.userData.localToGlobalNodeIndex), [3, 0, 2]);
});

test('replacement geometries and a shared original material are disposed once', () => {
  const material = new Material();
  const objects = [mesh(quadPositions, [0, 1, 2], material), mesh(quadPositions, [0, 2, 3], material)];
  const oldGeometries = objects.map(object => object.geometry);
  runDecorator({ positions: quadPositions, temperatures: quadValues, elements: [quadElement],
    objects, kind: 'meshSolidChunks' });
  assert.equal(material.disposals, 1);
  assert.ok(oldGeometries.every(geometry => geometry.disposals === 1));
  assert.ok(objects.every(object => object.geometry.disposals === 0 && object.material.disposals === 0));
});

test('line segments retain endpoint values and two-vertex interpolation attributes', () => {
  const object = mesh(Float32Array.from([0, 0, 0, 1, 0, 0]));
  object.isLineSegments = true;
  decorateQuad(object, { kind: 'meshLines' });
  const values = object.geometry.attributes.temperatureControl0.array;
  close(values[0], 10);
  close(values[1], 12);
  close(values[2], 12);
  assert.equal(object.geometry.attributes.temperatureBary.array.length, 6);
  assert.deepEqual(Array.from(object.geometry.attributes.temperatureBary.array), [1, 0, 0, 0, 1, 0]);
});


test('unindexed shells resolve coincident grids from their owner element', () => {
  const positions = Float32Array.from([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const object = mesh(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  runDecorator({ positions, temperatures: [10, 90, 12, 13], elements: [{ eid: 5, n: [1, 3, 4] }],
    objects: [object], metadata: [{ eid: 5, nodes: [1, 3, 4] }] });
  close(object.geometry.attributes.temperatureControl0.array[0], 10);
});

test('a large rigid element fits affine data with a linear number of connectivity edges', () => {
  const count = 1000;
  const positions = Float32Array.from(Array.from({ length: count }, (_, index) =>
    [index % 10, Math.floor(index / 10) % 10, Math.floor(index / 100)]).flat());
  const temperatures = Array.from({ length: count }, (_, index) =>
    10 + 2 * positions[3 * index] + 3 * positions[3 * index + 1] + 4 * positions[3 * index + 2]);
  const object = mesh(Float32Array.from([.25, .25, .25, .75, .25, .25, .25, .75, .25]));
  const nodes = Array.from({ length: count }, (_, index) => index + 1);
  let connectivityIndices = 0;
  runDecorator({ positions, temperatures, elements: [{ eid: 8, type: 'RBE2', n: nodes }],
    objects: [object], metadata: [{ eid: 8, nodes }], extra: { temperatureInterpolation: 'cubic' }, beforeApply(context) {
      const original = context.buildTemperatureGradientField;
      context.buildTemperatureGradientField = (pos, values, triangles, segments) => {
        connectivityIndices = segments.length;
        assert.ok(connectivityIndices <= count * 8,
          `expected at most four anchor edges per grid, received ${connectivityIndices / 2} edges`);
        return original(pos, values, triangles, segments);
      };
    } });
  assert.ok(connectivityIndices > count);
  const values = object.geometry.attributes.temperatureControl0.array;
  close(values[0], 12.25);
  close(values[1], 13.25);
  close(values[2], 13.75);
});


for (const mode of ['linear', 'nearest']) {
  test(`${mode} on primary grid vertices skips gradient fitting`, () => {
    const object = mesh(Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0]));
    decorateQuad(object, { extra: { temperatureInterpolation: mode }, beforeApply(context) {
      context.buildTemperatureGradientField = () => assert.fail('primary grid values do not need a gradient fit');
    } });
    const values = object.geometry.attributes.temperatureControl0.array;
    close(values[0], 10);
    close(values[1], 12);
    close(values[2], 15);
  });
}
