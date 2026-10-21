/* CAD feature recognition and selection-driven tool inference.
 *
 * Holes, bosses, fillets and chamfers are recognized from exact topology:
 * cylinder descriptors, material side, and per-solid dihedral angles. Given a
 * selection, `infer` proposes the preparation actions a user most likely
 * wants; for a solid that cannot be mapped, `fixes` proposes concrete slices
 * or feature removals that address each reported reason.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WebMeshCadFeatures = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => Math.hypot(a[0], a[1], a[2]);
  const unit = a => { const n = norm(a); return n > 0 ? scale(a, 1 / n) : [0, 0, 0]; };
  const fmt = (value, digits = 3) => Number(value).toLocaleString(undefined, { maximumSignificantDigits: digits });
  const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  function context(topology) {
    const faces = new Map((topology.faces || []).map(f => [Number(f.id), f]));
    const edges = new Map((topology.edges || []).map(e => [Number(e.id), e]));
    const vertices = new Map((topology.vertices || []).map(v => [Number(v.id), v.point]));
    const volumes = new Map((topology.volumes || []).map(v => [Number(v.id), v]));
    const angles = new Map();
    for (const volume of volumes.values()) for (const [edge, angle] of volume.edgeAngles || []) {
      if (!angles.has(Number(edge))) angles.set(Number(edge), new Map());
      angles.get(Number(edge)).set(Number(volume.id), angle);
    }
    const faceEdges = new Map(), edgeFaces = new Map();
    for (const face of faces.values()) {
      const list = (face.orientedLoops || []).flat().map(([e]) => Number(e));
      faceEdges.set(Number(face.id), list);
      for (const e of list) { if (!edgeFaces.has(e)) edgeFaces.set(e, new Set()); edgeFaces.get(e).add(Number(face.id)); }
    }
    const bounds = topology.bounds || [0, 0, 0, 1, 1, 1];
    const span = Math.max(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2], 1e-9);
    return { topology, faces, edges, vertices, volumes, angles, faceEdges, edgeFaces, bounds, span };
  }

  function edgeAngle(ctx, edge, volume) {
    const map = ctx.angles.get(Number(edge));
    if (!map) return null;
    if (volume != null) return map.get(Number(volume)) ?? null;
    return map.values().next().value ?? null;
  }

  function neighbors(ctx, faceId) {
    const result = new Set();
    for (const e of ctx.faceEdges.get(faceId) || []) for (const f of ctx.edgeFaces.get(e) || []) if (f !== faceId) result.add(f);
    return result;
  }

  function faceVertices(ctx, faceId) {
    const set = new Set();
    for (const e of ctx.faceEdges.get(faceId) || []) for (const v of ctx.edges.get(e)?.vertices || []) if (v != null) set.add(Number(v));
    return [...set];
  }

  function axialExtent(ctx, faceIds, origin, axis) {
    let lo = Infinity, hi = -Infinity;
    for (const f of faceIds) for (const v of faceVertices(ctx, f)) {
      const p = ctx.vertices.get(v); if (!p) continue;
      const t = dot(sub(p, origin), axis); lo = Math.min(lo, t); hi = Math.max(hi, t);
    }
    return Number.isFinite(lo) ? [lo, hi] : [0, 0];
  }

  /* ------------------------------------------------------------------ */
  /* Recognition                                                         */
  /* ------------------------------------------------------------------ */

  function sameAxis(a, b, tolerance) {
    if (Math.abs(a.radius - b.radius) > Math.max(a.radius, b.radius) * 1e-5) return false;
    const axis = unit(a.axis);
    if (Math.abs(Math.abs(dot(axis, unit(b.axis))) - 1) > 1e-6) return false;
    const offset = sub(b.origin, a.origin);
    return norm(sub(offset, scale(axis, dot(offset, axis)))) < tolerance;
  }

  function recognize(topology) {
    const ctx = context(topology);
    const tolerance = ctx.span * 1e-6;
    const features = [], byFace = new Map();
    // Sheets (faces of no solid) are midsurfaces, not features of a solid.
    const cylinders = [...ctx.faces.values()].filter(f => f.surface && f.surface.kind === 'cylinder' && (f.volumes || []).length);
    // One bore is often several faces: split by slices, or interrupted where it
    // crosses a pocket and only grazes the floor. Coaxial, equal-radius pieces
    // with a compatible material side form one feature, touching or not.
    const parent = cylinders.map((_, i) => i);
    const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    const compatible = (a, b) => a == null || b == null || a === b;
    for (let i = 0; i < cylinders.length; i++) for (let j = i + 1; j < cylinders.length; j++) {
      if (sameAxis(cylinders[i].surface, cylinders[j].surface, tolerance) && compatible(cylinders[i].concave, cylinders[j].concave)) parent[find(j)] = find(i);
    }
    const byRoot = new Map();
    cylinders.forEach((face, i) => { const r = find(i); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(face); });
    const groups = [...byRoot.values()].map(list => ({ surface: list[0].surface, concave: list.map(f => f.concave).find(c => c != null) ?? null, faces: list.map(f => Number(f.id)) }));
    // Sweep angle of each connected run of pieces, for telling full bores from partial arcs.
    const pieceSweeps = group => {
      const left = new Set(group.faces), out = [], axis = unit(group.surface.axis);
      while (left.size) {
        const start = left.values().next().value, run = [start], queue = [start]; left.delete(start);
        while (queue.length) for (const n of neighbors(ctx, queue.pop())) if (left.has(n)) { left.delete(n); run.push(n); queue.push(n); }
        const [lo, hi] = axialExtent(ctx, run, group.surface.origin, axis);
        const area = run.reduce((sum, f) => sum + (Number(ctx.faces.get(f).area) || 0), 0);
        out.push(area / (group.surface.radius * Math.max(hi - lo, 1e-12)));
      }
      return out;
    };
    let holeCount = 0, bossCount = 0, filletCount = 0;
    for (const group of groups) {
      const s = group.surface, axis = unit(s.axis);
      const [lo, hi] = axialExtent(ctx, group.faces, s.origin, axis);
      const depth = Math.max(hi - lo, 1e-12);
      const sweeps = pieceSweeps(group), sweep = Math.max(...sweeps);
      const tangentEdges = group.faces.flatMap(f => (ctx.faceEdges.get(f) || []).filter(e => {
        const owners = [...(ctx.edgeFaces.get(e) || [])];
        if (owners.every(o => group.faces.includes(o))) return false;
        const a = edgeAngle(ctx, e);
        return a != null && Math.abs(a - 180) < 8;
      }));
      const solids = [...new Set(group.faces.flatMap(f => ctx.faces.get(f).volumes || []))];
      const full = sweep > 2 * Math.PI * 0.97;
      if (full || (!tangentEdges.length && (sweep > Math.PI * 1.2 || sweeps.length > 1))) {
        const kind = group.concave === false ? 'boss' : 'hole';
        const faces = group.faces.slice();
        // Coaxial chamfers/countersinks and blind-hole floors join the feature.
        for (const f of group.faces) for (const n of neighbors(ctx, f)) {
          if (faces.includes(n)) continue;
          const face = ctx.faces.get(n);
          if (face.type === 'Cone') { faces.push(n); continue; }
          if (face.surface?.kind === 'plane' && Math.abs(Math.abs(dot(unit(face.surface.normal), axis)) - 1) < 1e-6 && (face.orientedLoops || []).length === 1) {
            const loopEdges = ctx.faceEdges.get(n) || [];
            if (loopEdges.every(e => [...(ctx.edgeFaces.get(e) || [])].some(o => o !== n && faces.includes(o)))) faces.push(n);
          }
        }
        const blind = faces.some(f => ctx.faces.get(f).surface?.kind === 'plane');
        const feature = { id: `${kind}-${kind === 'hole' ? ++holeCount : ++bossCount}`, kind, faces, solids, radius: s.radius, diameter: 2 * s.radius, depth, axis,
          center: add(s.origin, scale(axis, (lo + hi) / 2)), through: kind === 'hole' && !blind };
        feature.label = kind === 'hole' ? `Ø${fmt(feature.diameter)} ${feature.through ? 'through' : 'blind'} hole` : `Ø${fmt(feature.diameter)} boss`;
        features.push(feature);
        for (const f of faces) byFace.set(f, feature);
      } else if (tangentEdges.length) {
        const feature = { id: `fillet-${++filletCount}`, kind: 'fillet', faces: group.faces.slice(), solids, radius: s.radius, concave: group.concave === true, axis, center: s.origin, sweep };
        feature.label = `R${fmt(s.radius)} ${feature.concave ? 'fillet' : 'round'}`;
        features.push(feature);
        for (const f of group.faces) byFace.set(f, feature);
      }
    }
    // A narrow band meeting both long neighbors at about 135° is a chamfer, also
    // when it is conical (a chamfer along a curved edge).
    const bevelEdges = face => (face.orientedLoops?.[0] || []).filter(([e]) => { const a = edgeAngle(ctx, e, (face.volumes || [])[0]); return a != null && (Math.abs(a - 135) < 12 || Math.abs(a - 225) < 12); });
    const coneChamfer = face => face.type === 'Cone' && face.surface?.kind !== 'cylinder' && (face.orientedLoops || []).length === 1 && face.orientedLoops[0].length === 4 && bevelEdges(face).length === 2;
    // Other curved faces blended tangentially into neighbors are fillets too (torus, B-spline blends).
    for (const face of ctx.faces.values()) {
      const id = Number(face.id);
      if (byFace.has(id) || face.type === 'Plane' || face.surface?.kind === 'plane' || face.surface?.kind === 'cylinder' || coneChamfer(face)) continue;
      const tangent = (ctx.faceEdges.get(id) || []).filter(e => { const a = edgeAngle(ctx, e); return a != null && Math.abs(a - 180) < 8; });
      if (tangent.length >= 2) {
        const feature = { id: `fillet-${++filletCount}`, kind: 'fillet', faces: [id], solids: face.volumes || [], radius: Number(face.radius) || null, concave: null };
        feature.label = feature.radius ? `R${fmt(feature.radius)} blend` : `${face.type} blend`;
        features.push(feature); byFace.set(id, feature);
      }
    }
    // Chamfers: narrow planar or conical faces meeting both neighbors at about
    // 135°. Bands that continue each other tangentially (a chamfer around a
    // rounded cutout) are one chamfer, removed together.
    let chamferCount = 0;
    const bands = new Map();
    for (const face of ctx.faces.values()) {
      const id = Number(face.id);
      if (byFace.has(id) || (face.orientedLoops || []).length !== 1) continue;
      if (face.surface?.kind !== 'plane' && !coneChamfer(face)) continue;
      const loop = face.orientedLoops[0];
      if (bevelEdges(face).length !== 2 || loop.length !== 4) continue;
      const lengths = loop.map(([e]) => Number(ctx.edges.get(Number(e))?.length) || 0);
      const width = (Number(face.area) || 0) / Math.max(...lengths, 1e-12);
      if (width > ctx.span * 0.12) continue;
      bands.set(id, width);
    }
    const seen = new Set();
    for (const [id] of bands) {
      if (seen.has(id)) continue;
      const chain = [id], queue = [id]; seen.add(id);
      while (queue.length) {
        const f = queue.pop();
        for (const e of ctx.faceEdges.get(f) || []) {
          const a = edgeAngle(ctx, e);
          if (a == null || Math.abs(a - 180) >= 8) continue;
          for (const n of ctx.edgeFaces.get(e) || []) if (bands.has(Number(n)) && !seen.has(Number(n))) { seen.add(Number(n)); chain.push(Number(n)); queue.push(Number(n)); }
        }
      }
      const width = Math.max(...chain.map(f => bands.get(f)));
      const solids = [...new Set(chain.flatMap(f => ctx.faces.get(f).volumes || []))];
      const feature = { id: `chamfer-${++chamferCount}`, kind: 'chamfer', faces: chain.sort((a, b) => a - b), solids, width };
      feature.label = `${fmt(width)} chamfer${chain.length > 1 ? ` (${chain.length} faces)` : ''}`;
      features.push(feature); for (const f of chain) byFace.set(f, feature);
    }
    features.sort((a, b) => ({ hole: 0, boss: 1, fillet: 2, chamfer: 3 })[a.kind] - ({ hole: 0, boss: 1, fillet: 2, chamfer: 3 })[b.kind] || (b.radius || b.width || 0) - (a.radius || a.width || 0));
    // Cuts generated later check every hole of the model, not just the ones they are for.
    ctx.features = features;
    return { features, byFace, ctx };
  }

  /* ------------------------------------------------------------------ */
  /* Slice helpers                                                       */
  /* ------------------------------------------------------------------ */

  function centerOf(ctx) { const b = ctx.bounds; return [0, 1, 2].map(i => (b[i] + b[i + 3]) / 2); }

  function facePlane(ctx, faceId) {
    const face = ctx.faces.get(Number(faceId));
    if (!face || face.surface?.kind !== 'plane') return null;
    return { origin: (face.center || face.surface.origin).slice(), normal: unit(face.surface.normal) };
  }

  function edgeFrame(ctx, edgeId) {
    const edge = ctx.edges.get(Number(edgeId));
    if (!edge) return null;
    const [a, b] = (edge.vertices || []).map(v => ctx.vertices.get(Number(v)));
    if (!a || !b || norm(sub(b, a)) < 1e-12) return null;
    return { start: a, end: b, direction: unit(sub(b, a)), midpoint: scale(add(a, b), 0.5), line: edge.curve?.kind === 'line' };
  }

  /** Solids whose vertices lie strictly on both sides of a plane, i.e. that it would divide. */
  function solidsCut(ctx, origin, normal) {
    const tolerance = ctx.span * 1e-6, cut = [];
    for (const volume of ctx.volumes.values()) {
      let below = false, above = false;
      for (const f of volume.faces || []) for (const v of faceVertices(ctx, Number(f))) {
        const d = dot(sub(ctx.vertices.get(v), origin), normal);
        if (d < -tolerance) below = true; else if (d > tolerance) above = true;
      }
      if (below && above) cut.push(Number(volume.id));
    }
    return cut;
  }

  function bestAxis(normal) {
    let best = 0;
    for (let i = 1; i < 3; i++) if (Math.abs(normal[i]) > Math.abs(normal[best])) best = i;
    return best;
  }

  function cleanNormal(normal) {
    // Snap nearly axis-aligned normals so split faces stay exactly parallel.
    const n = unit(normal), axis = bestAxis(n);
    if (Math.abs(Math.abs(n[axis]) - 1) < 1e-9) { const snapped = [0, 0, 0]; snapped[axis] = 1; return snapped; }
    return Math.sign(n[axis]) < 0 ? scale(n, -1) : n;
  }

  /** Radial cuts from a hole axis to the corners of the face that surrounds it. */
  function holeSplit(ctx, feature, { ring = false } = {}) {
    const axis = unit(feature.axis), origin = feature.center;
    const holeEdges = new Set(feature.faces.flatMap(f => ctx.faceEdges.get(f) || []));
    const host = [...ctx.faces.values()].find(face => (face.orientedLoops || []).length > 1 && face.orientedLoops.slice(1).some(loop => loop.every(([e]) => holeEdges.has(Number(e)))));
    const rays = [];
    if (host) {
      const outer = host.corners?.[0] || [];
      const corners = outer.filter(([, angle]) => angle != null && angle < 140).map(([v]) => ctx.vertices.get(Number(v))).filter(Boolean);
      for (const p of corners) {
        const offset = sub(p, origin), radial = sub(offset, scale(axis, dot(offset, axis)));
        const length = norm(radial);
        // End at the corner: overshooting would cut any material that continues past it.
        if (length > feature.radius * 1.05) rays.push({ origin: origin.slice(), axis: axis.slice(), direction: unit(radial), length: length + ctx.span * 1e-5 });
      }
    }
    const operation = { kind: 'slice', volumeIds: feature.solids.slice(), label: `Split around ${feature.label}` };
    if (rays.length >= 3) operation.rays = rays;
    else {
      const reference = AXES[[0, 1, 2].sort((a, b) => Math.abs(axis[a]) - Math.abs(axis[b]))[0]];
      const r0 = unit(sub(reference, scale(axis, dot(reference, axis)))), r1 = cross(axis, r0);
      operation.planes = [0, 45, 90, 135].map(angle => {
        const t = angle * Math.PI / 180, inPlane = add(scale(r0, Math.cos(t)), scale(r1, Math.sin(t)));
        return { origin: origin.slice(), normal: unit(cross(axis, inPlane)) };
      });
    }
    if (ring) operation.cylinders = [{ origin: origin.slice(), axis: axis.slice(), radius: feature.radius * 1.8 }];
    return operation;
  }

  /**
   * Planes that box holes into square cells within the faces that surround
   * them: the cell side is the host face's narrow width, so the radial split
   * that follows gives four well-shaped sectors instead of long slivers.
   * Holes side by side across that width form a column and share it: each
   * gets an equal part, with a bounded cut between them. No cut passes through
   * a hole, here or elsewhere in the solid: one that would is moved just clear
   * of it, or left out.
   */
  function holeCells(ctx, features) {
    const cells = [], solids = new Set();
    for (const feature of features) {
      const axis = unit(feature.axis), holeEdges = new Set(feature.faces.flatMap(f => ctx.faceEdges.get(f) || []));
      const host = [...ctx.faces.values()].find(face => face.surface?.kind === 'plane' && (face.orientedLoops || []).length > 1 && face.orientedLoops.some(loop => loop.every(([e]) => holeEdges.has(Number(e)))));
      if (!host) continue;
      const outer = planarRings(ctx, host.id).outer.points;
      // In-plane directions: the axes closest to the face, made exactly perpendicular to the hole.
      const dirs = AXES.map(a => sub(a, scale(axis, dot(a, axis)))).filter(a => norm(a) > 0.5).map(cleanNormal);
      const spans = dirs.map(d => { const t = outer.map(p => dot(p, d)); return { d, lo: Math.min(...t), hi: Math.max(...t) }; }).map(x => ({ ...x, width: x.hi - x.lo }));
      if (spans.length < 2) continue;
      spans.sort((a, b) => a.width - b.width);
      const short = spans[0], long = spans[spans.length - 1];
      if (short.width < feature.diameter * 1.05) continue;
      cells.push({ feature, host: host.id, axis, long, short, t: dot(feature.center, long.d), s: dot(feature.center, short.d) });
    }
    const holes = (ctx.features || features).filter(f => f.kind === 'hole');
    const tol = ctx.span * 1e-6, reach = ctx.span * 1e-3;
    // The hole a cut plane would pass through, among the solids it slices.
    const through = (origin, normal, scope) => holes.find(h => {
      if (!h.solids.some(v => scope.has(Number(v)))) return false;
      const along = Math.abs(dot(normal, unit(h.axis)));
      const extent = h.radius * Math.sqrt(Math.max(0, 1 - along * along)) + along * (h.depth || 0) / 2;
      return Math.abs(dot(sub(origin, h.center), normal)) < extent - tol;
    });
    const planes = new Map(), rays = [];
    const groups = new Map();
    for (const cell of cells) { const key = `${cell.host}:${cell.long.d.map(x => x.toFixed(6))}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(cell); }
    for (const list of groups.values()) {
      const { long, short, axis } = list[0], scope = new Set(list.flatMap(c => c.feature.solids.map(Number)));
      list.sort((a, b) => a.t - b.t);
      // Holes side by side across the width (level within a radius) share it equally.
      const columns = [];
      for (const cell of list) {
        const last = columns[columns.length - 1];
        if (last && cell.t - last.t < Math.max(cell.feature.radius, last.cells[0].feature.radius)) last.cells.push(cell);
        else columns.push({ t: cell.t, cells: [cell] });
      }
      for (const column of columns) {
        column.cells.sort((a, b) => a.s - b.s);
        column.splits = column.cells.slice(1).map((c, i) => (c.s + column.cells[i].s) / 2);
        const edges = [short.lo, ...column.splits, short.hi];
        column.side = Math.min(...edges.slice(1).map((v, i) => v - edges[i]));
      }
      const usable = columns.filter(c => c.cells.every(cell => c.side >= cell.feature.diameter * 1.05));
      // A plane position, moved clear of any hole it would pass through; null when it cannot be.
      const resolved = new Map();
      const place = (offset, column) => {
        const key = offset.toFixed(6);
        if (!resolved.has(key)) {
          const at = x => add(column.cells[0].feature.center, scale(long.d, x - column.t));
          let x = offset;
          const hole = through(at(x), long.d, scope);
          if (hole) {
            const along = Math.abs(dot(long.d, unit(hole.axis)));
            const extent = hole.radius * Math.sqrt(Math.max(0, 1 - along * along)) + along * (hole.depth || 0) / 2;
            const d = dot(sub(at(x), hole.center), long.d), sense = d >= 0 ? 1 : -1;
            x += sense * (extent + hole.radius * 0.25) - d;
            if (Math.abs(x - offset) > column.side * 0.25 || through(at(x), long.d, scope)) x = null;
          }
          resolved.set(key, x);
          if (x != null) planes.set(`${long.d.map(v => v.toFixed(6))}:${x.toFixed(6)}`, { origin: at(x), normal: long.d.slice() });
        }
        return resolved.get(key);
      };
      usable.forEach((column, i) => {
        const prev = usable[i - 1], next = usable[i + 1];
        const lo = prev && prev.t + prev.side / 2 > column.t - column.side / 2 ? (prev.t + column.t) / 2 : column.t - column.side / 2;
        const hi = next && next.t - next.side / 2 < column.t + column.side / 2 ? (next.t + column.t) / 2 : column.t + column.side / 2;
        // A plane that would leave a sliver at the end of the host face is skipped: the cell runs to that end.
        const start = lo - long.lo < column.side * 0.2 ? long.lo - reach : place(lo, column);
        const end = long.hi - hi < column.side * 0.2 ? long.hi + reach : place(hi, column);
        for (const c of column.cells) for (const v of c.feature.solids) solids.add(Number(v));
        if (start == null || end == null) return;
        // Cuts between the holes of a column end on its planes, so they never reach a neighbor's cell.
        const base = column.cells[0];
        for (const s of column.splits) {
          rays.push({ origin: add(base.feature.center, add(scale(long.d, start - base.t), scale(short.d, s - base.s))), axis: axis.slice(), direction: long.d.slice(), length: end - start });
        }
      });
    }
    if (!planes.size && !rays.length) return null;
    const operation = { kind: 'slice', planes: [...planes.values()].slice(0, 16), volumeIds: [...solids], label: `Boxed ${features.length} hole${features.length === 1 ? '' : 's'} in square cells` };
    // Cuts between holes end on the planes: keep them only when every plane fits in one operation.
    if (rays.length && planes.size + rays.length <= 16) operation.rays = rays;
    return operation;
  }

  /** Inscribed square through-passage spanning the feature; the kernel fits its open ends. */
  function squarePassage(ctx, feature) {
    const axis = bestAxis(unit(feature.axis)), name = 'xyz'[axis];
    const side = Math.round(feature.diameter / Math.SQRT2 * 1e6) / 1e6;
    let lo = Infinity, hi = -Infinity;
    for (const f of feature.faces) for (const v of faceVertices(ctx, f)) { const p = ctx.vertices.get(v); if (p) { lo = Math.min(lo, p[axis]); hi = Math.max(hi, p[axis]); } }
    if (!Number.isFinite(lo)) { lo = ctx.bounds[axis]; hi = ctx.bounds[axis + 3]; }
    return { axis: name, center: feature.center.map(v => Math.round(v * 1e9) / 1e9), width: side, height: side, range: [lo, hi], fit: true };
  }

  /* ------------------------------------------------------------------ */
  /* Bounded cuts                                                        */
  /* ------------------------------------------------------------------ */

  const signedArea = poly => poly.reduce((sum, p, i) => { const r = poly[(i + 1) % poly.length]; return sum + p[0] * r[1] - r[0] * p[1]; }, 0) / 2;
  function segmentDistance(q, a, b) {
    const d = [b[0] - a[0], b[1] - a[1]], l = d[0] * d[0] + d[1] * d[1];
    const t = l > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1]) / l)) : 0;
    return Math.hypot(q[0] - a[0] - t * d[0], q[1] - a[1] - t * d[1]);
  }
  function insidePolygon(poly, q) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > q[1]) !== (yj > q[1]) && q[0] < (xj - xi) * (q[1] - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  /** A planar face as 2D polygons in its own plane; the outer ring is the one with the largest area. */
  function planarRings(ctx, faceId) {
    const face = ctx.faces.get(Number(faceId)), s = face?.surface;
    if (!s || s.kind !== 'plane' || !(face.orientedLoops || []).length) return null;
    const n = unit(s.normal), u = unit(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), w = cross(n, u);
    const flat = p => [dot(p, u), dot(p, w)];
    const rings = face.orientedLoops.map(loop => {
      const ids = loop.map(([e, sense]) => { const vs = ctx.edges.get(Number(e))?.vertices || []; return Number(sense > 0 ? vs[0] : vs[vs.length - 1]); });
      const points = ids.map(v => ctx.vertices.get(v)).filter(Boolean);
      return { ids, points, flat: points.map(flat), edges: loop.map(([e]) => Number(e)) };
    });
    const outer = rings.reduce((best, r) => (Math.abs(signedArea(r.flat)) > Math.abs(signedArea(best.flat)) ? r : best), rings[0]);
    return { n, u, w, flat, rings, outer, inner: rings.filter(r => r !== outer) };
  }

  /** True when a point lies inside a planar face (its outer loop minus inner loops). */
  function insideFace(ctx, faceId, point) {
    const shape = planarRings(ctx, faceId);
    if (!shape) return false;
    const q = shape.flat(point);
    return insidePolygon(shape.outer.flat, q) && !shape.inner.some(r => insidePolygon(r.flat, q));
  }

  /**
   * Half-plane strips for straight segments swept along `axis`. An end shared
   * by no other segment reaches slightly past it, so a cut that ends on the
   * boundary separates cleanly; `keepEnd(point)` can veto that extension.
   */
  function segmentRays(ctx, segments, axis, keepEnd = null) {
    const tol = ctx.span * 1e-6, eps = ctx.span * 1e-3;
    const ends = segments.flatMap(s => [s.a, s.b]);
    const free = p => ends.filter(q => norm(sub(p, q)) < tol).length === 1;
    const rays = [];
    for (const s of segments) {
      const d = sub(s.b, s.a), dir = sub(d, scale(axis, dot(d, axis))), length = norm(dir);
      if (length < tol) continue;
      const u = scale(dir, 1 / length);
      const ea = free(s.a) && !(keepEnd && keepEnd(sub(s.a, scale(u, eps)))) ? eps : 0;
      const eb = free(s.b) && !(keepEnd && keepEnd(add(s.b, scale(u, eps)))) ? eps : 0;
      const ray = { origin: sub(s.a, scale(u, ea)), axis: axis.slice(), direction: u, length: length + ea + eb };
      // A segment drawn on a face cuts only into that face's own material: the
      // kernel picks the side, so the cut never continues past a re-entrant corner.
      if (s.face != null) ray.face = Number(s.face);
      rays.push(ray);
    }
    return rays;
  }

  function cutOperation(ctx, segments, axis, volumeIds, label, holders = []) {
    const keepEnd = holders.length ? p => holders.some(f => insideFace(ctx, f, p)) : null;
    const rays = segmentRays(ctx, segments, unit(axis), keepEnd);
    if (!rays.length) return null;
    return { kind: 'slice', rays, volumeIds: [...new Set(volumeIds.map(Number))].sort((a, b) => a - b), label };
  }

  /**
   * A bounded cut along straight edges, swept through the solid along the
   * normal of the planar face they were drawn on. It stops where the edges
   * stop, unlike a plane, so it can follow an L-shaped imprint.
   */
  function edgeCut(ctx, edgeIds) {
    const ids = [...new Set((edgeIds || []).map(Number))];
    const frames = ids.map(e => edgeFrame(ctx, e));
    if (!ids.length || frames.some(f => !f || !f.line)) return { error: 'Cuts follow straight edges only.' };
    // Faces in which the edges continue into material (flat or re-entrant) can carry the cut.
    const sweeps = (e, f) => [...(ctx.faces.get(f)?.volumes || [])].some(v => (edgeAngle(ctx, e, v) ?? 0) >= 179);
    const candidates = [...new Set(ids.flatMap(e => [...(ctx.edgeFaces.get(e) || [])]))]
      .map(f => ctx.faces.get(f)).filter(f => f?.surface?.kind === 'plane')
      .map(f => ({ face: f, n: unit(f.surface.normal), held: ids.filter(e => (ctx.faceEdges.get(Number(f.id)) || []).includes(e) && sweeps(e, Number(f.id))).length }))
      .filter(c => c.held && frames.every(fr => Math.abs(dot(fr.direction, c.n)) < 1e-6 && Math.abs(dot(sub(fr.start, c.face.surface.origin), c.n)) < ctx.span * 1e-6))
      .sort((a, b) => b.held - a.held || (Number(b.face.area) || 0) - (Number(a.face.area) || 0));
    if (!candidates.length) return { error: 'Pick edges that lie in one planar face and continue into material.' };
    const { n } = candidates[0];
    const holders = candidates.filter(c => Math.abs(Math.abs(dot(c.n, n)) - 1) < 1e-6).map(c => Number(c.face.id));
    const volumes = new Set();
    for (const e of ids) for (const f of ctx.edgeFaces.get(e) || []) for (const v of ctx.faces.get(f)?.volumes || []) if ((edgeAngle(ctx, e, v) ?? 0) >= 179) volumes.add(Number(v));
    const segments = frames.map((f, i) => ({ a: f.start, b: f.end, source: `Edge ${ids[i]}`, face: Number(candidates[0].face.id) }));
    const label = `Cut solid${volumes.size === 1 ? '' : 's'} ${[...volumes].join(', ')} along edge${ids.length === 1 ? '' : 's'} ${ids.join(', ')}`;
    return { operation: cutOperation(ctx, segments, n, [...volumes], label, holders), segments, axis: cleanNormal(n), volumeIds: [...volumes], faces: holders };
  }

  /**
   * Walls that rise around a floor face (every edge of its outline is
   * re-entrant): cut along the outline to separate the floor from the walls,
   * and once across each corner of the wall ring so the ring falls apart into
   * straight wall pieces. A corner cut runs to the outer vertex on the corner's
   * bisector (a miter); at an acute corner it continues one inner face to an
   * outer vertex instead, which keeps both wall pieces four-sided.
   */
  function pocketCuts(ctx, volumeId) {
    const id = Number(volumeId), own = (ctx.volumes.get(id)?.faces || []).map(Number);
    const tol = ctx.span * 1e-6, actions = [];
    const unit2 = v => { const l = Math.hypot(v[0], v[1]); return [v[0] / l, v[1] / l]; };
    for (const f of own) {
      const face = ctx.faces.get(f);
      if (face?.surface?.kind !== 'plane' || (face.orientedLoops || []).length !== 1) continue;
      const loop = face.orientedLoops[0];
      if (loop.length < 3 || loop.length > 8 || !loop.every(([e]) => edgeFrame(ctx, e)?.line && (edgeAngle(ctx, e, id) ?? 0) > 220)) continue;
      const floor = planarRings(ctx, f);
      // The outline: the largest face of the solid parallel to the floor in another plane.
      const outline = own.filter(g => g !== f).map(g => ({ g, s: ctx.faces.get(g)?.surface, area: Number(ctx.faces.get(g)?.area) || 0 }))
        .filter(x => x.s?.kind === 'plane' && Math.abs(Math.abs(dot(unit(x.s.normal), floor.n)) - 1) < 1e-6 && Math.abs(dot(sub(x.s.origin, face.surface.origin), floor.n)) > tol)
        .sort((a, b) => b.area - a.area)[0];
      if (!outline) continue;
      const poly = floor.outer.flat, outer = planarRings(ctx, outline.g).outer.points.map(floor.flat);
      const ccw = signedArea(poly) > 0;
      const clear = (p, q) => [0.1, 0.3, 0.5, 0.7, 0.9].every(t => {
        const r = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        return insidePolygon(outer, r) && !insidePolygon(poly, r);
      });
      const hit = (p, d) => {
        let best = null;
        for (let i = 0; i < outer.length; i++) {
          const a = outer[i], b = outer[(i + 1) % outer.length], e = [b[0] - a[0], b[1] - a[1]];
          const den = d[0] * e[1] - d[1] * e[0];
          if (Math.abs(den) < 1e-12) continue;
          const ap = [a[0] - p[0], a[1] - p[1]];
          const t = (ap[0] * e[1] - ap[1] * e[0]) / den, k = (ap[0] * d[1] - ap[1] * d[0]) / den;
          if (t > tol && k > -1e-9 && k < 1 + 1e-9 && (!best || t < best.t)) best = { t, q: [p[0] + t * d[0], p[1] + t * d[1]] };
        }
        if (!best) return null;
        const vertex = outer.find(v => Math.hypot(v[0] - best.q[0], v[1] - best.q[1]) < ctx.span * 1e-5);
        return { length: best.t, q: vertex || best.q, vertex: !!vertex };
      };
      const corners = [];
      let complete = true;
      for (let i = 0; i < poly.length && complete; i++) {
        const p = poly[i], prev = poly[(i - 1 + poly.length) % poly.length], next = poly[(i + 1) % poly.length];
        const turn = (p[0] - prev[0]) * (next[1] - p[1]) - (p[1] - prev[1]) * (next[0] - p[0]);
        if ((turn > 0) !== ccw) continue; // a re-entrant floor corner needs no cut
        const a = unit2([prev[0] - p[0], prev[1] - p[1]]), b = unit2([next[0] - p[0], next[1] - p[1]]);
        const angle = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) * 180 / Math.PI;
        const bisector = unit2([-(a[0] + b[0]), -(a[1] + b[1])]);
        let choice = null;
        if (angle >= 80) {
          for (const q of outer) {
            const v = [q[0] - p[0], q[1] - p[1]], l = Math.hypot(v[0], v[1]);
            if (l < tol) continue;
            const off = Math.acos(Math.max(-1, Math.min(1, (v[0] * bisector[0] + v[1] * bisector[1]) / l))) * 180 / Math.PI;
            if (off <= 20 && clear(p, q) && (!choice || off < choice.off)) choice = { q, off };
          }
        }
        if (!choice) {
          const options = [];
          for (const d of [[-a[0], -a[1]], [-b[0], -b[1]]]) options.push({ d, rank: 0 });
          for (const e of [a, b]) for (const r of [[-e[1], e[0]], [e[1], -e[0]]]) if (r[0] * bisector[0] + r[1] * bisector[1] > 0) options.push({ d: r, rank: 1 });
          const found = options.map(o => ({ ...o, h: hit(p, o.d) })).filter(o => o.h && clear(p, o.h.q))
            .sort((x, y) => (y.h.vertex - x.h.vertex) || (x.rank - y.rank) || (x.h.length - y.h.length));
          if (found[0]) choice = { q: found[0].h.q };
        }
        if (!choice) { complete = false; break; }
        const start = floor.outer.points[i];
        corners.push({ a: start.slice(), b: add(start, add(scale(floor.u, choice.q[0] - p[0]), scale(floor.w, choice.q[1] - p[1]))) });
      }
      if (!complete || !corners.length) continue;
      const pts = floor.outer.points, outlineCuts = pts.map((pt, i) => ({ a: pt.slice(), b: pts[(i + 1) % pts.length].slice() }));
      const operation = cutOperation(ctx, [...outlineCuts, ...corners], floor.n, [id], `Separated the walls around floor face ${f} of solid ${id}`, [outline.g]);
      if (operation) actions.push({ key: `pocket:${id}:${f}`, label: 'Separate the walls from the floor', detail: `Cut along the ${pts.length} edges of floor face ${f} and across ${corners.length} wall corners`, faces: [f], edges: loop.map(([e]) => Number(e)), operation });
    }
    return actions;
  }

  /**
   * Openings that are not round features (square passages, windows): slice the
   * solid through the planes of the faces lining them, continued through the
   * neighbors those planes cross, so the solid falls into layers either side of
   * the openings. Planes parallel to the solid's largest faces come first.
   */
  function openingLevels(ctx, recognized, volume) {
    const id = Number(volume.id), own = (ctx.volumes.get(id)?.faces || []).map(Number);
    const hosts = (volume.reasons || []).filter(r => r.code === 'face-holes').flatMap(r => r.faces || []).map(Number);
    const groups = new Map();
    const b = ctx.volumes.get(id)?.bounds, size = b ? Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) : ctx.span;
    const extent = points => Math.hypot(...[0, 1, 2].map(i => Math.max(...points.map(p => p[i])) - Math.min(...points.map(p => p[i]))));
    for (const host of hosts) {
      const shape = planarRings(ctx, host);
      if (!shape) continue;
      for (const ring of shape.inner) {
        // Openings in a wall, not the cut-outs of a profile that make up the part.
        if (!ring.points.length || extent(ring.points) > size * 0.35) continue;
        const lining = [...new Set(ring.edges.flatMap(e => [...(ctx.edgeFaces.get(e) || [])]))].filter(g => g !== host);
        if (lining.some(g => recognized?.byFace.get(g))) continue;
        for (const g of lining) {
          const sg = ctx.faces.get(g)?.surface;
          if (sg?.kind !== 'plane') continue;
          const n = cleanNormal(sg.normal);
          if (Math.abs(dot(n, shape.n)) > 1e-6) continue;
          const key = n.map(x => x.toFixed(6)).join(',');
          if (!groups.has(key)) groups.set(key, { n, planes: new Map() });
          const offset = dot(sg.origin, n).toFixed(6);
          if (!groups.get(key).planes.has(offset)) groups.get(key).planes.set(offset, sg.origin.slice());
        }
      }
    }
    const weight = n => Math.max(0, ...own.map(g => ctx.faces.get(g)).filter(face => face?.surface?.kind === 'plane' && Math.abs(Math.abs(dot(unit(face.surface.normal), n)) - 1) < 1e-6).map(face => Number(face.area) || 0));
    const actions = [];
    for (const { n, planes } of [...groups.values()].sort((a, b) => weight(b.n) - weight(a.n))) {
      if (planes.size > 6) continue;
      const list = [...planes.values()].filter(origin => solidsCut(ctx, origin, n).includes(id))
        .map(origin => ({ origin, normal: n.slice(), volumeIds: sheetVolumes(ctx, [id], origin, n) }));
      if (!list.length) continue;
      const solids = new Set(list.flatMap(p => p.volumeIds));
      const axis = [0, 1, 2].find(i => Math.abs(Math.abs(n[i]) - 1) < 1e-9);
      actions.push({ key: `levels:${id}:${n.map(x => x.toFixed(6))}`, label: `Slice through the openings${axis == null ? '' : ` ⟂ ${'XYZ'[axis]}`}`,
        detail: `${list.length} plane${list.length === 1 ? '' : 's'} along faces lining the openings in face${hosts.length === 1 ? '' : 's'} ${hosts.slice(0, 3).join(', ')}, through ${solids.size} solid${solids.size === 1 ? '' : 's'}`,
        faces: hosts, operation: { kind: 'slice', planes: list, volumeIds: [...solids], label: `Sliced solid ${id} through its openings` } });
    }
    return actions;
  }

  function sweepName(axis) {
    const i = [0, 1, 2].find(k => Math.abs(Math.abs(axis[k]) - 1) < 1e-9);
    return i == null ? 'along the face normal' : `along ${'XYZ'[i]}`;
  }

  /** A bounded cut through picked vertices (in order), across the planar face that holds them. */
  function vertexCut(ctx, vertexIds) {
    const ids = (vertexIds || []).map(Number);
    const points = ids.map(v => ctx.vertices.get(v));
    if (ids.length < 2 || points.some(p => !p)) return { error: 'Pick two or more vertices.' };
    const segments = [];
    for (let i = 1; i < points.length; i++) segments.push({ a: points[i - 1].slice(), b: points[i].slice(), source: `Vertices ${ids[i - 1]} → ${ids[i]}` });
    const common = [...ctx.faces.values()].filter(f => f.surface?.kind === 'plane' && ids.every(v => faceVertices(ctx, Number(f.id)).includes(v)));
    // The face the cut runs across: every segment passes through its interior.
    const across = common.filter(f => segments.every(s => [0.25, 0.5, 0.75].every(t => insideFace(ctx, f.id, add(s.a, scale(sub(s.b, s.a), t))))));
    const face = across[0];
    if (!face) return { error: common.length ? 'The cut must run across the face that holds the vertices.' : 'Pick vertices of one planar face.' };
    const n = unit(face.surface.normal), volumeIds = (face.volumes || []).map(Number);
    for (const s of segments) s.face = Number(face.id);
    const label = `Cut solid${volumeIds.length === 1 ? '' : 's'} ${volumeIds.join(', ')} between vertices ${ids.join(', ')}`;
    return { operation: cutOperation(ctx, segments, n, volumeIds, label, [Number(face.id)]), segments, axis: cleanNormal(n), volumeIds, faces: [Number(face.id)] };
  }

  /* ------------------------------------------------------------------ */
  /* Inference                                                           */
  /* ------------------------------------------------------------------ */

  function featureActions(ctx, feature) {
    const actions = [];
    const tag = list => { list.forEach(action => { action.feature = feature.kind; action.featureId = feature.id; }); return list; };
    const removeLabel = { hole: 'Remove hole', boss: 'Remove boss', fillet: 'Remove fillet', chamfer: 'Remove chamfer' }[feature.kind];
    actions.push({ key: 'remove-feature', label: removeLabel, detail: `Heal ${feature.faces.length} face${feature.faces.length === 1 ? '' : 's'} closed`, primary: true,
      operation: { kind: 'defeature', faceIds: feature.faces.slice(), label: `Removed ${feature.label}` }, faces: feature.faces });
    if (feature.kind === 'hole' && feature.through) {
      actions.push({ key: 'split-hole', label: 'Split around hole', detail: 'Radial cuts to the corners → four-sided sectors', operation: holeSplit(ctx, feature), faces: feature.faces });
      actions.push({ key: 'split-hole-ring', label: 'Split with O-grid ring', detail: 'Radial cuts plus a concentric ring', operation: holeSplit(ctx, feature, { ring: true }), faces: feature.faces });
      const cell = holeCells(ctx, [feature]);
      if (cell) actions.push({ key: 'box-hole', label: 'Box in a square cell', detail: `${cell.planes.length} cut${cell.planes.length === 1 ? '' : 's'} across the surrounding face, then split around it`, operation: cell, faces: feature.faces });
      actions.push({ key: 'passage', label: 'Square passage', detail: `Replace with ${fmt(feature.diameter / Math.SQRT2)} × ${fmt(feature.diameter / Math.SQRT2)} inscribed square`, tool: 'passages', passage: squarePassage(ctx, feature), faces: feature.faces });
    }
    if (feature.kind === 'boss') actions.push({ key: 'split-hole', label: 'Split around boss', detail: 'Radial cuts through the axis', operation: holeSplit(ctx, feature), faces: feature.faces });
    return tag(actions);
  }

  /**
   * selection: { kind: 'face'|'edge'|'vertex'|'solid', ids: [...] }
   * Returns { title, subtitle, facts: [[label, value]], actions: [...] }
   */
  function infer(topology, recognized, analysis, selection) {
    const ctx = recognized ? recognized.ctx : context(topology);
    const ids = (selection?.ids || []).map(Number);
    const kind = selection?.kind;
    if (!ids.length) return null;
    const actions = [], facts = [];
    let title = '', subtitle = '';
    if (kind === 'face') {
      if (ids.length === 1) {
        const face = ctx.faces.get(ids[0]);
        if (!face) return null;
        const feature = recognized?.byFace.get(ids[0]);
        title = `Face ${face.id}`;
        subtitle = feature ? feature.label : `${face.type || 'Surface'}${face.surface?.radius ? ` · R${fmt(face.surface.radius)}` : ''}`;
        facts.push(['Area', fmt(face.area, 4)]);
        if (face.surface?.kind === 'plane') facts.push(['Normal', face.surface.normal.map(v => fmt(Math.abs(v) < 1e-12 ? 0 : v, 3)).join(', ')]);
        const info = analysis?.faces.get(ids[0]);
        if (info) facts.push(['Mapping', info.mappable ? '4-sided ✓' : info.message]);
        if (feature) actions.push(...featureActions(ctx, feature));
        const plane = facePlane(ctx, ids[0]);
        const crossed = plane ? solidsCut(ctx, plane.origin, unit(plane.normal)) : [];
        if (plane && crossed.length) actions.push({ key: 'slice-face', label: 'Slice with this plane', detail: `Extend the face plane through ${crossed.length} solid${crossed.length === 1 ? '' : 's'}`, tool: 'slice', slice: { origin: plane.origin, normal: cleanNormal(plane.normal), scope: 'all' }, primary: !feature });
        else if (plane) actions.push({ key: 'slice-parallel', label: 'Slice parallel to this face', detail: 'Choose the offset in the Slice tool', tool: 'slice', slice: { origin: centerOf(ctx), normal: cleanNormal(plane.normal), scope: 'all' }, primary: !feature });
        if (face.surface?.kind === 'cylinder' && !feature) {
          const pseudo = { kind: 'boss', faces: [ids[0]], solids: face.volumes || [], center: face.surface.origin, axis: face.surface.axis, radius: face.surface.radius, label: 'cylinder' };
          actions.push({ key: 'split-axis', label: 'Split through axis', detail: 'Planes through the cylinder axis', operation: holeSplit({ ...ctx, faces: new Map() }, pseudo) });
        }
        if (!feature) actions.push({ key: 'remove-faces', label: 'Remove face', detail: 'Delete it and heal the neighbors', operation: { kind: 'defeature', faceIds: ids.slice() }, faces: ids });
      } else {
        title = `${ids.length} faces`;
        const area = ids.reduce((s, id) => s + (Number(ctx.faces.get(id)?.area) || 0), 0);
        facts.push(['Total area', fmt(area, 4)]);
        const features = [...new Set(ids.map(id => recognized?.byFace.get(id)).filter(Boolean))];
        subtitle = features.length ? features.map(f => f.label).join(', ') : 'Faces';
        const faces = [...new Set([...ids, ...features.flatMap(f => f.faces)])];
        actions.push({ key: 'remove-faces', label: `Remove ${faces.length} faces`, detail: features.length ? 'Includes the complete selected features' : 'Delete and heal the neighbors', operation: { kind: 'defeature', faceIds: faces }, faces, primary: true });
      }
    } else if (kind === 'edge') {
      const edge = ctx.edges.get(ids[0]);
      if (!edge) return null;
      title = ids.length === 1 ? `Edge ${edge.id}` : `${ids.length} edges`;
      subtitle = ids.length === 1 ? `${edge.type || 'Curve'} · L ${fmt(edge.length, 4)}` : `Total length ${fmt(ids.reduce((s, id) => s + (Number(ctx.edges.get(id)?.length) || 0), 0), 4)}`;
      if (ids.length === 1) {
        const map = ctx.angles.get(ids[0]);
        if (map && map.size) facts.push(['Dihedral', [...map].map(([v, a]) => `${a == null ? '?' : Math.round(a)}° in solid ${v}`).join(', ')]);
        for (const [volume, angle] of map || []) {
          if (angle == null || angle <= 220) continue;
          for (const f of ctx.edgeFaces.get(ids[0]) || []) {
            const plane = facePlane(ctx, f);
            if (plane) actions.push({ key: 'slice-reentrant-' + f, label: `Slice along face ${f}`, detail: `Resolves the re-entrant edge in solid ${volume}`, primary: true,
              operation: { kind: 'slice', planes: [{ origin: plane.origin, normal: cleanNormal(plane.normal) }], volumeIds: [volume], label: `Sliced solid ${volume} along face ${f}` }, slice: { origin: plane.origin, normal: cleanNormal(plane.normal), scope: 'solids', volumeIds: [volume] } });
          }
        }
        const frame = edgeFrame(ctx, ids[0]);
        if (frame && frame.line) actions.push({ key: 'slice-normal', label: 'Slice across edge', detail: 'Plane perpendicular to the edge', tool: 'slice', slice: { origin: frame.midpoint, normal: cleanNormal(frame.direction), scope: 'all', along: { start: frame.start, end: frame.end } } });
      }
      const cut = edgeCut(ctx, ids);
      if (cut.operation) actions.push({ key: 'cut-edges', label: ids.length === 1 ? 'Cut along this edge' : `Cut along ${ids.length} edges`, detail: `Bounded cut through solid${cut.volumeIds.length === 1 ? '' : 's'} ${cut.volumeIds.join(', ')}, swept ${sweepName(cut.axis)}; it stops where the edges stop`, tool: 'cut', cut, primary: !actions.length });
    } else if (kind === 'vertex' && ids.length > 1) {
      title = `${ids.length} vertices`;
      subtitle = 'Bounded cut between them, in pick order';
      const cut = vertexCut(ctx, ids);
      if (cut.operation) actions.push({ key: 'cut-vertices', label: 'Cut between vertices', detail: `Straight cut${ids.length > 2 ? 's' : ''} across face ${cut.faces[0]} through solid${cut.volumeIds.length === 1 ? '' : 's'} ${cut.volumeIds.join(', ')}, swept ${sweepName(cut.axis)}`, tool: 'cut', cut, primary: true });
      else facts.push(['Cut', cut.error]);
    } else if (kind === 'vertex') {
      const point = ctx.vertices.get(ids[0]);
      if (!point) return null;
      title = `Vertex ${ids[0]}`;
      subtitle = point.map(v => fmt(v, 5)).join(', ');
      for (let axis = 0; axis < 3; axis++) actions.push({ key: 'slice-vertex-' + axis, label: `Slice ⟂ ${'XYZ'[axis]}`, detail: `Plane through the vertex, normal ${'XYZ'[axis]}`, tool: 'slice', slice: { origin: point.slice(), normal: AXES[axis].slice(), scope: 'all' }, primary: axis === 0 });
      facts.push(['Cut', 'Shift-pick a second vertex to cut between them']);
    } else if (kind === 'solid' && ids.length > 1) {
      const records = ids.map(id => ctx.volumes.get(id)).filter(Boolean);
      if (!records.length) return null;
      title = `${ids.length} solids`;
      const mappable = ids.filter(id => analysis?.volumes.get(id)?.mappable).length;
      subtitle = `${mappable} of ${ids.length} mappable`;
      facts.push(['Volume', fmt(records.reduce((sum, r) => sum + (Number(r.volume) || 0), 0), 5)]);
      const fuse = fuseAction(ctx, ids);
      if (fuse.operation) actions.push(fuse);
      else facts.push(['Fuse', fuse.error]);
      const box = ctx.bounds && records.every(r => r.bounds) ? [0, 1, 2].map(i => (Math.min(...records.map(r => r.bounds[i])) + Math.max(...records.map(r => r.bounds[i + 3]))) / 2) : [0, 0, 0];
      actions.push({ key: 'slice-solid', label: 'Slice these solids', detail: 'One plane through all of them', tool: 'slice', slice: { origin: box, normal: [1, 0, 0], scope: 'solids', volumeIds: ids.slice() } });
    } else if (kind === 'solid') {
      const volume = analysis?.volumes.get(ids[0]);
      const record = ctx.volumes.get(ids[0]);
      if (!record) return null;
      title = ids.length === 1 ? `Solid ${ids[0]}` : `${ids.length} solids`;
      subtitle = volume ? (volume.mappable ? 'Mappable hex block' : 'Not mappable yet') : '';
      facts.push(['Volume', fmt(record.volume, 5)], ['Faces', String((record.faces || []).length)]);
      if (volume && !volume.mappable) actions.push(...fixes(ctx, recognized, volume));
      if (volume?.mappable && volume.warnings?.length) actions.push(...shapeFixes(ctx, volume));
      actions.push({ key: 'slice-solid', label: 'Slice this solid', detail: 'Plane through its center', tool: 'slice', slice: { origin: record.bounds ? [0, 1, 2].map(i => (record.bounds[i] + record.bounds[i + 3]) / 2) : [0, 0, 0], normal: [1, 0, 0], scope: 'solids', volumeIds: ids.slice() } });
    }
    return { title, subtitle, facts, actions };
  }

  /** Fuse picked solids back into one; they must be connected through shared faces. */
  function fuseAction(ctx, volumeIds) {
    const ids = [...new Set(volumeIds.map(Number))];
    if (ids.length < 2) return { error: 'Pick two or more solids.' };
    const linked = new Set([ids[0]]), queue = [ids[0]];
    while (queue.length) {
      const id = queue.pop();
      for (const f of ctx.volumes.get(id)?.faces || []) for (const other of ctx.faces.get(Number(f))?.volumes || []) {
        const v = Number(other);
        if (ids.includes(v) && !linked.has(v)) { linked.add(v); queue.push(v); }
      }
    }
    if (linked.size !== ids.length) return { error: 'These solids do not share faces; pick neighbors to fuse.' };
    return { key: 'fuse', label: `Fuse ${ids.length} solids`, detail: 'Merge them back into one solid, e.g. to redo a cut differently', primary: true,
      operation: { kind: 'fuse', volumeIds: ids.slice().sort((a, b) => a - b), label: `Fused solids ${ids.slice().sort((a, b) => a - b).join(', ')}` } };
  }

  /** True when a plane grazes a cylinder of the solid, which would leave a knife edge. */
  function grazesCylinder(ctx, volumeId, origin, normal) {
    const record = ctx.volumes.get(Number(volumeId));
    for (const f of record?.faces || []) {
      const s = ctx.faces.get(Number(f))?.surface;
      if (!s || s.kind !== 'cylinder' || Math.abs(dot(unit(s.axis), normal)) > 1e-6) continue;
      if (Math.abs(Math.abs(dot(sub(s.origin, origin), normal)) - s.radius) < Math.max(s.radius * 1e-4, ctx.span * 1e-7)) return true;
    }
    return false;
  }

  /** The solid plus neighbors whose shared faces a plane crosses (so no imprint is left on them). */
  function crossingVolumes(ctx, volumeId, point, normal) {
    const ids = [Number(volumeId)], tol = ctx.span * 1e-6;
    for (const f of ctx.volumes.get(Number(volumeId))?.faces || []) {
      const d = faceVertices(ctx, Number(f)).map(x => ctx.vertices.get(x)).filter(Boolean).map(q => dot(sub(q, point), normal));
      if (!(d.some(x => x < -tol) && d.some(x => x > tol))) continue;
      for (const other of ctx.faces.get(Number(f))?.volumes || []) if (!ids.includes(Number(other))) ids.push(Number(other));
    }
    return ids;
  }

  /**
   * All solids a plane cut must pass through so it leaves no T-junction: start
   * from `start` and follow neighbors across every shared face the plane crosses.
   */
  function sheetVolumes(ctx, start, point, normal, exclude = []) {
    const skip = new Set(exclude.map(Number)), seen = new Set(), queue = [];
    for (const id of start) if (!skip.has(Number(id))) { seen.add(Number(id)); queue.push(Number(id)); }
    while (queue.length) {
      const id = queue.shift();
      for (const next of crossingVolumes(ctx, id, point, normal)) if (!seen.has(next) && !skip.has(next)) { seen.add(next); queue.push(next); }
    }
    return [...seen];
  }

  /**
   * Slices that reshape a mapped but badly shaped block: through the ends of
   * the long edges of a tapered block, and through vertices where a block side
   * bends, each perpendicular to the adjacent long straight edge.
   */
  function shapeFixes(ctx, volume) {
    const record = ctx.volumes.get(Number(volume.id));
    const own = new Set((record?.faces || []).map(Number));
    const picks = [];
    const straight = (e, v) => { const f = edgeFrame(ctx, e); return f && f.line && (ctx.edges.get(Number(e))?.vertices || []).map(Number).includes(v) ? f : null; };
    for (const warning of volume.warnings || []) {
      if (warning.code !== 'taper' || !warning.long) continue;
      for (const v of warning.long.corners) for (const e of warning.long.edges) { const f = straight(e, v); if (f) picks.push({ v, e, frame: f, why: 'taper' }); }
    }
    for (const f of own) {
      const face = ctx.faces.get(f), loop = face?.orientedLoops?.[0] || [], corners = face?.corners?.[0] || [];
      corners.forEach(([v, angle], i) => {
        if (angle == null || angle < 140 || angle >= 172) return;
        const options = [loop[i]?.[0], loop[(i - 1 + loop.length) % loop.length]?.[0]].map(e => ({ e, frame: straight(e, Number(v)), length: Number(ctx.edges.get(Number(e))?.length) || 0 })).filter(x => x.frame);
        options.sort((a, b) => b.length - a.length);
        if (options[0]) picks.push({ v: Number(v), e: options[0].e, frame: options[0].frame, why: 'bend' });
      });
    }
    const actions = [], seen = new Set();
    for (const { v, e, frame, why } of picks) {
      const point = ctx.vertices.get(v); if (!point) continue;
      const normal = cleanNormal(frame.direction);
      const key = `shape:${normal.map(x => x.toFixed(6))}:${dot(point, normal).toFixed(6)}:${volume.id}`;
      if (seen.has(key) || !solidsCut(ctx, point, normal).includes(Number(volume.id)) || grazesCylinder(ctx, volume.id, point, normal)) continue;
      seen.add(key);
      const volumeIds = crossingVolumes(ctx, volume.id, point, normal);
      actions.push({ key, label: `Square up solid ${volume.id}`, detail: why === 'taper' ? `Slice through vertex ${v} across its long edge ${e}` : `Slice through the bend at vertex ${v}`, vertices: [v], edges: [Number(e)],
        operation: { kind: 'slice', planes: [{ origin: point.slice(), normal }], volumeIds, label: `Squared up solid ${volume.id} at vertex ${v}` },
        slice: { origin: point.slice(), normal, scope: 'solids', volumeIds } });
      if (actions.length >= 8) break;
    }
    return actions;
  }

  /**
   * Slices that remove the T-junctions behind edge-count conflicts. A sum
   * equation exists because an imprint line ends on a side of a face; cutting
   * along that line through every solid it crosses removes the junction.
   */
  function conflictFixes(ctx, analysis, intervals) {
    const actions = [], seen = new Set();
    const faces = new Set((intervals?.conflicts || []).flatMap(c => c.faces || []));
    for (const faceId of faces) {
      const face = ctx.faces.get(Number(faceId)), info = analysis.faces.get(Number(faceId));
      if (!face || !info?.mappable) continue;
      for (const chain of info.chains) {
        for (let i = 1; i < chain.length; i++) {
          // The vertex between two edges of one chain is a T-junction on a block
          // edge: cut across that block edge there, through the whole sheet.
          const item = chain[i - 1], edge = ctx.edges.get(item.edge), frame = edgeFrame(ctx, item.edge);
          if (!edge || !frame || !frame.line) continue;
          const v = Number(item.sense > 0 ? edge.vertices[1] : edge.vertices[0]), point = ctx.vertices.get(v);
          if (!point) continue;
          const cut = cleanNormal(frame.direction);
          const key = `tjoint:${cut.map(x => x.toFixed(6))}:${dot(point, cut).toFixed(6)}`;
          if (seen.has(key)) continue;
          const sheet = sheetVolumes(ctx, face.volumes || [], point, cut);
          if (!sheet.length) continue;
          seen.add(key);
          actions.push({ key, label: `Extend T-junction at vertex ${v}`, detail: `Cut through ${sheet.length} solid${sheet.length === 1 ? '' : 's'} across edge ${item.edge}`, vertices: [v], edges: [item.edge], faces: [Number(faceId)],
            operation: { kind: 'slice', planes: [{ origin: point.slice(), normal: cut }], volumeIds: sheet, label: `Extended the T-junction at vertex ${v}` } });
          if (actions.length >= 12) return actions;
        }
      }
    }
    return actions;
  }

  /** Concrete fixes for each reason a solid cannot be mapped. */
  function fixes(ctxOrTopology, recognized, volume) {
    const ctx = ctxOrTopology.faces instanceof Map ? ctxOrTopology : context(ctxOrTopology);
    const actions = [], seen = new Set();
    const push = action => {
      const plane = action.operation?.kind === 'slice' && action.operation.planes?.length === 1 && !action.operation.rays ? action.operation.planes[0] : null;
      if (plane && grazesCylinder(ctx, volume.id, plane.origin, unit(plane.normal))) return;
      if (!seen.has(action.key)) { seen.add(action.key); actions.push(action); }
    };
    // Face-plane slices first: they name the face, and vertex slices on the same plane dedupe onto them.
    const reasons = (volume.reasons || []).slice().sort((a, b) => (a.code === 'reentrant' ? 0 : 1) - (b.code === 'reentrant' ? 0 : 1));
    for (const reason of reasons) {
      if (reason.code === 'reentrant') {
        for (const f of reason.faces || []) {
          const plane = facePlane(ctx, f);
          if (!plane) continue;
          const normal = cleanNormal(plane.normal);
          const key = `slice:${normal.map(v => v.toFixed(6))}:${dot(plane.origin, normal).toFixed(6)}:${volume.id}`;
          const sheet = [Number(volume.id)];
          push({ key, label: `Slice along face ${f}`, detail: `Fixes re-entrant edge ${reason.edges[0]}`, primary: !actions.length, edges: reason.edges, faces: [f],
            operation: { kind: 'slice', planes: [{ origin: plane.origin, normal }], volumeIds: sheet, label: `Sliced solid ${volume.id} along face ${f}` },
            slice: { origin: plane.origin, normal, scope: 'solids', volumeIds: sheet } });
        }
      }
      const feature = (reason.faces || []).map(f => recognized?.byFace.get(f)).find(Boolean)
        || (reason.edges || []).flatMap(e => [...(ctx.edgeFaces.get(e) || [])]).map(f => recognized?.byFace.get(f)).find(Boolean);
      if (feature && /^face-(holes|periodic|closed|corners|reflex)$|^sides$/.test(reason.code)) {
        for (const action of featureActions(ctx, feature)) push({ ...action, key: action.key + ':' + feature.id, label: `${action.label}`, detail: `${feature.label} · ${action.detail}`, primary: !actions.length && action.primary });
      }
      if (reason.code === 'face-holes' && reason.faces?.length && recognized) {
        const host = ctx.faces.get(reason.faces[0]);
        const inner = (host?.orientedLoops || []).slice(1);
        if (host?.surface?.kind === 'plane' && inner.length > 1) {
          const n = unit(host.surface.normal);
          const centers = inner.map(loop => {
            const feature = loop.map(([e]) => [...(ctx.edgeFaces.get(Number(e)) || [])].map(f => recognized.byFace.get(f)).find(Boolean)).find(Boolean);
            if (feature?.center) return feature.center;
            const pts = loop.flatMap(([e]) => (ctx.edges.get(Number(e))?.vertices || []).map(v => ctx.vertices.get(Number(v)))).filter(Boolean);
            return pts.length ? scale(pts.reduce(add, [0, 0, 0]), 1 / pts.length) : null;
          }).filter(Boolean).map(c => sub(c, scale(n, dot(sub(c, host.surface.origin), n))));
          // Cut between neighbors along the direction in which the holes spread most.
          const spread = AXES.map(a => sub(a, scale(n, dot(a, n)))).filter(a => norm(a) > 0.5).map(unit)
            .map(d => ({ d, values: centers.map(c => dot(c, d)) })).sort((a, b) => (Math.max(...b.values) - Math.min(...b.values)) - (Math.max(...a.values) - Math.min(...a.values)))[0];
          if (spread) {
            const order = centers.map((c, i) => [spread.values[i], c]).sort((a, b) => a[0] - b[0]);
            const normal = cleanNormal(spread.d), planes = [];
            for (let i = 1; i < order.length; i++) if (order[i][0] - order[i - 1][0] > ctx.span * 1e-3) planes.push({ origin: scale(add(order[i][1], order[i - 1][1]), 0.5), normal });
            const boxed = [...new Set(inner.map(loop => loop.map(([e]) => [...(ctx.edgeFaces.get(Number(e)) || [])].map(f => recognized.byFace.get(f)).find(Boolean)).find(Boolean)).filter(f => f?.kind === 'hole'))];
            const cells = boxed.length === inner.length ? holeCells(ctx, boxed) : null;
            if (cells) push({ key: `box-holes:${volume.id}:${host.id}`, label: `Box ${boxed.length} holes in square cells`, detail: `${cells.planes.length} cuts across face ${host.id}, sized to its width`, faces: [host.id], operation: cells });
            if (planes.length) {
              const volumeIds = [...new Set(planes.flatMap(pl => crossingVolumes(ctx, volume.id, pl.origin, normal)))];
              push({ key: `separate-holes:${volume.id}:${host.id}`, label: `Separate ${inner.length} holes`, detail: `${planes.length} cut${planes.length === 1 ? '' : 's'} between the holes in face ${host.id}`, faces: [host.id],
                operation: { kind: 'slice', planes, volumeIds, label: `Separated ${inner.length} holes in solid ${volume.id}` } });
            }
          }
        }
      }
      if ((reason.code === 'face-corners' || reason.code === 'face-reflex') && reason.faces?.length) {
        const faceId = reason.faces[0], face = ctx.faces.get(faceId), record = ctx.volumes.get(volume.id);
        const own = new Set((record?.faces || []).map(Number));
        if (face?.surface?.kind === 'plane') {
          const normal = unit(face.surface.normal);
          // An imprint (a flat edge to a coplanar face of the same solid) that stops
          // short of the far side leaves this face with too few or too many corners.
          for (const [e] of face.orientedLoops?.[0] || []) {
            const angle = edgeAngle(ctx, e, volume.id), frame = edgeFrame(ctx, e);
            if (angle == null || Math.abs(angle - 180) > 1 || !frame || !frame.line) continue;
            const other = [...(ctx.edgeFaces.get(Number(e)) || [])].find(g => g !== faceId && own.has(g));
            const g = other && ctx.faces.get(other);
            if (!g || g.surface?.kind !== 'plane' || Math.abs(Math.abs(dot(unit(g.surface.normal), normal)) - 1) > 1e-6) continue;
            const cut = cleanNormal(cross(frame.direction, normal));
            if (norm(cut) < 0.5 || !solidsCut(ctx, frame.midpoint, cut).includes(Number(volume.id))) continue;
            const sheet = [Number(volume.id)];
            push({ key: `slice:${cut.map(x => x.toFixed(6))}:${dot(frame.midpoint, cut).toFixed(6)}:${volume.id}`, label: `Extend imprint edge ${e}`, detail: `Slice solid ${volume.id} through the T-junction on face ${faceId}`, edges: [Number(e)], faces: [faceId],
              operation: { kind: 'slice', planes: [{ origin: frame.midpoint, normal: cut }], volumeIds: sheet, label: `Extended imprint edge ${e} through solid ${volume.id}` },
              slice: { origin: frame.midpoint, normal: cut, scope: 'solids', volumeIds: sheet } });
          }
          // A prism whose cap is a convex n-gon (n = 3 or n >= 5) splits into n blocks
          // by cuts from its centroid to every edge midpoint.
          const corners = (face.corners?.[0] || []).filter(([, a]) => a != null && a < 140).map(([v]) => ctx.vertices.get(Number(v))).filter(Boolean);
          const reflex = (face.corners?.[0] || []).some(([, a]) => a != null && a > 200);
          const coplanar = [...own].some(g => g !== faceId && ctx.faces.get(g)?.surface?.kind === 'plane' && Math.abs(Math.abs(dot(unit(ctx.faces.get(g).surface.normal), normal)) - 1) < 1e-6 && Math.abs(dot(sub(ctx.faces.get(g).surface.origin, face.surface.origin), normal)) < ctx.span * 1e-6);
          const prism = [...own].every(g => {
            const sg = ctx.faces.get(g)?.surface; if (!sg) return false;
            if (sg.kind === 'plane') { const c = Math.abs(dot(unit(sg.normal), normal)); return c > 1 - 1e-6 || c < 1e-6; }
            if (sg.kind === 'cylinder') return Math.abs(Math.abs(dot(unit(sg.axis), normal)) - 1) < 1e-6;
            return false;
          });
          if (prism && !reflex && !coplanar && corners.length >= 3 && corners.length !== 4 && corners.length <= 8) {
            const mids = corners.map((p, i) => scale(add(p, corners[(i + 1) % corners.length]), 0.5));
            let center = scale(corners.reduce((acc, p) => add(acc, p), [0, 0, 0]), 1 / corners.length);
            if (corners.length === 3) {
              // Fermat point of the midpoints (Weiszfeld): the three cuts meet at 120°,
              // so every cell keeps four corners however elongated the triangle is.
              for (let k = 0; k < 200; k++) {
                let w = 0, next = [0, 0, 0];
                for (const m of mids) { const d = Math.max(norm(sub(m, center)), 1e-12); next = add(next, scale(m, 1 / d)); w += 1 / d; }
                next = scale(next, 1 / w);
                if (norm(sub(next, center)) < ctx.span * 1e-10) { center = next; break; }
                center = next;
              }
            }
            const rays = mids.map(mid => {
              const offset = sub(mid, center);
              const radial = sub(offset, scale(normal, dot(offset, normal)));
              return { origin: center.slice(), axis: normal.slice(), direction: unit(radial), length: norm(radial) + ctx.span * 1e-5, volumeIds: [Number(volume.id)] };
            });
            // Where a cut ends on a face shared with a neighbor, continue it through
            // the neighbors as a plane across that edge, so no T-junction remains.
            const planes = [];
            mids.forEach((mid, i) => {
              const along = unit(sub(corners[(i + 1) % corners.length], corners[i]));
              const neighbors = [];
              for (const g of own) {
                if (g === faceId) continue;
                const sg = ctx.faces.get(g)?.surface;
                if (sg?.kind !== 'plane' || Math.abs(dot(sub(mid, sg.origin), unit(sg.normal))) > ctx.span * 1e-6) continue;
                for (const other of ctx.faces.get(g).volumes || []) if (Number(other) !== Number(volume.id)) neighbors.push(Number(other));
              }
              if (!neighbors.length) return;
              planes.push({ origin: mid.slice(), normal: cleanNormal(along), volumeIds: [...new Set(neighbors)] });
            });
            const operation = { kind: 'slice', rays, volumeIds: [Number(volume.id)], label: `Split ${corners.length}-sided solid ${volume.id} into ${corners.length} blocks` };
            if (planes.length) operation.planes = planes;
            push({ key: `split-mid:${volume.id}:${faceId}`, label: `Split into ${corners.length} blocks`, detail: `Cuts from the center of ${corners.length}-sided face ${faceId} to its edge midpoints${planes.length ? `, continued through ${new Set(planes.flatMap(p => p.volumeIds)).size} neighbors` : ''}`, faces: [faceId], operation });
          }
        }
      }
      if (reason.code === 'face-reflex') {
        for (const v of reason.vertices || []) {
          const point = ctx.vertices.get(v); if (!point) continue;
          const face = ctx.faces.get(reason.faces[0]);
          for (const [e] of (face?.orientedLoops?.[0] || [])) {
            const frame = edgeFrame(ctx, e);
            if (!frame || !frame.line || ![frame.start, frame.end].some(p => norm(sub(p, point)) < ctx.span * 1e-6)) continue;
            const normal = cleanNormal(frame.direction);
            const sheet = [Number(volume.id)];
            push({ key: `slice:${normal.map(x => x.toFixed(6))}:${dot(point, normal).toFixed(6)}:${volume.id}`, label: `Slice through vertex ${v}`, detail: `Plane ⟂ edge ${e} through the re-entrant corner`, faces: reason.faces, vertices: [v],
              operation: { kind: 'slice', planes: [{ origin: point.slice(), normal }], volumeIds: sheet, label: `Sliced solid ${volume.id} at vertex ${v}` },
              slice: { origin: point.slice(), normal, scope: 'solids', volumeIds: sheet } });
          }
        }
      }
    }
    {
      // Bounded cuts. Imprints on a blocked face's plane are followed exactly
      // (a plane through an L-shaped footprint would also cut what lies past
      // its corner), and two re-entrant edges that see each other across a cap
      // are joined by one cut.
      const own = new Set((ctx.volumes.get(Number(volume.id))?.faces || []).map(Number));
      if ((volume.reasons || []).some(r => r.code === 'reentrant')) pocketCuts(ctx, volume.id).forEach(push);
      if ((volume.reasons || []).some(r => r.code === 'face-holes')) openingLevels(ctx, recognized, volume).forEach(push);
      const cited = (volume.reasons || []).filter(r => r.code === 'face-corners' || r.code === 'face-reflex').flatMap(r => r.faces || []).map(Number);
      const planesDone = new Set();
      for (const faceId of cited) {
        const face = ctx.faces.get(faceId);
        if (face?.surface?.kind !== 'plane' || !own.has(faceId)) continue;
        const n = cleanNormal(face.surface.normal), planeKey = `${n.map(x => x.toFixed(6))}:${dot(face.surface.origin, n).toFixed(6)}`;
        if (planesDone.has(planeKey)) continue;
        planesDone.add(planeKey);
        const coplanar = [...own].filter(g => {
          const sg = ctx.faces.get(g)?.surface;
          return sg?.kind === 'plane' && Math.abs(Math.abs(dot(unit(sg.normal), n)) - 1) < 1e-6 && Math.abs(dot(sub(sg.origin, face.surface.origin), n)) < ctx.span * 1e-6;
        });
        if (coplanar.length < 2) continue;
        const edges = new Set();
        for (const g of coplanar) for (const e of ctx.faceEdges.get(g) || []) {
          const shared = [...(ctx.edgeFaces.get(e) || [])].some(h => h !== g && coplanar.includes(h));
          if (shared && edgeFrame(ctx, e)?.line && Math.abs((edgeAngle(ctx, e, volume.id) ?? 0) - 180) < 1) edges.add(e);
        }
        if (!edges.size || edges.size > 16) continue;
        const list = [...edges].sort((a, b) => a - b);
        const operation = cutOperation(ctx, list.map(e => { const f = edgeFrame(ctx, e); return { a: f.start, b: f.end }; }), n, [volume.id],
          `Cut solid ${volume.id} along ${list.length} imprint edge${list.length === 1 ? '' : 's'}`, coplanar);
        if (operation) push({ key: `cut-imprints:${volume.id}:${planeKey}`, label: `Cut along ${list.length} imprint edge${list.length === 1 ? '' : 's'}`,
          detail: `Bounded cuts that stop where the imprints on face${coplanar.length === 1 ? '' : 's'} ${coplanar.slice(0, 4).join(', ')}${coplanar.length > 4 ? '…' : ''} stop`, edges: list, faces: coplanar, operation });
      }
      // A piece of a hole (sectors fused back together, or a hole cut by an
      // earlier slice): radial cuts from the hole axis to the piece's own
      // corners split it into sectors again.
      if (recognized && (volume.reasons || []).some(r => r.code === 'face-corners')) {
        for (const feature of recognized.features.filter(f => f.kind === 'hole' && f.solids.includes(Number(volume.id)))) {
          const axis = unit(feature.axis), arc = new Set([...own].filter(g => feature.faces.includes(g)).flatMap(g => faceVertices(ctx, g)));
          const cap = [...own].map(g => ctx.faces.get(g)).find(face => face?.surface?.kind === 'plane' && Math.abs(Math.abs(dot(unit(face.surface.normal), axis)) - 1) < 1e-6);
          if (!cap || !arc.size) continue;
          const rays = (cap.corners?.[0] || []).filter(([v, angle]) => angle != null && angle < 140 && !arc.has(Number(v))).map(([v]) => {
            const offset = sub(ctx.vertices.get(Number(v)), feature.center), radial = sub(offset, scale(axis, dot(offset, axis)));
            return norm(radial) > feature.radius * 1.05 ? { origin: feature.center.slice(), axis: axis.slice(), direction: unit(radial), length: norm(radial) + ctx.span * 1e-5 } : null;
          }).filter(Boolean);
          if (rays.length) push({ key: `split-arc:${volume.id}:${feature.id}`, label: 'Split around the hole', detail: `${rays.length} radial cut${rays.length === 1 ? '' : 's'} from the ${feature.label} axis to the corners of solid ${volume.id}`, faces: feature.faces.filter(f => own.has(f)),
            operation: { kind: 'slice', rays, volumeIds: [Number(volume.id)], label: `Split solid ${volume.id} around ${feature.label}` } });
        }
      }
      const reentrant = [...new Set((volume.reasons || []).filter(r => r.code === 'reentrant').flatMap(r => r.edges || []).map(Number))]
        .map(e => ({ e, frame: edgeFrame(ctx, e) })).filter(x => x.frame?.line);
      for (let i = 0; i < reentrant.length; i++) for (let j = i + 1; j < reentrant.length; j++) {
        const A = reentrant[i], B = reentrant[j], axis = A.frame.direction;
        if (Math.abs(Math.abs(dot(axis, B.frame.direction)) - 1) > 1e-6) continue;
        for (const g of own) {
          const sg = ctx.faces.get(g)?.surface;
          if (sg?.kind !== 'plane' || Math.abs(Math.abs(dot(unit(sg.normal), axis)) - 1) > 1e-6) continue;
          const verts = faceVertices(ctx, g);
          const va = (ctx.edges.get(A.e)?.vertices || []).map(Number).find(v => verts.includes(v));
          const vb = (ctx.edges.get(B.e)?.vertices || []).map(Number).find(v => verts.includes(v));
          if (va == null || vb == null) continue;
          // Both ends must be re-entrant corners of the cap itself.
          const capCorners = new Map((ctx.faces.get(g).corners || []).flat().map(([v, angle]) => [Number(v), angle]));
          if (!((capCorners.get(va) ?? 0) > 200 && (capCorners.get(vb) ?? 0) > 200)) continue;
          const a = ctx.vertices.get(va), b = ctx.vertices.get(vb);
          if (![0.2, 0.4, 0.5, 0.6, 0.8].every(t => insideFace(ctx, g, add(a, scale(sub(b, a), t))))) continue;
          // The cut must cross the cap, not run along one of its edges.
          const cap = planarRings(ctx, g), m = cap.flat(scale(add(a, b), 0.5));
          if (cap.rings.some(r => r.flat.some((p, k) => segmentDistance(m, p, r.flat[(k + 1) % r.flat.length]) < ctx.span * 1e-4))) continue;
          const operation = cutOperation(ctx, [{ a, b }], axis, [volume.id], `Joined re-entrant edges ${A.e} and ${B.e} of solid ${volume.id}`, [g]);
          if (operation) push({ key: `join:${volume.id}:${A.e}:${B.e}`, label: 'Cut between re-entrant edges', detail: `Edges ${A.e} and ${B.e}, straight across face ${g}`, edges: [A.e, B.e], vertices: [va, vb], faces: [g], operation });
          break;
        }
      }
    }
    // Small chamfers and blends adding extra sides.
    if ((volume.reasons || []).some(r => r.code === 'sides' || r.code === 'face-corners') && recognized) {
      const record = ctx.volumes.get(volume.id);
      for (const f of record?.faces || []) {
        const feature = recognized.byFace.get(Number(f));
        if (feature && (feature.kind === 'fillet' || feature.kind === 'chamfer')) {
          push({ key: 'remove:' + feature.id, label: `Remove ${feature.kind}`, detail: `${feature.label} adds extra block sides`, faces: feature.faces, feature: feature.kind, featureId: feature.id, operation: { kind: 'defeature', faceIds: feature.faces.slice(), label: `Removed ${feature.label}` } });
        }
      }
    }
    // Blends hide re-entrant edges, so remove them first; split holes once the block structure exists.
    const rank = action => {
      if (action.operation?.kind === 'defeature' && (action.feature === 'fillet' || action.feature === 'chamfer' || action.key.startsWith('remove:'))) return 0;
      // Whole-structure cuts first: they make the pieces the other fixes work on.
      if (action.key.startsWith('pocket:')) return 0.8;
      if (action.key.startsWith('levels:')) return 0.85;
      if (action.key.startsWith('join:')) return 0.9;
      if (action.key.startsWith('slice:')) return 1;
      // One bounded cut along several imprints replaces as many single-plane extensions.
      if (action.key.startsWith('cut-imprints:')) return action.edges.length > 1 ? 0.95 : 1.05;
      if (action.key.startsWith('split-arc')) return 1.9;
      if (action.key.startsWith('split-mid')) return 2;
      // Square cells also separate holes that share a face, with better sectors.
      if (action.key.startsWith('box-holes')) return 1.44;
      if (action.key.startsWith('box-hole')) return 1.45;
      if (action.key.startsWith('separate-holes')) return 1.5;
      if (action.key.startsWith('split-hole-ring')) return 3;
      if (action.key.startsWith('split-hole')) return 2;
      if (action.operation?.kind === 'defeature') return 4;
      if (action.tool === 'passages') return 5;
      return 6;
    };
    actions.sort((a, b) => rank(a) - rank(b));
    actions.forEach((action, i) => { action.primary = i === 0; });
    return actions;
  }

  /**
   * Repeatedly apply the best fix until every solid is a mapped block, then
   * square up badly tapered blocks. A step is kept only when its previewed
   * result is better; blend removal is always kept when allowed.
   *
   * session: { state() -> { topology, preview, revision }, preview(op, { lite }), apply(op), undo() }
   * options: { mapping (hex-mapping module), blends, holes, shape, maxSteps, concurrency, progress(message) }
   *
   * Candidate previews run up to `concurrency` (default 4) at a time, and the
   * candidates the search would try next are previewed ahead. Results are
   * still judged one by one in the sequential order, so the same fixes win.
   * Previews ask for { lite: true }, without the display tessellation, unless
   * a trial mesh needs it to project onto approximated ('mesh') surfaces.
   */
  async function autoFix(session, options = {}) {
    const H = options.mapping, progress = options.progress || (() => {});
    // Features stay unless asked: the user removes what the analysis does not need.
    const blends = options.blends === true, holes = options.holes !== false, shape = options.shape !== false;
    const maxSteps = options.maxSteps || 40;
    // options.signal (an AbortSignal) stops the search: a preview being awaited
    // is dropped, a step being applied completes, and every applied step stays.
    const signal = options.signal || null, STOP = Error('Auto-fix was stopped.');
    const halt = () => { if (signal?.aborted) throw STOP; };
    const pass = error => { if (error === STOP) throw error; };
    const abortable = promise => !signal ? promise : new Promise((resolve, reject) => {
      if (signal.aborted) { reject(STOP); return; }
      const onAbort = () => reject(STOP);
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
    });
    const current = () => { const st = session.state(); return { ...st, analysis: H.analyze(st.topology), recognized: recognize(st.topology) }; };
    // session.state() returns { topology, preview, revision }.
    const solids = a => [...a.volumes.values()];
    const score = a => [solids(a).filter(v => v.mappable).length, -solids(a).reduce((n, v) => n + v.reasons.length, 0)];
    const cusps = a => solids(a).reduce((n, v) => n + v.reasons.filter(r => /cusp/.test(r.code)).length, 0);
    const tapers = a => solids(a).reduce((n, v) => n + (v.warnings || []).filter(w => w.code === 'taper').length, 0);
    const minTaper = a => Math.min(1, ...solids(a).filter(v => v.mappable).map(v => v.block.taper));
    const better = (x, y) => x[0] > y[0] || (x[0] === y[0] && x[1] > y[1]);
    // Edge-count equations must stay solvable: T-junction cycles can make them
    // contradictory even when every block maps.
    const sizeFor = topology => Number(options.size) > 0 ? Number(options.size) : Math.max(topology.bounds[3] - topology.bounds[0], topology.bounds[4] - topology.bounds[1], topology.bounds[5] - topology.bounds[2]) / 25;
    const intervalsOf = (a, topology) => { try { return H.solveIntervals(a, { size: sizeFor(topology) }); } catch { return null; } };
    // Every candidate is compared with the current state: count its conflicts once.
    const conflictCounts = new WeakMap();
    const conflicts = (a, topology) => {
      if (!conflictCounts.has(a)) conflictCounts.set(a, intervalsOf(a, topology)?.conflicts.length || 0);
      return conflictCounts.get(a);
    };
    const concurrency = Math.max(1, Math.floor(Number(options.concurrency) || 4));
    let running = 0;
    const waiting = [];
    const acquire = () => {
      if (running < concurrency) { running++; return Promise.resolve(); }
      return new Promise(resolve => waiting.push(resolve));
    };
    const release = () => { const next = waiting.shift(); if (next) next(); else running--; };
    // Bumped whenever the geometry changes: queued previews of an older state never start.
    let epoch = 0;
    const request = (operation, lite) => {
      const issued = epoch;
      const pending = acquire().then(() => {
        if (issued !== epoch) throw Error('The geometry changed before this preview started.');
        if (signal?.aborted) throw STOP;
        return lite ? session.preview(operation, { lite: true }) : session.preview(operation);
      }).finally(release);
      const result = abortable(pending);
      result.catch(() => {}); // judged later, or dropped once another fix is applied or Auto-fix stops
      return result;
    };
    const approximated = topology => (topology.faces || []).some(f => f.surface?.kind === 'mesh');
    // Only blends no wider than 1.5 elements are removed: larger fillets and
    // chamfers (a chamfered corner, say) are design geometry that maps as is.
    const smallBlend = (feature, topology) => !!feature && (feature.kind === 'fillet' || feature.kind === 'chamfer')
      && (Number(feature.radius ?? feature.width) || Infinity) <= 1.5 * sizeFor(topology);
    const allowed = a => {
      if (!a.operation) return false;
      if (a.operation.kind === 'defeature') return blends && (a.feature === 'fillet' || a.feature === 'chamfer') && smallBlend(st.recognized.features.find(f => f.id === a.featureId), st.topology);
      if (a.key.startsWith('split-hole-ring') || a.tool) return false;
      if (a.key.startsWith('split-hole')) return holes;
      return a.operation.kind === 'slice';
    };
    const applied = [], tried = new Set();
    const signature = (st, a) => (a.operation.kind === 'defeature' ? st.revision + ':' : '') + JSON.stringify(a.operation);
    const commit = async (operation, label) => { halt(); epoch++; await session.apply(operation); applied.push(label); progress(`Step ${applied.length}: ${label}`); };
    let st = current();
    const start = st.analysis.summary;
    // Every applied step is kept when the planner stops short or fails, so
    // the user continues by hand from its cuts (or undoes them one at a time).
    let failure = null, stopped = false;
    try {
      if (blends) {
        // One defeature for every blend on a blocked solid is far faster than one per blend.
        const blocked = new Set(solids(st.analysis).filter(v => !v.mappable).map(v => v.id));
        const list = st.recognized.features.filter(f => smallBlend(f, st.topology) && f.solids.some(v => blocked.has(v)));
        if (list.length > 1) {
          progress(`Removing ${list.length} fillets and chamfers…`);
          try { await commit({ kind: 'defeature', faceIds: [...new Set(list.flatMap(f => f.faces))].sort((a, b) => a - b), label: `Removed ${list.length} fillets and chamfers` }, `Removed ${list.length} fillets and chamfers`); }
          catch (error) { pass(error); /* fall back to one blend at a time */ }
          st = current();
        }
      }
      // Phase 1: make every solid a mapped block.
      const mapAll = async limit => {
      const begin = applied.length;
      while (applied.length < maxSteps && applied.length - begin < limit) {
        halt();
        const blocked = solids(st.analysis).filter(v => !v.mappable)
          .sort((a, b) => (Number(st.topology.volumes.find(x => x.id === b.id)?.volume) || 0) - (Number(st.topology.volumes.find(x => x.id === a.id)?.volume) || 0));
        if (!blocked.length) break;
        // The groups the search tries from this state, in order: the first untried
        // fix of the largest blocked solid, plus alternative planes for the same
        // re-entrant edge (preview each, keep the smaller cut). The first group is
        // usually kept, so it runs alone; once one is rejected, the groups after
        // it are previewed ahead while it is judged.
        const planned = new Set(tried);
        let exhausted = false;
        const plan = () => {
          let candidate = null, owner = null;
          for (const v of blocked) {
            const list = fixes(st.recognized.ctx, st.recognized, v).filter(a => allowed(a) && !planned.has(signature(st, a)));
            if (list.length) { candidate = list[0]; owner = v; break; }
          }
          if (!candidate) { exhausted = true; return null; }
          const alternatives = [candidate];
          if (candidate.key.startsWith('slice:') && candidate.edges?.length) {
            for (const a of fixes(st.recognized.ctx, st.recognized, owner)) if (a.key !== candidate.key && a.key.startsWith('slice:') && (a.edges || []).some(e => candidate.edges.includes(e)) && allowed(a)) alternatives.push(a);
          }
          for (const option of alternatives) planned.add(signature(st, option));
          return alternatives.map(option => ({ option, pending: request(option.operation, true) }));
        };
        const groups = [];
        let ahead = 0;
        const lookahead = window => {
          while (!exhausted && ahead < window) { const group = plan(); if (group) { groups.push(group); ahead += group.length; } }
        };
        let best = null;
        lookahead(1);
        while (!best && groups.length) {
          for (const { option, pending } of groups.shift()) {
            ahead--;
            tried.add(signature(st, option));
            progress(`Step ${applied.length + 1}: trying ${option.label.toLowerCase()}…`);
            let data;
            try { data = await pending; } catch (error) { pass(error); continue; }
            const result = H.analyze(data.topology), value = score(result);
            if (cusps(result) > cusps(st.analysis)) continue;
            // Cheap test before the interval solve; either rejects the fix.
            if (option.operation.kind !== 'defeature' && !better(value, score(st.analysis))) continue;
            if (conflicts(result, data.topology) > conflicts(st.analysis, st.topology)) continue;
            const plane = option.operation.planes?.[0];
            const cut = plane ? data.topology.faces.filter(f => (f.volumes || []).length > 1 && f.surface?.kind === 'plane' && Math.abs(Math.abs(dot(unit(f.surface.normal), unit(plane.normal))) - 1) < 1e-6 && Math.abs(dot(sub(f.surface.origin, plane.origin), unit(plane.normal))) < st.recognized.ctx.span * 1e-6).reduce((sum, f) => sum + (Number(f.area) || 0), 0) : 0;
            if (!best || better(value, best.value) || (value[0] === best.value[0] && value[1] === best.value[1] && cut < best.cut)) best = { option, value, cut };
          }
          if (!best) lookahead(concurrency);
        }
        if (!best) break;
        await commit(best.option.operation, best.option.operation.label || best.option.label);
        st = current();
      }
      return applied.length - begin;
      };
      await mapAll(maxSteps);
      // Phase 1b: remove T-junction cycles that make the edge counts unsolvable.
      for (let round = 0; round < 8 && applied.length < maxSteps; round++) {
        const intervals = intervalsOf(st.analysis, st.topology);
        if (!intervals || !intervals.conflicts.length) break;
        const now = intervals.conflicts.length, blockedNow = solids(st.analysis).filter(v => !v.mappable).length;
        let best = null;
        const options = conflictFixes(st.recognized.ctx, st.analysis, intervals).filter(a => !tried.has(signature(st, a))).slice(0, 6);
        const previews = options.map(option => request(option.operation, true));
        for (const [index, option] of options.entries()) {
          tried.add(signature(st, option));
          progress(`Resolving edge-count conflicts: ${option.label.toLowerCase()}…`);
          let data;
          try { data = await previews[index]; } catch (error) { pass(error); continue; }
          const result = H.analyze(data.topology), left = conflicts(result, data.topology);
          if (left >= now || cusps(result) > cusps(st.analysis) || solids(result).filter(v => !v.mappable).length > blockedNow) continue;
          if (!best || left < best.left) best = { option, left };
        }
        if (!best) break;
        await commit(best.option.operation, best.option.operation.label || best.option.label);
        st = current();
        await mapAll(6);
      }
      // Phase 2: reshape poor blocks, judged by the mapped mesh they actually give.
      if (shape) {
        const size = Number(options.size) > 0 ? Number(options.size) : null;
        const target = Number(options.targetQuality) > 0 ? Number(options.targetQuality) : 0.3;
        const quality = (topology, preview, analysis) => {
          try {
            const ctxSpan = Math.max(topology.bounds[3] - topology.bounds[0], topology.bounds[4] - topology.bounds[1], topology.bounds[5] - topology.bounds[2]);
            const intervals = H.solveIntervals(analysis, { size: size || ctxSpan / 25 });
            if (!intervals.solvable || !intervals.region.volumes.length) return null;
            const mesh = H.generateMesh(analysis, intervals, H.createGeometry(topology, preview), { order: 1 });
            const per = new Map(mesh.quality.perVolume.map(p => [p.volume, p.minScaledJacobian]));
            let deficit = 0; for (const value of per.values()) deficit += Math.max(0, target - value);
            return { min: mesh.quality.minScaledJacobian, deficit, per };
          } catch { return null; }
        };
        const blocked = a => solids(a).filter(x => !x.mappable).length;
        let q = quality(st.topology, st.preview, st.analysis);
        for (let round = 0; q && q.min < target && round < 10 && applied.length < maxSteps; round++) {
          const worst = [...q.per].filter(([, value]) => value < target).sort((a, b) => a[1] - b[1]).slice(0, 2).map(([id]) => st.analysis.volumes.get(id)).filter(Boolean);
          let best = null;
          const options = [];
          for (const v of worst) {
            const list = shapeFixes(st.recognized.ctx, v).filter(a => !tried.has(signature(st, a))).slice(0, 5);
            for (const option of list) tried.add(signature(st, option));
            options.push(...list);
          }
          // Trial meshes project onto approximated surfaces through their display triangles.
          const lite = !approximated(st.topology);
          const previews = options.map(option => request(option.operation, lite));
          for (const [index, option] of options.entries()) {
            progress(`Improving element quality: ${option.detail.toLowerCase()}…`);
            let data;
            try { data = await previews[index]; } catch (error) { pass(error); continue; }
            const result = H.analyze(data.topology);
            if (cusps(result) > cusps(st.analysis) || conflicts(result, data.topology) > conflicts(st.analysis, st.topology)) continue;
            if (data.preview?.lite && approximated(data.topology)) {
              try { data = await request(option.operation, false); } catch (error) { pass(error); continue; }
            }
            const next = quality(data.topology, data.preview, result);
            if (!next || next.deficit > q.deficit - 0.02 || next.min < q.min - 1e-9) continue;
            const repair = blocked(result) > blocked(st.analysis);
            if (repair && typeof session.undo !== 'function') continue;
            // Prefer steps that keep every block mapped; others need a repair pass.
            if (!best || (best.repair && !repair) || (best.repair === repair && next.deficit < best.next.deficit)) best = { option, next, repair };
          }
          if (!best) break;
          const before = { count: applied.length, deficit: q.deficit, blocked: blocked(st.analysis) };
          await commit(best.option.operation, best.option.operation.label || best.option.label);
          st = current();
          if (best.repair) {
            // A stop during the repair still returns to a state without the broken block.
            let interrupted = false;
            try { await mapAll(6); } catch (error) { if (error !== STOP) throw error; interrupted = true; }
            const repaired = quality(st.topology, st.preview, st.analysis);
            if (blocked(st.analysis) > before.blocked || !repaired || repaired.deficit > before.deficit - 0.02) {
              // The repair did not pay off: return to the state before this step.
              progress('Reverting a reshaping step that did not improve quality…');
              for (let k = applied.length; k > before.count; k--) { epoch++; await session.undo(); applied.pop(); }
              st = current();
              halt();
              continue;
            }
            if (interrupted) throw STOP;
          }
          q = quality(st.topology, st.preview, st.analysis);
        }
      }
    } catch (error) {
      if (error === STOP) stopped = true; else failure = error;
      try { st = current(); } catch { /* keep the last known state */ }
    }
    const end = st.analysis.summary;
    const reason = failure ? 'error' : stopped ? 'stopped' : !end.blocked ? 'done' : applied.length >= maxSteps ? 'limit' : 'stuck';
    return { steps: applied.length, applied, start, end, reason, error: failure ? failure.message || String(failure) : null,
      blocked: solids(st.analysis).filter(v => !v.mappable).map(v => v.id) };
  }

  /* ------------------------------------------------------------------ */
  /* Sheet sides, for midsurface shells                                  */
  /* ------------------------------------------------------------------ */

  /** The picked faces plus every face they meet tangentially (within 5°) in the same solid. */
  function tangentSide(topology, faceIds) {
    const faces = new Map(topology.faces.map(f => [Number(f.id), f]));
    const angles = new Map((topology.volumes || []).map(v => [Number(v.id), new Map((v.edgeAngles || []).map(([e, a]) => [Number(e), a]))]));
    const side = new Set(faceIds.map(Number)), queue = [...side];
    while (queue.length) {
      const face = faces.get(queue.pop());
      for (const v of face?.volumes || []) {
        for (const e of face.edges || []) {
          const angle = angles.get(Number(v))?.get(Number(e));
          if (angle == null || Math.abs(angle - 180) > 5) continue;
          for (const other of topology.faces) {
            const id = Number(other.id);
            if (!side.has(id) && (other.volumes || []).includes(v) && (other.edges || []).includes(e)) { side.add(id); queue.push(id); }
          }
        }
      }
    }
    return [...side].sort((a, b) => a - b);
  }

  /**
   * The faces across the sheet from the given ones: for each, the nearest face of
   * the same solid that is parallel (planes) or coaxial (cylinders) and overlaps it.
   */
  function oppositeSide(topology, faceIds) {
    const chosen = new Set(faceIds.map(Number)), b = topology.bounds;
    const span = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) || 1;
    const overlaps = (p, q, reach) => [0, 1, 2].every(i => p.bounds[i] - reach <= q.bounds[i + 3] && q.bounds[i] - reach <= p.bounds[i + 3]);
    const gap = (a, c) => {
      const s = a.surface, t = c.surface;
      if (s?.kind === 'plane' && t?.kind === 'plane') {
        const n = unit(s.normal);
        if (Math.abs(Math.abs(dot(n, unit(t.normal))) - 1) > 1e-3) return null;
        return Math.abs(dot(sub(t.origin, s.origin), n));
      }
      if (s?.kind === 'cylinder' && t?.kind === 'cylinder') {
        const axis = unit(s.axis);
        if (Math.abs(Math.abs(dot(axis, unit(t.axis))) - 1) > 1e-3) return null;
        const d = sub(t.origin, s.origin), off = sub(d, scale(axis, dot(d, axis)));
        if (norm(off) > span * 1e-6) return null;
        return Math.abs(s.radius - t.radius);
      }
      return null;
    };
    const opposite = new Set(), missing = [];
    for (const id of chosen) {
      const face = topology.faces.find(f => Number(f.id) === id);
      if (!face) continue;
      const candidates = topology.faces
        .filter(f => !chosen.has(Number(f.id)) && (f.volumes || []).some(v => (face.volumes || []).includes(v)))
        .map(f => ({ id: Number(f.id), d: gap(face, f), f }))
        .filter(c => c.d != null && c.d > span * 1e-6 && overlaps(face, c.f, c.d * 1.01 + span * 1e-6));
      if (!candidates.length) { missing.push(id); continue; }
      const nearest = Math.min(...candidates.map(c => c.d));
      for (const c of candidates) if (c.d <= nearest * 1.01) opposite.add(c.id);
    }
    return { faces: [...opposite].sort((x, y) => x - y), missing };
  }

  return { tangentSide, oppositeSide, recognize, infer, fixes, shapeFixes, conflictFixes, sheetVolumes, autoFix, holeSplit, holeCells, pocketCuts, openingLevels, squarePassage, edgeCut, cutOperation, vertexCut, segmentRays, insideFace, facePlane, edgeFrame, cleanNormal, solidsCut, context };
}));
