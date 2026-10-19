/* CAD display topology is independent from finite element model ownership. */
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
    if (!input.every(value => typeof value === 'number' && Number.isFinite(value))) throw Error(`${label} must contain finite numeric coordinates.`);
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
  function createCadViewport({ THREE, scene, getCamera, getViewport, onSelection = () => {}, onChange = () => {} }) {
    const { Group, BufferGeometry, Float32BufferAttribute, Mesh, MeshPhongMaterial, LineSegments, LineBasicMaterial, Color, Box3, Vector2, Vector3, Raycaster, DoubleSide } = THREE;
    let group = null, surface = null, edgeLines = null, selectedEdges = null, data = null, bounds = null;
    let mode = 'none', visible = true, info = {}, splitGuide = null, splitPlane = null, selectedFaces = new Set(), selectedEdgeIds = new Set();
    let segmentEdgeIds = [], edgeSegments = new Map();
    const raycaster = new Raycaster();
    const baseColor = new Color(0xa7b6c5), selectedColor = new Color(0xf1b75e);
    const state = () => ({
      loaded: !!data, visible: !!(data && visible), mode,
      name: info.name || '', cadId: info.cadId || null, revision: info.revision ?? null,
      faces: Array.from(selectedFaces), edges: Array.from(selectedEdgeIds),
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
      });
      for (const material of materials) material.dispose();
      if (target.parent) target.parent.remove(target);
    }
    function paintSelection() {
      if (!data) return;
      if (surface) {
        const colors = surface.geometry.getAttribute('color');
        for (let triangle = 0; triangle < data.triangleCount; triangle++) {
          const color = selectedFaces.has(data.triangleFaceIds[triangle]) ? selectedColor : baseColor;
          for (let vertex = 0; vertex < 3; vertex++) colors.setXYZ(triangle * 3 + vertex, color.r, color.g, color.b);
        }
        colors.needsUpdate = true;
      }
      if (selectedEdges) {
        group.remove(selectedEdges);
        selectedEdges.geometry.dispose(); selectedEdges.material.dispose(); selectedEdges = null;
      }
      const positions = [];
      for (const tag of selectedEdgeIds) for (const value of edgeSegments.get(tag) || []) positions.push(value);
      if (positions.length) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
        selectedEdges = new LineSegments(geometry, new LineBasicMaterial({ color: 0xffa62f, depthWrite: false, linewidth: 3 }));
        selectedEdges.renderOrder = 7; group.add(selectedEdges);
      }
    }
    function clear() {
      disposeGroup(group);
      group = surface = edgeLines = selectedEdges = data = bounds = splitGuide = splitPlane = null;
      selectedFaces.clear(); selectedEdgeIds.clear(); segmentEdgeIds = []; edgeSegments.clear(); info = {};
      emitSelection('clear'); onChange('cad-clear');
    }
    function load(preview, options = {}) {
      const normalized = normalizeCadPreview(preview);
      const candidate = new Group(); candidate.name = 'WebMesh CAD geometry';
      let nextSurface = null, nextEdges = null;
      const positions = [], owners = [], segmentsById = new Map();
      if (normalized.triangleCount) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute(normalized.positions, 3));
        geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(normalized.positions.length), 3));
        geometry.computeVertexNormals();
        nextSurface = new Mesh(geometry, new MeshPhongMaterial({ vertexColors: true, side: DoubleSide, shininess: 48, specular: 0x343b42, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
        nextSurface.userData.kind = 'cad-surface'; candidate.add(nextSurface);
      }
      for (const [tag, edge] of normalized.edges) {
        const segments = [];
        for (let i = 3; i < edge.points.length; i += 3) {
          for (let axis = 0; axis < 3; axis++) segments.push(edge.points[i - 3 + axis]);
          for (let axis = 0; axis < 3; axis++) segments.push(edge.points[i + axis]);
          owners.push(tag);
        }
        segmentsById.set(tag, segments);
        for (const value of segments) positions.push(value);
      }
      if (positions.length) {
        const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
        nextEdges = new LineSegments(geometry, new LineBasicMaterial({ color: 0x26384a, depthWrite: false }));
        nextEdges.userData.kind = 'cad-edges'; nextEdges.renderOrder = 5; candidate.add(nextEdges);
      }
      disposeGroup(group);
      group = candidate; surface = nextSurface; edgeLines = nextEdges; selectedEdges = null;
      splitGuide = splitPlane = null;
      data = normalized; segmentEdgeIds = owners; edgeSegments = segmentsById;
      selectedFaces = new Set(); selectedEdgeIds = new Set(); info = { ...options };
      visible = options.visible !== false; group.visible = visible;
      scene.add(group); group.updateMatrixWorld(true); bounds = new Box3().setFromObject(group);
      paintSelection(); emitSelection('load'); onChange('cad-load');
      return state();
    }
    function select({ faces = [], edges = [] } = {}) {
      if (!data) return state();
      selectedFaces = new Set(faces.map(Number).filter(tag => data.faces.has(tag)));
      selectedEdgeIds = new Set(edges.map(Number).filter(tag => data.edges.has(tag)));
      paintSelection(); emitSelection('selection'); onChange('cad-selection');
      return state();
    }
    function setMode(value) {
      if (!['none', 'face', 'edge'].includes(value)) throw Error('CAD selection mode must be none, face or edge.');
      mode = value; emitSelection('mode'); onChange('cad-mode'); return state();
    }
    function setVisible(value) {
      visible = !!value; if (group) group.visible = visible;
      onChange('cad-visibility'); return state();
    }
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
      const material = new THREE.MeshBasicMaterial({ color: 0x369bd5, side: DoubleSide, transparent: true, opacity: 0.2, depthWrite: false });
      const plane = new Mesh(geometry, material); plane.renderOrder = 8;
      const edgeGeometry = new BufferGeometry();
      edgeGeometry.setAttribute('position', new Float32BufferAttribute(points.flatMap((point, i) => [...point, ...points[(i + 1) % 4]]), 3));
      const outline = new LineSegments(edgeGeometry, new LineBasicMaterial({ color: 0x2388bf, transparent: true, opacity: 0.8, depthWrite: false }));
      outline.renderOrder = 9;
      splitGuide = new Group(); splitGuide.name = 'CAD split plane guide'; splitGuide.add(plane, outline); group.add(splitGuide);
      onChange('cad-split-guide'); return state();
    }
    function hitAt(clientX, clientY, requestedMode = mode) {
      if (!data || !visible || !group || !['face', 'edge'].includes(requestedMode)) return null;
      const rect = getViewport(), camera = getCamera();
      if (!(rect.width > 0 && rect.height > 0)) return null;
      const x = (clientX - rect.left) / rect.width, y = (clientY - rect.top) / rect.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return null;
      camera.updateMatrixWorld(true); group.updateMatrixWorld(true);
      raycaster.setFromCamera(new Vector2(x * 2 - 1, 1 - y * 2), camera);
      const faceHit = surface ? raycaster.intersectObject(surface, false)[0] : null;
      if (requestedMode === 'face') return faceHit ? { kind: 'face', id: data.triangleFaceIds[faceHit.faceIndex], point: faceHit.point.toArray(), distance: faceHit.distance } : null;
      if (!edgeLines) return null;
      const distance = camera.position.distanceTo(bounds.getCenter(new Vector3()));
      const worldPerPixel = camera.isOrthographicCamera ? Math.abs(camera.top - camera.bottom) / Math.max(1e-8, camera.zoom) / rect.height : 2 * distance * Math.tan(camera.fov * Math.PI / 360) / rect.height;
      raycaster.params.Line.threshold = Math.max(1e-10, worldPerPixel * 6);
      const candidates = raycaster.intersectObject(edgeLines, false);
      const edgeHit = candidates.find(hit => !faceHit || hit.distance <= faceHit.distance + raycaster.params.Line.threshold * 2);
      return edgeHit ? { kind: 'edge', id: segmentEdgeIds[Math.floor(edgeHit.index / 2)], point: edgeHit.point.toArray(), distance: edgeHit.distance } : null;
    }
    function pickAt(clientX, clientY, { additive = false } = {}) {
      if (!data || !visible || mode === 'none') return null;
      const hit = hitAt(clientX, clientY);
      let faces = additive ? new Set(selectedFaces) : new Set(), edges = additive ? new Set(selectedEdgeIds) : new Set();
      if (hit) {
        const chosen = hit.kind === 'face' ? faces : edges;
        if (additive && chosen.has(hit.id)) chosen.delete(hit.id); else chosen.add(hit.id);
      }
      select({ faces: Array.from(faces), edges: Array.from(edges) });
      return hit;
    }
    return { load, clear, select, setMode, setVisible, setSplitPlane, hitAt, pickAt, getState: state,
      getBounds: () => data && visible && bounds ? bounds.clone() : null,
      isPicking: () => !!(data && visible && mode !== 'none'), dispose: clear };
  }
  return { normalizeCadPreview, createCadViewport, limits: { maxTriangles: MAX_TRIANGLES, maxSegments: MAX_SEGMENTS } };
}));
