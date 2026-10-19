const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'WebMeshEditor.html'), 'utf8');
const encoded = html.match(/var CARD_ENGINE_WORKER_SOURCE_B64 = "([^"]+)";/)[1];
const source = process.env.WEBMESH_TEST_WORKER
  ? fs.readFileSync(process.env.WEBMESH_TEST_WORKER, 'utf8')
  : Buffer.from(encoded, 'base64').toString('utf8');
const messages = [];
const worker = vm.createContext({
  self: { postMessage(message) { messages.push(message); } },
  TextEncoder, TextDecoder, performance, setTimeout, clearTimeout
});
vm.runInContext(source, worker);
const parse = vm.runInContext('parseDeckToCardStream', worker);
const write = vm.runInContext('handleWriteRequest', worker);
const plain = value => JSON.parse(JSON.stringify(value));
const small = (head, fields, tail = '') => String(head).padEnd(8)
  + Array.from({ length: 8 }, (_, i) => String(fields[i] ?? '').padStart(8)).join('')
  + String(tail).padEnd(8);
const large = (head, fields, tail = '') => String(head).padEnd(8)
  + Array.from({ length: 4 }, (_, i) => String(fields[i] ?? '').padStart(16)).join('')
  + String(tail).padEnd(8);
const deck = cards => `BEGIN BULK\nGRID,1,,0.,0.,0.\nGRID,2,,1.,0.,0.\n${cards}\nENDDATA`;

for (const retainParseSession of [false, true]) {
  test(`temperature load from the MYSTRAN fixture (${retainParseSession ? 'editable' : 'fast'})`, async () => {
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'hexa8_default_x.bdf'), 'utf8');
    const result = await parse(fixture, 'fixture.bdf', {}, { retainParseSession });
    assert.deepEqual(plain(result.errors), []);
    assert.deepEqual(plain(result.warnings), []);
    assert.deepEqual(plain(result.transferables.coreModel.temperatures), [{
      sid: 5, defaultTemperature: null,
      nodeIds: [1, 2, 3, 4, 5, 6, 7, 8],
      values: [20, 120, 120, 20, 20, 120, 120, 20]
    }]);
  });
}

test('free-field TEMP pairs, labeled continuations, and Nastran signed numbers', async () => {
  const cards = 'TEMP,7,1,+20,2,-10,3,1.2+2,,+C\n+C,4,+1.0-3,5,+1E3,+H\n+H,6,0.';
  const result = await parse(deck(cards), 'free.bdf', {}, {});
  assert.deepEqual(plain(result.errors), []);
  assert.deepEqual(plain(result.warnings), []);
  assert.deepEqual(plain(result.transferables.coreModel.temperatures), [{
    sid: 7, defaultTemperature: null,
    nodeIds: [1, 2, 3, 4, 5, 6], values: [20, -10, 120, 0.001, 1000, 0]
  }]);
});

test('TEMP and TEMPD group independent SIDs; later values replace earlier values', async () => {
  const cards = [
    'TEMPD,9,15.,2,-5.',
    'TEMP,9,1,20.,2,30.',
    'TEMP,9,1,40.',
    'TEMP,2,2,50.',
    'TEMPD,9,25.'
  ].join('\n');
  const result = await parse(deck(cards), 'defaults.bdf', {}, {});
  assert.deepEqual(plain(result.errors), []);
  assert.deepEqual(plain(result.warnings), []);
  assert.deepEqual(plain(result.transferables.coreModel.temperatures), [
    { sid: 2, defaultTemperature: -5, nodeIds: [2], values: [50] },
    { sid: 9, defaultTemperature: 25, nodeIds: [1, 2], values: [40, 30] }
  ]);
});

test('small fixed-field TEMP padding and TEMPD continuation', async () => {
  const cards = [
    small('TEMP', [5, 1, '10.', 2, '20.', 3, '30.', ''], '+C'),
    small('+C', [4, '40.', 5, '50.']),
    small('TEMPD', [5, '-5.', 6, '0.', 7, '7.', 8, '8.'], '+H'),
    small('+H', [9, '9.'])
  ].join('\n');
  const result = await parse(deck(cards), 'small.bdf', {}, {});
  assert.deepEqual(plain(result.errors), []);
  assert.deepEqual(plain(result.warnings), []);
  assert.deepEqual(plain(result.transferables.coreModel.temperatures), [
    { sid: 5, defaultTemperature: -5, nodeIds: [1, 2, 3, 4, 5], values: [10, 20, 30, 40, 50] },
    { sid: 6, defaultTemperature: 0, nodeIds: [], values: [] },
    { sid: 7, defaultTemperature: 7, nodeIds: [], values: [] },
    { sid: 8, defaultTemperature: 8, nodeIds: [], values: [] },
    { sid: 9, defaultTemperature: 9, nodeIds: [], values: [] }
  ]);
});

test('large fixed-field TEMP and TEMPD pairs crossing physical lines', async () => {
  const cards = [
    large('TEMP*', [11, 1, '10.', 2], '*C'),
    large('*C', ['20.', 3, '30.', '']),
    large('TEMPD*', [11, '-1.', 12, '+2.'], '*H'),
    large('*H', [13, '3.'])
  ].join('\n');
  const result = await parse(deck(cards), 'large.bdf', {}, {});
  assert.deepEqual(plain(result.errors), []);
  assert.deepEqual(plain(result.warnings), []);
  assert.deepEqual(plain(result.transferables.coreModel.temperatures), [
    { sid: 11, defaultTemperature: -1, nodeIds: [1, 2, 3], values: [10, 20, 30] },
    { sid: 12, defaultTemperature: 2, nodeIds: [], values: [] },
    { sid: 13, defaultTemperature: 3, nodeIds: [], values: [] }
  ]);
});

for (const strictMode of [false, true]) {
  test(`invalid temperature pairs produce ${strictMode ? 'errors' : 'warnings'} without inventing zero temperatures`, async () => {
    const result = await parse(deck('TEMP,4,1,,2,25.\nTEMPD,5,INVALID\nTEMP,0,1,100.'), 'bad.bdf', {}, { strictMode });
    assert.equal(result[strictMode ? 'errors' : 'warnings'].length, 3);
    assert.deepEqual(plain(result.transferables.coreModel.temperatures), [
      { sid: 4, defaultTemperature: null, nodeIds: [2], values: [25] }
    ]);
  });
}

test('decks without temperature cards expose an empty list', async () => {
  const result = await parse(deck(''), 'empty.bdf', {}, {});
  assert.deepEqual(plain(result.transferables.coreModel.temperatures), []);
});

for (const writeFormat of ['source', 'free', 'small', 'large']) {
  test(`TEMP/TEMPD and unknown card survive ${writeFormat} export and reimport`, async () => {
    const cards = 'TEMPD,5,-3.\nTEMP,5,1,20.,2,30.,+C\n+C,3,40.\nNOTACARD,90,custom,data';
    const original = await parse(deck(cards), 'export.bdf', {}, { retainParseSession: true });
    messages.length = 0;
    write({ model: original.model, options: { writeFormat } });
    const output = messages.find(message => message.type === 'WRITE_COMPLETE');
    assert.ok(output, 'worker must produce an exported deck');
    assert.match(output.text, /NOTACARD/);
    const reparsed = await parse(output.text, 'roundtrip.bdf', {}, {});
    assert.deepEqual(plain(reparsed.errors), []);
    assert.deepEqual(plain(reparsed.warnings), []);
    assert.deepEqual(plain(reparsed.transferables.coreModel.temperatures), plain(original.transferables.coreModel.temperatures));
  });
}
