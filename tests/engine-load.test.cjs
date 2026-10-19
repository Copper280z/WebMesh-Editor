const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const engine = fs.readFileSync(path.join(__dirname, '..', 'app', 'editor-engine.js'), 'utf8');
const start = engine.indexOf('  async function loadFromText(');
const loadSource = engine.slice(start, engine.indexOf('  function refreshCounts()', start));

test('strict project parsing rejects invalid cards before clearing the previous model', async () => {
  let cleared = 0, options;
  const previous = { nodes: new Map([[90, { x: 1, y: 2, z: 3 }]]) };
  const context = vm.createContext({
    CARD_ENGINE_WORKER_SOURCE: 'worker', CORE_PAYLOAD_MODE: { CORE_SOA_ONLY: 'core_soa_only' }, model: previous, deckCaseControl: { original: true },
    perfCurrentRun: { status: 'running' },
    perfBeginPhase() {}, perfEndPhase() {}, perfPushEvent() {}, perfFinalizeRun() {},
    logPhaseMemorySnapshot() {}, hideLoadProgress() {}, statusMsg() {}, console: { error() {} },
    clearWorkerCaches() { cleared++; },
    parseCardEngine: async (_text, _name, _files, parseOptions) => {
      options = parseOptions;
      return { errors: [{ message: 'GRID: invalid coordinates' }], warnings: [], model: {}, transferables: { coreModel: {} } };
    }
  });
  vm.runInContext(loadSource, context);
  await assert.rejects(context.loadFromText('BEGIN BULK\nGRID,broken\nENDDATA', 'bad.bdf', null, { strict: true, throwOnError: true }), /invalid coordinates/);
  assert.equal(cleared, 0);
  assert.equal(context.model, previous);
  assert.equal(context.model.nodes.get(90).x, 1);
  assert.equal(context.deckCaseControl.original, true);
  assert.equal(options.strictMode, true);
  assert.equal(options.retainSourceSession, true, 'original source must remain available for later authoring');
  assert.equal(options.retainParseSession, false, 'initial import should keep the compact rendering path');
});

test('readable worker factory can recover source cards after compact import', async () => {
  const messages = [];
  let resolveRebuilt;
  const rebuilt = new Promise(resolve => { resolveRebuilt = resolve; });
  const context = vm.createContext({
    self: { postMessage(message) { messages.push(message); if (message.type === 'SOURCE_SESSION_CARD_STREAM_RESULT') resolveRebuilt(message); } },
    TextEncoder, TextDecoder, performance, setTimeout, clearTimeout
  });
  vm.runInContext(require('./helpers/worker-source.cjs'), context);
  const parse = vm.runInContext('parseDeckToCardStream', context);
  const recover = vm.runInContext('handleGetSourceSessionCardStreamRequest', context);
  const deck = 'SOL 101\nCEND\nTITLE = Preserve source\nBEGIN BULK\nGRID,1,,2.,3.,4.,0,123,7\nPARAM,POST,-1\nMYCARD,17,KEEP_THIS\nENDDATA';
  const result = await parse(deck, 'source.bdf', {}, { retainSourceSession: true, retainParseSession: false, includeSourceFilesInModel: false, retainRawLines: false, retainSourceSpans: false });
  assert.ok(result.model.sourceSessionId);
  assert.equal(result.model.parseSessionId, '');
  recover({ requestId: 'restore', sourceSessionId: result.model.sourceSessionId, entryFileKey: 'source.bdf' });
  const recovered = await rebuilt;
  const grid = recovered.cardStream.find(card => card.name === 'GRID');
  assert.equal(grid.tokens[7], '123');
  assert.equal(grid.tokens[8], '7');
  assert.ok(recovered.cardStream.some(card => card.name === 'MYCARD'));
  const write = vm.runInContext('handleWriteRequest', context);
  messages.length = 0;
  write({ model: { ...result.model, parseSessionId: recovered.parseSessionId, cardStream: recovered.cardStream }, options: { writeFormat: 'free' } });
  const written = messages.find(message => message.type === 'WRITE_COMPLETE');
  assert.ok(written);
  assert.match(written.text, /TITLE.*Preserve source/);
  assert.match(written.text, /MYCARD.*KEEP_THIS/);
});
