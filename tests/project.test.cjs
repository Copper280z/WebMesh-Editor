'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const project = require('../app/project.js');
const plain = value => JSON.parse(JSON.stringify(value));
const status = (store, id) => store.checks().find(check => check.id === id).status;

function rover() {
  const store = project.create({ name: 'Rover' });
  const setup = store.begin('Define wheel attachment');
  for (const object of [
    { id: 'pla', kind: 'material', definition: { E: 3000 } },
    { id: 'wheel', kind: 'mesh', dependsOn: ['pla'], definition: { size: 2 } },
    { id: 'holes', kind: 'region', dependsOn: ['wheel'], definition: { rule: 'hole-loops' } },
    { id: 'motor', kind: 'connection', dependsOn: ['holes'], overrides: { K1: 150000 } },
    { id: 'static', kind: 'analysis', dependsOn: ['motor'] },
    { id: 'unrelated', kind: 'part' }
  ]) setup.putObject(object);
  setup.commit();
  return store;
}
function refine(store) {
  return store.begin('Refine wheel').putObject({ ...store.getObject('wheel'), definition: { size: 1.5 } });
}

test('new projects isolate their data and declare locked units without mutating input', () => {
  const units = { length: 'mm', force: 'N', time: 's', mass: 't' };
  const store = project.create({ name: 'Rover', units });
  units.length = 'm';
  assert.equal(store.snapshot().units.length, 'mm');
  assert.equal(store.snapshot().revision, 0);
  assert.throws(() => { store.snapshot().units.length = 'm'; }, TypeError);
  assert.throws(() => project.create({ units: { length: 'mm' } }), /Units require/);
  assert.deepEqual(project.create().snapshot().objects, []);
});

test('browser-global entry works without Node or DOM dependencies', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/project.js'), 'utf8'), context);
  vm.runInContext('var p = WebMeshProject.create(); p.begin("Part").putObject({id:"p",kind:"part"}).commit();', context);
  assert.equal(context.p.snapshot().revision, 1);
  assert.equal(context.p.checks()[0].status, 'ok');
});

test('preview lists every wheel dependent while preserving the committed graph and overrides', () => {
  const store = rover(), original = store.snapshot(), tx = refine(store);
  const report = tx.preview();
  assert.deepEqual(report.affected, ['holes', 'motor', 'static', 'wheel']);
  assert.equal(report.baseRevision, 1);
  assert.equal(report.revision, 2);
  assert.equal(report.checks.find(check => check.id === 'holes').status, 'invalid');
  assert.deepEqual(store.snapshot(), original);
  tx.commit();
  assert.equal(store.snapshot().revision, 2);
  assert.equal(status(store, 'wheel'), 'ok');
  assert.equal(status(store, 'holes'), 'invalid');
  assert.equal(status(store, 'static'), 'invalid');
  assert.equal(status(store, 'unrelated'), 'ok');
  assert.deepEqual(store.getObject('motor').overrides, { K1: 150000 });
  assert.throws(() => tx.commit(), /closed/);
});

test('explicit downstream re-evaluation produces review checks, acknowledgements rebuild on reopen', () => {
  const store = rover();
  refine(store).revalidate('holes').revalidate('motor').revalidate('static').commit();
  assert.equal(status(store, 'holes'), 'changed');
  assert.equal(status(store, 'motor'), 'changed');
  assert.equal(store.readiness().allowed, true);
  store.begin('Review wheel attachment').acknowledge('holes').acknowledge('motor').acknowledge('static').commit();
  assert.ok(store.checks().every(check => check.status === 'ok'));
  const reopened = project.restore(JSON.stringify(store.snapshot()));
  assert.deepEqual(reopened.checks(), store.checks());
  assert.deepEqual(reopened.snapshot(), store.snapshot());
});

test('acknowledgement alone cannot repair stale, suspended, errored or unverified objects', () => {
  for (const evidence of [null, { suspendedReason: 'Explicit node identities lost' },
    { issues: [{ code: 'dependent-dof', message: 'Dependent DOF conflict' }] },
    { unverifiedReason: 'External result provenance is unknown' }]) {
    const store = rover();
    if (evidence) store.begin('Evidence').putObject({ ...store.getObject('holes'), facts: evidence }).commit();
    else refine(store).commit();
    const original = store.snapshot();
    assert.throws(() => store.begin('Acknowledge').acknowledge('holes').commit(), /Cannot acknowledge/);
    assert.deepEqual(store.snapshot(), original);
  }
});

