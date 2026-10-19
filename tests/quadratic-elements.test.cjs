const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const messages = [];
const context = vm.createContext({ self: { postMessage(message) { messages.push(message); } }, TextEncoder, TextDecoder, performance, setTimeout, clearTimeout });
vm.runInContext(require('./helpers/worker-source.cjs'), context);
const parse = vm.runInContext('parseDeckToCardStream', context);
const write = vm.runInContext('handleWriteRequest', context);
const positions = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1],
  [0.5,0,0],[1,0.5,0],[0.5,1,0],[0,0.5,0],[0,0,0.5],[1,0,0.5],[1,1,0.5],[0,1,0.5],
  [0.5,0,1],[1,0.5,1],[0.5,1,1],[0,0.5,1]];
const lines = ['CEND', 'BEGIN BULK', ...positions.map((p, i) => `GRID,${i + 1},,${p.join(',')}`),
  'MAT1,1,210000,,0.3,7.85E-9', 'PSHELL,1,1,1.', 'PSOLID,2,1',
  'CTRIA6,1,1,1,2,3,9,10,11',
  'CQUAD8,2,1,1,2,3,4,9,10\n+,11,12',
  'CTETRA,3,2,1,2,3,5,9,10\n+,11,13,14,15',
  'CHEXA,4,2,1,2,3,4,5,6\n+,7,8,9,10,11,12,13,14\n+,15,16,17,18,19,20',
  'TEMP,5,1,120.', 'SPC1,8,123,1', 'FORCE,9,1,0,20.,1.,0.,0.', 'PARAM,POST,-1', 'ENDDATA'];
const deck = lines.join('\n');

function checkConnectivity(parsed) {
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.errors)), []);
  const core = parsed.transferables.coreModel;
  assert.equal(core.counts.nodes, 20);
  assert.equal(core.counts.elements, 4);
  const expected = [[1,2,3,9,10,11], [1,2,3,4,9,10,11,12], [1,2,3,5,9,10,11,13,14,15], Array.from({length:20}, (_, i) => i + 1)];
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(Array.from(core.elemNodeIds.slice(core.elemNodeOffsets[i], core.elemNodeOffsets[i + 1]), idx => core.nodeIds[idx]), expected[core.elemIds[i] - 1]);
  }
}
for (const format of ['source', 'free', 'small', 'large']) {
  test(`all quadratic shell/solid connectivity and analysis cards survive ${format} export`, async () => {
    const initial = await parse(deck, 'quadratic.bdf', {}, { retainParseSession: true });
    checkConnectivity(initial);
    messages.length = 0;
    write({ model: initial.model, options: { writeFormat: format } });
    const output = messages.find(m => m.type === 'WRITE_COMPLETE');
    assert.ok(output);
    for (const name of ['CTRIA6', 'CQUAD8', 'CTETRA', 'CHEXA', 'TEMP', 'SPC1', 'FORCE', 'PARAM']) assert.match(output.text, new RegExp(name));
    const again = await parse(output.text, 'again.bdf', {}, {});
    checkConnectivity(again);
    assert.equal(again.transferables.coreModel.temperatures[0].values[0], 120);
  });
}
