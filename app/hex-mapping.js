/* Native mapped hex meshing: block recognition, edge interval equations and
 * transfinite interpolation. Pure functions; no Gmsh, DOM or Three.js.
 *
 * Topology comes from cad_mapping.py: oriented face loops with exact interior
 * corner angles, and interior dihedral angles for every edge of every solid.
 *
 * 1. Faces with exactly four corner vertices are mappable; their boundary
 *    splits into four chains of CAD edges. Opposite chains must carry the same
 *    number of element edges: n(chain 0) = n(chain 2), n(chain 1) = n(chain 3).
 * 2. A solid is a mapped block when all of its faces are mappable, no edge is
 *    re-entrant, and its faces group (across flat edges) into six logical
 *    sides meeting at eight corners like a cube.
 * 3. The face equations of every block are solved together for integer edge
 *    counts. Shared CAD edges and faces make the resulting meshes conform.
 * 4. Each face is meshed by 2D transfinite interpolation and projected onto
 *    its surface; each block interior by 3D transfinite interpolation.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WebMeshHexMapping = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CUSP_MAX = 20;          // corners and edges sharper than this are degenerate (knife edges)
  const CORNER_MAX = 140;       // face corner below this angle is a block corner
  const AMBIGUOUS_MIN = 115;    // corners and dihedrals in [AMBIGUOUS_MIN, AMBIGUOUS_MAX] may be either kind,
  const AMBIGUOUS_MAX = 165;    // decided by what makes faces four-sided
  const TAPER_MIN = 0.1;        // shortest / longest parallel block edge before a block counts as badly shaped
  const FLAT_MIN = 140;         // dihedral angles in [FLAT_MIN, FLAT_MAX] join faces into one side
  const FLAT_MAX = 220;
  const MAX_ELEMENTS = 250000;
  const MAX_NODES = 500000;
  // Midside order used by the rest of WebMesh (modeling.js, editor-engine.js).
  const HEX20_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const HEX_CORNER_NEIGHBORS = [[1, 3, 4], [2, 0, 5], [3, 1, 6], [0, 2, 7], [7, 5, 0], [4, 6, 1], [5, 7, 2], [6, 4, 3]];
  const SIDE_NAMES = ['i0', 'i1', 'j0', 'j1', 'k0', 'k1'];

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => Math.hypot(a[0], a[1], a[2]);
  const unit = a => { const n = norm(a); return n > 0 ? scale(a, 1 / n) : [0, 0, 0]; };
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  class UnionFind {
    constructor() { this.parent = new Map(); }
    find(x) {
      if (!this.parent.has(x)) this.parent.set(x, x);
      let rootValue = x;
      while (this.parent.get(rootValue) !== rootValue) rootValue = this.parent.get(rootValue);
      while (this.parent.get(x) !== rootValue) { const next = this.parent.get(x); this.parent.set(x, rootValue); x = next; }
      return rootValue;
    }
    union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(rb, ra); return ra !== rb; }
  }

  function indexTopology(topology) {
    const vertices = new Map((topology.vertices || []).map(v => [Number(v.id), v.point]));
    const edges = new Map((topology.edges || []).map(e => [Number(e.id), e]));
    const faces = new Map((topology.faces || []).map(f => [Number(f.id), f]));
    const volumes = new Map((topology.volumes || []).map(v => [Number(v.id), v]));
    return { vertices, edges, faces, volumes };
  }

  /* ------------------------------------------------------------------ */
  /* Face classification                                                 */
  /* ------------------------------------------------------------------ */

  function classifyFace(face, edges, overrides, vertices) {
    const id = Number(face.id);
    const fail = (code, message, extra = {}) => ({ id, mappable: false, code, message, ...extra });
    const loops = Array.isArray(face.orientedLoops) ? face.orientedLoops : [];
    if (!loops.length) return fail('topology', `Face ${id} has no boundary loop data. Reimport the CAD with the current server.`);
    if (loops.length > 1) return fail('holes', `Face ${id} has ${loops.length - 1} inner loop${loops.length > 2 ? 's' : ''} (a hole or boss outline). Remove the feature or slice through it.`, { edges: loops.slice(1).flat().map(([e]) => Number(e)) });
    const loop = loops[0].map(([edge, sense]) => ({ edge: Number(edge), sense: Number(sense) }));
    const corners = (face.corners && face.corners[0]) || [];
    if (loop.some(item => item.sense === 0) || corners.length !== loop.length) return fail('topology', `Face ${id} has an unordered boundary loop.`);
    const counts = new Map();
    for (const { edge } of loop) counts.set(edge, (counts.get(edge) || 0) + 1);
    const seams = [...counts].filter(([, n]) => n > 1).map(([edge]) => edge);
    if (seams.length) return fail('periodic', `Face ${id} is a closed periodic surface (seam edge ${seams.join(', ')}). Slice it through its axis into at least two pieces.`, { edges: seams });
    if (loop.length === 1 || loop.some(item => edges.get(item.edge)?.closed)) return fail('closed', `Face ${id} is bounded by a closed curve with no corners. Slice it so each piece has four corners (an O-grid).`, { edges: loop.map(item => item.edge) });
    const forced = overrides && overrides.get(id);
    const kinds = corners.map(([vertex, angle]) => {
      if (forced) return forced.has(Number(vertex)) ? 'end' : 'side';
      if (angle == null) return 'unknown';
      if (angle < CORNER_MAX) return 'end';
      if (angle <= FLAT_MAX) return 'side';
      return 'reflex';
    });
    if (kinds.includes('unknown')) return fail('angles', `Face ${id} has a corner angle the CAD kernel could not classify.`, { vertices: corners.filter((_, i) => kinds[i] === 'unknown').map(([v]) => Number(v)) });
    const cusps = corners.filter(([, angle]) => !forced && angle != null && angle < CUSP_MAX).map(([v]) => Number(v));
    if (cusps.length) return fail('cusp', `Face ${id} has a ${corners.find(([v]) => Number(v) === cusps[0])[1].toFixed(0)}° cusp at vertex ${cusps.join(', ')}. A slice probably grazed a curved face; undo it and slice elsewhere.`, { vertices: cusps });
    const reflex = corners.filter((_, i) => kinds[i] === 'reflex').map(([v]) => Number(v));
    if (reflex.length) return fail('reflex', `Face ${id} has a re-entrant corner at vertex ${reflex.join(', ')}. Slice through that corner so every piece is four-sided.`, { vertices: reflex });
    // Resolve ambiguous corners so the face has four: promote the sharpest
    // obtuse vertex (140–165°) when three are clear, or demote the bluntest
    // corner (115–140°) when there are five or more.
    const promoted = [], demoted = [];
    // Equal angles are decided by vertex position, which is the same on both
    // caps of a prism (unlike loop order), so the caps agree on their corners.
    const position = i => (vertices && vertices.get(Number(corners[i][0]))) || [0, 0, 0];
    const tie = (x, y) => { const p = position(x[1]), q = position(y[1]); for (let k = 0; k < 3; k++) if (Math.abs(p[k] - q[k]) > 1e-6) return p[k] - q[k]; return 0; };
    const sharp = (x, y) => Math.abs(x[0] - y[0]) > 0.05 ? x[0] - y[0] : tie(x, y);
    if (!forced) {
      let count = kinds.filter(k => k === 'end').length;
      if (count < 4) {
        const options = corners.map(([, a], i) => [a, i]).filter(([a, i]) => kinds[i] === 'side' && a >= CORNER_MAX && a <= AMBIGUOUS_MAX).sort(sharp);
        if (count + options.length >= 4) for (const [, i] of options.slice(0, 4 - count)) { kinds[i] = 'end'; promoted.push(Number(corners[i][0])); count++; }
      } else if (count > 4) {
        const options = corners.map(([, a], i) => [a, i]).filter(([a, i]) => kinds[i] === 'end' && a >= AMBIGUOUS_MIN).sort((x, y) => sharp(y, x));
        if (count - options.length <= 4) for (const [, i] of options.slice(0, count - 4)) { kinds[i] = 'side'; demoted.push(Number(corners[i][0])); count--; }
      }
    }
    const ends = kinds.map((kind, i) => kind === 'end' ? i : -1).filter(i => i >= 0);
    if (ends.length !== 4) {
      return fail('corners', `Face ${id} has ${ends.length} corner${ends.length === 1 ? '' : 's'}; a mapped face needs exactly 4.`, { vertices: ends.map(i => Number(corners[i][0])) });
    }
    const chains = ends.map((start, k) => {
      const stop = ends[(k + 1) % 4], chain = [];
      for (let i = start; i !== stop; i = (i + 1) % loop.length) chain.push(loop[i]);
      return chain;
    });
    return { id, mappable: true, corners: ends.map(i => Number(corners[i][0])), chains, promoted, demoted };
  }

  /* ------------------------------------------------------------------ */
  /* Volume (block) classification                                       */
  /* ------------------------------------------------------------------ */

  function chainVertices(chain, edges) {
    const ends = item => {
      const e = edges.get(item.edge), [a, b] = e.vertices;
      return item.sense > 0 ? [Number(a), Number(b)] : [Number(b), Number(a)];
    };
    return { start: ends(chain[0])[0], end: ends(chain[chain.length - 1])[1] };
  }

  function orderedChain(edgeIds, edges, from) {
    // Order unordered CAD edges into a path starting at vertex `from`.
    const remaining = new Set(edgeIds), path = [];
    let current = from;
    while (remaining.size) {
      let found = null;
      for (const edge of remaining) {
        const [a, b] = edges.get(edge).vertices.map(Number);
        if (a === current) { found = { edge, sense: 1 }; current = b; break; }
        if (b === current) { found = { edge, sense: -1 }; current = a; break; }
      }
      if (!found) return null;
      remaining.delete(found.edge); path.push(found);
    }
    return { path, end: current };
  }

  function classifyVolume(volume, index, faceInfo) {
    const id = Number(volume.id), { edges, faces } = index;
    const reasons = [];
    const volumeFaces = (volume.faces || []).map(Number);
    for (const faceId of volumeFaces) {
      const info = faceInfo.get(faceId);
      if (!info) reasons.push({ code: 'face', faces: [faceId], message: `Face ${faceId} is missing from the topology.` });
      else if (!info.mappable) reasons.push({ code: 'face-' + info.code, faces: [faceId], edges: info.edges || [], vertices: info.vertices || [], message: info.message });
    }
    const angles = new Map((volume.edgeAngles || []).map(([edge, angle]) => [Number(edge), angle == null ? null : Number(angle)]));
    const edgeFaces = new Map();
    for (const faceId of volumeFaces) {
      for (const loop of faces.get(faceId)?.orientedLoops || []) for (const [edge] of loop) {
        const list = edgeFaces.get(Number(edge)) || [];
        list.push(faceId); edgeFaces.set(Number(edge), list);
      }
    }
    for (const [edge, angle] of angles) {
      if (angle == null) reasons.push({ code: 'angle', edges: [edge], message: `The angle across edge ${edge} could not be classified.` });
      else if (angle < CUSP_MAX) reasons.push({ code: 'cusp', edges: [edge], faces: edgeFaces.get(edge) || [], angle, message: `Edge ${edge} is a knife edge (${Math.round(angle)}°) where faces meet tangentially. A slice probably grazed a curved face; undo it and slice elsewhere.` });
      else if (angle > FLAT_MAX) reasons.push({ code: 'reentrant', edges: [edge], faces: edgeFaces.get(edge) || [], angle, message: `Edge ${edge} is re-entrant (${Math.round(angle)}°). Slice the solid along one of its adjacent faces.` });
    }
    if (reasons.length) return { id, mappable: false, reasons };
    const sides = new UnionFind();
    volumeFaces.forEach(f => sides.find(f));
    const blockEdges = [];
    // An ambiguous edge is a block edge when its end vertices are corners of the
    // faces that meet it end-on, and flat when they are not.
    const endOn = (edge, vertex) => {
      const votes = [];
      for (const faceId of volumeFaces) {
        const info = faceInfo.get(faceId);
        if (!info?.mappable || (edgeFaces.get(edge) || []).includes(faceId)) continue;
        const loop = faces.get(faceId).orientedLoops?.[0] || [];
        if (!loop.some(([e]) => (edges.get(Number(e))?.vertices || []).map(Number).includes(vertex))) continue;
        votes.push(info.corners.includes(vertex));
      }
      return votes;
    };
    const flatEdge = (edge, angle) => {
      if (angle < AMBIGUOUS_MIN || angle > FLAT_MAX) return false;
      if (angle > AMBIGUOUS_MAX) return true;
      const votes = (edges.get(edge)?.vertices || []).map(Number).flatMap(v => endOn(edge, v));
      if (votes.length && votes.every(Boolean)) return false;
      if (votes.length && votes.every(x => !x)) return true;
      return angle >= FLAT_MIN;
    };
    for (const [edge, owners] of edgeFaces) {
      const angle = angles.get(edge);
      if (owners.length === 2 && angle != null && flatEdge(edge, angle)) sides.union(owners[0], owners[1]);
      else blockEdges.push(edge);
    }
    const sideOf = new Map(volumeFaces.map(f => [f, sides.find(f)]));
    const sideIds = [...new Set(sideOf.values())];
    const sideFaces = new Map(sideIds.map(s => [s, volumeFaces.filter(f => sideOf.get(f) === s)]));
    if (sideIds.length !== 6) {
      return { id, mappable: false, reasons: [{ code: 'sides', faces: volumeFaces, sideCount: sideIds.length, message: sideIds.length < 6
        ? `Solid ${id} has ${sideIds.length} logical sides; a mapped block needs 6. Slice it into box-like pieces.`
        : `Solid ${id} has ${sideIds.length} logical sides; a mapped block needs 6. Remove small faces (chamfers, fillets) or slice it.` }] };
    }
    const vertexSides = new Map();
    for (const faceId of volumeFaces) {
      for (const loop of faces.get(faceId).corners || []) for (const [vertex] of loop) {
        const set = vertexSides.get(Number(vertex)) || new Set();
        set.add(sideOf.get(faceId)); vertexSides.set(Number(vertex), set);
      }
    }
    const blockCorners = [...vertexSides].filter(([, set]) => set.size >= 3).map(([v]) => v);
    const overloaded = [...vertexSides].filter(([, set]) => set.size > 3).map(([v]) => v);
    if (blockCorners.length !== 8 || overloaded.length) {
      return { id, mappable: false, reasons: [{ code: 'block-corners', vertices: overloaded.length ? overloaded : blockCorners, message: `Solid ${id} has ${blockCorners.length} block corners; a mapped block needs 8 where exactly three sides meet.` }] };
    }
    const logical = new Map();
    for (const edge of blockEdges) {
      const owners = edgeFaces.get(edge);
      if (!owners || owners.length !== 2) return { id, mappable: false, reasons: [{ code: 'nonmanifold', edges: [edge], message: `Edge ${edge} is not shared by exactly two faces of solid ${id}.` }] };
      const [a, b] = owners.map(f => sideOf.get(f));
      if (a === b) return { id, mappable: false, reasons: [{ code: 'side-crease', edges: [edge], faces: owners, message: `Edge ${edge} creases one logical side of solid ${id}. Slice along it.` }] };
      const key = a < b ? a + ':' + b : b + ':' + a;
      if (!logical.has(key)) logical.set(key, { sides: [Math.min(a, b), Math.max(a, b)], edges: [] });
      logical.get(key).edges.push(edge);
    }
    if (logical.size !== 12) return { id, mappable: false, reasons: [{ code: 'block-edges', edges: blockEdges, message: `Solid ${id} has ${logical.size} logical block edges; a mapped block needs 12.` }] };
    const cornerSet = new Set(blockCorners);
    const adjacency = new Map(sideIds.map(s => [s, new Set()]));
    for (const item of logical.values()) {
      adjacency.get(item.sides[0]).add(item.sides[1]); adjacency.get(item.sides[1]).add(item.sides[0]);
      const touching = new Set();
      for (const edge of item.edges) for (const v of edges.get(edge).vertices.map(Number)) if (cornerSet.has(v)) touching.add(v);
      if (touching.size !== 2) return { id, mappable: false, reasons: [{ code: 'block-edges', edges: item.edges, message: `A block edge of solid ${id} does not run between two corners.` }] };
      const [from, to] = [...touching];
      const ordered = orderedChain(item.edges, edges, from);
      if (!ordered || ordered.end !== to) return { id, mappable: false, reasons: [{ code: 'block-edges', edges: item.edges, message: `A block edge of solid ${id} is not a single chain of CAD edges.` }] };
      item.corners = [from, to]; item.chain = ordered.path;
    }
    if ([...adjacency.values()].some(set => set.size !== 4)) return { id, mappable: false, reasons: [{ code: 'block-topology', faces: volumeFaces, message: `Solid ${id} is not cube-like: every side must touch exactly four others.` }] };
    // Frame: corner c000 and its three block edges define the I, J and K directions.
    const c000 = Math.min(...blockCorners);
    const fromCorner = [...logical.values()].filter(item => item.corners.includes(c000));
    if (fromCorner.length !== 3) return { id, mappable: false, reasons: [{ code: 'block-topology', vertices: [c000], message: `Corner ${c000} of solid ${id} does not have three block edges.` }] };
    const other = item => item.corners[0] === c000 ? item.corners[1] : item.corners[0];
    const [ei, ej, ek] = fromCorner;
    const sharedSide = (a, b) => a.sides.find(s => b.sides.includes(s));
    const named = { k0: sharedSide(ei, ej), j0: sharedSide(ei, ek), i0: sharedSide(ej, ek) };
    if (named.k0 == null || named.j0 == null || named.i0 == null) return { id, mappable: false, reasons: [{ code: 'block-topology', vertices: [c000], message: `Solid ${id} has inconsistent sides at corner ${c000}.` }] };
    const opposite = s => sideIds.find(t => t !== s && !adjacency.get(s).has(t));
    named.k1 = opposite(named.k0); named.j1 = opposite(named.j0); named.i1 = opposite(named.i0);
    const sideCorners = new Map(sideIds.map(s => [s, new Set(blockCorners.filter(v => vertexSides.get(v).has(s)))]));
    const cornerAt = (si, sj, sk) => {
      const found = blockCorners.filter(v => sideCorners.get(si).has(v) && sideCorners.get(sj).has(v) && sideCorners.get(sk).has(v));
      return found.length === 1 ? found[0] : null;
    };
    const corners = {};
    for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) corners[`${i}${j}${k}`] = cornerAt(named['i' + i], named['j' + j], named['k' + k]);
    if (Object.values(corners).some(v => v == null) || new Set(Object.values(corners)).size !== 8 || corners['100'] !== other(ei) || corners['010'] !== other(ej) || corners['001'] !== other(ek)) {
      return { id, mappable: false, reasons: [{ code: 'block-topology', vertices: blockCorners, message: `Solid ${id} corners do not form a consistent block.` }] };
    }
    const block = { corners, sides: {}, logicalEdges: [...logical.values()].map(item => ({ edges: item.chain.map(c => c.edge), corners: item.corners })) };
    for (const name of SIDE_NAMES) block.sides[name] = { faces: sideFaces.get(named[name]) };
    // Shape check: parallel block edges of very different length give tapered,
    // badly shaped hexes even though the block maps.
    const keyOf = new Map(Object.entries(corners).map(([key, vertex]) => [vertex, key]));
    const lengths = [[], [], []];
    for (const item of block.logicalEdges) {
      const [a, b] = item.corners.map(v => keyOf.get(v));
      const axis = [0, 1, 2].find(i => a[i] !== b[i]);
      item.length = item.edges.reduce((sum, e) => sum + (Number(edges.get(e)?.length) || 0), 0);
      item.axis = axis;
      lengths[axis].push(item);
    }
    const warnings = [];
    lengths.forEach((list, axis) => {
      const longest = Math.max(...list.map(x => x.length)), shortest = Math.min(...list.map(x => x.length));
      const taper = longest > 0 ? shortest / longest : 1;
      if (taper < TAPER_MIN) {
        const short = list.find(x => x.length === shortest), long = list.find(x => x.length === longest);
        warnings.push({ code: 'taper', taper, edges: [...short.edges, ...long.edges], vertices: short.corners.slice(),
          short: { edges: short.edges.slice(), corners: short.corners.slice() }, long: { edges: long.edges.slice(), corners: long.corners.slice() },
          message: `Solid ${id} is strongly tapered: parallel block edges are ${short.length.toPrecision(3)} and ${long.length.toPrecision(3)} long. Slice it so each block is closer to a box.` });
      }
    });
    block.taper = Math.min(...lengths.map(list => { const l = list.map(x => x.length); return Math.max(...l) > 0 ? Math.min(...l) / Math.max(...l) : 1; }));
    return { id, mappable: true, block, reasons: [], warnings };
  }

  function analyze(topology, options = {}) {
    const index = indexTopology(topology);
    const overrides = options.cornerOverrides && typeof options.cornerOverrides.get === 'function' ? options.cornerOverrides : null;
    const faces = new Map();
    for (const face of index.faces.values()) faces.set(Number(face.id), classifyFace(face, index.edges, overrides, index.vertices));
    // A ring cut once stays one solid; the kernel keeps the cut as a free face
    // (openIn) until a second cut separates the pieces.
    const openCuts = new Map();
    for (const face of index.faces.values()) {
      if (face.openIn == null || (face.volumes || []).length) continue;
      const owner = Number(face.openIn);
      if (!openCuts.has(owner)) openCuts.set(owner, []);
      openCuts.get(owner).push(Number(face.id));
    }
    const volumes = new Map();
    for (const volume of index.volumes.values()) {
      const id = Number(volume.id);
      let result = !Array.isArray(volume.edgeAngles)
        ? { id, mappable: false, reasons: [{ code: 'topology', message: 'This geometry revision has no mapping data. Reimport it with the current server.' }] }
        : classifyVolume(volume, index, faces);
      const cuts = openCuts.get(id);
      if (cuts) {
        result = { ...result, mappable: false, reasons: [{ code: 'open-ring', faces: cuts, message: `Solid ${id} is a ring opened by one cut (face ${cuts.join(', ')}). Cut it once more to separate it into pieces.` }, ...(result.mappable ? [] : result.reasons || [])] };
        delete result.block;
      }
      volumes.set(id, result);
    }
    const mappable = [...volumes.values()].filter(v => v.mappable).length;
    return { index, faces, volumes, summary: { volumes: volumes.size, mappable, blocked: volumes.size - mappable } };
  }

  /* ------------------------------------------------------------------ */
  /* Interval assignment                                                 */
  /* ------------------------------------------------------------------ */

  function regionOf(analysis, volumeIds) {
    const chosen = (volumeIds && volumeIds.length ? volumeIds.map(Number) : [...analysis.volumes.keys()])
      .filter(id => analysis.volumes.get(id)?.mappable);
    const faces = new Set(), edges = new Set();
    for (const id of chosen) for (const side of Object.values(analysis.volumes.get(id).block.sides)) for (const f of side.faces) faces.add(f);
    for (const f of faces) for (const chain of analysis.faces.get(f).chains) for (const item of chain) edges.add(item.edge);
    return { volumes: chosen, faces: [...faces].sort((a, b) => a - b), edges: [...edges].sort((a, b) => a - b) };
  }

  function equationsOf(analysis, region) {
    const equations = [];
    for (const f of region.faces) {
      const chains = analysis.faces.get(f).chains.map(chain => chain.map(item => item.edge));
      equations.push({ face: f, lhs: chains[0], rhs: chains[2], pair: 0 });
      equations.push({ face: f, lhs: chains[1], rhs: chains[3], pair: 1 });
    }
    return equations;
  }

  function letters(index) {
    let text = '', n = index;
    do { text = String.fromCharCode(65 + (n % 26)) + text; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return text;
  }

  /**
   * Solve the interval equations for integer element counts per CAD edge.
   * settings.size: global target element length; settings.minCount: minimum
   * per edge; settings.controls: Map(edgeId -> {count, size}). A count is a
   * hard requirement; a size only changes that edge's target.
   */
  function solveIntervals(analysis, settings = {}) {
    const region = regionOf(analysis, settings.volumes);
    const { edges } = analysis.index;
    const size = Number(settings.size) > 0 ? Number(settings.size) : 1;
    const minCount = Math.max(1, Math.round(Number(settings.minCount) || 1));
    const controls = settings.controls && typeof settings.controls.get === 'function' ? settings.controls : new Map();
    const equations = equationsOf(analysis, region);
    const target = new Map(), locked = new Map();
    for (const e of region.edges) {
      const control = controls.get(e) || {};
      const length = Number(edges.get(e)?.length) || 0;
      const edgeSize = Number(control.size) > 0 ? Number(control.size) : size;
      target.set(e, Math.max(minCount, length / edgeSize));
      if (Number.isInteger(control.count) && control.count > 0) locked.set(e, control.count);
    }
    // Single-edge chains give plain equalities: merge them into groups.
    const uf = new UnionFind(), links = new Map();
    region.edges.forEach(e => uf.find(e));
    const link = (a, b, face) => {
      for (const [x, y] of [[a, b], [b, a]]) { if (!links.has(x)) links.set(x, []); links.get(x).push({ to: y, face }); }
    };
    const sums = [];
    for (const eq of equations) {
      if (eq.lhs.length === 1 && eq.rhs.length === 1) { uf.union(eq.lhs[0], eq.rhs[0]); link(eq.lhs[0], eq.rhs[0], eq.face); }
      else sums.push(eq);
    }
    const groupMembers = new Map();
    for (const e of region.edges) { const r = uf.find(e); if (!groupMembers.has(r)) groupMembers.set(r, []); groupMembers.get(r).push(e); }
    const groups = [...groupMembers.values()].map(members => members.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0])
      .map((members, i) => ({ index: i, label: letters(i), edges: members }));
    const groupOf = new Map();
    groups.forEach(g => g.edges.forEach(e => groupOf.set(e, g.index)));
    const conflicts = [];
    const pathBetween = (from, to) => {
      const previous = new Map([[from, null]]), queue = [from];
      while (queue.length) {
        const current = queue.shift();
        if (current === to) break;
        for (const step of links.get(current) || []) if (!previous.has(step.to)) { previous.set(step.to, { from: current, face: step.face }); queue.push(step.to); }
      }
      const path = [];
      for (let at = to; at != null && previous.get(at); at = previous.get(at).from) path.unshift({ edge: at, face: previous.get(at).face });
      return [{ edge: from, face: null }, ...path];
    };
    for (const group of groups) {
      const fixed = group.edges.filter(e => locked.has(e));
      group.target = group.edges.reduce((s, e) => s + target.get(e), 0) / group.edges.length;
      group.lockedEdges = fixed;
      const values = [...new Set(fixed.map(e => locked.get(e)))];
      if (values.length > 1) {
        const a = fixed.find(e => locked.get(e) === values[0]), b = fixed.find(e => locked.get(e) === values[1]);
        const path = pathBetween(a, b);
        group.conflict = true;
        conflicts.push({ kind: 'locks', group: group.index, edges: path.map(p => p.edge), faces: [...new Set(path.map(p => p.face).filter(f => f != null))],
          message: `Edges ${a} (fixed ${locked.get(a)}) and ${b} (fixed ${locked.get(b)}) must match: ` + path.map((p, i) => i ? `E${p.edge} via face ${p.face}` : `E${p.edge}`).join(' = ') + '.' });
      }
      group.fixed = values.length ? values[0] : null;
    }
    // Sum equations as linear rows over group variables.
    const rows = [];
    for (const eq of sums) {
      const coef = new Map();
      for (const e of eq.lhs) coef.set(groupOf.get(e), (coef.get(groupOf.get(e)) || 0) + 1);
      for (const e of eq.rhs) coef.set(groupOf.get(e), (coef.get(groupOf.get(e)) || 0) - 1);
      for (const [g, c] of [...coef]) if (c === 0) coef.delete(g);
      if (coef.size) rows.push({ coef, equation: eq });
    }
    const values = solveGroupSystem(groups, rows, minCount, conflicts);
    const counts = new Map();
    for (const group of groups) {
      group.count = values[group.index];
      for (const e of group.edges) counts.set(e, values[group.index]);
    }
    const sumReport = sums.map(eq => {
      const lhs = eq.lhs.reduce((s, e) => s + counts.get(e), 0), rhs = eq.rhs.reduce((s, e) => s + counts.get(e), 0);
      return { ...eq, lhsValue: lhs, rhsValue: rhs, ok: lhs === rhs };
    });
    for (const s of sumReport) if (!s.ok && !conflicts.some(c => c.equations && c.equations.includes(s))) {
      conflicts.push({ kind: 'sum', edges: [...s.lhs, ...s.rhs], faces: [s.face], equations: [s],
        message: `Face ${s.face}: ${s.lhs.map(e => 'E' + e).join(' + ')} = ${s.rhs.map(e => 'E' + e).join(' + ')} cannot be satisfied (${s.lhsValue} ≠ ${s.rhsValue}).` });
    }
    const stretched = [];
    for (const e of region.edges) {
      const n = counts.get(e), t = target.get(e);
      if (!locked.has(e) && n > 0 && (n / t > 2.5 || t / n > 2.5) && Math.abs(n - t) >= 2) stretched.push({ edge: e, count: n, target: t });
    }
    let estimate = 0;
    for (const id of region.volumes) {
      const block = analysis.volumes.get(id).block;
      const chainCount = name => {
        const [a, b] = { i: ['000', '100'], j: ['000', '010'], k: ['000', '001'] }[name];
        const edge = block.logicalEdges.find(item => item.corners.includes(block.corners[a]) && item.corners.includes(block.corners[b]));
        return edge ? edge.edges.reduce((s, e) => s + (counts.get(e) || 0), 0) : 0;
      };
      estimate += chainCount('i') * chainCount('j') * chainCount('k');
    }
    return { region, equations, sums: sumReport, groups, counts, target, locked, conflicts, stretched, estimate, solvable: conflicts.length === 0 };
  }

  function solveGroupSystem(groups, rows, minCount, conflicts) {
    const n = groups.length;
    const fixed = groups.map(g => g.fixed);
    const targets = groups.map(g => g.target);
    if (!rows.length) return groups.map((g, i) => fixed[i] != null ? fixed[i] : Math.max(minCount, Math.round(targets[i])));
    // Gaussian elimination over free variables; fixed groups move to the right side.
    const free = [...Array(n).keys()].filter(i => fixed[i] == null);
    const col = new Map(free.map((g, k) => [g, k]));
    const matrix = rows.map(row => {
      const values = new Float64Array(free.length);
      let rhs = 0;
      for (const [g, c] of row.coef) { if (fixed[g] != null) rhs -= c * fixed[g]; else values[col.get(g)] += c; }
      return { values, rhs, origin: new Set([row]) };
    });
    const pivots = [];
    let r = 0;
    for (let c = 0; c < free.length && r < matrix.length; c++) {
      let best = -1;
      for (let i = r; i < matrix.length; i++) if (Math.abs(matrix[i].values[c]) > 1e-9 && (best < 0 || Math.abs(matrix[i].values[c]) > Math.abs(matrix[best].values[c]))) best = i;
      if (best < 0) continue;
      [matrix[r], matrix[best]] = [matrix[best], matrix[r]];
      const p = matrix[r], pv = p.values[c];
      for (let k = 0; k < free.length; k++) p.values[k] /= pv;
      p.rhs /= pv;
      for (let i = 0; i < matrix.length; i++) {
        if (i === r || Math.abs(matrix[i].values[c]) < 1e-12) continue;
        const factor = matrix[i].values[c];
        for (let k = 0; k < free.length; k++) matrix[i].values[k] -= factor * p.values[k];
        matrix[i].rhs -= factor * p.rhs;
        for (const o of p.origin) matrix[i].origin.add(o);
      }
      pivots.push({ row: r, col: c }); r++;
    }
    for (let i = r; i < matrix.length; i++) {
      if (Math.abs(matrix[i].rhs) > 1e-7) {
        const eqs = [...matrix[i].origin].map(row => row.equation);
        conflicts.push({ kind: 'sum', faces: [...new Set(eqs.map(e => e.face))], edges: [...new Set(eqs.flatMap(e => [...e.lhs, ...e.rhs]))], equations: eqs,
          message: `Fixed counts make these face equations inconsistent: ` + eqs.map(e => `face ${e.face}: ${e.lhs.map(x => 'E' + x).join(' + ')} = ${e.rhs.map(x => 'E' + x).join(' + ')}`).join('; ') + '.' });
      }
    }
    const pivotCols = new Set(pivots.map(p => p.col));
    const freeCols = [...Array(free.length).keys()].filter(c => !pivotCols.has(c));
    const values = groups.map((g, i) => fixed[i] != null ? fixed[i] : targets[i]);
    // Each pivot row's nonzero free-column terms, in column order: the rows are
    // sparse, and skipping exact zeros leaves every sum unchanged.
    const terms = pivots.map(p => {
      const row = matrix[p.row].values, cols = freeCols.filter(c => row[c] !== 0);
      return { col: p.col, rhs: matrix[p.row].rhs, cols, coefs: Float64Array.from(cols, c => row[c]) };
    });
    const evaluate = assignment => {
      // assignment: values for freeCols; dependent pivots follow from the rows.
      const x = new Float64Array(free.length);
      freeCols.forEach((c, k) => { x[c] = assignment[k]; });
      for (const t of terms) {
        let v = t.rhs;
        for (let k = 0; k < t.cols.length; k++) v -= t.coefs[k] * x[t.cols[k]];
        x[t.col] = v;
      }
      let penalty = 0, cost = 0;
      for (let c = 0; c < free.length; c++) {
        const g = free[c], v = x[c], rounded = Math.round(v);
        penalty += Math.abs(v - rounded) * 1000 + Math.max(0, minCount - v) * 1000;
        const t = targets[g];
        cost += (v - t) * (v - t) / Math.max(t, 1);
      }
      return { x, penalty, cost };
    };
    // Continuous optimum of the free variables by coordinate descent, then integer search.
    let assignment = freeCols.map(c => Math.max(minCount, Math.round(targets[free[c]])));
    let current = evaluate(assignment);
    const better = (a, b) => a.penalty < b.penalty - 1e-9 || (Math.abs(a.penalty - b.penalty) <= 1e-9 && a.cost < b.cost - 1e-12);
    for (let iteration = 0; iteration < 400; iteration++) {
      let improved = false;
      for (let k = 0; k < assignment.length; k++) {
        for (const step of [1, -1, 2, -2, 3, -3]) {
          const candidate = assignment.slice(); candidate[k] += step;
          if (candidate[k] < minCount) continue;
          const result = evaluate(candidate);
          if (better(result, current)) { assignment = candidate; current = result; improved = true; }
        }
      }
      if (!improved) {
        // Pairwise moves resolve parity and sum couplings single steps cannot.
        for (let a = 0; a < assignment.length && !improved; a++) for (let b = a + 1; b < assignment.length && !improved; b++) {
          for (const [da, db] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const candidate = assignment.slice(); candidate[a] += da; candidate[b] += db;
            if (candidate[a] < minCount || candidate[b] < minCount) continue;
            const result = evaluate(candidate);
            if (better(result, current)) { assignment = candidate; current = result; improved = true; break; }
          }
        }
        if (!improved) break;
      }
    }
    for (let c = 0; c < free.length; c++) values[free[c]] = Math.round(current.x[c]);
    if (current.penalty > 1e-6) {
      const bad = [];
      for (let c = 0; c < free.length; c++) {
        const v = current.x[c];
        if (Math.abs(v - Math.round(v)) > 1e-6 || v < minCount - 1e-9) bad.push(free[c]);
      }
      const involved = rows.filter(row => [...row.coef.keys()].some(g => bad.includes(g))).map(row => row.equation);
      conflicts.push({ kind: 'integer', faces: [...new Set(involved.map(e => e.face))], edges: [...new Set(involved.flatMap(e => [...e.lhs, ...e.rhs]))], equations: involved,
        message: `No positive integer counts satisfy the face equations with the fixed counts (groups ${bad.map(g => groups[g].label).join(', ')}). Free or change a fixed count.` });
      for (const g of bad) values[g] = Math.max(minCount, Math.round(current.x[free.indexOf(g)]));
    }
    return values.map(v => Math.max(1, Math.round(v)));
  }

  /* ------------------------------------------------------------------ */
  /* Geometry evaluation                                                 */
  /* ------------------------------------------------------------------ */

  function createGeometry(topology, preview) {
    const index = indexTopology(topology);
    const polylines = new Map();
    for (const edge of (preview && preview.edges) || []) polylines.set(Number(edge.id), Array.from(edge.points || [], Number));
    const curves = new Map(), surfaces = new Map();
    let triangles = null;
    function faceTriangles(faceId) {
      if (!triangles) {
        triangles = new Map();
        const positions = (preview && preview.positions) || [], owners = (preview && preview.triangleFaceIds) || [];
        for (let t = 0; t < owners.length; t++) {
          const id = Number(owners[t]);
          if (!triangles.has(id)) triangles.set(id, []);
          const list = triangles.get(id);
          for (let k = 0; k < 9; k++) list.push(Number(positions[t * 9 + k]));
        }
      }
      return triangles.get(faceId) || [];
    }
    function curve(edgeId) {
      if (curves.has(edgeId)) return curves.get(edgeId);
      const edge = index.edges.get(edgeId);
      if (!edge) throw Error(`Edge ${edgeId} is missing.`);
      const [a, b] = (edge.vertices || []).map(v => index.vertices.get(Number(v)));
      let points;
      if (edge.curve && edge.curve.kind === 'line' && a && b) points = [a, b];
      else {
        const flat = polylines.get(edgeId) || [];
        points = [];
        for (let i = 0; i + 2 < flat.length; i += 3) points.push([flat[i], flat[i + 1], flat[i + 2]]);
        if (a && points.length) points[0] = a.slice();
        if (b && points.length) points[points.length - 1] = b.slice();
      }
      if (points.length < 2) throw Error(`Edge ${edgeId} has no displayable curve.`);
      const lengths = [0];
      for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + norm(sub(points[i], points[i - 1])));
      const total = lengths[lengths.length - 1] || 1;
      const circle = edge.curve && edge.curve.kind === 'circle' ? edge.curve : null;
      const pointAt = s => {
        if (s <= 0) return points[0].slice();
        if (s >= 1) return points[points.length - 1].slice();
        const target = s * total;
        let lo = 0, hi = lengths.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (lengths[mid] <= target) lo = mid; else hi = mid; }
        const span = lengths[hi] - lengths[lo] || 1;
        let p = lerp(points[lo], points[hi], (target - lengths[lo]) / span);
        if (circle) {
          const c = circle.center, axis = circle.axis, offset = sub(p, c);
          const radial = sub(offset, scale(axis, dot(offset, axis)));
          if (norm(radial) > 0) p = add(add(c, scale(axis, dot(offset, axis))), scale(unit(radial), circle.radius));
        }
        return p;
      };
      const result = { length: total, pointAt, points };
      curves.set(edgeId, result);
      return result;
    }
    function surface(faceId) {
      if (surfaces.has(faceId)) return surfaces.get(faceId);
      const face = index.faces.get(faceId), descriptor = (face && face.surface) || { kind: 'mesh' };
      let project;
      if (descriptor.kind === 'plane') {
        const o = descriptor.origin, n = unit(descriptor.normal);
        project = p => sub(p, scale(n, dot(sub(p, o), n)));
      } else if (descriptor.kind === 'cylinder') {
        const o = descriptor.origin, axis = unit(descriptor.axis), r = descriptor.radius;
        project = p => {
          const offset = sub(p, o), along = dot(offset, axis), radial = sub(offset, scale(axis, along)), length = norm(radial);
          return length > 0 ? add(add(o, scale(axis, along)), scale(radial, r / length)) : p;
        };
      } else if (descriptor.kind === 'sphere') {
        const c = descriptor.center, r = descriptor.radius;
        project = p => { const d = sub(p, c), l = norm(d); return l > 0 ? add(c, scale(d, r / l)) : p; };
      } else if (descriptor.kind === 'cone') {
        // Onto the generator through the point's side of the axis.
        const o = descriptor.apex, axis = unit(descriptor.axis), sin = Math.sin(descriptor.angle), cos = Math.cos(descriptor.angle);
        project = p => {
          const offset = sub(p, o), along = dot(offset, axis), radial = sub(offset, scale(axis, along)), length = norm(radial);
          if (!(length > 0)) return p;
          const generator = add(scale(axis, cos), scale(radial, sin / length));
          return add(o, scale(generator, Math.max(0, dot(offset, generator))));
        };
      } else if (descriptor.kind === 'torus') {
        // Onto the tube's circle in the point's half-plane through the axis.
        const c = descriptor.center, axis = unit(descriptor.axis), R = descriptor.major, r = descriptor.minor;
        project = p => {
          const offset = sub(p, c), radial = sub(offset, scale(axis, dot(offset, axis))), length = norm(radial);
          if (!(length > 0)) return p;
          const core = add(c, scale(radial, R / length)), d = sub(p, core), l = norm(d);
          return l > 0 ? add(core, scale(d, r / l)) : p;
        };
      } else {
        const tri = faceTriangles(faceId);
        project = p => tri.length ? closestOnTriangles(tri, p) : p;
      }
      const result = { kind: descriptor.kind, project };
      surfaces.set(faceId, result);
      return result;
    }
    return { index, curve, surface };
  }

  function closestOnTriangle(p, a, b, c) {
    // Ericson, Real-Time Collision Detection, 5.1.5.
    const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a;
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
    const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
    const denom = 1 / (va + vb + vc);
    return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)));
  }

  function closestOnTriangles(flat, p) {
    let best = p, distance = Infinity;
    for (let i = 0; i < flat.length; i += 9) {
      const q = closestOnTriangle(p, [flat[i], flat[i + 1], flat[i + 2]], [flat[i + 3], flat[i + 4], flat[i + 5]], [flat[i + 6], flat[i + 7], flat[i + 8]]);
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
      if (d < distance) { distance = d; best = q; }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Mesh generation                                                     */
  /* ------------------------------------------------------------------ */

  class NodeTable {
    constructor() { this.keys = new Map(); this.points = []; }
    id(key, point) {
      let id = this.keys.get(key);
      if (id === undefined) {
        id = this.points.length; this.keys.set(key, id); this.points.push(point || null);
        if (this.points.length > MAX_NODES * 8) throw Error('The mapped mesh exceeds the node limit. Increase the element size.');
      } else if (point && !this.points[id]) this.points[id] = point;
      return id;
    }
    point(id) { return this.points[id]; }
  }

  function arcParameters(points) {
    const s = [0];
    for (let i = 1; i < points.length; i++) s.push(s[i - 1] + norm(sub(points[i], points[i - 1])));
    const total = s[s.length - 1] || 1;
    return s.map(v => v / total);
  }

  function edgeParameters(count, order) {
    const base = [];
    for (let k = 0; k <= count; k++) base.push(k / count);
    if (order !== 2) return base;
    const fine = [];
    for (let k = 0; k < count; k++) fine.push(base[k], (base[k] + base[k + 1]) / 2);
    fine.push(1);
    return fine;
  }

  function tfi2(B, T, L, R) {
    const I = B.length - 1, J = L.length - 1;
    const sB = arcParameters(B), sT = arcParameters(T), tL = arcParameters(L), tR = arcParameters(R);
    const grid = [];
    for (let i = 0; i <= I; i++) {
      grid.push([]);
      for (let j = 0; j <= J; j++) {
        if (j === 0) { grid[i].push(B[i]); continue; }
        if (j === J) { grid[i].push(T[i]); continue; }
        if (i === 0) { grid[i].push(L[j]); continue; }
        if (i === I) { grid[i].push(R[j]); continue; }
        const du = sT[i] - sB[i], dv = tR[j] - tL[j], denom = 1 - du * dv;
        const u = (sB[i] + tL[j] * du) / denom, v = (tL[j] + sB[i] * dv) / denom;
        const p = [0, 0, 0];
        for (let a = 0; a < 3; a++) {
          p[a] = (1 - v) * B[i][a] + v * T[i][a] + (1 - u) * L[j][a] + u * R[j][a]
            - ((1 - u) * (1 - v) * B[0][a] + u * (1 - v) * B[I][a] + (1 - u) * v * T[0][a] + u * v * T[I][a]);
        }
        grid[i].push(p);
      }
    }
    return grid;
  }

  function hexQuality(points) {
    let minSJ = Infinity;
    for (let c = 0; c < 8; c++) {
      const [a, b, d] = HEX_CORNER_NEIGHBORS[c];
      const e1 = unit(sub(points[a], points[c])), e2 = unit(sub(points[b], points[c])), e3 = unit(sub(points[d], points[c]));
      minSJ = Math.min(minSJ, dot(e1, cross(e2, e3)));
    }
    let shortest = Infinity, longest = 0;
    for (const [a, b] of HEX20_EDGES) { const l = norm(sub(points[b], points[a])); shortest = Math.min(shortest, l); longest = Math.max(longest, l); }
    return { scaledJacobian: minSJ, aspect: shortest > 0 ? longest / shortest : Infinity };
  }

  function generateMesh(analysis, intervals, geometry, options = {}) {
    const order = Number(options.order) === 2 ? 2 : 1;
    const volumeIds = (options.volumes && options.volumes.length ? options.volumes.map(Number) : intervals.region.volumes)
      .filter(id => intervals.region.volumes.includes(id));
    if (!volumeIds.length) throw Error('No mappable solids are selected for meshing.');
    if (!intervals.solvable) throw Error('Resolve the edge-count conflicts before generating the mapped mesh.');
    const { counts } = intervals;
    const { edges } = analysis.index;
    const table = new NodeTable();
    const edgeNodes = new Map(), faceGrids = new Map();
    const vertexNode = v => table.id('v' + v, analysis.index.vertices.get(Number(v)).slice());
    function nodesOnEdge(edgeId) {
      if (edgeNodes.has(edgeId)) return edgeNodes.get(edgeId);
      const n = counts.get(edgeId);
      if (!(n >= 1)) throw Error(`Edge ${edgeId} has no solved element count.`);
      const curve = geometry.curve(edgeId), params = edgeParameters(n, order), [a, b] = edges.get(edgeId).vertices;
      const list = params.map((s, k) => k === 0 ? vertexNode(a) : k === params.length - 1 ? vertexNode(b) : table.id(`e${edgeId}:${k}`, curve.pointAt(s)));
      edgeNodes.set(edgeId, list);
      return list;
    }
    function chainNodes(chain) {
      const list = [];
      for (const item of chain) {
        let nodes = nodesOnEdge(item.edge);
        if (item.sense < 0) nodes = nodes.slice().reverse();
        if (list.length) nodes = nodes.slice(1);
        list.push(...nodes);
      }
      return list;
    }
    function faceGrid(faceId) {
      if (faceGrids.has(faceId)) return faceGrids.get(faceId);
      const info = analysis.faces.get(faceId);
      const [c0, c1, c2, c3] = info.chains.map(chainNodes);
      if (c0.length !== c2.length || c1.length !== c3.length) throw Error(`Face ${faceId} has unequal opposite edge counts (${c0.length - 1}/${c2.length - 1}, ${c1.length - 1}/${c3.length - 1}).`);
      const B = c0, R = c1, T = c2.slice().reverse(), L = c3.slice().reverse();
      const I = B.length - 1, J = L.length - 1, P = id => table.point(id);
      const positions = tfi2(B.map(P), T.map(P), L.map(P), R.map(P));
      const projector = geometry.surface(faceId);
      const ids = [];
      for (let i = 0; i <= I; i++) {
        ids.push([]);
        for (let j = 0; j <= J; j++) {
          let id;
          if (j === 0) id = B[i]; else if (j === J) id = T[i]; else if (i === 0) id = L[j]; else if (i === I) id = R[j];
          else id = table.id(`f${faceId}:${i}:${j}`, projector.project(positions[i][j]));
          ids[i].push(id);
        }
      }
      const grid = { faceId, I, J, ids };
      faceGrids.set(faceId, grid);
      return grid;
    }
    function assembleSide(faceIds, origin, alongA, alongB, label) {
      const cells = [];
      for (const f of faceIds) {
        const g = faceGrid(f);
        for (let i = 0; i < g.I; i++) for (let j = 0; j < g.J; j++) cells.push([g.ids[i][j], g.ids[i + 1][j], g.ids[i + 1][j + 1], g.ids[i][j + 1]]);
      }
      const edgeCells = new Map(), key = (a, b) => a < b ? a + ':' + b : b + ':' + a;
      cells.forEach((cell, c) => { for (let k = 0; k < 4; k++) { const k2 = key(cell[k], cell[(k + 1) % 4]); if (!edgeCells.has(k2)) edgeCells.set(k2, []); edgeCells.get(k2).push(c); } });
      const coords = new Map(), placed = new Uint8Array(cells.length);
      const fail = message => { throw Error(`Side ${label} (faces ${faceIds.join(', ')}): ${message}`); };
      const seed = cells.findIndex(cell => cell.includes(origin));
      if (seed < 0) fail('the block corner is not on this side.');
      {
        const cell = cells[seed], p = cell.indexOf(origin);
        coords.set(origin, [0, 0]); coords.set(cell[(p + 1) % 4], [1, 0]); coords.set(cell[(p + 3) % 4], [0, 1]); coords.set(cell[(p + 2) % 4], [1, 1]);
      }
      placed[seed] = 1;
      const queue = [seed];
      const assign = (node, value) => {
        const existing = coords.get(node);
        if (existing && (existing[0] !== value[0] || existing[1] !== value[1])) fail('its faces do not form one structured grid. Check that each face is four-sided and aligned with the block.');
        coords.set(node, value);
      };
      while (queue.length) {
        const c = queue.pop(), cell = cells[c];
        for (let k = 0; k < 4; k++) {
          const p = cell[k], q = cell[(k + 1) % 4];
          for (const other of edgeCells.get(key(p, q))) {
            if (other === c) continue;
            if (placed[other]) continue;
            const neighbor = cells[other], np = neighbor.indexOf(p), nq = neighbor.indexOf(q);
            const step = (nq - np + 4) % 4 === 1 ? -1 : 1;
            const r = neighbor[(np + step + 4) % 4], s = neighbor[(nq - step + 4) % 4];
            const pPrev = cell[(k + 3) % 4], qNext = cell[(k + 2) % 4];
            const cp = coords.get(p), cq = coords.get(q), cpp = coords.get(pPrev), cqq = coords.get(qNext);
            assign(r, [2 * cp[0] - cpp[0], 2 * cp[1] - cpp[1]]);
            assign(s, [2 * cq[0] - cqq[0], 2 * cq[1] - cqq[1]]);
            placed[other] = 1; queue.push(other);
          }
        }
      }
      if (placed.some(v => !v)) fail('its faces are not connected.');
      const o = coords.get(origin), a = coords.get(alongA), b = coords.get(alongB);
      if (!a || !b) fail('a block corner is missing from the side grid.');
      const da = [a[0] - o[0], a[1] - o[1]], db = [b[0] - o[0], b[1] - o[1]];
      const A = Math.abs(da[0]) + Math.abs(da[1]), Bn = Math.abs(db[0]) + Math.abs(db[1]);
      if ((da[0] && da[1]) || (db[0] && db[1]) || !A || !Bn || (da[0] !== 0) === (db[0] !== 0)) fail('its corners are not at the grid corners.');
      const ua = [da[0] / A, da[1] / A], ub = [db[0] / Bn, db[1] / Bn];
      const grid = Array.from({ length: A + 1 }, () => new Array(Bn + 1).fill(-1));
      for (const [node, c] of coords) {
        const rel = [c[0] - o[0], c[1] - o[1]];
        const ia = rel[0] * ua[0] + rel[1] * ua[1], ib = rel[0] * ub[0] + rel[1] * ub[1];
        if (ia < 0 || ib < 0 || ia > A || ib > Bn || grid[ia][ib] !== -1) fail('its faces do not form one rectangular grid.');
        grid[ia][ib] = node;
      }
      if (grid.some(row => row.includes(-1))) fail('its grid has gaps.');
      return grid;
    }
    const elements = [], quality = { minScaledJacobian: Infinity, maxAspect: 0, histogram: new Array(10).fill(0), inverted: 0, perVolume: [] };
    const elementQuality = [];
    for (const volumeId of volumeIds) {
      const block = analysis.volumes.get(volumeId).block, c = block.corners, V = key => vertexNode(c[key]);
      const sides = block.sides;
      const k0 = assembleSide(sides.k0.faces, V('000'), V('100'), V('010'), 'k0');
      const k1 = assembleSide(sides.k1.faces, V('001'), V('101'), V('011'), 'k1');
      const j0 = assembleSide(sides.j0.faces, V('000'), V('100'), V('001'), 'j0');
      const j1 = assembleSide(sides.j1.faces, V('010'), V('110'), V('011'), 'j1');
      const i0 = assembleSide(sides.i0.faces, V('000'), V('010'), V('001'), 'i0');
      const i1 = assembleSide(sides.i1.faces, V('100'), V('110'), V('101'), 'i1');
      const I = k0.length - 1, J = k0[0].length - 1, K = j0[0].length - 1;
      const dims = [[k1, I, J], [j0, I, K], [j1, I, K], [i0, J, K], [i1, J, K]];
      if (dims.some(([g, a, b]) => g.length - 1 !== a || g[0].length - 1 !== b)) throw Error(`Solid ${volumeId}: opposite sides have different grid sizes. Check the edge-count equations.`);
      if ((I / order) * (J / order) * (K / order) + elements.length > MAX_ELEMENTS) throw Error(`The mapped mesh exceeds ${MAX_ELEMENTS.toLocaleString()} elements. Increase the element size.`);
      const X = Array.from({ length: I + 1 }, () => Array.from({ length: J + 1 }, () => new Int32Array(K + 1).fill(-1)));
      const put = (i, j, k, node) => {
        if (X[i][j][k] !== -1 && X[i][j][k] !== node) throw Error(`Solid ${volumeId}: side grids disagree along a block edge.`);
        X[i][j][k] = node;
      };
      for (let i = 0; i <= I; i++) for (let j = 0; j <= J; j++) { put(i, j, 0, k0[i][j]); put(i, j, K, k1[i][j]); }
      for (let i = 0; i <= I; i++) for (let k = 0; k <= K; k++) { put(i, 0, k, j0[i][k]); put(i, J, k, j1[i][k]); }
      for (let j = 0; j <= J; j++) for (let k = 0; k <= K; k++) { put(0, j, k, i0[j][k]); put(I, j, k, i1[j][k]); }
      const P = (i, j, k) => table.point(X[i][j][k]);
      const lineParams = pts => arcParameters(pts);
      const su = [[0, 0], [J, 0], [0, K], [J, K]].map(([j, k]) => lineParams(Array.from({ length: I + 1 }, (_, i) => P(i, j, k))));
      const sv = [[0, 0], [I, 0], [0, K], [I, K]].map(([i, k]) => lineParams(Array.from({ length: J + 1 }, (_, j) => P(i, j, k))));
      const sw = [[0, 0], [I, 0], [0, J], [I, J]].map(([i, j]) => lineParams(Array.from({ length: K + 1 }, (_, k) => P(i, j, k))));
      for (let i = 1; i < I; i++) for (let j = 1; j < J; j++) for (let k = 1; k < K; k++) {
        let u = (su[0][i] + su[1][i] + su[2][i] + su[3][i]) / 4, v = (sv[0][j] + sv[1][j] + sv[2][j] + sv[3][j]) / 4, w = (sw[0][k] + sw[1][k] + sw[2][k] + sw[3][k]) / 4;
        for (let pass = 0; pass < 3; pass++) {
          const nu = (1 - v) * (1 - w) * su[0][i] + v * (1 - w) * su[1][i] + (1 - v) * w * su[2][i] + v * w * su[3][i];
          const nv = (1 - u) * (1 - w) * sv[0][j] + u * (1 - w) * sv[1][j] + (1 - u) * w * sv[2][j] + u * w * sv[3][j];
          const nw = (1 - u) * (1 - v) * sw[0][k] + u * (1 - v) * sw[1][k] + (1 - u) * v * sw[2][k] + u * v * sw[3][k];
          u = nu; v = nv; w = nw;
        }
        const p = [0, 0, 0];
        const f = [P(0, j, k), P(I, j, k), P(i, 0, k), P(i, J, k), P(i, j, 0), P(i, j, K)];
        const e = [P(0, 0, k), P(0, J, k), P(I, 0, k), P(I, J, k), P(0, j, 0), P(0, j, K), P(I, j, 0), P(I, j, K), P(i, 0, 0), P(i, 0, K), P(i, J, 0), P(i, J, K)];
        const cc = [P(0, 0, 0), P(I, 0, 0), P(0, J, 0), P(I, J, 0), P(0, 0, K), P(I, 0, K), P(0, J, K), P(I, J, K)];
        for (let a = 0; a < 3; a++) {
          const faces = (1 - u) * f[0][a] + u * f[1][a] + (1 - v) * f[2][a] + v * f[3][a] + (1 - w) * f[4][a] + w * f[5][a];
          const edgesTerm = (1 - u) * (1 - v) * e[0][a] + (1 - u) * v * e[1][a] + u * (1 - v) * e[2][a] + u * v * e[3][a]
            + (1 - u) * (1 - w) * e[4][a] + (1 - u) * w * e[5][a] + u * (1 - w) * e[6][a] + u * w * e[7][a]
            + (1 - v) * (1 - w) * e[8][a] + (1 - v) * w * e[9][a] + v * (1 - w) * e[10][a] + v * w * e[11][a];
          const cornersTerm = (1 - u) * (1 - v) * (1 - w) * cc[0][a] + u * (1 - v) * (1 - w) * cc[1][a] + (1 - u) * v * (1 - w) * cc[2][a] + u * v * (1 - w) * cc[3][a]
            + (1 - u) * (1 - v) * w * cc[4][a] + u * (1 - v) * w * cc[5][a] + (1 - u) * v * w * cc[6][a] + u * v * w * cc[7][a];
          p[a] = faces - edgesTerm + cornersTerm;
        }
        X[i][j][k] = table.id(`b${volumeId}:${i}:${j}:${k}`, p);
      }
      // Orientation from the first cell; mirrored blocks swap J and I ordering.
      const s = order;
      const sample = [P(0, 0, 0), P(s, 0, 0), P(s, s, 0), P(0, s, 0), P(0, 0, s), P(s, 0, s), P(s, s, s), P(0, s, s)];
      const mirrored = hexQuality(sample).scaledJacobian < 0;
      const local = mirrored ? [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 1], [0, 1, 1], [1, 1, 1], [1, 0, 1]]
        : [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
      let volumeMin = Infinity, count = 0;
      for (let i = 0; i < I; i += s) for (let j = 0; j < J; j += s) for (let k = 0; k < K; k += s) {
        const corner = local.map(([a, b, d]) => [i + a * s, j + b * s, k + d * s]);
        const nodes = corner.map(([a, b, d]) => X[a][b][d]);
        if (order === 2) for (const [a, b] of HEX20_EDGES) {
          const m = [(corner[a][0] + corner[b][0]) / 2, (corner[a][1] + corner[b][1]) / 2, (corner[a][2] + corner[b][2]) / 2];
          nodes.push(X[m[0]][m[1]][m[2]]);
        }
        const q = hexQuality(nodes.slice(0, 8).map(id => table.point(id)));
        volumeMin = Math.min(volumeMin, q.scaledJacobian);
        quality.minScaledJacobian = Math.min(quality.minScaledJacobian, q.scaledJacobian);
        quality.maxAspect = Math.max(quality.maxAspect, q.aspect);
        if (q.scaledJacobian <= 0) quality.inverted++;
        quality.histogram[Math.max(0, Math.min(9, Math.floor(Math.max(0, q.scaledJacobian) * 10)))]++;
        elementQuality.push(q.scaledJacobian);
        elements.push({ volume: volumeId, nodes });
        count++;
      }
      quality.perVolume.push({ volume: volumeId, elements: count, dims: [I / s, J / s, K / s], minScaledJacobian: volumeMin });
    }
    // Number only referenced nodes, in creation order.
    const used = new Int32Array(table.points.length).fill(-1);
    const nodes = [];
    for (const element of elements) for (const id of element.nodes) if (used[id] < 0) { used[id] = nodes.length + 1; const p = table.point(id); nodes.push({ id: nodes.length + 1, x: p[0], y: p[1], z: p[2] }); }
    if (nodes.length > MAX_NODES) throw Error(`The mapped mesh exceeds ${MAX_NODES.toLocaleString()} nodes. Increase the element size.`);
    const result = {
      nodes,
      elements: elements.map((e, i) => ({ id: i + 1, type: 'CHEXA', pid: Number(options.pidPerSolid ? e.volume : 1), volume: e.volume, nodes: e.nodes.map(id => used[id]) })),
      quality: { ...quality, elements: elements.length, nodes: nodes.length, order, elementQuality }
    };
    if (!elements.length) throw Error('The mapped mesh has no elements.');
    return result;
  }

  return {
    analyze, solveIntervals, createGeometry, generateMesh, hexQuality, classifyFace,
    constants: { CUSP_MAX, CORNER_MAX, AMBIGUOUS_MIN, AMBIGUOUS_MAX, TAPER_MIN, FLAT_MIN, FLAT_MAX, MAX_ELEMENTS, MAX_NODES, HEX20_EDGES }
  };
}));