test('revalidation does not silently clear suspension; repair must explicitly replace its evidence', () => {
  const store = rover();
  store.begin('Lost region').putObject({ ...store.getObject('holes'), facts: { suspendedReason: 'Node IDs were reused' } }).commit();
  store.begin('Evaluate without repairing').revalidate('holes').commit();
  assert.equal(status(store, 'holes'), 'invalid');
  store.begin('Explicitly rebind region').revalidate('holes', { suspendedReason: null }).revalidate('motor').revalidate('static').commit();
  assert.equal(status(store, 'holes'), 'ok');
  assert.equal(status(store, 'motor'), 'changed');
});

test('solve and runnable export share blockers; incomplete export requires named omissions and acknowledgement', () => {
  const store = rover();
  store.begin('Suspend motor').putObject({ ...store.getObject('motor'), facts: { suspendedReason: 'Mounting holes missing' } }).commit();
  const solve = store.readiness({ action: 'solve', roots: ['static'] });
  const exported = store.readiness({ action: 'export-analysis', roots: ['static'] });
  assert.equal(solve.allowed, false);
  assert.deepEqual(solve.blockers, exported.blockers);
  const draft = store.readiness({ action: 'export-draft', roots: ['static'] });
  assert.equal(draft.allowed, false);
  assert.deepEqual(draft.omissions.map(item => item.id), ['motor', 'static']);
  assert.ok(draft.omissions.every(item => item.reason));
  assert.equal(store.readiness({ action: 'export-draft', roots: ['static'], acknowledgeOmissions: true }).allowed, true);
  assert.equal(store.readiness({ action: 'export-analysis', acknowledgeOmissions: true }).allowed, false);
  assert.equal(store.readiness({ roots: ['unrelated'] }).allowed, true);
  assert.throws(() => store.readiness({ roots: ['missing'] }), /Unknown readiness root/);
});

test('expected unfinished work is neutral until required by a defined downstream object', () => {
  const store = project.create();
  store.begin('Empty supports').putObject({ id: 'supports', kind: 'support', facts: { defined: false } }).commit();
  assert.equal(status(store, 'supports'), 'not-defined');
  assert.equal(store.readiness().blockers.length, 0);
  store.begin('Analysis requires supports').putObject({ id: 'analysis', kind: 'analysis', dependsOn: ['supports'] }).commit();
  assert.equal(status(store, 'analysis'), 'invalid');
  assert.equal(store.readiness({ roots: ['analysis'] }).allowed, false);
});

test('unknown provenance warns and propagates without pretending to be invalid cards', () => {
  const store = project.create();
  store.begin('External results').putObject({ id: 'run', kind: 'run', facts: { unverifiedReason: 'Origin unverified' } })
    .putObject({ id: 'result', kind: 'result', dependsOn: ['run'] }).commit();
  assert.equal(status(store, 'result'), 'unverified');
  assert.equal(store.readiness().warnings.length, 2);
});

test('a material edit committed during meshing rejects the outdated candidate without losing edits or IDs', () => {
  const store = rover(), pending = refine(store);
  pending.reserveIds('wheel', 'node', 'refined', 2000);
  store.begin('Change PLA').putObject({ ...store.getObject('pla'), definition: { E: 3200 } }).commit();
  const current = store.snapshot();
  assert.throws(() => pending.commit(), /Outdated candidate.*base revision 1, current revision 2/);
  assert.deepEqual(store.snapshot(), current);
  assert.equal(store.getObject('pla').definition.E, 3200);
  assert.equal(store.snapshot().reservations.length, 0);
  pending.discard();
  refine(store).revalidate('holes').revalidate('motor').revalidate('static').commit();
  assert.equal(store.snapshot().revision, 3);
  assert.equal(store.getObject('pla').definition.E, 3200);
});

test('discard and failed validation leave committed state byte-identical', () => {
  const store = rover(), before = JSON.stringify(store.snapshot());
  const tx = refine(store); tx.reserveIds('wheel', 'node', 'mesh', 100); tx.preview(); tx.discard();
  assert.equal(JSON.stringify(store.snapshot()), before);
  assert.throws(() => tx.preview(), /closed/);
  assert.throws(() => store.begin('Dangling').removeObject('wheel').commit(), /missing dependency wheel/);
  const cyclic = store.begin('Cycle').putObject({ ...store.getObject('wheel'), dependsOn: ['motor'] });
  assert.throws(() => cyclic.preview(), /cycle/);
  assert.throws(() => cyclic.commit(), /cycle/);
  assert.equal(JSON.stringify(store.snapshot()), before);
});

test('dependency removal is explicit, and simultaneous repair permits a complete transaction', () => {
  const store = rover();
  store.begin('Remove attachment chain').removeObject('holes').removeObject('motor')
    .putObject({ ...store.getObject('static'), dependsOn: ['wheel'] }).commit();
  assert.equal(store.getObject('holes'), null);
  assert.equal(status(store, 'static'), 'ok');
});

