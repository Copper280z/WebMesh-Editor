const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');
const createSyncContext = require('./helpers/editor-sync-context.cjs');

test('acceptance-size CAD mesh authoring indexes cards linearly and exports complete solid definitions', async t => {
  const nodeCount = 31878, elementCount = 24720;
  const { context, model, warnings, counts } = createSyncContext(nodeCount, elementCount);
  const start = performance.now();
  context.syncWorkerFromEditorModel();
  t.diagnostic(`Authored ${nodeCount} GRID and ${elementCount} CHEXA cards in ${Math.round(performance.now() - start)} ms with ${counts.fullIndexPasses} full index passes.`);
  assert.deepEqual(warnings, []);
  assert.equal(context.workerModel.indexes.nodes.size, nodeCount);
  assert.equal(context.workerModel.indexes.elements.size, elementCount);
  assert.equal(context.workerCards.gridByNid.size, nodeCount);
  assert.ok(context.workerCards.byKey.has('PSOLID:1'));
  assert.ok(context.workerCards.byKey.has('MAT1:1'));
  assert.equal(context.workerModel.cardStream.at(-1).name, 'ENDDATA');
  assert.equal(counts.fullIndexPasses, 2, 'one initial index and one completed-batch index; never one per inserted card');
  assert.ok(counts.indexedRecords <= context.workerModel.cardStream.length * 2, 'total records indexed must grow linearly');

  const messages = [];
  const worker = vm.createContext({ Map, Set, self: { postMessage(message) { messages.push(message); } }, TextEncoder, TextDecoder, performance, setTimeout, clearTimeout });
  vm.runInContext(require('./helpers/worker-source.cjs'), worker);
  worker.handleWriteRequest({ model: context.workerModel, options: { writeFormat: 'free' } });
  const exported = messages.find(message => message.type === 'WRITE_COMPLETE');
  assert.ok(exported, 'the actual worker writer must produce a deck');
  assert.match(exported.text, /^PSOLID,1,1,/m);
  assert.equal((exported.text.match(/^GRID,/gm) || []).length, nodeCount);
  assert.equal((exported.text.match(/^CHEXA,/gm) || []).length, elementCount);

  const before = counts.fullIndexPasses;
  model.nodes.get(1).x = 123.5;
  context.syncWorkerFromEditorModel();
  assert.equal(counts.fullIndexPasses - before, 1, 'editing an existing model only indexes the completed batch');
  assert.equal(context.workerCards.gridByNid.get(1).tokens[3], '123.5');
});

test('card readiness detects replaced streams and external appends without rebuilding unchanged indexes', () => {
  const { context, counts } = createSyncContext(8, 1);
  context.ensureWorkerBackedModelReady();
  const initial = counts.fullIndexPasses;
  for (let i = 0; i < 100; i++) context.ensureWorkerBackedModelReady();
  assert.equal(counts.fullIndexPasses, initial);
  const first = { kind: 'card', name: 'GRID', tokens: ['GRID', '99', '', '1', '2', '3'] };
  const last = { kind: 'card', name: 'GRID', tokens: ['GRID', '99', '', '4', '5', '6'] };
  context.workerModel.cardStream = [first, last, { kind: 'card', name: 'ENDDATA', tokens: ['ENDDATA'] }];
  context.ensureWorkerBackedModelReady();
  assert.equal(context.workerCards.gridByNid.get(99), last, 'duplicate-card authority remains last-record-wins');
  const extra = { kind: 'card', name: 'MAT1', tokens: ['MAT1', '10', '1000', '', '0.3'] };
  context.workerModel.cardStream.push(extra);
  context.ensureWorkerBackedModelReady();
  assert.equal(context.workerCards.byKey.get('MAT1:10'), extra);
  const passes = counts.fullIndexPasses;
  context.deleteWorkerCardByNameId('GRID', 99);
  context.ensureWorkerBackedModelReady();
  assert.equal(counts.fullIndexPasses, passes, 'incremental deletion leaves ready indexes');
  assert.equal(context.workerCards.gridByNid.has(99), false);
});

test('newly authored rod properties are included in the actual card stream', () => {
  const { context, model, warnings } = createSyncContext(8, 1);
  model.properties.set(2, { type: 'PROD', pid: 2, mid: 1, A: 12.5 });
  context.syncWorkerFromEditorModel();
  assert.deepEqual(warnings, []);
  assert.deepEqual(Array.from(context.workerCards.byKey.get('PROD:2').tokens.slice(0,4)), ['PROD', '2', '1', '12.5']);
});

test('new concentrated masses survive writer/parser roundtrip, edits and deletion', async () => {
  const { context, model, warnings } = createSyncContext(8, 1);
  model.masses.set(20, { type: 'CONM2', eid: 20, g: 1, cid: 0, m: 0.0005, x: [0, 0, 200], inertia: [1, 0.2, 3, 0.4, 0.5, 6] });
  let text;
  const worker = vm.createContext({ Map, Set, self: { postMessage(message) { if (message.type === 'WRITE_COMPLETE') text = message.text; } }, TextEncoder, TextDecoder, performance, setTimeout, clearTimeout });
  vm.runInContext(require('./helpers/worker-source.cjs'), worker);
  for (const mass of [0.0005, 0.001]) {
    model.masses.get(20).m = mass;
    context.syncWorkerFromEditorModel();
    worker.handleWriteRequest({ model: context.workerModel, options: { writeFormat: 'free' } });
    assert.equal((text.match(/^CONM2,/gm) || []).length, 1);
    const parsed = await worker.parseDeckToCardStream(text, 'mass.bdf', {}, { strictMode: true, retainSourceSession: false, includeSourceFilesInModel: false });
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.errors)), []);
    const restored = parsed.transferables.coreModel.masses[0];
    assert.equal(restored.m, mass);
    assert.equal(restored.g, 1);
    assert.deepEqual(Array.from(restored.x), [0, 0, 200]);
    assert.deepEqual(Array.from(restored.inertia), [1, 0.2, 3, 0.4, 0.5, 6]);
  }
  model.masses.delete(20);
  context.syncWorkerFromEditorModel();
  worker.handleWriteRequest({ model: context.workerModel, options: { writeFormat: 'free' } });
  assert.doesNotMatch(text, /^CONM2,/m);
  assert.deepEqual(warnings, []);
});


test('new solid properties survive the actual writer and parser roundtrip', async () => {
  const { context } = createSyncContext(8, 1);
  context.syncWorkerFromEditorModel();
  let text;
  const worker = vm.createContext({ Map, Set, self: { postMessage(message) { if (message.type === 'WRITE_COMPLETE') text = message.text; } }, TextEncoder, TextDecoder, performance, setTimeout, clearTimeout });
  vm.runInContext(require('./helpers/worker-source.cjs'), worker);
  worker.handleWriteRequest({ model: context.workerModel, options: { writeFormat: 'free' } });
  const parsed = await worker.parseDeckToCardStream(text, 'generated.bdf', {}, { strictMode: true, retainSourceSession: false, includeSourceFilesInModel: false });
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.errors)), []);
  assert.equal(parsed.transferables.coreModel.counts.nodes, 8);
  assert.equal(parsed.transferables.coreModel.counts.elements, 1);
  assert.equal(parsed.transferables.coreModel.properties[0].type, 'PSOLID');
  assert.equal(parsed.transferables.coreModel.properties[0].mid, 1);
});
