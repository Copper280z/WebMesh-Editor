(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./project.js'));
  else root.WebMeshOwnership = factory(root.WebMeshProject);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Project) {
  'use strict';
  // The adapter deliberately supports a closed set of generated semantic cards.
  // Unknown hand-card references fail closed, rather than guessing from integers.
  const FORMAT = 'webmesh-engine-ownership';
  const families = { nodes: 'node', elems: 'element', masses: 'element', properties: 'property', materials: 'material', coords: 'coordinate' };
  const buckets = { CTRIA3: 'tri', CTRIA6: 'tri', CQUAD4: 'quad', CQUAD8: 'quad', CTETRA: 'tet', CHEXA: 'hex', CROD: 'rod', CBUSH: 'bush', RBE2: 'rbe2' };
  const known = new Set(('GRID CORD1R CORD1C CORD2R CORD2C CORD2S CTRIA3 CTRIA6 CQUAD4 CQUAD8 CTETRA CHEXA CPENTA CPYRAM CROD CBAR CBEAM CBUSH RBE2 RBE3 CONM2 PSHELL PSOLID PROD PBAR PBEAM PCOMP PBUSH MAT1 MAT8 FORCE MOMENT PLOAD2 PLOAD4 LOAD SPC SPC1 TEMP TEMPD ENDDATA').split(' '));
  known.add('CEND'); known.add('BEGIN BULK');
  const copy = value => JSON.parse(JSON.stringify(value));
  const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
  const equal = (a, b) => canonical(a) === canonical(b);
  function fail(message) { throw Error(message); }
  function id(value) { if (!Number.isInteger(value) || value < 1 || value > 2147483647) fail('Card IDs must be positive 32-bit integers.'); return value; }
  function nonempty(value) { if (typeof value !== 'string' || !value.trim()) fail('Owner and role identifiers must be nonempty strings.'); return value; }
  function key(family, number) { if (!families[family]) fail('Unsupported owned family: ' + family); return families[family] + ':' + id(number); }
  function rows(semantic) {
    const result = new Map();
    const add = (family, number, value, bucket) => {
      const k = key(family, Number(number));
      if (result.has(k)) fail('Duplicate card identity: ' + k);
      result.set(k, { family, id: Number(number), value, ...(bucket ? { bucket } : {}) });
    };
    for (const family of Object.keys(families)) {
      if (family === 'elems') for (const [bucket, records] of Object.entries(semantic.elems || {})) for (const value of records) add(family, value.eid, value, bucket);
      else for (const [number, value] of semantic[family] || []) add(family, number, value);
    }
    return result;
  }
  function snapshot(model) {
    const result = {};
    for (const family of Object.keys(families)) result[family] = family === 'elems' ? copy(model.elems || {}) : [...(model[family] || new Map())].map(([i, v]) => [i, copy(v)]).sort((a, b) => a[0] - b[0]);
    for (const family of ['loads', 'spc', 'spc1', 'temperatures']) result[family] = copy(model[family] || (family === 'loads' ? {} : []));
    return result;
  }
  function put(semantic, row) {
    remove(semantic, key(row.family, row.id));
    if (row.family === 'elems') (semantic.elems[row.bucket] ||= []).push(copy(row.value));
    else { (semantic[row.family] ||= []).push([row.id, copy(row.value)]); semantic[row.family].sort((a, b) => a[0] - b[0]); }
  }
  function remove(semantic, k) {
    for (const family of Object.keys(families)) {
      if (family === 'elems') for (const bucket of Object.keys(semantic.elems || {})) semantic.elems[bucket] = semantic.elems[bucket].filter(v => key(family, v.eid) !== k);
      else semantic[family] = (semantic[family] || []).filter(([i]) => key(family, i) !== k);
    }
  }
  function validateGenerated(card, kind) {
    const k = key(card.family, card.id), v = card.value;
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail(k + ': missing semantic values.');
    const type = card.family === 'nodes' ? 'GRID' : v.type;
    const allowed = {
      GRID: ['x', 'y', 'z', 'cp', 'cd', 'ps', 'seid'],
      MAT1: ['type', 'mid', 'E', 'G', 'nu', 'rho'],
      PSHELL: ['type', 'pid', 'mid1', 'mid2', 'mid3', 'mid4', 't'], PSOLID: ['type', 'pid', 'mid'], PROD: ['type', 'pid', 'mid', 'A'],
      PBUSH: ['type', 'pid', 'K', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6'],
      RBE2: ['type', 'eid', 'gn', 'cm', 'deps'], CBUSH: ['type', 'eid', 'pid', 'n', 'orient', 'cid', 's', 'ocid', 'si']
    };
    const fields = allowed[type] || (buckets[type] ? ['type', 'eid', 'pid', 'n', 'zoffs'] : null);
    if (!fields || Object.keys(v).some(field => !fields.includes(field))) fail(k + ': unsupported generated card or field.');
    const expected = type === 'GRID' ? 'nodes' : type === 'MAT1' ? 'materials' : type.startsWith('P') ? 'properties' : 'elems';
    if (card.family !== expected || card.family === 'elems' && card.bucket !== buckets[type]) fail(k + ': wrong card family or bucket.');
    const ownerKinds = { nodes: ['mesh', 'point'], elems: ['mesh', 'connection'], properties: ['section', 'template'], materials: ['material'] };
    if (!ownerKinds[card.family]?.includes(kind)) fail(k + ': ' + kind + ' cannot own this family.');
    if (type !== 'GRID' && v[expected === 'materials' ? 'mid' : expected === 'properties' ? 'pid' : 'eid'] !== card.id) fail(k + ': card ID disagrees with its values.');
    const finite = (value, label) => { if (typeof value !== 'number' || !Number.isFinite(value)) fail(k + ': ' + label + ' must be finite.'); return value; };
    if (type === 'GRID') { for (const f of ['x', 'y', 'z']) finite(v[f], f); for (const f of ['cp', 'cd']) if (v[f] != null && v[f] !== 0) id(v[f]); }
    if (type === 'MAT1' && v.G != null && !(finite(v.G, 'G') > 0)) fail(k + ': G must be positive.');
    if (type === 'PSHELL') { id(v.mid1); for (const f of ['mid2', 'mid3', 'mid4']) if (v[f] != null) id(v[f]); }
    if (type === 'PSOLID' || type === 'PROD') id(v.mid);
    if (v.zoffs != null) finite(v.zoffs, 'offset');
    if (card.family === 'elems' && type !== 'RBE2') id(v.pid);
    if (type === 'MAT1' && (!(finite(v.E, 'E') > 0) || !(finite(v.nu, 'nu') > -1 && v.nu < 0.5) || finite(v.rho, 'rho') < 0)) fail(k + ': invalid material constants.');
    if (type === 'PSHELL' && !(finite(v.t, 'thickness') > 0)) fail(k + ': thickness must be positive.');
    if (type === 'PROD' && !(finite(v.A, 'area') > 0)) fail(k + ': area must be positive.');
    if (type === 'PBUSH') {
      const stiffness = Array.from({ length: 6 }, (_, i) => finite(v['K' + (i + 1)], 'stiffness'));
      if (v.K !== 'K' || stiffness.some(x => x < 0) || !stiffness.some(x => x > 0)) fail(k + ': invalid PBUSH stiffness.');
    }
    if (card.family === 'elems') {
      const ns = type === 'RBE2' ? [v.gn, ...(v.deps || [])] : v.n;
      const counts = { CTRIA3: [3], CTRIA6: [6], CQUAD4: [4], CQUAD8: [8], CTETRA: [4, 10], CHEXA: [8, 20], CROD: [2], CBUSH: [2] };
      if (!Array.isArray(ns) || (type === 'RBE2' ? ns.length < 2 : !counts[type].includes(ns.length))) fail(k + ': incorrect connectivity count.');
      ns.forEach(id); if (new Set(ns).size !== ns.length) fail(k + ': repeated connectivity.');
      if (type === 'RBE2' && (!/^[1-6]+$/.test(v.cm) || new Set(v.cm).size !== v.cm.length)) fail(k + ': invalid dependent components.');
      if (type === 'CBUSH' && (v.orient?.kind !== 'x' || !Array.isArray(v.orient.x) || v.orient.x.length !== 3 || !v.orient.x.every(Number.isFinite) || !Math.hypot(...v.orient.x))) fail(k + ': explicit CBUSH orientation required.');
    }
    return { family: card.family, id: card.id, value: copy(v), ...(card.bucket ? { bucket: card.bucket } : {}) };
  }
  function references(semantic, opaque = []) {
    const cards = rows(semantic), refs = [], unsupported = new Set();
    const add = (from, ns, value) => { if (value != null && value !== '' && Number(value) > 0) refs.push({ from, to: ns + ':' + id(Number(value)) }); };
    const each = (from, ns, values) => (values || []).forEach(v => add(from, ns, v));
    for (const [from, { family, value: v }] of cards) {
      const type = family === 'nodes' ? 'GRID' : v.type;
      if (!known.has(type)) unsupported.add(type || family);
      if (family === 'nodes') { add(from, 'coordinate', v.cp); add(from, 'coordinate', v.cd); }
      if (family === 'coords') { add(from, 'coordinate', v.rid); each(from, 'node', v.nodes); }
      if (family === 'elems') {
        each(from, 'node', v.n || v.nids);
        if (type === 'RBE2') { add(from, 'node', v.gn); each(from, 'node', v.deps || v.gmi); }
        if (type === 'RBE3') { add(from, 'node', v.refgrid ?? v.gn); each(from, 'node', v.inds); for (const g of v.groups || []) each(from, 'node', g.gids); for (const u of v.um || []) add(from, 'node', u.gm); }
        add(from, 'property', v.pid); add(from, 'node', v.orient?.g0);
        add(from, 'coordinate', v.cid); add(from, 'coordinate', v.ocid);
        if (Number.isInteger(v.thetaMcid)) add(from, 'coordinate', v.thetaMcid);
      }
      if (family === 'masses') { add(from, 'node', v.g ?? v.nid); add(from, 'coordinate', v.cid); }
      if (family === 'properties') { for (const [f, x] of Object.entries(v)) if (/^mid\d*$/i.test(f)) add(from, 'material', x); for (const ply of v.plies || []) add(from, 'material', ply.mid); add(from, 'coordinate', v.cordm); }
    }
    for (const [family, list] of Object.entries(semantic.loads || {})) for (const [i, v] of list.entries()) {
      const from = 'load:' + family + ':' + i;
      for (const f of ['nid', 'g', 'g1', 'g34']) add(from, 'node', v[f]);
      each(from, 'node', v.nodes); add(from, 'element', v.eid); each(from, 'element', v.eids); add(from, 'coordinate', v.cid);
    }
    for (const family of ['spc', 'spc1']) for (const [i, v] of (semantic[family] || []).entries()) { const from = family + ':' + i; add(from, 'node', v.g ?? v.nid); each(from, 'node', v.nodes); }
    for (const [i, v] of (semantic.temperatures || []).entries()) each('temperature:' + i, 'node', v.nodeIds);
    let bulk = !opaque.some(card => card?.name === 'BEGIN BULK');
    for (const card of opaque) if (card?.kind === 'card') {
      if (card.name === 'BEGIN BULK') { bulk = true; continue; }
      if (!bulk) {
        // Case-control SETs can select grid/element identities. Keep them
        // blocked until their use and contents are indexed together.
        if (!/^(SOL\b|CEND$|TITLE\b|SUBTITLE\b|LABEL\b|SUBCASE\b|ECHO\b|SPC\s*=|LOAD\s*=|DISPLACEMENT\b|STRESS\b|STRAIN\b|SPCFORCES\b|OLOAD\b)/.test(card.name)) unsupported.add('case control ' + card.name);
        continue;
      }
      const safeParameter = card.name === 'PARAM' && ['WTMASS', 'POST', 'AUTOSPC', 'BAILOUT', 'PRTMAXIM', 'PRGPST'].includes(String(card.tokens?.[1]).toUpperCase());
      if (card.name === 'GRAV') add('GRAV:' + card.tokens?.[1], 'coordinate', card.tokens?.[2]);
      else if (!known.has(card.name) && !safeParameter) unsupported.add(card.name);
      // The compact import model omits PLOAD4's face selectors and CID.
      // Read these from retained source as well; never infer them from pressure values.
      if (card.name === 'PLOAD4') {
        const t = card.tokens || [], from = 'PLOAD4:' + t[1] + ':' + t[2];
        add(from, 'node', t[7]); add(from, 'node', t[8]); add(from, 'coordinate', t[9]);
      }
    }
    return { cards, refs, unsupported: [...unsupported].sort(), missing: refs.filter(ref => !cards.has(ref.to)) };
  }
  function validateRigidDependents(semantic, owners) {
    const occupied = new Map();
    const occupy = (nid, components, label, reject) => {
      for (const c of String(components || "")) {
        const k = nid + ":" + c;
        if (reject && occupied.has(k)) fail(label + ': GRID ' + nid + ' component ' + c + ' is already constrained or dependent (' + occupied.get(k) + ').');
        occupied.set(k, label);
      }
    };
    for (const [nid, n] of semantic.nodes) occupy(nid, n.ps, 'permanent GRID constraint', false);
    for (const s of semantic.spc || []) occupy(s.g ?? s.nid, s.c ?? s.components, 'SPC ' + s.sid, false);
    for (const s of semantic.spc1 || []) for (const nid of s.nodes) occupy(nid, s.components ?? s.c, 'SPC1 ' + s.sid, false);
    const elements = Object.values(semantic.elems).flat();
    for (const e of elements) {
      if (e.type === 'RBE2' && !owners.has('element:' + e.eid)) for (const nid of e.deps || []) occupy(nid, e.cm, 'RBE2 ' + e.eid, false);
      if (e.type === 'RBE3') {
        if (e.um?.length) for (const pair of e.um) occupy(pair.gm, pair.cm, 'RBE3 ' + e.eid, false);
        else occupy(e.refgrid ?? e.gn, e.refc ?? e.cm, 'RBE3 ' + e.eid, false);
      }
    }
    for (const e of elements) if (e.type === 'RBE2' && owners.has('element:' + e.eid)) for (const nid of e.deps || []) occupy(nid, e.cm, 'RBE2 ' + e.eid, true);
  }
  function empty() { return { format: FORMAT, version: 1, project: Project.create().snapshot(), owners: [] }; }
  function validate(state, semantic) {
    const s = state || empty();
    if (s.format !== FORMAT || s.version !== 1 || !Array.isArray(s.owners)) fail('Unsupported ownership snapshot.');
    const project = Project.restore(s.project), objects = new Map(project.snapshot().objects.map(o => [o.id, o]));
    const definitions = new Map([...objects].map(([id,o]) => [id, new Map((o.definition.cards || []).map(c => [c.role,c]))]));
    const used = new Set(), roles = new Set(), all = semantic && rows(semantic);
    for (const entry of s.owners) {
      const object = objects.get(entry.owner); if (!object) fail('Unknown card owner: ' + entry.owner);
      const role = JSON.stringify([entry.owner, nonempty(entry.role)]);
      if (roles.has(role) || used.has(entry.key)) fail('Duplicate owner role or card identity.');
      roles.add(role); used.add(entry.key);
      const card = validateGenerated(entry.card, object.kind);
      if (entry.key !== key(card.family, card.id)) fail('Ownership key mismatch.');
      const allocation = s.project.reservations.find(r => r.owner === entry.owner && r.role === (entry.allocationRole || entry.role) && r.namespace === families[card.family]);
      if (!allocation || card.id < allocation.start || card.id > allocation.end) fail('Owned card has no matching ID reservation: ' + entry.key);
      const definition = definitions.get(object.id).get(entry.role);
      if (!definition || definition.allocationRole !== entry.allocationRole || !equal(validateGenerated(definition, object.kind), card)) fail('Generated card disagrees with owner definition: ' + entry.key);
      if (all && !equal(all.get(entry.key), card)) fail(entry.key + ' is owned by ' + object.name + ' (' + entry.role + '). Edit its owner or explicitly convert the object to plain cards.');
    }
    for (const object of objects.values()) {
      const expected = object.facts.suspendedReason ? [] : object.definition.cards || [];
      const definedRoles = new Set();
      for (const card of expected) {
        validateGenerated(card, object.kind);
        if (definedRoles.has(card.role)) fail('Duplicate definition role: ' + object.id + '/' + card.role);
        definedRoles.add(card.role);
        if (!roles.has(JSON.stringify([object.id, card.role]))) fail('Owner definition is missing a generated card: ' + object.id + '/' + card.role);
      }
    }
    return project;
  }
  function guard(state, before, after, opaque = []) {
    if (!state) return;
    validate(state, after);
    validateRigidDependents(after, new Map(state.owners.map(e => [e.key,e])));
    const a = references(before, opaque), b = references(after, opaque);
    const removed = [...a.cards.keys()].filter(k => !b.cards.has(k));
    if (removed.length && b.unsupported.length) fail('Cannot prove references for ' + b.unsupported.join(', ') + '; removal is blocked.');
    const existingMissing = new Set(a.missing.map(canonical));
    const newlyMissing = b.missing.filter(r => !existingMissing.has(canonical(r)));
    if (newlyMissing.length) fail('Dangling reference: ' + newlyMissing.map(r => r.from + ' → ' + r.to).join(', '));
    // Hand edits may never recycle a retired generated identity.
    for (const [k] of b.cards) if (!a.cards.has(k) && state.project.reservations.some(r => k.startsWith(r.namespace + ':') && Number(k.split(':')[1]) >= r.start && Number(k.split(':')[1]) <= r.end)) fail('Reserved generated identity: ' + k);
  }
  function preview(semantic, previous, request, opaque = []) {
    const state = copy(previous || empty()), project = validate(state, semantic);
    const before = rows(semantic), after = copy(semantic), nextCards = new Map(before), owners = new Map(state.owners.map(e => [e.key, e]));
    const previousByKey = new Map(owners), previousByRole = new Map(state.owners.map(e => [JSON.stringify([e.owner,e.role]),e]));
    const objects = request.objects || [], removed = request.removeObjects || [], converted = request.convertToPlain || [];
    const touched = [...objects.map(o => o.id), ...removed, ...converted];
    if (new Set(touched).size !== touched.length) fail('An object may be changed only once per transaction.');
    const tx = project.begin(request.label || 'Change project cards');
    for (const object of objects) tx.putObject(object);
    for (const block of request.reservations || []) tx.reserveIds(block.owner, block.namespace, block.role, block.count, { start: block.start });
    for (const owner of [...removed, ...converted]) { if (!project.getObject(owner)) fail('Unknown owner: ' + owner); tx.removeObject(owner); }
    for (const [k, entry] of owners) if (touched.includes(entry.owner)) { owners.delete(k); if (!converted.includes(entry.owner)) nextCards.delete(k); }
    for (const object of objects) {
      const roles = new Set();
      for (const spec of object.facts?.suspendedReason ? [] : object.definition?.cards || []) {
        const role = nonempty(spec.role); if (roles.has(role)) fail('Duplicate role: ' + role); roles.add(role);
        const card = validateGenerated(spec, object.kind), k = key(card.family, card.id), old = previousByKey.get(k);
        if (owners.has(k) || before.has(k) && (!old || old.owner !== object.id || old.role !== role)) fail('Cannot replace or adopt another owner or hand card: ' + k);
        const previousRole = previousByRole.get(JSON.stringify([object.id,role]));
        if (previousRole && (previousRole.key !== k || previousRole.card.value.type !== card.value.type)) fail('Stable role cannot change card identity: ' + role);
        if (spec.allocationRole) {
          const block = (request.reservations || []).find(r => r.owner === object.id && r.namespace === families[card.family] && r.role === spec.allocationRole);
          const previousBlock = state.project.reservations.find(r => r.owner === object.id && r.namespace === families[card.family] && r.role === spec.allocationRole);
          const start = block?.start ?? previousBlock?.start, end = block ? block.start + block.count - 1 : previousBlock?.end;
          if (!start || card.id < start || card.id > end) fail('Card is outside its reserved block: ' + k);
        } else tx.reserveIds(object.id, families[card.family], role, 1, { start: card.id });
        nextCards.set(k, card); owners.set(k, { key: k, owner: object.id, role, card, ...(spec.allocationRole ? { allocationRole: spec.allocationRole } : {}) });
      }
    }
    for (const family of Object.keys(families)) {
      if (family === 'elems') for (const bucket of Object.keys(after.elems)) after.elems[bucket] = [];
      else after[family] = [];
    }
    for (const card of nextCards.values()) {
      if (card.family === 'elems') (after.elems[card.bucket] ||= []).push(copy(card.value));
      else after[card.family].push([card.id,copy(card.value)]);
    }
    for (const family of Object.keys(families)) if (family !== 'elems') after[family].sort((a,b)=>a[0]-b[0]);
    const affected = new Set(tx.preview().affected);
    for (const object of objects) if (affected.has(object.id)) tx.revalidate(object.id);
    const corePreview = tx.preview(); tx.commit();
    const next = { ...state, project: project.snapshot(), owners: [...owners.values()].sort((a, b) => a.key.localeCompare(b.key)) };
    validate(next, after);
    const index = references(after, opaque);
    if (index.unsupported.length) fail('Cannot prove references for ' + index.unsupported.join(', ') + '; project generation is blocked.');
    if (index.missing.length) fail('Dangling reference: ' + index.missing.map(r => r.from + ' → ' + r.to).join(', '));
    validateRigidDependents(after, owners);
    for (const ref of index.refs) {
      const from = owners.get(ref.from), to = owners.get(ref.to);
      if (from && to && from.owner !== to.owner && !project.getObject(from.owner).dependsOn.includes(to.owner)) fail(from.owner + ' must declare dependency on ' + to.owner + '.');
    }
    const nextRows = rows(after), changes = [];
    for (const k of new Set([...before.keys(), ...nextRows.keys()])) if (!equal(before.get(k), nextRows.get(k))) changes.push({ key: k, action: !before.has(k) ? 'add' : !nextRows.has(k) ? 'remove' : 'update', owner: owners.get(k)?.owner || previousByKey.get(k)?.owner || null, before: before.get(k) || null, after: nextRows.get(k) || null });
    const previousOwners = new Map(state.owners.map(e => [e.key, { owner: e.owner, role: e.role }]));
    const nextOwners = new Map(next.owners.map(e => [e.key, { owner: e.owner, role: e.role }]));
    const ownershipChanges = [...new Set([...previousOwners.keys(), ...nextOwners.keys()])].filter(k => !equal(previousOwners.get(k), nextOwners.get(k))).map(k => ({ key: k, before: previousOwners.get(k) || null, after: nextOwners.get(k) || null }));
    return copy({ semantic: after, ownership: next, changes, ownershipChanges, project: corePreview });
  }
  return Object.freeze({ snapshot, rows, put, validate, preview, guard, references, empty, equal, canonical });
}));
