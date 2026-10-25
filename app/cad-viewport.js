/* CAD display topology is independent from finite element model ownership.
 *
 * Renders imported B-rep tessellations with per-face and per-edge colors,
 * picks solids, faces, edges and vertices, shows hover feedback, and hosts
 * named preview overlays (cutting planes, section outlines, mesh seeds, edge
 * count labels, ghost result geometry and mapped mesh previews).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WebMeshCadViewport = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_TRIANGLES = 500000;
  const MAX_SEGMENTS = 500000;
  const id = (value, label) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw Error(`${label} must be a positive CAD entity tag.`);
    return number;
  };
  function coordinates(input, stride, label) {
    if (!Array.isArray(input) && !ArrayBuffer.isView(input)) throw Error(`${label} must be a numeric array.`);
    if (input.length % stride) throw Error(`${label} has incomplete coordinates.`);
    if (!Array.prototype.every.call(input, value => typeof value === 'number' && Number.isFinite(value))) throw Error(`${label} must contain finite numeric coordinates.`);
    const values = Float32Array.from(input, Number);
    if (!values.every(Number.isFinite)) throw Error(`${label} must contain finite coordinates within the display range.`);
    return values;
  }
  function normalizeCadPreview(preview) {
    if (!preview || typeof preview !== 'object') throw Error('CAD preview data is missing.');
    const rawPositions = preview.positions || [];
    if (rawPositions.length > MAX_TRIANGLES * 9) throw Error('CAD preview exceeds the triangle display limit.');
    const positions = coordinates(rawPositions, 9, 'CAD triangles');
    const triangleCount = positions.length / 9;
    if (!Array.isArray(preview.triangleFaceIds) && !ArrayBuffer.isView(preview.triangleFaceIds)) throw Error('CAD preview needs one face tag per triangle.');
    if (preview.triangleFaceIds.length !== triangleCount) throw Error('CAD triangle and face-tag counts do not match.');
    const triangleFaceIds = Int32Array.from(preview.triangleFaceIds, value => id(value, 'Face ID'));
    const faces = new Map();
    for (const record of preview.faces || []) {
      const tag = id(record.id ?? record.tag, 'Face ID');
      if (faces.has(tag)) throw Error(`CAD face ${tag} is duplicated.`);
      faces.set(tag, { ...record, id: tag });
    }
    for (const tag of triangleFaceIds) if (!faces.has(tag)) faces.set(tag, { id: tag });
    const edges = new Map();
    let segmentCount = 0;
    for (const record of preview.edges || []) {
      const tag = id(record.id ?? record.tag, 'Edge ID');
      if (edges.has(tag)) throw Error(`CAD edge ${tag} is duplicated.`);
      const raw = record.points || [];
      if (raw.length > (MAX_SEGMENTS + 1) * 3) throw Error('CAD edge exceeds the segment display limit.');
      const points = coordinates(raw, 3, `CAD edge ${tag}`);
      segmentCount += Math.max(0, points.length / 3 - 1);
      if (segmentCount > MAX_SEGMENTS) throw Error('CAD preview exceeds the segment display limit.');
      edges.set(tag, { ...record, id: tag, points });
    }
    if (!triangleCount && !segmentCount) throw Error('The CAD preview contains no displayable surfaces or edges.');
    return { positions, triangleFaceIds, faces, edges, triangleCount, segmentCount };
  }

  /** Intersection of a plane with a triangle soup, as line segment endpoints. */
  function sectionSegments(positions, triangleCount, origin, normal, include = null, owners = null) {
    const out = [];
    const d = new Float64Array(3);
    for (let t = 0; t < triangleCount; t++) {
      if (include && owners && !include(owners[t])) continue;
      const o = t * 9;
      for (let k = 0; k < 3; k++) d[k] = (positions[o + 3 * k] - origin[0]) * normal[0] + (positions[o + 3 * k + 1] - origin[1]) * normal[1] + (positions[o + 3 * k + 2] - origin[2]) * normal[2];
      const crossing = [];
      for (let k = 0; k < 3; k++) {
        const a = k, b = (k + 1) % 3;
        if ((d[a] > 0) !== (d[b] > 0) && d[a] !== d[b]) {
          const s = d[a] / (d[a] - d[b]);
          crossing.push([0, 1, 2].map(i => positions[o + 3 * a + i] + (positions[o + 3 * b + i] - positions[o + 3 * a + i]) * s));
        }
      }
      if (crossing.length === 2) out.push(...crossing[0], ...crossing[1]);
    }
    return new Float32Array(out);
  }

  /** Area-weighted vertex normals shared only within each (smooth) CAD face. */
  function faceSmoothNormals(positions, owners, triangleCount) {
    const normals = new Float32Array(positions.length);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < positions.length; i++) { if (positions[i] < lo) lo = positions[i]; if (positions[i] > hi) hi = positions[i]; }
    const quantum = Math.max((hi - lo) * 1e-6, 1e-12);
    const sums = new Map(), keys = new Array(triangleCount * 3);
    const tri = new Float64Array(9);
    for (let t = 0; t < triangleCount; t++) {
      for (let k = 0; k < 9; k++) tri[k] = positions[t * 9 + k];
      const ux = tri[3] - tri[0], uy = tri[4] - tri[1], uz = tri[5] - tri[2], vx = tri[6] - tri[0], vy = tri[7] - tri[1], vz = tri[8] - tri[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (let k = 0; k < 3; k++) {
        const key = owners[t] + ':' + Math.round(tri[3 * k] / quantum) + ':' + Math.round(tri[3 * k + 1] / quantum) + ':' + Math.round(tri[3 * k + 2] / quantum);
        keys[t * 3 + k] = key;
        const sum = sums.get(key);
        if (sum) { sum[0] += nx; sum[1] += ny; sum[2] += nz; } else sums.set(key, [nx, ny, nz]);
      }
    }
    for (let v = 0; v < triangleCount * 3; v++) {
      const n = sums.get(keys[v]), length = Math.hypot(n[0], n[1], n[2]) || 1;
      normals[3 * v] = n[0] / length; normals[3 * v + 1] = n[1] / length; normals[3 * v + 2] = n[2] / length;
    }
    return normals;
  }

  const PALETTE = {
    base: 0xa7b6c5, selected: 0xf1b75e, hover: 0xdce8f2, hoverSelected: 0xffd28a,
    edge: 0x26384a, edgeSelected: 0xffa62f, edgeHover: 0x7fe7ff, vertex: 0x2a3b4d, vertexSelected: 0xffa62f
  };

  function createCadViewport({ THREE, scene, getCamera, getViewport, onSelection = () => {}, onChange = () => {}, onHover = () => {} }) {
    const { Group, BufferGeometry, Float32BufferAttribute, BufferAttribute, Mesh, MeshPhongMaterial, MeshBasicMaterial, LineSegments, LineBasicMaterial, Points, PointsMaterial, Color, Box3, Vector2, Vector3, Raycaster, DoubleSide } = THREE;
    let group = null, surface = null, edgeLines = null, selectedEdges = null, vertexPoints = null, data = null, bounds = null;
    let mode = 'none', visible = true, info = {}, splitGuide = null, splitPlane = null;
    let selectedFaces = new Set(), selectedEdgeIds = new Set(), selectedVertices = new Set(), selectedVolumes = new Set();
    let segmentEdgeIds = [], edgeSegments = new Map(), edgeSegmentRange = new Map();
    let faceTriangles = new Map(), faceVolumes = new Map(), volumeFaces = new Map(), vertices = new Map(), vertexOrder = [];
    let faceColors = null, edgeColors = null, hidden = new Set(), visibleTriangles = null, hover = null, xray = false;
    const overlays = new Map();
    const raycaster = new Raycaster();
    const color = value => value instanceof Color ? value : new Color(value);
    const state = () => ({
      loaded: !!data, visible: !!(data && visible), mode, xray,
      name: info.name || '', cadId: info.cadId || null, revision: info.revision ?? null,
      faces: Array.from(selectedFaces), edges: Array.from(selectedEdgeIds), vertices: Array.from(selectedVertices), volumes: Array.from(selectedVolumes),
      hiddenVolumes: Array.from(hidden),
      splitPlane: splitPlane ? { ...splitPlane } : null,
      counts: { faces: data ? data.faces.size : 0, edges: data ? data.edges.size : 0, triangles: data ? data.triangleCount : 0, segments: data ? data.segmentCount : 0 },
      bounds: bounds ? { min: bounds.min.toArray(), max: bounds.max.toArray() } : null
    });
    const emitSelection = reason => onSelection({ ...state(), reason });
    function disposeGroup(target) {
      if (!target) return;
      const materials = new Set();
      target.traverse(object => {
        if (object.geometry) object.geometry.dispose();
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material) materials.add(material);
        if (object.isCSS2DObject && object.element && object.element.remove) object.element.remove();
      });
      for (const material of materials) { if (material.map) material.map.dispose(); material.dispose(); }
      if (target.parent) target.parent.remove(target);
    }
    let dotTexture;
    function pointTexture() {
      if (dotTexture !== undefined) return dotTexture;
      dotTexture = null;
      if (typeof document === 'undefined' || !document.createElement || !THREE.CanvasTexture) return dotTexture;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const context = canvas.getContext && canvas.getContext('2d');
      if (!context) return dotTexture;
      context.beginPath(); context.arc(32, 32, 26, 0, Math.PI * 2); context.fillStyle = '#ffffff'; context.fill();
      context.lineWidth = 8; context.strokeStyle = 'rgba(10,18,26,0.85)'; context.stroke();
      dotTexture = new THREE.CanvasTexture(canvas);
      return dotTexture;
    }
    function pointsMaterial(size, opts = {}) {
      const map = pointTexture();
      return new PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, map: map || null, transparent: !!map, alphaTest: map ? 0.4 : 0, depthTest: opts.depthTest !== false, depthWrite: false });
    }
    /* -------------------------------- painting -------------------------------- */
    function faceIsSelected(tag) {
      if (selectedFaces.has(tag)) return true;
      if (selectedVolumes.size) for (const v of faceVolumes.get(tag) || []) if (selectedVolumes.has(v)) return true;
      return false;
    }
    function faceIsHovered(tag) {
      if (!hover) return false;
      if (hover.kind === 'face') return hover.id === tag;
      if (hover.kind === 'solid') return (faceVolumes.get(tag) || []).includes(hover.id);
      return false;
    }
    const scratch = new Color();
    function faceColor(tag) {
      const selected = faceIsSelected(tag), hovered = faceIsHovered(tag);
      if (selected && hovered) return scratch.set(PALETTE.hoverSelected);
      if (selected) return scratch.set(PALETTE.selected);
      const base = faceColors && faceColors.has(tag) ? color(faceColors.get(tag)) : scratch.set(PALETTE.base);
      if (hovered) return scratch.copy(base).lerp(new Color(0xffffff), 0.45);
      return base === scratch ? scratch : scratch.copy(base);
    }
    function paintFaces(tags = null) {
      if (!surface) return;
      const colors = surface.geometry.getAttribute('color');
      const list = tags ? [...tags] : [...faceTriangles.keys()];
      for (const tag of list) {
        const c = faceColor(tag);
        for (const t of faceTriangles.get(tag) || []) for (let v = 0; v < 3; v++) colors.setXYZ(t * 3 + v, c.r, c.g, c.b);
      }
      colors.needsUpdate = true;
    }
    function edgeColor(tag) {
      if (selectedEdgeIds.has(tag)) return scratch.set(PALETTE.edgeSelected);
      if (hover && hover.kind === 'edge' && hover.id === tag) return scratch.set(PALETTE.edgeHover);
      if (edgeColors && edgeColors.has(tag)) return scratch.copy(color(edgeColors.get(tag)));
      return scratch.set(PALETTE.edge);
    }
    function paintEdges(tags = null) {
      if (!edgeLines) return;
      const colors = edgeLines.geometry.getAttribute('color');
      for (const tag of tags ? [...tags] : [...edgeSegmentRange.keys()]) {
        const range = edgeSegmentRange.get(tag); if (!range) continue;
        const c = edgeColor(tag);
        for (let s = range[0]; s < range[1]; s++) { colors.setXYZ(2 * s, c.r, c.g, c.b); colors.setXYZ(2 * s + 1, c.r, c.g, c.b); }
      }
      colors.needsUpdate = true;
    }
    function paintVertices() {
      if (!vertexPoints) return;
      const colors = vertexPoints.geometry.getAttribute('color');
      vertexOrder.forEach((tag, i) => {
        const c = selectedVertices.has(tag) ? scratch.set(PALETTE.vertexSelected) : hover && hover.kind === 'vertex' && hover.id === tag ? scratch.set(PALETTE.edgeHover) : scratch.set(0xe8f0f7);
        colors.setXYZ(i, c.r, c.g, c.b);
      });
      colors.needsUpdate = true;
      vertexPoints.visible = mode === 'vertex' || mode === 'auto' || selectedVertices.size > 0;
    }
    function paintSelection() {
      if (!data) return;
      paintFaces(); paintEdges(); paintVertices();
      if (selectedEdges) { group.remove(selectedEdges); selectedEdges.geometry.dispose(); selectedEdges.material.dispose(); selectedEdges = null; }
      const positions = [];
      for (const tag of selectedEdgeIds) for (const value of edgeSegments.get(tag) || []) positions.push(value);
      if (positions.length) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
        selectedEdges = new LineSegments(geometry, new LineBasicMaterial({ color: PALETTE.edgeSelected, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 }));
        selectedEdges.renderOrder = 12; selectedEdges.userData.kind = 'cad-selected-edges'; group.add(selectedEdges);
      }
    }
    /* -------------------------------- lifecycle ------------------------------- */
    function clear() {
      disposeGroup(group);
      group = surface = edgeLines = selectedEdges = vertexPoints = data = bounds = splitGuide = splitPlane = null;
      selectedFaces.clear(); selectedEdgeIds.clear(); selectedVertices.clear(); selectedVolumes.clear();
      segmentEdgeIds = []; edgeSegments.clear(); edgeSegmentRange.clear(); faceTriangles = new Map(); faceVolumes = new Map(); volumeFaces = new Map();
      vertices = new Map(); vertexOrder = []; faceColors = edgeColors = null; hidden = new Set(); visibleTriangles = null; hover = null; overlays.clear(); watchOcclusion(); info = {};
      emitSelection('clear'); onChange('cad-clear');
    }
    function load(preview, options = {}) {
      const normalized = normalizeCadPreview(preview);
      const candidate = new Group(); candidate.name = 'WebMesh CAD geometry';
      let nextSurface = null, nextEdges = null, nextVertices = null;
      const positions = [], owners = [], segmentsById = new Map(), ranges = new Map();
      if (normalized.triangleCount) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute(normalized.positions, 3));
        geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(normalized.positions.length), 3));
        if (normalized.triangleCount <= 400000) geometry.setAttribute('normal', new Float32BufferAttribute(faceSmoothNormals(normalized.positions, normalized.triangleFaceIds, normalized.triangleCount), 3));
        else geometry.computeVertexNormals();
        nextSurface = new Mesh(geometry, new MeshPhongMaterial({ vertexColors: true, side: DoubleSide, shininess: 48, specular: 0x343b42, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
        nextSurface.userData.kind = 'cad-surface'; candidate.add(nextSurface);
      }
      for (const [tag, edge] of normalized.edges) {
        const segments = [], start = owners.length;
        for (let i = 3; i < edge.points.length; i += 3) {
          for (let axis = 0; axis < 3; axis++) segments.push(edge.points[i - 3 + axis]);
          for (let axis = 0; axis < 3; axis++) segments.push(edge.points[i + axis]);
          owners.push(tag);
        }
        segmentsById.set(tag, segments); ranges.set(tag, [start, owners.length]);
        for (const value of segments) positions.push(value);
      }
      if (positions.length) {
        const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
        geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(positions.length), 3));
        nextEdges = new LineSegments(geometry, new LineBasicMaterial({ vertexColors: true, depthWrite: false }));
        nextEdges.userData.kind = 'cad-edges'; nextEdges.renderOrder = 5; candidate.add(nextEdges);
      }
      const topology = options.topology || null;
      const nextVertexMap = new Map((topology?.vertices || []).map(v => [Number(v.id), v.point]));
      const order = [...nextVertexMap.keys()];
      if (order.length) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute(order.flatMap(tag => nextVertexMap.get(tag)), 3));
        geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(order.length * 3), 3));
        nextVertices = new Points(geometry, pointsMaterial(9));
        nextVertices.userData.kind = 'cad-vertices'; nextVertices.renderOrder = 11; nextVertices.visible = false; candidate.add(nextVertices);
      }
      disposeGroup(group);
      group = candidate; surface = nextSurface; edgeLines = nextEdges; vertexPoints = nextVertices; selectedEdges = null;
      splitGuide = splitPlane = null; overlays.clear(); watchOcclusion();
      data = normalized; segmentEdgeIds = owners; edgeSegments = segmentsById; edgeSegmentRange = ranges;
      faceTriangles = new Map();
      normalized.triangleFaceIds.forEach((tag, t) => { if (!faceTriangles.has(tag)) faceTriangles.set(tag, []); faceTriangles.get(tag).push(t); });
      faceVolumes = new Map(); volumeFaces = new Map();
      for (const face of topology?.faces || normalized.faces.values()) {
        const list = (face.volumes || []).map(Number);
        faceVolumes.set(Number(face.id), list);
        for (const v of list) { if (!volumeFaces.has(v)) volumeFaces.set(v, []); volumeFaces.get(v).push(Number(face.id)); }
      }
      vertices = nextVertexMap; vertexOrder = order;
      selectedFaces = new Set(); selectedEdgeIds = new Set(); selectedVertices = new Set(); selectedVolumes = new Set();
      faceColors = edgeColors = null; hidden = new Set(); visibleTriangles = null; hover = null; xray = false;
      info = { ...options }; delete info.topology;
      visible = options.visible !== false; group.visible = visible;
      scene.add(group); group.updateMatrixWorld(true); bounds = new Box3().setFromObject(surface || edgeLines || group);
      paintSelection(); emitSelection('load'); onChange('cad-load');
      return state();
    }
    function select({ faces = [], edges = [], vertices: vertexIds = [], volumes = [] } = {}) {
      if (!data) return state();
      selectedFaces = new Set(faces.map(Number).filter(tag => data.faces.has(tag)));
      selectedEdgeIds = new Set(edges.map(Number).filter(tag => data.edges.has(tag)));
      selectedVertices = new Set(vertexIds.map(Number).filter(tag => vertices.has(tag)));
      selectedVolumes = new Set(volumes.map(Number).filter(tag => volumeFaces.has(tag)));
      paintSelection(); emitSelection('selection'); onChange('cad-selection');
      return state();
    }
    function setMode(value) {
      if (!['none', 'auto', 'face', 'edge', 'vertex', 'solid'].includes(value)) throw Error('CAD selection mode must be none, auto, solid, face, edge or vertex.');
      mode = value; setHover(null); paintVertices(); emitSelection('mode'); onChange('cad-mode'); return state();
    }
    function setVisible(value) {
      visible = !!value; if (group) group.visible = visible;
      onChange('cad-visibility'); return state();
    }
    /* ----------------------------- colors & display ---------------------------- */
    function setFaceColors(map) { faceColors = map ? new Map([...map].map(([k, v]) => [Number(k), v])) : null; paintFaces(); onChange('cad-display'); }
    function setEdgeColors(map) { edgeColors = map ? new Map([...map].map(([k, v]) => [Number(k), v])) : null; paintEdges(); onChange('cad-display'); }
    function setBaseVisible(value) {
      // Hide the source surfaces while a result or mesh preview stands in for them.
      for (const object of [surface, edgeLines, selectedEdges]) if (object) object.visible = !!value;
      onChange('cad-display');
    }
    function setXray(value) {
      xray = !!value;
      if (surface) {
        surface.material.transparent = xray; surface.material.opacity = xray ? 0.28 : 1; surface.material.depthWrite = !xray; surface.material.needsUpdate = true;
      }
      onChange('cad-display'); return state();
    }
    function setHiddenVolumes(list, faces) {
      hidden = new Set((list || []).map(Number));
      // Faces of no solid (sheets) are hidden by name.
      const hiddenFaces = new Set((faces || []).map(Number));
      if (!surface) return state();
      const hiddenFace = tag => hiddenFaces.has(tag) || (() => { const owners = faceVolumes.get(tag) || []; return owners.length > 0 && owners.every(v => hidden.has(v)); })();
      if (!hidden.size && !hiddenFaces.size) { surface.geometry.setIndex(null); visibleTriangles = null; }
      else {
        const index = [], map = [];
        for (let t = 0; t < data.triangleCount; t++) if (!hiddenFace(data.triangleFaceIds[t])) { index.push(3 * t, 3 * t + 1, 3 * t + 2); map.push(t); }
        surface.geometry.setIndex(index); visibleTriangles = map;
      }
      if (edgeLines) {
        if (!hidden.size && !hiddenFaces.size) edgeLines.geometry.setIndex(null);
        else {
          const index = [], faceOwners = new Map();
          for (const [face, list] of faceVolumes) for (const v of list) { if (!faceOwners.has(face)) faceOwners.set(face, []); faceOwners.get(face).push(v); }
          const visibleEdge = new Map();
          for (const [tag, edge] of data.edges) visibleEdge.set(tag, !(edge.faces || []).length || (edge.faces || []).some(f => !hiddenFace(Number(f))));
          segmentEdgeIds.forEach((tag, s) => { if (visibleEdge.get(tag) !== false) index.push(2 * s, 2 * s + 1); });
          edgeLines.geometry.setIndex(index);
        }
      }
      onChange('cad-display'); return state();
    }
    function setEdgeFaces(map) {
      // Optional edge -> faces map for hiding edges with their solids.
      if (!data) return;
      for (const [tag, faces] of map) { const edge = data.edges.get(Number(tag)); if (edge) edge.faces = faces; }
    }
    /* -------------------------------- overlays -------------------------------- */
    function clearOverlay(name) {
      const existing = overlays.get(name);
      if (existing) { disposeGroup(existing); overlays.delete(name); watchOcclusion(); onChange('cad-overlay'); }
    }
    function clearOverlays(prefix = '') { for (const name of [...overlays.keys()]) if (name.startsWith(prefix)) clearOverlay(name); }
    function planeQuad(origin, normal, extent) {
      const n = new Vector3(...normal).normalize();
      const helper = Math.abs(n.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
      const u = new Vector3().crossVectors(n, helper).normalize(), w = new Vector3().crossVectors(n, u).normalize();
      const center = bounds ? bounds.getCenter(new Vector3()) : new Vector3();
      const o = new Vector3(...origin), offset = center.clone().sub(o).dot(n);
      const middle = center.clone().sub(n.clone().multiplyScalar(offset));
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => middle.clone().add(u.clone().multiplyScalar(a * extent)).add(w.clone().multiplyScalar(b * extent)).toArray());
    }
    function buildOverlay(spec) {
      const target = new Group();
      const type = spec.type;
      if (type === 'planes') {
        const size = bounds ? bounds.getSize(new Vector3()).length() * 0.62 : 1;
        for (const plane of spec.planes || []) {
          const pts = plane.corners || planeQuad(plane.origin, plane.normal, plane.extent || size);
          const geometry = new BufferGeometry();
          geometry.setAttribute('position', new Float32BufferAttribute(pts.flat(), 3)); geometry.setIndex([0, 1, 2, 0, 2, 3]);
          const quad = new Mesh(geometry, new MeshBasicMaterial({ color: plane.color ?? 0x3aa8e6, side: DoubleSide, transparent: true, opacity: plane.opacity ?? 0.16, depthWrite: false }));
          quad.renderOrder = 9;
          const outline = new BufferGeometry();
          outline.setAttribute('position', new Float32BufferAttribute(pts.flatMap((p, i) => [...p, ...pts[(i + 1) % pts.length]]), 3));
          const line = new LineSegments(outline, new LineBasicMaterial({ color: plane.color ?? 0x3aa8e6, transparent: true, opacity: 0.75, depthWrite: false }));
          line.renderOrder = 9;
          target.add(quad, line);
        }
      } else if (type === 'lines') {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute(spec.positions, 3));
        if (spec.colors) geometry.setAttribute('color', new Float32BufferAttribute(spec.colors, 3));
        const line = new LineSegments(geometry, new LineBasicMaterial({ color: spec.colors ? 0xffffff : (spec.color ?? 0xffd54a), vertexColors: !!spec.colors, transparent: true, opacity: spec.opacity ?? 1, depthTest: spec.depthTest !== false, depthWrite: false }));
        line.renderOrder = spec.renderOrder ?? 10; target.add(line);
      } else if (type === 'points') {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute(spec.positions, 3));
        const count = spec.positions.length / 3;
        const colors = spec.colors || new Float32Array(count * 3).map((_, i) => color(spec.color ?? 0x5cd9bb).toArray()[i % 3]);
        geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
        const points = new Points(geometry, pointsMaterial(spec.size ?? 6, { depthTest: spec.depthTest }));
        points.renderOrder = spec.renderOrder ?? 8; target.add(points);
      } else if (type === 'faces') {
        const tris = [];
        for (const tag of spec.faces || []) for (const t of faceTriangles.get(Number(tag)) || []) for (let k = 0; k < 9; k++) tris.push(data.positions[t * 9 + k]);
        if (tris.length) {
          const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(tris, 3));
          const mesh = new Mesh(geometry, new MeshBasicMaterial({ color: spec.color ?? 0xff5c5c, transparent: true, opacity: spec.opacity ?? 0.55, side: DoubleSide, depthWrite: false, depthTest: spec.depthTest !== false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
          mesh.renderOrder = spec.renderOrder ?? 6; target.add(mesh);
        }
      } else if (type === 'mesh') {
        const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(spec.positions, 3));
        if (spec.colors) geometry.setAttribute('color', new Float32BufferAttribute(spec.colors, 3));
        const count = spec.positions.length / 9;
        if (spec.owners && spec.owners.length === count) geometry.setAttribute('normal', new Float32BufferAttribute(faceSmoothNormals(Float32Array.from(spec.positions), spec.owners, count), 3));
        else geometry.computeVertexNormals();
        const Material = spec.lit === false ? MeshBasicMaterial : MeshPhongMaterial;
        const mesh = new Mesh(geometry, new Material({ color: spec.colors ? 0xffffff : (spec.color ?? 0x8fd6c4), vertexColors: !!spec.colors, side: DoubleSide, transparent: (spec.opacity ?? 1) < 1, opacity: spec.opacity ?? 1, depthWrite: (spec.opacity ?? 1) >= 1, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
        mesh.renderOrder = spec.renderOrder ?? 3; target.add(mesh);
        if (spec.edges) {
          const edges = new BufferGeometry(); edges.setAttribute('position', new Float32BufferAttribute(spec.edges, 3));
          const line = new LineSegments(edges, new LineBasicMaterial({ color: spec.edgeColor ?? 0x1c2a36, transparent: true, opacity: spec.edgeOpacity ?? 0.85, depthWrite: false }));
          line.renderOrder = (spec.renderOrder ?? 3) + 1; target.add(line);
        }
      } else if (type === 'labels') {
        if (!THREE.CSS2DObject || typeof document === 'undefined') return target;
        for (const label of spec.labels || []) {
          const element = document.createElement('div');
          element.className = 'cad-label ' + (label.className || '');
          element.textContent = label.text;
          if (label.title) element.title = label.title;
          if (spec.onClick) { element.style.pointerEvents = 'auto'; element.addEventListener('mousedown', event => event.stopPropagation()); element.addEventListener('click', event => { event.stopPropagation(); spec.onClick(label, event); }); }
          const object = new THREE.CSS2DObject(element);
          object.position.set(...label.position);
          object.userData.label = label;
          target.add(object);
        }
        target.userData.labels = true;
      }
      return target;
    }
    // Labels dim when a surface hides them; re-checked once the camera settles.
    let occlusionTimer = null, lastCamera = '', settled = true;
    function watchOcclusion() {
      const labelled = [...overlays.values()].some(o => o.userData.labels);
      if (!labelled) { if (occlusionTimer) { clearInterval(occlusionTimer); occlusionTimer = null; } return; }
      if (occlusionTimer || typeof setInterval !== 'function') return;
      occlusionTimer = setInterval(() => {
        const camera = getCamera(); if (!camera) return;
        const key = camera.matrixWorld.elements.map(v => v.toFixed(5)).join(',') + (camera.zoom || 1);
        if (key !== lastCamera) { lastCamera = key; settled = false; return; }
        if (!settled) { settled = true; updateLabelOcclusion(); }
      }, 220);
      if (occlusionTimer.unref) occlusionTimer.unref();
    }
    function setOverlay(name, spec) {
      if (!group) return;
      const existing = overlays.get(name);
      const next = buildOverlay(spec);
      next.name = 'CAD overlay ' + name;
      next.userData.includeInFit = spec.includeInFit === true;
      next.visible = spec.visible !== false;
      group.add(next); overlays.set(name, next);
      if (existing) disposeGroup(existing);
      if (next.userData.labels) { settled = false; lastCamera = ''; }
      watchOcclusion();
      onChange('cad-overlay');
    }
    function overlayNames() { return [...overlays.keys()]; }
    function updateLabelOcclusion() {
      if (!surface || !group) return;
      const camera = getCamera();
      for (const overlay of overlays.values()) {
        if (!overlay.userData.labels) continue;
        for (const object of overlay.children) {
          const target = object.position.clone();
          let occluded = false;
          if (!xray) {
            const origin = camera.position.clone();
            if (camera.isOrthographicCamera) {
              const direction = new Vector3(); camera.getWorldDirection(direction);
              origin.copy(target).sub(direction.clone().multiplyScalar(bounds.getSize(new Vector3()).length() * 4));
            }
            const direction = target.clone().sub(origin), distance = direction.length();
            raycaster.set(origin, direction.normalize());
            raycaster.far = distance;
            const hit = raycaster.intersectObject(surface, false)[0];
            occluded = !!hit && hit.distance < distance - Math.max(distance * 2e-3, 1e-6);
            raycaster.far = Infinity;
          }
          object.element.classList.toggle('occluded', occluded);
        }
      }
    }
    /* ------------------------------- split guide ------------------------------- */
    function setSplitPlane(value) {
      if (value != null && (!['x', 'y', 'z'].includes(value.axis) || !Number.isFinite(value.position))) throw Error('Split plane needs an X, Y or Z axis and finite position.');
      if (splitGuide) { disposeGroup(splitGuide); splitGuide = null; }
      splitPlane = value ? { axis: value.axis, position: value.position } : null;
      if (!data || !splitPlane) { onChange('cad-split-guide'); return state(); }
      const fixed = ['x', 'y', 'z'].indexOf(value.axis), varying = [0, 1, 2].filter(axis => axis !== fixed);
      const min = bounds.min.toArray(), max = bounds.max.toArray(), size = bounds.getSize(new Vector3()).length();
      const pad = Math.max(1e-6, size * 0.08);
      const points = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(signs => {
        const point = [0, 0, 0]; point[fixed] = value.position;
        varying.forEach((axis, i) => { point[axis] = signs[i] < 0 ? min[axis] - pad : max[axis] + pad; });
        return point;
      });
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(points.flat(), 3)); geometry.setIndex([0, 1, 2, 0, 2, 3]);
      const material = new MeshBasicMaterial({ color: 0x369bd5, side: DoubleSide, transparent: true, opacity: 0.2, depthWrite: false });
      const plane = new Mesh(geometry, material); plane.renderOrder = 8;
      const edgeGeometry = new BufferGeometry();
      edgeGeometry.setAttribute('position', new Float32BufferAttribute(points.flatMap((point, i) => [...point, ...points[(i + 1) % 4]]), 3));
      const outline = new LineSegments(edgeGeometry, new LineBasicMaterial({ color: 0x2388bf, transparent: true, opacity: 0.8, depthWrite: false }));
      outline.renderOrder = 9;
      splitGuide = new Group(); splitGuide.name = 'CAD split plane guide'; splitGuide.add(plane, outline); group.add(splitGuide);
      onChange('cad-split-guide'); return state();
    }
    /* --------------------------------- picking --------------------------------- */
    function ray(clientX, clientY) {
      const rect = getViewport(), camera = getCamera();
      if (!(rect.width > 0 && rect.height > 0)) return null;
      const x = (clientX - rect.left) / rect.width, y = (clientY - rect.top) / rect.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return null;
      camera.updateMatrixWorld(true); group.updateMatrixWorld(true);
      raycaster.setFromCamera(new Vector2(x * 2 - 1, 1 - y * 2), camera);
      return { rect, camera, x, y };
    }
    function worldPerPixel(rect, camera) {
      const distance = camera.position.distanceTo(bounds.getCenter(new Vector3()));
      return camera.isOrthographicCamera ? Math.abs(camera.top - camera.bottom) / Math.max(1e-8, camera.zoom) / rect.height : 2 * distance * Math.tan(camera.fov * Math.PI / 360) / rect.height;
    }
    function hitAt(clientX, clientY, requestedMode = mode, reach = {}) {
      if (requestedMode === 'auto') {
        // No filter: the smallest entity near the pointer wins (point, then edge, then face).
        return hitAt(clientX, clientY, 'vertex', { pixels: 7 }) || hitAt(clientX, clientY, 'edge', { pixels: 4 }) || hitAt(clientX, clientY, 'face');
      }
      if (!data || !visible || !group || !['face', 'edge', 'vertex', 'solid'].includes(requestedMode)) return null;
      const view = ray(clientX, clientY);
      if (!view) return null;
      const faceHit = surface ? raycaster.intersectObject(surface, false)[0] : null;
      const triangle = faceHit ? (visibleTriangles ? visibleTriangles[faceHit.faceIndex] : faceHit.faceIndex) : null;
      const faceTag = faceHit ? data.triangleFaceIds[triangle] : null;
      if (requestedMode === 'face') return faceHit ? { kind: 'face', id: faceTag, point: faceHit.point.toArray(), distance: faceHit.distance } : null;
      if (requestedMode === 'solid') {
        if (!faceHit) return null;
        const owners = (faceVolumes.get(faceTag) || []).filter(v => !hidden.has(v));
        return owners.length ? { kind: 'solid', id: owners[0], face: faceTag, point: faceHit.point.toArray(), distance: faceHit.distance } : null;
      }
      if (requestedMode === 'vertex') {
        if (!vertexOrder.length) return null;
        const camera = view.camera, rect = view.rect, threshold = reach.pixels || 12;
        let best = null;
        const projected = new Vector3();
        for (const tag of vertexOrder) {
          const p = vertices.get(tag);
          projected.set(p[0], p[1], p[2]).project(camera);
          const sx = (projected.x + 1) / 2 * rect.width + rect.left, sy = (1 - projected.y) / 2 * rect.height + rect.top;
          const d = Math.hypot(sx - clientX, sy - clientY);
          if (d > threshold || projected.z < -1 || projected.z > 1) continue;
          const distance = camera.position.distanceTo(new Vector3(...p));
          if (!xray && faceHit && camera.isPerspectiveCamera && faceHit.distance < distance - worldPerPixel(rect, camera) * 4) continue;
          if (!best || d < best.screen) best = { kind: 'vertex', id: tag, point: p.slice(), distance, screen: d };
        }
        if (best && !xray && faceHit && camera.isOrthographicCamera) {
          const direction = new Vector3(); camera.getWorldDirection(direction);
          const along = new Vector3(...best.point).sub(camera.position).dot(direction);
          if (faceHit.distance < along - worldPerPixel(rect, camera) * 4) return null;
        }
        if (best) delete best.screen;
        return best;
      }
      if (!edgeLines) return null;
      raycaster.params.Line.threshold = Math.max(1e-10, worldPerPixel(view.rect, view.camera) * (reach.pixels || 6));
      const candidates = raycaster.intersectObject(edgeLines, false);
      const edgeHit = candidates.find(hit => xray || !faceHit || hit.distance <= faceHit.distance + raycaster.params.Line.threshold * 2);
      if (!edgeHit) return null;
      // With hidden geometry, raycast indices address the filtered index buffer.
      const vertexIndex = edgeLines.geometry.index ? edgeLines.geometry.index.getX(edgeHit.index) : edgeHit.index;
      return { kind: 'edge', id: segmentEdgeIds[Math.floor(vertexIndex / 2)], point: edgeHit.point.toArray(), distance: edgeHit.distance };
    }
    function setHover(next) {
      const previous = hover;
      const same = (a, b) => (!a && !b) || (a && b && a.kind === b.kind && a.id === b.id);
      if (same(previous, next)) { if (next) hover = next; return; }
      hover = next;
      const touched = new Set();
      for (const h of [previous, next]) {
        if (!h) continue;
        if (h.kind === 'face') touched.add(h.id);
        if (h.kind === 'solid') for (const f of volumeFaces.get(h.id) || []) touched.add(f);
      }
      if (touched.size) paintFaces(touched);
      const edgeTouched = [previous, next].filter(h => h && h.kind === 'edge').map(h => h.id);
      if (edgeTouched.length) paintEdges(edgeTouched);
      if ([previous, next].some(h => h && h.kind === 'vertex')) paintVertices();
    }
    function hoverAt(clientX, clientY) {
      if (clientX == null || !data || !visible || mode === 'none') { setHover(null); onHover(null); return null; }
      const hit = hitAt(clientX, clientY);
      setHover(hit);
      onHover(hit, clientX, clientY);
      return hit;
    }
    function pickAt(clientX, clientY, { additive = false } = {}) {
      if (!data || !visible || mode === 'none') return null;
      const hit = hitAt(clientX, clientY);
      const sets = { face: selectedFaces, edge: selectedEdgeIds, vertex: selectedVertices, solid: selectedVolumes };
      const next = {};
      // Shift adds to the picked kind; in auto mode, to whatever kind was hit.
      for (const [kind, set] of Object.entries(sets)) next[kind] = additive && (kind === mode || (mode === 'auto' && hit && kind === hit.kind)) ? new Set(set) : new Set();
      if (hit) {
        const chosen = next[hit.kind];
        if (additive && chosen.has(hit.id)) chosen.delete(hit.id); else chosen.add(hit.id);
      }
      select({ faces: [...next.face], edges: [...next.edge], vertices: [...next.vertex], volumes: [...next.solid] });
      return hit;
    }
    return { load, clear, select, setMode, setVisible, setSplitPlane, hitAt, pickAt, hover: hoverAt, getState: state,
      setFaceColors, setEdgeColors, setXray, setBaseVisible, setHiddenVolumes, setEdgeFaces, setOverlay, clearOverlay, clearOverlays, overlayNames, updateLabelOcclusion,
      section: (origin, normal, includeFace) => data ? sectionSegments(data.positions, data.triangleCount, origin, normal, includeFace || null, data.triangleFaceIds) : new Float32Array(),
      faceVolumes: tag => (faceVolumes.get(Number(tag)) || []).slice(), volumeFaces: tag => (volumeFaces.get(Number(tag)) || []).slice(),
      getBounds: () => {
        if (!data || !visible || !bounds) return null;
        const box = bounds.clone();
        for (const overlay of overlays.values()) if (overlay.visible && overlay.userData.includeInFit) box.union(new Box3().setFromObject(overlay));
        return box;
      },
      isPicking: () => !!(data && visible && mode !== 'none'), dispose: clear };
  }
  return { normalizeCadPreview, createCadViewport, sectionSegments, limits: { maxTriangles: MAX_TRIANGLES, maxSegments: MAX_SEGMENTS } };
}));
