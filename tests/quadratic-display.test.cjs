const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'editor-engine.js'), 'utf8');
const start = source.indexOf('  function quadraticQuadCenter(');
const end = source.indexOf('  function buildGeometriesFromCoreSoa(', start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
const center = vm.runInContext('quadraticQuadCenter', context);

test('quadratic quadrilateral rendering uses serendipity geometry at the center', () => {
  const corners = [[-1,-1,0],[1,-1,0],[1,1,0],[-1,1,0]];
  const midsides = [[0,-1,1],[1,0,1],[0,1,1],[-1,0,1]];
  assert.deepEqual(Array.from(center(corners, midsides)), [0, 0, 2]);
});

test('quadratic quadrilateral center preserves straight and translated planar faces', () => {
  const corners = [[2,3,5],[4,3,5],[4,7,5],[2,7,5]];
  const midsides = [[3,3,5],[4,5,5],[3,7,5],[2,5,5]];
  assert.deepEqual(Array.from(center(corners, midsides)), [3,5,5]);
});