test('no-op previews and commits do not create revisions', () => {
  const store = rover();
  const tx = store.begin('No change').putObject(store.getObject('wheel')).acknowledge('wheel');
  assert.deepEqual(tx.preview().changes, []);
  assert.equal(tx.commit().revision, 1);
  assert.equal(store.snapshot().revision, 1);
});

test('candidate definitions and reports cannot be changed through caller aliases', () => {
  const store = project.create(), input = { id: 'wheel', kind: 'mesh', definition: { settings: { size: 2 } } };
  const tx = store.begin('Wheel').putObject(input);
  input.definition.settings.size = 999;
  assert.throws(() => { tx.preview().changes[0].action = 'removed'; }, TypeError);
  tx.commit();
  assert.equal(store.getObject('wheel').definition.settings.size, 2);
  assert.throws(() => { store.getObject('wheel').definition.settings.size = 5; }, TypeError);
});

test('stable role blocks, independent namespaces, imported ranges and additional blocks allocate without collisions', () => {
  const store = rover(), tx = store.begin('Allocate');
  tx.reserveIds(null, 'node', 'imported', 20, { start: 81 });
  const nodes = tx.reserveIds('wheel', 'node', 'instance-FL', 100);
  const elements = tx.reserveIds('wheel', 'element', 'instance-FL', 50);
  assert.equal(nodes.start, 101); assert.equal(nodes.end, 200); assert.equal(elements.start, 1);
  assert.deepEqual(tx.reserveIds('wheel', 'node', 'instance-FL', 80), nodes);
  assert.throws(() => tx.reserveIds('wheel', 'node', 'instance-FL', 101), /capacity exceeded/);
  assert.throws(() => tx.reserveIds('wheel', 'node', 'instance-FL', 20, { start: 1 }), /cannot move/);
  const next = tx.reserveIds('wheel', 'node', 'instance-FR', 100);
  assert.equal(next.start, 201);
  tx.commit();
  const reopened = project.restore(store.snapshot()), again = reopened.begin('Reuse block');
  assert.deepEqual(again.reserveIds('wheel', 'node', 'instance-FL', 100), nodes);
  assert.equal(again.commit().revision, 2);
});

test('overlap, overflow and invalid allocations do not consume IDs or alter valid draft reservations', () => {
  const store = rover(), tx = store.begin('Blocks');
  tx.reserveIds('wheel', 'node', 'first', 10);
  assert.throws(() => tx.reserveIds(null, 'node', 'overlap', 5, { start: 10 }), /Overlapping/);
  assert.throws(() => tx.reserveIds('wheel', 'node', 'huge', project.MAX_ID), /integer range/);
  assert.throws(() => tx.reserveIds('wheel', 'node', 'zero', 0), /integer range/);
  assert.throws(() => tx.reserveIds('absent', 'node', 'wrong', 1), /Unknown object/);
  assert.throws(() => tx.reserveIds('wheel', 'bogus', 'wrong', 1), /namespace/);
  assert.equal(tx.reserveIds('wheel', 'node', 'next', 10).start, 11);
  tx.commit();
  assert.equal(store.snapshot().reservations.length, 2);
});

test('deleted owners leave reserved numeric IDs unavailable for accidental reuse', () => {
  const store = project.create();
  const setup = store.begin('Temporary part').putObject({ id: 'part', kind: 'part' });
  setup.reserveIds('part', 'node', 'mesh', 100); setup.commit();
  store.begin('Remove part').removeObject('part').commit();
  const reopened = project.restore(store.snapshot());
  assert.throws(() => reopened.begin('Reuse old identity').putObject({ id: 'part', kind: 'part' }), /retired object identity/);
  const next = reopened.begin('New part').putObject({ id: 'new', kind: 'part' });
  assert.equal(next.reserveIds('new', 'node', 'mesh', 10).start, 101);
});

test('renaming a stale object or editing it during an upstream change cannot certify its inputs', () => {
  const store = rover();
  refine(store).putObject({ ...store.getObject('holes'), name: 'Renamed holes' }).commit();
  assert.equal(status(store, 'holes'), 'invalid');
  store.begin('Rename again').putObject({ ...store.getObject('holes'), name: 'Another name' }).commit();
  assert.equal(status(store, 'holes'), 'invalid');
  assert.throws(() => store.begin('Change kind').putObject({ ...store.getObject('wheel'), kind: 'part' }), /cannot change kind/);
  store.begin('Resolve inputs').revalidate('holes').revalidate('motor').revalidate('static').commit();
  assert.equal(status(store, 'holes'), 'changed');
});

