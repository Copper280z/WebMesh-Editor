/* CAD preparation and native mapped hex meshing workspace.
 *
 * Workflow: Prepare (slice, defeature, heal; every solid shows whether it is a
 * mapped block) → Size (edge interval equations solved live; conflicts are
 * highlighted with the faces and edges that cause them) → Mesh (native
 * transfinite HEX8/HEX20, previewed with quality before it joins the model).
 * Geometry stays separate from the finite-element model until meshes are added.
 */
(() => {
  'use strict';
  const H = () => window.WebMeshHexMapping;
  const F = () => window.WebMeshCadFeatures;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (value, digits = 4) => Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined, { maximumSignificantDigits: digits }) : '—';
  const base64 = buffer => { let s = ''; const bytes = new Uint8Array(buffer); for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(s); };
  const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
  const MAX_CONTROLS = 2000;
  const ICONS = {
    solid: 'M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9',
    face: 'M4 8 12 4l8 4-8 4-8-4Zm0 0v8l8 4 8-4V8',
    edge: 'M5 19 19 5M5 19h.01M19 5h.01',
    vertex: 'M12 12m-3 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0M4 20l5-5m6-6 5-5',
    slice: 'M4 7 12 3l8 4v10l-8 4-8-4V7Zm-1 6 18-3',
    cut: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm2.1-13.1L20 18M8.1 16.1 20 6',
    features: 'M4 5h16v14H4V5Zm8 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
    passage: 'M4 5h16v14H4V5Zm5 4h6v6H9V9Z',
    project: 'M4 17h16M7 17V9h4v8m2 0V6h4v11',
    heal: 'M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10Z',
    lock: 'M6 10h12v11H6V10Zm3 0V7a3 3 0 0 1 6 0v3',
    unlock: 'M6 10h12v11H6V10Zm3 0V7a3 3 0 0 1 5.8-1',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
    hide: 'M3 3l18 18M10.6 6.1A9.6 9.6 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.3 6.4C3.7 8.1 2 12 2 12s4 7 10 7c1.7 0 3.2-.5 4.5-1.2',
    xray: 'M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Zm0 0v18M4 7.5l16 9m0-9-16 9',
    check: 'm5 12 4 4L19 6', warn: 'M12 4 2 20h20L12 4Zm0 6v4m0 3h.01', x: 'm6 6 12 12M18 6 6 18',
    target: 'M12 3v4m0 10v4M3 12h4m10 0h4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', undo: 'M8 4 3 9l5 5M3 9h10a7 7 0 0 1 0 14', redo: 'm16 4 5 5-5 5m5-5H11a7 7 0 0 0 0 14',
    arrow: 'M4 12h16m-6-6 6 6-6 6', minus: 'M5 12h14', plus: 'M12 5v14M5 12h14', flip: 'M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3',
    file: 'M14 3H5v18h14V8l-5-5Zm0 0v6h5', mesh: 'M3 4h18v16H3V4Zm0 5h18M3 15h18M9 4v16m6-16v16', spark: 'M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5m7 7L18 18M6 18l2.5-2.5m7-7L18 6', stop: 'M7 7h10v10H7V7Z', shell: 'M3 9l9-5 9 5-9 5-9-5Zm0 5 9 5 9-5',
    sheet: 'M3 10l9-5 9 5-9 5-9-5Z', extend: 'M4 12h11m-4-4 4 4-4 4M20 5v14', join: 'M5 5v14M5 12h14M19 5v14'
  };
  const icon = (name, cls = '') => `<svg class="cad-i ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] || ICONS.solid}"/></svg>`;
  const ISSUE = 0xffd400;
  const STATUS_COLORS = { ok: 0x58c79f, blocked: 0xe7735f, conflict: 0xe8b04c, other: 0x8b9aab };
  const SHEET_COLOR = 0x7fa8f0;
  const GROUP_COLORS = [0x4cc9f0, 0xf72585, 0x7bd389, 0xffb703, 0xb388eb, 0xff7f51, 0x2ec4b6, 0xe0aaff, 0x90be6d, 0xf9844a, 0x48bfe3, 0xff99c8, 0x80ed99, 0xfcbf49, 0x8ecae6, 0xc77dff];
  const hueColor = index => { const h = (index * 137.508) % 360; const s = 0.42, l = 0.62; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l); const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255); };
  const rgb = hex => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  const qualityColor = sj => { const t = Math.max(0, Math.min(1, sj)); return t < 0.3 ? [0.93, 0.36, 0.33] : t < 0.6 ? [0.95, 0.72, 0.3] : t < 0.85 ? [0.62, 0.84, 0.45] : [0.36, 0.8, 0.62]; };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = a => Math.hypot(a[0], a[1], a[2]);
  const unit = a => { const n = norm(a); return n > 0 ? a.map(v => v / n) : [0, 0, 0]; };
  const round = v => Math.round(v * 1e9) / 1e9;

  window.WebMeshCadWorkspace = { create(hooks) {
    const engine = hooks.engine;
    const viewport = () => engine()?.getCadViewport?.() || null;
    let source = null, session = null, active = false;
    // Keep a tab identity across reloads without letting a duplicated tab inherit
    // the same mutable sessions (browsers copy sessionStorage when duplicating).
    const restoreClientReady=new Promise(resolve=>{
      const fresh=()=>crypto.randomUUID();
      if(typeof navigator==='undefined'||!navigator?.locks){resolve(fresh());return;}
      let saved;try{saved=sessionStorage.getItem('webmesh.cad.client');}catch{}
      const claim=id=>navigator.locks.request('webmesh.cad.client:'+id,{ifAvailable:true},lock=>{
        if(!lock){claim(fresh());return;}
        try{sessionStorage.setItem('webmesh.cad.client',id);}catch{}
        resolve(id);
        return new Promise(release=>window.addEventListener('pagehide',release,{once:true}));
      }).catch(()=>resolve(fresh()));
      claim(saved||fresh());
    });
    const beginRestore=async()=>({client:await restoreClientReady,transaction:crypto.randomUUID()});
    async function finishRestore(transaction,commit){if(!transaction)return;return api('restore_finish',{...transaction,commit});}
    async function abortRestore(transaction){
      if(!transaction)return;
      try { await finishRestore(transaction,false); }
      catch(error) { if(error.unsupportedRestore)return;try { await finishRestore(transaction,false); }catch{hooks.message('Restore cancelled. The service could not confirm cleanup; unadopted candidates expire after 15 minutes. Existing drafts are retained.',true);} }
    }
    function validateRestore(data){
      if(!data)return;
      if(typeof data.filename!=='string'||typeof data.content!=='string')throw Error('Invalid CAD source in the project.');
      fromBase64(data.content);
      const edges=data.settings?.sizing?.edges;
      if(Array.isArray(edges)&&edges.length>MAX_CONTROLS)throw Error(`Saved sizing exceeds ${MAX_CONTROLS} edge controls. Reduce the saved control list before restoring this project.`);
    }

    let analysis = null, recognized = null, geometry = null, intervals = null;
    let step = 'prepare', pick = 'face', selection = { kind: null, ids: [] }, tool = null;
    let pending = null, previewState = { key: null, status: 'idle', data: null, error: null, analysis: null }, previewTimer = null, previewPromise = null;
    let sliceDraft = null, cutDraft = null, passages = [], featureFilter = 'all', checkedFeatures = new Set();
    let sizing = { size: null, minCount: 1, edges: new Map(), faces: new Map(), solids: new Map() };
    let display = { color: 'status', xray: false, seeds: true, labels: true, groups: true, hidden: new Set(), hiddenSheets: new Set(), showResult: true };
    let meshSettings = { method: 'mapped', order: 1, scope: 'all', live: true, pidPerSolid: false };
    let legacy = { method: 'tet', size: null, layers: 4, sourceFace: '', targetFace: '', sweepAxis: 'z', layerCounts: {} };
    // Shell meshing of CAD faces: on the faces, at the midsurface of two sides, or offset.
    // pads: one ring of quads around each listed hole, inside a square (size and perSide null: the mesher's guess).
    let shell = { element: 'quad', mesher: 'recombined', placement: 'surface', scope: 'all', faces: [], facesB: [], size: null, perCircle: 12, offset: 0, thickness: 1, pidPerFace: false,
      pads: [], padSize: null, padSide: null };
    let meshPreview = null, meshError = null, meshTimer = null, committingMesh = false, report = null, auditHistory = [];
    // Meshes this CAD source added to the model, one per set of bodies: a hex or tet
    // mesh covers solids, a shell mesh faces. A new mesh replaces only those covering
    // any of the same ones, so meshes of different bodies stay side by side.
    // { id, kind, label, volumes, faces, all?, elements, properties, material, stale, inModel }
    let meshes = [], meshCounter = 0, removing = null, editingOwner = null, regionName = '';
    let partId = null;
    const meshesBySession = new Map();  // the lists of sessions switched away from in this page
    // CAD sessions open on the server (Sessions): resume one after a reload, or close one to free storage.
    let sessionsInfo = null, sessionsOpen = false, sessionsLoading = false, closing = null;
    let expanded = { blocked: false, groups: false, sums: false, history: true, solids: true, sheets: true, features: false };
    // Sheets (free faces standing for thin walls) come with the topology: { face, sheet, thickness, offset, label }.
    // The surface tool stays on after each surface; Extend takes sheet edges, then the face to reach.
    let surfaceDraft = { mode: 'two', place: 'mid', thickness: null, offset: 0, picked: [], busy: false };
    let extendDraft = { edges: [], busy: false }, sheetEdit = null, removingSheet = null;
    let treeFilter = 'all', treeShare = 0.42;
    try { const share = Number(localStorage.getItem('webmesh.cad.treeShare')); if (share > 0.15 && share < 0.85) treeShare = share; } catch { /* storage unavailable */ }
    let bound = false, tooltip = null, viewTools = null;
    // The Gmsh plugin is optional (/api/health reports it). Until the server answers it is assumed present;
    // when it is missing its choices are shown disabled, with the reason, not hidden.
    let plugins = { gmsh: { available: true } };
    const gmshReady = () => plugins.gmsh?.available !== false;
    const GMSH_MISSING = 'The Gmsh plugin is not installed. Install Gmsh and its Python bindings (python3 -m pip install gmsh), then restart python3 server.py. Mapped hexes and quad shells do not need it.';
    async function loadPlugins() {
      try {
        if (location.protocol === 'file:' || typeof fetch !== 'function') return;
        const response = await fetch('/api/health');
        if (!response.ok) return;
        const health = await response.json();
        if (health?.plugins?.gmsh) { plugins = health.plugins; if (!gmshReady() && meshSettings.method === 'gmsh' && !discrete()) meshSettings = { ...meshSettings, method: 'mapped' }; hooks.render?.(); }
      } catch { /* no service to ask: leave the choices as they are */ }
    }
    const autoState = { running: false, message: '', blends: false, holes: true, controller: null, stopping: false, review: null };

    /* ------------------------------------------------------------ server -- */
    async function api(path, payload) {
      if (location.protocol === 'file:') throw Error('Start python3 server.py and open http://127.0.0.1:8765 to work with CAD.');
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 110000);
      try {
        const response = await fetch('/api/cad/' + path, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await response.json();
        if (!response.ok || data.error) {
          // Full storage is resolved by closing sessions: show them.
          if (/under Sessions/.test(data.error || '') && path !== 'sessions') { sessionsOpen = true; refreshSessions().then(() => hooks.render()); }
          const unsupportedRestore=['restore','restore_finish'].includes(path)&&data.error==='Unknown API endpoint.';
          const error=Error(unsupportedRestore?'This server predates reliable project restore. Start the updated server on another port; keep this server running to preserve its CAD undo history.':data.error || 'CAD operation failed.');error.status=response.status;error.unsupportedRestore=unsupportedRestore;throw error;
        }
        return data;
      } catch (error) {
        if (error.name === 'AbortError') throw Error('The CAD operation timed out. Simplify the geometry or the operation.');
        if (error instanceof TypeError) throw Error('Cannot reach the local CAD service. Start python3 server.py.');
        throw error;
      } finally { clearTimeout(timer); }
    }
    const token = () => { if (!session) throw Error('Import CAD geometry first.'); return { cadId: session.cadId, revision: session.revision }; };
    const topology = () => session?.topology || null;
    const discrete = () => !!session?.topology?.discrete;
    const bounds = () => topology()?.bounds || [0, 0, 0, 1, 1, 1];
    const span = () => { const b = bounds(); return Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2], 1e-9); };
    const defaultSize = () => {
      const t = topology(); if (!t) return 1;
      const lengths = (t.edges || []).map(e => Number(e.length) || 0).filter(l => l > 0).sort((a, b) => a - b);
      const median = lengths.length ? lengths[Math.floor(lengths.length / 2)] : span() / 10;
      const raw = Math.min(span() / 12, median / 2);
      const p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
      return (m < 1.5 ? 1 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * p;
    };

    /* ---------------------------------------------------------- analysis -- */
    function analyse() {
      if (!session || discrete() || !H()) { analysis = recognized = geometry = intervals = null; return; }
      analysis = H().analyze(session.topology);
      recognized = F() ? F().recognize(session.topology) : null;
      geometry = H().createGeometry(session.topology, session.preview);
      solve();
    }
    function controlMap() {
      const map = new Map();
      for (const [edge, control] of sizing.edges) map.set(edge, { count: control.count, size: control.size });
      return map;
    }
    let localCache = null;
    function solve() {
      if (!analysis) { intervals = null; return; }
      const size = Number(sizing.size) > 0 ? Number(sizing.size) : defaultSize();
      intervals = H().solveIntervals(analysis, { size, minCount: sizing.minCount, controls: controlMap(), solidSizes: new Map([...sizing.solids].map(([id,c])=>[id,c.size])) });
    }
    function localPlan() {
      const L=window.WebMeshCadLocal,key=meshSettings.order+':'+meshSettings.pidPerSolid;
      if(!L||!analysis||!intervals||!editingOwner)return null;
      if(localCache?.ownerId===editingOwner&&localCache.analysis===analysis&&localCache.intervals===intervals&&localCache.key===key)return localCache.value;
      const state=engine().getProjectOwnership?.(),owner=state?.project.objects.find(o=>o.id===editingOwner);
      if(owner?.definition.generator!=='cad-mapped-v1'||owner.definition.pendingReplacement||owner.facts?.suspendedReason)return null;
      const source=state.project.objects.find(o=>o.id===owner.definition.source);
      const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
      const geometry=t=>canonical(['bounds','vertices','edges','faces','volumes','sheets'].map(k=>t?.[k]||[]));
      const value=geometry(source?.definition.topology)===geometry(topology())?{owner,objects:state.project.objects,...L.impact(analysis,owner.definition.settings,{sizing:{size:sizing.size,minCount:sizing.minCount,edges:[...sizing.edges].map(([id,c])=>({id,...c})),solids:[...sizing.solids].map(([id,c])=>({id,...c}))},mesh:meshSettings},owner.definition.targets,intervals)}:null;
      localCache={ownerId:editingOwner,analysis,intervals,key,value};return value;
    }
    const volumeStatus = id => {
      const v = analysis?.volumes.get(id);
      if (!v) return 'other';
      if (!v.mappable) return 'blocked';
      const edges = new Set();
      for (const side of Object.values(v.block.sides)) for (const f of side.faces) for (const chain of analysis.faces.get(f).chains) for (const item of chain) edges.add(item.edge);
      return intervals?.conflicts.some(c => (c.edges || []).some(e => edges.has(e))) ? 'conflict' : 'ok';
    };
    function remapControls(previous, next) {
      // Keep edge controls through preparation when an edge survives unchanged.
      if (!previous || !next || !sizing.edges.size) return 0;
      const key = (t, e) => { const pts = (e.vertices || []).map(v => (t.vertices || []).find(x => x.id === v)?.point).filter(Boolean); if (pts.length !== 2) return null; return pts.map(p => p.map(x => x.toFixed(5)).join(',')).sort().join('|') + '|' + Number(e.length).toFixed(5); };
      const lookup = new Map();
      for (const edge of next.edges || []) { const k = key(next, edge); if (k) lookup.set(k, edge.id); }
      const moved = new Map();
      for (const [id, control] of sizing.edges) {
        const edge = (previous.edges || []).find(e => e.id === id); const k = edge && key(previous, edge);
        if (k && lookup.has(k)) moved.set(lookup.get(k), control);
      }
      const lost = sizing.edges.size - moved.size;
      sizing.edges = moved; sizing.faces = new Map();
      return lost;
    }

    // Entity numbers are local to a BREP revision. Match geometry, not tags,
    // when keeping display choices after preparation, history or reopening.
    // Bounds may include tessellation tolerances that change after a reload;
    // analytic area/centroid/normal are independent of that display cache.
    const geometryKey = item => JSON.stringify([item.type, item.area ?? item.volume, ...(item.center || []), ...(item.normal || [])].map(v => typeof v === 'number' ? Number(v.toFixed(5)) : v));
    function visibilityGeometry(t) {
      const faces = new Map((t.faces || []).map(f => [f.id, geometryKey(f)]));
      const solids = new Map((t.volumes || []).map(v => [v.id, geometryKey(v) + '|' + (v.faces || []).map(id => faces.get(id)).sort().join('|')]));
      return { faces, solids };
    }
    function remapHidden(previous, next, hidden = display.hidden) {
      if (!previous || !next || !hidden.size) return new Set();
      const old = previous.volumes || [], keys = new Map(), exterior = new Map(), a = visibilityGeometry(previous), b = visibilityGeometry(next);
      for (const v of old) {
        const key = a.solids.get(v.id);
        if (!keys.has(key)) keys.set(key, []);
        keys.get(key).push(v.id);
      }
      for (const f of previous.faces || []) if (f.volumes?.length === 1) {
        const key = a.faces.get(f.id);
        if (!exterior.has(key)) exterior.set(key, new Set());
        exterior.get(key).add(f.volumes[0]);
      }
      return new Set((next.volumes || []).filter(v => {
        const exact = keys.get(b.solids.get(v.id));
        if (exact?.length === 1) return hidden.has(exact[0]);
        // Split/edited solids inherit surviving exterior faces. A merged
        // solid is hidden only if all identifiable contributors were hidden.
        const owners = new Set((v.faces || []).flatMap(id => [...(exterior.get(b.faces.get(id)) || [])]));
        return owners.size > 0 && [...owners].every(id => hidden.has(id));
      }).map(v => v.id));
    }

    /** Solids of the current pick: picked solids, or the solids owning picked faces. */
    function selectedSolids() {
      if (selection.kind === 'solid') return selection.ids.slice();
      if (selection.kind === 'face') return [...new Set(selection.ids.flatMap(f => session.topology.faces.find(x => x.id === f)?.volumes || []))];
      return [];
    }
    /** Undo, redo or go to a history step on the server; later steps stay available to redo. */
    async function moveHistory(kind, index) {
      if (!session) return;
      pending = null; clearPreview(); tool = null;
      const data = await api(kind, kind === 'revert' ? { ...token(), to: index } : token());
      accept(data, { fit: false, keepStep: true });
      markStale();
      hooks.render();
      const label = (data.history || [])[data.cursor]?.label;
      hooks.message(kind === 'undo' ? 'Undid the last geometry change.' : kind === 'redo' ? `Redid: ${label || 'change'}.` : `Went to step ${index}: ${label || 'change'}. Later steps can still be redone.`);
    }
    function historyActive() { return active && !!session && !discrete() && step !== 'mesh'; }
    /** One action at a time: forget the open tool, its draft and its pending change. */
    function closeTool() {
      pending = null; clearPreview();
      tool = null; cutDraft = null; sliceDraft = null; passages = []; checkedFeatures = new Set();
      updatePendingOverlay();
    }
    function canUndo() { return !!session && !discrete() && historyCursor() > 0; }
    function canRedo() { return !!session && !discrete() && historyCursor() + 1 < (session.history || []).length; }

    /* ------------------------------------------------------------ meshes -- */
    const meshOwner = m => `${session.cadId}#${m.id}`;
    function markStale(settingsOnly=false) { for (const m of meshes) if(!settingsOnly||!m.projectOwner||m.projectOwner===editingOwner)m.stale = true; }
    const freshMeshes = () => meshes.filter(m => !m.stale && m.inModel !== false);
    const covering = target => meshes.filter(m => m.all || (target.volumes?.length && (m.volumes || []).some(v => target.volumes.includes(v))) || (target.faces?.length && (m.faces || []).some(f => target.faces.includes(f))));
    const reviewMapped = volumes => hooks.reviewMappedMesh && !covering({ volumes }).some(m => !m.projectOwner && m.inModel !== false);
    function meshOwnership(m) {
      if (!m.projectOwner) return engine().getMeshOwner(meshOwner(m));
      const state = engine().getProjectOwnership(), root = state?.project.objects.find(o => o.id === m.projectOwner);
      if (!root) return { elements: [], properties: [] };
      return { elements: state.owners.filter(o => o.owner === root.id && o.card.family === 'elems').map(o => o.card.id), properties: root.definition.sections.map(s => s.pid), volumes: root.definition.generator==='cad-shell-v1'?[]:root.definition.targets, faces: root.definition.generator==='cad-shell-v1'?root.definition.targets:[] };
    }
    function ownedMatches(m) {
      const owned = meshOwnership(m), expected = new Set((m.elements || []).map(Number));
      const suspended=m.projectOwner&&engine().getProjectOwnership()?.project.objects.some(o=>o.id===m.projectOwner&&o.facts?.suspendedReason);
      m.inModel = owned.elements.length > 0||!!suspended;
      const matches = expected.size > 0 && expected.size === owned.elements.length && owned.elements.every(id => expected.has(Number(id)));
      if (m.projectOwner && m.inModel) Object.assign(m, owned);
      return matches;
    }
    /** Add a mesh of `target` (its solids or faces) to the model, replacing the meshes it covers in one undo step. */
    async function commitMesh(target, result, options, label) {
      const replaced = covering(target), keep = replaced[0];
      if (replaced.some(m => m.projectOwner && m.inModel !== false)) throw Error('This region has an editable mapped CAD mesh. Remove it or convert it to plain cards from its project owner before using another mesher.');
      const record = { id: keep?.id ?? ++meshCounter, kind: target.kind, label, volumes: target.volumes || [], faces: target.faces || [], stale: false, inModel: true };
      committingMesh = true;
      try { Object.assign(record, await hooks.appendMesh(result, source.name, { ...options, previousMesh: keep || null, ownerTag: meshOwner(record), replaceOwners: replaced.slice(1).map(meshOwner) })); }
      finally { committingMesh = false; }
      meshes = [...meshes.filter(m => !replaced.includes(m)), record];
      return record;
    }
    async function removeMesh(id) {
      const m = meshes.find(x => x.id === id); if (!m) return;
      if (m.projectOwner && m.inModel !== false) {
        await hooks.reviewRemoveMesh(m.projectOwner, () => { m.inModel = false; m.stale = true; hooks.render(); });
        return true;
      }
      committingMesh = true;
      try { if (m.inModel !== false) await hooks.removeMesh(meshOwner(m)); }
      finally { committingMesh = false; }
      meshes = meshes.filter(x => x !== m);
      if (!freshMeshes().length) { engine().setCadVisible(true); engine().setCadSelectionMode(active ? pick : 'none'); }
    }
    function meshesCard() {
      const rows = meshes.map(m => {
        const confirm = removing === m.id, gone = m.inModel === false;
        return `<div class="cad-session"><div class="cad-session-name"><strong title="${esc(m.label)}">${esc(m.label)}</strong><small>${gone ? (m.projectOwner ? 'Owner absent (undone, removed or converted)' : 'Not in the model (undone)') : `${(m.elements || []).length.toLocaleString()} elements${m.stale ? (m.projectOwner ? ((m.elements||[]).length?' · draft differs or needs review; committed mesh retained':' · suspended: remesh required') : ' · out of date: the geometry or sizing changed') : ''}`}</small></div>
          ${m.projectOwner&&!gone?btn('mesh-edit','Edit region',{cls:'ghost mini',data:{value:m.projectOwner}}):''}${m.stale && !gone ? chip(m.projectOwner ? 'Draft changed' : 'Out of date', 'warn') : ''}${btn('mesh-remove', gone ? 'Forget' : confirm ? 'Confirm remove' : 'Remove', { cls: `ghost mini${confirm ? ' danger' : ''}`, data: { value: m.id }, title: gone ? 'Drop it from this list' : 'Remove this mesh from the model' })}</div>`;
      }).join('');
      return `<section class="cad-card"><div class="cad-card-title">Mesh regions <small>${meshes.length}</small></div><label class="cad-field"><span>Mesh region name</span><input aria-label="Mesh region name" data-field="region-name" value="${esc(regionName)}" placeholder="Name this mesh region"></label><p class="cad-note">${editingOwner?'Editing the selected region. Other mesh regions stay committed.':'Creating a separate region from this CAD source. Unmeshed CAD remains reference geometry.'}</p>${meshes.length?btn('mesh-new','New mesh region',{cls:'ghost mini'}):''}${rows}
        <p class="cad-note">${meshes.some(m => m.projectOwner) ? 'Each region has its own sizing, section and mesh. Use Edit region to remesh one side; interfaces are rebuilt in the same review. Partition continuous solids before assigning different idealizations.' : 'Each set of bodies keeps its own mesh: a new mesh replaces only the one covering the same solids or faces.'}</p></section>`;
    }
    /* ------------------------------------------------------------ sheets -- */
    const sheetRecords = () => session?.topology?.sheets || [];
    const sheetOf = face => sheetRecords().find(r => r.face === Number(face));
    function sheetGroups() {
      const groups = new Map();
      for (const r of sheetRecords()) { if (!groups.has(r.sheet)) groups.set(r.sheet, { ...r, faces: [] }); groups.get(r.sheet).faces.push(r.face); }
      return [...groups.values()].sort((a, b) => a.sheet - b.sheet);
    }
    const sheetNote = s => `${s.thickness ? `T ${fmt(s.thickness, 4)}` : 'T not set'}${s.offset ? ` · ZOFFS ${fmt(s.offset, 4)}` : ''} · ${s.faces.length} face${s.faces.length === 1 ? '' : 's'}`;
    const hiddenSheetFaces = () => sheetRecords().filter(r => display.hiddenSheets.has(r.sheet)).map(r => r.face);
    /** Apply a sheet operation; the tool that made it stays open for the next. */
    async function applySheetOperation(operation, label) {
      hooks.message(`${label}…`);
      const data = await api('prepare', { ...token(), operation: { ...operation, label } });
      markStale();
      accept(data, { fit: false, keepStep: true });
      hooks.render(); hooks.log(label);
      hooks.message(`${label}. ${sheetGroups().length} sheet${sheetGroups().length === 1 ? '' : 's'} in the model.`);
    }
    function surfacePick(ids) {
      const d = surfaceDraft;
      if (d.busy || hooks.isBusy?.()) return;
      for (const id of ids) if (!d.picked.includes(id)) d.picked.push(id);
      const need = d.mode === 'two' ? 2 : 1;
      if (d.picked.length < need) { renderPart('cad-tool', toolCard); return; }
      const faces = d.picked.slice(0, need), offset = Number(d.offset) || 0;
      d.picked = [];
      const operation = need === 2 ? { kind: 'surface', faces, place: d.place } : { kind: 'surface', faces, offset, ...(Number(d.thickness) > 0 ? { thickness: Number(d.thickness) } : {}) };
      const label = need === 2 ? { mid: `Midsurface of faces ${faces[0]} and ${faces[1]}`, first: `Surface on face ${faces[0]}`, second: `Surface on face ${faces[1]}` }[d.place]
        : offset ? `Offset of face ${faces[0]} by ${fmt(offset, 4)}` : `Surface on face ${faces[0]}`;
      d.busy = true; renderPart('cad-tool', toolCard);
      hooks.run(async () => { try { await applySheetOperation(operation, label); } finally { d.busy = false; renderPart('cad-tool', toolCard); } });
    }
    function surfaceCard() {
      const d = surfaceDraft, two = d.mode === 'two';
      const status = d.busy ? 'Making the surface…' : two ? (d.picked.length ? `Face ${d.picked[0]} picked: now pick the face across the wall.` : 'Pick a face of the wall, then the face across it.') : 'Pick a face: the surface is made on it, moved by the offset.';
      return `<div class="cad-card"><div class="cad-card-title">Surface <small>stays on · Esc ends it</small></div>
        <div class="cad-row"><span class="cad-row-label">From</span>${seg('surface-mode', [['two', 'Two faces', '', 'A midsurface, or a surface on either face, with the thickness measured between them'], ['one', 'One face', '', 'A copy of one face, moved by an offset, with a thickness you enter']], d.mode, 'compact')}</div>
        ${two ? `<div class="cad-row"><span class="cad-row-label">Place</span>${seg('surface-place', [['mid', 'Midway'], ['first', 'On first'], ['second', 'On second']], d.place, 'compact')}</div>`
          : `<div class="cad-size-row">${numberField('surface-offset', 'Offset (+ out)', d.offset)}${numberField('surface-thickness', 'Thickness T', d.thickness ?? '', 'min="0" placeholder="unknown"')}</div>`}
        <p class="cad-note">${icon('target')} ${esc(status)}</p>
        <p class="cad-note">${two ? 'On first or On second puts the surface on that face; its elements get an offset (ZOFFS) to the middle of the wall.' : 'The wall is taken to run T into the material from the face; the elements get an offset (ZOFFS) to its middle. Offset 0 copies the face.'} Flat faces, cylinders and spheres.</p></div>`;
    }
    function extendPick() {
      const d = extendDraft;
      if (d.busy || hooks.isBusy?.()) return;
      if (selection.kind === 'edge') {
        const sheetFaces = new Set(sheetRecords().map(r => r.face));
        d.edges = selection.ids.filter(e => (session.topology.edges.find(x => x.id === e)?.faces || []).some(f => sheetFaces.has(f)));
        renderPart('cad-tool', toolCard); return;
      }
      if (selection.kind !== 'face' || !d.edges.length) return;
      const target = selection.ids[selection.ids.length - 1], edges = d.edges.slice();
      d.edges = []; d.busy = true; renderPart('cad-tool', toolCard);
      hooks.run(async () => {
        try { await applySheetOperation({ kind: 'extend', edges, target }, `Extended ${edges.length} sheet edge${edges.length === 1 ? '' : 's'} to face ${target}`); }
        finally { d.busy = false; setPick('edge'); renderPart('cad-tool', toolCard); }
      });
    }
    function extendCard() {
      const d = extendDraft;
      const status = d.busy ? 'Extending…' : d.edges.length ? `${d.edges.length} sheet edge${d.edges.length === 1 ? '' : 's'} picked: now pick the face to extend to.` : 'Pick straight edges of a flat sheet (Shift adds), then the face to extend them to.';
      return `<div class="cad-card"><div class="cad-card-title">Extend <small>stays on · Esc ends it</small></div>
        <p class="cad-note">${icon('target')} ${esc(status)}</p>
        <div class="cad-inline">${btn('extend-target', 'Pick the face', { cls: 'ghost small', disabled: !d.edges.length, title: 'Switch to face picking for the face the edges grow to' })}${btn('sheets-join', 'Join sheets', { cls: 'ghost small', iconName: 'join', title: 'Fuse the sheets where they meet, so every junction becomes an edge they share', disabled: sheetRecords().length < 2 })}</div>
        <p class="cad-note">Edges grow in their sheet's plane until they meet the face, a flat one for now. Join afterwards makes the junction an edge both sheets share.</p></div>`;
    }
    function sheetContext() {
      const ids = [...new Set(selection.ids.map(f => sheetOf(f)?.sheet))];
      const s = ids.length === 1 ? sheetGroups().find(g => g.sheet === ids[0]) : null;
      let html = `<div class="cad-ctx-head"><div><strong>${s ? esc(s.label) : `${ids.length} sheets`}</strong><small>${s ? `Sheet ${s.sheet} · ${sheetNote(s)}` : 'Pick one sheet to edit it'}</small></div>${btn('clear-selection', '', { cls: 'icon ghost', iconName: 'x', title: 'Clear selection (Esc)' })}</div>`;
      if (!s) return html;
      if (!sheetEdit || sheetEdit.sheet !== s.sheet) sheetEdit = { sheet: s.sheet, thickness: s.thickness, offset: s.offset, name: s.label };
      const confirm = removingSheet === s.sheet, part = selection.ids.length < s.faces.length;
      const flat = s.faces.map(f => session.topology.faces.find(x => x.id === f)?.surface).every(x => x?.kind === 'plane');
      html += `<div class="cad-size-row">${numberField('sheet-thickness', 'Thickness T', sheetEdit.thickness ?? '', 'min="0" placeholder="not set"')}${numberField('sheet-offset', 'Offset ZOFFS', sheetEdit.offset)}</div>
        <label class="cad-field"><span>Name</span><input data-field="sheet-name" type="text" value="${esc(sheetEdit.name)}"></label>
        <div class="cad-inline">${btn('sheet-apply', 'Apply', { cls: 'small', iconName: 'check' })}${btn('sheet-remove', confirm ? 'Confirm remove' : part ? `Remove ${selection.ids.length} picked face${selection.ids.length === 1 ? '' : 's'}` : 'Remove sheet', { cls: `ghost small${confirm ? ' danger' : ''}`, title: part ? 'Delete the picked faces of this sheet, such as an overhang a join split off (undo brings them back)' : 'Delete this sheet from the geometry (undo brings it back)' })}</div>
        ${flat && sheetRecords().length > s.faces.length ? `<div class="cad-inline">${btn('sheet-split', 'Split sheets along its plane', { cls: 'ghost small', title: 'Cut the other sheets this plane crosses, so their mesh follows where this sheet meets them (a brace on a floor)' })}</div>` : ''}
        <p class="cad-note">ZOFFS is the distance from the sheet to the middle of the wall, along the sheet's normal; shell elements carry it.</p>`;
      return html;
    }

    /** Saved meshes of a project (or its single mesh, from before meshes were per body). */
    function savedMeshes(data) {
      const ids = list => Array.isArray(list) ? list.filter(Number.isSafeInteger).slice(0, 2000000) : [];
      if (Array.isArray(data?.meshes)) return data.meshes.filter(m => m && Number.isSafeInteger(m.id) && m.id > 0 && Array.isArray(m.elements)).slice(0, 200)
        .map(m => ({ id: m.id, kind: typeof m.kind === 'string' ? m.kind.slice(0, 20) : 'mesh', label: typeof m.label === 'string' ? m.label.slice(0, 200) : 'Mesh', volumes: ids(m.volumes), faces: ids(m.faces),
          elements: ids(m.elements), properties: ids(m.properties), material: Number.isSafeInteger(m.material) ? m.material : undefined, stale: !!m.stale, ...(typeof m.projectOwner === 'string' ? { projectOwner: m.projectOwner } : {}) }));
      if (data?.mesh && Array.isArray(data.mesh.elements)) return [{ id: 1, kind: 'mesh', label: 'Mesh', all: true, volumes: [], faces: [], elements: ids(data.mesh.elements), properties: ids(data.mesh.properties), material: data.mesh.material, stale: !!data.mesh.stale }];
      return [];
    }

    /* ------------------------------------------------------------ accept -- */
    function accept(data, { fit = true, keepStep = false } = {}) {
      const previous = session?.topology;
      // Solid IDs may be renumbered by CAD preparation; retain controls only on
      // verified unchanged volumes, using the same geometry keys as visibility.
      if(previous&&session?.cadId===data.cadId&&sizing.solids.size){
        const a=visibilityGeometry(previous).solids,b=visibilityGeometry(data.topology).solids,kept=new Map();
        for(const [id,c] of sizing.solids){const hits=[...b].filter(([,key])=>key===a.get(id));if(hits.length===1)kept.set(hits[0][0],c);}
        sizing.solids=kept;
      }else sizing.solids=new Map();
      const lost = previous && session?.cadId === data.cadId ? remapControls(previous, data.topology) : (sizing.edges = new Map(), sizing.faces = new Map(), 0);
      display.hidden = session?.cadId === data.cadId ? remapHidden(previous, data.topology) : new Set();
      display.hiddenSheets = new Set([...display.hiddenSheets].filter(id => data.topology.sheets?.some(s => s.sheet === id)));
      session = data;
      if (discrete()) { step = 'mesh'; meshSettings.method = 'gmsh'; legacy.method = ['tet', 'tri'].includes(legacy.method) ? legacy.method : 'tet'; }
      else if (!keepStep) step = step === 'mesh' && meshSettings.method === 'gmsh' ? 'mesh' : step;
      if (!(Number(sizing.size) > 0)) sizing.size = defaultSize();
      if (!(Number(legacy.size) > 0)) legacy.size = sizing.size;
      selection = { kind: null, ids: [] }; pending = null; sliceDraft = null; cutDraft = null; tool = tool === 'slice' ? null : tool; clearPreview();
      checkedFeatures = new Set(); meshPreview = null; meshError = null; report = null;
      analyse();
      engine().setCadGeometry(data.preview, { name: source?.name || data.filename, cadId: data.cadId, revision: data.revision, fit, topology: data.topology });
      const vp = viewport();
      if (vp && data.topology?.edges) vp.setEdgeFaces(new Map(data.topology.edges.map(e => [e.id, e.faces || []])));
      engine().setCadSelectionMode(active ? pick : 'none');
      if (lost) hooks.message(`${lost} edge count control${lost === 1 ? ' was' : 's were'} removed: those edges changed with the geometry.`, true);
      updateDisplay();
      hooks.refresh();
    }
    async function refreshSessions() {
      if (sessionsLoading || location.protocol === 'file:') return;
      sessionsLoading = true;
      try { sessionsInfo = await api('sessions', {}); }
      catch { sessionsInfo = { sessions: [], bytes: 0, budget: 1, failed: true }; }
      finally { sessionsLoading = false; }
      if (active) { renderPart('cad-sessions', sessionsCard); if (session) hooks.render(); }
    }
    async function resumeSession(cadId) {
      hooks.message('Resuming the CAD session…');
      const data = await api('resume', { cadId });
      const original = data.original; delete data.original;
      const file = new File([fromBase64(original.content)], original.filename);
      if(hooks.addSessionPart){const retained=data.draft||{filename:file.name,content:original.content};const prepared=await api('export',{cadId:data.cadId,revision:data.revision,checkpoint:true});return hooks.addSessionPart(await thisWorkspace.stageRestore({...retained,editingOwner:null,meshes:[],prepared:{...prepared,history:retained.prepared?.history||[]}}));}
      if (session) meshesBySession.set(session.cadId, meshes);
      editingOwner = null; regionName = ''; source = file; meshes = meshesBySession.get(cadId) || []; auditHistory = []; step = 'prepare'; tool = null; session = null; sizing.size = null; legacy.size = null;
      display.hiddenSheets = new Set();
      sessionsOpen = false; closing = null;
      accept(data);
      for (const m of meshes) if (!ownedMatches(m)) m.stale = true;
      hooks.name(file.name.replace(/\.[^.]+$/, '')); hooks.render();
      hooks.log(`Resumed CAD ${file.name}`);
      hooks.message(`Resumed ${file.name} at ${data.cursor ? `“${data.history?.[data.cursor]?.label}” (${data.cursor} step${data.cursor === 1 ? '' : 's'})` : 'its import'}.`);
      refreshSessions();
    }
    function sessionsCard() {
      const info = sessionsInfo;
      if (!info) return sessionsLoading ? '<p class="cad-note">Looking for open CAD sessions…</p>' : '';
      if (info.failed) return session ? '<p class="cad-note warn">The CAD service did not list its sessions.</p>' : '';
      if (!info.sessions.length) return session ? '<p class="cad-note">No CAD sessions are open on the server.</p>' : '';
      const mib = bytes => fmt(bytes / 1048576, 3);
      const ago = time => { const s = Math.max(0, Date.now() / 1000 - time); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
      const rows = info.sessions.map(s => {
        const here = session?.cadId === s.cadId, confirm = closing === s.cadId;
        return `<div class="cad-session${here ? ' here' : ''}"><div class="cad-session-name"><strong title="${esc(s.filename)}">${esc(s.filename)}</strong><small title="${esc(s.label)}">${s.provisional?'Restoring · ':''}${s.steps} step${s.steps === 1 ? '' : 's'}${s.kept>s.steps+1?' · '+(s.kept-s.steps-1)+' redo':''}${s.hasDraft?' · draft retained':''}${s.steps ? ` · ${esc(s.label)}` : ''} · ${mib(s.bytes)} MiB · ${ago(s.lastUsed)}</small></div>
          ${here ? chip('Open here', 'ok') : btn('session-resume', 'Resume', { cls: 'ghost mini', data: { value: s.cadId }, title: 'Work in this session from its last step' })}${btn('session-close', confirm ? 'Confirm close' : 'Close', { cls: `ghost mini${confirm ? ' danger' : ''}`, data: { value: s.cadId }, title: 'Delete this session and its undo steps from the server' })}</div>`;
      }).join('');
      const share = info.bytes / info.budget;
      return `<div class="cad-card"><div class="cad-card-title">Sessions on this server <small>${info.sessions.length}/${info.capacity||24} · ${mib(info.bytes)} of ${mib(info.budget)} MiB</small></div>
        <div class="cad-meter${share > 0.9 ? ' bad' : share > 0.7 ? ' warn' : ''}"><i style="width:${Math.min(100, Math.round(100 * share))}%"></i></div>${rows}
        <p class="cad-note">Resume preserves retained draft settings and undo/redo. Unadopted restore candidates expire automatically; other sessions stay until you close them. Save a project before closing a retained session.</p></div>`;
    }
    async function importFile(file) {
      if(hooks.addPart)return hooks.addPart(file);
      if (file.size > 23 * 1024 * 1024) throw Error('Choose a CAD file smaller than 23 MB.');
      hooks.message(`Reading ${file.name}…`);
      const format = ({ stp: 'step', igs: 'iges' }[file.name.split('.').pop().toLowerCase()] || file.name.split('.').pop().toLowerCase());
      const data = await api('import', { filename: file.name, format, content: base64(await file.arrayBuffer()) });
      if (session) meshesBySession.set(session.cadId, meshes);
      source = file; meshes = []; editingOwner = null; regionName = ''; auditHistory = []; step = 'prepare'; tool = null; session = null; sizing.size = null; legacy.size = null;
      display.hiddenSheets = new Set();
      accept(data); hooks.name(file.name.replace(/\.[^.]+$/, '')); hooks.render();
      hooks.log(`Imported CAD ${file.name}`);
      if (sessionsOpen) refreshSessions();
      const s = analysis?.summary;
      hooks.message(`${file.name}: ${session.topology.volumes.length} solid${session.topology.volumes.length === 1 ? '' : 's'} · ${session.topology.faces.length} faces${s ? ` · ${s.mappable}/${s.volumes} ready for mapped hex` : ''}.`);
    }

    /* ----------------------------------------------------------- display -- */
    function faceColorMap() {
      const t = topology(); if (!t) return null;
      const map = new Map();
      const volumeColor = new Map();
      (t.volumes || []).forEach((v, i) => {
        if (display.color === 'solid') volumeColor.set(v.id, hueColor(i));
        else if (display.color === 'status' && analysis) volumeColor.set(v.id, STATUS_COLORS[volumeStatus(v.id)]);
      });
      const impact=step!=='prepare'?localPlan():null;
      if(impact?.affected.length){
        for(const id of impact.unchanged)volumeColor.set(id,0x587582);
        for(const id of impact.propagated)volumeColor.set(id,0xe8b04c);
        for(const id of impact.direct)volumeColor.set(id,0xe58a55);
      }
      const sheets = t.sheets || [];
      if (!volumeColor.size && !sheets.length) return null;
      for (const face of t.faces || []) {
        const owners = (face.volumes || []).filter(v => !display.hidden.has(v));
        if (owners.length && volumeColor.has(owners[0])) map.set(face.id, volumeColor.get(owners[0]));
      }
      for (const r of sheets) map.set(r.face, SHEET_COLOR);
      return map;
    }
    function midpoint(edge) { try { return geometry.curve(edge).pointAt(0.5); } catch { return null; } }
    function updateDisplay() {
      const vp = viewport(); if (!vp || !session) return;
      vp.setFaceColors(faceColorMap());
      vp.clearOverlays('remesh-impact');
      const plan=step==='size'?localPlan():null;
      if(plan?.affected.length)for(const [kind,color] of [['direct',0xe58a55],['propagated',0xe8b04c]]){
        const faces=[...new Set(plan[kind].filter(id=>!display.hidden.has(id)).flatMap(id=>topology().volumes.find(v=>v.id===id)?.faces.map(Math.abs)||[]))];
        if(faces.length)vp.setOverlay('remesh-impact-'+kind,{type:'faces',faces,color,opacity:0.75,depthTest:true,renderOrder:7});
      }
      vp.setXray(display.xray);
      vp.setHiddenVolumes([...display.hidden], hiddenSheetFaces());
      // Edge colors: equation groups while sizing, conflicts in red.
      let edgeColors = null;
      if (analysis && intervals && step !== 'prepare') {
        edgeColors = new Map();
        if (display.groups) intervals.groups.forEach(g => g.edges.forEach(e => edgeColors.set(e, GROUP_COLORS[g.index % GROUP_COLORS.length])));
        for (const c of intervals.conflicts) for (const e of c.edges || []) edgeColors.set(e, 0xff4d4d);
      } else if (analysis && step === 'prepare') {
        edgeColors = new Map();
        for (const v of analysis.volumes.values()) if (!v.mappable) for (const r of v.reasons) if (r.code === 'reentrant') for (const e of r.edges) edgeColors.set(e, ISSUE);
      }
      vp.setEdgeColors(edgeColors);
      updateIssueOverlay();
      updateSizingOverlays();
      updatePendingOverlay();
      updateMeshOverlay();
    }
    function updateIssueOverlay() {
      const vp = viewport(); if (!vp) return;
      vp.clearOverlays('issue');
      if (!analysis || step !== 'prepare') return;
      const solids = selection.kind === 'solid' ? selection.ids : [];
      const faces = new Set(), edges = new Set(), vertices = new Set();
      for (const id of solids) for (const r of analysis.volumes.get(id)?.reasons || []) {
        (r.faces || []).forEach(f => faces.add(f)); (r.edges || []).forEach(e => edges.add(e)); (r.vertices || []).forEach(v => vertices.add(v));
      }
      if (faces.size && faces.size < 40) vp.setOverlay('issue-faces', { type: 'faces', faces: [...faces], color: 0xffd400, opacity: 0.22 });
      const segs = [];
      for (const e of edges) { try { segs.push(...segmentsOf(e)); } catch { /* edge without a curve */ } }
      if (segs.length) vp.setOverlay('issue-edges', { type: 'lines', positions: segs, color: ISSUE, depthTest: false, renderOrder: 13 });
      const pts = [...vertices].map(v => analysis.index.vertices.get(v)).filter(Boolean).flat();
      if (pts.length) vp.setOverlay('issue-vertices', { type: 'points', positions: pts, color: ISSUE, size: 11, depthTest: false, renderOrder: 14 });
    }
    function segmentsOf(edge) {
      const points = geometry.curve(edge).points, out = [];
      for (let i = 1; i < points.length; i++) out.push(...points[i - 1], ...points[i]);
      return out;
    }
    function updateSizingOverlays() {
      const vp = viewport(); if (!vp) return;
      vp.clearOverlays('size');
      if (!intervals || !geometry || step === 'prepare' || (step === 'mesh' && meshSettings.method !== 'mapped')) return;
      if (display.seeds && !(step === 'mesh' && meshPreview)) {
        const positions = [], colors = [];
        for (const e of intervals.region.edges) {
          const n = intervals.counts.get(e); if (!(n > 1)) continue;
          let curve; try { curve = geometry.curve(e); } catch { continue; }
          const group = intervals.groups.find(g => g.edges.includes(e));
          const conflict = intervals.conflicts.some(c => (c.edges || []).includes(e));
          const c = rgb(conflict ? 0xff4d4d : display.groups && group ? GROUP_COLORS[group.index % GROUP_COLORS.length] : 0x5cd9bb);
          for (let k = 1; k < n; k++) { positions.push(...curve.pointAt(k / n)); colors.push(...c); }
        }
        if (positions.length) vp.setOverlay('size-seeds', { type: 'points', positions, colors, size: 6, renderOrder: 9 });
      }
      if (display.labels && step === 'size') {
        let edges = intervals.region.edges;
        if (edges.length > 260) {
          const focus = new Set(selection.kind === 'edge' ? selection.ids : []);
          const solids = selection.kind === 'solid' ? selection.ids : [];
          for (const s of solids) for (const side of Object.values(analysis.volumes.get(s)?.block?.sides || {})) for (const f of side.faces) for (const chain of analysis.faces.get(f).chains) chain.forEach(item => focus.add(item.edge));
          for (const c of intervals.conflicts) (c.edges || []).forEach(e => focus.add(e));
          edges = edges.filter(e => focus.has(e) || sizing.edges.has(e));
        }
        const labels = [];
        for (const e of edges) {
          const p = midpoint(e); if (!p) continue;
          const locked = intervals.locked.has(e), conflict = intervals.conflicts.some(c => (c.edges || []).includes(e));
          const selected = selection.kind === 'edge' && selection.ids.includes(e);
          const requested = intervals.locked.get(e), solved = intervals.counts.get(e);
          labels.push({ id: e, position: p, text: requested != null && requested !== solved ? `${requested}≠${solved}` : String(solved), title: `Edge ${e}${locked ? ' · fixed' : ''}`, className: [locked ? 'locked' : '', conflict ? 'conflict' : '', selected ? 'selected' : ''].join(' ') });
        }
        if (labels.length) vp.setOverlay('size-labels', { type: 'labels', labels, onClick: label => { setPick('edge'); setSelection('edge', [label.id], { additive: false }); } });
      }
    }
    function planeOverlay(planes, color = 0x3aa8e6) { return { type: 'planes', planes: planes.map(p => ({ ...p, color })) }; }
    function bboxCorners() { const b = bounds(), out = []; for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) out.push([x, y, z]); return out; }
    function rayCorners(ray) {
      // Display only: clip the half-plane to the model extent along its axis.
      const a = unit(ray.axis), d = unit(sub(ray.direction, a.map(v => v * dot(ray.direction, a))));
      const along = bboxCorners().map(c => dot(sub(c, ray.origin), a)), pad = span() * 0.04;
      const lo = Math.min(...along) - pad, hi = Math.max(...along) + pad;
      const s = ray.origin.map((v, i) => v + lo * a[i]), e = ray.origin.map((v, i) => v + hi * a[i]);
      return [s, e, e.map((v, i) => v + ray.length * d[i]), s.map((v, i) => v + ray.length * d[i])];
    }
    function planeCorners(plane) {
      // Axis-aligned planes follow the part's bounding box; others use a square.
      const n = unit(plane.normal), axis = [0, 1, 2].find(i => Math.abs(Math.abs(n[i]) - 1) < 1e-9);
      if (axis == null) return null;
      const b = bounds(), pad = span() * 0.06, [u, w] = [0, 1, 2].filter(i => i !== axis);
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sw]) => { const p = [0, 0, 0]; p[axis] = plane.origin[axis]; p[u] = su < 0 ? b[u] - pad : b[u + 3] + pad; p[w] = sw < 0 ? b[w] - pad : b[w + 3] + pad; return p; });
    }
    function sectionFor(planes) {
      const vp = viewport(); if (!vp) return [];
      const out = [];
      for (const p of planes) { const seg = vp.section(p.origin, unit(p.normal)); for (const v of seg) out.push(v); }
      return out;
    }
    function updatePendingOverlay() {
      const vp = viewport(); if (!vp) return;
      vp.clearOverlays('pending');
      vp.clearOverlays('result');
      setBaseVisible(true);
      if (!pending || step !== 'prepare') return;
      const op = pending.operation;
      if (op.kind === 'slice') {
        const planes = (op.planes || []).map(p => ({ origin: p.origin, normal: p.normal }));
        const quads = [...planes.map(p => { const corners = planeCorners(p); return corners ? { corners } : p; }), ...(op.rays || []).map(r => ({ corners: rayCorners(r) }))];
        if (quads.length) vp.setOverlay('pending-planes', planeOverlay(quads));
        const outline = sectionFor(planes);
        if (outline.length) vp.setOverlay('pending-section', { type: 'lines', positions: outline, color: 0xffd54a, depthTest: false, renderOrder: 14 });
        if (op.cylinders?.length) {
          const segs = [];
          for (const c of op.cylinders) {
            const a = unit(c.axis), helper = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
            const u = unit([a[1] * helper[2] - a[2] * helper[1], a[2] * helper[0] - a[0] * helper[2], a[0] * helper[1] - a[1] * helper[0]]);
            const w = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
            const ext = span() * 0.6;
            for (const t of [-ext, 0, ext]) for (let k = 0; k < 48; k++) {
              const p = q => c.origin.map((v, i) => v + a[i] * t + c.radius * (Math.cos(q) * u[i] + Math.sin(q) * w[i]));
              segs.push(...p(2 * Math.PI * k / 48), ...p(2 * Math.PI * (k + 1) / 48));
            }
          }
          vp.setOverlay('pending-cylinders', { type: 'lines', positions: segs, color: 0x3aa8e6, depthTest: false, renderOrder: 14 });
        }
        if (op.volumeIds?.length) vp.setOverlay('pending-scope', { type: 'faces', faces: op.volumeIds.flatMap(v => vp.volumeFaces(v)), color: 0x3aa8e6, opacity: 0.18 });
      } else if (op.kind === 'fuse') {
        vp.setOverlay('pending-faces', { type: 'faces', faces: op.volumeIds.flatMap(v => vp.volumeFaces(v)), color: 0x3aa8e6, opacity: 0.45, depthTest: false, renderOrder: 7 });
      } else if (op.kind === 'defeature') {
        vp.setOverlay('pending-faces', { type: 'faces', faces: op.faceIds, color: 0xff5c5c, opacity: 0.6, depthTest: false, renderOrder: 7 });
      } else if (op.kind === 'passages' || op.kind === 'passage') {
        if (op.faceIds?.length) vp.setOverlay('pending-faces', { type: 'faces', faces: op.faceIds, color: 0xff5c5c, opacity: 0.45, depthTest: false });
        const segs = [];
        for (const p of op.passages || []) {
          const axis = 'xyz'.indexOf(p.axis), others = [0, 1, 2].filter(i => i !== axis);
          const corner = (a, b, c) => { const q = [0, 0, 0]; q[axis] = p.range[c]; q[others[0]] = p.center[others[0]] + a * p.width / 2; q[others[1]] = p.center[others[1]] + b * p.height / 2; return q; };
          const ring = c => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => corner(a, b, c));
          const r0 = ring(0), r1 = ring(1);
          for (let k = 0; k < 4; k++) segs.push(...r0[k], ...r0[(k + 1) % 4], ...r1[k], ...r1[(k + 1) % 4], ...r0[k], ...r1[k]);
        }
        if (segs.length) vp.setOverlay('pending-passages', { type: 'lines', positions: segs, color: 0xffd54a, depthTest: false, renderOrder: 14 });
      } else if (op.kind === 'project') {
        vp.setOverlay('pending-faces', { type: 'faces', faces: op.faceIds || [], color: 0x3aa8e6, opacity: 0.5, depthTest: false });
        if (op.volumeIds?.length) vp.setOverlay('pending-scope', { type: 'faces', faces: op.volumeIds.flatMap(v => vp.volumeFaces(v)), color: 0x3aa8e6, opacity: 0.18 });
      }
      if (previewState.status === 'ready' && previewState.data && display.showResult) showResultPreview(previewState.data);
    }
    function setBaseVisible(value) {
      const vp = viewport(); if (!vp) return;
      vp.setBaseVisible?.(value);
    }
    function showResultPreview(data) {
      const vp = viewport(); if (!vp || !data?.preview) return;
      const t = data.topology, hidden = remapHidden(topology(), t);
      const hiddenFaces = new Set((t.faces || []).filter(f => f.volumes?.length && f.volumes.every(id => hidden.has(id))).map(f => f.id));
      for (const sheet of t.sheets || []) if (display.hiddenSheets.has(sheet.sheet)) hiddenFaces.add(sheet.face);
      const ids = [], pos = [];
      (data.preview.triangleFaceIds || []).forEach((face, i) => { if (!hiddenFaces.has(face)) { ids.push(face); pos.push(...data.preview.positions.slice(i * 9, i * 9 + 9)); } });
      const owner = new Map((t.faces || []).map(f => [f.id, (f.volumes || [])[0]]));
      const order = new Map((t.volumes || []).map((v, i) => [v.id, i]));
      const result = previewState.analysis;
      const colors = new Float32Array(pos.length);
      for (let tri = 0; tri < ids.length; tri++) {
        const v = owner.get(ids[tri]);
        const mapped = result?.volumes.get(v)?.mappable;
        // Status hue, varied per solid so every new piece is distinguishable.
        const index = order.get(v) || 0, status = rgb(result ? (mapped ? STATUS_COLORS.ok : STATUS_COLORS.blocked) : hueColor(index)), hue = rgb(hueColor(index));
        const shade = [1, 0.72, 0.88, 0.62][index % 4];
        const c = status.map((x, i) => (x * 0.7 + hue[i] * 0.3) * shade);
        for (let k = 0; k < 3; k++) { colors[tri * 9 + k * 3] = c[0]; colors[tri * 9 + k * 3 + 1] = c[1]; colors[tri * 9 + k * 3 + 2] = c[2]; }
      }
      const edges = [];
      const edgeFaces = new Map((t.edges || []).map(e => [e.id, e.faces || []]));
      for (const e of data.preview.edges || []) { if (edgeFaces.get(e.id)?.length && edgeFaces.get(e.id).every(f => hiddenFaces.has(f))) continue; const p = e.points; for (let i = 3; i < p.length; i += 3) edges.push(p[i - 3], p[i - 2], p[i - 1], p[i], p[i + 1], p[i + 2]); }
      vp.setOverlay('result', { type: 'mesh', positions: pos, colors, owners: ids, edges, edgeColor: 0x0f1a24, opacity: 1, renderOrder: 2 });
      setBaseVisible(false);
    }
    function updateMeshOverlay() {
      const vp = viewport(); if (!vp) return;
      vp.clearOverlays('mesh');
      if (step !== 'mesh' || !meshPreview) return;
      const { faces, edges, colors } = meshPreview.display;
      vp.setOverlay('mesh-preview', { type: 'mesh', positions: faces, colors, edges, edgeColor: 0x10202c, edgeOpacity: 0.9, renderOrder: 2 });
      setBaseVisible(false);
    }

    /* ---------------------------------------------------------- selection -- */
    function setPick(next) {
      pick = next;
      if (active && session) engine().setCadSelectionMode(pick);
      document.querySelectorAll('[data-act="pick"]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.value === pick)));
      updateViewTools();
    }
    function setSelection(kind, ids, { additive = false, quiet = false } = {}) {
      const list = [...new Set((ids || []).map(Number))];
      if (additive && selection.kind === kind) {
        const current = new Set(selection.ids);
        for (const id of list) current.has(id) ? current.delete(id) : current.add(id);
        selection = { kind, ids: [...current] };
      } else selection = { kind: list.length ? kind : null, ids: list };
      if (!quiet) {
        const map = { face: 'faces', edge: 'edges', vertex: 'vertices', solid: 'volumes' };
        const payload = { faces: [], edges: [], vertices: [], volumes: [] };
        if (selection.kind) payload[map[selection.kind]] = selection.ids;
        engine().selectCad(payload);
      }
      onSelectionChanged();
    }
    function onSelectionChanged() {
      // The surface and extend tools take each pick as it comes.
      if (tool === 'surface' && selection.kind === 'face' && selection.ids.length) surfacePick(selection.ids);
      if (tool === 'extend' && selection.ids.length) extendPick();
      if (tool === 'features') {
        if (selection.kind === 'face') for (const f of selection.ids) { const feat = recognized?.byFace.get(f); if (feat) checkedFeatures.add(feat.id); }
      }
      if (tool === 'project' && pending?.operation.kind === 'project' && selection.kind === 'face') { pending.operation.faceIds = selection.ids.slice(); schedulePreview(); }
      renderPart('cad-context', contextCard);
      if (step === 'size') { renderPart('cad-edge-editor', edgeEditor); updateSizingOverlays(); }
      // The shell card counts and uses the picked faces.
      if (step === 'mesh' && meshSettings.method === 'shell') renderPart('cad-shell', shellBody);
      if (step === 'prepare') { updateIssueOverlay(); if (tool === 'features') renderPart('cad-tool', toolCard); }
      document.querySelectorAll('[data-solid-row]').forEach(el => el.classList.toggle('selected', selection.kind === 'solid' && selection.ids.includes(Number(el.dataset.solidRow))));
      if (step === 'mesh' && meshSettings.scope === 'selected') { invalidateMesh(); scheduleMesh(); }
    }

    /* ------------------------------------------------------------- render -- */
    const chip = (text, tone = '') => `<span class="cad-chip ${tone}">${text}</span>`;
    const btn = (act, label, { cls = '', data = {}, title = '', disabled = false, iconName = '' } = {}) =>
      `<button type="button" class="cad-btn ${cls}" data-act="${act}" ${Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ')} ${title ? `title="${esc(title)}"` : ''} ${disabled ? 'disabled' : ''}>${iconName ? icon(iconName) : ''}${label}</button>`;
    const seg = (act, options, value, extra = '') => `<div class="cad-seg ${extra}" role="group">${options.map(([v, label, iconName, title, off]) => `<button type="button" data-act="${act}" data-value="${esc(v)}" aria-pressed="${String(v) === String(value)}" ${title ? `title="${esc(title)}"` : ''} ${off ? 'disabled' : ''}>${iconName ? icon(iconName) : ''}<span>${label}</span></button>`).join('')}</div>`;
    const numberField = (field, label, value, attrs = '') => `<label class="cad-field"><span>${label}</span><input data-field="${field}" type="number" step="any" value="${esc(value)}" ${attrs}></label>`;
    function renderPart(id, fn) {
      const el = document.getElementById(id);
      if (!el) return;
      if (window.WebMeshDom) window.WebMeshDom.morph(el, fn());
      else el.innerHTML = fn();
    }

    function clearAll() {
      clearTimeout(meshTimer);clearTimeout(previewTimer);
      step='prepare';pick='face';tool=null;sliceDraft=cutDraft=null;passages=[];checkedFeatures=new Set();
      surfaceDraft={mode:'two',place:'mid',thickness:null,offset:0,picked:[],busy:false};extendDraft={edges:[],busy:false};sheetEdit=removingSheet=null;
      meshSettings={method:'mapped',order:1,scope:'all',live:true,pidPerSolid:false};
      shell={element:'quad',mesher:'recombined',placement:'surface',scope:'all',faces:[],facesB:[],size:null,perCircle:12,offset:0,thickness:1,pidPerFace:false,pads:[],padSize:null,padSide:null};
      legacy={method:'tet',size:null,layers:4,sourceFace:'',targetFace:'',sweepAxis:'z',layerCounts:{}};
      display={color:'status',xray:false,seeds:true,labels:true,groups:true,hidden:new Set(),hiddenSheets:new Set(),showResult:true};
      source = null; session = null; editingOwner = null; regionName = ''; selection = { kind: null, ids: [] }; report = null; meshes = []; auditHistory = []; pending = null; clearPreview();
      analysis = recognized = geometry = intervals = null; meshPreview = null; sizing = { size: null, minCount: 1, edges: new Map(), faces: new Map(), solids: new Map() };
      engine()?.clearCadGeometry?.(); updateViewTools();
    }

    function render() {
      if (!session) {
        const body = `<div class="cad-wb">
          <div class="cad-empty">
            <div class="cad-empty-art">${icon('solid')}</div>
            <h3>Import CAD to start hex meshing</h3>
            <p>STEP · IGES · BREP · STL. Geometry appears immediately with every solid checked for mapped hex meshing.</p>
            ${btn('import', 'Import CAD…', { cls: 'primary wide', iconName: 'file' })}
            <section id="cad-sessions">${sessionsCard()}</section>
            <ol class="cad-howto"><li><b>Prepare</b> — slice solids into blocks and remove features. Click geometry; the tool suggests the fix.</li><li><b>Size</b> — set element size; edge counts are solved so every block conforms.</li><li><b>Mesh</b> — preview native HEX8/HEX20 with quality, then add to the model.</li></ol>
          </div><div id="wb-report"></div></div>`;
        return { body, foot: '', ready: false };
      }
      const t = session.topology, s = analysis?.summary;
      const conflicts = intervals?.conflicts.length || 0;
      const stepStatus = {
        prepare: discrete() ? chip('STL', 'muted') : s ? (s.blocked ? chip(`${s.blocked} to fix`, 'warn') : chip('All blocks', 'ok')) : '',
        size: discrete() ? '' : conflicts ? chip(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`, 'bad') : intervals?.region.volumes.length ? chip('Solved', 'ok') : chip('—', 'muted'),
        mesh: freshMeshes().length ? chip(freshMeshes().length > 1 ? `${freshMeshes().length} in model` : 'In model', 'ok') : meshPreview ? chip('Preview', 'info') : ''
      };
      const cursor = historyCursor(), states = session.history || [];
      const undoLabel = cursor > 0 ? states[cursor]?.label : '', redoLabel = cursor + 1 < states.length ? states[cursor + 1]?.label : '';
      let body = `<div class="cad-wb cad-layout">
        <div class="cad-top">
        <section class="cad-file">
          <div class="cad-file-row">${icon('file')}<div class="cad-file-name"><strong title="${esc(source?.name)}">${esc(source?.name || session.filename)}</strong><small>${t.volumes.length} solid${t.volumes.length === 1 ? '' : 's'} · ${t.faces.length} faces · ${t.edges.length} edges</small></div>
          ${btn('undo', '', { cls: 'icon ghost', iconName: 'undo', title: undoLabel ? `Undo: ${undoLabel} (Ctrl+Z)` : 'Nothing to undo', disabled: !undoLabel })}${btn('redo', '', { cls: 'icon ghost', iconName: 'redo', title: redoLabel ? `Redo: ${redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo', disabled: !redoLabel })}${btn('import', hooks.addPart?'Add part…':'Replace', { cls: 'ghost small' })}</div>
          <div class="cad-file-sessions"><button type="button" class="cad-link" data-act="sessions" title="CAD sessions open on the server: resume or close them">${sessionsOpen ? 'Hide sessions' : 'Sessions'}</button>${sessionsInfo && !sessionsInfo.failed ? `<small>${sessionsInfo.sessions.length} open · ${fmt(sessionsInfo.bytes / 1048576, 3)} of ${fmt(sessionsInfo.budget / 1048576, 3)} MiB</small>` : ''}</div>
        </section>
        ${sessionsOpen ? `<section id="cad-sessions">${sessionsCard()}</section>` : ''}
        <nav class="cad-steps" role="tablist">${[['prepare', '1', 'Prepare'], ['size', '2', 'Size'], ['mesh', '3', 'Mesh']].map(([key, n, label]) =>
          `<button role="tab" data-act="step" data-value="${key}" aria-selected="${step === key}" ${discrete() && key !== 'mesh' ? 'disabled' : ''}><span class="n">${n}</span><span class="l">${label}</span>${stepStatus[key] || ''}</button>`).join('')}</nav>
        ${discrete() ? '' : `<div class="cad-pickbar"><span>Pick</span>${seg('pick', [['auto', 'Auto', 'target', 'Nearest point, edge or face (0)'], ['solid', 'Solid', 'solid', 'Pick solids (1)'], ['face', 'Face', 'face', 'Pick faces (2)'], ['edge', 'Edge', 'edge', 'Pick edges (3)'], ['vertex', 'Point', 'vertex', 'Pick vertices (4)']], pick, 'pick')}</div>`}
        </div>
        <div class="cad-split" style="--tree-share:${treeShare}">
          <section id="cad-tree" class="cad-tree" aria-label="Model tree">${treeHtml()}</section>
          <div class="cad-resize" data-resize="tree" role="separator" aria-orientation="horizontal" title="Drag to resize"></div>
          <section id="cad-inspector" class="cad-inspector">`;
      if (!discrete()) body += `<section id="cad-context" class="cad-context">${contextCard()}</section>`;
      if (step === 'prepare') body += prepareBody();
      else if (step === 'size') body += sizeBody();
      else body += meshBody();
      body += '<div id="wb-report"></div></section></div></div>';
      return { body, foot: footer(), ready: true };
    }

    function footer() {
      if (!session) return '';
      if (step === 'prepare') {
        if (pending) {
          const ready = previewState.status === 'ready' && previewState.key === opKey(pending.operation);
          return `<div class="cad-foot-row">${btn('cancel-pending', 'Cancel', { cls: 'ghost' })}${btn('apply-pending', ready ? 'Apply' : 'Apply now', { cls: 'primary', iconName: 'check' })}</div>`;
        }
        return `<div class="cad-foot-row">${btn('step', 'Next: Size', { cls: 'primary', data: { value: 'size' }, iconName: 'arrow' })}</div>`;
      }
      if (step === 'size') return `<div class="cad-foot-row">${btn('step', 'Back', { cls: 'ghost', data: { value: 'prepare' } })}${localPlan()?.affected.length&&!localPlan().all?btn('remesh-affected','Preview '+localPlan().affected.length+' affected solids',{cls:'primary',iconName:'arrow',disabled:!!intervals?.conflicts.length}):btn('step', 'Next: Mesh', { cls: 'primary', data: { value: 'mesh' }, iconName: 'arrow' })}</div>`;
      if (meshSettings.method === 'gmsh' || discrete()) return `<div class="cad-foot-row">${btn('gmsh-mesh', 'Generate with Gmsh', { cls: 'primary', iconName: 'mesh', disabled: !gmshReady(), title: gmshReady() ? '' : GMSH_MISSING })}</div>`;
      if (meshSettings.method === 'shell') return `<div class="cad-foot-row">${btn('shell-mesh', hooks.reviewMappedMesh?'Review shell mesh':covering({ faces: shellTarget() }).length ? 'Replace shell mesh' : 'Generate shell mesh', { cls: 'primary', iconName: 'shell', disabled: shell.element === 'tri' && !gmshReady(), title: shell.element === 'tri' && !gmshReady() ? GMSH_MISSING : '' })}</div>`;
      return `<div class="cad-foot-row">${btn('mesh-preview', meshPreview ? 'Refresh' : 'Preview', { cls: 'ghost', iconName: 'eye' })}${btn('mesh-add', reviewMapped(mappedTarget()) ? 'Review mesh changes' : covering({ volumes: mappedTarget() }).length ? 'Replace in model' : 'Add to model', { cls: 'primary', iconName: 'check', disabled: !!intervals?.conflicts.length })}</div>`;
    }

    /* ----------------------------------------------------- context (infer) -- */
    function contextCard() {
      if (!session || discrete()) return '';
      if (!selection.ids.length) {
        if (pending && !tool && step === 'prepare') return pendingCard();
        const hint = { auto: 'Click near a point, edge or face: the smallest one under the pointer is picked. Shift adds.', solid: 'Click a solid to see whether it is a mapped block and how to fix it. Shift-pick neighbors to fuse them.', face: 'Click a face: holes, fillets and planes get matching tools.', edge: step === 'size' ? 'Click edges to set their element counts. Shift adds to the selection.' : 'Click edges to cut along them, or one to slice across it.', vertex: 'Click a vertex to slice through it; Shift-pick a second to cut between them.' }[pick];
        return `<div class="cad-hint">${icon('target')}<span>${hint}<br><small>Shift/Ctrl adds · Esc clears · 1–4 switch pick type</small></span></div>`;
      }
      if (selection.kind === 'face' && selection.ids.every(f => sheetOf(f)) && !['surface', 'extend'].includes(tool)) return sheetContext();
      const info = F() && analysis ? F().infer(session.topology, recognized, analysis, selection) : null;
      if (!info) return '';
      let html = pending && !tool && step === 'prepare' ? pendingCard() : '';
      html += `<div class="cad-ctx-head"><div><strong>${esc(info.title)}</strong><small>${esc(info.subtitle)}</small></div>${btn('clear-selection', '', { cls: 'icon ghost', iconName: 'x', title: 'Clear selection (Esc)' })}</div>`;
      if (info.facts.length) html += `<dl class="cad-facts">${info.facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
      if (selection.kind === 'solid' && selection.ids.length === 1 && analysis) {
        const v = analysis.volumes.get(selection.ids[0]);
        if (v && !v.mappable) html += `<ul class="cad-reasons">${v.reasons.slice(0, 3).map(r => `<li>${icon('warn')}<span>${esc(r.message)}</span></li>`).join('')}${v.reasons.length > 3 ? `<li class="more">+${v.reasons.length - 3} more · yellow marks show them in the view</li>` : ''}</ul>`;
        else if (v?.mappable) {
          const dims = blockDims(v);
          html += `<div class="cad-ok-line">${icon('check')} Mapped block${dims ? ` · ${dims.join(' × ')} elements` : ''}</div>`;
          if (v.warnings?.length) html += `<ul class="cad-reasons warn">${v.warnings.map(w => `<li>${icon('warn')}<span>${esc(w.message)}</span></li>`).join('')}</ul>`;
        }
        html += `<div class="cad-inline">${btn('isolate', 'Isolate', { cls: 'ghost small', iconName: 'eye', title: 'Hide all other solids (H)' })}${btn('hide-selected', 'Hide', { cls: 'ghost small', iconName: 'hide' })}${display.hidden.size ? btn('show-all', 'Show all', { cls: 'ghost small' }) : ''}</div>`;
      }
      let actions = step === 'prepare' ? info.actions : [];
      if (tool === 'cut' && cutDraft?.segments.length && actions.some(a => a.tool === 'cut')) {
        // While a cut is being drawn, picks extend it.
        actions = [...actions.filter(a => a.tool === 'cut').map(a => ({ ...a, label: 'Add to cut', primary: true })), ...actions.filter(a => a.tool !== 'cut').map(a => ({ ...a, primary: false }))];
      }
      if (actions.length) {
        const shown = expanded.actions ? actions.slice(0, 24) : actions.slice(0, 6);
        html += `<div class="cad-actions">${shown.map((a, i) => `<button type="button" class="cad-action ${a.primary ? 'primary' : ''}" data-act="infer" data-index="${i}"><strong>${esc(a.label)}</strong><small>${esc(a.detail || '')}</small></button>`).join('')}</div>`;
        if (actions.length > 6) html += `<button type="button" class="cad-link" data-act="expand" data-value="actions">${expanded.actions ? 'Show fewer' : `Show ${Math.min(actions.length, 24) - 6} more`}</button>`;
        lastActions = actions;
      } else lastActions = [];
      if (step === 'size' && selection.kind !== 'edge') html += `<p class="cad-note">Switch to edge picking to set counts.</p>`;
      return html;
    }
    let lastActions = [];
    function blockDims(volume) {
      if (!intervals || !volume?.block) return null;
      const b = volume.block, c = b.corners;
      return [['000', '100'], ['000', '010'], ['000', '001']].map(([p, q]) => {
        const edge = b.logicalEdges.find(e => e.corners.includes(c[p]) && e.corners.includes(c[q]));
        return edge ? edge.edges.reduce((s, e) => s + (intervals.counts.get(e) || 0), 0) : '?';
      });
    }

    /* ------------------------------------------------------------ prepare -- */
    function prepareBody() {
      let html = readinessCard();
      html += `<section class="cad-card"><div class="cad-card-title">Geometry tools</div><div class="cad-tools">${[
        ['slice', 'Slice', 'slice', 'Split solids with a plane'], ['cut', 'Cut', 'cut', 'Bounded cuts along edges or between vertices'], ['features', 'Features', 'features', 'Holes, fillets, chamfers'], ['passages', 'Passage', 'passage', 'Square through passages'],
        ['project', 'Project', 'project', 'Partition by face outlines'], ['heal', 'Heal', 'heal', 'Sew and repair'],
        ['surface', 'Surface', 'sheet', 'Midsurface or offset surface from picked faces; stays on for the next'], ['extend', 'Extend', 'extend', 'Extend sheet edges to a face, and join sheets']].map(([key, label, iconName, title]) =>
        `<button type="button" class="cad-tool ${tool === key ? 'active' : ''}" data-act="tool" data-value="${key}" title="${title}">${icon(iconName)}<span>${label}</span></button>`).join('')}</div></section>`;
      html += `<section id="cad-tool">${toolCard()}</section>`;
      return html;
    }

    /* ---------------------------------------------------------- model tree -- */
    function historyCursor() {
      const states = session?.history || [];
      return Number.isInteger(session?.cursor) ? session.cursor : states.length - 1;
    }
    function treeGroup(key, title, count, inner, tools = '') {
      return `<details class="cad-tree-group" data-expand="${key}" ${expanded[key] !== false ? 'open' : ''}><summary><span>${title}</span><small>${count}</small>${tools}</summary>${inner}</details>`;
    }
    function treeHtml() {
      if (!session) return '';
      const vols = session.topology.volumes;
      const impact=step!=='prepare'?localPlan():null;
      const stateOf = id => {
        const v = analysis?.volumes.get(id);
        if (!v) return ['other', ''];
        if (!v.mappable) return ['bad', shortReason(v)];
        if (intervals?.conflicts.some(c => (c.volumes || []).includes(id))) return ['warn', 'count conflict'];
        const dims = blockDims(v);
        return [impact?.affected.includes(id)?'warn':v.warnings?.length?'taper':'ok', (dims?dims.join(' × '):'mapped block')+(impact?.affected.includes(id)?(impact.propagated.includes(id)?' · dependent remesh':' · remesh'):'')];
      };
      const list = treeFilter === 'blocked' ? vols.filter(v => !analysis?.volumes.get(v.id)?.mappable) : vols;
      const rows = list.map(v => {
        const [tone, note] = stateOf(v.id), hidden = display.hidden.has(v.id);
        const picked = selection.kind === 'solid' && selection.ids.includes(v.id);
        return `<div class="cad-tree-row ${picked ? 'selected' : ''} ${hidden ? 'hidden' : ''}" data-solid-row="${v.id}">
          <button type="button" class="cad-tree-main" data-act="select-solid" data-id="${v.id}" title="Select solid ${v.id} (Shift adds)"><i class="dot ${tone}"></i><strong>Solid ${v.id}</strong><span>${esc(note)}</span></button>
          <button type="button" class="cad-eye" data-act="toggle-visible" data-id="${v.id}" aria-pressed="${!hidden}" title="${hidden ? 'Show' : 'Hide'} solid ${v.id} (H)">${icon(hidden ? 'hide' : 'eye')}</button></div>`;
      }).join('');
      const blocked = vols.filter(v => !analysis?.volumes.get(v.id)?.mappable).length;
      const solidTools = `<span class="cad-tree-tools">${seg('tree-filter', [['all', 'All'], ['blocked', `Red ${blocked}`]], treeFilter, 'compact mini')}${display.hidden.size ? btn('show-all', `Show ${display.hidden.size}`, { cls: 'ghost mini', title: 'Show hidden solids (Shift+H)' }) : ''}</span>`;
      let html = vols.length || !sheetRecords().length ? treeGroup('solids', 'Solids', `${vols.length - blocked}/${vols.length} mapped`, `<div class="cad-tree-list">${rows || '<p class="cad-note">No solids need work.</p>'}</div>`, solidTools) : '';
      const sheets = sheetGroups();
      if (sheets.length) {
        const sheetRows = sheets.map(s => {
          const hidden = display.hiddenSheets.has(s.sheet), picked = selection.kind === 'face' && s.faces.every(f => selection.ids.includes(f));
          return `<div class="cad-tree-row ${picked ? 'selected' : ''} ${hidden ? 'hidden' : ''}"><button type="button" class="cad-tree-main" data-act="select-sheet" data-id="${s.sheet}" title="Select its faces"><i class="dot sheet"></i><strong>${esc(s.label)}</strong><span>${esc(sheetNote(s))}</span></button>
            <button type="button" class="cad-eye" data-act="toggle-sheet" data-id="${s.sheet}" aria-pressed="${!hidden}" title="${hidden ? 'Show' : 'Hide'} this sheet">${icon(hidden ? 'hide' : 'eye')}</button></div>`;
        }).join('');
        const tools = `<span class="cad-tree-tools">${btn('sheets-join', 'Join', { cls: 'ghost mini', title: 'Fuse the sheets where they meet, so every junction becomes an edge they share', disabled: sheetRecords().length < 2 })}</span>`;
        html += treeGroup('sheets', 'Sheets', `${sheets.length}`, `<div class="cad-tree-list">${sheetRows}</div>`, tools);
      }
      const features = recognized?.features || [];
      if (features.length) {
        html += treeGroup('features', 'Features', features.length, `<div class="cad-tree-list">${features.map(f => `<div class="cad-tree-row" data-hover-faces="${f.faces.join(',')}"><button type="button" class="cad-tree-main" data-act="feature-locate" data-id="${f.id}" title="Select its faces"><i class="kind ${f.kind}"></i><strong>${esc(f.label)}</strong><span>${f.faces.length} face${f.faces.length === 1 ? '' : 's'}</span></button></div>`).join('')}</div>`);
      }
      const states = session.history || [], cursor = historyCursor();
      const saved = auditHistory.map(item => `<li class="saved"><span>${esc(item.label || item)}</span></li>`).join('');
      const steps = states.map((item, i) => {
        const where = i === cursor ? 'current' : i > cursor ? 'undone' : '';
        const action = i === cursor ? '<small>current</small>' : `<button type="button" class="cad-history-go" data-act="history-go" data-index="${i}" title="${i < cursor ? 'Go back to this step; later steps stay available to redo' : 'Redo up to this step'}">${icon(i < cursor ? 'undo' : 'redo')}${i < cursor ? 'Back here' : 'Redo to here'}</button>`;
        return `<li class="${where}"><span class="n">${i}</span><span class="cad-history-label" title="${esc(item.label || item.operation?.kind || '')}">${esc(item.label || item.operation?.kind || 'Change')}</span>${action}</li>`;
      }).reverse().join('');
      html += treeGroup('history', 'History', `${cursor} change${cursor === 1 ? '' : 's'}${states.length - 1 > cursor ? ` · ${states.length - 1 - cursor} undone` : ''}`, `<ol class="cad-history-list">${steps}${saved}</ol>`);
      return html;
    }
    function readinessCard() {
      if (!analysis) return '';
      if (!session.topology.volumes.length) return `<section class="cad-card"><div class="cad-card-title">Surfaces only</div><p class="cad-note">This model has no solids: mesh its sheets with Mesh → Shell.</p></section>`;
      const s = analysis.summary, pct = s.volumes ? Math.round(100 * s.mappable / s.volumes) : 0;
      const blocked = [...analysis.volumes.values()].filter(v => !v.mappable);
      let html = `<section class="cad-card cad-ready"><div class="cad-card-title">Mapped-mesh readiness <small>${s.mappable}/${s.volumes} solids</small></div>
        <div class="cad-meter"><i style="width:${pct}%"></i></div>`;
      const review = autoReview();
      if (!blocked.length) {
        html += review || `<p class="cad-good">${icon('check')} Every solid is a mapped block. Continue to sizing.</p>`;
      }
      else {
        html += review || autoFixControls();
        const shown = expanded.blocked ? blocked : blocked.slice(0, 4);
        html += `<div class="cad-solid-list">${shown.map(v => `<button type="button" class="cad-solid-row ${selection.kind === 'solid' && selection.ids.includes(v.id) ? 'selected' : ''}" data-act="select-solid" data-id="${v.id}" data-solid-row="${v.id}"><i class="dot bad"></i><strong>Solid ${v.id}</strong><span>${esc(shortReason(v))}</span></button>`).join('')}</div>`;
        if (blocked.length > 4) html += `<button type="button" class="cad-link" data-act="expand" data-value="blocked">${expanded.blocked ? 'Show fewer' : `Show all ${blocked.length}`}</button>`;
      }
      const tapered = [...analysis.volumes.values()].filter(v => v.mappable && v.warnings?.some(w => w.code === 'taper'));
      if (tapered.length) html += `<p class="cad-note warn">${icon('warn')} ${tapered.length} block${tapered.length === 1 ? ' is' : 's are'} strongly tapered and will give poor elements: ${tapered.slice(0, 4).map(v => `<button type="button" class="cad-link inline" data-act="select-solid" data-id="${v.id}">solid ${v.id}</button>`).join(', ')}${tapered.length > 4 ? '…' : ''}</p>`;
      const tangent = [...analysis.volumes.values()].filter(v => v.mappable && v.warnings?.some(w => w.code === 'curved-tangency'));
      if (tangent.length) html += `<p class="cad-note warn">${icon('warn')} ${tangent.length} curved block${tangent.length === 1 ? ' has' : 's have'} tangent corners. Check mesh quality after sizing; finer curve divisions can reduce the Jacobian. ${tangent.slice(0, 4).map(v => `<button type="button" class="cad-link inline" data-act="select-solid" data-id="${v.id}">Solid ${v.id}</button>`).join(', ')}${tangent.length > 4 ? '…' : ''}</p>`;
      html += `<div class="cad-legend"><span><i class="dot ok"></i>Mappable</span><span><i class="dot bad"></i>Needs work</span><span><i class="dot warn"></i>Count conflict</span></div></section>`;
      return html;
    }
    function autoFixControls() {
      if (autoState.running) {
        return `<div class="cad-auto running"><div class="cad-auto-row"><span class="cad-spin"></span><span class="cad-auto-status">${esc(autoState.stopping ? 'Stopping… the step being applied finishes first.' : autoState.message || 'Auto-fix running…')}</span>
          ${btn('auto-stop', autoState.stopping ? 'Stopping' : 'Stop', { cls: 'ghost small', iconName: 'stop', title: 'Stop after the current step; every step applied so far stays for you to keep or discard', disabled: autoState.stopping })}</div></div>`;
      }
      return `<div class="cad-auto"><div class="cad-auto-row">${btn('auto-fix', 'Auto-fix', { cls: 'small', iconName: 'spark', title: 'Repeatedly apply the best cut that makes more solids mappable. It only cuts: remove features yourself first, or allow small fillets and chamfers below' })}
        <label title="Off: Auto-fix only cuts, and every feature stays. On: it may also remove fillets and chamfers no wider than 1.5 elements"><input type="checkbox" data-field="auto-blends" ${autoState.blends ? 'checked' : ''}> Remove small fillets & chamfers</label>
        <label title="Cut around through holes so they stay in the mesh"><input type="checkbox" data-field="auto-holes" ${autoState.holes ? 'checked' : ''}> Split around holes</label></div>
        ${autoState.message && autoState.revision === session.revision ? `<p class="cad-note">${esc(autoState.message)}</p>` : ''}</div>`;
    }
    /** The changes of the last Auto-fix run, waiting for the user to keep or discard them. */
    function autoReview() {
      const r = autoState.review;
      if (!r || autoState.revision !== session.revision || autoState.running) return '';
      const finished = r.reason === 'done';
      return `<div class="cad-auto review" data-key="auto-review"><div class="cad-auto-head">${icon(finished ? 'check' : 'spark')}<strong>Auto-fix made ${r.steps} change${r.steps === 1 ? '' : 's'}</strong><span>${esc(r.counts)}</span></div>
        <p class="cad-note">${finished ? 'Every solid is a mapped block.' : esc(r.why) + '. Keep these cuts to finish by hand: select a red solid for its fixes, or Shift-pick neighbors to fuse and cut again.'} The changes are applied in the view and listed in the history.</p>
        <div class="cad-inline">${btn('auto-keep', 'Keep changes', { cls: 'small', iconName: 'check', title: 'Keep the cuts. Any other change also keeps them' })}${btn('auto-discard', 'Discard', { cls: 'ghost small', iconName: 'undo', title: 'Return to the geometry before Auto-fix ran; its steps can still be redone from the history' })}</div></div>`;
    }
    async function autoFix() {
      // The planner lives in cad-features.js so the UI, tests and automation share it.
      const startRevision = session.revision, startCursor = historyCursor();
      autoState.running = true; autoState.stopping = false; autoState.review = null; autoState.message = 'Analyzing solids…';
      autoState.controller = typeof AbortController === 'function' ? new AbortController() : null;
      renderReadiness();
      let result;
      try {
        result = await F().autoFix({
          state: () => ({ topology: session.topology, preview: session.preview, revision: session.revision }),
          preview: (operation, { lite } = {}) => api('preview', { ...token(), operation, ...(lite ? { lite: true } : {}) }),
          apply: async operation => { accept(await api('prepare', { ...token(), operation }), { fit: false, keepStep: true }); hooks.log(operation.label || operation.kind); },
          undo: async () => { accept(await api('undo', token()), { fit: false, keepStep: true }); }
        }, { mapping: H(), blends: autoState.blends, holes: autoState.holes, size: Number(sizing.size) || defaultSize(), signal: autoState.controller?.signal,
          progress: message => { autoState.message = message; renderReadiness(); } });
      } finally { autoState.running = false; autoState.stopping = false; autoState.controller = null; }
      const { start, end, steps, reason, error } = result;
      const counts = `${start.mappable}/${start.volumes} → ${end.mappable}/${end.volumes} mappable`;
      const why = { done: 'Finished', stopped: 'Stopped', error: `Stopped on an error (${error})`, limit: 'Stopped at its 40-step limit',
        stuck: steps ? 'Found no further cut that helps' : 'Found no cut that makes more solids mappable' }[reason] || 'Stopped';
      if (!end.blocked) expanded.blocked = false; else expanded.blocked = true;
      if (session.revision !== startRevision) markStale();
      // The changes wait for Keep or Discard; any later change keeps them.
      autoState.revision = session.revision;
      autoState.review = steps ? { steps, counts, reason, why, startCursor } : null;
      autoState.message = steps ? '' : `Auto-fix ${why.toLowerCase()} (${counts}). Continue by hand: select a red solid for its fixes, or Shift-pick neighboring solids to fuse them and cut again.${autoState.blends ? '' : ' Auto-fix keeps every feature, so removing fillets or holes the analysis does not need (Features) can let it go further.'}`;
      hooks.render();
      hooks.message(steps ? `Auto-fix made ${steps} change${steps === 1 ? '' : 's'} (${counts}). Keep or discard them in the readiness card.` : autoState.message, reason === 'error' || (!!end.blocked && !steps));
    }
    function keepAutoFix() {
      const r = autoState.review; if (!r) return;
      autoState.review = null;
      autoState.message = r.reason === 'done' ? '' : `Kept ${r.steps} Auto-fix change${r.steps === 1 ? '' : 's'} (${r.counts}). Continue by hand: select a red solid for its fixes, or Shift-pick neighboring solids to fuse them and cut again.`;
      hooks.render();
      hooks.message(`Kept the Auto-fix changes.`);
    }
    async function discardAutoFix() {
      const r = autoState.review; if (!r) return;
      autoState.review = null; autoState.message = '';
      await moveHistory('revert', r.startCursor);
      hooks.message(`Discarded ${r.steps} Auto-fix change${r.steps === 1 ? '' : 's'}. They can still be redone from the history until the next change.`);
    }
    function renderReadiness() { const el = document.querySelector('.cad-ready'); if (el) el.outerHTML = readinessCard(); }
    function shortReason(volume) {
      const r = volume.reasons[0]; if (!r) return '';
      const counts = {};
      const rank = code => code === 'open-ring' ? 0 : code === 'reentrant' ? 1 : 2;
      for (const reason of volume.reasons.slice().sort((a, b) => rank(a.code) - rank(b.code))) counts[reason.code] = (counts[reason.code] || 0) + 1;
      const label = { 'open-ring': 'open ring: cut again', cusp: 'knife edge', 'face-cusp': 'cusp', reentrant: 're-entrant edge', 'face-holes': 'face with hole', 'face-periodic': 'closed surface', 'face-closed': 'round face', 'face-corners': 'face corners', 'face-reflex': 'L-shaped face', sides: 'side count', 'block-corners': 'corner count' };
      return Object.entries(counts).map(([code, n]) => `${n > 1 ? n + ' × ' : ''}${label[code] || code}`).slice(0, 2).join(', ');
    }
    function toolCard() {
      if (!session) return '';
      if (pending && !tool) return '';
      if (tool === 'slice') return sliceCard() + (pending ? pendingStatus() : '');
      if (tool === 'cut') return cutCard() + (pending ? pendingStatus() : '');
      if (tool === 'features') return featuresCard() + (pending ? pendingStatus() : '');
      if (tool === 'passages') return passagesCard() + (pending ? pendingStatus() : '');
      if (tool === 'project') return projectCard() + (pending ? pendingStatus() : '');
      if (tool === 'surface') return surfaceCard();
      if (tool === 'extend') return extendCard();
      if (tool === 'heal') return `<div class="cad-card"><div class="cad-card-title">Heal geometry</div><p class="cad-note">Repairs small edges and faces, sews surfaces and rebuilds solids. Material volume must not change.</p>${pendingStatus()}</div>`;
      return '';
    }
    function pendingCard() {
      return `<div class="cad-pending"><div class="cad-pending-title">${icon('spark')}<span>Preview</span><strong>${esc(pending.label)}</strong></div>${pendingStatus()}</div>`;
    }
    function refreshPending() { renderPart('cad-tool', toolCard); renderPart('cad-context', contextCard); refreshFooter(); }
    function pendingStatus() {
      if (!pending) return '';
      const st = previewState, current = st.key === opKey(pending.operation);
      let html = '<div class="cad-result">';
      if (!current || st.status === 'running') html += `<span class="cad-spin"></span><span>Computing result preview…</span>`;
      else if (st.status === 'error') html += `${icon('warn', 'bad')}<span class="bad">${esc(st.error)}</span>`;
      else if (st.status === 'ready') {
        const before = session.topology.volumes.length, after = st.data.topology.volumes.length, a = st.analysis?.summary;
        html += `${icon('check', 'ok')}<span><b>${before} → ${after} solid${after === 1 ? '' : 's'}</b>${a ? ` · ${a.mappable}/${a.volumes} mappable` : ''}</span>
          <button type="button" class="cad-toggle" data-act="toggle-result" aria-pressed="${display.showResult}">${display.showResult ? 'Result' : 'Original'}</button>`;
      }
      return html + '</div>';
    }
    function sliceCard() {
      const d = sliceDraft;
      if (!d) return '';
      const n = unit(d.normal), b = bounds();
      const corners = [];
      for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) corners.push(dot([x, y, z], n));
      const lo = Math.min(...corners), hi = Math.max(...corners), offset = dot(d.origin, n);
      const axisName = [0, 1, 2].find(i => Math.abs(Math.abs(n[i]) - 1) < 1e-9);
      const preset = axisName == null ? 'custom' : 'xyz'[axisName];
      const ticks = sliceSnaps(n, lo, hi).map(v => `<i style="left:${(100 * (v - lo) / (hi - lo || 1)).toFixed(2)}%"></i>`).join('');
      const scopeCount = d.volumeIds?.length || 0;
      return `<div class="cad-card"><div class="cad-card-title">Slice <small>plane through solids</small></div>
        <div class="cad-row"><span class="cad-row-label">Normal</span>${seg('slice-axis', [['x', 'X'], ['y', 'Y'], ['z', 'Z'], ['custom', 'Custom']], preset, 'compact')}${btn('slice-flip', '', { cls: 'icon ghost', iconName: 'flip', title: 'Flip normal' })}</div>
        ${preset === 'custom' ? `<div class="cad-vec">${n.map((v, i) => `<label><em>${'XYZ'[i]}</em><input data-field="slice-n${i}" type="number" step="any" value="${round(v)}"></label>`).join('')}</div>` : ''}
        <div class="cad-row"><span class="cad-row-label">Offset</span><input class="cad-offset-num" data-field="slice-offset" type="number" step="any" value="${round(offset)}"></div>
        <div class="cad-slider"><input data-field="slice-slider" type="range" min="${lo}" max="${hi}" step="${(hi - lo) / 1000 || 1e-6}" value="${offset}"><div class="cad-ticks">${ticks}</div></div>
        ${d.along ? `<div class="cad-row"><span class="cad-row-label">On edge</span><input data-field="slice-along" type="range" min="0" max="1" step="0.001" value="${alongFraction(d)}"><span class="cad-mono">${Math.round(alongFraction(d) * 100)}%</span></div>` : ''}
        <div class="cad-row"><span class="cad-row-label">Applies to</span>${seg('slice-scope', [['all', 'All solids'], ['solids', scopeCount ? `${scopeCount} solid${scopeCount === 1 ? '' : 's'}` : 'Selected']], d.scope, 'compact')}</div>
        ${d.scope === 'solids' ? `<div class="cad-inline">${btn('slice-use-selection', 'Use selected solids', { cls: 'ghost small', disabled: selection.kind !== 'solid' })}</div>` : ''}
        <p class="cad-note">Drag the slider or type an offset. Ticks mark vertices; the slider snaps to them. Pick a planar face to slice along it.</p></div>`;
    }
    function cutCard() {
      const d = cutDraft, list = d?.segments || [];
      const axis = d ? [0, 1, 2].find(i => Math.abs(Math.abs(unit(d.axis)[i]) - 1) < 1e-9) : null;
      return `<div class="cad-card"><div class="cad-card-title">Cut <small>bounded, along edges</small></div>
        ${list.length ? `<ol class="cad-cut-list">${list.map((s, i) => `<li data-hover-points="${esc([...s.a, ...s.b].map(round).join(','))}"><span>${esc(s.source || `Segment ${i + 1}`)}</span><small>${fmt(norm(sub(s.b, s.a)), 4)} long</small>${btn('cut-remove', '', { cls: 'icon ghost', iconName: 'x', data: { index: i }, title: 'Remove this segment' })}</li>`).join('')}</ol>
        <div class="cad-row"><span class="cad-row-label">Sweep</span><span class="cad-row-value">${axis == null ? `(${unit(d.axis).map(v => fmt(v, 3)).join(', ')})` : `along ${'XYZ'[axis]}`}</span></div>
        <div class="cad-row"><span class="cad-row-label">Solids</span><span class="cad-row-value">${d.volumeIds.length ? d.volumeIds.join(', ') : 'all'}</span></div>` : ''}
        <p class="cad-note">${list.length
          ? 'Pick more edges, or Shift-pick two vertices, and choose <b>Add to cut</b>. A cut has to close off every region it enters; the preview says when one is left open.'
          : 'Pick straight edges, or Shift-pick two vertices of a face, and choose <b>Add to cut</b>. Unlike a slice, the cut stops where the edges stop.'}</p>
        ${list.length ? `<div class="cad-inline">${btn('cut-clear', 'Clear', { cls: 'ghost small' })}</div>` : ''}</div>`;
    }
    function alongFraction(d) {
      const { start, end } = d.along, dir = sub(end, start), l = dot(dir, dir);
      return l > 0 ? Math.max(0, Math.min(1, dot(sub(d.origin, start), dir) / l)) : 0.5;
    }
    function sliceSnaps(n, lo, hi) {
      const values = new Set();
      for (const v of session.topology.vertices || []) values.add(Number(dot(v.point, n).toFixed(9)));
      return [...values].filter(v => v > lo && v < hi).sort((a, b) => a - b).slice(0, 300);
    }
    function featuresCard() {
      const all = recognized?.features || [];
      const counts = { all: all.length, hole: 0, boss: 0, fillet: 0, chamfer: 0 };
      for (const f of all) counts[f.kind]++;
      const list = all.filter(f => featureFilter === 'all' || f.kind === featureFilter);
      const facesToRemove = new Set(all.filter(f => checkedFeatures.has(f.id)).flatMap(f => f.faces));
      if (selection.kind === 'face') for (const f of selection.ids) facesToRemove.add(f);
      let html = `<div class="cad-card"><div class="cad-card-title">Remove features <small>${all.length} recognized</small></div>
        ${seg('feature-filter', [['all', `All ${counts.all}`], ['hole', `Holes ${counts.hole}`], ['fillet', `Fillets ${counts.fillet}`], ['chamfer', `Chamfers ${counts.chamfer}`]], featureFilter, 'compact tabs')}`;
      if (!list.length) html += `<p class="cad-note">No ${featureFilter === 'all' ? '' : featureFilter + ' '}features recognized. Pick faces to remove them directly.</p>`;
      else {
        html += `<div class="cad-feature-tools">${btn('features-all', 'Check all', { cls: 'ghost small' })}${btn('features-none', 'None', { cls: 'ghost small' })}<label class="cad-mini"><span>≤</span><input data-field="feature-max" type="number" step="any" placeholder="size"></label>${btn('features-max', 'Check smaller', { cls: 'ghost small' })}</div>`;
        html += `<div class="cad-feature-list">${list.map(f => `<label class="cad-feature ${checkedFeatures.has(f.id) ? 'checked' : ''}" data-hover-faces="${f.faces.join(',')}"><input type="checkbox" data-act="feature-check" data-id="${f.id}" ${checkedFeatures.has(f.id) ? 'checked' : ''}><span class="kind ${f.kind}"></span><span class="name">${esc(f.label)}</span><small>${f.faces.length} face${f.faces.length === 1 ? '' : 's'}</small><button type="button" class="cad-locate" data-act="feature-locate" data-id="${f.id}" title="Select faces">${icon('target')}</button></label>`).join('')}</div>`;
      }
      html += `<div class="cad-sum-line">${facesToRemove.size ? `<b>${facesToRemove.size}</b> face${facesToRemove.size === 1 ? '' : 's'} will be removed and healed` : 'Check features or pick faces to remove'}</div>`;
      const checkedHoles = all.filter(f => checkedFeatures.has(f.id) && f.kind === 'hole');
      if (checkedHoles.length) html += `<div class="cad-inline">${btn('features-passages', `Replace ${checkedHoles.length} hole${checkedHoles.length === 1 ? '' : 's'} with square passages`, { cls: 'ghost small', iconName: 'passage', title: 'Keep the openings as inscribed square passages instead of removing them' })}</div>`;
      html += '</div>';
      return html;
    }
    function passagesCard() {
      const input = (i, key, label, value, component) => `<label><em>${label}</em><input data-field="passage:${i}:${key}${component == null ? '' : ':' + component}" type="number" step="any" value="${esc(value)}"></label>`;
      return `<div class="cad-card"><div class="cad-card-title">Square passages <small>replace bores</small></div>
        <p class="cad-note">Selected feature faces are healed, then each rectangular passage is cut through. Pick a hole face to add a matching passage.</p>
        ${passages.map((p, i) => `<div class="cad-passage"><div class="cad-row"><span class="cad-row-label">Passage ${i + 1}</span>${seg('passage-axis', [['x', 'X'], ['y', 'Y'], ['z', 'Z']].map(o => [i + ':' + o[0], o[1]]), i + ':' + p.axis, 'compact')}${btn('passage-remove', '', { cls: 'icon ghost', iconName: 'x', data: { index: i } })}</div>
          <div class="cad-vec">${p.center.map((v, j) => input(i, 'center', 'XYZ'[j], v, j)).join('')}</div>
          <div class="cad-vec two">${input(i, 'width', 'W', p.width)}${input(i, 'height', 'H', p.height)}</div>
          <div class="cad-vec two">${input(i, 'range', 'From', p.range[0], 0)}${input(i, 'range', 'To', p.range[1], 1)}</div>${p.fit ? '<p class="cad-note">Ends are moved to the nearest open space when applied.</p>' : ''}</div>`).join('')}
        <div class="cad-inline">${btn('passage-add', 'Add passage', { cls: 'ghost small', iconName: 'plus' })}</div></div>`;
    }
    function projectCard() {
      const axis = pending?.operation.axis || 'z';
      return `<div class="cad-card"><div class="cad-card-title">Project faces <small>constant-section columns</small></div>
        <div class="cad-row"><span class="cad-row-label">Axis</span>${seg('project-axis', [['x', 'X'], ['y', 'Y'], ['z', 'Z']], axis, 'compact')}</div>
        <label class="cad-row"><span class="cad-row-label">Target solids</span><input type="text" data-field="project-solids" value="${esc((pending?.operation.volumeIds || []).join(', '))}" placeholder="All solids" aria-label="Projection target solids"></label>
        <div class="cad-inline">${btn('project-targets', 'Use selected solids', { cls: 'ghost small' })}</div>
        <div class="cad-inline">${btn('project-floors', 'Select internal floors', { cls: 'ghost small' })}</div>
        <p class="cad-note">Pick planar faces. Their outlines and existing splits continue through the target solids. Leave targets blank to project through all solids.</p></div>`;
    }

    /* --------------------------------------------------------------- size -- */
    function sizeBody() {
      if (!intervals) return '';
      const size = Number(sizing.size) || defaultSize();
      let html = `<section class="cad-card"><div class="cad-card-title">Global sizing <small>≈ ${fmt(intervals.estimate, 3)} hex</small></div>
        <div class="cad-size-row"><label class="cad-field"><span>Element size</span><input data-field="size" type="number" step="any" min="0" value="${round(size)}"></label>
        <label class="cad-field narrow"><span>Min / edge</span><input data-field="min-count" type="number" min="1" step="1" value="${sizing.minCount}"></label></div>
        <input class="cad-size-slider" data-field="size-slider" type="range" min="${Math.log10(span() / 400)}" max="${Math.log10(span() / 2)}" step="0.01" value="${Math.log10(size)}">
        <div class="cad-display-toggles">${[['seeds', 'Seeds'], ['labels', 'Counts'], ['groups', 'Group colors']].map(([k, label]) => `<button type="button" class="cad-toggle" data-act="display" data-value="${k}" aria-pressed="${display[k]}">${label}</button>`).join('')}</div></section>`;
      html += `<section id="cad-edge-editor">${edgeEditor()}</section><section id="cad-impact">${impactCard()}</section>`;
      html += `<section id="cad-equations">${equationsCard()}</section>`;
      const blocked = analysis.summary.blocked;
      if (blocked) html += `<p class="cad-note warn">${icon('warn')} ${blocked} solid${blocked === 1 ? ' is' : 's are'} not mappable and excluded from these equations.</p>`;
      return html;
    }
    function solidEditor() {
      const ids=selection.ids.filter(id=>analysis.volumes.get(id)?.mappable),sizes=ids.map(id=>sizing.solids.get(id)?.size||'');
      if(!ids.length)return '<div class="cad-card subtle">Select a mappable solid.</div>';
      const block=ids.length===1?analysis.volumes.get(ids[0]).block:null;
      const directions=block?['100','010','001'].map(key=>block.logicalEdges.find(e=>e.corners.includes(block.corners['000'])&&e.corners.includes(block.corners[key]))).filter(Boolean):[];
      const directional=directions.map(e=>{
        const a=analysis.index.vertices.get(e.corners[0]),b=analysis.index.vertices.get(e.corners[1]),delta=b.map((x,i)=>Math.abs(x-a[i])),axis=delta.indexOf(Math.max(...delta)),aligned=delta.every((x,i)=>i===axis||x<1e-6);
        return `<button type="button" class="cad-link" data-act="select-edges" data-edges="${e.edges.join(',')}">${aligned?'XYZ'[axis]+' · ':''}${fmt(e.length||e.edges.reduce((s,id)=>s+analysis.index.edges.get(id).length,0))} mm · ${e.edges.reduce((s,id)=>s+intervals.counts.get(id),0)} element${e.edges.reduce((s,id)=>s+intervals.counts.get(id),0)===1?'':'s'}${e.edges.length>1?' ('+e.edges.length+' segments)':''}</button>`;
      }).join('');
      return `<div class="cad-card"><div class="cad-card-title">${ids.length===1?'Solid '+ids[0]:ids.length+' solids'} · local sizing</div><div class="cad-size-row"><label class="cad-field"><span>Solid element size</span><input data-field="solid-size" type="number" min="0" step="any" value="${sizes.every(s=>s===sizes[0])?sizes[0]:''}" placeholder="global"></label>${btn('solid-reset','Reset',{cls:'ghost small'})}</div><p class="cad-note">Edge controls override this size. Matching edges propagate to neighboring blocks.</p>${directional?'<div class="cad-sub-title">Directional edge controls</div><div class="cad-direction-controls">'+directional+'</div>':''}${btn('pick','Pick thickness edges',{cls:'ghost small',data:{value:'edge'}})}</div>`;
    }
    function impactCard() {
      const plan=localPlan();if(!plan)return '';
      const ids=new Set([plan.owner.id]),objects=plan.objects;
      let changed=true;while(changed){changed=false;for(const o of objects)if(!ids.has(o.id)&&o.dependsOn?.some(id=>ids.has(id))){ids.add(o.id);changed=true;}}
      const downstream=objects.filter(o=>o.id!==plan.owner.id&&ids.has(o.id));
      return `<div class="cad-card"><div class="cad-card-title">Remesh impact <small>${plan.affected.length} / ${plan.owner.definition.targets.length} solids</small></div>${plan.affected.length?`<div class="cad-impact-legend"><span style="color:#e58a55">● ${plan.direct.length} directly changed</span><span style="color:#e8b04c">● ${plan.propagated.length} dependent</span><span style="color:#92a9bd">● ${plan.unchanged.length} unchanged</span></div>${plan.all?'<p class="cad-note">Order or section changes require the complete region.</p>':btn('remesh-affected','Preview affected solids',{cls:'ghost small',disabled:!!plan.conflicts.length})}<details class="cad-impact-list"><summary>Why these solids?</summary>${plan.affected.map(id=>`<button type="button" class="cad-link" data-act="impact-solid" data-id="${id}">Solid ${id} · ${plan.propagated.includes(id)?'dependent':'direct'}</button><p class="cad-note">${esc(plan.reasons[id])}</p>`).join('')}</details>${downstream.length?`<details><summary>${downstream.length} downstream objects to recheck on Apply</summary><p class="cad-note">${downstream.map(o=>esc(o.name)).join(' · ')}</p></details>`:''}`:'<p class="cad-note">No solved counts changed. Pick a solid to remesh it, or edit an edge or solid size.</p>'}</div>`;
    }
    function edgeEditor() {
      if(selection.kind==='solid'&&selection.ids.length)return solidEditor();
      if (!intervals || selection.kind !== 'edge' || !selection.ids.length) {
        return `<div class="cad-card subtle"><div class="cad-hint compact">${icon('edge')}<span>Pick edges for counts or local sizes; pick solids for a regional size.</span></div>${pick !== 'edge' ? btn('pick', 'Pick edges', { cls: 'ghost small', data: { value: 'edge' } }) : ''}${btn('pick','Pick solids',{cls:'ghost small',data:{value:'solid'}})}</div>`;
      }
      const ids = selection.ids.filter(e => intervals.counts.has(e));
      if (!ids.length) return `<div class="cad-card subtle"><p class="cad-note">The selected edge${selection.ids.length === 1 ? ' is' : 's are'} not on a mappable solid.</p></div>`;
      const shown = e => intervals.locked.get(e) ?? intervals.counts.get(e);
      const counts = [...new Set(ids.map(shown))];
      const locked = ids.filter(e => intervals.locked.has(e));
      const groups = [...new Set(ids.map(e => intervals.groups.find(g => g.edges.includes(e))))].filter(Boolean);
      const lengths = ids.map(e => Number(analysis.index.edges.get(e)?.length) || 0);
      const value = counts.length === 1 ? counts[0] : '';
      const sizeValue = ids.every(e => sizing.edges.get(e)?.size) && new Set(ids.map(e => sizing.edges.get(e).size)).size === 1 ? sizing.edges.get(ids[0]).size : '';
      return `<div class="cad-card cad-edge-card"><div class="cad-card-title">${ids.length === 1 ? `Edge ${ids[0]}` : `${ids.length} edges`} <small>L ${fmt(lengths.reduce((a, b) => a + b, 0) / lengths.length)}${ids.length > 1 ? ' avg' : ''}</small></div>
        <div class="cad-stepper"><button type="button" data-act="count-step" data-value="-1" title="Fewer (−)">${icon('minus')}</button><input data-field="count" type="number" min="1" step="1" value="${value}" placeholder="mixed"><button type="button" data-act="count-step" data-value="1" title="More (+)">${icon('plus')}</button>
        <button type="button" class="cad-lock ${locked.length === ids.length ? 'on' : ''}" data-act="lock" title="${locked.length === ids.length ? 'Fixed count — click to free (L)' : 'Fix this count (L)'}">${icon(locked.length === ids.length ? 'lock' : 'unlock')}<span>${locked.length === ids.length ? 'Fixed' : locked.length ? 'Partly fixed' : 'Free'}</span></button></div>
        <div class="cad-size-row"><label class="cad-field"><span>Local size</span><input data-field="edge-size" type="number" step="any" min="0" value="${esc(sizeValue)}" placeholder="global"></label>${btn('edge-reset', 'Reset', { cls: 'ghost small', title: 'Remove local controls' })}</div>
        <div class="cad-group-line">${groups.map(g => `<button type="button" class="cad-group-tag" data-act="select-group" data-index="${g.index}" style="--g:#${GROUP_COLORS[g.index % GROUP_COLORS.length].toString(16).padStart(6, '0')}">Group ${g.label} · ${g.edges.length} edges</button>`).join('')}</div>
        <p class="cad-note">${locked.length ? 'Fixed counts are hard constraints. ' : ''}Keys: <kbd>+</kbd>/<kbd>−</kbd> change, <kbd>L</kbd> fix.</p></div>`;
    }
    function equationsCard() {
      if (!intervals) return '';
      const { conflicts, groups, sums, stretched } = intervals;
      let html = `<div class="cad-card"><div class="cad-card-title">Edge-count equations <small>${groups.length} groups · ${sums.length} sums</small></div>`;
      if (!intervals.region.volumes.length) return html + '<p class="cad-note">No mappable solids yet. Prepare the geometry first.</p></div>';
      if (conflicts.length) html += conflicts.map((c, i) => `<div class="cad-conflict">${icon('warn')}<div><strong>${c.kind === 'locks' ? 'Fixed counts disagree' : c.kind === 'integer' ? 'No integer solution' : 'Sum equation conflict'}</strong><p>${esc(c.message)}</p>${btn('show-conflict', 'Show edges', { cls: 'ghost small', data: { index: i } })}</div></div>`).join('');
      else html += `<p class="cad-good">${icon('check')} All ${intervals.equations.length} face equations are satisfied with integer counts.</p>`;
      const shownGroups = expanded.groups ? groups : groups.slice(0, 8);
      html += `<div class="cad-eq-list">${shownGroups.map(g => {
        const col = '#' + GROUP_COLORS[g.index % GROUP_COLORS.length].toString(16).padStart(6, '0');
        const lockedTag = g.lockedEdges.length ? icon('lock', 'tiny') : '';
        const edgesText = g.edges.length > 6 ? `E${g.edges.slice(0, 5).join(' = E')} = … (${g.edges.length})` : 'E' + g.edges.join(' = E');
        return `<button type="button" class="cad-eq ${g.conflict ? 'bad' : ''}" data-act="select-group" data-index="${g.index}" style="--g:${col}"><span class="tag">${g.label}</span><span class="expr">${esc(edgesText)}</span><span class="val">${lockedTag}${g.count}<small>${g.lockedEdges.length ? '' : ` (${fmt(g.target, 2)})`}</small></span></button>`;
      }).join('')}</div>`;
      if (groups.length > 8) html += `<button type="button" class="cad-link" data-act="expand" data-value="groups">${expanded.groups ? 'Show fewer' : `Show all ${groups.length} groups`}</button>`;
      if (sums.length) {
        const shown = expanded.sums ? sums : sums.slice(0, 5);
        html += `<div class="cad-sub-title">Sum equations</div><div class="cad-eq-list">${shown.map(s => `<button type="button" class="cad-eq sum ${s.ok ? '' : 'bad'}" data-act="select-edges" data-edges="${[...s.lhs, ...s.rhs].join(',')}"><span class="tag">F${s.face}</span><span class="expr">${esc(s.lhs.map(e => 'E' + e).join(' + '))} = ${esc(s.rhs.map(e => 'E' + e).join(' + '))}</span><span class="val">${s.lhsValue}${s.ok ? '' : ' ≠ ' + s.rhsValue}</span></button>`).join('')}</div>`;
        if (sums.length > 5) html += `<button type="button" class="cad-link" data-act="expand" data-value="sums">${expanded.sums ? 'Show fewer' : `Show all ${sums.length}`}</button>`;
      }
      const single = groups.filter(g => g.count === 1).length;
      if (single && meshSettings.order === 1) html += `<p class="cad-note warn">${icon('warn')} ${single} group${single === 1 ? ' has' : 's have'} one element through. A single layer of linear hexes is too stiff in bending: raise Min / edge to 2 or mesh with HEX20.</p>`;
      if (stretched.length) html += `<p class="cad-note warn">${icon('warn')} ${stretched.length} edge${stretched.length === 1 ? ' is' : 's are'} far from the target size because of linked counts (e.g. E${stretched[0].edge}: ${stretched[0].count} vs ${fmt(stretched[0].target, 2)}). Fix a count or slice to decouple.</p>`;
      return html + '</div>';
    }

    /* --------------------------------------------------------------- mesh -- */
    function meshBody() {
      let html = `<div id="cad-meshes">${meshesCard()}</div>`;
      if (!discrete()) html += `<section class="cad-card"><div class="cad-card-title">Method</div>${seg('mesh-method', [['mapped', 'Mapped hex', 'mesh', 'Native transfinite hex meshing — no Gmsh'], ['shell', 'Shell', 'shell', 'Quad or tri shell elements on faces, at a midsurface or offset'], ['gmsh', 'Other (Gmsh)', 'spark', gmshReady() ? 'Tet, tri, quad and sweep methods through Gmsh' : GMSH_MISSING, !gmshReady()]], meshSettings.method)}${gmshReady() ? '' : `<p class="cad-note">${icon('warn')} Gmsh methods (tets, triangle shells, sweeps) are off: ${esc(GMSH_MISSING)}</p>`}</section>`;
      if (meshSettings.method === 'shell' && !discrete()) html += `<div id="cad-shell">${shellBody()}</div>`;
      else if (meshSettings.method === 'mapped' && !discrete()) {
        const s = analysis.summary, selectedSolids = selection.kind === 'solid' ? selection.ids.filter(id => analysis.volumes.get(id)?.mappable) : [];
        html += `<section class="cad-card"><div class="cad-card-title">Mapped hex <small>native</small></div>
          <div class="cad-row"><span class="cad-row-label">Order</span>${seg('mesh-order', [[1, 'HEX8'], [2, 'HEX20']], meshSettings.order, 'compact')}</div>
          <div class="cad-row"><span class="cad-row-label">Solids</span>${seg('mesh-scope', [['all', `All mappable ${s.mappable}`], ['selected', `Selected ${selectedSolids.length}${localPlan()?' + dependents':''}`], ...(localPlan()&&!localPlan().all?[['affected',`Affected ${localPlan().affected.length}`]]:[])], meshSettings.scope, 'compact')}</div>
          <div class="cad-row"><span class="cad-row-label">Property</span>${seg('mesh-pid', [['one', 'One PSOLID'], ['solid', 'Per solid']], meshSettings.pidPerSolid ? 'solid' : 'one', 'compact')}</div>
          <label class="cad-check"><input type="checkbox" data-field="mesh-live" ${meshSettings.live ? 'checked' : ''}> Live preview while editing</label>
          ${s.blocked ? `<p class="cad-note warn">${icon('warn')} ${s.blocked} solid${s.blocked === 1 ? '' : 's'} will be skipped (not mappable).</p>` : ''}
          ${intervals?.conflicts.length ? `<p class="cad-note bad">${icon('warn')} Resolve ${intervals.conflicts.length} edge-count conflict${intervals.conflicts.length === 1 ? '' : 's'} in Size first.</p>` : ''}</section>`;
        html += `<section id="cad-impact">${impactCard()}</section><section id="cad-mesh-report">${meshReportCard()}</section>`;
      } else html += legacyBody();
      if (report) html += `<div class="cad-card ${report.error ? 'bad' : 'good'}"><pre class="cad-report">${esc(report.text)}</pre></div>`;
      if (meshes.some(m => m.stale && m.inModel !== false)) html += `<p class="cad-note warn">${icon('warn')} ${meshes.some(m => m.projectOwner && m.stale && m.inModel !== false) ? 'The CAD draft or mesh history changed. Review a new mesh to reconcile it; export retains the committed model.' : 'Geometry, sizing or the model changed since a mesh was added. Mesh those bodies again to update it.'}</p>`;
      return html;
    }
    function meshReportCard() {
      if (meshError) return `<div class="cad-card bad"><div class="cad-conflict">${icon('warn')}<div><strong>Cannot mesh</strong><p>${esc(meshError)}</p></div></div></div>`;
      if (!meshPreview) return `<div class="cad-card subtle"><div class="cad-hint compact">${icon('eye')}<span>Preview the mesh to check element quality before adding it to the model.</span></div></div>`;
      const q = meshPreview.result.quality, total = q.elements || 1;
      const bars = q.histogram.map((n, i) => `<i style="height:${Math.max(2, Math.round(40 * n / Math.max(...q.histogram, 1)))}px;background:rgb(${qualityColor((i + 0.5) / 10).map(c => Math.round(c * 255)).join(',')})" title="SJ ${i / 10}–${(i + 1) / 10}: ${n}"></i>`).join('');
      const worst = q.perVolume.slice().sort((a, b) => a.minScaledJacobian - b.minScaledJacobian).slice(0, 3);
      return `<div class="cad-card"><div class="cad-card-title">Preview quality <small>${meshPreview.ms} ms</small></div>
        <div class="cad-stats"><div><span>Elements</span><strong>${q.elements.toLocaleString()}</strong></div><div><span>Nodes</span><strong>${q.nodes.toLocaleString()}</strong></div><div><span>Min SJ</span><strong class="${q.minScaledJacobian < 0.2 ? 'bad' : q.minScaledJacobian < 0.5 ? 'warn' : 'ok'}">${q.minScaledJacobian.toFixed(3)}</strong></div><div><span>Max AR</span><strong>${fmt(q.maxAspect, 3)}</strong></div></div>
        <div class="cad-hist">${bars}</div><div class="cad-hist-axis"><span>0</span><span>Scaled Jacobian</span><span>1</span></div>
        ${q.inverted ? `<p class="cad-note bad">${icon('warn')} ${q.inverted} inverted element${q.inverted === 1 ? '' : 's'}. Slice the solid or change counts.</p>` : ''}
        <div class="cad-worst">${worst.map(w => `<button type="button" data-act="select-solid" data-id="${w.volume}"><span>Solid ${w.volume}</span><span>${w.dims.join('×')}</span><span>${w.minScaledJacobian.toFixed(3)}</span></button>`).join('')}</div>
        <p class="cad-note">Faces are colored by element scaled Jacobian.${q.order === 2 ? ' HEX20 quality samples the curved mapping at nodes, face centres, the centre and Gauss points.' : ''} ${(100 * q.histogram.slice(5).reduce((a, b) => a + b, 0) / total).toFixed(0)}% of elements have SJ ≥ 0.5.</p></div>`;
    }
    /** Round holes among the picked faces or edges (a hole's bore, countersink or rim). */
    function pickedHoles() {
      if (!recognized || !['face', 'edge'].includes(selection.kind)) return [];
      const faces = selection.kind === 'face' ? selection.ids : selection.ids.flatMap(e => [...(recognized.ctx.edgeFaces.get(Number(e)) || [])]);
      return [...new Set(faces.map(f => recognized.byFace.get(Number(f))).filter(f => f?.kind === 'hole'))];
    }
    function padsBody() {
      const holes = pickedHoles(), fixed = shell.mesher !== 'quadtree', n = shell.pads.length;
      let html = `<div class="cad-side"><span>Pads <strong>${n} hole${n === 1 ? '' : 's'}</strong></span>${btn('shell-pad-add', holes.length ? `Add ${holes.length} picked` : 'Add picked', { cls: 'ghost mini', disabled: !holes.length || !fixed, title: 'One ring of quads around each picked hole, inside a square; the rest of the face is meshed to the square\'s nodes' })}${btn('shell-pad-show', 'Show', { cls: 'ghost mini', disabled: !n })}${btn('shell-pad-clear', 'Clear', { cls: 'ghost mini', disabled: !n })}</div>
        <div class="cad-size-row">${numberField('shell-pad-size', 'Pad size', shell.padSize ?? '', 'min="0" placeholder="auto"')}${numberField('shell-pad-side', 'Per side', shell.padSide ?? '', 'min="2" max="64" step="1" placeholder="auto"')}</div>`;
      if (n) html += `<div class="cad-pads">${shell.pads.map((p, i) => `<span class="cad-chip">Ø${fmt(p.diameter, 3)} · ${p.size ? fmt(p.size, 3) + ' mm' : 'auto'}${p.perSide ? ` · ${p.perSide}/side` : ''}<button type="button" data-act="shell-pad-remove" data-value="${i}" title="Remove this pad" aria-label="Remove pad">×</button></span>`).join('')}</div>`;
      else html += '<p class="cad-note">Pick holes (a bore face or its edge), then <b>Add picked</b>. Size and per side apply to the holes you add; left blank, the pad matches the element size and shrinks to stay on its face.</p>';
      if (n && !fixed) html += `<p class="cad-note warn">${icon('warn')} Pads need fixed boundary nodes: the quadtree leaves them out.</p>`;
      return html;
    }
    function shellBody() {
      const picked = selection.kind === 'face' ? selection.ids : [];
      const all = session.topology.faces.length, quad = shell.element === 'quad';
      const count = list => `${list.length} face${list.length === 1 ? '' : 's'}`;
      let html = `<section class="cad-card"><div class="cad-card-title">Shell mesh <small>${quad ? (shell.mesher === 'paved' ? 'native paved' : 'native quadmesh') : 'Gmsh triangles'}</small></div>
        <div class="cad-row"><span class="cad-row-label">Elements</span>${seg('shell-element', [['quad', 'Quad CQUAD4'], ['tri', 'Tri CTRIA3', '', gmshReady() ? 'Triangles through Gmsh' : GMSH_MISSING, !gmshReady()]], shell.element, 'compact')}</div>
        ${!quad && !gmshReady() ? `<p class="cad-note warn">${icon('warn')} ${esc(GMSH_MISSING)} Switch to quad elements.</p>` : ''}`;
      if (quad) html += `<div class="cad-row"><span class="cad-row-label">Mesher</span>${seg('shell-mesher', [['recombined', 'Recombined', '', 'Triangulate, pair into quads and subdivide; faces share nodes along their edges'], ['paved', 'Paved', '', 'Rows of quads that follow every boundary and hole (Q-Morph); faces share nodes along their edges'], ['quadtree', 'Quadtree', '', 'Quadtree mesh of each face on its own']], shell.mesher, 'compact')}</div>
        ${shell.mesher === 'quadtree' ? `<p class="cad-note warn">${icon('warn')} The quadtree meshes each face on its own: faces will not share nodes along their edges.</p>` : ''}`;
      html += `<div class="cad-row"><span class="cad-row-label">Place</span>${seg('shell-placement', [['surface', 'On faces'], ['midsurface', 'Midsurface'], ['offset', 'Offset']], shell.placement, 'compact')}</div>`;
      if (shell.placement === 'midsurface') {
        html += `<p class="cad-note">Pick one face of the sheet, then <b>Use picked</b>, <b>Whole side</b> and <b>Opposite of A</b>. The shell goes halfway between the sides; its thickness is measured.</p>
          <div class="cad-side"><span>Side A <strong>${count(shell.faces)}</strong></span>${btn('shell-side', 'Use picked', { cls: 'ghost mini', data: { value: 'a' }, disabled: !picked.length })}${btn('shell-grow', 'Whole side', { cls: 'ghost mini', disabled: !shell.faces.length, title: 'Add every face the side continues into tangentially' })}${btn('shell-show', 'Show', { cls: 'ghost mini', data: { value: 'a' }, disabled: !shell.faces.length })}</div>
          <div class="cad-side"><span>Side B <strong>${count(shell.facesB)}</strong></span>${btn('shell-side', 'Use picked', { cls: 'ghost mini', data: { value: 'b' }, disabled: !picked.length })}${btn('shell-opposite', 'Opposite of A', { cls: 'ghost mini', disabled: !shell.faces.length, title: 'The nearest parallel or coaxial faces across the sheet' })}${btn('shell-show', 'Show', { cls: 'ghost mini', data: { value: 'b' }, disabled: !shell.facesB.length })}</div>`;
      } else {
        const sheetFaces = sheetRecords().length;
        html += `<div class="cad-row"><span class="cad-row-label">Faces</span>${seg('shell-scope', [['all', `All ${all}`], ...(sheetFaces ? [['sheets', `Sheets ${sheetFaces}`]] : []), ['selected', `Picked ${picked.length}`]], shell.scope, 'compact')}</div>`;
        if (sheetFaces) html += `<p class="cad-note">Sheets use their own thickness and offset (ZOFFS); T below is for other faces and sheets without one.</p>`;
        if (shell.placement === 'offset') html += `<div class="cad-size-row">${numberField('shell-offset', 'Offset (+ out)', shell.offset)}${btn('shell-half', '−T/2', { cls: 'ghost mini', title: 'Offset inward by half the thickness: from an outer face to the midsurface' })}</div>`;
        const patchOwner=engine().getProjectOwnership?.()?.project.objects.find(o=>o.id===editingOwner&&o.definition.pendingReplacement);
        html += patchOwner?'<p class="cad-note">Changed-face patch: existing sections and thicknesses are retained. Matched boundary divisions are pinned to the retained mesh.</p>':numberField('shell-thickness', 'Thickness T', shell.thickness, 'min="0"');
      }
      html += `<div class="cad-size-row">${numberField('shell-size', 'Element size', round(Number(shell.size) || Number(sizing.size) || defaultSize()), 'min="0"')}${quad ? numberField('shell-circle', 'Per circle', shell.perCircle, 'min="4" max="128" step="1"') : ''}</div>
        <div class="cad-row"><span class="cad-row-label">Property</span>${seg('shell-pid', [['one', 'One PSHELL'], ['face', 'Per face']], shell.pidPerFace ? 'face' : 'one', 'compact')}</div>`;
      if (quad) html += padsBody();
      const locks = [...sizing.edges].filter(([, c]) => c.count).length;
      if (locks) html += `<p class="cad-note">Uses ${locks} edge count${locks === 1 ? '' : 's'} from Size; odd counts make the quads on that face poorer.</p>`;
      return html + '</section>';
    }
    function shellFaces() {
      if (shell.placement === 'midsurface') return shell.faces.slice();
      if (shell.scope === 'selected') return selection.kind === 'face' ? selection.ids.slice() : [];
      if (shell.scope === 'sheets') return sheetRecords().map(r => r.face);
      return [];
    }
    /** The faces a shell mesh would cover now, and the solids a mapped mesh would. */
    function shellTarget() { const faces = shellFaces(); return faces.length ? faces : (session?.topology.faces || []).map(f => f.id); }
    function mappedTarget() { return meshVolumes() || [...(analysis?.volumes.values() || [])].filter(v => v.mappable).map(v => v.id); }
    async function shellMesh() {
      const size = Number(shell.size) || Number(sizing.size) || defaultSize();
      if (!(size > 0)) throw Error('Enter a positive element size.');
      const payload = { ...token(), element: shell.element, mesher: shell.mesher, size, elementsPerCircle: Math.round(Number(shell.perCircle) || 12), placement: shell.placement, pidPerFace: shell.pidPerFace };
      const faces = shellFaces();
      if (shell.placement === 'midsurface') {
        if (!shell.faces.length || !shell.facesB.length) throw Error('Choose both sides of the sheet: side A, then side B (Opposite of A finds it).');
        payload.faceIds = faces; payload.facesB = shell.facesB.slice();
      } else {
        if (shell.scope === 'selected' && !faces.length) throw Error('Pick the faces to mesh, or mesh all faces.');
        if (shell.scope === 'sheets' && !faces.length) throw Error('There are no sheets to mesh: make them with the Surface tool in Prepare.');
        if (faces.length) payload.faceIds = faces;
        if (shell.placement === 'offset') { payload.offset = Number(shell.offset); if (!Number.isFinite(payload.offset)) throw Error('Enter a finite offset.'); }
      }
      payload.edgeDivisions = [...sizing.edges].filter(([, c]) => c.count).slice(0, 10000).map(([id, c]) => ({ id, divisions: c.count }));
      payload.edgeSizes = [...sizing.edges].filter(([, c]) => c.size && !c.count).slice(0, 10000).map(([id, c]) => ({ id, size: c.size }));
      if (shell.element === 'quad' && shell.mesher !== 'quadtree' && shell.pads.length) {
        payload.pads = shell.pads.map(p => ({ faces: p.faces.slice(), ...(p.size ? { size: p.size } : {}), ...(p.perSide ? { perSide: p.perSide } : {}) }));
      }
      hooks.message(`Meshing ${faces.length || session.topology.faces.length} face${(faces.length || session.topology.faces.length) === 1 ? '' : 's'} with ${shell.element === 'quad' ? 'quads' : 'triangles'}…`);
      const result = await api('shell', payload);
      const q = result.quality, placed = q.placement || {};
      const thickness = placed.placement === 'midsurface' ? placed.thickness : Number(shell.thickness);
      if (!(thickness > 0)) throw Error('Enter a positive shell thickness.');
      const meshed = q.faces.filter(f => f.quads).map(f => f.face);
      const label = `${shell.element === 'quad' ? 'Quad' : 'Tri'} shell · ${meshed.length} face${meshed.length === 1 ? '' : 's'}${placed.placement === 'midsurface' ? ' · midsurface' : placed.placement === 'offset' ? ' · offset' : ''}`;
      if(hooks.reviewMappedMesh&&!covering({faces:meshed}).some(m=>!m.projectOwner&&m.inModel!==false)){
        if(shellTarget().some(id=>!meshed.includes(id))||q.failedFaces?.length||q.faces.some(f=>!f.quads||f.valid===false)||!(q.minScaledJacobian>0))throw Error('Shell coverage or quality failed. Resolve every requested face before committing this region.');
        await reviewOwnedMesh('shell',result.mesh,meshed,{thickness,thicknessByProperty:result.thicknessByProperty||{}},()=>{report={text:label+' · '+q.elements+' elements · min scaled Jacobian '+q.minScaledJacobian.toFixed(3)};engine().setCadVisible(false);engine().setCadSelectionMode('none');});
        return;
      }
      await commitMesh({ kind: 'shell', faces: meshed }, result, { topology: shell.element, order: 1, thickness, thicknessByProperty: result.thicknessByProperty || null }, label);
      const failed = q.faces.filter(f => !f.quads);
      const lines = [`${q.nodes.toLocaleString()} nodes · ${q.elements.toLocaleString()} ${shell.element === 'quad' ? 'CQUAD4' : 'CTRIA3'} · ${q.faces.length - failed.length} of ${q.faces.length} faces`,
        `Min scaled Jacobian ${q.minScaledJacobian.toFixed(3)} · mean ${q.meanScaledJacobian.toFixed(3)} · ${q.freeEdges.toLocaleString()} free edges${q.nonManifoldEdges ? ` · ${q.nonManifoldEdges} ${meshed.some(f => sheetOf(f)) ? 'junction edges (three or more faces meet)' : 'non-manifold'}` : ''}`,
        placed.placement === 'midsurface' ? `Midsurface · PSHELL T ${fmt(thickness, 4)} (measured ${fmt(placed.minThickness, 4)} to ${fmt(placed.maxThickness, 4)})` : placed.placement === 'offset' ? `Offset ${fmt(placed.offset, 4)} · PSHELL T ${fmt(thickness, 4)}`
          : Object.keys(result.thicknessByProperty || {}).length ? `Sheets · PSHELL T ${[...new Set(Object.values(result.thicknessByProperty))].map(t => fmt(t, 4)).join(', ')}${meshed.some(f => !sheetOf(f) || !sheetOf(f).thickness) ? ` · T ${fmt(thickness, 4)} for the other faces` : ''}` : `On the faces · PSHELL T ${fmt(thickness, 4)}`];
      if (placed.placement === 'midsurface' && placed.maxThickness > placed.minThickness * 1.02) lines.push(`Warning: the sheet thickness varies by ${fmt(100 * (placed.maxThickness / placed.minThickness - 1), 2)}%; the property uses the median.`);
      for (const f of failed.slice(0, 6)) lines.push(`Face ${f.face} not meshed: ${f.issues[0] || 'unknown reason'}`);
      if (q.oddEdges?.length) lines.push(`Odd counts on edges ${q.oddEdges.slice(0, 8).join(', ')} lower quad quality on their faces.`);
      if (q.pads?.length) {
        // Pads as meshed, alike ones counted together: a through hole has one on each side.
        const kinds = new Map();
        for (const p of q.pads) { const key = `Ø${fmt(p.diameter, 3)} → ${fmt(p.size, 3)} mm, ${p.perSide}/side${p.shrunk ? ' (shrunk to fit)' : ''}`; kinds.set(key, (kinds.get(key) || 0) + 1); }
        lines.push(`Pads: ${[...kinds].map(([key, n]) => (n > 1 ? `${n} × ` : '') + key).join('; ')}`);
      }
      report = { text: lines.join('\n'), error: !!failed.length };
      engine().setCadVisible(false); engine().setCadSelectionMode('none'); hooks.render();
      hooks.message(`Shell mesh added: ${q.elements.toLocaleString()} elements, min scaled Jacobian ${q.minScaledJacobian.toFixed(3)}.`, !!failed.length);
    }
    function legacyBody() {
      const options = discrete() ? [['tet', 'Tetrahedral volume'], ['tri', 'Triangular surface']] : [['tet', 'Tetrahedral volume'], ['tri', 'Triangular surface'], ['quad', 'Quadrilateral surface'], ['sweep', 'Sweep quads → hex'], ['layered', 'Sweep partitioned columns']];
      let html = `<section class="cad-card"><div class="cad-card-title">Gmsh method</div>
        ${gmshReady() ? '' : `<p class="cad-note warn">${icon('warn')} ${esc(GMSH_MISSING)}</p>`}
        <label class="cad-field"><span>Method</span><select data-field="legacy-method">${options.map(([v, l]) => `<option value="${v}" ${legacy.method === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <div class="cad-row"><span class="cad-row-label">Order</span>${seg('mesh-order', [[1, 'Linear'], [2, 'Quadratic']], meshSettings.order, 'compact')}</div>
        ${numberField('legacy-size', legacy.method === 'sweep' || legacy.method === 'layered' ? 'Surface size' : 'Element size', round(Number(legacy.size) || defaultSize()), 'min="0"')}`;
      if (legacy.method === 'sweep') {
        html += `<div class="cad-size-row">${numberField('legacy-source', 'Source face', legacy.sourceFace, 'min="1" step="1"')}${numberField('legacy-target', 'Target face', legacy.targetFace, 'min="1" step="1" placeholder="auto"')}</div>
          <div class="cad-inline">${btn('legacy-use-source', 'Use picked as source', { cls: 'ghost small', disabled: !(selection.kind === 'face' && selection.ids.length === 1) })}${btn('legacy-use-target', 'as target', { cls: 'ghost small', disabled: !(selection.kind === 'face' && selection.ids.length === 1) })}</div>
          ${numberField('legacy-layers', 'Through layers', legacy.layers, 'min="1" max="80" step="1"')}`;
      }
      if (legacy.method === 'layered') {
        const plan = (session.topology.layeredSweeps || []).find(p => p.axis === legacy.sweepAxis);
        html += `<div class="cad-row"><span class="cad-row-label">Axis</span>${seg('legacy-axis', [['x', 'X'], ['y', 'Y'], ['z', 'Z']], legacy.sweepAxis, 'compact')}</div>`;
        if (plan) html += `<div class="cad-layer-head"><span>From</span><span>To</span><span>Layers</span></div>${plan.intervals.map((interval, i) => { const value = legacy.layerCounts[legacy.sweepAxis + i] ?? Math.max(1, Math.ceil((interval.end - interval.start) / Math.max(Number(legacy.size) || 1, 1e-9))); return `<div class="cad-layer-row"><span>${fmt(interval.start)}</span><span>${fmt(interval.end)}</span><input data-field="legacy-layer:${i}" type="number" min="1" max="80" step="1" value="${value}"></div>`; }).join('')}`;
        else html += `<p class="cad-note warn">Partition the solid with Project faces along this axis first.</p>`;
      }
      const locks = [...sizing.edges].filter(([, c]) => c.count).length, sizes = [...sizing.edges].filter(([, c]) => c.size).length;
      if (locks || sizes) html += `<p class="cad-note">Uses ${locks ? `${locks} fixed edge count${locks === 1 ? '' : 's'}` : ''}${locks && sizes ? ' and ' : ''}${sizes ? `${sizes} local edge size${sizes === 1 ? '' : 's'}` : ''} from Size.</p>`;
      return html + '</section>';
    }

    /* ----------------------------------------------------------- previews -- */
    const opKey = op => JSON.stringify(op);
    function clearPreview() {
      clearTimeout(previewTimer); previewTimer = null;
      previewState = { key: null, status: 'idle', data: null, error: null, analysis: null };
    }
    function setPending(operation, label, { immediate = false } = {}) {
      pending = operation ? { operation, label } : null;
      if (!pending) clearPreview();
      updatePendingOverlay();
      renderPart('cad-tool', toolCard);
      refreshFooter();
      if (pending) schedulePreview(immediate ? 0 : 200);
    }
    function refreshFooter() { const foot = document.getElementById('wb-panel-foot'); if (foot && active) { if (window.WebMeshDom) window.WebMeshDom.morph(foot, footer()); else foot.innerHTML = footer(); foot.querySelectorAll('button').forEach(el => { el.dataset.operation = 'true'; }); } }
    function schedulePreview(delay = 200) {
      clearTimeout(previewTimer);
      if (!pending) return;
      const valid = operationProblem(pending.operation);
      if (valid) { previewState = { key: opKey(pending.operation), status: 'error', data: null, error: valid, analysis: null }; refreshPending(); return; }
      previewTimer = setTimeout(runPreview, delay);
      if (previewState.key !== opKey(pending.operation)) { previewState = { ...previewState, status: 'running' }; refreshPending(); }
    }
    function operationProblem(op) {
      if (op.kind === 'defeature' && !op.faceIds?.length) return 'Choose features or faces to remove.';
      if (op.kind === 'project' && !op.faceIds?.length) return 'Pick the planar faces to project.';
      if (op.kind === 'project' && op.volumeIds?.some(id => !Number.isSafeInteger(id) || !analysis?.volumes.has(id))) return 'Enter existing target solid IDs, separated by commas.';
      if ((op.kind === 'passages') && !op.passages?.length) return 'Add a passage.';
      return null;
    }
    async function runPreview() {
      if (!pending || !session) return;
      if (previewPromise) { await previewPromise.catch(() => {}); if (!pending) return; }
      const operation = pending.operation, key = opKey(operation), revision = session.revision;
      if (previewState.key === key && previewState.status === 'ready') return;
      previewState = { key, status: 'running', data: null, error: null, analysis: null };
      refreshPending();
      const request = api('preview', { ...token(), operation });
      previewPromise = request;
      try {
        const data = await request;
        if (!pending || opKey(pending.operation) !== key || session.revision !== revision) return;
        previewState = { key, status: 'ready', data, error: null, analysis: H() && !data.topology.discrete ? H().analyze(data.topology) : null };
      } catch (error) {
        if (!pending || opKey(pending.operation) !== key) return;
        previewState = { key, status: 'error', data: null, error: error.message, analysis: null };
      } finally {
        if (previewPromise === request) previewPromise = null;
      }
      updatePendingOverlay(); refreshPending();
    }
    async function applyPending() {
      if (!pending) return;
      const operation = pending.operation, label = pending.label;
      const problem = operationProblem(operation); if (problem) throw Error(problem);
      clearTimeout(previewTimer);
      if (previewPromise) await previewPromise.catch(() => {});
      hooks.message('Applying geometry change…');
      const before = analysis?.summary;
      const data = await api('prepare', { ...token(), operation });
      pending = null; clearPreview();
      markStale();
      accept(data, { fit: false, keepStep: true });
      // The change is done: nothing from it stays armed for the next pick.
      closeTool();
      hooks.render();
      hooks.log(label || 'Prepared CAD');
      const after = analysis?.summary;
      hooks.message(`${label || 'Geometry updated'} · ${data.topology.volumes.length} solids${after ? ` · ${after.mappable}/${after.volumes} mappable${before ? ` (was ${before.mappable}/${before.volumes})` : ''}` : ''}.`);
    }

    /* ------------------------------------------------------------- tools -- */
    function openTool(next, seedDraft = null) {
      tool = tool === next && !seedDraft ? null : next;
      pending = null; clearPreview();
      if (tool === 'slice') {
        sliceDraft = seedDraft || sliceDraft || { origin: centerPoint(), normal: [1, 0, 0], scope: 'all', volumeIds: [] };
        if (seedDraft) sliceDraft = { scope: 'all', volumeIds: [], ...seedDraft };
        syncSlicePending();
      } else if (tool === 'cut') {
        if (!cutDraft) cutDraft = { segments: [], axis: [0, 0, 1], volumeIds: [], holders: [] };
        syncCutPending();
        if (pick !== 'edge' && pick !== 'vertex') setPick('edge');
      } else if (tool === 'features') {
        if (selection.kind === 'face') for (const f of selection.ids) { const feat = recognized?.byFace.get(f); if (feat) checkedFeatures.add(feat.id); }
        syncFeaturePending();
        setPick('face');
      } else if (tool === 'passages') {
        if (!passages.length) passages = [{ axis: 'x', center: centerPoint().map(round), width: span() / 10, height: span() / 10, range: [bounds()[0] - span() * 0.02, bounds()[3] + span() * 0.02] }];
        syncPassagePending();
      } else if (tool === 'project') {
        setPick('face');
        pending = { operation: { kind: 'project', axis: 'z', faceIds: selection.kind === 'face' ? selection.ids.slice() : [] }, label: 'Partition by projected faces' };
      } else if (tool === 'heal') pending = { operation: { kind: 'heal' }, label: 'Heal geometry' };
      else if (tool === 'surface') { surfaceDraft.picked = []; setPick('face'); }
      else if (tool === 'extend') { extendDraft.edges = []; setPick('edge'); }
      hooks.render();
      updatePendingOverlay();
      if (pending) schedulePreview(tool === 'heal' ? 0 : 300);
      document.getElementById('cad-tool')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }
    function centerPoint() { const b = bounds(); return [0, 1, 2].map(i => (b[i] + b[i + 3]) / 2); }
    function syncSlicePending() {
      const d = sliceDraft; if (!d) return;
      const n = unit(d.normal);
      const operation = { kind: 'slice', planes: [{ origin: d.origin.map(round), normal: n.map(round) }] };
      if (d.scope === 'solids' && d.volumeIds?.length) operation.volumeIds = d.volumeIds.slice();
      const axis = [0, 1, 2].find(i => Math.abs(Math.abs(n[i]) - 1) < 1e-9);
      operation.label = axis != null ? `Sliced at ${'XYZ'[axis]} = ${fmt(d.origin[axis], 6)}` : `Sliced with plane through (${d.origin.map(v => fmt(v, 4)).join(', ')})`;
      pending = { operation, label: operation.label };
    }
    function syncCutPending() {
      const d = cutDraft;
      if (!d || !d.segments.length || !F() || !recognized) { pending = null; clearPreview(); return; }
      const label = `Cut solid${d.volumeIds.length === 1 ? '' : 's'} ${d.volumeIds.join(', ')} along ${d.segments.length} segment${d.segments.length === 1 ? '' : 's'}`;
      const operation = F().cutOperation(recognized.ctx, d.segments, d.axis, d.volumeIds, label, d.holders);
      pending = operation ? { operation, label } : null;
      if (!pending) clearPreview();
    }
    function addToCut(cut) {
      const open = tool === 'cut' && cutDraft?.segments.length;
      if (open && Math.abs(Math.abs(dot(unit(cutDraft.axis), unit(cut.axis))) - 1) > 1e-6) throw Error('This cut would sweep in another direction. Apply or clear the current cut first.');
      if (!open) cutDraft = { segments: [], axis: cut.axis.slice(), volumeIds: [], holders: [] };
      const key = s => [s.a, s.b].map(p => p.map(v => v.toFixed(6)).join(',')).sort().join('|');
      const have = new Set(cutDraft.segments.map(key));
      for (const s of cut.segments) if (!have.has(key(s))) { cutDraft.segments.push({ a: s.a.slice(), b: s.b.slice(), source: s.source, ...(s.face != null ? { face: s.face } : {}) }); have.add(key(s)); }
      if (cutDraft.segments.length > 16) { cutDraft.segments.length = 16; hooks.message('A cut holds at most 16 segments; apply it and start another.', true); }
      cutDraft.volumeIds = [...new Set([...cutDraft.volumeIds, ...cut.volumeIds])].sort((a, b) => a - b);
      cutDraft.holders = [...new Set([...cutDraft.holders, ...(cut.faces || [])])];
      tool = 'cut';
      clearPreview(); syncCutPending();
      setSelection(null, []);
      hooks.render(); updatePendingOverlay();
      if (pending) schedulePreview(300);
    }
    function syncFeaturePending() {
      const faces = new Set((recognized?.features || []).filter(f => checkedFeatures.has(f.id)).flatMap(f => f.faces));
      if (selection.kind === 'face') for (const f of selection.ids) faces.add(f);
      pending = faces.size ? { operation: { kind: 'defeature', faceIds: [...faces].sort((a, b) => a - b) }, label: `Removed ${faces.size} feature face${faces.size === 1 ? '' : 's'}` } : null;
      if (!pending) clearPreview();
    }
    function syncPassagePending() {
      const faceIds = selection.kind === 'face' ? selection.ids.slice() : [];
      const list = passages.map(p => ({ axis: p.axis, center: p.center.map(Number), width: Number(p.width), height: Number(p.height), range: p.range.map(Number), ...(p.fit ? { fit: true } : {}) }));
      if (list.some(p => [...p.center, ...p.range, p.width, p.height].some(v => !Number.isFinite(v)))) { pending = null; return; }
      pending = { operation: { kind: 'passages', faceIds, passages: list }, label: `Cut ${list.length} rectangular passage${list.length === 1 ? '' : 's'}` };
    }
    function runInferred(action) {
      if (action.operation) {
        tool = null;
        pending = { operation: JSON.parse(JSON.stringify(action.operation)), label: action.operation.label || action.label };
        clearPreview(); hooks.render(); updatePendingOverlay(); schedulePreview(0);
        return;
      }
      if (action.tool === 'slice') { openTool('slice', { ...action.slice }); return; }
      if (action.tool === 'cut') { addToCut(action.cut); return; }
      if (action.tool === 'passages') {
        passages.push({ ...action.passage });
        tool = 'passages'; syncPassagePending(); hooks.render(); updatePendingOverlay(); schedulePreview(300);
      }
    }

    /* ------------------------------------------------------------- sizing -- */
    function resolve({ rerender = true } = {}) {
      solve();
      if(localPlan()?.affected.length&&!localPlan().all&&meshSettings.scope==='all')meshSettings.scope='affected';
      invalidateMesh();
      updateDisplay();
      if (rerender) {
        renderPart('cad-edge-editor', edgeEditor); renderPart('cad-impact', impactCard); renderPart('cad-tree', treeHtml); renderPart('cad-equations', equationsCard); renderPart('cad-context', contextCard);
        const title = document.querySelector('.cad-card-title small');
        if (title && step === 'size' && intervals) title.textContent = `≈ ${fmt(intervals.estimate, 3)} hex`;
        refreshStepChips(); refreshFooter();
      }
      if (step === 'mesh') scheduleMesh();
    }
    function refreshStepChips() {
      const conflicts = intervals?.conflicts.length || 0;
      const tab = document.querySelector('[data-act="step"][data-value="size"]');
      if (tab) { const old = tab.querySelector('.cad-chip'); if (old) old.outerHTML = conflicts ? chip(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`, 'bad') : chip('Solved', 'ok'); }
    }
    function selectedEdges() { return selection.kind === 'edge' ? selection.ids.filter(e => intervals?.counts.has(e)) : []; }
    function setEdgeCount(ids, valueFor) {
      for (const e of ids) {
        const current = sizing.edges.get(e) || {};
        const next = Math.max(1, Math.min(400, Math.round(valueFor(e))));
        sizing.edges.set(e, { ...current, count: next });
      }
      if (sizing.edges.size > MAX_CONTROLS) throw Error(`Use at most ${MAX_CONTROLS} edge controls.`);
      resolve();
    }

    /* --------------------------------------------------------------- mesh -- */
    function scheduleMesh(force = false) {
      clearTimeout(meshTimer);
      if (step !== 'mesh' || meshSettings.method !== 'mapped' || !analysis) return;
      if (!force && !meshSettings.live && !meshPreview) return;
      if (!force && (intervals?.estimate || 0) > 60000 && !meshPreview) return;
      meshTimer = setTimeout(() => { try { buildMeshPreview(); } catch (error) { hooks.message(error.message, true); } }, force ? 0 : 160);
    }
    function meshVolumes() {
      const plan=localPlan();
      if(meshSettings.scope==='affected')return plan?.affected||[];
      if(meshSettings.scope==='selected'){
        const chosen=selection.kind==='solid'?selection.ids.filter(id=>analysis.volumes.get(id)?.mappable):[];
        return [...new Set([...chosen,...(plan?.affected||[])])].sort((a,b)=>a-b);
      }
      return null;
    }
    function buildMeshPreview() {
      if (!analysis || !intervals) return;
      meshError = null;
      const started = performance.now();
      try {
        const volumes = meshVolumes();
        if (volumes && !volumes.length) throw Error('Pick one or more mappable solids, or mesh all mappable solids.');
        engine().setCadVisible(true);
        const result = H().generateMesh(analysis, intervals, geometry, { order: meshSettings.order, volumes, pidPerSolid: meshSettings.pidPerSolid });
        meshPreview = { result, display: meshDisplay(result), ms: Math.round(performance.now() - started) };
      } catch (error) { meshPreview = null; meshError = error.message; }
      updateSizingOverlays();
      updateMeshOverlay();
      renderPart('cad-mesh-report', meshReportCard);
      refreshFooter();
      const tab = document.querySelector('[data-act="step"][data-value="mesh"]');
      if (tab && !tab.querySelector('.cad-chip') && meshPreview) tab.insertAdjacentHTML('beforeend', chip('Preview', 'info'));
    }
    function meshDisplay(result) {
      // Boundary quads of the hex mesh, colored by element quality.
      const pos = new Map(result.nodes.map(n => [n.id, [n.x, n.y, n.z]]));
      const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
      const count = new Map(), owner = new Map();
      result.elements.forEach((e, index) => {
        for (const q of quads) {
          const ids = q.map(k => e.nodes[k]), key = ids.slice().sort((a, b) => a - b).join(':');
          count.set(key, (count.get(key) || 0) + 1); owner.set(key, [ids, index]);
        }
      });
      const faces = [], colors = [], edgeSet = new Set(), edges = [];
      for (const [key, n] of count) {
        if (n !== 1) continue;
        const [ids, index] = owner.get(key);
        const p = ids.map(id => pos.get(id)), c = qualityColor(result.quality.elementQuality[index]);
        for (const tri of [[0, 1, 2], [0, 2, 3]]) for (const k of tri) { faces.push(...p[k]); colors.push(...c); }
        for (let k = 0; k < 4; k++) {
          const a = ids[k], b = ids[(k + 1) % 4], ek = a < b ? a + ':' + b : b + ':' + a;
          if (!edgeSet.has(ek)) { edgeSet.add(ek); edges.push(...pos.get(a), ...pos.get(b)); }
        }
      }
      return { faces, colors, edges };
    }
    function savedSettings() {
      const hiddenKeys = display.hidden.size ? visibilityGeometry(topology()).solids : new Map();
      return { version: 2, step, sizing: { size: sizing.size, minCount: sizing.minCount, edges: [...sizing.edges].map(([id, c]) => ({ id, ...c })), solids: [...sizing.solids].map(([id,c])=>({id,...c})) },
        mesh: { ...meshSettings, ...(meshSettings.scope === 'selected' ? { selectedVolumes: meshVolumes() } : {}) }, legacy: JSON.parse(JSON.stringify(legacy)), shell: {...JSON.parse(JSON.stringify(shell)),...(shell.scope==='selected'?{selectedFaces:shellFaces()}: {})}, passages: JSON.parse(JSON.stringify(passages)), display: { color: display.color, seeds: display.seeds, labels: display.labels, groups: display.groups,
          hiddenSolids: [...display.hidden].map(id => hiddenKeys.get(id)).filter(Boolean), hiddenSheets: [...display.hiddenSheets] } };
    }
    function finishMappedMesh(result, localRemesh = false) {
      const q = result.quality;
      report = { text: `${localRemesh?'Local replacement · unchanged mesh retained\n':''}${result.nodes.length.toLocaleString()} nodes · ${result.elements.length.toLocaleString()} ${meshSettings.order === 2 ? 'HEX20' : 'HEX8'} elements\n${q.perVolume.length} mapped block${q.perVolume.length === 1 ? '' : 's'} · min scaled Jacobian ${q.minScaledJacobian.toFixed(4)} · max aspect ${fmt(q.maxAspect, 3)}\nNative transfinite mapping; shared CAD edges and faces give conforming interfaces.` };
      meshPreview = null; viewport()?.clearOverlays('mesh'); setBaseVisible(true);
      engine().setCadVisible(false); engine().setCadSelectionMode('none');
      hooks.render();
    }
    async function reviewOwnedMesh(kind, mesh, targets, extra, finish) {
      const previous=meshes.find(m=>m.projectOwner===editingOwner&&m.inModel!==false);
      if(previous&&previous.kind!==kind)throw Error('Use New mesh region for a different idealization, or edit the existing region with its original mesher.');
      const draft=JSON.stringify({token:token(),settings:savedSettings(),editingOwner,regionName}),file=source;
      const beforeCommit=()=>{if(source!==file||draft!==JSON.stringify({token:token(),settings:savedSettings(),editingOwner,regionName}))throw Error('The CAD draft changed. Discard this review and generate a new mesh review.');};
      const id=previous?.projectOwner||'cad-'+crypto.randomUUID(),name=regionName.trim()||source.name+(kind==='shell'?' · Shell mesh':' · Mapped mesh');
      const owners=engine().getProjectOwnership()?.project.objects||[];
      const sibling=meshes.map(m=>owners.find(o=>o.id===m.projectOwner)).find(Boolean);
      const snapshot={filename:source.name,content:base64(await source.arrayBuffer()),prepared:await api('export',token())};
      snapshot.prepared.history=[...auditHistory,...(snapshot.prepared.history||[])];beforeCommit();
      await hooks.reviewMappedMesh({id,name,part:partId,sourceId:sibling?.definition.source,kind:kind==='shell'?'shell':'solid',snapshot,topology:topology(),settings:savedSettings(),perSolid:meshSettings.pidPerSolid,[kind==='shell'?'faces':'volumes']:targets,mesh,...extra},{beforeCommit,onApplied(){
        localCache=null;
        const record={id:previous?.id??++meshCounter,kind,label:name,projectOwner:id,volumes:kind==='hex'?targets:[],faces:kind==='shell'?targets:[],stale:false,inModel:true};
        Object.assign(record,meshOwnership(record));meshes=[...meshes.filter(m=>m!==previous),record];editingOwner=id;regionName=name;finish();hooks.render();
      }});
    }
    async function addMesh() {
      if (!meshPreview) buildMeshPreview();
      if (!meshPreview) throw Error(meshError || 'The mapped mesh could not be generated.');
      const result = meshPreview.result, q = result.quality;
      if (q.inverted) throw Error(`${q.inverted} elements are inverted. Change edge counts or slice the solids before adding the mesh.`);
      const volumes = [...new Set(result.elements.map(e => e.volume))].sort((a, b) => a - b);
      if (reviewMapped(volumes)) {
        const plan=localPlan(),localRemesh=!!plan&&!plan.all&&meshSettings.scope!=='all'&&volumes.every(id=>plan.owner.definition.targets.includes(id))&&(plan.affected.length>0||volumes.length<plan.owner.definition.targets.length);
        let baselineMesh;
        if(localRemesh&&!plan.owner.definition.volumeElements){
          const d=plan.owner.definition;
          baselineMesh=H().generateMesh(analysis,window.WebMeshCadLocal.solve(analysis,d.settings),geometry,{order:d.settings.mesh?.order||1,volumes:d.targets,pidPerSolid:!!d.settings.mesh?.pidPerSolid});
        }
        await reviewOwnedMesh('hex', {nodes:result.nodes,elements:result.elements,faceNodes:result.faceNodes,edgeNodes:result.edgeNodes}, volumes, {localRemesh,baselineMesh}, ()=>finishMappedMesh(result,localRemesh));
        return;
      }
      await commitMesh({ kind: 'hex', volumes }, { mesh: { nodes: result.nodes, elements: result.elements.map(({ volume, ...e }) => e) }, log: '' }, { topology: 'hex', order: meshSettings.order },
        `Mapped ${meshSettings.order === 2 ? 'HEX20' : 'HEX8'} · ${volumes.length} solid${volumes.length === 1 ? '' : 's'}`);
      finishMappedMesh(result);
    }
    async function gmshMesh() {
      if (!gmshReady()) throw Error(GMSH_MISSING);
      const method = legacy.method, isHex = ['sweep', 'layered'].includes(method);
      const finite = (value, label) => { if (String(value).trim() === '' || !Number.isFinite(Number(value))) throw Error(`Enter a finite ${label}.`); return Number(value); };
      const payload = { ...token(), topology: isHex ? 'hex' : method, dimension: ['tri', 'quad'].includes(method) ? 2 : 3, order: Number(meshSettings.order), size: finite(legacy.size, 'element size'), divisions: 6 };
      if (isHex) payload.method = method;
      if (method === 'sweep') { payload.sourceFace = finite(legacy.sourceFace, 'source face ID'); payload.layers = finite(legacy.layers, 'layer count'); if (String(legacy.targetFace).trim()) payload.targetFace = finite(legacy.targetFace, 'target face ID'); }
      if (method === 'layered') {
        const plan = (session.topology.layeredSweeps || []).find(p => p.axis === legacy.sweepAxis);
        if (!plan) throw Error('Prepare constant-section columns along this axis before meshing.');
        payload.axis = legacy.sweepAxis;
        payload.layerCounts = plan.intervals.map((interval, i) => Number(legacy.layerCounts[legacy.sweepAxis + i] ?? Math.max(1, Math.ceil((interval.end - interval.start) / Math.max(Number(legacy.size) || 1, 1e-9)))));
      }
      if (!discrete()) {
        payload.edgeDivisions = [...sizing.edges].filter(([, c]) => c.count).slice(0, 256).map(([id, c]) => ({ id, divisions: c.count }));
        payload.edgeSizes = [...sizing.edges].filter(([, c]) => c.size && !c.count).slice(0, 256).map(([id, c]) => ({ id, size: c.size }));
        payload.faceSizes = [];
      }
      hooks.message('Generating and checking the Gmsh mesh…');
      const result = await api('mesh', payload);
      const surface = payload.dimension === 2, t = session.topology;
      await commitMesh({ kind: 'gmsh', ...(surface ? { faces: t.faces.map(f => f.id) } : { volumes: t.volumes.map(v => v.id) }) }, result, payload,
        `Gmsh ${({ tet: 'tet', tri: 'tri', quad: 'quad', sweep: 'swept hex', layered: 'layered hex' })[method] || method} · ${surface ? 'all faces' : 'all solids'}`);
      const q = result.quality || result.stats?.quality || {};
      report = { text: `${result.mesh.nodes.length.toLocaleString()} nodes · ${result.mesh.elements.length.toLocaleString()} elements${q.connectedComponents != null ? '\nConnected regions: ' + q.connectedComponents : q.components != null ? '\nConnected regions: ' + q.components : ''}${q.minScaledJacobian != null ? '\nMinimum scaled Jacobian: ' + Number(q.minScaledJacobian).toPrecision(4) : ''}${Array.isArray(q.achievedEdgeDivisions) && q.achievedEdgeDivisions.length ? '\nEdge divisions (requested → actual): ' + q.achievedEdgeDivisions.slice(0, 8).map(item => `${item.id}: ${item.requested} → ${item.achieved}`).join(', ') : ''}` };
      engine().setCadVisible(false); engine().setCadSelectionMode('none'); hooks.render();
    }

    /* ------------------------------------------------------------- events -- */
    function changeStep(next) {
      if (next === step) return;
      if (discrete() && next !== 'mesh') return;
      step = next; pending = null; clearPreview(); tool = next === 'prepare' ? tool : null;
      if (step === 'size' && pick !== 'edge') setPick('edge');
      if (step === 'mesh') { engine().setCadVisible(true); scheduleMesh(meshSettings.live); }
      else { meshPreview = null; meshError = null; }
      if (step === 'prepare' && (pick === 'edge') ) setPick('face');
      engine().setCadVisible(true);
      updateDisplay(); hooks.render();
    }
    function onClick(event) {
      if (!active) return;
      const el = event.target.closest('[data-act]');
      if (!el) return;
      // Stop works while Auto-fix holds the workspace busy.
      if (el.dataset.act === 'auto-stop') {
        if (autoState.running && autoState.controller && !autoState.stopping) { autoState.stopping = true; autoState.controller.abort(); renderReadiness(); }
        return;
      }
      if (el.disabled) return;
      if (hooks.isBusy?.()) return;
      const act = el.dataset.act, value = el.dataset.value;
      try {
        switch (act) {
          case 'import': if(partId&&hooks.replaceSource)hooks.replaceSource(partId);else document.getElementById('wb-cad-file').click(); break;
          case 'sessions': sessionsOpen = !sessionsOpen; closing = null; if (sessionsOpen) refreshSessions(); hooks.render(); break;
          case 'session-resume': hooks.run(() => resumeSession(value)); break;
          case 'session-close':
            // A second click confirms: closing deletes the session's undo steps.
            if (closing !== value) { closing = value; renderPart('cad-sessions', sessionsCard); break; }
            closing = null;
            hooks.run(async () => {
              sessionsInfo = await api('close', { cadId: value });
              if (session?.cadId === value) { clearAll(); hooks.render(); hooks.message('Session closed. Import CAD or resume another session.'); }
              else { renderPart('cad-sessions', sessionsCard); hooks.message('Session closed.'); }
            });
            break;
          case 'step': changeStep(value); break;
          case 'pick': setPick(value); renderPart('cad-context', contextCard); break;
          case 'clear-selection': setSelection(null, []); break;
          case 'infer': { const action = lastActions[Number(el.dataset.index)]; if (action) runInferred(action); break; }
          case 'tool': openTool(value); break;
          case 'cancel-pending': closeTool(); hooks.render(); break;
          case 'cut-remove': if (cutDraft) { cutDraft.segments.splice(Number(el.dataset.index), 1); syncCutPending(); renderPart('cad-tool', toolCard); updatePendingOverlay(); refreshFooter(); if (pending) schedulePreview(); } break;
          case 'cut-clear': if (cutDraft) { cutDraft.segments = []; cutDraft.volumeIds = []; cutDraft.holders = []; syncCutPending(); hooks.render(); updatePendingOverlay(); } break;
          case 'apply-pending': hooks.run(applyPending); break;
          case 'auto-fix': pending = null; clearPreview(); updatePendingOverlay(); hooks.run(autoFix); break;
          case 'auto-keep': keepAutoFix(); break;
          case 'auto-discard': hooks.run(discardAutoFix); break;
          case 'undo': hooks.run(() => moveHistory('undo')); break;
          case 'redo': hooks.run(() => moveHistory('redo')); break;
          case 'history-go': hooks.run(() => moveHistory('revert', Number(el.dataset.index))); break;
          case 'toggle-visible': { const id = Number(el.dataset.id); display.hidden.has(id) ? display.hidden.delete(id) : display.hidden.add(id); updateDisplay(); updateViewTools(); renderPart('cad-tree', treeHtml); break; }
          case 'tree-filter': event.preventDefault(); treeFilter = value; renderPart('cad-tree', treeHtml); break;
          case 'toggle-result': display.showResult = !display.showResult; updatePendingOverlay(); refreshPending(); break;
          case 'select-solid': if (pick !== 'auto') setPick('solid'); setSelection('solid', [Number(el.dataset.id)], { additive: event.shiftKey || event.metaKey || event.ctrlKey }); break;
          case 'expand': expanded[value] = !expanded[value]; hooks.render(); break;
          case 'isolate': { const ids = selectedSolids(); if (ids.length) { display.hidden = new Set(session.topology.volumes.map(v => v.id).filter(id => !ids.includes(id))); updateDisplay(); updateViewTools(); renderPart('cad-context', contextCard); renderPart('cad-tree', treeHtml); } break; }
          case 'hide-selected': { const ids = selectedSolids(); if (ids.length) { ids.forEach(id => display.hidden.add(id)); setSelection(null, []); updateDisplay(); updateViewTools(); renderPart('cad-tree', treeHtml); } break; }
          case 'show-all': event.preventDefault(); display.hidden = new Set(); updateDisplay(); updateViewTools(); renderPart('cad-context', contextCard); renderPart('cad-tree', treeHtml); break;
          case 'slice-axis': {
            if (value === 'custom') { sliceDraft.normal = sliceDraft.normal.map(v => v + 1e-3); sliceDraft.normal = unit([sliceDraft.normal[0] || 1, sliceDraft.normal[1] + 0.3, sliceDraft.normal[2]]); }
            else { const n = [0, 0, 0]; n['xyz'.indexOf(value)] = 1; sliceDraft.normal = n; }
            sliceDraft.along = null; syncSlicePending(); refreshSlice(true); break;
          }
          case 'slice-flip': sliceDraft.normal = sliceDraft.normal.map(v => -v); syncSlicePending(); refreshSlice(true); break;
          case 'slice-scope': sliceDraft.scope = value; if (value === 'solids' && selection.kind === 'solid' && !sliceDraft.volumeIds?.length) sliceDraft.volumeIds = selection.ids.slice(); syncSlicePending(); refreshSlice(true); break;
          case 'slice-use-selection': if (selection.kind === 'solid') { sliceDraft.volumeIds = selection.ids.slice(); syncSlicePending(); refreshSlice(true); } break;
          case 'feature-filter': featureFilter = value; renderPart('cad-tool', toolCard); break;
          case 'feature-check': break;
          case 'features-all': (recognized?.features || []).filter(f => featureFilter === 'all' || f.kind === featureFilter).forEach(f => checkedFeatures.add(f.id)); syncFeaturePending(); afterFeatureChange(); break;
          case 'features-none': checkedFeatures = new Set(); syncFeaturePending(); afterFeatureChange(); break;
          case 'features-max': {
            const limit = Number(document.querySelector('[data-field="feature-max"]')?.value);
            if (!(limit > 0)) throw Error('Enter a size limit (diameter for holes, radius for fillets, width for chamfers).');
            for (const f of recognized?.features || []) if ((featureFilter === 'all' || f.kind === featureFilter) && (f.diameter ?? f.radius ?? f.width ?? Infinity) <= limit) checkedFeatures.add(f.id);
            syncFeaturePending(); afterFeatureChange(); break;
          }
          case 'features-passages': {
            const holes = (recognized?.features || []).filter(f => checkedFeatures.has(f.id) && f.kind === 'hole');
            if (!holes.length) break;
            passages = holes.map(f => F().squarePassage(recognized.ctx, f));
            checkedFeatures = new Set(); tool = 'passages';
            pending = { operation: { kind: 'passages', faceIds: holes.flatMap(f => f.faces), passages: JSON.parse(JSON.stringify(passages)) }, label: `Replaced ${holes.length} hole${holes.length === 1 ? '' : 's'} with square passages` };
            clearPreview(); hooks.render(); updatePendingOverlay(); schedulePreview(0);
            break;
          }
          case 'feature-locate': { event.preventDefault(); const f = recognized.features.find(x => x.id === el.dataset.id); if (f) { setPick('face'); setSelection('face', f.faces); } break; }
          case 'passage-axis': { const [i, axis] = value.split(':'); passages[Number(i)].axis = axis; syncPassagePending(); renderPart('cad-tool', toolCard); updatePendingOverlay(); schedulePreview(); break; }
          case 'passage-remove': passages.splice(Number(el.dataset.index), 1); syncPassagePending(); renderPart('cad-tool', toolCard); updatePendingOverlay(); refreshFooter(); if (pending) schedulePreview(); else clearPreview(); break;
          case 'passage-add': if (passages.length >= 24) throw Error('Use at most 24 passages per operation.'); passages.push({ axis: 'x', center: centerPoint().map(round), width: span() / 10, height: span() / 10, range: [bounds()[0] - span() * 0.02, bounds()[3] + span() * 0.02] }); syncPassagePending(); renderPart('cad-tool', toolCard); updatePendingOverlay(); schedulePreview(); break;
          case 'project-axis': if (pending?.operation.kind === 'project') { pending.operation.axis = value; renderPart('cad-tool', toolCard); schedulePreview(); } break;
          case 'project-targets': {
            if (pending?.operation.kind !== 'project') break;
            if (selection.kind !== 'solid' || !selection.ids.length) { hooks.message('Pick the target solids, then choose Use selected solids.'); break; }
            pending.operation.volumeIds = selection.ids.slice(); setPick('face'); renderPart('cad-tool', toolCard); updatePendingOverlay(); schedulePreview(); break;
          }
          case 'project-floors': {
            const axis = 'xyz'.indexOf(pending?.operation.axis || 'z'), b = bounds(), tol = Math.max(1e-5, (b[axis + 3] - b[axis]) * 1e-8);
            const floors = session.topology.faces.filter(face => face.type === 'Plane' && face.bounds[axis + 3] - face.bounds[axis] < tol && face.center[axis] > b[axis] + tol && face.center[axis] < b[axis + 3] - tol && (face.normal?.[axis] || 0) > 0).map(f => f.id);
            setPick('face'); setSelection('face', floors); hooks.message(`Selected ${floors.length} internal floor faces.`); break;
          }
          case 'display': display[value] = !display[value]; el.setAttribute('aria-pressed', String(display[value])); updateDisplay(); break;
          case 'count-step': { const ids = selectedEdges(); if (!ids.length) break; setEdgeCount(ids, e => (intervals.locked.get(e) ?? intervals.counts.get(e)) + Number(value)); break; }
          case 'lock': {
            const ids = selectedEdges(); if (!ids.length) break;
            const allLocked = ids.every(e => intervals.locked.has(e));
            for (const e of ids) { const c = sizing.edges.get(e) || {}; if (allLocked) { delete c.count; if (c.size) sizing.edges.set(e, c); else sizing.edges.delete(e); } else sizing.edges.set(e, { ...c, count: intervals.counts.get(e) }); }
            resolve(); break;
          }
          case 'edge-reset': for (const e of selectedEdges()) sizing.edges.delete(e); resolve(); break;
          case 'select-group': { const g = intervals?.groups[Number(el.dataset.index)]; if (g) { setPick('edge'); setSelection('edge', g.edges); } break; }
          case 'select-edges': setPick('edge'); setSelection('edge', el.dataset.edges.split(',').map(Number)); break;
          case 'show-conflict': { const c = intervals?.conflicts[Number(el.dataset.index)]; if (c) { setPick('edge'); setSelection('edge', c.edges || []); } break; }
          case 'solid-reset': for(const id of selectedSolids())sizing.solids.delete(id);resolve();break;
          case 'impact-solid': setSelection('solid',[Number(el.dataset.id)]);break;
          case 'remesh-affected': meshSettings.scope='affected';changeStep('mesh');break;
          case 'mesh-method': meshSettings.method = value; meshPreview = null; meshError = null; updateDisplay(); hooks.render(); if (value === 'mapped') scheduleMesh(meshSettings.live); break;
          case 'mesh-order': meshSettings.order = Number(value); invalidateMesh(); hooks.render(); scheduleMesh(); break;
          case 'mesh-scope': meshSettings.scope = value; invalidateMesh(); hooks.render(); scheduleMesh(); break;
          case 'mesh-pid': meshSettings.pidPerSolid = value === 'solid'; invalidateMesh(); hooks.render(); scheduleMesh(); break;
          case 'mesh-preview': buildMeshPreview(); break;
          case 'mesh-add': hooks.run(addMesh); break;
          case 'gmsh-mesh': hooks.run(async () => { try { await gmshMesh(); } catch (error) { report = { error: true, text: error.message }; hooks.render(); throw error; } }); break;
          case 'mesh-new': editingOwner=null;regionName='';hooks.render();break;
          case 'mesh-edit': hooks.editMeshOwner?.(value);break;
          case 'shell-mesh': hooks.run(async () => { try { await shellMesh(); } catch (error) { report = { error: true, text: error.message }; hooks.render(); throw error; } }); break;
          case 'shell-element': shell.element = value; hooks.render(); break;
          case 'shell-mesher': shell.mesher = value; hooks.render(); break;
          case 'shell-placement': shell.placement = value; hooks.render(); break;
          case 'shell-scope': shell.scope = value; hooks.render(); break;
          case 'shell-pid': shell.pidPerFace = value === 'face'; hooks.render(); break;
          case 'shell-side': {
            const picked = selection.kind === 'face' ? selection.ids.slice() : [];
            if (value === 'a') { shell.faces = picked; shell.facesB = shell.facesB.filter(f => !picked.includes(f)); }
            else { shell.facesB = picked; shell.faces = shell.faces.filter(f => !picked.includes(f)); }
            hooks.render(); break;
          }
          case 'shell-grow': shell.faces = F().tangentSide(session.topology, shell.faces); shell.facesB = shell.facesB.filter(f => !shell.faces.includes(f)); setSelection('face', shell.faces); hooks.render(); hooks.message(`Side A: ${shell.faces.length} faces.`); break;
          case 'shell-opposite': {
            const found = F().oppositeSide(session.topology, shell.faces);
            shell.facesB = found.faces; setSelection('face', shell.facesB); hooks.render();
            hooks.message(found.missing.length ? `Side B: ${found.faces.length} faces. No opposite face found for face${found.missing.length === 1 ? '' : 's'} ${found.missing.join(', ')}; pick side B by hand.` : `Side B: ${found.faces.length} faces.`, !!found.missing.length);
            break;
          }
          case 'shell-show': setPick('face'); setSelection('face', value === 'b' ? shell.facesB : shell.faces); hooks.render(); break;
          case 'shell-half': shell.offset = -Number(shell.thickness) / 2; hooks.render(); break;
          case 'shell-pad-add': {
            const holes = pickedHoles();
            for (const hole of holes) {
              const pad = { faces: hole.faces.map(Number).sort((a, b) => a - b), diameter: hole.diameter, size: shell.padSize, perSide: shell.padSide };
              const at = shell.pads.findIndex(p => p.faces.some(f => pad.faces.includes(f)));
              if (at >= 0) shell.pads[at] = pad; else shell.pads.push(pad);
            }
            hooks.render(); hooks.message(`${holes.length} pad${holes.length === 1 ? '' : 's'} set; ${shell.pads.length} in all.`); break;
          }
          case 'shell-pad-remove': shell.pads.splice(Number(value), 1); hooks.render(); break;
          case 'surface-mode': surfaceDraft.mode = value; surfaceDraft.picked = []; renderPart('cad-tool', toolCard); break;
          case 'surface-place': surfaceDraft.place = value; renderPart('cad-tool', toolCard); break;
          case 'extend-target': setPick('face'); renderPart('cad-tool', toolCard); break;
          case 'sheets-join': hooks.run(() => applySheetOperation({ kind: 'join' }, `Joined ${sheetGroups().length} sheets`)); break;
          case 'select-sheet': { const s = sheetGroups().find(g => g.sheet === Number(el.dataset.id)); if (s) { setPick('face'); setSelection('face', s.faces); } break; }
          case 'toggle-sheet': { const id = Number(el.dataset.id); display.hiddenSheets.has(id) ? display.hiddenSheets.delete(id) : display.hiddenSheets.add(id); updateDisplay(); renderPart('cad-tree', treeHtml); break; }
          case 'sheet-apply': {
            const e = sheetEdit; if (!e) break;
            const operation = { kind: 'sheet', sheet: e.sheet, thickness: Number(e.thickness) > 0 ? Number(e.thickness) : null, offset: Number(e.offset) || 0, ...(e.name?.trim() ? { name: e.name.trim() } : {}) };
            hooks.run(() => applySheetOperation(operation, `Edited sheet ${e.sheet}`)); break;
          }
          case 'sheet-split': {
            const s = sheetGroups().find(g => g.sheet === sheetEdit?.sheet); if (!s) break;
            const plane = session.topology.faces.find(x => x.id === s.faces[0])?.surface; if (plane?.kind !== 'plane') break;
            const others = sheetRecords().filter(r => r.sheet !== s.sheet).map(r => r.face);
            hooks.run(() => applySheetOperation({ kind: 'split-sheets', plane: { origin: plane.origin, normal: plane.normal }, faces: others }, `Split sheets along the plane of ${s.label}`)); break;
          }
          case 'sheet-remove': {
            const id = sheetEdit?.sheet; if (id == null) break;
            if (removingSheet !== id) { removingSheet = id; renderPart('cad-context', contextCard); break; }
            const all = sheetGroups().find(g => g.sheet === id)?.faces || [], picked = selection.ids.filter(f => all.includes(f));
            removingSheet = null; sheetEdit = null;
            if (picked.length && picked.length < all.length) hooks.run(() => applySheetOperation({ kind: 'sheet', sheet: id, remove: true, faces: picked }, `Removed ${picked.length} face${picked.length === 1 ? '' : 's'} of sheet ${id}`));
            else hooks.run(() => applySheetOperation({ kind: 'sheet', sheet: id, remove: true }, `Removed sheet ${id}`));
            break;
          }
          case 'mesh-remove': {
            // A second click confirms: the mesh leaves the model (undo brings it back).
            const id = Number(value), m = meshes.find(x => x.id === id);
            if (m && m.inModel !== false && removing !== id) { removing = id; renderPart('cad-meshes', meshesCard); break; }
            removing = null;
            hooks.run(async () => { const pending = await removeMesh(id); hooks.render(); if (!pending) hooks.message(m?.inModel === false ? 'Dropped the mesh from the list.' : 'Removed the mesh from the model.'); });
            break;
          }
          case 'shell-pad-clear': shell.pads = []; hooks.render(); break;
          case 'shell-pad-show': setPick('face'); setSelection('face', [...new Set(shell.pads.flatMap(p => p.faces))]); hooks.render(); break;
          case 'legacy-axis': legacy.sweepAxis = value; hooks.render(); break;
          case 'legacy-use-source': case 'legacy-use-target': if (selection.kind === 'face' && selection.ids.length === 1) { legacy[act === 'legacy-use-source' ? 'sourceFace' : 'targetFace'] = selection.ids[0]; hooks.render(); } break;
          default: break;
        }
      } catch (error) { hooks.message(error.message || String(error), true); }
    }
    function invalidateMesh() { meshPreview = null; markStale(true); viewport()?.clearOverlays('mesh'); setBaseVisible(true); }
    function afterFeatureChange() { renderPart('cad-tool', toolCard); updatePendingOverlay(); refreshFooter(); if (pending) schedulePreview(); }
    function refreshSlice(rerender) {
      if (rerender) renderPart('cad-tool', toolCard);
      else {
        const num = document.querySelector('[data-field="slice-offset"]'), slider = document.querySelector('[data-field="slice-slider"]');
        const offset = dot(sliceDraft.origin, unit(sliceDraft.normal));
        if (num && document.activeElement !== num) num.value = round(offset);
        if (slider && document.activeElement !== slider) slider.value = offset;
      }
      updatePendingOverlay(); refreshFooter(); schedulePreview(500);
    }
    function moveSlice(offset, snap = true) {
      const n = unit(sliceDraft.normal);
      let target = offset;
      if (snap) {
        const tol = span() * 0.006;
        for (const v of session.topology.vertices || []) { const d = dot(v.point, n); if (Math.abs(d - offset) < tol) { target = d; break; } }
      }
      const current = dot(sliceDraft.origin, n);
      sliceDraft.origin = sliceDraft.origin.map((v, i) => v + (target - current) * n[i]);
      syncSlicePending();
    }
    function onInput(event, kind) {
      if (!active) return;
      const el = event.target.closest('[data-field]'); if (!el) return;
      const field = el.dataset.field, value = el.type === 'checkbox' ? el.checked : el.value;
      if(field==='region-name'){regionName=value;return;}
      try {
        if (field === 'project-solids' && kind === 'change' && pending?.operation.kind === 'project') {
          pending.operation.volumeIds = [...new Set(String(value).trim().split(/[\s,]+/).filter(Boolean).map(Number))];
          updatePendingOverlay(); schedulePreview(); return;
        }
        if (field === 'slice-slider') { moveSlice(Number(value), true); refreshSlice(false); return; }
        if (field === 'slice-offset' && Number.isFinite(Number(value)) && String(value).trim() !== '') { moveSlice(Number(value), false); refreshSlice(false); return; }
        if (field === 'slice-along' && sliceDraft?.along) {
          const { start, end } = sliceDraft.along, t = Number(value);
          sliceDraft.origin = start.map((v, i) => v + (end[i] - v) * t); syncSlicePending();
          const label = el.parentElement?.querySelector('.cad-mono'); if (label) label.textContent = Math.round(t * 100) + '%';
          refreshSlice(false); return;
        }
        if (/^slice-n\d$/.test(field) && kind === 'change') {
          const n = [0, 1, 2].map(i => Number(document.querySelector(`[data-field="slice-n${i}"]`)?.value) || 0);
          if (norm(n) > 0) { sliceDraft.normal = unit(n); syncSlicePending(); refreshSlice(false); }
          return;
        }
        if (field.startsWith('passage:')) {
          const [, index, key, component] = field.split(':'), p = passages[Number(index)];
          if (!p) return;
          if (component != null) p[key][Number(component)] = Number(value); else p[key] = Number(value);
          syncPassagePending(); updatePendingOverlay(); refreshFooter(); if (pending) schedulePreview(); return;
        }
        if (field === 'size' || field === 'size-slider') {
          const size = field === 'size' ? Number(value) : 10 ** Number(value);
          if (!(size > 0)) return;
          sizing.size = field === 'size' ? size : Number(size.toPrecision(3));
          if (field === 'size-slider') { const input = document.querySelector('[data-field="size"]'); if (input) input.value = sizing.size; }
          else { const slider = document.querySelector('[data-field="size-slider"]'); if (slider) slider.value = Math.log10(size); }
          resolve(); return;
        }
        if (field === 'min-count' && kind === 'change') { sizing.minCount = Math.max(1, Math.round(Number(value) || 1)); resolve(); return; }
        if (field === 'count' && kind === 'change') { const n = Number(value); if (Number.isInteger(n) && n > 0) setEdgeCount(selectedEdges(), () => n); return; }
        if (field === 'edge-size' && kind === 'change') {
          const s = Number(value);
          for (const e of selectedEdges()) { const c = sizing.edges.get(e) || {}; if (s > 0) sizing.edges.set(e, { ...c, size: s }); else { delete c.size; if (c.count) sizing.edges.set(e, c); else sizing.edges.delete(e); } }
          resolve(); return;
        }
        if(field==='solid-size'&&kind==='change'){
          const size=Number(value);for(const id of selectedSolids()){if(size>0&&Number.isFinite(size))sizing.solids.set(id,{size});else sizing.solids.delete(id);}resolve();return;
        }
        if (field === 'auto-blends') { autoState.blends = !!value; return; }
        if (field === 'auto-holes') { autoState.holes = !!value; return; }
        if (field === 'mesh-live') { meshSettings.live = !!value; if (value) scheduleMesh(); return; }
        if(['shell-size','shell-circle','shell-offset','shell-thickness'].includes(field))markStale(true);
        if (field === 'shell-size') { shell.size = Number(value) > 0 ? Number(value) : null; return; }
        if (field === 'shell-circle') { shell.perCircle = Math.max(4, Math.min(128, Math.round(Number(value) || 12))); return; }
        if (field === 'shell-offset') { shell.offset = Number(value); return; }
        if (field === 'shell-thickness') { shell.thickness = Number(value); return; }
        if (field === 'shell-pad-size') { shell.padSize = Number(value) > 0 ? Number(value) : null; return; }
        if (field === 'surface-offset') { surfaceDraft.offset = Number(value) || 0; return; }
        if (field === 'surface-thickness') { surfaceDraft.thickness = Number(value) > 0 ? Number(value) : null; return; }
        if (field === 'sheet-thickness') { if (sheetEdit) sheetEdit.thickness = Number(value) > 0 ? Number(value) : null; return; }
        if (field === 'sheet-offset') { if (sheetEdit) sheetEdit.offset = Number(value) || 0; return; }
        if (field === 'sheet-name') { if (sheetEdit) sheetEdit.name = String(value); return; }
        if (field === 'shell-pad-side') { const n = Math.round(Number(value)); shell.padSide = n >= 2 ? Math.min(64, n) : null; return; }
        if (field === 'legacy-method' && kind === 'change') { legacy.method = value; hooks.render(); return; }
        if (field === 'legacy-size') { legacy.size = Number(value); return; }
        if (field === 'legacy-source') { legacy.sourceFace = value; return; }
        if (field === 'legacy-target') { legacy.targetFace = value; return; }
        if (field === 'legacy-layers') { legacy.layers = Number(value); return; }
        if (field.startsWith('legacy-layer:')) { legacy.layerCounts[legacy.sweepAxis + field.split(':')[1]] = Number(value); return; }
      } catch (error) { hooks.message(error.message, true); }
    }
    function onChangeEvent(event) {
      if (!active) return;
      const box = event.target.closest('[data-act="feature-check"]');
      if (box) { box.checked ? checkedFeatures.add(box.dataset.id) : checkedFeatures.delete(box.dataset.id); box.closest('.cad-feature')?.classList.toggle('checked', box.checked); syncFeaturePending(); renderPart('cad-tool', toolCard); updatePendingOverlay(); refreshFooter(); if (pending) schedulePreview(); return; }
      const details = event.target.closest('details[data-expand]');
      if (details) expanded[details.dataset.expand] = details.open;
      onInput(event, 'change');
    }
    function onHoverRow(event) {
      if (!active) return;
      const vp = viewport(); if (!vp) return;
      const segment = event.target.closest('[data-hover-points]');
      if (segment && event.type === 'mouseover') { vp.setOverlay('hover-segment', { type: 'lines', positions: segment.dataset.hoverPoints.split(',').map(Number), color: 0xffd54a, depthTest: false, renderOrder: 16 }); return; }
      if (event.type === 'mouseout' && !event.relatedTarget?.closest?.('[data-hover-points]')) vp.clearOverlay('hover-segment');
      const row = event.target.closest('[data-hover-faces]');
      if (row && event.type === 'mouseover') vp.setOverlay('hover-faces', { type: 'faces', faces: row.dataset.hoverFaces.split(',').map(Number), color: 0xffd54a, opacity: 0.6, depthTest: false, renderOrder: 8 });
      else if (event.type === 'mouseout' && (!event.relatedTarget || !event.relatedTarget.closest?.('[data-hover-faces]'))) vp.clearOverlay('hover-faces');
    }
    function onResizeStart(event) {
      const handle = event.target.closest?.('[data-resize="tree"]'); if (!handle) return;
      const split = handle.parentElement, box = split.getBoundingClientRect();
      event.preventDefault();
      handle.setPointerCapture?.(event.pointerId);
      const move = e => { treeShare = Math.max(0.15, Math.min(0.85, (e.clientY - box.top) / box.height)); split.style.setProperty('--tree-share', treeShare); };
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); try { localStorage.setItem('webmesh.cad.treeShare', String(treeShare)); } catch { /* storage unavailable */ } };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
    }
    function onKey(event) {
      if (!active || !session || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
      // Ctrl/Cmd+Z undoes geometry changes while preparing and sizing (the model's
      // own history takes over in the Mesh step, where meshes are added).
      if ((event.metaKey || event.ctrlKey) && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase()) && historyActive()) {
        event.preventDefault(); event.stopPropagation();
        if (!hooks.isBusy?.()) { const redo = event.key.toLowerCase() === 'y' || event.shiftKey; if (redo ? canRedo() : canUndo()) hooks.run(() => moveHistory(redo ? 'redo' : 'undo')); }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (document.querySelector('dialog[open]')) return;
      const key = event.key;
      if (['0', '1', '2', '3', '4'].includes(key) && !discrete()) { setPick(['auto', 'solid', 'face', 'edge', 'vertex'][Number(key)]); renderPart('cad-context', contextCard); event.preventDefault(); return; }
      if (key === 'Escape') { if (pending || tool) { closeTool(); hooks.render(); } else setSelection(null, []); event.preventDefault(); return; }
      if (key === 'Enter' && pending && step === 'prepare' && !hooks.isBusy?.()) { hooks.run(applyPending); event.preventDefault(); return; }
      if (step === 'size' && selectedEdges().length) {
        const current = e => intervals.locked.get(e) ?? intervals.counts.get(e);
        if (key === '+' || key === '=') { setEdgeCount(selectedEdges(), e => current(e) + 1); event.preventDefault(); return; }
        if (key === '-' || key === '_') { setEdgeCount(selectedEdges(), e => current(e) - 1); event.preventDefault(); return; }
        if (key.toLowerCase() === 'l') { document.querySelector('[data-act="lock"]')?.click(); event.preventDefault(); return; }
      }
      if (key.toLowerCase() === 'h') { if (event.shiftKey) display.hidden = new Set(); else if (selectedSolids().length) { selectedSolids().forEach(id => display.hidden.add(id)); setSelection(null, []); } updateDisplay(); updateViewTools(); renderPart('cad-tree', treeHtml); event.preventDefault(); return; }
      if (key.toLowerCase() === 'x') { display.xray = !display.xray; updateDisplay(); updateViewTools(); event.preventDefault(); }
    }

    /* ----------------------------------------------------- viewport chrome -- */
    function ensureViewTools() {
      const host = document.getElementById('viewport');
      if (!host || viewTools) return;
      viewTools = document.createElement('div');
      viewTools.className = 'cad-view-tools';
      host.appendChild(viewTools);
      viewTools.addEventListener('click', event => {
        const el = event.target.closest('[data-view]'); if (!el) return;
        const v = el.dataset.view;
        if (v === 'xray') display.xray = !display.xray;
        else if (v === 'show-all') display.hidden = new Set();
        else if (['status', 'solid', 'plain'].includes(v)) display.color = v;
        else if (['auto-pick', 'solid-pick', 'face-pick', 'edge-pick', 'vertex-pick'].includes(v)) { setPick(v.split('-')[0]); renderPart('cad-context', contextCard); }
        updateDisplay(); updateViewTools();
      });
      tooltip = document.createElement('div'); tooltip.className = 'cad-tooltip'; host.appendChild(tooltip);
    }
    function updateViewTools() {
      if (!viewTools) return;
      const show = active && !!session && engine()?.getCadState?.().visible !== false;
      viewTools.hidden = !show;
      if (!show) return;
      viewTools.innerHTML = `<div class="cad-vt-group">${[['auto', 'target', 'Pick the nearest point, edge or face'], ['solid', 'solid'], ['face', 'face'], ['edge', 'edge'], ['vertex', 'vertex']].map(([k, i, title]) => `<button type="button" data-view="${k}-pick" aria-pressed="${pick === k}" title="${title || `Pick ${k}s`}">${icon(i)}</button>`).join('')}</div>
        <div class="cad-vt-group">${[['status', 'Status'], ['solid', 'Solids'], ['plain', 'Plain']].map(([k, l]) => `<button type="button" data-view="${k}" aria-pressed="${display.color === k}">${l}</button>`).join('')}</div>
        <div class="cad-vt-group"><button type="button" data-view="xray" aria-pressed="${display.xray}" title="X-ray (X)">${icon('xray')}</button>${display.hidden.size ? `<button type="button" data-view="show-all" title="Show all solids (Shift+H)">${icon('eye')}<span>${display.hidden.size} hidden</span></button>` : ''}</div>`;
    }
    function onHover(event) {
      if (!tooltip) return;
      const { hit, x, y } = event.detail || {};
      if (!active || !hit || !session) { tooltip.hidden = true; return; }
      const host = document.getElementById('viewport').getBoundingClientRect();
      tooltip.innerHTML = hoverText(hit);
      tooltip.hidden = false;
      tooltip.style.transform = `translate(${Math.min(x - host.left + 14, host.width - 240)}px, ${Math.max(0, y - host.top + 16)}px)`;
    }
    function hoverText(hit) {
      const t = session.topology;
      if (hit.kind === 'face') {
        const f = t.faces.find(x => x.id === hit.id), feat = recognized?.byFace.get(hit.id), info = analysis?.faces.get(hit.id);
        return `<b>Face ${hit.id}</b> · ${esc(feat ? feat.label : f?.surface?.kind === 'cylinder' ? `Cylinder R${fmt(f.surface.radius)}` : f?.type || 'Surface')}${info ? `<br><span class="${info.mappable ? 'ok' : 'bad'}">${info.mappable ? '4-sided' : esc(info.message.replace(/^Face \d+ /, ''))}</span>` : ''}`;
      }
      if (hit.kind === 'edge') {
        const e = t.edges.find(x => x.id === hit.id);
        let extra = '';
        if (intervals?.counts.has(hit.id) && step !== 'prepare') { const g = intervals.groups.find(g => g.edges.includes(hit.id)); extra = `<br>n = <b>${intervals.counts.get(hit.id)}</b>${intervals.locked.has(hit.id) ? ' (fixed)' : ''}${g ? ` · group ${g.label}` : ''}`; }
        else { const angles = (t.volumes || []).map(v => (v.edgeAngles || []).find(([id]) => id === hit.id)).filter(Boolean); if (angles.length) extra = '<br>' + angles.map(([, a]) => a == null ? '?' : `${Math.round(a)}°`).join(' / '); }
        return `<b>Edge ${hit.id}</b> · ${esc(e?.type || 'Curve')} L ${fmt(e?.length)}${extra}`;
      }
      if (hit.kind === 'vertex') return `<b>Vertex ${hit.id}</b><br>${hit.point.map(v => fmt(v, 5)).join(', ')}`;
      if (hit.kind === 'solid') {
        const v = analysis?.volumes.get(hit.id);
        return `<b>Solid ${hit.id}</b>${v ? `<br><span class="${v.mappable ? 'ok' : 'bad'}">${v.mappable ? 'Mapped block ✓' : esc(shortReason(v))}</span>` : ''}`;
      }
      return '';
    }

    function bind() {
      if (!bound) {
        bound = true;
        for (const id of ['wb-panel-body', 'wb-panel-foot']) {
          const el = document.getElementById(id); if (!el) continue;
          el.addEventListener('click', onClick);
          el.addEventListener('input', event => onInput(event, 'input'));
          el.addEventListener('change', onChangeEvent);
          el.addEventListener('mouseover', onHoverRow);
          el.addEventListener('mouseout', onHoverRow);
          // Remember which tree groups and cards are open; renders keep them so.
          el.addEventListener('toggle', event => { const d = event.target; if (d.matches?.('details[data-expand]')) expanded[d.dataset.expand] = d.open; }, true);
          el.addEventListener('pointerdown', onResizeStart);
        }
        document.addEventListener('keydown', onKey);
        window.addEventListener('webmesh:cad-hover', onHover);
        ensureViewTools();
      }
      document.querySelectorAll('[data-act="feature-check"]').forEach(el => { el.checked = checkedFeatures.has(el.dataset.id); });
      updateViewTools();
      updateAvailability();
    }
    function updateAvailability() {
      const busy = !!hooks.isBusy?.();
      const undo = document.querySelector('[data-act="undo"]'); if (undo) undo.disabled = !canUndo() || busy;
      const redo = document.querySelector('[data-act="redo"]'); if (redo) redo.disabled = !canRedo() || busy;
    }

    window.addEventListener('webmesh:cad-selection', event => {
      if (!session || !active) return;
      const detail = event.detail || {};
      if (detail.reason !== 'selection') return;
      const kinds = [['solid', detail.volumes], ['face', detail.faces], ['edge', detail.edges], ['vertex', detail.vertices]];
      const found = kinds.find(([, list]) => list && list.length);
      const next = found ? { kind: found[0], ids: found[1].slice() } : { kind: null, ids: [] };
      if (next.kind === selection.kind && next.ids.length === selection.ids.length && next.ids.every((id, i) => id === selection.ids[i])) return;
      selection = next;
      if (tool === 'features') { syncFeaturePending(); updatePendingOverlay(); refreshFooter(); if (pending) schedulePreview(); }
      if (tool === 'passages' && pending) { syncPassagePending(); updatePendingOverlay(); schedulePreview(); }
      if (tool === 'slice' && selection.kind === 'face' && selection.ids.length === 1) {
        const plane = F()?.facePlane(recognized.ctx, selection.ids[0]);
        if (plane) { sliceDraft.origin = plane.origin; sliceDraft.normal = F().cleanNormal(plane.normal); sliceDraft.along = null; syncSlicePending(); refreshSlice(true); }
      }
      if (tool === 'slice' && selection.kind === 'vertex' && selection.ids.length === 1) {
        const p = analysis?.index.vertices.get(selection.ids[0]);
        if (p) { moveSlice(dot(p, unit(sliceDraft.normal)), false); refreshSlice(false); }
      }
      if (tool === 'slice' && selection.kind === 'solid' && sliceDraft.scope === 'solids') { sliceDraft.volumeIds = selection.ids.slice(); syncSlicePending(); refreshSlice(true); }
      onSelectionChanged();
    });
    window.addEventListener('webmesh:change', event => {
      localCache=null;
      if (!session || !meshes.length || committingMesh) return;
      const reasons = event.detail?.reasons || [event.detail?.reason];
      if (!reasons.some(reason => ['load', 'undo', 'redo', 'history', 'model'].includes(reason))) return;
      // Edits elsewhere in the model leave a mesh as it is; undoing it, or editing it, makes it out of date.
      for (const m of meshes) if (!ownedMatches(m)) { m.stale = true; report = null; }
      const current=localPlan();if(current&&!current.affected.length){const record=meshes.find(m=>m.projectOwner===editingOwner);if(record?.inModel)record.stale=false;}
      if (!meshes.some(m => m.inModel)) { engine().setCadVisible(true); engine().setCadSelectionMode(active ? pick : 'none'); }
      if (active) hooks.render();
    });

    /* ------------------------------------------------------- persistence -- */
    const thisWorkspace = {
      beginRestore,finishRestore,abortRestore,validateRestore,
      render, bind, importFile, updateAvailability, hasGeometry: () => !!session, getFile: () => source,
      activate(value) {
        active = value;
        if (value) { refreshSessions(); loadPlugins(); }
        document.getElementById('app')?.classList.toggle('cad-mode', !!value);
        if (value && session) { if (step !== 'mesh' || !freshMeshes().length) engine()?.setCadVisible(true); updateDisplay(); }
        engine()?.setCadSelectionMode?.(value && session ? pick : 'none');
        if (!value) {
          engine()?.setCadVisible(false);
          // Workspace overlays belong to this tab; the next activation rebuilds them.
          engine()?.setCadSplitPlane?.(null); if (tooltip) tooltip.hidden = true;
          const vp = viewport(); if (vp) { vp.clearOverlays(''); vp.setBaseVisible?.(true); vp.setEdgeColors(null); }
        }
        updateViewTools();
      },
      clear() { partId=null;clearAll(); },
      setPart(id) { partId=id; },
      // Capturing a draft retains its server revision and in-session undo stack.
      captureDraft() {
        if(!session)return null;
        return {runtime:true,file:source,imported:session,data:{filename:source.name,settings:savedSettings(),report,editingOwner,regionName,meshes:meshes.map(m=>({...m})),prepared:{history:auditHistory}},partId,selection:structuredClone(selection),pick,display:{...display,hidden:new Set(display.hidden),hiddenSheets:new Set(display.hiddenSheets)},expanded:{...expanded}};
      },
      restoreDraft(draft) { this.commitRestore(draft);if(!draft)return;partId=draft.partId||null;if(draft.runtime)auditHistory=structuredClone(draft.data.prepared?.history||[]);if(draft.selection){selection=structuredClone(draft.selection);pick=draft.pick||pick;display=draft.display||display;expanded=draft.expanded||expanded;engine().selectCad({faces:selection.kind==='face'?selection.ids:[],edges:selection.kind==='edge'?selection.ids:[],vertices:selection.kind==='vertex'?selection.ids:[],volumes:selection.kind==='solid'?selection.ids:[]});updateDisplay();} },
      async serializeDraft(draft,{checkpoint=true}={}) {
        if(!draft)return null;
        const data={...structuredClone(draft.data),filename:draft.file.name,content:base64(await draft.file.arrayBuffer())};
        const retained={...data,prepared:{history:data.prepared?.history||[]}};
        data.prepared=await api('export',{cadId:draft.imported.cadId,revision:draft.imported.revision,checkpoint,draft:retained});data.prepared.history=[...(draft.data.prepared?.history||[]),...(data.prepared.checkpoint?[]:data.prepared.history||[])];return data;
      },
      /** [owner tag, element IDs] of each mesh a project saved, for the restored CAD session. */
      savedOwners(staged) { return staged ? savedMeshes(staged.data).filter(m => !m.projectOwner).map(m => [`${staged.imported.cadId}#${m.id}`, m.elements]) : []; },
      async serialize() {
        if (!source) return null;
        for (const m of meshes) if (!ownedMatches(m) && !m.stale) { m.stale = true; report = null; }
        const settings = savedSettings();
        const original = { filename: source.name, content: base64(await source.arrayBuffer()), settings, report, editingOwner, regionName };
        if (session) { original.prepared = await api('export', {...token(),checkpoint:true,draft:{...original,prepared:{history:auditHistory},meshes}}); original.prepared.history = [...auditHistory, ...(original.prepared.checkpoint?[]:original.prepared.history || [])]; }
        const saved = meshes.filter(m => m.inModel !== false).map(m => { const owned = meshOwnership(m); return { ...m, elements: owned.elements, properties: owned.properties }; });
        if (saved.length) original.meshes = saved;
        return original;
      },
      async stageRestore(data,transaction=null,scope=null) {
        if(!data)return null;
        validateRestore(data);
        const own=!transaction,tx=transaction||await beginRestore();scope=scope||'part-'+crypto.randomUUID();
        const file=new File([fromBase64(data.content)],data.filename),prepared=data.prepared?.content?data.prepared:null;
        const format=prepared?.format||({stp:'step',igs:'iges'}[file.name.split('.').pop().toLowerCase()]||file.name.split('.').pop().toLowerCase());
        try {
          const imported=await api('restore',{...tx,scope,filename:file.name,format,...(prepared?.checkpoint?{checkpoint:prepared.checkpoint}:{content:prepared?.content||data.content,...(Array.isArray(prepared?.sheets)?{sheets:prepared.sheets}:{})})});
          return {data,file,imported,transaction:tx,scope};
        } catch(error){if(own&&!error.unsupportedRestore)await abortRestore(tx);throw error;}
      },
      async adoptRestore(staged){if(staged?.transaction)await finishRestore(staged.transaction,true);},
      async discardRestore(staged){if(staged?.transaction)await abortRestore(staged.transaction);},
      commitRestore(staged) {
        this.clear(); if (!staged) return;
        const { data, file, imported } = staged; source = file;partId=staged.partId||null;
        auditHistory = Array.isArray(data.prepared?.history) ? data.prepared.history.filter(h => typeof h === 'string' || h && typeof h.label === 'string').map(h => typeof h === 'string' ? { label: 'Saved: ' + h.replace(/^(Saved: )+/, '') } : { ...h, label: 'Saved: ' + h.label.replace(/^(Saved: )+/, '') }) : [];
        const s = data.settings || {};
        if (s.version === 2) {
          if (Number(s.sizing?.size) > 0) sizing.size = Number(s.sizing.size);
          if (Number.isInteger(s.sizing?.minCount) && s.sizing.minCount > 0) sizing.minCount = s.sizing.minCount;
          if (['prepare', 'size', 'mesh'].includes(s.step)) step = s.step;
          if (s.shell && typeof s.shell === 'object') {
            const v = s.shell, ids = list => Array.isArray(list) ? list.filter(Number.isSafeInteger).slice(0, 10000) : [];
            shell = { ...shell, element: v.element === 'tri' ? 'tri' : 'quad', mesher: ['quadtree', 'paved'].includes(v.mesher) ? v.mesher : 'recombined',
              placement: ['surface', 'midsurface', 'offset'].includes(v.placement) ? v.placement : 'surface', scope: ['selected', 'sheets'].includes(v.scope) ? v.scope : 'all',
              faces: ids(v.faces), facesB: ids(v.facesB), size: Number(v.size) > 0 ? Number(v.size) : null, perCircle: Number.isInteger(v.perCircle) ? Math.max(4, Math.min(128, v.perCircle)) : 12,
              offset: Number.isFinite(v.offset) ? v.offset : 0, thickness: Number(v.thickness) > 0 ? Number(v.thickness) : 1, pidPerFace: !!v.pidPerFace,
              pads: Array.isArray(v.pads) ? v.pads.filter(p => p && ids(p.faces).length).slice(0, 1000).map(p => ({ faces: ids(p.faces), diameter: Number(p.diameter) > 0 ? Number(p.diameter) : 0,
                size: Number(p.size) > 0 ? Number(p.size) : null, perSide: Number.isInteger(p.perSide) && p.perSide >= 2 && p.perSide <= 64 ? p.perSide : null })) : [],
              padSize: Number(v.padSize) > 0 ? Number(v.padSize) : null, padSide: Number.isInteger(v.padSide) && v.padSide >= 2 && v.padSide <= 64 ? v.padSide : null };
          }
          if (s.mesh && ['mapped', 'gmsh', 'shell'].includes(s.mesh.method)) meshSettings = { ...meshSettings, method: s.mesh.method, order: s.mesh.order === 2 ? 2 : 1, scope: ['selected','affected'].includes(s.mesh.scope) ? s.mesh.scope : 'all', live: s.mesh.live !== false, pidPerSolid: !!s.mesh.pidPerSolid };
          if (s.legacy && ['tet', 'tri', 'quad', 'sweep', 'layered'].includes(s.legacy.method)) legacy = { ...legacy, ...s.legacy, layerCounts: typeof s.legacy.layerCounts === 'object' && s.legacy.layerCounts ? s.legacy.layerCounts : {} };
          if (Array.isArray(s.passages) && s.passages.length <= 24) passages = s.passages.filter(p => p && ['x', 'y', 'z'].includes(p.axis) && Array.isArray(p.center) && p.center.length === 3 && Array.isArray(p.range) && p.range.length === 2);
          if (s.display) display = { ...display, color: ['status', 'solid', 'plain'].includes(s.display.color) ? s.display.color : 'status', seeds: s.display.seeds !== false, labels: s.display.labels !== false, groups: s.display.groups !== false };
        } else if (s.values) {
          // Version 1 projects (Gmsh-only workflow).
          const v = s.values;
          if (['tet', 'tri', 'quad', 'sweep', 'layered'].includes(v.method)) { legacy.method = v.method; meshSettings.method = 'gmsh'; }
          if (Number(v.size) > 0) legacy.size = Number(v.size);
          if (v.order === '2' || v.order === 2) meshSettings.order = 2;
          if (s.stage === 'mesh') step = 'mesh';
        }
        accept(imported, { keepStep: true });
        if (s.version === 2 && s.display) {
          const keys = new Set(Array.isArray(s.display.hiddenSolids) ? s.display.hiddenSolids.filter(k => typeof k === 'string').slice(0, 10000) : []);
          display.hidden = new Set([...visibilityGeometry(session.topology).solids].filter(([, key]) => keys.has(key)).map(([id]) => id));
          display.hiddenSheets = new Set((Array.isArray(s.display.hiddenSheets) ? s.display.hiddenSheets : []).filter(id => Number.isSafeInteger(id) && session.topology.sheets?.some(s => s.sheet === id)));
        }
        let invalid = false;
        const available = new Set((session.topology.edges || []).map(e => e.id));
        const savedEdges = s.version === 2 ? (s.sizing?.edges || []) : [
          ...(s.localSizing?.edgeDivisions || []).map(c => ({ id: c.id, count: c.divisions })), ...(s.localSizing?.edgeSizes || []).map(c => ({ id: c.id, size: c.size }))];
        for (const control of savedEdges) {
          const ok = control && Number.isSafeInteger(control.id) && available.has(control.id) && (control.count == null || (Number.isInteger(control.count) && control.count > 0 && control.count <= 400)) && (control.size == null || (Number.isFinite(control.size) && control.size > 0));
          if (!ok) { invalid = true; continue; }
          const entry = {}; if (control.count != null) entry.count = control.count; if (control.size != null) entry.size = control.size;
          if (Object.keys(entry).length) sizing.edges.set(control.id, entry);
        }
        for(const c of s.sizing?.solids||[]){if(Number.isSafeInteger(c.id)&&analysis.volumes.has(c.id)&&Number.isFinite(c.size)&&c.size>0)sizing.solids.set(c.id,{size:c.size});else invalid=true;}
        if(s.mesh?.method==='shell'&&s.shell?.scope==='selected'){
          selection={kind:'face',ids:(s.shell.selectedFaces||[]).filter(id=>session.topology.faces.some(f=>f.id===id))};
          if(!selection.ids.length||selection.ids.length!==s.shell.selectedFaces?.length)invalid=true;
          engine().selectCad({faces:selection.ids,edges:[],vertices:[],volumes:[]});
        } else if (s.mesh?.method!=='shell' && s.mesh?.scope === 'selected') {
          const targets = Array.isArray(s.mesh.selectedVolumes) ? s.mesh.selectedVolumes : [];
          const availableSolids = new Set(session.topology.volumes.map(v => v.id));
          selection = { kind: 'solid', ids: targets.filter(id => Number.isSafeInteger(id) && availableSolids.has(id)) };
          if (!selection.ids.length || selection.ids.length !== targets.length) invalid = true;
          engine().selectCad({ faces: [], edges: [], vertices: [], volumes: selection.ids });
        }
        solve(); updateDisplay();
        meshes = savedMeshes(data); editingOwner=data.editingOwner||meshes.find(m=>m.projectOwner)?.projectOwner||null;regionName=data.regionName||meshes.find(m=>m.projectOwner===editingOwner)?.label||''; meshCounter = Math.max(0, ...meshes.map(m => m.id));
        if (data.report && typeof data.report.text === 'string') report = { text: data.report.text.slice(0, 6000), error: !!data.report.error };
        if (invalid) { markStale(); report = null; hooks.message('Some saved edge controls do not match this CAD revision. Review sizing and mesh again.', true); }
        for (const m of meshes) if (!ownedMatches(m)) m.stale = true;
        if (report && !report.error && (!freshMeshes().length || meshes.some(m => m.stale))) report = null;
        if (meshes.length) engine().setCadVisible(!freshMeshes().length);
      },
      getState() {
        return { cadId: session?.cadId, revision: session?.revision, filename: source?.name, step, pick, tool, selection: { ...selection, ids: selection.ids.slice() }, topology: session?.topology, report,
          analysis: analysis ? { summary: { ...analysis.summary } } : null, intervals: intervals ? { conflicts: intervals.conflicts.length, groups: intervals.groups.length, estimate: intervals.estimate, counts: Object.fromEntries(intervals.counts) } : null,
          remeshImpact: localPlan()?{affected:localPlan().affected,direct:localPlan().direct,propagated:localPlan().propagated,unchanged:localPlan().unchanged}:null, pending: pending ? JSON.parse(JSON.stringify(pending)) : null, preview: { status: previewState.status, error: previewState.error }, mesh: meshPreview ? { ...meshPreview.result.quality, elementQuality: undefined } : null, meshError };
      },
      historyActive, canUndo, canRedo,
      undo: () => hooks.run(() => moveHistory('undo')), redo: () => hooks.run(() => moveHistory('redo')),
      // Programmatic hooks used by tests and automation.
      api: {
        history: (kind, index) => moveHistory(kind, index),
        select: (kind, ids) => setSelection(kind, ids), pick: setPick, step: changeStep, tool: openTool, infer: () => lastActions.slice(),
        runAction: index => runInferred(lastActions[index]), apply: applyPending, setSize: size => { sizing.size = size; resolve(); },
        setCount: (edges, count) => setEdgeCount(edges, () => count), preview: buildMeshPreview, addMesh, waitForPreview: async () => { clearTimeout(previewTimer); await runPreview(); }
      }
    };
    return thisWorkspace;
  } };
})();
