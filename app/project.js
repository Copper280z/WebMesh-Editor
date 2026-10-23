(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WebMeshProject = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Pure project state. engine-ownership.js connects this to guarded editor
  // transactions; this module itself never mutates solver cards or the DOM.
  const FORMAT = 'webmesh-project-core';
  const VERSION = 1;
  const MAX_ID = 2147483647;
  const NAMESPACES = ['node', 'element', 'property', 'material', 'coordinate', 'load', 'constraint', 'set'];
  const DEFAULT_UNITS = { length: 'mm', force: 'N', time: 's', mass: 't' };

  function fail(message) { throw new Error(message); }
  function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max) fail(label + ' is outside the supported integer range.');
    return value;
  }
  function text(value, label) {
    if (typeof value !== 'string' || !value.trim()) fail(label + ' must be a nonempty string.');
    return value;
  }
  function record(value, label) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]') fail(label + ' must be an object.');
    return value;
  }
  function copy(value) {
    const visiting = new Set();
    function check(item) {
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
      if (typeof item === 'number' && Number.isFinite(item)) return;
      if (!item || typeof item !== 'object') fail('Project data must contain only finite JSON values.');
      if (visiting.has(item)) fail('Project data cannot contain circular references.');
      if (!Array.isArray(item)) record(item, 'Project data');
      visiting.add(item);
      for (const key of Object.keys(item)) check(item[key]);
      if (Array.isArray(item) && Object.keys(item).length !== item.length) fail('Project arrays must be dense JSON arrays.');
      visiting.delete(item);
    }
    check(value);
    return JSON.parse(JSON.stringify(value));
  }
  function freeze(value) {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  const detached = value => freeze(copy(value));
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  const equal = (a, b) => canonical(a) === canonical(b);

  function facts(input = {}) {
    record(input, 'Validation facts');
    const allowed = ['defined', 'issues', 'suspendedReason', 'unverifiedReason'];
    if (Object.keys(input).some(key => !allowed.includes(key))) fail('Unknown validation fact.');
    const result = { defined: true, issues: [], suspendedReason: null, unverifiedReason: null, ...copy(input) };
    if (typeof result.defined !== 'boolean' || !Array.isArray(result.issues)) fail('Invalid validation facts.');
    result.issues.forEach(issue => { record(issue, 'Issue'); text(issue.code, 'Issue code'); text(issue.message, 'Issue message'); });
    for (const key of ['suspendedReason', 'unverifiedReason']) if (result[key] !== null) text(result[key], key);
    return result;
  }
  function specification(input) {
    record(input, 'Object');
    const dependsOn = input.dependsOn === undefined ? [] : input.dependsOn;
    if (!Array.isArray(dependsOn)) fail('Dependencies must be an array.');
    dependsOn.forEach(id => text(id, 'Dependency ID'));
    if (new Set(dependsOn).size !== dependsOn.length) fail('Duplicate dependency.');
    return {
      id: text(input.id, 'Object ID'), kind: text(input.kind, 'Object kind'),
      name: text(input.name === undefined ? input.id : input.name, 'Object name'),
      dependsOn: dependsOn.slice().sort(),
      definition: copy(record(input.definition === undefined ? {} : input.definition, 'Definition')),
      overrides: copy(record(input.overrides === undefined ? {} : input.overrides, 'Overrides')),
      facts: facts(input.facts)
    };
  }
  function graph(objects) {
    const byId = new Map(), children = new Map(), remaining = new Map();
    for (const object of objects) {
      if (byId.has(object.id)) fail('Duplicate object ID: ' + object.id);
      byId.set(object.id, object); children.set(object.id, []);
    }
    for (const object of objects) {
      remaining.set(object.id, object.dependsOn.length);
      for (const parent of object.dependsOn) {
        if (!byId.has(parent)) fail(object.id + ' refers to missing dependency ' + parent + '.');
        children.get(parent).push(object.id);
      }
    }
    const order = [...byId.keys()].filter(id => !remaining.get(id)).sort();
    for (let i = 0; i < order.length; i++) {
      for (const child of children.get(order[i]).slice().sort()) {
        remaining.set(child, remaining.get(child) - 1);
        if (!remaining.get(child)) order.push(child);
      }
    }
    if (order.length !== objects.length) fail('Project dependencies contain a cycle.');
    return { byId, children, order };
  }
  function descendants(ids, ...graphs) {
    const found = new Set(ids), queue = [...ids];
    for (let i = 0; i < queue.length; i++) for (const g of graphs) {
      for (const child of g.children.get(queue[i]) || []) if (!found.has(child)) { found.add(child); queue.push(child); }
    }
    return found;
  }
  function deriveChecks(state) {
    const g = graph(state.objects), checks = new Map();
    for (const id of g.order) {
      const object = g.byId.get(id), f = object.facts, parents = object.dependsOn.map(parent => checks.get(parent));
      let status = 'ok', reason = 'Current and verified.';
      const invalid = parents.filter(parent => parent.status === 'invalid');
      const missing = parents.filter(parent => parent.status === 'not-defined');
      const unverified = parents.filter(parent => parent.status === 'unverified');
      const changed = parents.filter(parent => parent.status === 'changed');
      if (f.suspendedReason) { status = 'invalid'; reason = 'Suspended: ' + f.suspendedReason; }
      else if (f.issues.length) { status = 'invalid'; reason = f.issues.map(issue => issue.message).join('; '); }
      else if (invalid.length) { status = 'invalid'; reason = 'Invalid dependencies: ' + invalid.map(parent => parent.id).join(', '); }
      else if (!f.defined) { status = 'not-defined'; reason = 'Not defined yet.'; }
      else if (missing.length) { status = 'invalid'; reason = 'Required dependencies not defined: ' + missing.map(parent => parent.id).join(', '); }
      else if (object.evaluatedAt < object.changedAt) { status = 'invalid'; reason = 'Upstream changed; re-evaluation required.'; }
      else if (f.unverifiedReason || unverified.length) {
        status = 'unverified'; reason = f.unverifiedReason || 'Unverified dependencies: ' + unverified.map(parent => parent.id).join(', ');
      } else if (object.verifiedAt < object.changedAt || changed.length) {
        status = 'changed'; reason = 'Changed since verified.';
      }
      checks.set(id, { id, name: object.name, status, reason });
    }
    return state.objects.map(object => checks.get(object.id));
  }
  function units(input) {
    record(input, 'Units');
    if (Object.keys(input).sort().join(',') !== Object.keys(DEFAULT_UNITS).sort().join(',')) fail('Units require length, force, time and mass.');
    Object.values(input).forEach(value => text(value, 'Unit'));
    return copy(input);
  }
  function validateReservations(items) {
    if (!Array.isArray(items)) fail('ID reservations must be an array.');
    const keys = new Set();
    for (const item of items) {
      record(item, 'ID reservation');
      if (item.owner !== null) text(item.owner, 'Reservation owner');
      if (!NAMESPACES.includes(item.namespace)) fail('Unknown ID namespace.');
      text(item.role, 'Reservation role');
      integer(item.start, 'First ID', 1, MAX_ID); integer(item.end, 'Last ID', item.start, MAX_ID);
      const key = JSON.stringify([item.owner, item.namespace, item.role]);
      if (keys.has(key)) fail('Duplicate ID reservation role.');
      keys.add(key);
    }
    for (const ns of NAMESPACES) {
      const sorted = items.filter(item => item.namespace === ns).sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) if (sorted[i].start <= sorted[i - 1].end) fail('Overlapping ' + ns + ' ID reservations.');
    }
  }
  function validateState(input) {
    const state = copy(record(input, 'Project snapshot'));
    if (state.format !== FORMAT || state.version !== VERSION) fail('Unsupported project-core snapshot.');
    text(state.name, 'Project name'); integer(state.revision, 'Model revision'); units(state.units);
    if (!Array.isArray(state.objects)) fail('Project objects must be an array.');
    if (!Array.isArray(state.retiredObjectIds)) fail('Retired object IDs must be an array.');
    state.retiredObjectIds.forEach(id => text(id, 'Retired object ID'));
    if (new Set(state.retiredObjectIds).size !== state.retiredObjectIds.length) fail('Duplicate retired object ID.');
    state.objects = state.objects.map(object => {
      const spec = specification(object);
      for (const key of ['changedAt', 'evaluatedAt', 'verifiedAt']) integer(object[key], key, 0, state.revision);
      if (object.evaluatedAt > object.changedAt) fail('Evaluation cannot be newer than the object evidence revision.');
      return { ...spec, changedAt: object.changedAt, evaluatedAt: object.evaluatedAt, verifiedAt: object.verifiedAt };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const g = graph(state.objects);
    if (state.retiredObjectIds.some(id => g.byId.has(id))) fail('An active object cannot reuse a retired identity.');
    validateReservations(state.reservations);
    if (state.reservations.some(item => item.owner !== null && !g.byId.has(item.owner) && !state.retiredObjectIds.includes(item.owner))) {
      fail('ID reservation refers to an unknown owner.');
    }
    return state;
  }

  function store(initial) {
    let state = freeze(validateState(initial));

    function readiness(options = {}) {
      const action = options.action || 'solve';
      if (!['solve', 'export-analysis', 'export-draft'].includes(action)) fail('Unknown readiness action.');
      const g = graph(state.objects), included = new Set();
      const roots = options.roots === undefined ? [...g.byId.keys()] : options.roots;
      if (!Array.isArray(roots)) fail('Readiness roots must be an array.');
      const queue = roots.slice();
      for (let i = 0; i < queue.length; i++) {
        const object = g.byId.get(queue[i]);
        if (!object) fail('Unknown readiness root: ' + queue[i]);
        if (included.has(object.id)) continue;
        included.add(object.id); queue.push(...object.dependsOn);
      }
      const checks = deriveChecks(state).filter(check => included.has(check.id));
      const blockers = checks.filter(check => check.status === 'invalid');
      const omissions = action === 'export-draft' ? blockers : [];
      return detached({ action, allowed: !blockers.length || (action === 'export-draft' && options.acknowledgeOmissions === true),
        blockers, omissions, warnings: checks.filter(check => ['changed', 'unverified'].includes(check.status)),
        information: checks.filter(check => check.status === 'not-defined') });
    }

    function begin(label) {
      text(label, 'Transaction label');
      const base = state, baseGraph = graph(base.objects);
      const draft = new Map(base.objects.map(object => [object.id, specification(object)]));
      const reservations = copy(base.reservations), revalidated = new Set(), acknowledged = new Set();
      let closed = false;
      const open = () => { if (closed) fail('Transaction is closed.'); };
      const objectAt = id => { if (!draft.has(id)) fail('Unknown object: ' + id); return draft.get(id); };
      function invalidateDraftEvidence(id) {
        // Drafts may temporarily contain forward references, so defer full graph
        // validation until preview. A later input edit invalidates earlier work
        // within this candidate as well as work from a previous transaction.
        const children = new Map();
        for (const object of draft.values()) for (const parent of object.dependsOn) {
          if (!children.has(parent)) children.set(parent, []);
          children.get(parent).push(object.id);
        }
        for (const affected of descendants([id], { children }, baseGraph)) {
          revalidated.delete(affected); acknowledged.delete(affected);
        }
      }

      function prepare() {
        open();
        const nextRevision = integer(base.revision + 1, 'Next model revision');
        const nextGraph = graph([...draft.values()]);
        const roots = new Set();
        for (const [id, spec] of draft) {
          const previous = baseGraph.byId.get(id);
          if (!previous || !equal(spec, specification(previous))) roots.add(id);
        }
        for (const id of baseGraph.byId.keys()) if (!draft.has(id)) roots.add(id);
        const affected = descendants(roots, baseGraph, nextGraph);
        const objects = [...draft.values()].map(spec => {
          const previous = baseGraph.byId.get(spec.id);
          const changed = affected.has(spec.id) || revalidated.has(spec.id);
          // A rename or parameter edit must not accidentally certify an object
          // whose inputs changed. Only its adapter can re-evaluate those inputs.
          const upstreamChanged = spec.dependsOn.some(id => affected.has(id));
          const evaluated = !previous || revalidated.has(spec.id) ||
            (roots.has(spec.id) && !upstreamChanged && previous.evaluatedAt === previous.changedAt);
          return { ...copy(spec), changedAt: changed ? nextRevision : previous.changedAt,
            evaluatedAt: changed && evaluated ? nextRevision : previous.evaluatedAt,
            verifiedAt: roots.has(spec.id) ? nextRevision : previous.verifiedAt };
        });
        const retiredObjectIds = [...base.retiredObjectIds, ...[...baseGraph.byId.keys()].filter(id => !draft.has(id))].sort();
        const next = { ...copy(base), revision: nextRevision, objects, reservations: copy(reservations), retiredObjectIds };
        const beforeAcknowledgement = new Map(deriveChecks(next).map(check => [check.id, check]));
        for (const id of acknowledged) {
          const check = beforeAcknowledgement.get(id);
          if (!check || !['changed', 'ok'].includes(check.status)) fail('Cannot acknowledge ' + id + ': repair or verify its evidence first.');
          if (check.status === 'changed') objects.find(object => object.id === id).verifiedAt = nextRevision;
        }
        const normalized = validateState(next);
        const afterById = new Map(normalized.objects.map(object => [object.id, object]));
        const changedIds = new Set([...baseGraph.byId.keys(), ...draft.keys()]);
        const changes = [];
        for (const id of [...changedIds].sort()) {
          const before = baseGraph.byId.get(id), after = afterById.get(id);
          if (!before || !after || !equal(before, after)) changes.push({ id, action: !before ? 'added' : !after ? 'removed' : 'updated' });
        }
        const allocations = normalized.reservations.filter(item => !base.reservations.some(previous => equal(item, previous)));
        if (!changes.length && !allocations.length) normalized.revision = base.revision;
        return { next: normalized, report: { label, baseRevision: base.revision, revision: normalized.revision,
          changes, affected: [...descendants(new Set([...roots, ...revalidated, ...acknowledged]), baseGraph, nextGraph)].sort(),
          reservations: allocations, checks: deriveChecks(normalized) } };
      }

      const transaction = {
        baseRevision: base.revision,
        putObject(input) {
          open(); const spec = specification(input);
          if (base.retiredObjectIds.includes(spec.id)) fail('Cannot reuse retired object identity: ' + spec.id);
          const previous = baseGraph.byId.get(spec.id);
          if (previous && previous.kind !== spec.kind) fail('An existing object cannot change kind.');
          if (!draft.has(spec.id) || !equal(draft.get(spec.id), spec)) invalidateDraftEvidence(spec.id);
          draft.set(spec.id, spec); return transaction;
        },
        removeObject(id) { open(); objectAt(id); invalidateDraftEvidence(id); draft.delete(id); return transaction; },
        revalidate(id, evidence = {}) {
          open(); const object = objectAt(id), updatedFacts = facts({ ...object.facts, ...copy(evidence) });
          if (!equal(object.facts, updatedFacts)) invalidateDraftEvidence(id);
          object.facts = updatedFacts; revalidated.add(id); return transaction;
        },
        acknowledge(id) { open(); objectAt(id); acknowledged.add(id); return transaction; },
        reserveIds(owner, namespace, role, count, options = {}) {
          open();
          if (owner !== null) objectAt(owner);
          integer(count, 'Reservation size', 1, MAX_ID); text(role, 'Reservation role');
          if (!NAMESPACES.includes(namespace)) fail('Unknown ID namespace.');
          const existing = reservations.find(item => item.owner === owner && item.namespace === namespace && item.role === role);
          if (existing) {
            if (count > existing.end - existing.start + 1) fail('ID block capacity exceeded; reserve an additional role instead of renumbering.');
            if (options.start !== undefined && options.start !== existing.start) fail('An existing ID block cannot move.');
            return detached(existing);
          }
          const high = reservations.filter(item => item.namespace === namespace).reduce((max, item) => Math.max(max, item.end), 0);
          const start = options.start === undefined ? high + 1 : options.start;
          const allocation = { owner, namespace, role, start, end: start + count - 1 };
          validateReservations([...reservations, allocation]);
          reservations.push(allocation);
          return detached(allocation);
        },
        preview() { return detached(prepare().report); },
        commit() {
          open();
          if (state.revision !== base.revision) fail('Outdated candidate: base revision ' + base.revision + ', current revision ' + state.revision + '. Recompute before committing.');
          const prepared = prepare();
          state = freeze(prepared.next); closed = true;
          return detached(prepared.report);
        },
        discard() { open(); closed = true; }
      };
      return Object.freeze(transaction);
    }
    return Object.freeze({
      snapshot: () => detached(state),
      getObject: id => { const object = state.objects.find(item => item.id === id); return object ? detached(object) : null; },
      checks: () => detached(deriveChecks(state)), readiness, begin
    });
  }

  function create(options = {}) {
    return store({ format: FORMAT, version: VERSION, name: options.name === undefined ? 'Untitled project' : options.name,
      revision: 0, units: units(options.units === undefined ? DEFAULT_UNITS : options.units), objects: [], reservations: [], retiredObjectIds: [] });
  }
  function restore(snapshot) { return store(typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot); }
  return Object.freeze({ create, restore, FORMAT, VERSION, MAX_ID });
}));