test('a later upstream edit inside the same candidate invalidates already-computed downstream evidence', () => {
  const store = rover();
  const tx = refine(store).revalidate('holes').revalidate('motor').revalidate('static');
  assert.equal(tx.preview().checks.find(check => check.id === 'static').status, 'changed');
  tx.putObject({ ...store.getObject('wheel'), definition: { size: 1 } });
  assert.equal(tx.preview().checks.find(check => check.id === 'holes').status, 'invalid');
  tx.revalidate('holes').revalidate('motor').revalidate('static').commit();
  assert.equal(status(store, 'static'), 'changed');
});

test('reservations cannot be committed for an owner that never existed', () => {
  const store = project.create(), tx = store.begin('Temporary draft part').putObject({ id: 'draft', kind: 'part' });
  tx.reserveIds('draft', 'node', 'mesh', 10);
  tx.removeObject('draft');
  assert.throws(() => tx.commit(), /unknown owner/);
  assert.equal(store.snapshot().reservations.length, 0);
});

test('core snapshot roundtrip retains invalid, unverified, neutral, changed and OK checks', () => {
  const store = rover();
  refine(store).revalidate('holes').revalidate('motor').revalidate('static')
    .putObject({ id: 'missing', kind: 'support', facts: { defined: false } })
    .putObject({ id: 'external', kind: 'run', facts: { unverifiedReason: 'No launch record' } })
    .putObject({ id: 'bad', kind: 'region', facts: { suspendedReason: 'Identity lost' } }).commit();
  const input = plain(store.snapshot()), restored = project.restore(input);
  assert.deepEqual(new Set(restored.checks().map(check => check.status)), new Set(['ok', 'changed', 'not-defined', 'unverified', 'invalid']));
  assert.deepEqual(restored.checks(), store.checks());
  input.objects[0].name = 'Corrupted caller data';
  assert.deepEqual(restored.snapshot(), store.snapshot());
  restored.begin('Independent edit').removeObject('bad').commit();
  assert.equal(store.getObject('bad').id, 'bad');
});

test('restore rejects unsupported, cyclic, dangling, overlapping and fabricated-evidence snapshots', () => {
  const store = rover(), base = plain(store.snapshot());
  const changes = [
    s => { s.version = 2; },
    s => { s.revision = -1; },
    s => { s.objects.push(s.objects[0]); },
    s => { s.objects[0].dependsOn = ['absent']; },
    s => { s.objects[0].dependsOn = [s.objects[0].id]; },
    s => { s.objects[0].verifiedAt = 1000; },
    s => { s.objects[0].changedAt = 0; },
    s => { s.objects[0].facts.defined = 'yes'; },
    s => { s.reservations = [{ owner: null, namespace: 'node', role: 'a', start: 1, end: 10 }, { owner: null, namespace: 'node', role: 'b', start: 10, end: 20 }]; }
  ];
  for (const mutate of changes) {
    const input = plain(base); mutate(input);
    assert.throws(() => project.restore(input));
  }
  assert.deepEqual(store.snapshot(), base);
});

test('non-JSON definitions and malformed facts fail before reaching committed state', () => {
  const store = project.create(), tx = store.begin('Bad inputs');
  for (const value of [NaN, Infinity, undefined, () => {}, new Date(), new Map()]) {
    assert.throws(() => tx.putObject({ id: 'a', kind: 'part', definition: { value } }));
  }
  const circle = {}; circle.self = circle;
  assert.throws(() => tx.putObject({ id: 'a', kind: 'part', definition: circle }), /circular/);
  assert.throws(() => tx.putObject({ id: 'a', kind: 'part', dependsOn: ['b', 'b'] }), /Duplicate dependency/);
  assert.throws(() => tx.putObject({ id: 'a', kind: 'part', facts: { status: 'ok' } }), /Unknown validation fact/);
  assert.equal(store.snapshot().revision, 0);
});

test('wide dependency graphs include each dependent once, without touching independent branches', () => {
  const store = project.create(), tx = store.begin('Many instances');
  tx.putObject({ id: 'wheel', kind: 'mesh' });
  for (let i = 0; i < 100; i++) {
    tx.putObject({ id: 'instance-' + i, kind: 'instance', dependsOn: ['wheel'] });
    tx.putObject({ id: 'region-' + i, kind: 'region', dependsOn: ['instance-' + i] });
  }
  tx.putObject({ id: 'analysis', kind: 'analysis', dependsOn: Array.from({ length: 100 }, (_, i) => 'region-' + i) });
  tx.commit();
  const change = store.begin('Remesh').putObject({ ...store.getObject('wheel'), definition: { size: 1 } });
  const preview = change.preview();
  assert.equal(preview.affected.length, 202);
  assert.equal(new Set(preview.affected).size, 202);
  assert.equal(preview.changes.length, 202);
});
