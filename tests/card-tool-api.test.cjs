const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'editor-engine.js'), 'utf8');
const start = source.indexOf('  window.WebMeshAPI = Object.freeze({');
const apiSource = source.slice(start, source.indexOf('  window.dispatchEvent(new CustomEvent("webmesh:ready"))', start));
function tab(active = false) {
  const state = new Set(active ? ['active'] : []);
  return { classList: { contains: key => state.has(key), add: key => state.add(key), remove: key => state.delete(key), toggle(key, on) { if (on) state.add(key); else state.delete(key); } } };
}
function fixture() {
  const calls = [];
  const noop = () => {};
  const context = vm.createContext({
    window: {}, workbenchState: noop, workbenchNextIds: noop, workbenchGetMesh: noop,
    workbenchBindMeshOwner: noop, workbenchGetMeshOwner: noop, workbenchRemoveMeshOwner: noop,
    workbenchAppendMesh: noop, workbenchPreviewMesh: noop, fitView: noop,
    workbenchSetView: noop, workbenchSetTheme: noop,
    schemaCreateReady: Promise.resolve(), schemaEditReady: Promise.resolve(),
    createTab: tab(), modifyTab: tab(), inspectTab: tab(true), currentElemInput: { id: 'old-node-pick' },
    schemaSelectCardForMode(mode, name) { calls.push({ mode, name }); return name !== 'UNSUPPORTED'; },
    schemaEditApplySelection(options) { calls.push({ apply: true, ...options }); if (options.throwOnNoTarget !== false) throw Error('Empty selection'); }
  });
  vm.runInContext(apiSource, context);
  return { context, api: context.window.WebMeshAPI, calls };
}

test('a docked modify editor opens with no selection and activates its viewport pick context', async () => {
  const { context, api, calls } = fixture();
  await api.editCard('GRID', 'modify');
  assert.equal(context.modifyTab.classList.contains('active'), true);
  assert.equal(context.createTab.classList.contains('active'), false);
  assert.equal(context.inspectTab.classList.contains('active'), false);
  assert.equal(calls.find(call => call.apply).throwOnNoTarget, false);
  api.closeTool();
  assert.equal(context.modifyTab.classList.contains('active'), false);
  assert.equal(context.inspectTab.classList.contains('active'), true);
  assert.equal(context.currentElemInput, null);
});

test('a docked create editor waits for schema initialization before selecting its card', async () => {
  const { context, api, calls } = fixture();
  let resolve;
  context.schemaCreateReady = new Promise(done => { resolve = done; });
  const operation = api.editCard('FORCE', 'create');
  assert.equal(calls.length, 0);
  resolve();
  await operation;
  assert.equal(calls[0].name, 'FORCE');
  assert.equal(context.createTab.classList.contains('active'), true);
  assert.equal(context.modifyTab.classList.contains('active'), false);
});

test('unsupported card selection reports an error before changing the active pick context', async () => {
  const { context, api } = fixture();
  await assert.rejects(api.editCard('UNSUPPORTED'), /editor is unavailable/);
  assert.equal(context.createTab.classList.contains('active'), false);
  assert.equal(context.inspectTab.classList.contains('active'), true);
});
