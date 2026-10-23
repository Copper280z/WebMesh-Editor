(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./modeling.js'));
  else root.WebMeshPrimitiveProject = factory(root.WebMeshModeling);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Modeling) {
  'use strict';
  const GENERATOR = 'plate-v1';
  const copy = value => JSON.parse(JSON.stringify(value));
  function parameters(input) {
    const p = copy(input), number = (v, label) => { if (typeof v !== 'number' || !Number.isFinite(v)) throw Error(label + ' must be finite.'); return v; };
    if (!Array.isArray(p.size) || p.size.length !== 3 || !Array.isArray(p.origin) || p.origin.length !== 3 || !Array.isArray(p.divisions) || p.divisions.length !== 3) throw Error('Plate size, origin and divisions require three components.');
    p.size.forEach(v => number(v, 'Size')); p.origin.forEach(v => number(v, 'Origin'));
    if (p.size[2] !== 0 || !(p.size[0] > 0 && p.size[1] > 0)) throw Error('A plate needs positive X/Y dimensions and zero Z size; use shell thickness for its section.');
    if (!p.divisions.every(v => Number.isInteger(v) && v > 0) || p.divisions[2] !== 1) throw Error('Plate divisions must be positive integers, with W = 1.');
    if (!['quad', 'tri'].includes(p.topology) || ![1, 2].includes(p.order)) throw Error('Choose quad/triangle shells and element order 1 or 2.');
    return { size: p.size, origin: p.origin, divisions: p.divisions, topology: p.topology, order: p.order };
  }
  function rootFor(state, owner) {
    const objects = state?.project.objects || [];
    return objects.find(o => o.definition.generator === GENERATOR && [o.id, o.definition.section, o.definition.material].includes(owner)) || null;
  }
  function inputs(state, owner) {
    const root = rootFor(state, owner); if (!root) throw Error('This owner has no plate parameter editor.');
    const section = state.project.objects.find(o => o.id === root.definition.section), material = state.project.objects.find(o => o.id === root.definition.material);
    if (!section || !material) throw Error('The plate material or section is missing.');
    return { id: root.id, name: root.name, parameters: copy(root.definition.parameters), thickness: section.definition.cards[0].value.t,
      material: copy(material.definition.parameters) };
  }
  function build(input, state, nextIds) {
    if (!input.id || typeof input.name !== 'string' || !input.name.trim()) throw Error('Enter a plate name.');
    const p = parameters(input.parameters), previous = rootFor(state, input.id);
    if (state?.project.objects.some(o => o.id === input.id) && (!previous || previous.id !== input.id)) throw Error('This object is not an editable plate.');
    if (previous && previous.facts.suspendedReason) throw Error('Repair the suspended plate before regeneration.');
    const fresh = ns => Math.max(nextIds[ns] || 1, ...((state?.project.reservations || []).filter(r => r.namespace === ns).map(r => r.end + 1)));
    const before = previous?.definition;
    const sameLayout = before && JSON.stringify([before.parameters.divisions, before.parameters.topology, before.parameters.order]) === JSON.stringify([p.divisions, p.topology, p.order]);
    const revision = sameLayout ? before.layout.revision : (before?.layout.revision || 0) + 1;
    const layout = sameLayout ? copy(before.layout) : { revision, node: fresh('node'), element: fresh('element') };
    const materialId = before?.material || input.id + '/material', sectionId = before?.section || input.id + '/section';
    const oldObject = id => state?.project.objects.find(o => o.id === id);
    const mid = oldObject(materialId)?.definition.cards[0].id || fresh('material'), pid = oldObject(sectionId)?.definition.cards[0].id || fresh('property');
    const material = input.material;
    if (!material || !Number.isFinite(material.E) || material.E <= 0 || !Number.isFinite(material.nu) || material.nu <= -1 || material.nu >= .5 || !Number.isFinite(material.rho) || material.rho < 0) throw Error('Material needs E > 0, −1 < ν < 0.5 and density ≥ 0.');
    if (!Number.isFinite(input.thickness) || input.thickness <= 0) throw Error('Shell thickness must be positive.');
    const mesh = Modeling.createPrimitive({ ...p, kind: 'plate', pid, startNode: layout.node, startElement: layout.element });
    const validation = Modeling.validateMesh(mesh); if (!validation.valid) throw Error(validation.errors.join('\n'));
    const nodeRole = 'mesh-' + revision + '/nodes', elementRole = 'mesh-' + revision + '/elements';
    const cards = mesh.nodes.map((n, i) => ({ family: 'nodes', id: n.id, role: nodeRole + '/' + i, allocationRole: nodeRole, value: { x: n.x, y: n.y, z: n.z, cp: 0, cd: 0, ps: '' } }));
    for (const [i, e] of mesh.elements.entries()) cards.push({ family: 'elems', bucket: { CQUAD4: 'quad', CQUAD8: 'quad', CTRIA3: 'tri', CTRIA6: 'tri' }[e.type], id: e.id, role: elementRole + '/' + i, allocationRole: elementRole, value: { type: e.type, eid: e.id, pid, n: e.nodes } });
    const m = { E: material.E, nu: material.nu, rho: material.rho };
    const objects = [
      { id: materialId, kind: 'material', name: input.name + ' · Material', definition: { parameters: m, cards: [{ family: 'materials', id: mid, role: 'elastic', value: { type: 'MAT1', mid, ...m, G: m.E / (2 * (1 + m.nu)) } }] } },
      { id: sectionId, kind: 'section', name: input.name + ' · Section', dependsOn: [materialId], definition: { cards: [{ family: 'properties', id: pid, role: 'shell', value: { type: 'PSHELL', pid, mid1: mid, mid2: mid, t: input.thickness } }] } },
      { id: input.id, kind: 'mesh', name: input.name, dependsOn: [sectionId], definition: { generator: GENERATOR, parameters: p, layout, section: sectionId, material: materialId, cards } }
    ];
    // Re-evaluate only this generator's bundle. Other dependents are surfaced by
    // the core as Invalid until their own adapter re-evaluates them.
    const reservations = [{ owner: input.id, namespace: 'node', role: nodeRole, start: layout.node, count: mesh.nodes.length }, { owner: input.id, namespace: 'element', role: elementRole, start: layout.element, count: mesh.elements.length }];
    return { mesh, newMeshIdentity: !!before && !sameLayout, request: { label: (before ? 'Update ' : 'Create ') + input.name, objects, reservations } };
  }
  function conversion(state, owner) {
    const root = rootFor(state, owner); if (!root) throw Error('This object has no plate conversion workflow.');
    const ids = [root.id, root.definition.section, root.definition.material], objects = state.project.objects;
    const dependents = objects.filter(o => !ids.includes(o.id) && o.dependsOn.some(id => ids.includes(id)));
    if (dependents.length) throw Error('Convert or repair dependent objects first: ' + dependents.map(o => o.name).join(', ') + '.');
    return { label: 'Convert ' + root.name + ' to plain cards', convertToPlain: ids };
  }
  return Object.freeze({ build, inputs, rootFor, conversion, GENERATOR });
}));
