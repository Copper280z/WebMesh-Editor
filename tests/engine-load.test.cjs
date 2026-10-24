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
    clearSolverResults() { throw new Error('Failed import must retain the previous results'); },
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

test('clearing a model drops solver data, derived values, animation and result UI', () => {
  const controls = Object.fromEntries(['chkShowContour', 'chkShowDeformed', 'chkShowCriteriaValues', 'deformScaleInput', 'contourLegend'].map(id => [id, { checked: true, value: '100', style: { display: 'block' } }]));
  let timerCleared = null, selectorUpdates = 0, clearHandler;
  const noop = () => {};
  const context = vm.createContext({
    solverResults: { displacements: { 1: [9, 8, 7] } }, solverResultsSourceName: 'old.f06',
    nodeAvgStress: { 1: 42 }, nodeAvgStressByField: { sx: { 1: 42 } }, nodeAvgStrainByField: { sx: { 1: 1 } }, nodeAvgElementForceByField: { nxx: { 1: 2 } },
    showContour: true, showDeformed: true, showCriteriaValues: true, deformationScale: 100,
    animationPlaying: true, animationPaused: true, animationPhase: 1, animationTimer: 17,
    document: { getElementById: id => controls[id] }, clearInterval: id => { timerCleared = id; },
    updateResultSetSelector: () => { selectorUpdates++; }, refreshResultDisplayExclusions: noop,
    btnClear: { addEventListener: (_event, handler) => { clearHandler = handler; } },
    historyManager: { recordAction: action => action() },
    selection: Object.fromEntries(['nodes', 'elems', 'loads', 'constraints', 'props'].map(key => [key, new Set([1])])),
    modelTreeContainer: null, hideEntryChooser: noop, clearWorkerCaches: noop, resetModel: noop, clearModelTreeHoverVisual: noop, clearScene: noop,
    updateSelectionVisual: noop, highlightSelectedElementVisual: noop, updateSelectionUI: noop, refreshCounts: noop,
    populateModelTree: noop, refreshTemperatureLoadSelector: noop, refreshContourFieldOptions: noop, statusMsg: noop
  });
  const resetStart = engine.indexOf('  function clearSolverResults(');
  vm.runInContext(engine.slice(resetStart, engine.indexOf('  function applyLoadedSolverResults(', resetStart)), context);
  const handlerStart = engine.indexOf('  btnClear.addEventListener("click",');
  vm.runInContext(engine.slice(handlerStart, engine.indexOf('  btnReset.addEventListener', handlerStart)), context);
  clearHandler();
  assert.equal(context.solverResults, null);
  assert.equal(context.solverResultsSourceName, '');
  for (const key of ['nodeAvgStress', 'nodeAvgStressByField', 'nodeAvgStrainByField', 'nodeAvgElementForceByField']) assert.equal(Object.keys(context[key]).length, 0);
  for (const key of ['showContour', 'showDeformed', 'showCriteriaValues', 'animationPlaying', 'animationPaused']) assert.equal(context[key], false);
  assert.equal(context.animationTimer, null);
  assert.equal(context.animationPhase, 0);
  assert.equal(timerCleared, 17);
  assert.equal(selectorUpdates, 1);
  assert.equal(controls.contourLegend.style.display, 'none');
  assert.equal(controls.chkShowContour.checked, false);
  assert.equal(controls.chkShowDeformed.checked, false);
  assert.equal(controls.deformScaleInput.value, '1');
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

test('run-bound result display does not queue an unverified manual-import notification', () => {
  const notifications = [], context = vm.createContext({ window: {},
    solverResults: null, solverResultsSourceName: '', refreshResultDisplayExclusions() {},
    emitWorkbenchChange: reason => notifications.push(reason),
    getSolverResultSets: () => [{setId: '1'}], getSolverResultSetById: () => null,
    syncSolverResultsActiveSet: id => id
  });
  const start = engine.indexOf('  function applyLoadedSolverResults(');
  vm.runInContext(engine.slice(start, engine.indexOf('  function fetchParseSessionCardStream(', start)), context);
  context.applyLoadedSolverResults({resultSets:[{setId:'1'}]}, 'Run', true);
  assert.deepEqual(notifications, []);
  context.applyLoadedSolverResults({resultSets:[{setId:'1'}]}, 'manual.f06');
  assert.deepEqual(notifications, ['results']);
});
