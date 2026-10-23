/* Readable worker source. Wrapping it keeps offline file:// launches compatible
 * with Blob workers; this function is never executed in the main window. */
window.WebMeshCardWorkerSource = function webMeshCardWorker() {
// WebMesh Card Engine Worker
// Generated: 2026-03-21T20:21:38.068Z
// Source: src/worker/card_engine_worker.src.js

// Card Engine Worker
// Phase 1: tokenizer + logical card builder + INCLUDE expansion (flatten)

/** @typedef {{type:string, [k:string]:any}} WorkerMessage */

function post(type, payload = {}) {
  // eslint-disable-next-line no-restricted-globals
  self.postMessage({ type, ...payload });
}

function postWithTransfer(type, payload = {}, transfer = []) {
  // eslint-disable-next-line no-restricted-globals
  self.postMessage({ type, ...payload }, transfer);
}

const SOURCE_SESSION_STORE = new Map();
const SOURCE_SESSION_LIMIT = 4;
let SOURCE_SESSION_COUNTER = 0;
const PARSE_SESSION_STORE = new Map();
const PARSE_SESSION_LIMIT = 2;
let PARSE_SESSION_COUNTER = 0;

function nextSourceSessionId() {
  SOURCE_SESSION_COUNTER++;
  return `src_${Date.now()}_${SOURCE_SESSION_COUNTER}`;
}

function storeSourceSession(sessionId, sourceFiles) {
  if (!sessionId || !sourceFiles || typeof sourceFiles !== 'object') return;
  SOURCE_SESSION_STORE.set(sessionId, {
    createdAt: Date.now(),
    sourceFiles
  });
  if (SOURCE_SESSION_STORE.size <= SOURCE_SESSION_LIMIT) return;
  const keys = Array.from(SOURCE_SESSION_STORE.keys());
  const overflow = SOURCE_SESSION_STORE.size - SOURCE_SESSION_LIMIT;
  for (let i = 0; i < overflow; i++) {
    SOURCE_SESSION_STORE.delete(keys[i]);
  }
}

function getSourceSessionFiles(sessionId) {
  if (!sessionId) return null;
  const key = String(sessionId);
  if (!SOURCE_SESSION_STORE.has(key)) return null;
  const entry = SOURCE_SESSION_STORE.get(key);
  // LRU-style bump.
  SOURCE_SESSION_STORE.delete(key);
  SOURCE_SESSION_STORE.set(key, entry);
  return entry && entry.sourceFiles ? entry.sourceFiles : null;
}

function nextParseSessionId() {
  PARSE_SESSION_COUNTER++;
  return `parse_${Date.now()}_${PARSE_SESSION_COUNTER}`;
}

function storeParseSession(sessionId, session) {
  if (!sessionId || !session || typeof session !== 'object') return;
  PARSE_SESSION_STORE.set(String(sessionId), {
    createdAt: Date.now(),
    ...session
  });
  if (PARSE_SESSION_STORE.size <= PARSE_SESSION_LIMIT) return;
  const keys = Array.from(PARSE_SESSION_STORE.keys());
  const overflow = PARSE_SESSION_STORE.size - PARSE_SESSION_LIMIT;
  for (let i = 0; i < overflow; i++) {
    PARSE_SESSION_STORE.delete(keys[i]);
  }
}

function getParseSession(sessionId) {
  if (!sessionId) return null;
  const key = String(sessionId);
  if (!PARSE_SESSION_STORE.has(key)) return null;
  const entry = PARSE_SESSION_STORE.get(key);
  // LRU-style bump.
  PARSE_SESSION_STORE.delete(key);
  PARSE_SESSION_STORE.set(key, entry);
  return entry || null;
}

const CORE_ELEM_TYPE_CODES = Object.freeze({
  UNKNOWN: 0,
  CTRIA3: 1,
  CTRIA6: 2,
  CQUAD4: 3,
  CQUAD8: 4,
  CHEXA: 5,
  CTETRA: 6,
  CPENTA: 7,
  CPYRAM: 8,
  CROD: 9,
  CBAR: 10,
  CBEAM: 11,
  CBUSH: 12,
  RBE2: 13,
  RBE3: 14
});

function coreElemTypeCodeFor(typeName) {
  const key = String(typeName || '').toUpperCase();
  return Object.prototype.hasOwnProperty.call(CORE_ELEM_TYPE_CODES, key)
    ? CORE_ELEM_TYPE_CODES[key]
    : CORE_ELEM_TYPE_CODES.UNKNOWN;
}

function nowMs() {
  // eslint-disable-next-line no-restricted-globals
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    // eslint-disable-next-line no-restricted-globals
    return performance.now();
  }
  return Date.now();
}

function asError(err) {
  if (!err) return { message: 'unknown error' };
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}

function makeIssue(code, message, extra = {}) {
  return {
    code,
    message,
    ...extra
  };
}

function toUpper(s) {
  return String(s ?? '').trim().toUpperCase();
}

function isBlankToken(tok) {
  return tok == null || String(tok).trim() === '';
}

function parseNastranString(token) {
  if (isBlankToken(token)) return null;
  return String(token).trim();
}

function parseNastranInt(token) {
  if (isBlankToken(token)) return null;
  const s = String(token).trim();
  if (!/^[+-]?\d+$/.test(s)) return NaN;
  const v = Number.parseInt(s, 10);
  return Number.isFinite(v) ? v : NaN;
}

function parseNastranFloat(token) {
  if (isBlankToken(token)) return null;
  let s = String(token).trim();
  // Normalize packed exponent forms like 1.23-5 or .5+3 to 1.23E-5 / .5E+3
  if (!/[eEdD]/.test(s)) {
    const m = /^([+-]?(?:\d+\.?\d*|\.?\d+))([+-]\d+)$/.exec(s);
    if (m) s = `${m[1]}E${m[2]}`;
  } else {
    s = s.replace(/[dD]/g, 'E');
  }
  // Full-match validation after normalization (no partial parses like "1.0abc").
  const full = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (!full.test(s)) return NaN;
  const v = Number.parseFloat(s);
  return Number.isFinite(v) ? v : NaN;
}

function trimByteRange(bytes, start, end) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  let s = Math.max(0, Number(start) | 0);
  let e = Math.max(s, Math.min(view.length, Number(end) | 0));
  while (s < e) {
    const b = view[s];
    if (b !== 32 && b !== 9 && b !== 13) break;
    s++;
  }
  while (e > s) {
    const b = view[e - 1];
    if (b !== 32 && b !== 9 && b !== 13) break;
    e--;
  }
  return [s, e];
}

function isAsciiDigitByte(b) {
  return b >= 48 && b <= 57;
}

function parseNastranIntFromBytes(bytes, start, end) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const range = trimByteRange(view, start, end);
  let s = range[0];
  const e = range[1];
  if (s >= e) return null;

  let sign = 1;
  const first = view[s];
  if (first === 43) s++;
  else if (first === 45) {
    sign = -1;
    s++;
  }
  if (s >= e) return NaN;

  let value = 0;
  for (let i = s; i < e; i++) {
    const b = view[i];
    if (!isAsciiDigitByte(b)) return NaN;
    value = value * 10 + (b - 48);
  }
  return sign * value;
}

function parseNastranFloatFromBytes(bytes, start, end) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const range = trimByteRange(view, start, end);
  let i = range[0];
  const e = range[1];
  if (i >= e) return null;

  let sign = 1;
  if (view[i] === 43) i++;
  else if (view[i] === 45) {
    sign = -1;
    i++;
  }
  if (i >= e) return NaN;

  let mant = 0;
  let fracDiv = 1;
  let sawDot = false;
  let sawDigit = false;

  while (i < e) {
    const b = view[i];
    if (isAsciiDigitByte(b)) {
      sawDigit = true;
      const d = b - 48;
      if (!sawDot) mant = mant * 10 + d;
      else {
        fracDiv *= 10;
        mant += d / fracDiv;
      }
      i++;
      continue;
    }
    if (b === 46 && !sawDot) {
      sawDot = true;
      i++;
      continue;
    }
    break;
  }
  if (!sawDigit) return NaN;

  let exp = 0;
  let expSign = 1;
  if (i < e) {
    let b = view[i];
    if (b === 101 || b === 69 || b === 100 || b === 68) {
      i++;
      if (i < e && (view[i] === 43 || view[i] === 45)) {
        if (view[i] === 45) expSign = -1;
        i++;
      }
      if (i >= e || !isAsciiDigitByte(view[i])) return NaN;
      while (i < e) {
        b = view[i];
        if (!isAsciiDigitByte(b)) return NaN;
        exp = exp * 10 + (b - 48);
        i++;
      }
    } else if (b === 43 || b === 45) {
      // Packed exponent form, e.g. 1.23-5
      if (b === 45) expSign = -1;
      i++;
      if (i >= e || !isAsciiDigitByte(view[i])) return NaN;
      while (i < e) {
        b = view[i];
        if (!isAsciiDigitByte(b)) return NaN;
        exp = exp * 10 + (b - 48);
        i++;
      }
    } else {
      return NaN;
    }
  }
  if (i !== e) return NaN;

  return sign * mant * Math.pow(10, expSign * exp);
}

function parseGridPsMaskFromBytes(bytes, start, end) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const range = trimByteRange(view, start, end);
  let s = range[0];
  const e = range[1];
  if (s >= e) return 0;

  let mask = 0;
  for (let i = s; i < e; i++) {
    const b = view[i];
    if (b < 49 || b > 54) return -1;
    const bit = 1 << (b - 49);
    if ((mask & bit) !== 0) return -1;
    mask |= bit;
  }
  return mask;
}

const ALLOWED_BAR_BEAM_OFFT = new Set([
  'GGG', 'BGG', 'GGO', 'BGO', 'GOG', 'BOG', 'GOO', 'BOO',
  'GGE', 'BGE', 'GEG', 'BEG', 'GEE', 'BEE', 'GGB', 'BGB',
  'GBG', 'BBG', 'GBB', 'BBB', 'B'
]);

function formatInt(val, width) {
  if (typeof val !== 'number' && val !== null) return ''.padEnd(width, ' ');
  let v = val;
  if (v === null) return ''.padEnd(width, ' ');
  if (typeof v !== 'number') v = Number(v);
  if (Number.isNaN(v)) return ''.padEnd(width, ' ');

  let s = String(Math.round(v));
  if (s.length > width) return '*'.repeat(width);
  return s.padStart(width, ' ');
}

function formatString(val, width) {
  let s = String(val ?? '');
  if (s.length > width) return s.slice(0, width);
  return s.padEnd(width, ' ');
}

// Built-in schema is embedded into the generated worker at build time.
// Source of truth: schema/nastran_schema.min.json (generated from pyNastran).
// The build tool replaces this null with a JSON object literal.
const BUILTIN_NASTRAN_SCHEMA = {"schemaVersion":1,"tier":"Tier1","meta":{"generator":"tools/generate_schema.py:ast_v1","pyNastranSourceHash":"2f6db9c1a629d2ba74d8efe587762d95fdeb8f79f5d82a71ea3c0c4fcb5908a1","pynastranRoot":"pyNastran/pyNastran","scannedFiles":["pyNastran/pyNastran/bdf/cards/__init__.py","pyNastran/pyNastran/bdf/cards/aero/__init__.py","pyNastran/pyNastran/bdf/cards/aero/aero.py","pyNastran/pyNastran/bdf/cards/aero/dynamic_loads.py","pyNastran/pyNastran/bdf/cards/aero/spline_utils.py","pyNastran/pyNastran/bdf/cards/aero/static_loads.py","pyNastran/pyNastran/bdf/cards/aero/utils.py","pyNastran/pyNastran/bdf/cards/aero/wkk.py","pyNastran/pyNastran/bdf/cards/aero/zona.py","pyNastran/pyNastran/bdf/cards/axisymmetric/loads.py","pyNastran/pyNastran/bdf/cards/base_card.py","pyNastran/pyNastran/bdf/cards/bdf_sets.py","pyNastran/pyNastran/bdf/cards/bdf_tables.py","pyNastran/pyNastran/bdf/cards/bolt.py","pyNastran/pyNastran/bdf/cards/collpase_card.py","pyNastran/pyNastran/bdf/cards/constraints.py","pyNastran/pyNastran/bdf/cards/contact.py","pyNastran/pyNastran/bdf/cards/coordinate_systems.py","pyNastran/pyNastran/bdf/cards/cyclic.py","pyNastran/pyNastran/bdf/cards/deqatn.py","pyNastran/pyNastran/bdf/cards/dmig.py","pyNastran/pyNastran/bdf/cards/dynamic.py","pyNastran/pyNastran/bdf/cards/elements/__init__.py","pyNastran/pyNastran/bdf/cards/elements/acoustic.py","pyNastran/pyNastran/bdf/cards/elements/axisymmetric_shells.py","pyNastran/pyNastran/bdf/cards/elements/bars.py","pyNastran/pyNastran/bdf/cards/elements/beam.py","pyNastran/pyNastran/bdf/cards/elements/beam_connectivity.py","pyNastran/pyNastran/bdf/cards/elements/beam_line_connectivity.py","pyNastran/pyNastran/bdf/cards/elements/bush.py","pyNastran/pyNastran/bdf/cards/elements/damper.py","pyNastran/pyNastran/bdf/cards/elements/elements.py","pyNastran/pyNastran/bdf/cards/elements/mass.py","pyNastran/pyNastran/bdf/cards/elements/optimization_utils.py","pyNastran/pyNastran/bdf/cards/elements/plot.py","pyNastran/pyNastran/bdf/cards/elements/rigid.py","pyNastran/pyNastran/bdf/cards/elements/rods.py","pyNastran/pyNastran/bdf/cards/elements/shell.py","pyNastran/pyNastran/bdf/cards/elements/shell_laminate_plot.py","pyNastran/pyNastran/bdf/cards/elements/solid.py","pyNastran/pyNastran/bdf/cards/elements/springs.py","pyNastran/pyNastran/bdf/cards/expand_card.py","pyNastran/pyNastran/bdf/cards/glue.py","pyNastran/pyNastran/bdf/cards/loads/__init__.py","pyNastran/pyNastran/bdf/cards/loads/dloads.py","pyNastran/pyNastran/bdf/cards/loads/loads.py","pyNastran/pyNastran/bdf/cards/loads/random_loads.py","pyNastran/pyNastran/bdf/cards/loads/static_loads.py","pyNastran/pyNastran/bdf/cards/material_deps.py","pyNastran/pyNastran/bdf/cards/materials.py","pyNastran/pyNastran/bdf/cards/methods.py","pyNastran/pyNastran/bdf/cards/nodes.py","pyNastran/pyNastran/bdf/cards/optimization.py","pyNastran/pyNastran/bdf/cards/optimization_nx.py","pyNastran/pyNastran/bdf/cards/parametric/__init__.py","pyNastran/pyNastran/bdf/cards/parametric/geometry.py","pyNastran/pyNastran/bdf/cards/params.py","pyNastran/pyNastran/bdf/cards/properties/__init__.py","pyNastran/pyNastran/bdf/cards/properties/bars.py","pyNastran/pyNastran/bdf/cards/properties/beam.py","pyNastran/pyNastran/bdf/cards/properties/bush.py","pyNastran/pyNastran/bdf/cards/properties/damper.py","pyNastran/pyNastran/bdf/cards/properties/mass.py","pyNastran/pyNastran/bdf/cards/properties/properties.py","pyNastran/pyNastran/bdf/cards/properties/rods.py","pyNastran/pyNastran/bdf/cards/properties/shell.py","pyNastran/pyNastran/bdf/cards/properties/solid.py","pyNastran/pyNastran/bdf/cards/properties/springs.py","pyNastran/pyNastran/bdf/cards/superelements.py","pyNastran/pyNastran/bdf/cards/test/__init__.py","pyNastran/pyNastran/bdf/cards/test/all_tests.py","pyNastran/pyNastran/bdf/cards/test/test_acoustic.py","pyNastran/pyNastran/bdf/cards/test/test_aero.py","pyNastran/pyNastran/bdf/cards/test/test_axisymmetric.py","pyNastran/pyNastran/bdf/cards/test/test_bars.py","pyNastran/pyNastran/bdf/cards/test/test_base_card.py","pyNastran/pyNastran/bdf/cards/test/test_beams.py","pyNastran/pyNastran/bdf/cards/test/test_bolt_nx.py","pyNastran/pyNastran/bdf/cards/test/test_constraints.py","pyNastran/pyNastran/bdf/cards/test/test_contact.py","pyNastran/pyNastran/bdf/cards/test/test_coords.py","pyNastran/pyNastran/bdf/cards/test/test_cyclic.py","pyNastran/pyNastran/bdf/cards/test/test_dampers.py","pyNastran/pyNastran/bdf/cards/test/test_deqatn.py","pyNastran/pyNastran/bdf/cards/test/test_dmig.py","pyNastran/pyNastran/bdf/cards/test/test_dynamic.py","pyNastran/pyNastran/bdf/cards/test/test_elements.py","pyNastran/pyNastran/bdf/cards/test/test_loads.py","pyNastran/pyNastran/bdf/cards/test/test_mass_elements.py","pyNastran/pyNastran/bdf/cards/test/test_materials.py","pyNastran/pyNastran/bdf/cards/test/test_methods.py","pyNastran/pyNastran/bdf/cards/test/test_nodes.py","pyNastran/pyNastran/bdf/cards/test/test_nsm.py","pyNastran/pyNastran/bdf/cards/test/test_optimization.py","pyNastran/pyNastran/bdf/cards/test/test_parametric.py","pyNastran/pyNastran/bdf/cards/test/test_params.py","pyNastran/pyNastran/bdf/cards/test/test_rigid.py","pyNastran/pyNastran/bdf/cards/test/test_rods.py","pyNastran/pyNastran/bdf/cards/test/test_sets.py","pyNastran/pyNastran/bdf/cards/test/test_shells.py","pyNastran/pyNastran/bdf/cards/test/test_solids.py","pyNastran/pyNastran/bdf/cards/test/test_springs.py","pyNastran/pyNastran/bdf/cards/test/test_superelements.py","pyNastran/pyNastran/bdf/cards/test/test_tables.py","pyNastran/pyNastran/bdf/cards/test/test_thermal.py","pyNastran/pyNastran/bdf/cards/test/utils.py","pyNastran/pyNastran/bdf/cards/thermal/__init__.py","pyNastran/pyNastran/bdf/cards/thermal/loads.py","pyNastran/pyNastran/bdf/cards/thermal/radiation.py","pyNastran/pyNastran/bdf/cards/thermal/thermal.py","pyNastran/pyNastran/bdf/cards/utils.py","pyNastran/pyNastran/bdf/bdf_interface/__init__.py","pyNastran/pyNastran/bdf/bdf_interface/add_card.py","pyNastran/pyNastran/bdf/bdf_interface/add_methods.py","pyNastran/pyNastran/bdf/bdf_interface/assign_type.py","pyNastran/pyNastran/bdf/bdf_interface/assign_type_force.py","pyNastran/pyNastran/bdf/bdf_interface/attributes.py","pyNastran/pyNastran/bdf/bdf_interface/bdf_card.py","pyNastran/pyNastran/bdf/bdf_interface/card_groups.py","pyNastran/pyNastran/bdf/bdf_interface/case_control_cards.py","pyNastran/pyNastran/bdf/bdf_interface/compare_card_content.py","pyNastran/pyNastran/bdf/bdf_interface/cross_reference.py","pyNastran/pyNastran/bdf/bdf_interface/cross_reference_obj.py","pyNastran/pyNastran/bdf/bdf_interface/dev/__init__.py","pyNastran/pyNastran/bdf/bdf_interface/dev/dedemap.py","pyNastran/pyNastran/bdf/bdf_interface/dev/dmap.py","pyNastran/pyNastran/bdf/bdf_interface/dev/mass.py","pyNastran/pyNastran/bdf/bdf_interface/dev/matrices.py","pyNastran/pyNastran/bdf/bdf_interface/dev/set_operations.py","pyNastran/pyNastran/bdf/bdf_interface/dev/test_mass.py","pyNastran/pyNastran/bdf/bdf_interface/encoding.py","pyNastran/pyNastran/bdf/bdf_interface/get_card.py","pyNastran/pyNastran/bdf/bdf_interface/get_methods.py","pyNastran/pyNastran/bdf/bdf_interface/hdf5_exporter.py","pyNastran/pyNastran/bdf/bdf_interface/hdf5_loader.py","pyNastran/pyNastran/bdf/bdf_interface/include_file.py","pyNastran/pyNastran/bdf/bdf_interface/internal_get.py","pyNastran/pyNastran/bdf/bdf_interface/model_group.py","pyNastran/pyNastran/bdf/bdf_interface/pybdf.py","pyNastran/pyNastran/bdf/bdf_interface/replication.py","pyNastran/pyNastran/bdf/bdf_interface/safe_cross_reference.py","pyNastran/pyNastran/bdf/bdf_interface/stats.py","pyNastran/pyNastran/bdf/bdf_interface/subcase/__init__.py","pyNastran/pyNastran/bdf/bdf_interface/subcase/cards.py","pyNastran/pyNastran/bdf/bdf_interface/subcase/cards_check.py","pyNastran/pyNastran/bdf/bdf_interface/subcase/cards_int.py","pyNastran/pyNastran/bdf/bdf_interface/subcase/cards_str.py","pyNastran/pyNastran/bdf/bdf_interface/subcase/h5py_interface.py","pyNastran/pyNastran/bdf/bdf_interface/subcase/int_str_cards.py","pyNastran/pyNastran/bdf/bdf_interface/subcase/matrix.py","pyNastran/pyNastran/bdf/bdf_interface/subcase/sets.py","pyNastran/pyNastran/bdf/bdf_interface/subcase/subcase_base.py","pyNastran/pyNastran/bdf/bdf_interface/subcase/utils.py","pyNastran/pyNastran/bdf/bdf_interface/test/__init__.py","pyNastran/pyNastran/bdf/bdf_interface/test/test_assign_type.py","pyNastran/pyNastran/bdf/bdf_interface/test/test_bdf_interface.py","pyNastran/pyNastran/bdf/bdf_interface/test/test_case_control_deck.py","pyNastran/pyNastran/bdf/bdf_interface/test/test_dev_utils.py","pyNastran/pyNastran/bdf/bdf_interface/test/test_executive.py","pyNastran/pyNastran/bdf/bdf_interface/test/test_pybdf.py","pyNastran/pyNastran/bdf/bdf_interface/uncross_reference.py","pyNastran/pyNastran/bdf/bdf_interface/utils.py","pyNastran/pyNastran/bdf/bdf_interface/verify_validate.py","pyNastran/pyNastran/bdf/bdf_interface/write_mesh.py","pyNastran/pyNastran/bdf/bdf_interface/write_mesh_file.py","pyNastran/pyNastran/bdf/bdf_interface/write_mesh_utils.py"],"wantedCardCount":32,"extractedCardCount":32,"missingCards":[],"qrgSourceCards":["CBAR","CBEAM","CBUSH","CHEXA","CONM2","CORD1C","CORD1R","CORD2C","CORD2R","CORD2S","CQUAD4","CROD","CTETRA","CTRIA3","FORCE","GRID","LOAD","MAT1","MOMENT","PBAR","PBEAM","PBUSH","PCOMP","PLOAD2","PLOAD4","PROD","PSHELL","PSOLID","RBE2","RBE3","SPC","SPC1"],"tiersFile":"docs/NastranCardTiers.txt","maxTier":1,"qrgFieldMap":"References/New References/qrg_field_map.json","structuralDirectives":["BEGIN BULK","CEND","DISPLACEMENT","ENDDATA","INCLUDE","SOL","STRESS","SUBCASE"]},"cards":{"CBAR":{"fields":[{"index":1,"name":"eid","type":"int","required":true},{"index":2,"name":"pid","type":"int","required":false,"defaultFrom":"pid_default"},{"index":3,"name":"ga","type":"int","required":true},{"index":4,"name":"gb","type":"int","required":true},{"index":5,"name":"x1","type":"number","required":false},{"index":6,"name":"x2","type":"float","required":false},{"index":7,"name":"x3","type":"float","required":false},{"index":8,"name":"offt","type":"string","required":false,"default":"GGG"},{"index":9,"name":"pa","type":"int","required":false,"default":0},{"index":10,"name":"pb","type":"int","required":false,"default":0},{"index":11,"name":"w1a","type":"float","required":false,"default":0.0},{"index":12,"name":"w2a","type":"float","required":false,"default":0.0},{"index":13,"name":"w3a","type":"float","required":false,"default":0.0},{"index":14,"name":"w1b","type":"float","required":false,"default":0.0},{"index":15,"name":"w2b","type":"float","required":false,"default":0.0},{"index":16,"name":"w3b","type":"float","required":false,"default":0.0}]},"CBEAM":{"fields":[{"index":1,"name":"eid","type":"int","required":true},{"index":2,"name":"pid","type":"int","required":false,"defaultFrom":"pid_default"},{"index":3,"name":"ga","type":"int","required":true},{"index":4,"name":"gb","type":"int","required":true},{"index":5,"name":"x1","type":"number","required":false},{"index":6,"name":"x2","type":"float","required":false},{"index":7,"name":"x3","type":"float","required":false},{"index":8,"name":"offt","type":"string","required":false,"default":"GGG"},{"index":9,"name":"pa","type":"int","required":false,"default":0},{"index":10,"name":"pb","type":"int","required":false,"default":0},{"index":11,"name":"w1a","type":"float","required":false,"default":0.0},{"index":12,"name":"w2a","type":"float","required":false,"default":0.0},{"index":13,"name":"w3a","type":"float","required":false,"default":0.0},{"index":14,"name":"w1b","type":"float","required":false,"default":0.0},{"index":15,"name":"w2b","type":"float","required":false,"default":0.0},{"index":16,"name":"w3b","type":"float","required":false,"default":0.0},{"index":17,"name":"sa","type":"int","required":false,"default":0},{"index":18,"name":"sb","type":"int","required":false,"default":0}]},"CBUSH":{"fields":[{"index":1,"name":"eid","type":"int","required":true},{"index":2,"name":"pid","type":"int","required":false,"defaultFrom":"pid_default"},{"index":3,"name":"ga","type":"int","required":true},{"index":4,"name":"gb","type":"int","required":true},{"index":5,"name":"x1_g0","type":"number","required":false},{"index":6,"name":"x2","type":"float","required":false},{"index":7,"name":"x3","type":"float","required":false},{"index":8,"name":"cid","type":"int","required":false},{"index":9,"name":"s","type":"float","required":false,"default":0.5},{"index":10,"name":"ocid","type":"int","required":false,"default":-1},{"index":11,"name":"s1","type":"float","required":false},{"index":12,"name":"s2","type":"float","required":false},{"index":13,"name":"s3","type":"float","required":false}]},"CHEXA":{"fields":[{"index":1,"name":"EID","type":"string","required":false},{"index":2,"name":"PID","type":"string","required":false},{"index":3,"name":"G1","type":"string","required":false},{"index":4,"name":"G2","type":"string","required":false},{"index":5,"name":"G3","type":"string","required":false},{"index":6,"name":"G4","type":"string","required":false},{"index":7,"name":"G5","type":"string","required":false},{"index":8,"name":"G6","type":"string","required":false},{"index":9,"name":"G7","type":"string","required":false},{"index":10,"name":"G8","type":"string","required":false},{"index":11,"name":"G9","type":"string","required":false},{"index":12,"name":"G10","type":"string","required":false},{"index":13,"name":"G11","type":"string","required":false},{"index":14,"name":"G12","type":"string","required":false},{"index":15,"name":"G13","type":"string","required":false},{"index":16,"name":"G14","type":"string","required":false},{"index":17,"name":"G15","type":"string","required":false},{"index":18,"name":"G16","type":"string","required":false},{"index":19,"name":"G17","type":"string","required":false},{"index":20,"name":"G18","type":"string","required":false},{"index":21,"name":"G19","type":"string","required":false},{"index":22,"name":"G20","type":"string","required":false}]},"CONM2":{"fields":[{"index":1,"name":"eid","type":"int","required":true},{"index":2,"name":"g","type":"int","required":true},{"index":3,"name":"cid","type":"int","required":false,"default":0},{"index":4,"name":"m","type":"float","required":false,"default":0.0},{"index":5,"name":"x1","type":"float","required":false,"default":0.0},{"index":6,"name":"x2","type":"float","required":false,"default":0.0},{"index":7,"name":"x3","type":"float","required":false,"default":0.0},{"index":9,"name":"I11","type":"float","required":false,"default":0.0},{"index":10,"name":"I21","type":"float","required":false,"default":0.0},{"index":11,"name":"I22","type":"float","required":false,"default":0.0},{"index":12,"name":"I31","type":"float","required":false,"default":0.0},{"index":13,"name":"I32","type":"float","required":false,"default":0.0},{"index":14,"name":"I33","type":"float","required":false,"default":0.0}]},"CORD1C":{"fields":[{"index":1,"name":"cid","type":"int","required":true},{"index":2,"name":"g1","type":"int","required":true},{"index":3,"name":"g2","type":"int","required":true},{"index":4,"name":"g3","type":"int","required":true},{"index":5,"name":"cidb","type":"int","required":false},{"index":6,"name":"g1b","type":"int","required":false},{"index":7,"name":"g2b","type":"int","required":false},{"index":8,"name":"g3b","type":"int","required":false}]},"CORD1R":{"fields":[{"index":1,"name":"cid","type":"int","required":true},{"index":2,"name":"g1","type":"int","required":true},{"index":3,"name":"g2","type":"int","required":true},{"index":4,"name":"g3","type":"int","required":true},{"index":5,"name":"cidb","type":"int","required":false},{"index":6,"name":"g1b","type":"int","required":false},{"index":7,"name":"g2b","type":"int","required":false},{"index":8,"name":"g3b","type":"int","required":false}]},"CORD2C":{"fields":[{"index":1,"name":"cid","type":"int","required":true},{"index":2,"name":"rid","type":"int","required":false,"default":0},{"index":3,"name":"e1x","type":"float","required":true},{"index":4,"name":"e1y","type":"float","required":true},{"index":5,"name":"e1z","type":"float","required":true},{"index":6,"name":"e2x","type":"float","required":true},{"index":7,"name":"e2y","type":"float","required":true},{"index":8,"name":"e2z","type":"float","required":true},{"index":9,"name":"e3x","type":"float","required":true},{"index":10,"name":"e3y","type":"float","required":true},{"index":11,"name":"e3z","type":"float","required":true}]},"CORD2R":{"fields":[{"index":1,"name":"cid","type":"int","required":true},{"index":2,"name":"rid","type":"int","required":false,"default":0},{"index":3,"name":"e1x","type":"float","required":true},{"index":4,"name":"e1y","type":"float","required":true},{"index":5,"name":"e1z","type":"float","required":true},{"index":6,"name":"e2x","type":"float","required":true},{"index":7,"name":"e2y","type":"float","required":true},{"index":8,"name":"e2z","type":"float","required":true},{"index":9,"name":"e3x","type":"float","required":true},{"index":10,"name":"e3y","type":"float","required":true},{"index":11,"name":"e3z","type":"float","required":true}]},"CORD2S":{"fields":[{"index":1,"name":"cid","type":"int","required":true},{"index":2,"name":"rid","type":"int","required":false,"default":0},{"index":3,"name":"e1x","type":"float","required":true},{"index":4,"name":"e1y","type":"float","required":true},{"index":5,"name":"e1z","type":"float","required":true},{"index":6,"name":"e2x","type":"float","required":true},{"index":7,"name":"e2y","type":"float","required":true},{"index":8,"name":"e2z","type":"float","required":true},{"index":9,"name":"e3x","type":"float","required":true},{"index":10,"name":"e3y","type":"float","required":true},{"index":11,"name":"e3z","type":"float","required":true}]},"CQUAD4":{"fields":[{"index":1,"name":"eid","type":"int","required":true},{"index":2,"name":"pid","type":"int","required":false,"defaultFrom":"eid"},{"index":3,"name":"n1","type":"int","required":true},{"index":4,"name":"n2","type":"int","required":true},{"index":5,"name":"n3","type":"int","required":true},{"index":6,"name":"n4","type":"int","required":true},{"index":7,"name":"theta_mcid","type":"number","required":false,"default":0.0},{"index":8,"name":"zoffset","type":"float","required":false,"default":0.0},{"index":9,"name":"blank","type":"blank","required":false},{"index":10,"name":"tflag","type":"int","required":false,"default":0},{"index":11,"name":"T1","type":"float","required":false},{"index":12,"name":"T2","type":"float","required":false},{"index":13,"name":"T3","type":"float","required":false},{"index":14,"name":"T4","type":"float","required":false}]},"CROD":{"fields":[{"index":1,"name":"EID","type":"string","required":false},{"index":2,"name":"PID","type":"string","required":false},{"index":3,"name":"G1","type":"string","required":false},{"index":4,"name":"G2","type":"string","required":false}]},"CTETRA":{"fields":[{"index":1,"name":"EID","type":"string","required":false},{"index":2,"name":"PID","type":"string","required":false},{"index":3,"name":"G1","type":"string","required":false},{"index":4,"name":"G2","type":"string","required":false},{"index":5,"name":"G3","type":"string","required":false},{"index":6,"name":"G4","type":"string","required":false},{"index":7,"name":"G5","type":"string","required":false},{"index":8,"name":"G6","type":"string","required":false},{"index":9,"name":"G7","type":"string","required":false},{"index":10,"name":"G8","type":"string","required":false},{"index":11,"name":"G9","type":"string","required":false},{"index":12,"name":"G10","type":"string","required":false}]},"CTRIA3":{"fields":[{"index":1,"name":"eid","type":"int","required":true},{"index":2,"name":"pid","type":"int","required":false,"defaultFrom":"eid"},{"index":3,"name":"n1","type":"int","required":true},{"index":4,"name":"n2","type":"int","required":true},{"index":5,"name":"n3","type":"int","required":true},{"index":6,"name":"theta_mcid","type":"number","required":false,"default":0.0},{"index":7,"name":"zoffset","type":"float","required":false,"default":0.0},{"index":8,"name":"blank","type":"blank","required":false},{"index":9,"name":"blank","type":"blank","required":false},{"index":10,"name":"tflag","type":"int","required":false,"default":0},{"index":11,"name":"T1","type":"float","required":false},{"index":12,"name":"T2","type":"float","required":false},{"index":13,"name":"T3","type":"float","required":false}]},"FORCE":{"fields":[{"index":1,"name":"sid","type":"int","required":true},{"index":2,"name":"g","type":"int","required":true},{"index":3,"name":"cid","type":"int","required":false,"default":0},{"index":4,"name":"f","type":"float","required":true},{"index":5,"name":"n1","type":"float","required":true},{"index":6,"name":"n2","type":"float","required":true},{"index":7,"name":"n3","type":"float","required":true}]},"GRID":{"fields":[{"index":1,"name":"nid","type":"int","required":true},{"index":2,"name":"cp","type":"int","required":false,"default":0},{"index":3,"name":"x1","type":"float","required":false,"default":0.0},{"index":4,"name":"x2","type":"float","required":false,"default":0.0},{"index":5,"name":"x3","type":"float","required":false,"default":0.0},{"index":6,"name":"cd","type":"int","required":false,"default":0},{"index":7,"name":"ps","type":"string","required":false,"default":""},{"index":8,"name":"seid","type":"int","required":false,"default":0}]},"LOAD":{"fields":[{"index":1,"name":"sid","type":"int","required":true},{"index":2,"name":"scale","type":"float","required":true},{"index":3,"name":"s1","type":"float","required":false},{"index":4,"name":"l1","type":"int","required":false},{"index":5,"name":"s2","type":"float","required":false},{"index":6,"name":"l2","type":"int","required":false},{"index":7,"name":"s3","type":"float","required":false},{"index":8,"name":"l3","type":"int","required":false},{"index":9,"name":"s4","type":"float","required":false},{"index":10,"name":"l4","type":"int","required":false}]},"MAT1":{"fields":[{"index":1,"name":"mid","type":"int","required":true},{"index":2,"name":"E","type":"float","required":false},{"index":3,"name":"G","type":"float","required":false},{"index":4,"name":"nu","type":"float","required":false},{"index":5,"name":"rho","type":"float","required":false,"default":0.0},{"index":6,"name":"a","type":"float","required":false,"default":0.0},{"index":7,"name":"tref","type":"float","required":false,"default":0.0},{"index":8,"name":"ge","type":"float","required":false,"default":0.0},{"index":9,"name":"st","type":"float","required":false,"default":0.0},{"index":10,"name":"sc","type":"float","required":false,"default":0.0},{"index":11,"name":"ss","type":"float","required":false,"default":0.0},{"index":12,"name":"mcsid","type":"int","required":false}]},"MOMENT":{"fields":[{"index":1,"name":"sid","type":"int","required":true},{"index":2,"name":"g","type":"int","required":true},{"index":3,"name":"cid","type":"int","required":false,"default":0},{"index":4,"name":"m","type":"float","required":true},{"index":5,"name":"n1","type":"float","required":true},{"index":6,"name":"n2","type":"float","required":true},{"index":7,"name":"n3","type":"float","required":true}]},"PBAR":{"fields":[{"index":1,"name":"pid","type":"int","required":true},{"index":2,"name":"mid","type":"int","required":true},{"index":3,"name":"A","type":"float","required":false,"default":0.0},{"index":4,"name":"I1","type":"float","required":false,"default":0.0},{"index":5,"name":"I2","type":"float","required":false,"default":0.0},{"index":6,"name":"J","type":"float","required":false,"default":0.0},{"index":7,"name":"nsm","type":"float","required":false,"default":0.0},{"index":9,"name":"C1","type":"float","required":false,"default":0.0},{"index":10,"name":"C2","type":"float","required":false,"default":0.0},{"index":11,"name":"D1","type":"float","required":false,"default":0.0},{"index":12,"name":"D2","type":"float","required":false,"default":0.0},{"index":13,"name":"E1","type":"float","required":false,"default":0.0},{"index":14,"name":"E2","type":"float","required":false,"default":0.0},{"index":15,"name":"F1","type":"float","required":false,"default":0.0},{"index":16,"name":"F2","type":"float","required":false,"default":0.0},{"index":17,"name":"K1","type":"float","required":false,"default":0.0},{"index":18,"name":"K2","type":"float","required":false,"default":0.0},{"index":19,"name":"I12","type":"float","required":false,"default":0.0}]},"PBEAM":{"fields":[{"index":1,"name":"pid","type":"int","required":true},{"index":2,"name":"mid","type":"int","required":true},{"index":3,"name":"a_a","type":"float","required":true},{"index":4,"name":"i1_a","type":"float","required":false},{"index":5,"name":"i2_a","type":"float","required":false},{"index":6,"name":"i12_a","type":"float","required":false},{"index":7,"name":"j_a","type":"float","required":false},{"index":8,"name":"nsm_a","type":"float","required":false,"default":0.0},{"index":9,"name":"c1_a","type":"float","required":false,"default":0.0},{"index":10,"name":"c2_a","type":"float","required":false,"default":0.0},{"index":11,"name":"d1_a","type":"float","required":false,"default":0.0},{"index":12,"name":"d2_a","type":"float","required":false,"default":0.0},{"index":13,"name":"e1_a","type":"float","required":false,"default":0.0},{"index":14,"name":"e2_a","type":"float","required":false,"default":0.0},{"index":15,"name":"f1_a","type":"float","required":false,"default":0.0},{"index":16,"name":"f2_a","type":"float","required":false,"default":0.0},{"index":17,"name":"so","type":"string","required":false},{"index":18,"name":"x_xb","type":"float","required":false},{"index":19,"name":"a","type":"float","required":false},{"index":20,"name":"i1","type":"float","required":false},{"index":21,"name":"i2","type":"float","required":false},{"index":22,"name":"i12","type":"float","required":false},{"index":23,"name":"j","type":"float","required":false},{"index":24,"name":"nsm","type":"float","required":false,"default":0.0},{"index":25,"name":"c1","type":"float","required":false},{"index":26,"name":"c2","type":"float","required":false},{"index":27,"name":"d1","type":"float","required":false},{"index":28,"name":"d2","type":"float","required":false},{"index":29,"name":"e1","type":"float","required":false},{"index":30,"name":"e2","type":"float","required":false},{"index":31,"name":"f1","type":"float","required":false},{"index":32,"name":"f2","type":"float","required":false},{"index":33,"name":"k1","type":"float","required":false},{"index":34,"name":"k2","type":"float","required":false},{"index":35,"name":"s1","type":"float","required":false},{"index":36,"name":"s2","type":"float","required":false},{"index":37,"name":"nsi_a","type":"float","required":false},{"index":38,"name":"nsi_b","type":"float","required":false},{"index":39,"name":"cw_a","type":"float","required":false},{"index":40,"name":"cw_b","type":"float","required":false},{"index":41,"name":"m1_a","type":"float","required":false},{"index":42,"name":"m2_a","type":"float","required":false},{"index":43,"name":"m1_b","type":"float","required":false},{"index":44,"name":"m2_b","type":"float","required":false},{"index":45,"name":"n1_a","type":"float","required":false},{"index":46,"name":"n2_a","type":"float","required":false},{"index":47,"name":"n1_b","type":"float","required":false},{"index":48,"name":"n2_b","type":"float","required":false}]},"PBUSH":{"fields":[{"index":1,"name":"pid","type":"int","required":true},{"index":2,"name":"K","type":"string","required":false},{"index":3,"name":"K1","type":"float","required":false,"default":0.0},{"index":4,"name":"K2","type":"float","required":false,"default":0.0},{"index":5,"name":"K3","type":"float","required":false,"default":0.0},{"index":6,"name":"K4","type":"float","required":false,"default":0.0},{"index":7,"name":"K5","type":"float","required":false,"default":0.0},{"index":8,"name":"K6","type":"float","required":false,"default":0.0},{"index":10,"name":"B","type":"string","required":false},{"index":11,"name":"B1","type":"float","required":false,"default":0.0},{"index":12,"name":"B2","type":"float","required":false,"default":0.0},{"index":13,"name":"B3","type":"float","required":false,"default":0.0},{"index":14,"name":"B4","type":"float","required":false,"default":0.0},{"index":15,"name":"B5","type":"float","required":false,"default":0.0},{"index":16,"name":"B6","type":"float","required":false,"default":0.0},{"index":18,"name":"GE","type":"string","required":false},{"index":19,"name":"GE1","type":"float","required":false,"default":0.0},{"index":20,"name":"GE2","type":"float","required":false,"default":0.0},{"index":21,"name":"GE3","type":"float","required":false,"default":0.0},{"index":22,"name":"GE4","type":"float","required":false,"default":0.0},{"index":23,"name":"GE5","type":"float","required":false,"default":0.0},{"index":24,"name":"GE6","type":"float","required":false,"default":0.0},{"index":26,"name":"RCV","type":"string","required":false},{"index":27,"name":"SA","type":"float","required":false,"default":1.0},{"index":28,"name":"ST","type":"float","required":false,"default":1.0},{"index":29,"name":"EA","type":"float","required":false,"default":1.0},{"index":30,"name":"ET","type":"float","required":false,"default":1.0}]},"PCOMP":{"fields":[{"index":1,"name":"pid","type":"int","required":true},{"index":2,"name":"z0","type":"float","required":false},{"index":3,"name":"nsm","type":"float","required":false,"default":0.0},{"index":4,"name":"sb","type":"float","required":false},{"index":5,"name":"ft","type":"string","required":false},{"index":6,"name":"tref","type":"float","required":false,"default":0.0},{"index":7,"name":"ge","type":"float","required":false,"default":0.0},{"index":8,"name":"lam","type":"string","required":false},{"index":9,"name":"mid1","type":"int","required":true},{"index":10,"name":"t1","type":"float","required":true},{"index":11,"name":"theta1","type":"float","required":false,"default":0.0},{"index":12,"name":"sout1","type":"string","required":false,"default":"NO"},{"index":13,"name":"mid2","type":"int","required":false},{"index":14,"name":"t2","type":"float","required":false},{"index":15,"name":"theta2","type":"float","required":false,"default":0.0},{"index":16,"name":"sout2","type":"string","required":false,"default":"NO"},{"index":17,"name":"mid3","type":"int","required":false},{"index":18,"name":"t3","type":"float","required":false},{"index":19,"name":"theta3","type":"float","required":false,"default":0.0},{"index":20,"name":"sout3","type":"string","required":false,"default":"NO"}]},"PLOAD2":{"fields":[{"index":1,"name":"sid","type":"int","required":true},{"index":2,"name":"p","type":"float","required":true},{"index":3,"name":"eid1","type":"int","required":false},{"index":4,"name":"eid2","type":"int","required":false},{"index":5,"name":"eid3","type":"int","required":false},{"index":6,"name":"eid4","type":"int","required":false},{"index":7,"name":"eid5","type":"int","required":false},{"index":8,"name":"eid6","type":"int","required":false}]},"PLOAD4":{"fields":[{"index":1,"name":"sid","type":"int","required":true},{"index":2,"name":"eid","type":"int","required":true},{"index":3,"name":"p1","type":"float","required":true},{"index":4,"name":"p2","type":"float","required":false},{"index":5,"name":"p3","type":"float","required":false},{"index":6,"name":"p4","type":"float","required":false},{"index":7,"name":"g1","type":"int","required":false},{"index":8,"name":"g34","type":"int","required":false},{"index":9,"name":"cid","type":"int","required":false,"default":0},{"index":10,"name":"n1","type":"float","required":false},{"index":11,"name":"n2","type":"float","required":false},{"index":12,"name":"n3","type":"float","required":false}]},"PROD":{"fields":[{"index":1,"name":"pid","type":"int","required":true},{"index":2,"name":"mid","type":"int","required":true},{"index":3,"name":"A","type":"float","required":true},{"index":4,"name":"j","type":"float","required":false,"default":0.0},{"index":5,"name":"c","type":"float","required":false,"default":0.0},{"index":6,"name":"nsm","type":"float","required":false,"default":0.0}]},"PSHELL":{"fields":[{"index":1,"name":"pid","type":"int","required":true},{"index":2,"name":"mid1","type":"int","required":false},{"index":3,"name":"t","type":"float","required":false},{"index":4,"name":"mid2","type":"int","required":false},{"index":5,"name":"i12t3","type":"float","required":false,"default":1.0},{"index":6,"name":"mid3","type":"int","required":false},{"index":7,"name":"tst","type":"float","required":false,"default":0.833333},{"index":8,"name":"nsm","type":"float","required":false,"default":0.0},{"index":9,"name":"z1","type":"float","required":false},{"index":10,"name":"z2","type":"float","required":false,"defaultFrom":"t_over_2"},{"index":11,"name":"mid4","type":"int","required":false}]},"PSOLID":{"fields":[{"index":1,"name":"pid","type":"int","required":true},{"index":2,"name":"mid","type":"int","required":true},{"index":3,"name":"cordm","type":"int","required":false,"default":0},{"index":4,"name":"integ","type":"string","required":false},{"index":5,"name":"stress","type":"string","required":false,"default":"GRID"},{"index":6,"name":"isop","type":"string","required":false},{"index":7,"name":"fctn","type":"string","required":false,"default":"SMECH"}]},"RBE2":{"fields":[{"index":1,"name":"eid","type":"int","required":true},{"index":2,"name":"gn","type":"int","required":true},{"index":3,"name":"cm","type":"string","required":true},{"index":4,"name":"gm1","type":"int","required":false},{"index":5,"name":"gm2","type":"int","required":false},{"index":6,"name":"gm3","type":"int","required":false},{"index":7,"name":"gm4","type":"int","required":false},{"index":8,"name":"gm5","type":"int","required":false},{"index":9,"name":"gm6","type":"int","required":false},{"index":10,"name":"gm7","type":"int","required":false},{"index":11,"name":"gm8","type":"int","required":false},{"index":13,"name":"alpha","type":"float","required":false,"default":0.0}]},"RBE3":{"fields":[{"index":1,"name":"eid","type":"int","required":true},{"index":3,"name":"refgrid","type":"int","required":true},{"index":4,"name":"refc","type":"string","required":true},{"index":5,"name":"wt1","type":"float","required":false},{"index":6,"name":"c1","type":"string","required":false},{"index":7,"name":"g1_1","type":"int","required":false},{"index":8,"name":"g1_2","type":"int","required":false},{"index":10,"name":"wt2","type":"float","required":false},{"index":11,"name":"c2","type":"string","required":false},{"index":12,"name":"g2_1","type":"int","required":false},{"index":13,"name":"g2_2","type":"int","required":false},{"index":15,"name":"wt3","type":"float","required":false},{"index":16,"name":"c3","type":"string","required":false},{"index":17,"name":"g3_1","type":"int","required":false},{"index":18,"name":"g3_2","type":"int","required":false},{"index":20,"name":"wt4","type":"float","required":false},{"index":21,"name":"c4","type":"string","required":false},{"index":22,"name":"g4_1","type":"int","required":false},{"index":23,"name":"g4_2","type":"int","required":false},{"index":25,"name":"um","type":"string","required":false},{"index":26,"name":"gm1","type":"int","required":false},{"index":27,"name":"cm1","type":"string","required":false},{"index":28,"name":"gm2","type":"int","required":false},{"index":29,"name":"cm2","type":"string","required":false},{"index":30,"name":"gm3","type":"int","required":false},{"index":31,"name":"cm3","type":"string","required":false},{"index":34,"name":"gm4","type":"int","required":false},{"index":35,"name":"cm4","type":"string","required":false},{"index":36,"name":"gm5","type":"int","required":false},{"index":37,"name":"cm5","type":"string","required":false},{"index":41,"name":"alpha_marker","type":"string","required":false},{"index":42,"name":"alpha","type":"float","required":false,"default":0.0}]},"SPC":{"fields":[{"index":1,"name":"sid","type":"int","required":true},{"index":2,"name":"G1","type":"int","required":true},{"index":3,"name":"C1","type":"string","required":false,"default":"0"},{"index":4,"name":"D1","type":"float","required":false,"default":0.0},{"index":5,"name":"G2","type":"int","required":false},{"index":6,"name":"C2","type":"string","required":false,"default":"0"},{"index":7,"name":"D2","type":"float","required":false,"default":0.0}]},"SPC1":{"fields":[{"index":1,"name":"sid","type":"int","required":true},{"index":2,"name":"components","type":"string","required":false,"default":"0"},{"index":3,"name":"g1","type":"int","required":false},{"index":4,"name":"g2","type":"int","required":false},{"index":5,"name":"g3","type":"int","required":false},{"index":6,"name":"g4","type":"int","required":false},{"index":7,"name":"g5","type":"int","required":false},{"index":8,"name":"g6","type":"int","required":false},{"index":9,"name":"g7","type":"int","required":false},{"index":10,"name":"g8","type":"int","required":false},{"index":11,"name":"g9","type":"int","required":false}]},"BEGIN BULK":{"fields":[],"structural":true},"CEND":{"fields":[],"structural":true},"DISPLACEMENT":{"fields":[],"structural":true},"ENDDATA":{"fields":[],"structural":true},"INCLUDE":{"fields":[],"structural":true},"SOL":{"fields":[],"structural":true},"STRESS":{"fields":[],"structural":true},"SUBCASE":{"fields":[],"structural":true}},"notes":["Generated from pyNastran source using AST analysis.","Some cards may require overrides for repeat/variant layouts."]}; // embedded from schema/nastran_schema.min.json


// Helper to match Python's s.strip(chars) behavior exactly
function python_strip(s, chars = null) {
  if (s === null || s === undefined) return '';
  const str = String(s);
  if (chars === null) return str.trim();

  const set = new Set(chars.split(''));
  let start = 0;
  let end = str.length;

  while (start < end && set.has(str[start])) start++;
  while (end > start && set.has(str[end - 1])) end--;

  return str.slice(start, end);
}

// TRANSLATION: print_scientific_8 from field_writer_8.py
function print_scientific_8(value) {
  if (value === 0.0) return '      0.';

  let python_value = value.toExponential(11);
  let [svalue, sexponent] = python_value.split('e');
  let exponent = parseInt(sexponent, 10);
  let sign = Math.abs(value) < 1.0 ? '-' : '+';
  let exp2 = String(Math.abs(exponent));
  let value2 = parseFloat(svalue);
  let leftover = 5 - exp2.length;

  let fmtPrecision;
  if (value < 0) {
    fmtPrecision = leftover - 1;
  } else {
    fmtPrecision = leftover;
  }

  if (fmtPrecision < 0) fmtPrecision = 0;
  let svalue3 = value2.toFixed(fmtPrecision);
  let svalue4 = python_strip(svalue3, '0');

  let field = svalue4 + sign + exp2;
  return field.padStart(8, ' ');
}

function formatFloat8(value) {
  if (value === null || typeof value === 'undefined' || Number.isNaN(value) || !Number.isFinite(value)) {
    return '        ';
  }
  if (value === 0.0) return '      0.';

  let field = '';

  if (value > 0.0) {
    if (value < 5e-8) return print_scientific_8(value);

    if (value < 0.001) {
      field = print_scientific_8(value);
      let field2 = value.toFixed(7);
      field2 = python_strip(field2, '0 ');

      let field1 = field.replace('-', 'e-');

      if (field2 === '.') return print_scientific_8(value);

      if (field2.length <= 8 && parseFloat(field1) === parseFloat(field2)) {
        field = field2;
        field = python_strip(field, ' 0');
      }
    } else if (value < 1.0) field = value.toFixed(7);
    else if (value < 10.0) field = value.toFixed(6);
    else if (value < 100.0) field = value.toFixed(5);
    else if (value < 1000.0) field = value.toFixed(4);
    else if (value < 10000.0) field = value.toFixed(3);
    else if (value < 100000.0) field = value.toFixed(2);
    else if (value < 1000000.0) field = value.toFixed(1);
    else {
      field = value.toFixed(1);
      if (field.indexOf('.') < 8) {
        field = Math.round(value).toFixed(1).slice(0, 8);
      } else {
        return print_scientific_8(value);
      }
      return field;
    }
  } else {
    if (value > -5e-7) return print_scientific_8(value);

    if (value > -0.01) {
      field = print_scientific_8(value);
      let field2 = value.toFixed(6);
      field2 = python_strip(field2, '0 ');

      let stripped = python_strip(field, ' 0-');
      let field1 = '-' + stripped.replace('-', 'e-');

      if (field2.length <= 8 && parseFloat(field1) === parseFloat(field2)) {
        field = field2.replace(/[ 0]+$/, '');
        field = field.replace('-0.', '-.');
      }
    } else if (value > -1.0) {
      field = value.toFixed(6);
      field = field.replace('-0.', '-.');
    } else if (value > -10.0) field = value.toFixed(5);
    else if (value > -100.0) field = value.toFixed(4);
    else if (value > -1000.0) field = value.toFixed(3);
    else if (value > -10000.0) field = value.toFixed(2);
    else if (value > -100000.0) field = value.toFixed(1);
    else if (value <= -999999.5) return print_scientific_8(value);
    else {
      field = value.toFixed(1);
      let ifield = field.indexOf('.');
      if (ifield === -1) throw new Error('error printing float; cant find decimal');

      if (ifield < 8) {
        let rounded = Math.round(value);
        let s = String(rounded).padStart(7, ' ') + '.';
        field = s;
      } else {
        return print_scientific_8(value);
      }
      return field;
    }
  }

  field = python_strip(String(field), ' 0');
  return field.padStart(8, ' ');
}

function formatFloat16(val) {
  // TRANSLATION: print_scientific_16 + print_float_16 from pyNastran.bdf.field_writer_16.py
  const width = 16;

  if (val === null || typeof val === 'undefined' || Number.isNaN(val) || !Number.isFinite(val)) {
    return ' '.repeat(width);
  }

  // Handles +0.0 / -0.0
  if (val === 0.0) {
    return '0.'.padStart(width, ' ');
  }

  const print_scientific_16 = (value) => {
    if (value === 0.0) return '0.'.padStart(width, ' ');

    const python_value = value.toExponential(14);
    const parts = python_value.split('e');
    const svalue = parts[0];
    const sexponent = parts[1] ?? '0';
    const exponent = parseInt(sexponent, 10);

    const sign = Math.abs(value) < 1.0 ? '-' : '+';
    const sexp2 = String(Math.abs(exponent));
    const value2 = parseFloat(svalue);

    const len_sexp = sexp2.length + 1; // +1 for exponent sign
    const leftover = width - len_sexp;

    let fmtPrecision = value < 0 ? (leftover - 3) : (leftover - 2);
    if (fmtPrecision < 0) fmtPrecision = 0;

    const svalue3 = value2.toFixed(fmtPrecision);
    const svalue4 = python_strip(svalue3, '0');
    const field = svalue4 + sign + sexp2;
    return field.padStart(width, ' ');
  };

  const rstripChars = (s, chars) => {
    if (s === null || s === undefined) return '';
    const set = new Set(String(chars).split(''));
    let end = String(s).length;
    while (end > 0 && set.has(String(s)[end - 1])) end--;
    return String(s).slice(0, end);
  };

  let field = '';

  if (val > 0.0) {
    if (val < 5e-16) {
      return print_scientific_16(val);
    } else if (val < 0.001) {
      field = print_scientific_16(val);
      let field2 = val.toFixed(15);
      field2 = python_strip(field2, '0 ');
      const field1 = field.replace('-', 'e-');

      if (field2 === '.') return print_scientific_16(val);

      if (field2.length <= width && parseFloat(field1) === parseFloat(field2)) {
        field = python_strip(field2, ' 0');
      }
      return String(field).padStart(width, ' ');
    } else if (val < 1.0) field = val.toFixed(15);
    else if (val < 10.0) field = val.toFixed(14);
    else if (val < 100.0) field = val.toFixed(13);
    else if (val < 1000.0) field = val.toFixed(12);
    else if (val < 10000.0) field = val.toFixed(11);
    else if (val < 100000.0) field = val.toFixed(10);
    else if (val < 1000000.0) field = val.toFixed(9);
    else if (val < 10000000.0) field = val.toFixed(8);
    else if (val < 100000000.0) field = val.toFixed(7);
    else if (val < 1000000000.0) field = val.toFixed(6);
    else if (val < 10000000000.0) field = val.toFixed(5);
    else if (val < 100000000000.0) field = val.toFixed(4);
    else if (val < 1000000000000.0) field = val.toFixed(3);
    else if (val < 10000000000000.0) field = val.toFixed(2);
    else if (val < 100000000000000.0) field = val.toFixed(1);
    else {
      field = val.toFixed(1);
      if (field.indexOf('.') < width) {
        field = Math.round(val).toFixed(1).padStart(width, ' ').slice(0, width);
      } else {
        return print_scientific_16(val);
      }
      return field;
    }
  } else {
    if (val > -5e-15) {
      return print_scientific_16(val);
    } else if (val > -0.01) {
      field = print_scientific_16(val);
      let field2 = val.toFixed(14);
      field2 = python_strip(field2, '0 ');

      const stripped = python_strip(field, ' 0-');
      const field1 = '-' + stripped.replace('-', 'e-');

      if (field2.length <= width && parseFloat(field1) === parseFloat(field2)) {
        field = rstripChars(field2, ' 0');
        field = field.replace('-0.', '-.');
      }
      return String(field).padStart(width, ' ');
    } else if (val > -1.0) {
      field = val.toFixed(14);
      field = field.replace('-0.', '-.');
    } else if (val > -10.0) field = val.toFixed(13);
    else if (val > -100.0) field = val.toFixed(12);
    else if (val > -1000.0) field = val.toFixed(11);
    else if (val > -10000.0) field = val.toFixed(10);
    else if (val > -100000.0) field = val.toFixed(9);
    else if (val > -1000000.0) field = val.toFixed(8);
    else if (val > -10000000.0) field = val.toFixed(7);
    else if (val > -100000000.0) field = val.toFixed(6);
    else if (val > -1000000000.0) field = val.toFixed(5);
    else if (val > -10000000000.0) field = val.toFixed(4);
    else if (val > -100000000000.0) field = val.toFixed(3);
    else if (val > -1000000000000.0) field = val.toFixed(2);
    else if (val > -10000000000000.0) field = val.toFixed(1);
    else {
      field = val.toFixed(1);
      const ifield = field.indexOf('.');
      if (ifield === -1) throw new Error('error printing float16; cant find decimal');

      if (ifield < width) {
        const rounded = Math.round(val);
        field = String(rounded).padStart(width - 1, ' ') + '.';
      } else {
        return print_scientific_16(val);
      }
      return field;
    }
  }

  field = python_strip(String(field), ' 0');
  return field.padStart(width, ' ');
}

function pushParseIssue(strictMode, errors, warnings, issue) {
  (strictMode ? errors : warnings).push(issue);
}

function vAdd(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function vSub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vScale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function vDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vCross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function vNorm(a) {
  return Math.sqrt(vDot(a, a));
}

function vNormalize(a) {
  const n = vNorm(a);
  if (!Number.isFinite(n) || n === 0) return null;
  return vScale(a, 1 / n);
}

function applyBasis(axes, v) {
  // axes: [xAxis,yAxis,zAxis] in some parent frame
  return vAdd(vAdd(vScale(axes[0], v[0]), vScale(axes[1], v[1])), vScale(axes[2], v[2]));
}

function computeCord2RAxes(A, B, C) {
  const zRaw = vSub(B, A);
  const z = vNormalize(zRaw);
  if (!z) return null;
  const cRaw = vSub(C, A);
  const cProj = vScale(z, vDot(cRaw, z));
  const xRaw = vSub(cRaw, cProj);
  const x = vNormalize(xRaw);
  if (!x) return null;
  const y = vCross(z, x);
  const yN = vNormalize(y);
  if (!yN) return null;
  return [x, yN, z];
}

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function coordLocalToRect(coordType, p) {
  if (!Array.isArray(p) || p.length < 3) return null;
  const x1 = Number(p[0]);
  const x2 = Number(p[1]);
  const x3 = Number(p[2]);
  if (![x1, x2, x3].every((v) => Number.isFinite(v))) return null;

  const type = toUpper(coordType);
  if (type === 'CORD2C' || type === 'CORD1C') {
    const th = degToRad(x2);
    return [x1 * Math.cos(th), x1 * Math.sin(th), x3];
  }
  if (type === 'CORD2S' || type === 'CORD1S') {
    const theta = degToRad(x2);
    const phi = degToRad(x3);
    const st = Math.sin(theta);
    return [x1 * st * Math.cos(phi), x1 * st * Math.sin(phi), x1 * Math.cos(theta)];
  }
  return [x1, x2, x3];
}

// Tier-1 enforcement (opt-in). This is intended as a compliance gate, not as
// the default behavior for tokenizer fixtures.
const FALLBACK_TIER1_CARDS = new Set([
  // Deck structure / control
  'SOL',
  'CEND',
  'SUBCASE',
  'DISPLACEMENT',
  'STRESS',
  'INCLUDE',

  // Grids / coords
  'GRID',
  'CORD2R',
  'CORD2C',
  'CORD2S',
  'CORD1R',
  'CORD1C',

  // Elements
  'CTRIA3',
  'CQUAD4',
  'CHEXA',
  'CTETRA',
  'CROD',
  'CBAR',
  'CBEAM',
  'CBUSH',
  'RBE2',
  'RBE3',

  // Properties
  'PSHELL',
  'PSOLID',
  'PROD',
  'PBAR',
  'PBUSH',

  // Materials
  'MAT1',

  // Mass
  'CONM2',

  // Loads
  'FORCE',
  'MOMENT',
  'PLOAD2',
  'PLOAD4',
  'LOAD',

  // Constraints
  'SPC',
  'SPC1'
]);

// Cards that are considered "handled" even if not hydrated yet.
// (e.g., executive/case control lines are tokenized but not indexed.)
const TIER1_ALWAYS_ALLOWED = new Set(['SOL', 'CEND', 'SUBCASE', 'DISPLACEMENT', 'STRESS', 'INCLUDE', 'BEGIN BULK', 'ENDDATA']);

function getTierKeyword(rec) {
  if (!rec) return '';
  const fmt = String(rec.fmt || '');
  if (fmt === 'free') {
    const head = rec.tokens && rec.tokens.length ? String(rec.tokens[0]) : String(rec.name || '');
    return head.trim().split(/\s+/)[0].toUpperCase();
  }
  const line = getRecordFirstLine(rec);
  if (!line) {
    const fallback = String(rec.name || '').trim().toUpperCase();
    if (!fallback) return '';
    if (fallback === 'BEGIN BULK' || fallback === 'ENDDATA') return fallback;
    return fallback.endsWith('*') ? fallback.slice(0, -1) : fallback;
  }
  if (isInBulkBeginLine(line)) return 'BEGIN BULK';
  if (isEndDataLine(line)) return 'ENDDATA';
  const head8 = line.trimStart().slice(0, 8).trim();
  const first = head8.split(/\s+/)[0];
  return (first.endsWith('*') ? first.slice(0, -1) : first).toUpperCase();
}

function getHydrationTokens(record) {
  if (record && record.tokensHydrationReady === true && Array.isArray(record.tokens)) {
    return record.tokens;
  }
  // Returns a token list suitable for schema/hydrator field mapping.
  // For fixed-field formats, strip continuation-id columns:
  // - small-field: exclude field 10 (cols 73-80) on every physical line
  // - large-field: exclude the final 8-char continuation marker column on every physical line
  // This keeps tokenizer behavior stable while avoiding corruption during hydration.
  const fmt = String(record && record.fmt ? record.fmt : '');
  const name = toUpper(record && record.name ? record.name : '');
  if (fmt === 'free') {
    if (record && Array.isArray(record.lineTokens) && record.lineTokens.length > 0) {
      /** @type {string[]} */
      const merged = [name];
      for (let i = 0; i < record.lineTokens.length; i++) {
        const parts = Array.isArray(record.lineTokens[i]) ? record.lineTokens[i] : [];
        if (parts.length === 0) continue;
        const row = parts.slice();
        if (row.length > 1 && isFreeTrailingContinuationToken(row[row.length - 1], row.length - 1)) row.pop();
        if (i === 0) {
          merged.push(...row.slice(1));
          continue;
        }
        const head = String(row[0] || '').trim();
        if (isFreeContinuationHead(head)) merged.push(...row.slice(1));
        else merged.push(...row);
      }
      return merged;
    }
    return Array.isArray(record && record.tokens) ? record.tokens : [name];
  }

  if (!record || !Array.isArray(record.lineTokens) || record.lineTokens.length === 0) {
    return Array.isArray(record && record.tokens) ? record.tokens : [name];
  }

  const data = [];
  if (fmt === 'small') {
    for (let i = 0; i < record.lineTokens.length; i++) {
      const parts = record.lineTokens[i] || [];
      const row = parts.slice(1, 9);
      if (row.length > 7) row[7] = stripSmallFieldTrailingContinuationMarker(row[7]);
      data.push(...row);
    }
    return [name, ...data];
  }

  if (fmt === 'large') {
    for (let i = 0; i < record.lineTokens.length; i++) {
      const parts = record.lineTokens[i] || [];
      data.push(...parts.slice(1, 5));
    }
    return [name, ...data];
  }

  return Array.isArray(record && record.tokens) ? record.tokens : [name];
}

function applyTier1Enforcement(cardStream, strictMode, enforceTier1, options, errors, warnings) {
  if (!enforceTier1) return cardStream;

  const tier1Cards = getTier1CardSetFromOptions(options);

  const handledForNow = new Set([
    'GRID',
    'CORD2R',
    'CORD2C',
    'CORD2S',
    'CORD1R',
    'CORD1C',
    'CTRIA3',
    'CTRIA6',
    'CQUAD4',
    'CQUAD8',
    'CTETRA',
    'CHEXA',
    'PSHELL',
    'PSOLID',
    'PBAR',
    'PBUSH',
    'PBEAM',
    'PCOMP',
    'CROD',
    'CBAR',
    'CBEAM',
    'CPENTA',
    'PROD',
    'MAT1',
    // Loads
    'FORCE',
    'MOMENT',
    'PLOAD2',
    'PLOAD4',
    'LOAD',
    // Constraints
    'SPC',
    'SPC1',
    // Mass
    'CONM2',
    // Rigid elements
    'RBE2',
    'RBE3',
    ...TIER1_ALWAYS_ALLOWED
  ]);
  /** @type {Array<{kind:string,[k:string]:any}>} */
  const out = [];

  for (const rec of cardStream) {
    if (!rec || rec.kind !== 'card') {
      out.push(rec);
      continue;
    }

    const keyword = getTierKeyword(rec);
    if (!tier1Cards.has(keyword)) {
      out.push(rec);
      continue;
    }

    if (handledForNow.has(keyword)) {
      out.push(rec);
      continue;
    }

    const issue = makeIssue('TIER1_UNSUPPORTED', `Tier 1 card '${keyword}' is not yet supported by the hydrator`, {
      source: rec.source,
      cardName: keyword
    });

    if (strictMode) {
      errors.push(issue);
      out.push(rec);
      continue;
    }

    warnings.push(issue);
    const downgraded = {
      kind: 'unknown',
      name: keyword,
      fmt: rec.fmt,
      source: rec.source
    };
    if (Array.isArray(rec.rawLines)) downgraded.rawLines = rec.rawLines;
    if (Array.isArray(rec.sourceLineRanges)) downgraded.sourceLineRanges = rec.sourceLineRanges;
    if (Array.isArray(rec.sourceSpan) && rec.sourceSpan.length >= 2) downgraded.sourceSpan = rec.sourceSpan;
    if (typeof rec.sourceFirstLine === 'string') downgraded.sourceFirstLine = rec.sourceFirstLine;
    out.push(downgraded);
  }

  return out;
}

function hydrateRbe2(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const eid = parseNastranInt(t[1]);
  const gn = parseNastranInt(t[2]);
  const cmTok = parseNastranString(t[3]);

  if (![eid, gn].every((v) => Number.isFinite(v)) || !cmTok) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'RBE2: invalid required fields', {
        source: record.source,
        cardName: 'RBE2',
        details: { eid: t[1], gn: t[2], cm: t[3] }
      })
    );
    return null;
  }

  const cm = String(cmTok).trim();
  const isIntToken = (tok) => {
    if (isBlankToken(tok)) return false;
    return Number.isFinite(parseNastranInt(tok));
  };
  const isFloatToken = (tok) => {
    if (isBlankToken(tok)) return false;
    if (isIntToken(tok)) return false;
    return Number.isFinite(parseNastranFloat(tok));
  };

  // Find last non-blank token index.
  let lastIdx = t.length - 1;
  while (lastIdx >= 0 && isBlankToken(t[lastIdx])) lastIdx--;

  let alpha = 0.0;
  let tref = 0.0;
  let trailing = 0;
  if (lastIdx >= 4 && isFloatToken(t[lastIdx])) {
    // 1 or 2 trailing floats.
    if (lastIdx - 1 >= 4 && isFloatToken(t[lastIdx - 1])) {
      alpha = parseNastranFloat(t[lastIdx - 1]);
      tref = parseNastranFloat(t[lastIdx]);
      trailing = 2;
    } else {
      alpha = parseNastranFloat(t[lastIdx]);
      trailing = 1;
    }
  }

  const endGmIdx = lastIdx - trailing;
  if (endGmIdx < 4) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'RBE2: missing dependent grid list', {
        source: record.source,
        cardName: 'RBE2',
        details: { eid, gn, cm }
      })
    );
    return null;
  }

  /** @type {number[]} */
  const gmi = [];
  for (let i = 4; i <= endGmIdx; i++) {
    const v = parseNastranInt(t[i]);
    if (!Number.isFinite(v)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'RBE2: invalid dependent grid id', {
          source: record.source,
          cardName: 'RBE2',
          details: { eid, token: t[i] }
        })
      );
      return null;
    }
    gmi.push(v);
  }

  return {
    type: 'RBE2',
    eid,
    gn,
    cm,
    gmi,
    alpha: Number.isFinite(alpha) ? alpha : 0.0,
    tref: Number.isFinite(tref) ? tref : 0.0,
    source: record.source
  };
}

function hydrateRbe3(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const eid = parseNastranInt(t[1]);
  const refgrid = parseNastranInt(t[3]);
  const refcTok = parseNastranString(t[4]);

  if (![eid, refgrid].every((v) => Number.isFinite(v)) || !refcTok) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'RBE3: invalid required header fields', {
        source: record.source,
        cardName: 'RBE3',
        details: { eid: t[1], refgrid: t[3], refc: t[4] }
      })
    );
    return null;
  }

  const refc = String(refcTok).trim();
  const upperTok = (tok) => String(tok ?? '').trim().toUpperCase();
  const isIntToken = (tok) => {
    if (isBlankToken(tok)) return false;
    return Number.isFinite(parseNastranInt(tok));
  };
  const isFloatToken = (tok) => {
    if (isBlankToken(tok)) return false;
    if (isIntToken(tok)) return false;
    return Number.isFinite(parseNastranFloat(tok));
  };

  // Find last non-blank token index.
  let lastIdx = t.length - 1;
  while (lastIdx >= 0 && isBlankToken(t[lastIdx])) lastIdx--;

  /** @type {Array<{wt:number,c:string,gids:number[]}>} */
  const groups = [];
  /** @type {Array<{gm:number,cm:string}>} */
  const um = [];
  let alpha = 0.0;
  let tref = 0.0;
  let hasAlpha = false;
  let hasTref = false;

  let mode = 'groups'; // groups | um | alpha
  let current = null;

  let i = 5;
  while (i <= lastIdx) {
    const tok = t[i];
    if (isBlankToken(tok)) {
      i++;
      continue;
    }
    const u = upperTok(tok);
    if (u === 'UM') {
      mode = 'um';
      i++;
      continue;
    }
    if (u === 'ALPHA') {
      mode = 'alpha';
      i++;
      continue;
    }

    if (mode === 'alpha') {
      const a = parseNastranFloat(tok);
      if (!Number.isFinite(a)) {
        pushParseIssue(
          strictMode,
          errors,
          warnings,
          makeIssue('CARD_PARSE', 'RBE3: invalid ALPHA value', {
            source: record.source,
            cardName: 'RBE3',
            details: { eid, token: tok }
          })
        );
        return null;
      }
      alpha = a;
      hasAlpha = true;
      if (i + 1 <= lastIdx && isFloatToken(t[i + 1])) {
        const tr = parseNastranFloat(t[i + 1]);
        if (Number.isFinite(tr)) {
          tref = tr;
          hasTref = true;
        }
      }
      break;
    }

    if (mode === 'um') {
      const gm = parseNastranInt(tok);
      const cmTok = t[i + 1];
      if (!Number.isFinite(gm) || isBlankToken(cmTok)) {
        pushParseIssue(
          strictMode,
          errors,
          warnings,
          makeIssue('CARD_PARSE', 'RBE3: invalid UM pair', {
            source: record.source,
            cardName: 'RBE3',
            details: { eid, gm: tok, cm: cmTok }
          })
        );
        return null;
      }
      um.push({ gm, cm: String(cmTok).trim() });
      i += 2;
      continue;
    }

    // mode === 'groups'
    const nextTok = i + 1 <= lastIdx ? t[i + 1] : null;
    const nextUpper = upperTok(nextTok);
    const canBeInferredAlpha = isFloatToken(tok) && (nextTok == null || isFloatToken(nextTok) || nextUpper === 'UM' || nextUpper === 'ALPHA');
    if (canBeInferredAlpha) {
      mode = 'alpha';
      continue;
    }

    if (isFloatToken(tok)) {
      const wt = parseNastranFloat(tok);
      const cTok = t[i + 1];
      if (!Number.isFinite(wt) || isBlankToken(cTok)) {
        pushParseIssue(
          strictMode,
          errors,
          warnings,
          makeIssue('CARD_PARSE', 'RBE3: invalid weight group header', {
            source: record.source,
            cardName: 'RBE3',
            details: { eid, wt: tok, c: cTok }
          })
        );
        return null;
      }
      current = { wt, c: String(cTok).trim(), gids: [] };
      groups.push(current);
      i += 2;
      continue;
    }

    if (!current) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'RBE3: expected weight group before grid list', {
          source: record.source,
          cardName: 'RBE3',
          details: { eid, token: tok }
        })
      );
      return null;
    }

    const gid = parseNastranInt(tok);
    if (!Number.isFinite(gid)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'RBE3: invalid grid id in weight group', {
          source: record.source,
          cardName: 'RBE3',
          details: { eid, token: tok }
        })
      );
      return null;
    }
    current.gids.push(gid);
    i += 1;
  }

  if (groups.length === 0) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'RBE3: missing weight groups', {
        source: record.source,
        cardName: 'RBE3',
        details: { eid }
      })
    );
    return null;
  }

  return {
    type: 'RBE3',
    eid,
    refgrid,
    refc,
    groups,
    um,
    alpha: hasAlpha && Number.isFinite(alpha) ? alpha : null,
    tref: hasTref && Number.isFinite(tref) ? tref : null,
    tokens: t.slice(),
    source: record.source
  };
}

function parseSchemaFromOptions(options) {
  const schema = options && (options.schema || options.nastranSchema);
  if (!schema) return BUILTIN_NASTRAN_SCHEMA;
  if (typeof schema === 'string') {
    try {
      return JSON.parse(schema);
    } catch {
      return null;
    }
  }
  if (typeof schema === 'object') return schema;
  return null;
}

function getTier1CardSetFromSchema(schema) {
  if (!schema || typeof schema !== 'object') return null;
  const cards = schema.cards;
  if (!cards || typeof cards !== 'object') return null;
  const set = new Set();
  for (const k of Object.keys(cards)) set.add(String(k).trim().toUpperCase());
  return set;
}

function getTier1CardSetFromOptions(options) {
  const schema = parseSchemaFromOptions(options);
  const fromSchema = getTier1CardSetFromSchema(schema);
  return fromSchema || FALLBACK_TIER1_CARDS;
}

function getCardDefFromSchema(schema, cardName) {
  if (!schema || typeof schema !== 'object') return null;
  const cards = schema.cards;
  if (!cards || typeof cards !== 'object') return null;
  const key = toUpper(cardName);
  return cards[key] || null;
}

function hasNonEmptySchemaDef(schema, cardName) {
  const def = getCardDefFromSchema(schema, cardName);
  return !!(def && Array.isArray(def.fields) && def.fields.length > 0);
}

function hydrateBySchema(record, schemaDef, strictMode, errors, warnings) {
  if (!record || !schemaDef || !Array.isArray(schemaDef.fields)) return null;
  const name = toUpper(record.name);
  const t = getHydrationTokens(record);
  if (!t || t.length === 0) return null;

  /** @type {{[k:string]: any}} */
  const out = { type: name, source: record.source };

  const parseByType = (raw, fType) => {
    if (fType === 'int') return parseNastranInt(raw);
    if (fType === 'float') return parseNastranFloat(raw);
    if (fType === 'number') {
      if (isBlankToken(raw)) return null;
      const s = String(raw).trim();
      if (/^[+-]?\d+$/.test(s)) return parseNastranInt(raw);
      return parseNastranFloat(raw);
    }
    if (fType === 'blank') return null;
    return parseNastranString(raw);
  };

  // For schema-driven hydration, prefer explicit 1-based field indexes.
  // If indexes are omitted (e.g. ad-hoc test schemas), fall back to implicit
  // sequential indexing.
  // Note: token array is [cardName, field1, field2, ...]
  const memo = new Map();
  const resolvedIndexByName = new Map();
  const getFieldValue = (field) => {
    const fName = field && field.name ? String(field.name) : '';
    if (!fName) return null;
    if (memo.has(fName)) return memo.get(fName);
    const fType = field && field.type ? String(field.type) : 'string';
    const idx = field && Number.isFinite(field.index) ? field.index : resolvedIndexByName.get(fName);
    const raw = idx != null ? t[idx] : null;

    let val = parseByType(raw, fType);
    if (typeof val === 'number' && Number.isNaN(val)) val = null;

    // Apply defaults for blank tokens.
    if (val == null && isBlankToken(raw)) {
      const df = field && field.defaultFrom ? String(field.defaultFrom) : '';
      if (df) {
        val = out[df];
        if (typeof val === 'number' && Number.isNaN(val)) val = null;
      }
      if (val == null && field && Object.prototype.hasOwnProperty.call(field, 'default')) {
        val = field.default;
      }
    }

    memo.set(fName, val);
    return val;
  };

  // Pre-resolve implicit indices so lookups are stable regardless of defaults.
  let implicitIndex = 1;
  for (const field of schemaDef.fields) {
    const fName = field && field.name ? String(field.name) : '';
    if (!fName) continue;
    const idx = field && Number.isFinite(field.index) ? field.index : implicitIndex;
    resolvedIndexByName.set(fName, idx);
    if (!(field && Number.isFinite(field.index))) implicitIndex++;
  }

  for (const field of schemaDef.fields) {
    const fName = field && field.name ? String(field.name) : '';
    const fType = field && field.type ? String(field.type) : 'string';
    const required = !!(field && field.required);
    if (!fName) continue;

    // Reserved blanks are used to preserve layout; do not hydrate into the object.
    if (fType === 'blank') continue;

    if (fType === 'list') {
      const items = Array.isArray(field.items) ? field.items : [];
      const itemLen = items.length;
      const startIdx = field && Number.isFinite(field.index) ? field.index : resolvedIndexByName.get(fName) ?? 1;
      const rest = t.slice(startIdx);

      if (itemLen === 0) {
        out[fName] = [];
        ti = t.length;
        continue;
      }
      if (rest.length % itemLen !== 0) {
        pushParseIssue(
          strictMode,
          errors,
          warnings,
          makeIssue('CARD_PARSE', `${name}: invalid list field '${fName}' (expected groups of ${itemLen})`, {
            source: record.source,
            cardName: name,
            details: { field: fName, tokens: rest }
          })
        );
        return null;
      }

      const arr = [];
      for (let i = 0; i < rest.length; i += itemLen) {
        const group = rest.slice(i, i + itemLen);
        if (group.every((x) => isBlankToken(x))) continue;

        const obj = {};
        for (let j = 0; j < items.length; j++) {
          const it = items[j] || {};
          const itName = it.name ? String(it.name) : '';
          const itType = it.type ? String(it.type) : 'string';
          const itReq = !!it.required;
          const raw = group[j];

          let val = null;
          if (itType === 'int') val = parseNastranInt(raw);
          else if (itType === 'float') val = parseNastranFloat(raw);
          else val = parseNastranString(raw);

          if (itReq && (val == null || (typeof val === 'number' && Number.isNaN(val)))) {
            pushParseIssue(
              strictMode,
              errors,
              warnings,
              makeIssue('CARD_PARSE', `${name}: invalid required list item '${itName || '(unnamed)'}'`, {
                source: record.source,
                cardName: name,
                details: { field: fName, item: itName, raw }
              })
            );
            return null;
          }

          if (typeof val === 'number' && Number.isNaN(val)) val = null;
          if (itName) obj[itName] = val;
        }
        arr.push(obj);
      }

      if (required && arr.length === 0) {
        pushParseIssue(
          strictMode,
          errors,
          warnings,
          makeIssue('CARD_PARSE', `${name}: missing required list field '${fName}'`, {
            source: record.source,
            cardName: name,
            details: { field: fName }
          })
        );
        return null;
      }

      out[fName] = arr;
      continue;
    }

    const idx = field && Number.isFinite(field.index) ? field.index : resolvedIndexByName.get(fName);
    const raw = idx != null ? t[idx] : null;
    let val = getFieldValue(field);

    if (required && (val == null || (typeof val === 'number' && Number.isNaN(val)))) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', `${name}: invalid required field '${fName}'`, {
          source: record.source,
          cardName: name,
          details: { field: fName, raw }
        })
      );
      return null;
    }

    out[fName] = val == null ? null : val;
  }

  return out;
}

function hydrateCord2R(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const cid = parseNastranInt(t[1]);
  const rid = parseNastranInt(t[2]);
  const a = [parseNastranFloat(t[3]), parseNastranFloat(t[4]), parseNastranFloat(t[5])];
  const b = [parseNastranFloat(t[6]), parseNastranFloat(t[7]), parseNastranFloat(t[8])];
  const c = [parseNastranFloat(t[9]), parseNastranFloat(t[10]), parseNastranFloat(t[11])];

  if (!Number.isFinite(cid) || cid < 1) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CORD2R: invalid CID (expected integer > 0)', { source: record.source, cardName: 'CORD2R', details: { cid: t[1] } })
    );
    return null;
  }
  if (!isBlankToken(t[2]) && (!Number.isFinite(rid) || rid < 0)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CORD2R: invalid RID (expected integer >= 0 or blank)', {
        source: record.source,
        cardName: 'CORD2R',
        details: { rid: t[2] }
      })
    );
    return null;
  }
  if (![...a, ...b, ...c].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CORD2R: invalid A/B/C points', {
        source: record.source,
        cardName: 'CORD2R',
        details: { a: [t[3], t[4], t[5]], b: [t[6], t[7], t[8]], c: [t[9], t[10], t[11]] }
      })
    );
    return null;
  }
  const axes = computeCord2RAxes(a, b, c);
  if (!axes) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CORD2R: invalid axis definition (degenerate points)', { source: record.source, cardName: 'CORD2R' })
    );
    return null;
  }

  return {
    cid,
    rid: Number.isFinite(rid) ? rid : 0,
    type: 'CORD2R',
    origin: a,
    pointB: b,
    pointC: c,
    axes,
    source: record.source
  };
}

function hydrateCord2C(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const cid = parseNastranInt(t[1]);
  const rid = parseNastranInt(t[2]);
  const a = [parseNastranFloat(t[3]), parseNastranFloat(t[4]), parseNastranFloat(t[5])];
  const b = [parseNastranFloat(t[6]), parseNastranFloat(t[7]), parseNastranFloat(t[8])];
  const c = [parseNastranFloat(t[9]), parseNastranFloat(t[10]), parseNastranFloat(t[11])];

  if (!Number.isFinite(cid) || cid < 1) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CORD2C: invalid CID (expected integer > 0)', { source: record.source, cardName: 'CORD2C', details: { cid: t[1] } })
    );
    return null;
  }
  if (!isBlankToken(t[2]) && (!Number.isFinite(rid) || rid < 0)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CORD2C: invalid RID (expected integer >= 0 or blank)', {
        source: record.source,
        cardName: 'CORD2C',
        details: { rid: t[2] }
      })
    );
    return null;
  }
  if (![...a, ...b, ...c].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CORD2C: invalid A/B/C points', {
        source: record.source,
        cardName: 'CORD2C',
        details: { a: [t[3], t[4], t[5]], b: [t[6], t[7], t[8]], c: [t[9], t[10], t[11]] }
      })
    );
    return null;
  }
  const axes = computeCord2RAxes(a, b, c);
  if (!axes) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CORD2C: invalid axis definition (degenerate points)', { source: record.source, cardName: 'CORD2C' })
    );
    return null;
  }

  return {
    cid,
    rid: Number.isFinite(rid) ? rid : 0,
    type: 'CORD2C',
    origin: a,
    pointB: b,
    pointC: c,
    axes,
    source: record.source
  };
}

function hydrateCord2S(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const cid = parseNastranInt(t[1]);
  const rid = parseNastranInt(t[2]);
  const a = [parseNastranFloat(t[3]), parseNastranFloat(t[4]), parseNastranFloat(t[5])];
  const b = [parseNastranFloat(t[6]), parseNastranFloat(t[7]), parseNastranFloat(t[8])];
  const c = [parseNastranFloat(t[9]), parseNastranFloat(t[10]), parseNastranFloat(t[11])];

  if (!Number.isFinite(cid) || cid < 1) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CORD2S: invalid CID (expected integer > 0)', { source: record.source, cardName: 'CORD2S', details: { cid: t[1] } })
    );
    return null;
  }
  if (!isBlankToken(t[2]) && (!Number.isFinite(rid) || rid < 0)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CORD2S: invalid RID (expected integer >= 0 or blank)', {
        source: record.source,
        cardName: 'CORD2S',
        details: { rid: t[2] }
      })
    );
    return null;
  }
  if (![...a, ...b, ...c].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CORD2S: invalid A/B/C points', {
        source: record.source,
        cardName: 'CORD2S',
        details: { a: [t[3], t[4], t[5]], b: [t[6], t[7], t[8]], c: [t[9], t[10], t[11]] }
      })
    );
    return null;
  }
  const axes = computeCord2RAxes(a, b, c);
  if (!axes) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CORD2S: invalid axis definition (degenerate points)', { source: record.source, cardName: 'CORD2S' })
    );
    return null;
  }

  return {
    cid,
    rid: Number.isFinite(rid) ? rid : 0,
    type: 'CORD2S',
    origin: a,
    pointB: b,
    pointC: c,
    axes,
    source: record.source
  };
}

function hydrateCord1ByNodes(record, cardName, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const cid = parseNastranInt(t[1]);
  const g1 = parseNastranInt(t[2]);
  const g2 = parseNastranInt(t[3]);
  const g3 = parseNastranInt(t[4]);

  if (!Number.isFinite(cid) || cid < 1) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', `${cardName}: invalid CID (expected integer > 0)`, { source: record.source, cardName, details: { cid: t[1] } })
    );
    return null;
  }
  if (![g1, g2, g3].every((v) => Number.isFinite(v) && v > 0)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', `${cardName}: invalid G1/G2/G3 (expected integer > 0)`, {
        source: record.source,
        cardName,
        details: { g1: t[2], g2: t[3], g3: t[4] }
      })
    );
    return null;
  }
  if (g1 === g2 || g1 === g3 || g2 === g3) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', `${cardName}: invalid node triplet (duplicate G1/G2/G3)`, {
        source: record.source,
        cardName,
        details: { g1, g2, g3 }
      })
    );
    return null;
  }

  return {
    cid,
    rid: 0,
    type: cardName,
    nodes: [g1, g2, g3],
    source: record.source
  };
}

function hydrateCord1R(record, strictMode, errors, warnings) {
  return hydrateCord1ByNodes(record, 'CORD1R', strictMode, errors, warnings);
}

function hydrateCord1C(record, strictMode, errors, warnings) {
  return hydrateCord1ByNodes(record, 'CORD1C', strictMode, errors, warnings);
}

function resolveCordGlobal(cid, coords, cache, nodes, nodeCache, coordStack, nodeStack) {
  if (cache.has(cid)) return cache.get(cid);
  if (coordStack.includes(cid)) return null;
  const coord = coords.get(cid);
  if (!coord) return null;
  coordStack.push(cid);

  // Node-defined coordinates (CORD1x): axes are resolved from G1/G2/G3.
  if (Array.isArray(coord.nodes) && coord.nodes.length >= 3) {
    const p1 = resolveNodeGlobal(coord.nodes[0], nodes, coords, nodeCache, cache, nodeStack, coordStack);
    const p2 = resolveNodeGlobal(coord.nodes[1], nodes, coords, nodeCache, cache, nodeStack, coordStack);
    const p3 = resolveNodeGlobal(coord.nodes[2], nodes, coords, nodeCache, cache, nodeStack, coordStack);
    if (!p1 || !p2 || !p3) {
      coordStack.pop();
      return null;
    }
    const axes = computeCord2RAxes(p1, p2, p3);
    if (!axes) {
      coordStack.pop();
      return null;
    }
    const resolved = { origin: p1, axes };
    cache.set(cid, resolved);
    coordStack.pop();
    return resolved;
  }

  // Base case: RID=0 is global for CORD2x.
  const hasOrigin = Array.isArray(coord.origin) && coord.origin.length >= 3;
  let pointA = hasOrigin ? [Number(coord.origin[0]), Number(coord.origin[1]), Number(coord.origin[2])] : null;
  let pointB = Array.isArray(coord.pointB) && coord.pointB.length >= 3
    ? [Number(coord.pointB[0]), Number(coord.pointB[1]), Number(coord.pointB[2])]
    : null;
  let pointC = Array.isArray(coord.pointC) && coord.pointC.length >= 3
    ? [Number(coord.pointC[0]), Number(coord.pointC[1]), Number(coord.pointC[2])]
    : null;

  if ((!pointB || !pointC) && hasOrigin && Array.isArray(coord.axes) && coord.axes.length === 3) {
    const xAxis = Array.isArray(coord.axes[0]) ? coord.axes[0] : null;
    const zAxis = Array.isArray(coord.axes[2]) ? coord.axes[2] : null;
    if (xAxis && zAxis && xAxis.length >= 3 && zAxis.length >= 3) {
      pointB = [pointA[0] + Number(zAxis[0]), pointA[1] + Number(zAxis[1]), pointA[2] + Number(zAxis[2])];
      pointC = [pointA[0] + Number(xAxis[0]), pointA[1] + Number(xAxis[1]), pointA[2] + Number(xAxis[2])];
    }
  }

  if (!pointA || !pointB || !pointC || ![...pointA, ...pointB, ...pointC].every((v) => Number.isFinite(v))) {
    coordStack.pop();
    return null;
  }

  let pointAGlobal = pointA;
  let pointBGlobal = pointB;
  let pointCGlobal = pointC;

  if (coord.rid) {
    const parent = resolveCordGlobal(coord.rid, coords, cache, nodes, nodeCache, coordStack, nodeStack);
    if (!parent) {
      coordStack.pop();
      return null;
    }
    const parentDef = coords.get(coord.rid);
    const parentType = parentDef && parentDef.type ? parentDef.type : 'CORD2R';

    const pointARect = coordLocalToRect(parentType, pointA);
    const pointBRect = coordLocalToRect(parentType, pointB);
    const pointCRect = coordLocalToRect(parentType, pointC);
    if (!pointARect || !pointBRect || !pointCRect) {
      coordStack.pop();
      return null;
    }

    pointAGlobal = vAdd(parent.origin, applyBasis(parent.axes, pointARect));
    pointBGlobal = vAdd(parent.origin, applyBasis(parent.axes, pointBRect));
    pointCGlobal = vAdd(parent.origin, applyBasis(parent.axes, pointCRect));
  }

  const axes = computeCord2RAxes(pointAGlobal, pointBGlobal, pointCGlobal);
  if (!axes) {
    coordStack.pop();
    return null;
  }

  const resolved = { origin: pointAGlobal, axes, pointB: pointBGlobal, pointC: pointCGlobal };
  cache.set(cid, resolved);
  coordStack.pop();
  return resolved;
}

function resolveNodeGlobal(nid, nodes, coords, nodeCache, coordsGlobalCache, nodeStack, coordStack) {
  if (nodeCache.has(nid)) return nodeCache.get(nid);
  if (nodeStack.includes(nid)) return null;
  const node = nodes.get(nid);
  if (!node) return null;

  const local = Array.isArray(node.xLocal) && node.xLocal.length >= 3
    ? node.xLocal
    : (Array.isArray(node.x) && node.x.length >= 3 ? node.x : null);
  if (!local || !local.every((v) => Number.isFinite(Number(v)))) return null;

  nodeStack.push(nid);
  const cp = Number.isFinite(node.cp) ? node.cp : 0;
  let out = null;

  if (cp === 0) {
    out = [Number(local[0]), Number(local[1]), Number(local[2])];
  } else {
    const global = resolveCordGlobal(cp, coords, coordsGlobalCache, nodes, nodeCache, coordStack, nodeStack);
    if (global) {
      const coordDef = coords.get(cp);
      const rectLocal = coordLocalToRect(coordDef && coordDef.type, local);
      if (rectLocal) {
        out = vAdd(global.origin, applyBasis(global.axes, rectLocal));
      }
    }
  }

  nodeStack.pop();
  if (!out) return null;
  nodeCache.set(nid, out);
  return out;
}

function hydrateGrid(record, strictMode, errors, warnings) {
  // tokens: [ 'GRID', nid, cp, x1, x2, x3, cd, ps, seid, ...]
  const t = getHydrationTokens(record);
  const emitGridIssue = (message, details) => {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', message, { source: record.source, cardName: 'GRID', details })
    );
    return strictMode;
  };

  const nid = parseNastranInt(t[1]);
  if (!Number.isFinite(nid) || nid < 1) {
    emitGridIssue('GRID: invalid NID (expected integer > 0)', { nid: t[1] });
    return null;
  }
  const cpTok = t[2];
  let cp = parseNastranInt(cpTok);
  if (!isBlankToken(cpTok) && !Number.isFinite(cp)) {
    if (emitGridIssue('GRID: invalid CP (expected integer >= 0 or blank)', { cp: cpTok })) return null;
    cp = null;
  }
  if (Number.isFinite(cp) && cp < 0) {
    if (emitGridIssue('GRID: invalid CP (expected integer >= 0 or blank)', { cp })) return null;
    cp = null;
  }

  const x1 = parseNastranFloat(t[3]);
  const x2 = parseNastranFloat(t[4]);
  const x3 = parseNastranFloat(t[5]);
  if (![x1, x2, x3].every((v) => Number.isFinite(v))) {
    emitGridIssue('GRID: invalid or blank XYZ', { x: [t[3], t[4], t[5]] });
    return null;
  }
  const cdTok = t[6];
  let cd = parseNastranInt(cdTok);
  if (!isBlankToken(cdTok) && !Number.isFinite(cd)) {
    if (emitGridIssue('GRID: invalid CD (expected integer >= -1 or blank)', { cd: cdTok })) return null;
    cd = null;
  }
  if (Number.isFinite(cd) && cd < -1) {
    if (emitGridIssue('GRID: invalid CD (expected integer >= -1 or blank)', { cd })) return null;
    cd = null;
  }
  let ps = isBlankToken(t[7]) ? null : String(t[7]).trim();
  if (ps != null && ps.length === 0) ps = null;
  if (ps != null) {
    const isValidPs = (s) => {
      if (!/^[1-6]+$/.test(s)) return false;
      const seen = new Set();
      for (const ch of s) {
        if (seen.has(ch)) return false;
        seen.add(ch);
      }
      return true;
    };
    if (!isValidPs(ps)) {
      emitGridIssue('GRID: invalid PS (expected unique digits 1-6)', { ps });
      if (strictMode) return null;
      // Non-strict: keep the node for geometry/indexing but drop invalid PS.
      ps = null;
    }
  }
  const seidTok = t[8];
  let seid = parseNastranInt(seidTok);
  if (!isBlankToken(seidTok) && !Number.isFinite(seid)) {
    if (emitGridIssue('GRID: invalid SEID (expected integer >= 0 or blank)', { seid: seidTok })) return null;
    seid = null;
  }
  if (Number.isFinite(seid) && seid < 0) {
    if (emitGridIssue('GRID: invalid SEID (expected integer >= 0 or blank)', { seid })) return null;
    seid = null;
  }
  const posLocal = [x1, x2, x3];

  return {
    nid,
    cp: Number.isFinite(cp) ? cp : null,
    x: posLocal,
    xLocal: posLocal,
    cd: Number.isFinite(cd) ? cd : null,
    ps,
    seid: Number.isFinite(seid) ? seid : null,
    source: record.source
  };
}

function hydrateCtria3(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const eid = parseNastranInt(t[1]);
  const pidTokBlank = isBlankToken(t[2]);
  const pidParsed = parseNastranInt(t[2]);
  const pid = pidTokBlank ? eid : pidParsed;
  const g1 = parseNastranInt(t[3]);
  const g2 = parseNastranInt(t[4]);
  const g3 = parseNastranInt(t[5]);
  if (![eid, pid, g1, g2, g3].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CTRIA3: invalid required fields', {
        source: record.source,
        cardName: 'CTRIA3',
        details: { eid: t[1], pid: t[2], g: [t[3], t[4], t[5]] }
      })
    );
    return null;
  }

  // Field 6 is THETA or MCID (float angle or integer coordinate id).
  let theta_mcid = null;
  if (!isBlankToken(t[6])) {
    const raw = String(t[6]).trim();
    if (/^[+-]?\d+$/.test(raw)) theta_mcid = parseNastranInt(raw);
    else theta_mcid = parseNastranFloat(raw);
    if (typeof theta_mcid === 'number' && !Number.isFinite(theta_mcid)) theta_mcid = null;
  }
  const zoffsetRaw = parseNastranFloat(t[7]);
  const zoffset = Number.isFinite(zoffsetRaw) ? zoffsetRaw : null;

  // QRG slot layout (small-field) places TFLAG/T1/T2/T3 at 10..13 with two
  // reserved blanks in 8..9.
  const tflagRaw = parseNastranInt(t[10]);
  const tflag = Number.isFinite(tflagRaw) ? tflagRaw : null;
  const t1raw = parseNastranFloat(t[11]);
  const t2raw = parseNastranFloat(t[12]);
  const t3raw = parseNastranFloat(t[13]);
  const t1 = Number.isFinite(t1raw) ? t1raw : null;
  const t2 = Number.isFinite(t2raw) ? t2raw : null;
  const t3 = Number.isFinite(t3raw) ? t3raw : null;

  return {
    type: 'CTRIA3',
    eid,
    pid,
    nids: [g1, g2, g3],
    theta_mcid,
    zoffset,
    tflag,
    t: [t1, t2, t3],
    tokens: t.slice(),
    source: record.source
  };
}

function hydrateCtria6(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const eid = parseNastranInt(t[1]);
  const pidTokBlank = isBlankToken(t[2]);
  const pidParsed = parseNastranInt(t[2]);
  const pid = pidTokBlank ? eid : pidParsed;
  const g1 = parseNastranInt(t[3]);
  const g2 = parseNastranInt(t[4]);
  const g3 = parseNastranInt(t[5]);
  const g4 = parseNastranInt(t[6]);
  const g5 = parseNastranInt(t[7]);
  const g6 = parseNastranInt(t[8]);

  if (![eid, pid, g1, g2, g3, g4, g5, g6].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CTRIA6: invalid required fields', {
        source: record.source,
        cardName: 'CTRIA6',
        details: { eid: t[1], pid: t[2], g: [t[3], t[4], t[5], t[6], t[7], t[8]] }
      })
    );
    return null;
  }

  // We intentionally ignore optional continuation fields here; editor just needs connectivity.
  return {
    type: 'CTRIA6',
    eid,
    pid,
    nids: [g1, g2, g3, g4, g5, g6],
    source: record.source
  };
}

function hydrateCquad4(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const eid = parseNastranInt(t[1]);
  const pidTokBlank = isBlankToken(t[2]);
  const pidParsed = parseNastranInt(t[2]);
  const pid = pidTokBlank ? eid : pidParsed;
  const g1 = parseNastranInt(t[3]);
  const g2 = parseNastranInt(t[4]);
  const g3 = parseNastranInt(t[5]);
  const g4 = parseNastranInt(t[6]);
  if (![eid, pid, g1, g2, g3, g4].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CQUAD4: invalid required fields', {
        source: record.source,
        cardName: 'CQUAD4',
        details: { eid: t[1], pid: t[2], g: [t[3], t[4], t[5], t[6]] }
      })
    );
    return null;
  }
  // Field 6 is THETA or MCID (float angle or integer coordinate id).
  let theta_mcid = null;
  if (!isBlankToken(t[7])) {
    const raw = String(t[7]).trim();
    if (/^[+-]?\d+$/.test(raw)) theta_mcid = parseNastranInt(raw);
    else theta_mcid = parseNastranFloat(raw);
    if (typeof theta_mcid === 'number' && !Number.isFinite(theta_mcid)) theta_mcid = null;
  }
  const zoffsetRaw = parseNastranFloat(t[8]);
  const zoffset = Number.isFinite(zoffsetRaw) ? zoffsetRaw : null;
  const tflagRaw = parseNastranInt(t[10]);
  const tflag = Number.isFinite(tflagRaw) ? tflagRaw : null;
  const t1raw = parseNastranFloat(t[11]);
  const t2raw = parseNastranFloat(t[12]);
  const t3raw = parseNastranFloat(t[13]);
  const t4raw = parseNastranFloat(t[14]);
  const t1 = Number.isFinite(t1raw) ? t1raw : null;
  const t2 = Number.isFinite(t2raw) ? t2raw : null;
  const t3 = Number.isFinite(t3raw) ? t3raw : null;
  const t4 = Number.isFinite(t4raw) ? t4raw : null;
  return {
    type: 'CQUAD4',
    eid,
    pid,
    nids: [g1, g2, g3, g4],
    theta_mcid,
    zoffset,
    tflag,
    t: [t1, t2, t3, t4],
    tokens: t.slice(),
    source: record.source
  };
}

function hydrateCquad8(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const eid = parseNastranInt(t[1]);
  const pidTokBlank = isBlankToken(t[2]);
  const pidParsed = parseNastranInt(t[2]);
  const pid = pidTokBlank ? eid : pidParsed;
  const g1 = parseNastranInt(t[3]);
  const g2 = parseNastranInt(t[4]);
  const g3 = parseNastranInt(t[5]);
  const g4 = parseNastranInt(t[6]);
  const g5 = parseNastranInt(t[7]);
  const g6 = parseNastranInt(t[8]);
  const g7 = parseNastranInt(t[9]);
  const g8 = parseNastranInt(t[10]);

  if (![eid, pid, g1, g2, g3, g4, g5, g6, g7, g8].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CQUAD8: invalid required fields', {
        source: record.source,
        cardName: 'CQUAD8',
        details: { eid: t[1], pid: t[2], g: [t[3], t[4], t[5], t[6], t[7], t[8], t[9], t[10]] }
      })
    );
    return null;
  }

  // We intentionally ignore optional continuation fields here; editor just needs connectivity.
  return {
    type: 'CQUAD8',
    eid,
    pid,
    nids: [g1, g2, g3, g4, g5, g6, g7, g8],
    source: record.source
  };
}

function hydrateCrod(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const eid = parseNastranInt(t[1]);
  const pidTokBlank = isBlankToken(t[2]);
  const pidParsed = parseNastranInt(t[2]);
  const pid = pidTokBlank ? eid : pidParsed;
  const n1 = parseNastranInt(t[3]);
  const n2 = parseNastranInt(t[4]);

  if (![eid, pid, n1, n2].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CROD: invalid required fields', {
        source: record.source,
        cardName: 'CROD',
        details: { eid: t[1], pid: t[2], n: [t[3], t[4]] }
      })
    );
    return null;
  }

  if (n1 === n2) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CROD: nodes N1 and N2 must be different', {
        source: record.source,
        cardName: 'CROD',
        details: { eid, n: [n1, n2] }
      })
    );
    return null;
  }

  return {
    type: 'CROD',
    eid,
    pid,
    nids: [n1, n2],
    source: record.source
  };
}

function hydrateCbar(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const eid = parseNastranInt(t[1]);
  const pidTokBlank = isBlankToken(t[2]);
  const pidParsed = parseNastranInt(t[2]);
  const pid = pidTokBlank ? eid : pidParsed;
  const ga = parseNastranInt(t[3]);
  const gb = parseNastranInt(t[4]);

  if (![eid, pid, ga, gb].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CBAR: invalid required fields', {
        source: record.source,
        cardName: 'CBAR',
        details: { eid: t[1], pid: t[2], g: [t[3], t[4]] }
      })
    );
    return null;
  }

  if (ga === gb) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CBAR: GA and GB must be different', {
        source: record.source,
        cardName: 'CBAR',
        details: { eid, g: [ga, gb] }
      })
    );
    return null;
  }

  const x1g0Tok = t[5];
  const x2Tok = t[6];
  const x3Tok = t[7];

  const hasAnyOrient = !isBlankToken(x1g0Tok) || !isBlankToken(x2Tok) || !isBlankToken(x3Tok);
  if (!hasAnyOrient) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CBAR: missing orientation (expected X1/X2/X3 or G0)', {
        source: record.source,
        cardName: 'CBAR',
        details: { eid, x1g0: t[5], x2: t[6], x3: t[7] }
      })
    );
    return null;
  }

  let orient = null;
  if (!isBlankToken(x1g0Tok) && isBlankToken(x2Tok) && isBlankToken(x3Tok)) {
    const g0 = parseNastranInt(x1g0Tok);
    if (Number.isFinite(g0) && g0 !== ga && g0 !== gb) {
      orient = { kind: 'g0', g0 };
    }
  }

  if (!orient) {
    const x1 = parseNastranFloat(x1g0Tok);
    const x2 = parseNastranFloat(x2Tok);
    const x3 = parseNastranFloat(x3Tok);
    if (![x1, x2, x3].every((v) => Number.isFinite(v))) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'CBAR: invalid orientation vector X1/X2/X3', {
          source: record.source,
          cardName: 'CBAR',
          details: { eid, x: [t[5], t[6], t[7]] }
        })
      );
      return null;
    }

    if (Math.abs(x1) < 1e-30 && Math.abs(x2) < 1e-30 && Math.abs(x3) < 1e-30) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'CBAR: orientation vector must be non-zero', {
          source: record.source,
          cardName: 'CBAR',
          details: { eid, x: [x1, x2, x3] }
        })
      );
      return null;
    }

    orient = { kind: 'x', x: [x1, x2, x3] };
  }

  let offt = isBlankToken(t[8]) ? 'GGG' : toUpper(parseNastranString(t[8]) || '');
  if (!offt) offt = 'GGG';
  if (!ALLOWED_BAR_BEAM_OFFT.has(offt)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CBAR: invalid OFFT', {
        source: record.source,
        cardName: 'CBAR',
        details: { eid, offt: t[8] }
      })
    );
    return null;
  }

  const parseOptInt = (raw, key, dflt) => {
    if (isBlankToken(raw)) return dflt;
    const v = parseNastranInt(raw);
    if (!Number.isFinite(v)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', `CBAR: invalid ${key}`, {
          source: record.source,
          cardName: 'CBAR',
          details: { [key]: raw }
        })
      );
      return NaN;
    }
    return v;
  };

  const parseOptFloat = (raw, key, dflt) => {
    if (isBlankToken(raw)) return dflt;
    const v = parseNastranFloat(raw);
    if (!Number.isFinite(v)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', `CBAR: invalid ${key}`, {
          source: record.source,
          cardName: 'CBAR',
          details: { [key]: raw }
        })
      );
      return NaN;
    }
    return v;
  };

  const pa = parseOptInt(t[9], 'PA', 0);
  const pb = parseOptInt(t[10], 'PB', 0);
  const w1a = parseOptFloat(t[11], 'W1A', 0.0);
  const w2a = parseOptFloat(t[12], 'W2A', 0.0);
  const w3a = parseOptFloat(t[13], 'W3A', 0.0);
  const w1b = parseOptFloat(t[14], 'W1B', 0.0);
  const w2b = parseOptFloat(t[15], 'W2B', 0.0);
  const w3b = parseOptFloat(t[16], 'W3B', 0.0);
  const parsedOpts = [pa, pb, w1a, w2a, w3a, w1b, w2b, w3b];
  if (parsedOpts.some((v) => Number.isNaN(v))) return null;

  return {
    type: 'CBAR',
    eid,
    pid,
    nids: [ga, gb],
    orient,
    offt,
    pa,
    pb,
    wa: [w1a, w2a, w3a],
    wb: [w1b, w2b, w3b],
    tokens: t.slice(),
    source: record.source
  }
}

function hydrateCbeam(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const eid = parseNastranInt(t[1]);
  const pidTokBlank = isBlankToken(t[2]);
  const pidParsed = parseNastranInt(t[2]);
  const pid = pidTokBlank ? eid : pidParsed;
  const ga = parseNastranInt(t[3]);
  const gb = parseNastranInt(t[4]);

  if (![eid, pid, ga, gb].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CBEAM: invalid required fields', {
        source: record.source,
        cardName: 'CBEAM',
        details: { eid: t[1], pid: t[2], g: [t[3], t[4]] }
      })
    );
    return null;
  }

  if (ga === gb) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CBEAM: GA and GB must be different', {
        source: record.source,
        cardName: 'CBEAM',
        details: { eid, g: [ga, gb] }
      })
    );
    return null;
  }

  // Orientation is optional in NX when BEAMOR defaults apply. If present,
  // parse either G0 (X1/G0 slot only) or vector X1/X2/X3.
  const x1g0Tok = t[5];
  const x2Tok = t[6];
  const x3Tok = t[7];
  const hasAnyOrient = !isBlankToken(x1g0Tok) || !isBlankToken(x2Tok) || !isBlankToken(x3Tok);
  let orient = null;

  if (hasAnyOrient) {
    if (!isBlankToken(x1g0Tok) && isBlankToken(x2Tok) && isBlankToken(x3Tok)) {
      const g0 = parseNastranInt(x1g0Tok);
      if (!Number.isFinite(g0)) {
        pushParseIssue(
          strictMode,
          errors,
          warnings,
          makeIssue('CARD_PARSE', 'CBEAM: invalid G0 orientation token', {
            source: record.source,
            cardName: 'CBEAM',
            details: { eid, g0: x1g0Tok }
          })
        );
        return null;
      }
      if (g0 === ga || g0 === gb) {
        pushParseIssue(
          strictMode,
          errors,
          warnings,
          makeIssue('CARD_PARSE', 'CBEAM: G0 cannot equal GA or GB', {
            source: record.source,
            cardName: 'CBEAM',
            details: { eid, g0, ga, gb }
          })
        );
        return null;
      }
      orient = { kind: 'g0', g0 };
    }

    if (!orient) {
      const x1 = parseNastranFloat(x1g0Tok);
      const x2 = parseNastranFloat(x2Tok);
      const x3 = parseNastranFloat(x3Tok);
      if (![x1, x2, x3].every((v) => Number.isFinite(v))) {
        pushParseIssue(
          strictMode,
          errors,
          warnings,
          makeIssue('CARD_PARSE', 'CBEAM: invalid orientation vector X1/X2/X3', {
            source: record.source,
            cardName: 'CBEAM',
            details: { eid, x: [x1g0Tok, x2Tok, x3Tok] }
          })
        );
        return null;
      }
      if (Math.abs(x1) < 1e-30 && Math.abs(x2) < 1e-30 && Math.abs(x3) < 1e-30) {
        pushParseIssue(
          strictMode,
          errors,
          warnings,
          makeIssue('CARD_PARSE', 'CBEAM: orientation vector must be non-zero', {
            source: record.source,
            cardName: 'CBEAM',
            details: { eid, x: [x1, x2, x3] }
          })
        );
        return null;
      }
      orient = { kind: 'x', x: [x1, x2, x3] };
    }
  }

  let offt = isBlankToken(t[8]) ? 'GGG' : toUpper(parseNastranString(t[8]) || '');
  if (!offt) offt = 'GGG';
  if (!ALLOWED_BAR_BEAM_OFFT.has(offt)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CBEAM: invalid OFFT', {
        source: record.source,
        cardName: 'CBEAM',
        details: { eid, offt: t[8] }
      })
    );
    return null;
  }

  const parseOptInt = (raw, key, dflt) => {
    if (isBlankToken(raw)) return dflt;
    const v = parseNastranInt(raw);
    if (!Number.isFinite(v)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', `CBEAM: invalid ${key}`, {
          source: record.source,
          cardName: 'CBEAM',
          details: { [key]: raw }
        })
      );
      return NaN;
    }
    return v;
  };

  const parseOptFloat = (raw, key, dflt) => {
    if (isBlankToken(raw)) return dflt;
    const v = parseNastranFloat(raw);
    if (!Number.isFinite(v)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', `CBEAM: invalid ${key}`, {
          source: record.source,
          cardName: 'CBEAM',
          details: { [key]: raw }
        })
      );
      return NaN;
    }
    return v;
  };

  const pa = parseOptInt(t[9], 'PA', 0);
  const pb = parseOptInt(t[10], 'PB', 0);
  const w1a = parseOptFloat(t[11], 'W1A', 0.0);
  const w2a = parseOptFloat(t[12], 'W2A', 0.0);
  const w3a = parseOptFloat(t[13], 'W3A', 0.0);
  const w1b = parseOptFloat(t[14], 'W1B', 0.0);
  const w2b = parseOptFloat(t[15], 'W2B', 0.0);
  const w3b = parseOptFloat(t[16], 'W3B', 0.0);
  const sa = parseOptInt(t[17], 'SA', 0);
  const sb = parseOptInt(t[18], 'SB', 0);
  const parsedOpts = [pa, pb, w1a, w2a, w3a, w1b, w2b, w3b, sa, sb];
  if (parsedOpts.some((v) => Number.isNaN(v))) return null;

  return {
    type: 'CBEAM',
    eid,
    pid,
    nids: [ga, gb],
    orient,
    offt,
    pa,
    pb,
    wa: [w1a, w2a, w3a],
    wb: [w1b, w2b, w3b],
    sa,
    sb,
    tokens: t.slice(),
    source: record.source
  };
}

function hydrateCbush(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const eid = parseNastranInt(t[1]);
  const pidTokBlank = isBlankToken(t[2]);
  const pidParsed = parseNastranInt(t[2]);
  const pid = pidTokBlank ? eid : pidParsed;
  const ga = parseNastranInt(t[3]);
  const gb = parseNastranInt(t[4]);

  if (![eid, pid, ga, gb].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CBUSH: invalid required fields', {
        source: record.source,
        cardName: 'CBUSH',
        details: { eid: t[1], pid: t[2], g: [t[3], t[4]] }
      })
    );
    return null;
  }

  let orient = null;
  const x1g0Tok = t[5];
  const x2Tok = t[6];
  const x3Tok = t[7];
  const hasAnyOrient = !isBlankToken(x1g0Tok) || !isBlankToken(x2Tok) || !isBlankToken(x3Tok);
  if (hasAnyOrient) {
    if (!isBlankToken(x1g0Tok) && isBlankToken(x2Tok) && isBlankToken(x3Tok)) {
      const g0 = parseNastranInt(x1g0Tok);
      if (Number.isFinite(g0) && g0 !== ga && g0 !== gb) orient = { kind: 'g0', g0 };
    }
    if (!orient) {
      const x1 = parseNastranFloat(x1g0Tok);
      const x2 = parseNastranFloat(x2Tok);
      const x3 = parseNastranFloat(x3Tok);
      if ([x1, x2, x3].every((v) => Number.isFinite(v))) {
        orient = { kind: 'x', x: [x1, x2, x3] };
      } else {
        pushParseIssue(
          strictMode,
          errors,
          warnings,
          makeIssue('CARD_PARSE', 'CBUSH: invalid orientation (expected GO or X1/X2/X3)', {
            source: record.source,
            cardName: 'CBUSH',
            details: { eid, x1g0: x1g0Tok, x2: x2Tok, x3: x3Tok }
          })
        );
        return null;
      }
    }
  }

  const parseOptInt = (raw, key, dflt) => {
    if (isBlankToken(raw)) return dflt;
    const v = parseNastranInt(raw);
    if (!Number.isFinite(v)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', `CBUSH: invalid ${key}`, {
          source: record.source,
          cardName: 'CBUSH',
          details: { [key]: raw }
        })
      );
      return NaN;
    }
    return v;
  };

  const parseOptFloat = (raw, key, dflt) => {
    if (isBlankToken(raw)) return dflt;
    const v = parseNastranFloat(raw);
    if (!Number.isFinite(v)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', `CBUSH: invalid ${key}`, {
          source: record.source,
          cardName: 'CBUSH',
          details: { [key]: raw }
        })
      );
      return NaN;
    }
    return v;
  };

  const cid = parseOptInt(t[8], 'CID', null);
  const s = parseOptFloat(t[9], 'S', 0.5);
  const ocid = parseOptInt(t[10], 'OCID', -1);
  const s1 = parseOptFloat(t[11], 'S1', null);
  const s2 = parseOptFloat(t[12], 'S2', null);
  const s3 = parseOptFloat(t[13], 'S3', null);
  const parsedOpts = [cid, s, ocid, s1, s2, s3];
  if (parsedOpts.some((v) => Number.isNaN(v))) return null;

  return {
    type: 'CBUSH',
    eid,
    pid,
    nids: [ga, gb],
    orient,
    cid,
    s,
    ocid,
    si: [s1, s2, s3],
    tokens: t.slice(),
    source: record.source
  };
}

function hydrateCtetrA(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const eid = parseNastranInt(t[1]);
  const pidTokBlank = isBlankToken(t[2]);
  const pidParsed = parseNastranInt(t[2]);
  const pid = pidTokBlank ? eid : pidParsed;
  const n1 = parseNastranInt(t[3]);
  const n2 = parseNastranInt(t[4]);
  const n3 = parseNastranInt(t[5]);
  const n4 = parseNastranInt(t[6]);
  if (![eid, pid, n1, n2, n3, n4].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CTETRA: invalid required fields', {
        source: record.source,
        cardName: 'CTETRA',
        details: { eid: t[1], pid: t[2], n: [t[3], t[4], t[5], t[6]] }
      })
    );
    return null;
  }

  const corner = [n1, n2, n3, n4];
  if (new Set(corner).size !== 4) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CTETRA: corner nodes N1-N4 must be unique', {
        source: record.source,
        cardName: 'CTETRA',
        details: { eid, n: corner }
      })
    );
    return null;
  }

  // Spec: Either 4-node (N1-N4 only) OR 10-node (N1-N10). If any of N5-N10
  // is present, all must be present.
  const optRaw = [t[7], t[8], t[9], t[10], t[11], t[12]];
  const optNonBlank = optRaw.filter((x) => !isBlankToken(x));
  if (optNonBlank.length !== 0 && optNonBlank.length !== 6) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CTETRA: nodes must be 4 or 10 (N5-N10 all-or-none)', {
        source: record.source,
        cardName: 'CTETRA',
        details: { eid, providedOptional: optNonBlank.map((x) => String(x).trim()) }
      })
    );
    return null;
  }

  let nids = corner;
  if (optNonBlank.length === 6) {
    const opt = optRaw.map((x) => parseNastranInt(x));
    if (!opt.every((v) => Number.isFinite(v))) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'CTETRA: invalid optional nodes N5-N10', {
          source: record.source,
          cardName: 'CTETRA',
          details: { eid, n: optRaw }
        })
      );
      return null;
    }
    nids = [...corner, ...opt];
  }

  return {
    type: 'CTETRA',
    eid,
    pid,
    nids,
    source: record.source
  };
}

function hydrateChexa(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const eid = parseNastranInt(t[1]);
  const pidTokBlank = isBlankToken(t[2]);
  const pidParsed = parseNastranInt(t[2]);
  const pid = pidTokBlank ? eid : pidParsed;

  const cornerRaw = [t[3], t[4], t[5], t[6], t[7], t[8], t[9], t[10]];
  const corner = cornerRaw.map((x) => parseNastranInt(x));
  if (![eid, pid, ...corner].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CHEXA: invalid required fields', {
        source: record.source,
        cardName: 'CHEXA',
        details: { eid: t[1], pid: t[2], g: cornerRaw }
      })
    );
    return null;
  }

  if (new Set(corner).size !== 8) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CHEXA: corner nodes G1-G8 must be unique', {
        source: record.source,
        cardName: 'CHEXA',
        details: { eid, g: corner }
      })
    );
    return null;
  }

  // Spec: Either 8-node (G1-G8 only) OR 20-node (G1-G20). If any of G9-G20
  // is present, all must be present.
  const optRaw = [t[11], t[12], t[13], t[14], t[15], t[16], t[17], t[18], t[19], t[20], t[21], t[22]];
  const optNonBlank = optRaw.filter((x) => !isBlankToken(x));
  if (optNonBlank.length !== 0 && optNonBlank.length !== 12) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CHEXA: nodes must be 8 or 20 (G9-G20 all-or-none)', {
        source: record.source,
        cardName: 'CHEXA',
        details: { eid, providedOptional: optNonBlank.map((x) => String(x).trim()) }
      })
    );
    return null;
  }

  let nids = corner;
  if (optNonBlank.length === 12) {
    const opt = optRaw.map((x) => parseNastranInt(x));
    if (!opt.every((v) => Number.isFinite(v))) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'CHEXA: invalid optional nodes G9-G20', {
          source: record.source,
          cardName: 'CHEXA',
          details: { eid, g: optRaw }
        })
      );
      return null;
    }
    nids = [...corner, ...opt];
  }

  return {
    type: 'CHEXA',
    eid,
    pid,
    nids,
    source: record.source
  };
}

function hydrateCpenta(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const eid = parseNastranInt(t[1]);
  const pidTokBlank = isBlankToken(t[2]);
  const pidParsed = parseNastranInt(t[2]);
  const pid = pidTokBlank ? eid : pidParsed;

  const cornerRaw = [t[3], t[4], t[5], t[6], t[7], t[8]];
  const corner = cornerRaw.map((x) => parseNastranInt(x));
  if (![eid, pid, ...corner].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CPENTA: invalid required fields', {
        source: record.source,
        cardName: 'CPENTA',
        details: { eid: t[1], pid: t[2], g: cornerRaw }
      })
    );
    return null;
  }

  if (new Set(corner).size !== 6) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CPENTA: corner nodes G1-G6 must be unique', {
        source: record.source,
        cardName: 'CPENTA',
        details: { eid, g: corner }
      })
    );
    return null;
  }

  // Spec: Either 6-node (G1-G6 only) OR 15-node (G1-G15). If any of G7-G15
  // is present, all must be present.
  const optRaw = [t[9], t[10], t[11], t[12], t[13], t[14], t[15], t[16], t[17]];
  const optNonBlank = optRaw.filter((x) => !isBlankToken(x));
  if (optNonBlank.length !== 0 && optNonBlank.length !== 9) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CPENTA: nodes must be 6 or 15 (G7-G15 all-or-none)', {
        source: record.source,
        cardName: 'CPENTA',
        details: { eid, providedOptional: optNonBlank.map((x) => String(x).trim()) }
      })
    );
    return null;
  }

  let nids = corner;
  if (optNonBlank.length === 9) {
    const opt = optRaw.map((x) => parseNastranInt(x));
    if (!opt.every((v) => Number.isFinite(v))) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'CPENTA: invalid optional nodes G7-G15', {
          source: record.source,
          cardName: 'CPENTA',
          details: { eid, g: optRaw }
        })
      );
      return null;
    }
    nids = [...corner, ...opt];
  }

  return {
    type: 'CPENTA',
    eid,
    pid,
    nids,
    source: record.source
  };
}

function hydrateCpyram(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const eid = parseNastranInt(t[1]);
  const pidTokBlank = isBlankToken(t[2]);
  const pidParsed = parseNastranInt(t[2]);
  const pid = pidTokBlank ? eid : pidParsed;

  const cornerRaw = [t[3], t[4], t[5], t[6], t[7]];
  const corner = cornerRaw.map((x) => parseNastranInt(x));
  if (![eid, pid, ...corner].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CPYRAM: invalid required fields', {
        source: record.source,
        cardName: 'CPYRAM',
        details: { eid: t[1], pid: t[2], g: cornerRaw }
      })
    );
    return null;
  }

  if (new Set(corner).size !== 5) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CPYRAM: corner nodes G1-G5 must be unique', {
        source: record.source,
        cardName: 'CPYRAM',
        details: { eid, g: corner }
      })
    );
    return null;
  }

  // Spec: Either 5-node (G1-G5 only) OR 13-node (G1-G13). If any of G6-G13
  // is present, all must be present.
  const optRaw = [t[8], t[9], t[10], t[11], t[12], t[13], t[14], t[15]];
  const optNonBlank = optRaw.filter((x) => !isBlankToken(x));
  if (optNonBlank.length !== 0 && optNonBlank.length !== 8) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CPYRAM: nodes must be 5 or 13 (G6-G13 all-or-none)', {
        source: record.source,
        cardName: 'CPYRAM',
        details: { eid, providedOptional: optNonBlank.map((x) => String(x).trim()) }
      })
    );
    return null;
  }

  let nids = corner;
  if (optNonBlank.length === 8) {
    const opt = optRaw.map((x) => parseNastranInt(x));
    if (!opt.every((v) => Number.isFinite(v))) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'CPYRAM: invalid optional nodes G6-G13', {
          source: record.source,
          cardName: 'CPYRAM',
          details: { eid, g: optRaw }
        })
      );
      return null;
    }
    nids = [...corner, ...opt];
  }

  return {
    type: 'CPYRAM',
    eid,
    pid,
    nids,
    source: record.source
  };
}

function hydratePshell(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const pid = parseNastranInt(t[1]);
  const mid1 = parseNastranInt(t[2]);
  const tval = parseNastranFloat(t[3]);
  const mid2 = parseNastranInt(t[4]);
  const i12t3 = parseNastranFloat(t[5]);
  const mid3 = parseNastranInt(t[6]);
  const tst = parseNastranFloat(t[7]);
  const nsm = parseNastranFloat(t[8]);
  const z1 = parseNastranFloat(t[9]);
  const z2 = parseNastranFloat(t[10]);
  const mid4 = parseNastranInt(t[11]);

  if (!Number.isFinite(pid) || !Number.isFinite(mid1) || !Number.isFinite(tval)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PSHELL: invalid required fields', {
        source: record.source,
        cardName: 'PSHELL',
        details: { pid: t[1], mid1: t[2], t: t[3] }
      })
    );
    return null;
  }

  return {
    type: 'PSHELL',
    pid,
    mid1,
    t: tval,
    mid2: Number.isFinite(mid2) ? mid2 : null,
    i12t3: Number.isFinite(i12t3) ? i12t3 : null,
    mid3: Number.isFinite(mid3) ? mid3 : null,
    tst: Number.isFinite(tst) ? tst : null,
    nsm: Number.isFinite(nsm) ? nsm : null,
    z1: Number.isFinite(z1) ? z1 : null,
    z2: Number.isFinite(z2) ? z2 : null,
    mid4: Number.isFinite(mid4) ? mid4 : null,
    source: record.source
  };
}

function hydratePbar(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const pid = parseNastranInt(t[1]);
  const mid = parseNastranInt(t[2]);

  if (!Number.isFinite(pid) || !Number.isFinite(mid)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PBAR: invalid required fields', {
        source: record.source,
        cardName: 'PBAR',
        details: { pid: t[1], mid: t[2] }
      })
    );
    return null;
  }

  const parseOptFloat = (idx, key) => {
    const raw = t[idx];
    const val = parseNastranFloat(raw);
    if (!isBlankToken(raw) && !Number.isFinite(val)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', `PBAR: invalid ${key}`, {
          source: record.source,
          cardName: 'PBAR',
          details: { [key]: raw }
        })
      );
      return NaN;
    }
    return Number.isFinite(val) ? val : null;
  };

  const A = parseOptFloat(3, 'A');
  const I1 = parseOptFloat(4, 'I1');
  const I2 = parseOptFloat(5, 'I2');
  const J = parseOptFloat(6, 'J');
  const nsm = parseOptFloat(7, 'NSM');
  const C1 = parseOptFloat(9, 'C1');
  const C2 = parseOptFloat(10, 'C2');
  const D1 = parseOptFloat(11, 'D1');
  const D2 = parseOptFloat(12, 'D2');
  const E1 = parseOptFloat(13, 'E1');
  const E2 = parseOptFloat(14, 'E2');
  const F1 = parseOptFloat(15, 'F1');
  const F2 = parseOptFloat(16, 'F2');
  const K1 = parseOptFloat(17, 'K1');
  const K2 = parseOptFloat(18, 'K2');
  const I12 = parseOptFloat(19, 'I12');

  const allVals = [A, I1, I2, J, nsm, C1, C2, D1, D2, E1, E2, F1, F2, K1, K2, I12];
  if (allVals.some((v) => Number.isNaN(v))) return null;
  const numOr = (v, dflt) => (Number.isFinite(v) ? v : dflt);

  return {
    type: 'PBAR',
    pid,
    mid,
    A: numOr(A, 0.0),
    I1: numOr(I1, 0.0),
    I2: numOr(I2, 0.0),
    J: numOr(J, 0.0),
    nsm: numOr(nsm, 0.0),
    C1: numOr(C1, 0.0),
    C2: numOr(C2, 0.0),
    D1: numOr(D1, 0.0),
    D2: numOr(D2, 0.0),
    E1: numOr(E1, 0.0),
    E2: numOr(E2, 0.0),
    F1: numOr(F1, 0.0),
    F2: numOr(F2, 0.0),
    K1: numOr(K1, 0.0),
    K2: numOr(K2, 0.0),
    I12: numOr(I12, 0.0),
    source: record.source
  };
}

function hydratePbush(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const pid = parseNastranInt(t[1]);
  if (!Number.isFinite(pid)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PBUSH: invalid required fields', {
        source: record.source,
        cardName: 'PBUSH',
        details: { pid: t[1] }
      })
    );
    return null;
  }

  const normalizeKeyword = (tok) => String(tok ?? '').trim().replace(/[“”"]/g, '').toUpperCase();
  const KEYWORDS = new Set(['K', 'B', 'GE', 'RCV']);
  const out = {
    type: 'PBUSH',
    pid,
    // Defaults follow QRG.
    K1: 0.0, K2: 0.0, K3: 0.0, K4: 0.0, K5: 0.0, K6: 0.0,
    B1: 0.0, B2: 0.0, B3: 0.0, B4: 0.0, B5: 0.0, B6: 0.0,
    GE1: 0.0, GE2: 0.0, GE3: 0.0, GE4: 0.0, GE5: 0.0, GE6: 0.0,
    SA: 1.0, ST: 1.0, EA: 1.0, ET: 1.0,
    source: record.source
  };

  const parseFloatField = (raw, key) => {
    if (isBlankToken(raw)) return null;
    const v = parseNastranFloat(raw);
    if (!Number.isFinite(v)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', `PBUSH: invalid ${key}`, {
          source: record.source,
          cardName: 'PBUSH',
          details: { [key]: raw }
        })
      );
      return NaN;
    }
    return v;
  };

  let i = 2;
  let sawPropertyBlock = false;
  while (i < t.length) {
    if (isBlankToken(t[i])) {
      i += 1;
      continue;
    }
    const key = normalizeKeyword(t[i]);
    if (!KEYWORDS.has(key)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'PBUSH: expected block keyword (K/B/GE/RCV)', {
          source: record.source,
          cardName: 'PBUSH',
          details: { token: t[i], index: i }
        })
      );
      return null;
    }

    sawPropertyBlock = true;
    out[key] = key;
    i += 1;

    if (key === 'K' || key === 'B' || key === 'GE') {
      const prefix = key;
      let comp = 1;
      while (i < t.length && comp <= 6) {
        const nextKey = normalizeKeyword(t[i]);
        if (nextKey && KEYWORDS.has(nextKey)) break;
        const v = parseFloatField(t[i], `${prefix}${comp}`);
        if (Number.isNaN(v)) return null;
        if (Number.isFinite(v)) out[`${prefix}${comp}`] = v;
        i += 1;
        comp += 1;
      }
      continue;
    }

    if (key === 'RCV') {
      const names = ['SA', 'ST', 'EA', 'ET'];
      for (const nm of names) {
        if (i >= t.length) break;
        const nextKey = normalizeKeyword(t[i]);
        if (nextKey && KEYWORDS.has(nextKey)) break;
        const v = parseFloatField(t[i], nm);
        if (Number.isNaN(v)) return null;
        if (Number.isFinite(v)) out[nm] = v;
        i += 1;
      }
    }
  }

  if (!sawPropertyBlock) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PBUSH: expected at least one property block keyword (K/B/GE/RCV)', {
        source: record.source,
        cardName: 'PBUSH',
        details: { pid: t[1] }
      })
    );
    return null;
  }

  return out;
}

function hydratePbeam(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const pid = parseNastranInt(t[1]);
  const mid = parseNastranInt(t[2]);
  const aA = parseNastranFloat(t[3]);
  if (!Number.isFinite(pid) || !Number.isFinite(mid) || !Number.isFinite(aA) || !(aA > 0)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PBEAM: invalid required fields', {
        source: record.source,
        cardName: 'PBEAM',
        details: { pid: t[1], mid: t[2], a_a: t[3] }
      })
    );
    return null;
  }

  const parseOptFloat = (raw, key) => {
    if (isBlankToken(raw)) return null;
    const v = parseNastranFloat(raw);
    if (!Number.isFinite(v)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', `PBEAM: invalid ${key}`, {
          source: record.source,
          cardName: 'PBEAM',
          details: { [key]: raw }
        })
      );
      return NaN;
    }
    return v;
  };

  const numOr = (v, dflt) => (Number.isFinite(v) ? v : dflt);
  const i1A = parseOptFloat(t[4], 'i1_a');
  const i2A = parseOptFloat(t[5], 'i2_a');
  const i12A = parseOptFloat(t[6], 'i12_a');
  const jA = parseOptFloat(t[7], 'j_a');
  const nsmA = parseOptFloat(t[8], 'nsm_a');
  const c1A = parseOptFloat(t[9], 'c1_a');
  const c2A = parseOptFloat(t[10], 'c2_a');
  const d1A = parseOptFloat(t[11], 'd1_a');
  const d2A = parseOptFloat(t[12], 'd2_a');
  const e1A = parseOptFloat(t[13], 'e1_a');
  const e2A = parseOptFloat(t[14], 'e2_a');
  const f1A = parseOptFloat(t[15], 'f1_a');
  const f2A = parseOptFloat(t[16], 'f2_a');
  const aVals = [i1A, i2A, i12A, jA, nsmA, c1A, c2A, d1A, d2A, e1A, e2A, f1A, f2A];
  if (aVals.some((v) => Number.isNaN(v))) return null;

  const normalizeSo = (raw) => String(raw == null ? '' : raw).trim().replace(/"/g, '').toUpperCase();
  const SO_VALUES = new Set(['YES', 'YESA', 'NO']);
  /** @type {Array<{so:string,x_xb:number,a:number|null,i1:number|null,i2:number|null,i12:number|null,j:number|null,nsm:number|null,c1:number|null,c2:number|null,d1:number|null,d2:number|null,e1:number|null,e2:number|null,f1:number|null,f2:number|null}>} */
  const stations = [];
  let idx = 17;
  while (idx < t.length) {
    const so = normalizeSo(t[idx]);
    if (!SO_VALUES.has(so)) break;
    const xxb = parseNastranFloat(t[idx + 1]);
    if (!Number.isFinite(xxb) || !(xxb > 0)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'PBEAM: invalid station X/XB', {
          source: record.source,
          cardName: 'PBEAM',
          details: { so: t[idx], x_xb: t[idx + 1] }
        })
      );
      return null;
    }
    const a = parseOptFloat(t[idx + 2], 'a');
    const i1 = parseOptFloat(t[idx + 3], 'i1');
    const i2 = parseOptFloat(t[idx + 4], 'i2');
    const i12 = parseOptFloat(t[idx + 5], 'i12');
    const j = parseOptFloat(t[idx + 6], 'j');
    const nsm = parseOptFloat(t[idx + 7], 'nsm');
    const c1 = parseOptFloat(t[idx + 8], 'c1');
    const c2 = parseOptFloat(t[idx + 9], 'c2');
    const d1 = parseOptFloat(t[idx + 10], 'd1');
    const d2 = parseOptFloat(t[idx + 11], 'd2');
    const e1 = parseOptFloat(t[idx + 12], 'e1');
    const e2 = parseOptFloat(t[idx + 13], 'e2');
    const f1 = parseOptFloat(t[idx + 14], 'f1');
    const f2 = parseOptFloat(t[idx + 15], 'f2');
    const vals = [a, i1, i2, i12, j, nsm, c1, c2, d1, d2, e1, e2, f1, f2];
    if (vals.some((v) => Number.isNaN(v))) return null;
    stations.push({
      so,
      x_xb: xxb,
      a: Number.isFinite(a) ? a : null,
      i1: Number.isFinite(i1) ? i1 : null,
      i2: Number.isFinite(i2) ? i2 : null,
      i12: Number.isFinite(i12) ? i12 : null,
      j: Number.isFinite(j) ? j : null,
      nsm: Number.isFinite(nsm) ? nsm : null,
      c1: Number.isFinite(c1) ? c1 : null,
      c2: Number.isFinite(c2) ? c2 : null,
      d1: Number.isFinite(d1) ? d1 : null,
      d2: Number.isFinite(d2) ? d2 : null,
      e1: Number.isFinite(e1) ? e1 : null,
      e2: Number.isFinite(e2) ? e2 : null,
      f1: Number.isFinite(f1) ? f1 : null,
      f2: Number.isFinite(f2) ? f2 : null,
    });
    idx += 16;
  }

  const tail = [
    ['k1', t[idx + 0]],
    ['k2', t[idx + 1]],
    ['s1', t[idx + 2]],
    ['s2', t[idx + 3]],
    ['nsi_a', t[idx + 4]],
    ['nsi_b', t[idx + 5]],
    ['cw_a', t[idx + 6]],
    ['cw_b', t[idx + 7]],
    ['m1_a', t[idx + 8]],
    ['m2_a', t[idx + 9]],
    ['m1_b', t[idx + 10]],
    ['m2_b', t[idx + 11]],
    ['n1_a', t[idx + 12]],
    ['n2_a', t[idx + 13]],
    ['n1_b', t[idx + 14]],
    ['n2_b', t[idx + 15]],
  ];
  /** @type {Record<string, number|null>} */
  const tailOut = {};
  for (const [k, raw] of tail) {
    const v = parseOptFloat(raw, k);
    if (Number.isNaN(v)) return null;
    tailOut[k] = Number.isFinite(v) ? v : null;
  }

  return {
    type: 'PBEAM',
    pid,
    mid,
    a_a: aA,
    i1_a: numOr(i1A, 0.0),
    i2_a: numOr(i2A, 0.0),
    i12_a: numOr(i12A, 0.0),
    j_a: numOr(jA, 0.0),
    nsm_a: numOr(nsmA, 0.0),
    c1_a: numOr(c1A, 0.0),
    c2_a: numOr(c2A, 0.0),
    d1_a: numOr(d1A, 0.0),
    d2_a: numOr(d2A, 0.0),
    e1_a: numOr(e1A, 0.0),
    e2_a: numOr(e2A, 0.0),
    f1_a: numOr(f1A, 0.0),
    f2_a: numOr(f2A, 0.0),
    stations,
    ...tailOut,
    source: record.source,
  };
}

function hydratePcomp(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const pid = parseNastranInt(t[1]);
  if (!Number.isFinite(pid) || !(pid > 0)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PCOMP: invalid required fields', {
        source: record.source,
        cardName: 'PCOMP',
        details: { pid: t[1] }
      })
    );
    return null;
  }

  const parseOptFloat = (raw, key) => {
    if (isBlankToken(raw)) return null;
    const v = parseNastranFloat(raw);
    if (!Number.isFinite(v)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', `PCOMP: invalid ${key}`, {
          source: record.source,
          cardName: 'PCOMP',
          details: { [key]: raw }
        })
      );
      return NaN;
    }
    return v;
  };
  const parseOptInt = (raw, key) => {
    if (isBlankToken(raw)) return null;
    const v = parseNastranInt(raw);
    if (!Number.isFinite(v)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', `PCOMP: invalid ${key}`, {
          source: record.source,
          cardName: 'PCOMP',
          details: { [key]: raw }
        })
      );
      return NaN;
    }
    return v;
  };
  const normUpperOrNull = (raw) => {
    if (isBlankToken(raw)) return null;
    const s = String(raw).trim().replace(/"/g, '').toUpperCase();
    return s || null;
  };

  const z0 = parseOptFloat(t[2], 'z0');
  const nsm = parseOptFloat(t[3], 'nsm');
  const sb = parseOptFloat(t[4], 'sb');
  const tref = parseOptFloat(t[6], 'tref');
  const ge = parseOptFloat(t[7], 'ge');
  if ([z0, nsm, sb, tref, ge].some((v) => Number.isNaN(v))) return null;

  const ft = normUpperOrNull(t[5]);
  const lam = normUpperOrNull(t[8]);
  const validFt = new Set(['HILL', 'HOFF', 'TSAI', 'STRN']);
  const validLam = new Set(['SYM', 'MEM', 'BEND', 'SMEAR', 'SMCORE']);
  if (ft && !validFt.has(ft)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PCOMP: invalid FT', {
        source: record.source,
        cardName: 'PCOMP',
        details: { ft: t[5] }
      })
    );
    return null;
  }
  if (lam && !validLam.has(lam)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PCOMP: invalid LAM', {
        source: record.source,
        cardName: 'PCOMP',
        details: { lam: t[8] }
      })
    );
    return null;
  }

  /** @type {Array<{mid:number,t:number,theta:number,sout:string}>} */
  const plies = [];
  for (let idx = 9; idx < t.length; idx += 4) {
    const midRaw = t[idx];
    const tRaw = t[idx + 1];
    const thetaRaw = t[idx + 2];
    const soutRaw = t[idx + 3];
    if (isBlankToken(midRaw) && isBlankToken(tRaw) && isBlankToken(thetaRaw) && isBlankToken(soutRaw)) {
      continue;
    }
    const mid = parseOptInt(midRaw, `mid${plies.length + 1}`);
    const thickness = parseOptFloat(tRaw, `t${plies.length + 1}`);
    const theta = parseOptFloat(thetaRaw, `theta${plies.length + 1}`);
    if (Number.isNaN(mid) || Number.isNaN(thickness) || Number.isNaN(theta)) return null;
    if (!Number.isFinite(mid) || !(mid > 0) || !Number.isFinite(thickness) || !(thickness > 0)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'PCOMP: each ply requires MIDi and positive Ti', {
          source: record.source,
          cardName: 'PCOMP',
          details: { mid: midRaw, t: tRaw, ply: plies.length + 1 }
        })
      );
      return null;
    }
    const sout = normUpperOrNull(soutRaw) || 'NO';
    if (sout !== 'YES' && sout !== 'NO') {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'PCOMP: SOUTi must be YES or NO', {
          source: record.source,
          cardName: 'PCOMP',
          details: { sout: soutRaw, ply: plies.length + 1 }
        })
      );
      return null;
    }
    plies.push({
      mid,
      t: thickness,
      theta: Number.isFinite(theta) ? theta : 0.0,
      sout,
    });
  }

  if (plies.length === 0) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PCOMP: expected at least one ply (MIDi/Ti)', {
        source: record.source,
        cardName: 'PCOMP',
        details: { pid }
      })
    );
    return null;
  }

  const totalThickness = plies.reduce((sum, p) => sum + p.t, 0.0);
  return {
    type: 'PCOMP',
    pid,
    z0: Number.isFinite(z0) ? z0 : null,
    nsm: Number.isFinite(nsm) ? nsm : null,
    sb: Number.isFinite(sb) ? sb : null,
    ft: ft || null,
    tref: Number.isFinite(tref) ? tref : null,
    ge: Number.isFinite(ge) ? ge : null,
    lam: lam || null,
    plies,
    totalThickness,
    source: record.source,
  };
}

function hydrateProd(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const pid = parseNastranInt(t[1]);
  const mid = parseNastranInt(t[2]);
  const A = parseNastranFloat(t[3]);
  const j = parseNastranFloat(t[4]);
  const c = parseNastranFloat(t[5]);
  const nsm = parseNastranFloat(t[6]);

  if (!Number.isFinite(pid) || !Number.isFinite(mid) || !Number.isFinite(A)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PROD: invalid required fields', {
        source: record.source,
        cardName: 'PROD',
        details: { pid: t[1], mid: t[2], A: t[3] }
      })
    );
    return null;
  }

  const normOpt = (v) => (v === null ? null : Number.isFinite(v) ? v : null);

  return {
    type: 'PROD',
    pid,
    mid,
    A,
    j: normOpt(j),
    c: normOpt(c),
    nsm: normOpt(nsm),
    source: record.source
  };
}

function hydrateMat1(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const mid = parseNastranInt(t[1]);
  const E = parseNastranFloat(t[2]);
  const G = parseNastranFloat(t[3]);
  const nu = parseNastranFloat(t[4]);
  const rho = parseNastranFloat(t[5]);
  const a = parseNastranFloat(t[6]);
  const tref = parseNastranFloat(t[7]);
  const ge = parseNastranFloat(t[8]);
  const st = parseNastranFloat(t[9]);
  const sc = parseNastranFloat(t[10]);
  const ss = parseNastranFloat(t[11]);
  const mcsid = parseNastranInt(t[12]);

  if (!Number.isFinite(mid) || !Number.isFinite(E)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'MAT1: invalid required fields', {
        source: record.source,
        cardName: 'MAT1',
        details: { mid: t[1], E: t[2] }
      })
    );
    return null;
  }

  return {
    type: 'MAT1',
    mid,
    E,
    G: Number.isFinite(G) ? G : null,
    nu: Number.isFinite(nu) ? nu : null,
    rho: Number.isFinite(rho) ? rho : null,
    a: Number.isFinite(a) ? a : null,
    tref: Number.isFinite(tref) ? tref : null,
    ge: Number.isFinite(ge) ? ge : null,
    st: Number.isFinite(st) ? st : null,
    sc: Number.isFinite(sc) ? sc : null,
    ss: Number.isFinite(ss) ? ss : null,
    mcsid: Number.isFinite(mcsid) ? mcsid : null,
    source: record.source
  };
}

function hydrateForce(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const sid = parseNastranInt(t[1]);
  const g = parseNastranInt(t[2]);
  const cid = parseNastranInt(t[3]);
  const f = parseNastranFloat(t[4]);
  const n1 = parseNastranFloat(t[5]);
  const n2 = parseNastranFloat(t[6]);
  const n3 = parseNastranFloat(t[7]);

  if (![sid, g].every((v) => Number.isFinite(v)) || !Number.isFinite(f) || ![n1, n2, n3].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'FORCE: invalid required fields', {
        source: record.source,
        cardName: 'FORCE',
        details: { sid: t[1], g: t[2], f: t[4], n: [t[5], t[6], t[7]] }
      })
    );
    return null;
  }

  // Spec: direction vector must not be the zero vector.
  // Use a tiny epsilon to treat +/-0 and very small values as zero.
  const eps = 1e-15;
  if (Math.abs(n1) < eps && Math.abs(n2) < eps && Math.abs(n3) < eps) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'FORCE: direction vector must be non-zero', {
        source: record.source,
        cardName: 'FORCE',
        details: { sid, g, n: [t[5], t[6], t[7]] }
      })
    );
    return null;
  }

  return {
    type: 'FORCE',
    sid,
    g,
    cid: Number.isFinite(cid) ? cid : 0,
    f,
    n: [n1, n2, n3],
    source: record.source
  };
}

function hydrateMoment(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const sid = parseNastranInt(t[1]);
  const g = parseNastranInt(t[2]);
  const cid = parseNastranInt(t[3]);
  const m = parseNastranFloat(t[4]);
  const n1 = parseNastranFloat(t[5]);
  const n2 = parseNastranFloat(t[6]);
  const n3 = parseNastranFloat(t[7]);

  if (![sid, g].every((v) => Number.isFinite(v)) || !Number.isFinite(m) || ![n1, n2, n3].every((v) => Number.isFinite(v))) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'MOMENT: invalid required fields', {
        source: record.source,
        cardName: 'MOMENT',
        details: { sid: t[1], g: t[2], m: t[4], n: [t[5], t[6], t[7]] }
      })
    );
    return null;
  }

  const eps = 1e-15;
  if (Math.abs(n1) < eps && Math.abs(n2) < eps && Math.abs(n3) < eps) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'MOMENT: direction vector must be non-zero', {
        source: record.source,
        cardName: 'MOMENT',
        details: { sid, g, n: [t[5], t[6], t[7]] }
      })
    );
    return null;
  }

  return {
    type: 'MOMENT',
    sid,
    g,
    cid: Number.isFinite(cid) ? cid : 0,
    m,
    n: [n1, n2, n3],
    source: record.source
  };
}

function expandIntegerListWithThru(rawTokens, minValue = 0) {
  const tokens = Array.isArray(rawTokens)
    ? rawTokens.filter((v) => !isBlankToken(v)).map((v) => String(v).trim())
    : [];
  if (tokens.length === 0) {
    return { ok: false, code: 'EMPTY', details: { rawTokens } };
  }

  /** @type {number[]} */
  const values = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const upper = tok.toUpperCase();
    if (upper === 'THRU') {
      const start = values.length > 0 ? values[values.length - 1] : null;
      const endTok = tokens[i + 1];
      const end = parseNastranInt(endTok);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end < minValue) {
        return { ok: false, code: 'BAD_THRU', details: { start, thru: tok, end: endTok, tokens } };
      }
      for (let v = start + 1; v <= end; v++) values.push(v);
      i += 1; // consume range end token
      continue;
    }

    const v = parseNastranInt(tok);
    if (!Number.isFinite(v) || v < minValue) {
      return { ok: false, code: 'BAD_ID', details: { token: tok, tokens } };
    }
    values.push(v);
  }

  // De-duplicate while preserving order.
  if (values.length > 1) {
    const seen = new Set();
    const deduped = values.filter((v) => {
      if (seen.has(v)) return false;
      seen.add(v);
      return true;
    });
    return { ok: true, values: deduped };
  }
  return { ok: true, values };
}

function hydratePload4(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const sid = parseNastranInt(t[1]);
  const eid = parseNastranInt(t[2]);
  const p1 = parseNastranFloat(t[3]);
  const p2raw = parseNastranFloat(t[4]);
  const p3raw = parseNastranFloat(t[5]);
  const p4raw = parseNastranFloat(t[6]);

  if (![sid, eid].every((v) => Number.isFinite(v)) || !Number.isFinite(p1)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PLOAD4: invalid required fields', {
        source: record.source,
        cardName: 'PLOAD4',
        details: { sid: t[1], eid: t[2], p: [t[3], t[4], t[5], t[6]] }
      })
    );
    return null;
  }

  const field7 = parseNastranString(t[7]);
  const field8 = parseNastranString(t[8]);
  const isThruForm = String(field7 || '').trim().toUpperCase() === 'THRU';
  /** @type {number[]} */
  let eids = [eid];
  let g1 = null;
  let g34 = null;

  if (isThruForm) {
    const expanded = expandIntegerListWithThru([eid, 'THRU', field8], 1);
    if (!expanded.ok) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'PLOAD4: invalid THRU range', {
          source: record.source,
          cardName: 'PLOAD4',
          details: expanded.details
        })
      );
      return null;
    }
    eids = expanded.values;
  } else {
    g1 = parseNastranInt(t[7]);
    g34 = parseNastranInt(t[8]);
    if (!isBlankToken(t[7]) && !Number.isFinite(g1)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'PLOAD4: invalid G1', {
          source: record.source,
          cardName: 'PLOAD4',
          details: { g1: t[7] }
        })
      );
      return null;
    }
    if (!isBlankToken(t[8]) && !Number.isFinite(g34)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'PLOAD4: invalid G3/G4', {
          source: record.source,
          cardName: 'PLOAD4',
          details: { g34: t[8] }
        })
      );
      return null;
    }
  }

  const cid = parseNastranInt(t[9]);
  const n1 = parseNastranFloat(t[10]);
  const n2 = parseNastranFloat(t[11]);
  const n3 = parseNastranFloat(t[12]);

  // Common shorthand: if only P1 is specified, treat it as uniform pressure.
  // If some pressures are blank, default them to P1; if provided, they must be valid numbers.
  if (p2raw !== null && !Number.isFinite(p2raw)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PLOAD4: invalid P2', { source: record.source, cardName: 'PLOAD4', details: { p2: t[4] } })
    );
    return null;
  }
  if (p3raw !== null && !Number.isFinite(p3raw)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PLOAD4: invalid P3', { source: record.source, cardName: 'PLOAD4', details: { p3: t[5] } })
    );
    return null;
  }
  if (p4raw !== null && !Number.isFinite(p4raw)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PLOAD4: invalid P4', { source: record.source, cardName: 'PLOAD4', details: { p4: t[6] } })
    );
    return null;
  }

  const p2 = p2raw === null ? p1 : p2raw;
  const p3 = p3raw === null ? p1 : p3raw;
  const p4 = p4raw === null ? p1 : p4raw;

  return {
    type: 'PLOAD4',
    sid,
    eid: eids[0],
    eids,
    p: [p1, p2, p3, p4],
    g1: Number.isFinite(g1) ? g1 : null,
    g34: Number.isFinite(g34) ? g34 : null,
    cid: Number.isFinite(cid) ? cid : null,
    n: [n1, n2, n3].every((v) => Number.isFinite(v)) ? [n1, n2, n3] : null,
    source: record.source
  };
}

function hydratePload2(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const sid = parseNastranInt(t[1]);
  const p = parseNastranFloat(t[2]);

  if (!Number.isFinite(sid) || !Number.isFinite(p)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PLOAD2: invalid required fields', {
        source: record.source,
        cardName: 'PLOAD2',
        details: { sid: t[1], p: t[2] }
      })
    );
    return null;
  }

  const restRaw = t.slice(3);
  const rest = restRaw.filter((v) => !isBlankToken(v)).map((v) => String(v).trim());
  if (rest.length === 0) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PLOAD2: expected at least one EID', {
        source: record.source,
        cardName: 'PLOAD2',
        details: { tokensAfterP: restRaw }
      })
    );
    return null;
  }

  /** @type {number[]} */
  let eids = [];

  const expanded = expandIntegerListWithThru(rest, 1);
  if (!expanded.ok) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PLOAD2: invalid EID list/THRU sequence', {
        source: record.source,
        cardName: 'PLOAD2',
        details: expanded.details
      })
    );
    return null;
  }
  eids = expanded.values;

  return {
    type: 'PLOAD2',
    sid,
    p,
    eids,
    source: record.source
  };
}

function hydrateLoad(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const sid = parseNastranInt(t[1]);
  const scale = parseNastranFloat(t[2]);
  if (!Number.isFinite(sid) || !Number.isFinite(scale)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'LOAD: invalid required fields', {
        source: record.source,
        cardName: 'LOAD',
        details: { sid: t[1], scale: t[2] }
      })
    );
    return null;
  }

  const rest = t.slice(3);
  // Large/small fixed-field formatting can pad trailing blank slots; LOAD pair
  // parsing should ignore trailing blanks rather than treating them as invalid pairs.
  while (rest.length > 0 && isBlankToken(rest[rest.length - 1])) rest.pop();
  if (rest.length === 0) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'LOAD: expected at least one (scale,lid) pair', {
        source: record.source,
        cardName: 'LOAD',
        details: { tokensAfterScale: rest }
      })
    );
    return null;
  }
  if (rest.length % 2 !== 0) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'LOAD: expected (scale,lid) pairs', {
        source: record.source,
        cardName: 'LOAD',
        details: { tokensAfterScale: rest }
      })
    );
    return null;
  }

  /** @type {Array<{lid:number, scale:number}>} */
  const entries = [];
  for (let i = 0; i < rest.length; i += 2) {
    // QRG: repeating (Si, Li) pairs => (scale, loadId)
    const s = parseNastranFloat(rest[i]);
    const lid = parseNastranInt(rest[i + 1]);
    if (!Number.isFinite(lid) || !Number.isFinite(s)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'LOAD: invalid (scale,lid) pair', {
          source: record.source,
          cardName: 'LOAD',
          details: { scale: rest[i], lid: rest[i + 1] }
        })
      );
      return null;
    }
    entries.push({ lid, scale: s });
  }

  return {
    type: 'LOAD',
    sid,
    scale,
    entries,
    source: record.source
  };
}

function hydrateSpc(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const sid = parseNastranInt(t[1]);
  const g1 = parseNastranInt(t[2]);
  const c1raw = parseNastranString(t[3]);
  const d1raw = parseNastranFloat(t[4]);

  const normalizeConstraintComponents = (raw, defaultValue = '0') => {
    if (raw == null) return defaultValue;
    const s = String(raw).trim();
    if (s.length === 0) return defaultValue;
    if (!/^\d+$/.test(s)) return null;
    if (s !== '0' && s.includes('0')) return null;
    const sorted = s.split('').sort().join('');
    if (sorted.length === 0) return defaultValue;
    const seen = new Set();
    for (const ch of sorted) {
      if (!'0123456'.includes(ch)) return null;
      if (seen.has(ch)) return null;
      seen.add(ch);
    }
    return sorted;
  };

  const c1 = normalizeConstraintComponents(c1raw, '0');
  const d1 = d1raw == null ? 0.0 : d1raw;

  if (
    !Number.isFinite(sid) ||
    sid < 1 ||
    !Number.isFinite(g1) ||
    g1 < 1 ||
    !c1 ||
    (t[4] != null && !isBlankToken(t[4]) && !Number.isFinite(d1raw))
  ) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'SPC: invalid required fields', {
        source: record.source,
        cardName: 'SPC',
        details: { sid: t[1], g1: t[2], c1: t[3], d1: t[4] }
      })
    );
    return null;
  }

  /** @type {Array<{type:string,sid:number,g:number,c:string,d:number,source?:any}>} */
  const out = [{ type: 'SPC', sid, g: g1, c: c1.length ? c1 : '0', d: Number.isFinite(d1) ? d1 : 0.0, source: record.source }];

  // Optional second entry.
  const g2tok = t[5];
  const c2tok = t[6];
  const d2tok = t[7];

  const anySecond = !isBlankToken(g2tok) || !isBlankToken(c2tok) || !isBlankToken(d2tok);
  if (anySecond) {
    const g2 = parseNastranInt(g2tok);
    const c2raw = parseNastranString(c2tok);
    const d2raw = parseNastranFloat(d2tok);
    const c2 = normalizeConstraintComponents(c2raw, '0');
    const d2 = d2raw == null ? 0.0 : d2raw;

    if (!Number.isFinite(g2) || g2 < 1 || !c2 || (d2tok != null && !isBlankToken(d2tok) && !Number.isFinite(d2raw))) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', 'SPC: invalid optional second entry', {
          source: record.source,
          cardName: 'SPC',
          details: { sid, g2: g2tok, c2: c2tok, d2: d2tok }
        })
      );
      return null;
    }

    out.push({ type: 'SPC', sid, g: g2, c: c2.length ? c2 : '0', d: Number.isFinite(d2) ? d2 : 0.0, source: record.source });
  }

  return out;
}

function hydrateSpc1(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const sid = parseNastranInt(t[1]);
  const compRaw = parseNastranString(t[2]);
  const normalizeConstraintComponents = (raw, defaultValue = '0') => {
    if (raw == null) return defaultValue;
    const s = String(raw).trim();
    if (s.length === 0) return defaultValue;
    if (!/^\d+$/.test(s)) return null;
    if (s !== '0' && s.includes('0')) return null;
    const sorted = s.split('').sort().join('');
    if (sorted.length === 0) return defaultValue;
    const seen = new Set();
    for (const ch of sorted) {
      if (!'0123456'.includes(ch)) return null;
      if (seen.has(ch)) return null;
      seen.add(ch);
    }
    return sorted;
  };
  const components = normalizeConstraintComponents(compRaw, '0');

  if (!Number.isFinite(sid) || sid < 1 || !components) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'SPC1: invalid required fields', {
        source: record.source,
        cardName: 'SPC1',
        details: { sid: t[1], components: t[2] }
      })
    );
    return null;
  }

  const restRaw = t.slice(3);
  const rest = restRaw.filter((v) => !isBlankToken(v)).map((v) => String(v).trim());
  if (rest.length === 0) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'SPC1: expected at least one GRID id', {
        source: record.source,
        cardName: 'SPC1',
        details: { tokensAfterComponents: restRaw }
      })
    );
    return null;
  }

  const expanded = expandIntegerListWithThru(rest, 1);
  if (!expanded.ok) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'SPC1: invalid GRID list/THRU sequence', {
        source: record.source,
        cardName: 'SPC1',
        details: expanded.details
      })
    );
    return null;
  }
  const nodes = expanded.values;

  return { type: 'SPC1', sid, components, nodes, source: record.source };
}

function hydrateConm2(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const eid = parseNastranInt(t[1]);
  const g = parseNastranInt(t[2]);
  const cid = parseNastranInt(t[3]);
  const parseOptFloat = (raw, key, defaultValue = 0.0) => {
    if (isBlankToken(raw)) return defaultValue;
    const v = parseNastranFloat(raw);
    if (!Number.isFinite(v)) {
      pushParseIssue(
        strictMode,
        errors,
        warnings,
        makeIssue('CARD_PARSE', `CONM2: invalid ${key}`, {
          source: record.source,
          cardName: 'CONM2',
          details: { [key]: raw }
        })
      );
      return NaN;
    }
    return v;
  };

  if (!Number.isFinite(eid) || eid < 1 || !Number.isFinite(g) || g < 1) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CONM2: invalid required fields', {
        source: record.source,
        cardName: 'CONM2',
        details: { eid: t[1], g: t[2], cid: t[3], m: t[4] }
      })
    );
    return null;
  }

  if (!isBlankToken(t[3]) && (!Number.isFinite(cid) || cid < -1)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CONM2: invalid CID', {
        source: record.source,
        cardName: 'CONM2',
        details: { cid: t[3] }
      })
    );
    return null;
  }

  const m = parseOptFloat(t[4], 'mass', 0.0);
  const x1 = parseOptFloat(t[5], 'x1', 0.0);
  const x2 = parseOptFloat(t[6], 'x2', 0.0);
  const x3 = parseOptFloat(t[7], 'x3', 0.0);
  // QRG fixed-format examples may include a blank separator before inertia terms.
  // Accept both layouts:
  // - no separator:  I11 starts at token 8
  // - separator:     I11 starts at token 9
  const hasInertiaSeparator =
    isBlankToken(t[8]) &&
    (!isBlankToken(t[9]) ||
      !isBlankToken(t[10]) ||
      !isBlankToken(t[11]) ||
      !isBlankToken(t[12]) ||
      !isBlankToken(t[13]) ||
      !isBlankToken(t[14]));
  const iBase = hasInertiaSeparator ? 9 : 8;
  const i11 = parseOptFloat(t[iBase + 0], 'I11', 0.0);
  const i21 = parseOptFloat(t[iBase + 1], 'I21', 0.0);
  const i22 = parseOptFloat(t[iBase + 2], 'I22', 0.0);
  const i31 = parseOptFloat(t[iBase + 3], 'I31', 0.0);
  const i32 = parseOptFloat(t[iBase + 4], 'I32', 0.0);
  const i33 = parseOptFloat(t[iBase + 5], 'I33', 0.0);

  if ([m, x1, x2, x3, i11, i21, i22, i31, i32, i33].some((v) => Number.isNaN(v))) {
    return null;
  }
  if (!Number.isFinite(m) || m < 0.0) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'CONM2: mass must be >= 0.0', {
        source: record.source,
        cardName: 'CONM2',
        details: { mass: t[4] }
      })
    );
    return null;
  }

  return {
    type: 'CONM2',
    eid,
    g,
    cid: Number.isFinite(cid) ? cid : 0,
    m,
    x: [x1, x2, x3],
    inertia: [i11, i21, i22, i31, i32, i33],
    source: record.source
  };
}

function hydratePsolid(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const pid = parseNastranInt(t[1]);
  const mid = parseNastranInt(t[2]);
  const cordm = parseNastranInt(t[3]);
  const integTok = parseNastranString(t[4]);
  const stressTok = parseNastranString(t[5]);
  const isopTok = parseNastranString(t[6]);
  const fctnTok = parseNastranString(t[7]);

  if (!Number.isFinite(pid) || !Number.isFinite(mid)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PSOLID: invalid required fields', {
        source: record.source,
        cardName: 'PSOLID',
        details: { pid: t[1], mid: t[2] }
      })
    );
    return null;
  }

  if (!isBlankToken(t[3]) && !Number.isFinite(cordm)) {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', 'PSOLID: invalid CORDM', {
        source: record.source,
        cardName: 'PSOLID',
        details: { cordm: t[3] }
      })
    );
    return null;
  }

  // Polymorphic normalization (pyNastran-compatible):
  // INTEG/STRESS/ISOP may be integers or strings; normalize known integer
  // encodings into their canonical string forms.
  const mapIntOrString = (tok, intMap) => {
    if (tok == null) return null;
    const asInt = parseNastranInt(tok);
    if (Number.isFinite(asInt)) return intMap.get(asInt) ?? String(tok).trim();
    return String(tok).trim().toUpperCase();
  };
  const integ = mapIntOrString(integTok, new Map([[0, 'BUBBLE'], [1, 'GAUSS'], [2, 'TWO'], [3, 'THREE']]));
  const stressRaw = mapIntOrString(stressTok, new Map([[0, 'GRID'], [1, 'GAUSS']]));
  const isop = mapIntOrString(isopTok, new Map([[0, 'REDUCED'], [1, 'FULL']]));

  // Safe defaults that do not require element-type context.
  const stress = stressRaw == null ? 'GRID' : stressRaw;
  const fctn = fctnTok == null ? 'SMECH' : String(fctnTok).trim().toUpperCase();

  return {
    type: 'PSOLID',
    pid,
    mid,
    cordm: Number.isFinite(cordm) ? cordm : 0,
    integ,
    stress,
    isop,
    fctn,
    source: record.source
  };
}

// Read the repeating TEMP / TEMPD fields without promoting these cards to
// semantic editing: source-backed export continues to preserve their data.
function hydrateTemperatures(record, strictMode, errors, warnings) {
  const t = getHydrationTokens(record);
  const name = toUpper(record.name);
  const entries = [];
  const issue = (message, details) => {
    pushParseIssue(strictMode, errors, warnings, makeIssue('CARD_PARSE', message, {
      source: record.source,
      cardName: name,
      details
    }));
  };
  let sid = null;
  let index = 1;
  if (name === 'TEMP') {
    sid = parseNastranInt(t[1]);
    if (!Number.isFinite(sid) || sid <= 0) {
      issue('TEMP: invalid SID (expected integer > 0)', { sid: t[1] });
      return entries;
    }
    index = 2;
  }
  for (; index < t.length;) {
    // Fixed-width cards include padding fields at the end of physical lines.
    // These are allowed between complete pairs, never in place of a temperature.
    if (isBlankToken(t[index])) {
      index++;
      continue;
    }
    const idRaw = t[index];
    const valueRaw = t[index + 1];
    const id = parseNastranInt(idRaw);
    const temperature = parseNastranFloat(valueRaw);
    const idField = name === 'TEMP' ? 'G' : 'SID';
    if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(temperature)) {
      issue(`${name}: invalid ${idField}/temperature pair`, {
        fieldIndex: index, [idField.toLowerCase()]: idRaw, temperature: valueRaw
      });
    } else if (name === 'TEMP') {
      entries.push({ sid, g: id, temperature });
    } else {
      entries.push({ sid: id, defaultTemperature: temperature });
    }
    index += 2;
  }
  if (!entries.length && t.slice(name === 'TEMP' ? 2 : 1).every(isBlankToken)) {
    issue(`${name}: missing temperature entries`, {});
  }
  return entries;
}

function hydrateIndexes(cardStream, strictMode, errors, warnings, directSoa = null, options = null) {
  const nodes = new Map();
  const coords = new Map();
  const coordsGlobalCache = new Map();
  const elements = new Map();
  const properties = new Map();
  const materials = new Map();
  const loads = new Map();
  const temperatures = new Map();
  const constraints = new Map();
  const masses = new Map();
  const schemaCards = new Map();
  const strictHydrationCards = new Set([
    'GRID', 'CORD1R', 'CORD1C', 'CORD2R', 'CORD2C', 'CORD2S',
    'PBAR', 'PBUSH', 'PBEAM', 'PCOMP', 'LOAD', 'FORCE', 'MOMENT', 'PLOAD2', 'PLOAD4', 'TEMP', 'TEMPD',
    'RBE2', 'RBE3', 'CROD', 'CBAR', 'CBEAM', 'CBUSH', 'CTETRA', 'CHEXA', 'CPENTA', 'CPYRAM',
    'CTRIA3', 'CQUAD4', 'PSHELL', 'PSOLID', 'PROD', 'MAT1', 'CONM2', 'SPC', 'SPC1',
  ]);
  const hasDirectSoa = !!(directSoa && typeof directSoa === 'object');
  const skipDirectElementHydration = !!(options && options.skipDirectElementHydration);
  const DIRECT_ELEM_TYPE = Object.freeze({
    CTRIA3: 2,
    CQUAD4: 3,
    CTETRA: 4,
    CHEXA: 5,
    CPENTA: 6,
    CPYRAM: 7
  });
  const DIRECT_ELEM_TYPE_NAME_BY_CODE = Object.freeze({
    2: 'CTRIA3',
    3: 'CQUAD4',
    4: 'CTETRA',
    5: 'CHEXA',
    6: 'CPENTA',
    7: 'CPYRAM'
  });

  const emitDirectHydrationIssue = (rec, cardName, message, details) => {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', message, {
        source: rec && rec.source ? rec.source : null,
        cardName,
        details: details || {}
      })
    );
  };

  const hasDirectRecord = (rec, kind) => (
    hasDirectSoa &&
    rec &&
    rec.kind === 'card' &&
    rec.directSoaKind === kind &&
    Number.isFinite(Number(rec.directSoaIndex))
  );

  const decodeGridPsMask = (mask) => {
    const m = Number(mask) | 0;
    if (m <= 0) return null;
    let out = '';
    for (let bit = 0; bit < 6; bit++) {
      if ((m & (1 << bit)) !== 0) out += String(bit + 1);
    }
    return out || null;
  };

  const hydrateDirectGrid = (rec) => {
    const idx = Number(rec.directSoaIndex) | 0;
    if (idx < 0 || idx >= (Number(directSoa.gridCount) | 0)) {
      emitDirectHydrationIssue(rec, 'GRID', 'GRID: invalid direct SoA index', { index: rec.directSoaIndex });
      return null;
    }
    const nid = Number(directSoa.gridNid[idx]);
    if (!Number.isFinite(nid) || nid < 1) {
      emitDirectHydrationIssue(rec, 'GRID', 'GRID: invalid NID in direct SoA', { index: idx, nid });
      return null;
    }
    const x1 = Number(directSoa.gridX1[idx]);
    const x2 = Number(directSoa.gridX2[idx]);
    const x3 = Number(directSoa.gridX3[idx]);
    if (![x1, x2, x3].every(Number.isFinite)) {
      emitDirectHydrationIssue(rec, 'GRID', 'GRID: invalid XYZ in direct SoA', { index: idx, x: [x1, x2, x3] });
      return null;
    }

    const cpRaw = Number(directSoa.gridCp[idx]);
    const cp = cpRaw >= 0 ? cpRaw : null;
    const cdRaw = Number(directSoa.gridCd[idx]);
    const cd = cdRaw === -2147483648 ? null : cdRaw;
    const seidRaw = Number(directSoa.gridSeid[idx]);
    const seid = seidRaw === -2147483648 ? null : seidRaw;
    const psMask = Number(directSoa.gridPsMask[idx]) | 0;
    const ps = decodeGridPsMask(psMask);
    const posLocal = [x1, x2, x3];

    return {
      nid,
      cp,
      x: posLocal,
      xLocal: posLocal,
      cd,
      ps,
      seid,
      source: rec.source
    };
  };

  const validateUniqueCornerNodes = (nids, cornerCount) => {
    if (!Array.isArray(nids) || cornerCount < 2) return true;
    for (let i = 0; i < cornerCount; i++) {
      for (let j = i + 1; j < cornerCount; j++) {
        if (nids[i] === nids[j]) return false;
      }
    }
    return true;
  };

  const hydrateDirectElement = (rec, name) => {
    const idx = Number(rec.directSoaIndex) | 0;
    if (idx < 0 || idx >= (Number(directSoa.elemCount) | 0)) {
      emitDirectHydrationIssue(rec, name, `${name}: invalid direct SoA index`, { index: rec.directSoaIndex });
      return null;
    }

    const expectedType = DIRECT_ELEM_TYPE[name];
    const storedType = Number(directSoa.elemType[idx]) | 0;
    if (Number.isFinite(expectedType) && storedType !== expectedType) {
      emitDirectHydrationIssue(rec, name, `${name}: direct SoA type mismatch`, {
        index: idx,
        expectedType,
        storedType
      });
      return null;
    }

    const eid = Number(directSoa.elemEid[idx]);
    const pid = Number(directSoa.elemPid[idx]);
    const connStart = Number(directSoa.elemConnStart[idx]) | 0;
    const connCount = Number(directSoa.elemConnCount[idx]) | 0;
    const connEnd = connStart + connCount;
    if (!Number.isFinite(eid) || !Number.isFinite(pid) || connStart < 0 || connCount < 0) {
      emitDirectHydrationIssue(rec, name, `${name}: invalid direct connectivity metadata`, {
        index: idx,
        eid,
        pid,
        connStart,
        connCount
      });
      return null;
    }
    if (connEnd > (Number(directSoa.elemConnUsed) | 0) || connEnd > directSoa.elemConn.length) {
      emitDirectHydrationIssue(rec, name, `${name}: direct connectivity out of range`, {
        index: idx,
        connStart,
        connCount,
        connUsed: directSoa.elemConnUsed
      });
      return null;
    }

    const nids = new Array(connCount);
    for (let i = 0; i < connCount; i++) {
      const nid = Number(directSoa.elemConn[connStart + i]);
      if (!Number.isFinite(nid)) {
        emitDirectHydrationIssue(rec, name, `${name}: invalid node id in direct connectivity`, {
          index: idx,
          nodeOffset: i,
          value: directSoa.elemConn[connStart + i]
        });
        return null;
      }
      nids[i] = nid;
    }

    if (name === 'CTRIA3') {
      if (connCount !== 3) {
        emitDirectHydrationIssue(rec, name, 'CTRIA3: direct connectivity must have exactly 3 nodes', { eid, connCount });
        return null;
      }
      const thetaMcid = Number(directSoa.elemThetaMcid[idx]);
      const zOffset = Number(directSoa.elemZOffset[idx]);
      const tflagRaw = Number(directSoa.elemTFlag[idx]);
      const t1 = Number(directSoa.elemT1[idx]);
      const t2 = Number(directSoa.elemT2[idx]);
      const t3 = Number(directSoa.elemT3[idx]);
      return {
        type: 'CTRIA3',
        eid,
        pid,
        nids,
        theta_mcid: Number.isFinite(thetaMcid) ? thetaMcid : null,
        zoffset: Number.isFinite(zOffset) ? zOffset : null,
        tflag: tflagRaw === -2147483648 ? null : tflagRaw,
        t: [
          Number.isFinite(t1) ? t1 : null,
          Number.isFinite(t2) ? t2 : null,
          Number.isFinite(t3) ? t3 : null
        ],
        source: rec.source
      };
    }

    if (name === 'CQUAD4') {
      if (connCount !== 4) {
        emitDirectHydrationIssue(rec, name, 'CQUAD4: direct connectivity must have exactly 4 nodes', { eid, connCount });
        return null;
      }
      const thetaMcid = Number(directSoa.elemThetaMcid[idx]);
      const zOffset = Number(directSoa.elemZOffset[idx]);
      const tflagRaw = Number(directSoa.elemTFlag[idx]);
      const t1 = Number(directSoa.elemT1[idx]);
      const t2 = Number(directSoa.elemT2[idx]);
      const t3 = Number(directSoa.elemT3[idx]);
      const t4 = Number(directSoa.elemT4[idx]);
      return {
        type: 'CQUAD4',
        eid,
        pid,
        nids,
        theta_mcid: Number.isFinite(thetaMcid) ? thetaMcid : null,
        zoffset: Number.isFinite(zOffset) ? zOffset : null,
        tflag: tflagRaw === -2147483648 ? null : tflagRaw,
        t: [
          Number.isFinite(t1) ? t1 : null,
          Number.isFinite(t2) ? t2 : null,
          Number.isFinite(t3) ? t3 : null,
          Number.isFinite(t4) ? t4 : null
        ],
        source: rec.source
      };
    }

    if (name === 'CTETRA') {
      if (connCount !== 4 && connCount !== 10) {
        emitDirectHydrationIssue(rec, name, 'CTETRA: nodes must be 4 or 10', { eid, connCount });
        return null;
      }
      if (!validateUniqueCornerNodes(nids, 4)) {
        emitDirectHydrationIssue(rec, name, 'CTETRA: corner nodes N1-N4 must be unique', { eid, corner: nids.slice(0, 4) });
        return null;
      }
      return { type: 'CTETRA', eid, pid, nids, source: rec.source };
    }

    if (name === 'CHEXA') {
      if (connCount !== 8 && connCount !== 20) {
        emitDirectHydrationIssue(rec, name, 'CHEXA: nodes must be 8 or 20', { eid, connCount });
        return null;
      }
      if (!validateUniqueCornerNodes(nids, 8)) {
        emitDirectHydrationIssue(rec, name, 'CHEXA: corner nodes G1-G8 must be unique', { eid, corner: nids.slice(0, 8) });
        return null;
      }
      return { type: 'CHEXA', eid, pid, nids, source: rec.source };
    }

    if (name === 'CPENTA') {
      if (connCount !== 6 && connCount !== 15) {
        emitDirectHydrationIssue(rec, name, 'CPENTA: nodes must be 6 or 15', { eid, connCount });
        return null;
      }
      if (!validateUniqueCornerNodes(nids, 6)) {
        emitDirectHydrationIssue(rec, name, 'CPENTA: corner nodes G1-G6 must be unique', { eid, corner: nids.slice(0, 6) });
        return null;
      }
      return { type: 'CPENTA', eid, pid, nids, source: rec.source };
    }

    if (name === 'CPYRAM') {
      if (connCount !== 5 && connCount !== 13) {
        emitDirectHydrationIssue(rec, name, 'CPYRAM: nodes must be 5 or 13', { eid, connCount });
        return null;
      }
      if (!validateUniqueCornerNodes(nids, 5)) {
        emitDirectHydrationIssue(rec, name, 'CPYRAM: corner nodes G1-G5 must be unique', { eid, corner: nids.slice(0, 5) });
        return null;
      }
      return { type: 'CPYRAM', eid, pid, nids, source: rec.source };
    }

    emitDirectHydrationIssue(rec, name, `${name}: direct hydration not implemented`, { eid });
    return null;
  };

  // Pass 1: coordinates
  for (const rec of cardStream) {
    if (!rec || rec.kind !== 'card') continue;
    const name = toUpper(rec.name);

    // Optional schema-driven hydration (must be enabled by caller).
    if (
      rec.schemaDef &&
      Array.isArray(rec.schemaDef.fields) &&
      rec.schemaDef.fields.length > 0 &&
      rec.enableSchemaHydration &&
      !strictHydrationCards.has(name)
    ) {
      // Avoid emitting schema errors for intentionally preserved blank-leading
      // fixed-field records (e.g., continuation heuristics tests).
      const firstLine = getRecordFirstLine(rec);
      if ((name === 'GRID') && (rec.fmt === 'small' || rec.fmt === 'large') && firstLine && /^[ \t]/.test(firstLine)) {
        // skip
      } else {
        const obj = hydrateBySchema(rec, rec.schemaDef, strictMode, errors, warnings);
        if (obj) {
          const arr = schemaCards.get(name) || [];
          arr.push(obj);
          schemaCards.set(name, arr);
        }
      }
    }
    if (name === 'CORD2R') {
      const coord = hydrateCord2R(rec, strictMode, errors, warnings);
      if (coord) coords.set(coord.cid, coord);
    } else if (name === 'CORD2C') {
      const coord = hydrateCord2C(rec, strictMode, errors, warnings);
      if (coord) coords.set(coord.cid, coord);
    } else if (name === 'CORD2S') {
      const coord = hydrateCord2S(rec, strictMode, errors, warnings);
      if (coord) coords.set(coord.cid, coord);
    } else if (name === 'CORD1R') {
      const coord = hydrateCord1R(rec, strictMode, errors, warnings);
      if (coord) coords.set(coord.cid, coord);
    } else if (name === 'CORD1C') {
      const coord = hydrateCord1C(rec, strictMode, errors, warnings);
      if (coord) coords.set(coord.cid, coord);
    }
  }

  // Hydrate direct SoA slabs even when direct records are not retained in cardStream.
  if (hasDirectSoa) {
    const gridCount = Number(directSoa.gridCount) | 0;
    for (let idx = 0; idx < gridCount; idx++) {
      const node = hydrateDirectGrid({ kind: 'card', directSoaIndex: idx, source: null });
      if (node) nodes.set(node.nid, node);
    }
    if (!skipDirectElementHydration) {
      const elemCount = Number(directSoa.elemCount) | 0;
      for (let idx = 0; idx < elemCount; idx++) {
        const typeName = DIRECT_ELEM_TYPE_NAME_BY_CODE[Number(directSoa.elemType[idx]) | 0];
        if (!typeName) continue;
        const elem = hydrateDirectElement({ kind: 'card', directSoaIndex: idx, source: null }, typeName);
        if (elem) elements.set(elem.eid, elem);
      }
    }
  }

  for (const rec of cardStream) {
    if (!rec || rec.kind !== 'card') continue;
    const name = toUpper(rec.name);
    if (name === 'GRID' && hasDirectRecord(rec, 'grid')) {
      const node = hydrateDirectGrid(rec);
      if (node) nodes.set(node.nid, node);
      continue;
    }
    if (
      (name === 'CTRIA3' || name === 'CQUAD4' || name === 'CTETRA' || name === 'CHEXA' || name === 'CPENTA' || name === 'CPYRAM') &&
      hasDirectRecord(rec, 'element')
    ) {
      if (!skipDirectElementHydration) {
        const elem = hydrateDirectElement(rec, name);
        if (elem) elements.set(elem.eid, elem);
      }
      continue;
    }
    if (name === 'GRID') {
      // Fixed-field GRID should be column-1 aligned; if the physical line is
      // blank-leading, token slices are intentionally preserved and may not
      // represent a valid GRID. Skip hydration rather than emitting parse errors.
      const firstLine = getRecordFirstLine(rec);
      if ((rec.fmt === 'small' || rec.fmt === 'large') && firstLine && /^[ \t]/.test(firstLine)) {
        continue;
      }
      const node = hydrateGrid(rec, strictMode, errors, warnings);
      if (node) nodes.set(node.nid, node);
    } else if (name === 'CTRIA3') {
      const elem = hydrateCtria3(rec, strictMode, errors, warnings);
      if (elem) elements.set(elem.eid, elem);
    } else if (name === 'CTRIA6') {
      const elem = hydrateCtria6(rec, strictMode, errors, warnings);
      if (elem) elements.set(elem.eid, elem);
    } else if (name === 'CQUAD4') {
      const elem = hydrateCquad4(rec, strictMode, errors, warnings);
      if (elem) elements.set(elem.eid, elem);
    } else if (name === 'CQUAD8') {
      const elem = hydrateCquad8(rec, strictMode, errors, warnings);
      if (elem) elements.set(elem.eid, elem);
    } else if (name === 'CROD') {
      const elem = hydrateCrod(rec, strictMode, errors, warnings);
      if (elem) elements.set(elem.eid, elem);
    } else if (name === 'CBAR') {
      const elem = hydrateCbar(rec, strictMode, errors, warnings);
      if (elem) elements.set(elem.eid, elem);
    } else if (name === 'CBEAM') {
      const elem = hydrateCbeam(rec, strictMode, errors, warnings);
      if (elem) elements.set(elem.eid, elem);
    } else if (name === 'CBUSH') {
      const elem = hydrateCbush(rec, strictMode, errors, warnings);
      if (elem) elements.set(elem.eid, elem);
    } else if (name === 'RBE2') {
      const elem = hydrateRbe2(rec, strictMode, errors, warnings);
      if (elem) elements.set(elem.eid, elem);
    } else if (name === 'RBE3') {
      const elem = hydrateRbe3(rec, strictMode, errors, warnings);
      if (elem) elements.set(elem.eid, elem);
    } else if (name === 'CTETRA') {
      const elem = hydrateCtetrA(rec, strictMode, errors, warnings);
      if (elem) elements.set(elem.eid, elem);
    } else if (name === 'CHEXA') {
      const elem = hydrateChexa(rec, strictMode, errors, warnings);
      if (elem) elements.set(elem.eid, elem);
    } else if (name === 'CPENTA') {
      const elem = hydrateCpenta(rec, strictMode, errors, warnings);
      if (elem) elements.set(elem.eid, elem);
    } else if (name === 'CPYRAM') {
      const elem = hydrateCpyram(rec, strictMode, errors, warnings);
      if (elem) elements.set(elem.eid, elem);
    } else if (name === 'PSHELL') {
      const prop = hydratePshell(rec, strictMode, errors, warnings);
      if (prop) properties.set(prop.pid, prop);
    } else if (name === 'PBAR') {
      const prop = hydratePbar(rec, strictMode, errors, warnings);
      if (prop) properties.set(prop.pid, prop);
    } else if (name === 'PBUSH') {
      const prop = hydratePbush(rec, strictMode, errors, warnings);
      if (prop) properties.set(prop.pid, prop);
    } else if (name === 'PBEAM') {
      const prop = hydratePbeam(rec, strictMode, errors, warnings);
      if (prop) properties.set(prop.pid, prop);
    } else if (name === 'PCOMP') {
      const prop = hydratePcomp(rec, strictMode, errors, warnings);
      if (prop) properties.set(prop.pid, prop);
    } else if (name === 'PROD') {
      const prop = hydrateProd(rec, strictMode, errors, warnings);
      if (prop) properties.set(prop.pid, prop);
    } else if (name === 'MAT1') {
      const mat = hydrateMat1(rec, strictMode, errors, warnings);
      if (mat) materials.set(mat.mid, mat);
    } else if (name === 'PSOLID') {
      const prop = hydratePsolid(rec, strictMode, errors, warnings);
      if (prop) properties.set(prop.pid, prop);
    } else if (name === 'TEMP' || name === 'TEMPD') {
      for (const entry of hydrateTemperatures(rec, strictMode, errors, warnings)) {
        const current = temperatures.get(entry.sid) || {
          sid: entry.sid, defaultTemperature: null, nodalValues: new Map()
        };
        if (name === 'TEMPD') current.defaultTemperature = entry.defaultTemperature;
        else current.nodalValues.set(entry.g, entry.temperature);
        temperatures.set(entry.sid, current);
      }
    } else if (name === 'FORCE') {
      const load = hydrateForce(rec, strictMode, errors, warnings);
      if (load) {
        const arr = loads.get(load.sid) || [];
        arr.push(load);
        loads.set(load.sid, arr);
      }
    } else if (name === 'MOMENT') {
      const load = hydrateMoment(rec, strictMode, errors, warnings);
      if (load) {
        const arr = loads.get(load.sid) || [];
        arr.push(load);
        loads.set(load.sid, arr);
      }
    } else if (name === 'PLOAD4') {
      const load = hydratePload4(rec, strictMode, errors, warnings);
      if (load) {
        const arr = loads.get(load.sid) || [];
        arr.push(load);
        loads.set(load.sid, arr);
      }
    } else if (name === 'PLOAD2') {
      const load = hydratePload2(rec, strictMode, errors, warnings);
      if (load) {
        const arr = loads.get(load.sid) || [];
        arr.push(load);
        loads.set(load.sid, arr);
      }
    } else if (name === 'LOAD') {
      const load = hydrateLoad(rec, strictMode, errors, warnings);
      if (load) {
        const arr = loads.get(load.sid) || [];
        arr.push(load);
        loads.set(load.sid, arr);
      }
    } else if (name === 'SPC') {
      const spcs = hydrateSpc(rec, strictMode, errors, warnings);
      if (Array.isArray(spcs) && spcs.length) {
        for (const spc of spcs) {
          const arr = constraints.get(spc.sid) || [];
          arr.push(spc);
          constraints.set(spc.sid, arr);
        }
      }
    } else if (name === 'SPC1') {
      const spc1 = hydrateSpc1(rec, strictMode, errors, warnings);
      if (spc1) {
        const arr = constraints.get(spc1.sid) || [];
        arr.push(spc1);
        constraints.set(spc1.sid, arr);
      }
    } else if (name === 'CONM2') {
      const mass = hydrateConm2(rec, strictMode, errors, warnings);
      if (mass) masses.set(mass.eid, mass);
    }
  }

  // Resolve GRID positions to global coordinates after all GRID/CORD cards are known.
  // This allows CORD1x systems (defined by nodes) and nested dependencies.
  const nodeGlobalCache = new Map();
  for (const node of nodes.values()) {
    if (!node || !Number.isFinite(node.nid)) continue;
    const cp = Number.isFinite(node.cp) ? node.cp : 0;
    if (cp === 0) {
      const local = Array.isArray(node.xLocal) ? node.xLocal : node.x;
      if (Array.isArray(local) && local.length >= 3) node.x = [Number(local[0]), Number(local[1]), Number(local[2])];
      continue;
    }
    const global = resolveNodeGlobal(node.nid, nodes, coords, nodeGlobalCache, coordsGlobalCache, [], []);
    if (global) {
      node.x = global;
      continue;
    }
    warnings.push(
      makeIssue('GRID_CP_NOT_FOUND', `GRID CP references unresolved coordinate system ${cp}`, {
        source: node.source,
        cardName: 'GRID',
        details: { nid: node.nid, cp }
      })
    );
  }

  // QRG rule: SPC1 component 0/blank is scalar-only.
  // We can enforce this for known GRID references after node indexes are complete.
  for (const [sid, arr] of constraints.entries()) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const kept = [];
    for (const c of arr) {
      if (c && c.type === 'SPC1') {
        const components = String(c.components ?? '').trim();
        const scalarOnly = !components || components === '0';
        if (scalarOnly) {
          const hasKnownGridRef = Array.isArray(c.nodes) && c.nodes.some((nid) => {
            const id = parseNastranInt(nid);
            return Number.isFinite(id) && nodes.has(id);
          });
          if (hasKnownGridRef) {
            pushParseIssue(
              strictMode,
              errors,
              warnings,
              makeIssue('CARD_PARSE', 'SPC1: component 0/blank is only valid for scalar points', {
                source: c.source,
                cardName: 'SPC1',
                details: {
                  sid: Number.isFinite(parseNastranInt(c.sid)) ? parseNastranInt(c.sid) : sid,
                  components: c.components,
                  nodes: Array.isArray(c.nodes) ? c.nodes.slice(0, 12) : c.nodes
                }
              })
            );
            if (strictMode) continue;
          }
        }
      }
      kept.push(c);
    }
    if (kept.length > 0) constraints.set(sid, kept);
    else constraints.delete(sid);
  }

  return { nodes, coords, elements, properties, materials, loads, temperatures, constraints, masses, schemaCards };
}

function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const SHARED_UTF8_DECODER = (typeof TextDecoder !== 'undefined')
  ? new TextDecoder('utf-8')
  : null;
const SHARED_UTF8_ENCODER = (typeof TextEncoder !== 'undefined')
  ? new TextEncoder()
  : null;

function encodeUtf8TextToBytes(text) {
  const s = String(text ?? '');
  if (SHARED_UTF8_ENCODER) return SHARED_UTF8_ENCODER.encode(s);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function decodeUtf8Slice(bytes, start, end) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const s = Math.max(0, Number(start) | 0);
  const e = Math.max(s, Math.min(view.length, Number(end) | 0));
  if (e <= s) return '';
  if (SHARED_UTF8_DECODER) return SHARED_UTF8_DECODER.decode(view.subarray(s, e));
  let out = '';
  for (let i = s; i < e; i++) out += String.fromCharCode(view[i]);
  return out;
}

function decodeUtf8TextInChunks(bytes, chunkBytes = 1 << 16) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  if (view.length === 0) return '';
  if (!SHARED_UTF8_DECODER) {
    let out = '';
    for (let i = 0; i < view.length; i++) out += String.fromCharCode(view[i]);
    return out;
  }
  const parts = [];
  for (let i = 0; i < view.length; i += chunkBytes) {
    const end = Math.min(view.length, i + chunkBytes);
    const chunk = view.subarray(i, end);
    const isFinal = end >= view.length;
    parts.push(SHARED_UTF8_DECODER.decode(chunk, { stream: !isFinal }));
  }
  parts.push(SHARED_UTF8_DECODER.decode());
  return parts.join('');
}

function coerceSourceText(source) {
  if (typeof source === 'string') return source;
  if (source == null) return '';
  if (typeof ArrayBuffer !== 'undefined') {
    if (source instanceof ArrayBuffer) {
      return decodeUtf8TextInChunks(new Uint8Array(source));
    }
    if (ArrayBuffer.isView && ArrayBuffer.isView(source)) {
      const view = source;
      return decodeUtf8TextInChunks(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    }
  }
  if (typeof source === 'object') {
    if (typeof source.text === 'string') return source.text;
    if (source.bytes != null) return coerceSourceText(source.bytes);
    if (source.arrayBuffer != null) return coerceSourceText(source.arrayBuffer);
  }
  return String(source);
}

function coerceSourceBytes(source) {
  if (source == null) return new Uint8Array(0);
  if (source instanceof Uint8Array) return source;
  if (typeof ArrayBuffer !== 'undefined') {
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (ArrayBuffer.isView && ArrayBuffer.isView(source)) {
      const view = source;
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
  }
  if (typeof source === 'string') return encodeUtf8TextToBytes(source);
  if (typeof source === 'object') {
    if (source.bytes != null) return coerceSourceBytes(source.bytes);
    if (source.arrayBuffer != null) return coerceSourceBytes(source.arrayBuffer);
    if (typeof source.text === 'string') return encodeUtf8TextToBytes(source.text);
  }
  return encodeUtf8TextToBytes(String(source));
}

function createLazyLineView(text) {
  const sourceText = String(text ?? '');
  const starts = [0];
  const ends = [];
  let scanPos = 0;
  let finalized = false;

  const ensureLine = (lineIndex) => {
    while (!finalized && ends.length <= lineIndex) {
      const newlineAt = sourceText.indexOf('\n', scanPos);
      if (newlineAt < 0) {
        ends.push(sourceText.length);
        finalized = true;
        break;
      }
      let lineEnd = newlineAt;
      if (lineEnd > scanPos && sourceText.charCodeAt(lineEnd - 1) === 13) lineEnd--;
      ends.push(lineEnd);
      scanPos = newlineAt + 1;
      starts.push(scanPos);
    }
  };

  const getLineInfo = (lineIndex) => {
    if (!Number.isInteger(lineIndex) || lineIndex < 0) return null;
    ensureLine(lineIndex);
    if (lineIndex >= ends.length) return null;
    const startOffset = starts[lineIndex];
    const endOffset = ends[lineIndex];
    return {
      line: sourceText.slice(startOffset, endOffset),
      lineNo: lineIndex + 1,
      startOffset,
      endOffset
    };
  };

  return { getLineInfo };
}

function getRecordFirstLine(rec) {
  if (!rec || typeof rec !== 'object') return '';
  if (typeof rec.sourceFirstLine === 'string') return rec.sourceFirstLine;
  if (Array.isArray(rec.rawLines) && rec.rawLines.length > 0) {
    return String(rec.rawLines[0] ?? '');
  }
  return '';
}

function sourceLinesFromSpanText(sourceText, startRaw, endRaw) {
  const text = String(sourceText ?? '');
  if (!text) return [];
  const start = Math.max(0, Math.min(text.length, Number(startRaw) | 0));
  const end = Math.max(start, Math.min(text.length, Number(endRaw) | 0));
  if (end <= start) return [];
  const out = [];
  let lineStart = start;
  for (let i = start; i < end; i++) {
    if (text.charCodeAt(i) !== 10) continue; // '\n'
    let lineEnd = i;
    if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) lineEnd--; // trim '\r'
    out.push(text.slice(lineStart, lineEnd));
    lineStart = i + 1;
  }
  if (lineStart <= end) {
    let lineEnd = end;
    if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) lineEnd--;
    out.push(text.slice(lineStart, lineEnd));
  }
  return out;
}

function countPhysicalLines(text) {
  const sourceText = String(text ?? '');
  if (!sourceText) return 1;
  let lines = 1;
  for (let i = 0; i < sourceText.length; i++) {
    if (sourceText.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

function isBlankLine(line) {
  return line.trim().length === 0;
}

function isCommentLine(line) {
  // Nastran comments are typically '$' in column 1, but tolerate leading whitespace.
  return line.trimStart().startsWith('$');
}

function isInBulkBeginLine(line) {
  return /^\s*BEGIN\s+BULK\b/i.test(line);
}

function isEndDataLine(line) {
  return /^\s*ENDDATA\b/i.test(line);
}

function hasCommaOutsideQuotes(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ',' && !inSingle && !inDouble) return true;
  }
  return false;
}

function getFixedFieldName(line8) {
  // cols 1-8; may contain trailing '*'
  const raw = (line8 ?? '').trim();
  return raw.endsWith('*') ? raw.slice(0, -1).trim().toUpperCase() : raw.toUpperCase();
}

function isPlausibleCardName(name) {
  const n = String(name ?? '').trim().toUpperCase();
  if (!n) return false;
  if (n === '+' || n === '*') return false;
  // Card names are typically alnum/underscore, start with a letter.
  return /^[A-Z][A-Z0-9_]*$/.test(n);
}

function isPlausibleNewFixedFieldCard(line) {
  // Based on columns 1-8 after trim.
  if (isInBulkBeginLine(line)) return true;
  const head8 = String(line ?? '').slice(0, 8);
  const name = getFixedFieldName(head8);
  // BEGIN BULK / ENDDATA are directives, but should behave like new cards for continuation decisions.
  if (name === 'BEGIN' || name === 'ENDDATA') return true;
  return isPlausibleCardName(name);
}

function isPlausibleNewFreeFieldCard(line) {
  if (!hasCommaOutsideQuotes(line)) return false;
  const name = getFreeFieldName(line);
  if (!name) return false;
  if (name === 'BEGIN' || name === 'ENDDATA') return true;
  return isPlausibleCardName(name);
}

function getFreeFieldName(line) {
  const idx = line.indexOf(',');
  const head = (idx >= 0 ? line.slice(0, idx) : line).trim();
  return head.toUpperCase();
}

function detectFormat(firstLine) {
  // Order matters: comments/blanks handled elsewhere.
  const trimmed = firstLine.trimStart();
  if (trimmed.startsWith('*')) return 'large';
  if (hasCommaOutsideQuotes(firstLine)) return 'free';
  const head8 = firstLine.slice(0, 8);
  if (head8.includes('*')) return 'large';
  return 'small';
}

function padRight(s, n) {
  const str = String(s ?? '');
  if (str.length >= n) return str;
  return str + ' '.repeat(n - str.length);
}

function sliceFixedFields(line, widths) {
  const out = [];
  let offset = 0;
  for (const w of widths) {
    out.push(line.slice(offset, offset + w));
    offset += w;
  }
  return out;
}

function sliceSmallLine80(line) {
  const padded = padRight(line, 80);
  return sliceFixedFields(padded, [8, 8, 8, 8, 8, 8, 8, 8, 8, 8]);
}

function sliceLargeLine80(line) {
  const padded = padRight(line, 80);
  // 1-8: name* or *cont; 9-72: 4x16 fields; 73-80: continuation marker (* or blank)
  return sliceFixedFields(padded, [8, 16, 16, 16, 16, 8]);
}

function trimAll(parts) {
  return parts.map((c) => String(c).trim());
}

function stripSmallFieldTrailingContinuationMarker(value) {
  const t = String(value ?? '').trim();
  if (t.length <= 1) return t;
  const last = t.charAt(t.length - 1);
  if (last !== '+' && last !== '*') return t;
  const prev = t.charAt(t.length - 2);
  if (prev === '+' || prev === '-') return t;
  return t.slice(0, -1).trim();
}

function isFreeTrailingContinuationToken(value, fieldIndex = -1) {
  const t = String(value ?? '').trim();
  if (t === '+' || t === '*') return true;
  // Labeled continuation IDs are metadata, not card data. In field 10 an
  // ID may be numeric (+123); elsewhere preserve signed numbers (+8, +1E3).
  return /^[+*][A-Za-z0-9_]+$/.test(t)
    && (fieldIndex === 9 || !Number.isFinite(parseNastranFloat(t)));
}

function isFreeContinuationHead(value) {
  const t = String(value ?? '').trim();
  return t === '' || t.startsWith('+') || t.startsWith('*');
}

function parseCsvLine(line) {
  // Quote-aware CSV-like parser; supports single/double quotes.
  const out = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      cur += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      cur += ch;
      continue;
    }
    if (ch === ',' && !inSingle && !inDouble) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function stripOuterQuotes(s) {
  const t = String(s ?? '').trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

function tokenizeCardLines(fmt, rawLines) {
  /** @type {string[][]} */
  const lineTokens = [];
  /** @type {string[][]} */
  const lineSlices = [];
  /** @type {string[]} */
  const tokens = [];

  if (!rawLines || rawLines.length === 0) return { tokens, lineTokens, lineSlices };

  if (fmt === 'free') {
    for (let i = 0; i < rawLines.length; i++) {
      const parts = parseCsvLine(rawLines[i]);
      if (parts.length > 1 && isFreeTrailingContinuationToken(parts[parts.length - 1], parts.length - 1)) parts.pop();
      lineTokens.push(parts);
      if (i === 0) {
        tokens.push(...parts);
      } else {
        // Continuation: drop the leading marker/ID (including a blank head).
        const head = (parts[0] ?? '').trimStart();
        if (isFreeContinuationHead(head)) tokens.push(...parts.slice(1));
        else tokens.push(...parts);
      }
    }
    // Normalize INCLUDE path token if present (doesn't change rawLines)
    if (tokens.length >= 2 && String(tokens[0]).toUpperCase() === 'INCLUDE') {
      tokens[1] = stripOuterQuotes(tokens[1]);
    }
    return { tokens, lineTokens, lineSlices };
  }

  if (fmt === 'small') {
    for (let i = 0; i < rawLines.length; i++) {
      const slices = sliceSmallLine80(rawLines[i]);
      const parts = trimAll(slices);
      if (parts.length > 8) parts[8] = stripSmallFieldTrailingContinuationMarker(parts[8]);
      lineSlices.push(slices);
      lineTokens.push(parts);
      if (i === 0) {
        // parts[0] is card name
        tokens.push(parts[0], ...parts.slice(1));
      } else {
        // parts[0] is continuation marker/id
        tokens.push(...parts.slice(1));
      }
    }
    return { tokens, lineTokens, lineSlices };
  }

  // large
  const stripTrailingStarFromLastField = (s) => {
    const t = String(s ?? '').trim();
    return t.endsWith('*') ? t.slice(0, -1).trim() : t;
  };
  for (let i = 0; i < rawLines.length; i++) {
    const slices = sliceLargeLine80(rawLines[i]);
    const parts = trimAll(slices);
    lineSlices.push(slices);
    lineTokens.push(parts);
    if (i === 0) {
      // parts[0] contains NAME*; normalize by stripping '*'
      const name = parts[0].endsWith('*') ? parts[0].slice(0, -1).trim() : parts[0];
      tokens.push(name, parts[1], parts[2], parts[3], stripTrailingStarFromLastField(parts[4]));
    } else {
      // Continuation: parts[0] is '*' or '*id'; parts[5] is cont marker; treat 1..4 as data
      tokens.push(parts[1], parts[2], parts[3], stripTrailingStarFromLastField(parts[4]));
    }
  }
  return { tokens, lineTokens, lineSlices };
}

function isContinuationLine(fmt, line) {
  const trimmed = line.trimStart();
  if (fmt === 'large') return trimmed.startsWith('*');
  if (fmt === 'small') return trimmed.startsWith('+');
  if (fmt === 'free') return /^[+*,]/.test(trimmed);
  return false;
}

function isBlankLeading(line) {
  const s = String(line ?? '');
  return s.length > 0 && /^[ \t]/.test(s);
}

function isBlankLeadingContinuationAllowed(fmt, nextLine, inBulk) {
  // Only consider blank-leading continuation inside BEGIN BULK..ENDDATA.
  if (!inBulk) return false;
  if (!isBlankLeading(nextLine)) return false;
  if (isBlankLine(nextLine) || isCommentLine(nextLine)) return false;

  if (fmt === 'small' || fmt === 'large') {
    // If it could be a new card header, treat as new card.
    return !isPlausibleNewFixedFieldCard(nextLine);
  }
  if (fmt === 'free') {
    // Free-field blank-leading continuation is allowed only if it does not look like a new free-field card.
    // Typical continuation starts with ',' or blanks then ','.
    return !isPlausibleNewFreeFieldCard(nextLine);
  }
  return false;
}

function readIncludeStatement(lines, startIndex, fileKey, inBulk) {
  // Returns null if not an INCLUDE line.
  const firstInfo = lines && typeof lines.getLineInfo === 'function'
    ? lines.getLineInfo(startIndex)
    : null;
  if (!firstInfo) return null;
  const firstLine = firstInfo.line;
  const trimmed = String(firstLine ?? '').trimStart();
  if (!/^INCLUDE\b/i.test(trimmed)) return null;

  // INCLUDE is typically a single physical line, but handle multi-line quoted paths.
  // Accept quote-aware parsing that may span continuation/blank-leading lines.
  const rawLineInfos = [firstInfo];
  const rawLines = [firstLine];

  // Extract the content after INCLUDE
  const m = /^INCLUDE\b(.*)$/i.exec(trimmed);
  let rest = (m && m[1] != null ? m[1] : '').trim();
  if (rest.startsWith('=')) rest = rest.slice(1).trim();

  if (!rest) {
    return { includePathRaw: '', rawLines, rawLineInfos, consumed: 1 };
  }

  const firstChar = rest[0];
  const quote = firstChar === "'" || firstChar === '"' ? firstChar : null;
  if (!quote) {
    // Unquoted path: take the remainder as-is
    return { includePathRaw: rest, rawLines, rawLineInfos, consumed: 1 };
  }

  // Quoted path: keep reading until we find the closing quote.
  let pathAccum = rest;
  let consumed = 1;
  const maxExtraLines = 20;
  for (let k = 0; k < maxExtraLines; k++) {
    const hasClosing = pathAccum.slice(1).includes(quote);
    if (hasClosing) break;
    const nextIndex = startIndex + consumed;
    const nextInfo = lines.getLineInfo(nextIndex);
    if (!nextInfo) break;
    const nextLine = nextInfo.line;
    // Only allow continuation-ish lines to extend the INCLUDE path.
    const ok =
      isContinuationLine('free', nextLine) ||
      isContinuationLine('small', nextLine) ||
      isContinuationLine('large', nextLine) ||
      (inBulk && isBlankLeading(nextLine));
    if (!ok) break;
    rawLineInfos.push(nextInfo);
    rawLines.push(nextLine);
    consumed++;
    // Append trimmed portion; strip leading continuation marker if present.
    const t = String(nextLine).trimStart();
    const appended = t.startsWith('+') || t.startsWith('*') ? t.slice(1).trimStart() : t;
    pathAccum += appended;
  }

  // Extract inside quotes from the accumulated string.
  const startQ = pathAccum.indexOf(quote);
  const endQ = pathAccum.indexOf(quote, startQ + 1);
  const inside = endQ > startQ ? pathAccum.slice(startQ + 1, endQ) : '';
  return { includePathRaw: quote + inside + quote, rawLines, rawLineInfos, consumed };
}

function parseIncludePathFromLine(line) {
  // Supports: INCLUDE 'path'  |  INCLUDE "path"  |  INCLUDE path
  const s = line.trim();
  const m = /^INCLUDE\b(.*)$/i.exec(s);
  if (!m) return null;
  let rest = (m[1] ?? '').trim();
  if (!rest) return '';
  // Strip a leading '=' if present.
  if (rest.startsWith('=')) rest = rest.slice(1).trim();
  // Outer quotes
  if ((rest.startsWith("'") && rest.endsWith("'")) || (rest.startsWith('"') && rest.endsWith('"'))) {
    rest = rest.slice(1, -1);
  }
  return rest;
}

function normalizeKeyForLookup(key) {
  return String(key ?? '')
    .replace(/\\/g, '/')
    .trim()
    .toLowerCase();
}

function buildVfsIndex(files, errors) {
  const index = {
    byFolded: new Map(),
    originalKeys: new Set()
  };

  if (!files || typeof files !== 'object') return index;
  for (const originalKey of Object.keys(files)) {
    const folded = normalizeKeyForLookup(originalKey);
    if (index.byFolded.has(folded) && index.byFolded.get(folded) !== originalKey) {
      errors.push(
        makeIssue('VFS_CASE_COLLISION', `VFS contains case-colliding files: '${index.byFolded.get(folded)}' and '${originalKey}'`, {
          details: { a: index.byFolded.get(folded), b: originalKey }
        })
      );
      continue;
    }
    index.byFolded.set(folded, originalKey);
    index.originalKeys.add(originalKey);
  }
  return index;
}

function hasNonSpaceAfterColumn80(line) {
  if (line.length <= 80) return false;
  const tail = line.slice(80);
  return /\S/.test(tail);
}

function hasTabs(line) {
  return String(line ?? '').includes('\t');
}

function splitPath(path) {
  const parts = String(path).split('/');
  return parts.filter((p) => p.length > 0);
}

function joinPath(parts) {
  return parts.join('/');
}

function dirname(path) {
  const s = String(path).replace(/\\/g, '/');
  const idx = s.lastIndexOf('/');
  return idx >= 0 ? s.slice(0, idx) : '';
}

function normalizeIncludePath(includePathRaw, includingFileKey, strictMode, errors, warnings) {
  let p = String(includePathRaw ?? '').trim();
  // Be tolerant of common INCLUDE syntaxes:
  //   INCLUDE 'path' | INCLUDE "path" | INCLUDE = 'path'
  if (p.startsWith('=')) p = p.slice(1).trim();
  p = stripOuterQuotes(p);
  if (p.length === 0) {
    const issue = makeIssue('INCLUDE_EMPTY_PATH', 'INCLUDE path is empty', {
      source: { file: includingFileKey }
    });
    (strictMode ? errors : warnings).push(issue);
    return null;
  }

  // Reject absolute/OS-specific paths for offline VFS.
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('\\\\') || p.startsWith('/')) {
    const issue = makeIssue('INCLUDE_ABSOLUTE_PATH', `INCLUDE path must be relative for offline VFS: '${p}'`, {
      source: { file: includingFileKey },
      details: { path: p }
    });
    (strictMode ? errors : warnings).push(issue);
    return null;
  }

  p = p.replace(/\\/g, '/');

  // We return two candidates:
  //  - relativeResolved: resolved against the including file's directory
  //  - rootResolved: normalized without the including file's directory
  const relParts = splitPath(p);

  function normalizeAgainstBase(baseParts) {
    const out = [...baseParts];
    for (const part of relParts) {
      if (part === '.') continue;
      if (part === '..') {
        if (out.length > 0) out.pop();
        else {
          const issue = makeIssue('INCLUDE_PATH_ABOVE_ROOT', `INCLUDE path escapes root: '${p}'`, {
            source: { file: includingFileKey },
            details: { path: p }
          });
          (strictMode ? errors : warnings).push(issue);
          return null;
        }
        continue;
      }
      out.push(part);
    }
    return joinPath(out);
  }

  const baseDir = dirname(includingFileKey);
  const baseParts = splitPath(baseDir);
  const relativeResolved = normalizeAgainstBase(baseParts);
  const rootResolved = normalizeAgainstBase([]);
  return { relativeResolved, rootResolved };
}

function resolveIncludeToVfsKey(candidates, vfsIndex) {
  if (!candidates) return null;
  const tryOne = (p) => {
    if (!p) return null;
    const folded = normalizeKeyForLookup(p);
    return vfsIndex.byFolded.has(folded) ? vfsIndex.byFolded.get(folded) : null;
  };

  return tryOne(candidates.relativeResolved) || tryOne(candidates.rootResolved);
}

async function parseDeckToCardStream(entryText, entryFileKey, files, options) {
  const strictMode = Boolean(options && options.strictMode);
  const exportMode = String((options && options.exportMode) || 'flatten');
  const enforceTier1 = Boolean(options && options.enforceTier1);
  const retainParseSession = Boolean(options && options.retainParseSession);
  const retainSourceSession = !(options && options.retainSourceSession === false);
  const skipDirectElementHydration = !retainParseSession;
  const extractSolidBoundary = Boolean(options && (options.extractSolidBoundary || options.extractCtetraBoundary));
  const retainRawLines = !(options && options.retainRawLines === false);
  const includeLineTokenMetadata = !(options && options.includeLineTokenMetadata === false);
  const includeSourceFilesInModel = !(options && options.includeSourceFilesInModel === false);
  const payloadMode = 'core_soa_only';
  // Runtime parse should keep compact source offsets for write-back even when source files stay worker-side.
  const retainSourceSpans = !(options && options.retainSourceSpans === false);
  const retainSourceLineRanges = !!(options && options.retainSourceLineRanges === true);
  const needsLineStorage = retainSourceSpans || retainSourceLineRanges || retainRawLines;
  const maxIncludeDepth = Number.isFinite(options && options.maxIncludeDepth) ? Number(options.maxIncludeDepth) : 50;
  const yieldEveryMs = Number.isFinite(options && options.yieldEveryMs) ? Number(options.yieldEveryMs) : 100;
  const yieldEveryNLines = Number.isFinite(options && options.yieldEveryNLines) ? Number(options.yieldEveryNLines) : 10000;
  const perfRunId = options && options.perfRunId != null ? String(options.perfRunId) : null;
  const parseStartMs = nowMs();
  const phaseDurationsMs = {};
  const phaseStartsMs = Object.create(null);
  const phaseTimeline = [];

  const emitPhase = (phase, event, extra = {}) => {
    const atMs = nowMs();
    const relMs = atMs - parseStartMs;
    const payload = { perfRunId, phase, event, atMs, relMs, ...extra };
    post('PARSE_PHASE', payload);
    if (phaseTimeline.length < 256) phaseTimeline.push(payload);
  };

  const beginPhase = (phase, extra = {}) => {
    phaseStartsMs[phase] = nowMs();
    emitPhase(phase, 'start', extra);
  };

  const endPhase = (phase, extra = {}) => {
    const endMs = nowMs();
    const startMs = Number.isFinite(phaseStartsMs[phase]) ? phaseStartsMs[phase] : endMs;
    const durationMs = Math.max(0, endMs - startMs);
    phaseDurationsMs[phase] = (phaseDurationsMs[phase] || 0) + durationMs;
    delete phaseStartsMs[phase];
    emitPhase(phase, 'end', { durationMs, ...extra });
  };

  const errors = [];
  const warnings = [];
  const vfsErrors = [];

  const vfsIndex = buildVfsIndex(files, vfsErrors);
  if (vfsErrors.length) {
    if (strictMode) errors.push(...vfsErrors);
    else warnings.push(...vfsErrors);
  }

  /** @type {Array<{kind:string,[k:string]:any}>} */
  const cardStream = [];
  const sourceFiles = Object.create(null);
  const sourceByteCache = new Map();
  const getSourceBytesForFile = (fileKey, sourceValue) => {
    const key = String(fileKey ?? '');
    if (sourceByteCache.has(key)) return sourceByteCache.get(key);
    const bytes = coerceSourceBytes(sourceValue);
    sourceByteCache.set(key, bytes);
    return bytes;
  };
  const includeStack = [];
  /** @type {Array<{includingFileKey:string, includingLine:number, pathRaw:string, status:string, resolvedKey:(string|null), rawLines:string[]}>} */
  const includeRecords = [];
  const shouldStoreSourceFiles = includeSourceFilesInModel || retainSourceSession || retainParseSession;

  // Zero-allocation parse staging: write heavy-card values into typed SoA slabs
  // during parse, then hydrate indexes from these slabs without token arrays.
  const DIRECT_CARD_TYPE = Object.freeze({
    GRID: 1,
    CTRIA3: 2,
    CQUAD4: 3,
    CTETRA: 4,
    CHEXA: 5,
    CPENTA: 6,
    CPYRAM: 7
  });

  const DIRECT_CARD_NAME_SET = new Set([
    'GRID', 'CTRIA3', 'CQUAD4', 'CTETRA', 'CHEXA', 'CPENTA', 'CPYRAM'
  ]);

  const directSoa = {
    // GRID SoA
    gridCount: 0,
    gridNid: new Int32Array(1 << 18),
    gridCp: new Int32Array(1 << 18),
    gridCd: new Int32Array(1 << 18),
    gridSeid: new Int32Array(1 << 18),
    gridPsMask: new Int32Array(1 << 18),
    gridX1: new Float64Array(1 << 18),
    gridX2: new Float64Array(1 << 18),
    gridX3: new Float64Array(1 << 18),

    // Element SoA
    elemCount: 0,
    elemType: new Uint8Array(1 << 18),
    elemEid: new Int32Array(1 << 18),
    elemPid: new Int32Array(1 << 18),
    elemConnStart: new Uint32Array(1 << 18),
    elemConnCount: new Uint8Array(1 << 18),
    elemConn: new Int32Array(1 << 21),
    elemThetaMcid: new Float64Array(1 << 18),
    elemZOffset: new Float64Array(1 << 18),
    elemTFlag: new Int32Array(1 << 18),
    elemT1: new Float64Array(1 << 18),
    elemT2: new Float64Array(1 << 18),
    elemT3: new Float64Array(1 << 18),
    elemT4: new Float64Array(1 << 18),
    elemConnUsed: 0
  };

  const initDirectElemOptionSlots = () => {
    for (let i = 0; i < directSoa.elemThetaMcid.length; i++) directSoa.elemThetaMcid[i] = NaN;
    for (let i = 0; i < directSoa.elemZOffset.length; i++) directSoa.elemZOffset[i] = NaN;
    for (let i = 0; i < directSoa.elemT1.length; i++) directSoa.elemT1[i] = NaN;
    for (let i = 0; i < directSoa.elemT2.length; i++) directSoa.elemT2[i] = NaN;
    for (let i = 0; i < directSoa.elemT3.length; i++) directSoa.elemT3[i] = NaN;
    for (let i = 0; i < directSoa.elemT4.length; i++) directSoa.elemT4[i] = NaN;
    for (let i = 0; i < directSoa.elemTFlag.length; i++) directSoa.elemTFlag[i] = -2147483648;
  };
  initDirectElemOptionSlots();

  const growInt32 = (src, needed) => {
    let cap = src.length;
    while (cap < needed) cap *= 2;
    const next = new Int32Array(cap);
    next.set(src);
    return next;
  };
  const growUint8 = (src, needed) => {
    let cap = src.length;
    while (cap < needed) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(src);
    return next;
  };
  const growUint32 = (src, needed) => {
    let cap = src.length;
    while (cap < needed) cap *= 2;
    const next = new Uint32Array(cap);
    next.set(src);
    return next;
  };
  const growFloat64 = (src, needed, fillNaN = false) => {
    let cap = src.length;
    while (cap < needed) cap *= 2;
    const next = new Float64Array(cap);
    next.set(src);
    if (fillNaN) {
      for (let i = src.length; i < next.length; i++) next[i] = NaN;
    }
    return next;
  };

  const ensureGridCapacity = (needed) => {
    if (directSoa.gridNid.length >= needed) return;
    directSoa.gridNid = growInt32(directSoa.gridNid, needed);
    directSoa.gridCp = growInt32(directSoa.gridCp, needed);
    directSoa.gridCd = growInt32(directSoa.gridCd, needed);
    directSoa.gridSeid = growInt32(directSoa.gridSeid, needed);
    directSoa.gridPsMask = growInt32(directSoa.gridPsMask, needed);
    directSoa.gridX1 = growFloat64(directSoa.gridX1, needed);
    directSoa.gridX2 = growFloat64(directSoa.gridX2, needed);
    directSoa.gridX3 = growFloat64(directSoa.gridX3, needed);
  };

  const ensureElemCapacity = (needed) => {
    if (directSoa.elemType.length < needed) directSoa.elemType = growUint8(directSoa.elemType, needed);
    if (directSoa.elemEid.length < needed) directSoa.elemEid = growInt32(directSoa.elemEid, needed);
    if (directSoa.elemPid.length < needed) directSoa.elemPid = growInt32(directSoa.elemPid, needed);
    if (directSoa.elemConnStart.length < needed) directSoa.elemConnStart = growUint32(directSoa.elemConnStart, needed);
    if (directSoa.elemConnCount.length < needed) directSoa.elemConnCount = growUint8(directSoa.elemConnCount, needed);
    if (directSoa.elemThetaMcid.length < needed) directSoa.elemThetaMcid = growFloat64(directSoa.elemThetaMcid, needed, true);
    if (directSoa.elemZOffset.length < needed) directSoa.elemZOffset = growFloat64(directSoa.elemZOffset, needed, true);
    if (directSoa.elemT1.length < needed) directSoa.elemT1 = growFloat64(directSoa.elemT1, needed, true);
    if (directSoa.elemT2.length < needed) directSoa.elemT2 = growFloat64(directSoa.elemT2, needed, true);
    if (directSoa.elemT3.length < needed) directSoa.elemT3 = growFloat64(directSoa.elemT3, needed, true);
    if (directSoa.elemT4.length < needed) directSoa.elemT4 = growFloat64(directSoa.elemT4, needed, true);
    if (directSoa.elemTFlag.length < needed) {
      const prevLen = directSoa.elemTFlag.length;
      directSoa.elemTFlag = growInt32(directSoa.elemTFlag, needed);
      for (let i = prevLen; i < directSoa.elemTFlag.length; i++) directSoa.elemTFlag[i] = -2147483648;
    }
  };

  const ensureElemConnCapacity = (needed) => {
    if (directSoa.elemConn.length >= needed) return;
    directSoa.elemConn = growInt32(directSoa.elemConn, needed);
  };

  const directNodeScratch = new Int32Array(24);

  const pushDirectGrid = (nid, cp, x1, x2, x3, cd, psMask, seid) => {
    const idx = directSoa.gridCount++;
    ensureGridCapacity(directSoa.gridCount);
    directSoa.gridNid[idx] = nid;
    directSoa.gridCp[idx] = Number.isFinite(cp) ? cp : -1;
    directSoa.gridCd[idx] = Number.isFinite(cd) ? cd : -2147483648;
    directSoa.gridSeid[idx] = Number.isFinite(seid) ? seid : -2147483648;
    directSoa.gridPsMask[idx] = Number.isFinite(psMask) ? psMask : 0;
    directSoa.gridX1[idx] = x1;
    directSoa.gridX2[idx] = x2;
    directSoa.gridX3[idx] = x3;
    return idx;
  };

  const pushDirectElement = (typeCode, eid, pid, nodeCount, opt = null) => {
    const idx = directSoa.elemCount++;
    ensureElemCapacity(directSoa.elemCount);
    const connStart = directSoa.elemConnUsed;
    const count = Math.max(0, Number(nodeCount) | 0);
    ensureElemConnCapacity(connStart + count);
    for (let i = 0; i < count; i++) {
      directSoa.elemConn[connStart + i] = directNodeScratch[i];
    }
    directSoa.elemConnUsed += count;
    directSoa.elemType[idx] = typeCode;
    directSoa.elemEid[idx] = eid;
    directSoa.elemPid[idx] = pid;
    directSoa.elemConnStart[idx] = connStart;
    directSoa.elemConnCount[idx] = count;
    if (opt && typeof opt === 'object') {
      if (Number.isFinite(opt.thetaMcid)) directSoa.elemThetaMcid[idx] = Number(opt.thetaMcid);
      if (Number.isFinite(opt.zOffset)) directSoa.elemZOffset[idx] = Number(opt.zOffset);
      if (Number.isFinite(opt.tflag)) directSoa.elemTFlag[idx] = Number(opt.tflag) | 0;
      if (Number.isFinite(opt.t1)) directSoa.elemT1[idx] = Number(opt.t1);
      if (Number.isFinite(opt.t2)) directSoa.elemT2[idx] = Number(opt.t2);
      if (Number.isFinite(opt.t3)) directSoa.elemT3[idx] = Number(opt.t3);
      if (Number.isFinite(opt.t4)) directSoa.elemT4[idx] = Number(opt.t4);
    }
    return idx;
  };

  // ---------- Solid boundary surface extraction ----------
  // We compute boundary faces using a parity hash-set: insert face on first encounter,
  // delete on second (internal face). Remaining faces are boundary.
  const mix32 = (x) => {
    let v = x >>> 0;
    v ^= v >>> 16;
    v = Math.imul(v, 0x7feb352d) >>> 0;
    v ^= v >>> 15;
    v = Math.imul(v, 0x846ca68b) >>> 0;
    v ^= v >>> 16;
    return v >>> 0;
  };
  const hashFace = (len, a, b, c, d) => {
    let h = 2166136261 >>> 0;
    h ^= mix32(len); h = Math.imul(h, 16777619) >>> 0;
    h ^= mix32(a); h = Math.imul(h, 16777619) >>> 0;
    h ^= mix32(b); h = Math.imul(h, 16777619) >>> 0;
    h ^= mix32(c); h = Math.imul(h, 16777619) >>> 0;
    h ^= mix32(d); h = Math.imul(h, 16777619) >>> 0;
    return h >>> 0;
  };

  const makeFaceSet = (initialPow2 = 22) => {
    let cap = 1 << initialPow2;
    let ka = new Uint32Array(cap);
    let kb = new Uint32Array(cap);
    let kc = new Uint32Array(cap);
    let kd = new Uint32Array(cap);
    // Preserve original per-face node order for rendering output; do not use
    // canonicalized/sorted keys for geometry reconstruction.
    let oa = new Uint32Array(cap);
    let ob = new Uint32Array(cap);
    let oc = new Uint32Array(cap);
    let od = new Uint32Array(cap);
    let kl = new Uint8Array(cap); // 3 or 4
    let ke = new Uint32Array(cap); // owner EID
    let st = new Uint8Array(cap); // 0 empty, 1 full, 2 tombstone
    let size = 0;
    let used = 0;

    const rehash = (newCap) => {
      const oldA = ka, oldB = kb, oldC = kc, oldD = kd;
      const oldOA = oa, oldOB = ob, oldOC = oc, oldOD = od;
      const oldL = kl, oldE = ke, oldS = st;
      cap = newCap;
      ka = new Uint32Array(cap);
      kb = new Uint32Array(cap);
      kc = new Uint32Array(cap);
      kd = new Uint32Array(cap);
      oa = new Uint32Array(cap);
      ob = new Uint32Array(cap);
      oc = new Uint32Array(cap);
      od = new Uint32Array(cap);
      kl = new Uint8Array(cap);
      ke = new Uint32Array(cap);
      st = new Uint8Array(cap);
      size = 0;
      used = 0;
      const m = cap - 1;
      for (let i = 0; i < oldS.length; i++) {
        if (oldS[i] !== 1) continue;
        const len = oldL[i];
        const a = oldA[i], b = oldB[i], c = oldC[i], d = oldD[i];
        const eid = oldE[i];
        let idx = hashFace(len, a, b, c, d) & m;
        while (st[idx] === 1) idx = (idx + 1) & m;
        st[idx] = 1;
        kl[idx] = len;
        ke[idx] = eid;
        ka[idx] = a; kb[idx] = b; kc[idx] = c; kd[idx] = d;
        oa[idx] = oldOA[i]; ob[idx] = oldOB[i]; oc[idx] = oldOC[i]; od[idx] = oldOD[i];
        size++; used++;
      }
    };

    const ensure = () => {
      if ((used / cap) < 0.85) return;
      rehash(cap << 1);
    };

    const toggleTri = (a0, b0, c0, ownerEid) => {
      const pa = a0 >>> 0, pb = b0 >>> 0, pc = c0 >>> 0;
      let a = pa, b = pb, c = pc;
      if (a > b) { const t = a; a = b; b = t; }
      if (b > c) { const t = b; b = c; c = t; }
      if (a > b) { const t = a; a = b; b = t; }
      const len = 3;
      const d = 0;
      const eid = (ownerEid >>> 0);

      ensure();
      const m = cap - 1;
      let idx = hashFace(len, a, b, c, d) & m;
      let firstTomb = -1;
      while (true) {
        const s = st[idx];
        if (s === 0) {
          const ins = firstTomb >= 0 ? firstTomb : idx;
          if (st[ins] === 0) used++;
          st[ins] = 1;
          kl[ins] = len;
          ke[ins] = eid;
          ka[ins] = a; kb[ins] = b; kc[ins] = c; kd[ins] = d;
          oa[ins] = pa; ob[ins] = pb; oc[ins] = pc; od[ins] = 0;
          size++;
          return;
        }
        if (s === 2) {
          if (firstTomb < 0) firstTomb = idx;
        } else {
          if (kl[idx] === len && ka[idx] === a && kb[idx] === b && kc[idx] === c) {
            st[idx] = 2;
            size--;
            return;
          }
        }
        idx = (idx + 1) & m;
      }
    };

    const toggleQuad = (a0, b0, c0, d0, ownerEid) => {
      const pa = a0 >>> 0, pb = b0 >>> 0, pc = c0 >>> 0, pd = d0 >>> 0;
      let a = pa, b = pb, c = pc, d = pd;
      // sort 4
      if (a > b) { const t = a; a = b; b = t; }
      if (c > d) { const t = c; c = d; d = t; }
      if (a > c) { const t = a; a = c; c = t; }
      if (b > d) { const t = b; b = d; d = t; }
      if (b > c) { const t = b; b = c; c = t; }
      const len = 4;
      const eid = (ownerEid >>> 0);

      ensure();
      const m = cap - 1;
      let idx = hashFace(len, a, b, c, d) & m;
      let firstTomb = -1;
      while (true) {
        const s = st[idx];
        if (s === 0) {
          const ins = firstTomb >= 0 ? firstTomb : idx;
          if (st[ins] === 0) used++;
          st[ins] = 1;
          kl[ins] = len;
          ke[ins] = eid;
          ka[ins] = a; kb[ins] = b; kc[ins] = c; kd[ins] = d;
          oa[ins] = pa; ob[ins] = pb; oc[ins] = pc; od[ins] = pd;
          size++;
          return;
        }
        if (s === 2) {
          if (firstTomb < 0) firstTomb = idx;
        } else {
          if (kl[idx] === len && ka[idx] === a && kb[idx] === b && kc[idx] === c && kd[idx] === d) {
            st[idx] = 2;
            size--;
            return;
          }
        }
        idx = (idx + 1) & m;
      }
    };

    const toFaces = () => {
      // packed faces: [len, a, b, c, d, eid]
      const out = new Uint32Array(size * 6);
      let w = 0;
      for (let i = 0; i < st.length; i++) {
        if (st[i] !== 1) continue;
        out[w++] = kl[i];
        out[w++] = oa[i];
        out[w++] = ob[i];
        out[w++] = oc[i];
        out[w++] = od[i];
        out[w++] = ke[i];
      }
      return out;
    };

    return { toggleTri, toggleQuad, toFaces, getSize: () => size };
  };

  // Keep boundary extraction available in full-feature mode so we can render
  // only visible outer solid faces without internal shared faces.
  const solidFaceSet = extractSolidBoundary ? makeFaceSet(20) : null;

  const buildSolidBoundaryChunkManifest = (faces, nodeMap, gridSize = 8) => {
    if (!(faces instanceof Uint32Array)) return null;
    if (!nodeMap || typeof nodeMap.get !== 'function') return null;
    const faceCount = Math.floor(faces.length / 6);
    if (faceCount <= 0) return null;
    const grid = Math.max(1, Math.min(64, Number(gridSize) | 0));
    const chunkTotal = grid * grid * grid;
    if (!Number.isFinite(chunkTotal) || chunkTotal <= 0) return null;

    const faceChunkIds = new Uint16Array(faceCount);
    const faceCx = new Float64Array(faceCount);
    const faceCy = new Float64Array(faceCount);
    const faceCz = new Float64Array(faceCount);
    const faceTriCount = new Uint8Array(faceCount);

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    let validFaceCount = 0;

    const getNodePoint = (nidRaw) => {
      const nid = Number(nidRaw);
      if (!Number.isFinite(nid)) return null;
      const node = nodeMap.get(nid);
      if (!node) return null;
      const p = Array.isArray(node.x) && node.x.length >= 3
        ? node.x
        : (Array.isArray(node.xLocal) && node.xLocal.length >= 3 ? node.xLocal : null);
      if (!p) return null;
      const x = Number(p[0]);
      const y = Number(p[1]);
      const z = Number(p[2]);
      if (![x, y, z].every(Number.isFinite)) return null;
      return [x, y, z];
    };

    for (let i = 0; i < faceCount; i++) {
      const len = Number(faces[6 * i]) | 0;
      const triCount = len === 4 ? 2 : (len === 3 ? 1 : 0);
      if (!triCount) continue;
      const pA = getNodePoint(faces[6 * i + 1]);
      const pB = getNodePoint(faces[6 * i + 2]);
      const pC = getNodePoint(faces[6 * i + 3]);
      if (!pA || !pB || !pC) continue;

      let cx;
      let cy;
      let cz;
      let faceMinX;
      let faceMinY;
      let faceMinZ;
      let faceMaxX;
      let faceMaxY;
      let faceMaxZ;

      if (len === 4) {
        const pD = getNodePoint(faces[6 * i + 4]);
        if (!pD) continue;
        cx = 0.25 * (pA[0] + pB[0] + pC[0] + pD[0]);
        cy = 0.25 * (pA[1] + pB[1] + pC[1] + pD[1]);
        cz = 0.25 * (pA[2] + pB[2] + pC[2] + pD[2]);
        faceMinX = Math.min(pA[0], pB[0], pC[0], pD[0]);
        faceMinY = Math.min(pA[1], pB[1], pC[1], pD[1]);
        faceMinZ = Math.min(pA[2], pB[2], pC[2], pD[2]);
        faceMaxX = Math.max(pA[0], pB[0], pC[0], pD[0]);
        faceMaxY = Math.max(pA[1], pB[1], pC[1], pD[1]);
        faceMaxZ = Math.max(pA[2], pB[2], pC[2], pD[2]);
      } else {
        cx = (pA[0] + pB[0] + pC[0]) / 3;
        cy = (pA[1] + pB[1] + pC[1]) / 3;
        cz = (pA[2] + pB[2] + pC[2]) / 3;
        faceMinX = Math.min(pA[0], pB[0], pC[0]);
        faceMinY = Math.min(pA[1], pB[1], pC[1]);
        faceMinZ = Math.min(pA[2], pB[2], pC[2]);
        faceMaxX = Math.max(pA[0], pB[0], pC[0]);
        faceMaxY = Math.max(pA[1], pB[1], pC[1]);
        faceMaxZ = Math.max(pA[2], pB[2], pC[2]);
      }

      faceCx[i] = cx;
      faceCy[i] = cy;
      faceCz[i] = cz;
      faceTriCount[i] = triCount;

      if (faceMinX < minX) minX = faceMinX;
      if (faceMinY < minY) minY = faceMinY;
      if (faceMinZ < minZ) minZ = faceMinZ;
      if (faceMaxX > maxX) maxX = faceMaxX;
      if (faceMaxY > maxY) maxY = faceMaxY;
      if (faceMaxZ > maxZ) maxZ = faceMaxZ;
      validFaceCount++;
    }

    if (
      validFaceCount === 0 ||
      ![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)
    ) {
      return null;
    }

    const dx = Math.max(1e-9, maxX - minX);
    const dy = Math.max(1e-9, maxY - minY);
    const dz = Math.max(1e-9, maxZ - minZ);
    const invx = grid / dx;
    const invy = grid / dy;
    const invz = grid / dz;

    const chunkTriCountFull = new Uint32Array(chunkTotal);
    const chunkBoundsMinFull = new Float32Array(chunkTotal * 3);
    const chunkBoundsMaxFull = new Float32Array(chunkTotal * 3);
    chunkBoundsMinFull.fill(Number.POSITIVE_INFINITY);
    chunkBoundsMaxFull.fill(Number.NEGATIVE_INFINITY);

    for (let i = 0; i < faceCount; i++) {
      const triCount = faceTriCount[i];
      if (!triCount) continue;
      const cx = faceCx[i];
      const cy = faceCy[i];
      const cz = faceCz[i];
      if (![cx, cy, cz].every(Number.isFinite)) continue;
      let gx = Math.floor((cx - minX) * invx); if (gx < 0) gx = 0; if (gx >= grid) gx = grid - 1;
      let gy = Math.floor((cy - minY) * invy); if (gy < 0) gy = 0; if (gy >= grid) gy = grid - 1;
      let gz = Math.floor((cz - minZ) * invz); if (gz < 0) gz = 0; if (gz >= grid) gz = grid - 1;
      const cid = gx + gy * grid + gz * grid * grid;
      faceChunkIds[i] = cid;
      chunkTriCountFull[cid] += triCount;
      const off = cid * 3;
      if (cx < chunkBoundsMinFull[off]) chunkBoundsMinFull[off] = cx;
      if (cy < chunkBoundsMinFull[off + 1]) chunkBoundsMinFull[off + 1] = cy;
      if (cz < chunkBoundsMinFull[off + 2]) chunkBoundsMinFull[off + 2] = cz;
      if (cx > chunkBoundsMaxFull[off]) chunkBoundsMaxFull[off] = cx;
      if (cy > chunkBoundsMaxFull[off + 1]) chunkBoundsMaxFull[off + 1] = cy;
      if (cz > chunkBoundsMaxFull[off + 2]) chunkBoundsMaxFull[off + 2] = cz;
    }

    let activeCount = 0;
    for (let cid = 0; cid < chunkTotal; cid++) {
      if (chunkTriCountFull[cid] > 0) activeCount++;
    }
    if (activeCount === 0) return null;

    const chunkIds = new Uint16Array(activeCount);
    const triStart = new Uint32Array(activeCount);
    const triCount = new Uint32Array(activeCount);
    const chunkBoundsMin = new Float32Array(activeCount * 3);
    const chunkBoundsMax = new Float32Array(activeCount * 3);

    let w = 0;
    let runningTri = 0;
    for (let cid = 0; cid < chunkTotal; cid++) {
      const tc = chunkTriCountFull[cid];
      if (!tc) continue;
      chunkIds[w] = cid;
      triStart[w] = runningTri;
      triCount[w] = tc;
      runningTri += tc;
      const src = cid * 3;
      const dst = w * 3;
      chunkBoundsMin[dst] = Number.isFinite(chunkBoundsMinFull[src]) ? chunkBoundsMinFull[src] : minX;
      chunkBoundsMin[dst + 1] = Number.isFinite(chunkBoundsMinFull[src + 1]) ? chunkBoundsMinFull[src + 1] : minY;
      chunkBoundsMin[dst + 2] = Number.isFinite(chunkBoundsMinFull[src + 2]) ? chunkBoundsMinFull[src + 2] : minZ;
      chunkBoundsMax[dst] = Number.isFinite(chunkBoundsMaxFull[src]) ? chunkBoundsMaxFull[src] : maxX;
      chunkBoundsMax[dst + 1] = Number.isFinite(chunkBoundsMaxFull[src + 1]) ? chunkBoundsMaxFull[src + 1] : maxY;
      chunkBoundsMax[dst + 2] = Number.isFinite(chunkBoundsMaxFull[src + 2]) ? chunkBoundsMaxFull[src + 2] : maxZ;
      w++;
    }

    const manifest = {
      version: 1,
      gridSize: grid,
      faceCount,
      triCount: runningTri,
      boundsMin: [minX, minY, minZ],
      boundsMax: [maxX, maxY, maxZ],
      faceChunkIds,
      chunkIds,
      triStart,
      triCountPerChunk: triCount,
      chunkBoundsMin,
      chunkBoundsMax
    };
    const transfers = [
      faceChunkIds.buffer,
      chunkIds.buffer,
      triStart.buffer,
      triCount.buffer,
      chunkBoundsMin.buffer,
      chunkBoundsMax.buffer
    ];
    return { manifest, transfers };
  };

  const parseIntField = (s) => {
    if (!s) return null;
    const t = String(s).trim();
    if (!t) return null;
    const v = Number.parseInt(t, 10);
    return Number.isFinite(v) ? v : null;
  };

  const parseSolidCornerNodesFromTokens = (cardName, tokens) => {
    const name = String(cardName || '').trim().toUpperCase();
    const need =
      name === 'CTETRA' ? 4 :
        name === 'CHEXA' ? 8 :
          name === 'CPENTA' ? 6 :
            name === 'CPYRAM' ? 5 : 0;
    if (!need) return null;
    const t = Array.isArray(tokens) ? tokens : [];
    const eid = parseIntField(t[1]);
    const nodes = [];
    for (let i = 0; i < need; i++) nodes.push(parseIntField(t[3 + i]));
    if (!Number.isFinite(eid)) return null;
    if (!nodes.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    return { eid, nodes };
  };

  const isSpaceTabByte = (b) => b === 32 || b === 9;
  const toUpperAsciiByte = (b) => (b >= 97 && b <= 122) ? (b - 32) : b;

  const countPhysicalLinesFromBytes = (bytes) => {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    if (view.length === 0) return 1;
    let lines = 1;
    for (let i = 0; i < view.length; i++) {
      if (view[i] === 10) lines++;
    }
    return lines;
  };

  const createLazyByteLineView = (bytes) => {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    let scanPos = 0;
    let nextLineIndex = 0;
    let nextLineNo = 1;
    let finalized = false;
    const cache = new Map();
    let minCachedIndex = 0;

    const parseNextLine = () => {
      if (finalized) return null;
      const lineIndex = nextLineIndex;
      const lineNo = nextLineNo;
      const startOffset = scanPos;

      let nl = scanPos;
      while (nl < view.length && view[nl] !== 10) nl++;

      let endOffset = nl;
      if (endOffset > startOffset && view[endOffset - 1] === 13) endOffset--;

      const info = { lineNo, startOffset, endOffset };
      cache.set(lineIndex, info);
      nextLineIndex++;
      nextLineNo++;

      if (nl >= view.length) {
        finalized = true;
        scanPos = view.length + 1;
      } else {
        scanPos = nl + 1;
      }
      return info;
    };

    const ensureLine = (lineIndex) => {
      while (!finalized && nextLineIndex <= lineIndex) parseNextLine();
    };

    const releaseBefore = (lineIndex) => {
      if (!Number.isInteger(lineIndex)) return;
      const keepFrom = Math.max(0, Number(lineIndex) | 0);
      while (minCachedIndex < keepFrom) {
        cache.delete(minCachedIndex);
        minCachedIndex++;
      }
    };

    const getLineInfo = (lineIndex) => {
      if (!Number.isInteger(lineIndex) || lineIndex < 0) return null;
      if (lineIndex < minCachedIndex) return null;
      ensureLine(lineIndex);
      return cache.get(lineIndex) || null;
    };

    return { getLineInfo, releaseBefore };
  };

  const decodeLineByInfo = (sourceBytes, info) => {
    if (!info) return '';
    return decodeUtf8Slice(sourceBytes, info.startOffset, info.endOffset);
  };

  const getLineInfoWithText = (lineView, sourceBytes, lineIndex) => {
    const info = lineView.getLineInfo(lineIndex);
    if (!info) return null;
    return {
      ...info,
      line: decodeLineByInfo(sourceBytes, info)
    };
  };

  const isBlankLineBytes = (sourceBytes, start, end) => {
    const s = Math.max(0, Number(start) | 0);
    const e = Math.max(s, Math.min(sourceBytes.length, Number(end) | 0));
    for (let i = s; i < e; i++) {
      const b = sourceBytes[i];
      if (b !== 32 && b !== 9 && b !== 13) return false;
    }
    return true;
  };

  const skipLeadingSpacesTabs = (sourceBytes, start, end) => {
    let i = Math.max(0, Number(start) | 0);
    const e = Math.max(i, Math.min(sourceBytes.length, Number(end) | 0));
    while (i < e && isSpaceTabByte(sourceBytes[i])) i++;
    return i;
  };

  const isCommentLineBytes = (sourceBytes, start, end) => {
    const i = skipLeadingSpacesTabs(sourceBytes, start, end);
    return i < end && sourceBytes[i] === 36; // '$'
  };

  const matchAsciiTokenAt = (sourceBytes, tokenStart, tokenEnd, upperWord) => {
    const w = String(upperWord || '');
    if (!w) return false;
    if ((tokenEnd - tokenStart) !== w.length) return false;
    for (let i = 0; i < w.length; i++) {
      const b = sourceBytes[tokenStart + i];
      if (toUpperAsciiByte(b) !== w.charCodeAt(i)) return false;
    }
    return true;
  };

  const nthTokenRange = (sourceBytes, start, end, n) => {
    let i = skipLeadingSpacesTabs(sourceBytes, start, end);
    const e = Math.max(i, Math.min(sourceBytes.length, Number(end) | 0));
    let tokenIndex = 0;
    while (i < e) {
      const s = i;
      while (i < e && !isSpaceTabByte(sourceBytes[i])) i++;
      const tEnd = i;
      if (tokenIndex === n) return [s, tEnd];
      tokenIndex++;
      while (i < e && isSpaceTabByte(sourceBytes[i])) i++;
    }
    return [-1, -1];
  };

  const isInBulkBeginLineBytes = (sourceBytes, start, end) => {
    const t0 = nthTokenRange(sourceBytes, start, end, 0);
    if (t0[0] < 0) return false;
    if (!matchAsciiTokenAt(sourceBytes, t0[0], t0[1], 'BEGIN')) return false;
    const t1 = nthTokenRange(sourceBytes, start, end, 1);
    return t1[0] >= 0 && matchAsciiTokenAt(sourceBytes, t1[0], t1[1], 'BULK');
  };

  const isEndDataLineBytes = (sourceBytes, start, end) => {
    const t0 = nthTokenRange(sourceBytes, start, end, 0);
    return t0[0] >= 0 && matchAsciiTokenAt(sourceBytes, t0[0], t0[1], 'ENDDATA');
  };

  const isIncludeLineBytes = (sourceBytes, start, end) => {
    const t0 = nthTokenRange(sourceBytes, start, end, 0);
    return t0[0] >= 0 && matchAsciiTokenAt(sourceBytes, t0[0], t0[1], 'INCLUDE');
  };

  const hasTabsBytes = (sourceBytes, start, end) => {
    const s = Math.max(0, Number(start) | 0);
    const e = Math.max(s, Math.min(sourceBytes.length, Number(end) | 0));
    for (let i = s; i < e; i++) {
      if (sourceBytes[i] === 9) return true;
    }
    return false;
  };

  const hasNonSpaceAfterColumn80Bytes = (sourceBytes, start, end) => {
    const s = Math.max(0, Number(start) | 0);
    const e = Math.max(s, Math.min(sourceBytes.length, Number(end) | 0));
    let i = s + 80;
    if (i < s) i = s;
    if (i >= e) return false;
    for (; i < e; i++) {
      const b = sourceBytes[i];
      if (b !== 32 && b !== 9 && b !== 13) return true;
    }
    return false;
  };

  const hasCommaOutsideQuotesBytes = (sourceBytes, start, end) => {
    let inSingle = false;
    let inDouble = false;
    const s = Math.max(0, Number(start) | 0);
    const e = Math.max(s, Math.min(sourceBytes.length, Number(end) | 0));
    for (let i = s; i < e; i++) {
      const ch = sourceBytes[i];
      if (ch === 39 && !inDouble) { // '
        inSingle = !inSingle;
        continue;
      }
      if (ch === 34 && !inSingle) { // "
        inDouble = !inDouble;
        continue;
      }
      if (ch === 44 && !inSingle && !inDouble) return true; // ,
    }
    return false;
  };

  const detectFormatFromBytes = (sourceBytes, start, end) => {
    const s = skipLeadingSpacesTabs(sourceBytes, start, end);
    const e = Math.max(s, Math.min(sourceBytes.length, Number(end) | 0));
    if (s < e && sourceBytes[s] === 42) return 'large'; // '*'
    if (hasCommaOutsideQuotesBytes(sourceBytes, start, end)) return 'free';
    const headStart = Math.max(0, Number(start) | 0);
    const headEnd = Math.min(e, headStart + 8);
    for (let i = headStart; i < headEnd; i++) {
      if (sourceBytes[i] === 42) return 'large';
    }
    return 'small';
  };

  const isContinuationLineBytes = (fmt, sourceBytes, start, end) => {
    const s = skipLeadingSpacesTabs(sourceBytes, start, end);
    if (s >= end) return false;
    const first = sourceBytes[s];
    if (fmt === 'large') return first === 42; // '*'
    if (fmt === 'small') return first === 43; // '+'
    if (fmt === 'free') return first === 43 || first === 42 || first === 44; // '+', '*', ','
    return false;
  };

  const isBlankLeadingBytes = (sourceBytes, start, end) => {
    const s = Math.max(0, Number(start) | 0);
    if (s >= end) return false;
    return isSpaceTabByte(sourceBytes[s]);
  };

  const extractFixedSlice = (sourceBytes, start, end, colStart, width) => {
    const absStart = Math.max(0, start + colStart);
    const maxEnd = Math.max(absStart, Math.min(sourceBytes.length, end));
    let out = '';
    for (let i = 0; i < width; i++) {
      const p = absStart + i;
      out += (p < maxEnd) ? String.fromCharCode(sourceBytes[p]) : ' ';
    }
    return out;
  };

  const trimFixedFieldToken = (slice) => String(slice ?? '').trim();

  const getFixedFieldNameFromBytes = (sourceBytes, start, end) => {
    const head = trimFixedFieldToken(extractFixedSlice(sourceBytes, start, end, 0, 8));
    const normalized = head.endsWith('*') ? head.slice(0, -1).trim() : head;
    return normalized.toUpperCase();
  };

  const stripTrailingStarFromLastField = (s) => {
    const t = String(s ?? '').trim();
    return t.endsWith('*') ? t.slice(0, -1).trim() : t;
  };

  const tokenizeCardLineInfos = (fmt, sourceBytes, lineInfos, name) => {
    /** @type {string[][]} */
    const lineTokens = includeLineTokenMetadata ? [] : null;
    /** @type {string[][]} */
    const lineSlices = includeLineTokenMetadata ? [] : null;
    /** @type {string[]} */
    const tokens = [];

    if (!Array.isArray(lineInfos) || lineInfos.length === 0) {
      return { tokens: [String(name || '')], lineTokens, lineSlices };
    }

    if (fmt === 'free') {
      tokens.push(String(name || '').toUpperCase());
      for (let i = 0; i < lineInfos.length; i++) {
        const line = decodeLineByInfo(sourceBytes, lineInfos[i]);
        const parts = parseCsvLine(line);
        if (parts.length > 1 && isFreeTrailingContinuationToken(parts[parts.length - 1], parts.length - 1)) parts.pop();
        if (lineTokens) lineTokens.push(parts);
        if (i === 0) {
          tokens.push(...parts.slice(1));
        } else {
          const head = String(parts[0] || '').trimStart();
          if (isFreeContinuationHead(head)) tokens.push(...parts.slice(1));
          else tokens.push(...parts);
        }
      }
      if (tokens.length >= 2 && String(tokens[0]).toUpperCase() === 'INCLUDE') {
        tokens[1] = stripOuterQuotes(tokens[1]);
      }
      return { tokens, lineTokens, lineSlices };
    }

    if (fmt === 'small') {
      tokens.push(String(name || '').toUpperCase());
      for (let i = 0; i < lineInfos.length; i++) {
        const info = lineInfos[i];
        if (lineTokens || lineSlices) {
          const slices = [];
          for (let f = 0; f < 10; f++) {
            slices.push(extractFixedSlice(sourceBytes, info.startOffset, info.endOffset, f * 8, 8));
          }
          const parts = trimAll(slices);
          if (lineSlices) lineSlices.push(slices);
          if (lineTokens) lineTokens.push(parts);
          tokens.push(...parts.slice(1, 9)); // drop continuation-id field (cols 73-80)
          continue;
        }
        for (let f = 1; f <= 8; f++) {
          tokens.push(trimFixedFieldToken(extractFixedSlice(sourceBytes, info.startOffset, info.endOffset, f * 8, 8)));
        }
      }
      return { tokens, lineTokens, lineSlices };
    }

    // large
    tokens.push(String(name || '').toUpperCase());
    for (let i = 0; i < lineInfos.length; i++) {
      const info = lineInfos[i];
      if (lineTokens || lineSlices) {
        const slices = [
          extractFixedSlice(sourceBytes, info.startOffset, info.endOffset, 0, 8),
          extractFixedSlice(sourceBytes, info.startOffset, info.endOffset, 8, 16),
          extractFixedSlice(sourceBytes, info.startOffset, info.endOffset, 24, 16),
          extractFixedSlice(sourceBytes, info.startOffset, info.endOffset, 40, 16),
          extractFixedSlice(sourceBytes, info.startOffset, info.endOffset, 56, 16),
          extractFixedSlice(sourceBytes, info.startOffset, info.endOffset, 72, 8)
        ];
        const parts = trimAll(slices);
        if (lineSlices) lineSlices.push(slices);
        if (lineTokens) lineTokens.push(parts);
        tokens.push(parts[1], parts[2], parts[3], stripTrailingStarFromLastField(parts[4]));
        continue;
      }
      tokens.push(
        trimFixedFieldToken(extractFixedSlice(sourceBytes, info.startOffset, info.endOffset, 8, 16)),
        trimFixedFieldToken(extractFixedSlice(sourceBytes, info.startOffset, info.endOffset, 24, 16)),
        trimFixedFieldToken(extractFixedSlice(sourceBytes, info.startOffset, info.endOffset, 40, 16)),
        stripTrailingStarFromLastField(extractFixedSlice(sourceBytes, info.startOffset, info.endOffset, 56, 16))
      );
    }
    return { tokens, lineTokens, lineSlices };
  };

  const EMPTY_LINE_STORAGE = Object.freeze({});
  const buildLineStorageFromInfos = (sourceBytes, lineInfos, includeFirstLine = false) => {
    if (!includeFirstLine && !needsLineStorage) return EMPTY_LINE_STORAGE;
    const infos = Array.isArray(lineInfos) ? lineInfos : [];
    const firstInfo = infos.length ? infos[0] : null;
    const lastInfo = infos.length ? infos[infos.length - 1] : null;
    const out = {};
    if (retainSourceSpans && firstInfo && lastInfo) {
      out.sourceSpan = [
        Number(firstInfo.startOffset || 0),
        Number(lastInfo.endOffset || 0)
      ];
    }
    if (includeFirstLine && firstInfo) out.sourceFirstLine = decodeLineByInfo(sourceBytes, firstInfo);
    if (retainSourceLineRanges) {
      out.sourceLineRanges = infos.map((info) => [Number(info.startOffset || 0), Number(info.endOffset || 0)]);
    }
    if (retainRawLines) out.rawLines = infos.map((info) => decodeLineByInfo(sourceBytes, info));
    return out;
  };

  const spanStart = (spans, i) => spans[(i << 1)] ?? 0;
  const spanEnd = (spans, i) => spans[(i << 1) + 1] ?? 0;
  const spanCount = (spans) => (Array.isArray(spans) ? (spans.length >> 1) : 0);
  const spanIsBlank = (spans, i) => spanStart(spans, i) >= spanEnd(spans, i);
  const directSpanScratch = [];
  const freeLineSpanScratch = [];

  const spanIsFreeContinuationHead = (spans, i, sourceBytes) => {
    const s = spanStart(spans, i);
    const e = spanEnd(spans, i);
    return s === e || sourceBytes[s] === 43 || sourceBytes[s] === 42;
  };

  const appendNormalizedFreeFieldSpan = (out, sourceBytes, rawStart, rawEnd) => {
    let range = trimByteRange(sourceBytes, rawStart, rawEnd);
    let s = range[0];
    let e = range[1];
    if (e - s >= 2) {
      const first = sourceBytes[s];
      const last = sourceBytes[e - 1];
      if ((first === 34 && last === 34) || (first === 39 && last === 39)) {
        s++;
        e--;
      }
    }
    out.push(s, e);
  };

  const collectFreeFieldSpans = (sourceBytes, info, out) => {
    const outSpans = Array.isArray(out) ? out : [];
    outSpans.length = 0;
    const s = Math.max(0, Number(info && info.startOffset) | 0);
    const e = Math.max(s, Math.min(sourceBytes.length, Number(info && info.endOffset) | 0));
    let fieldStart = s;
    let inSingle = false;
    let inDouble = false;
    for (let i = s; i < e; i++) {
      const b = sourceBytes[i];
      if (b === 39 && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
      if (b === 34 && !inSingle) {
        inDouble = !inDouble;
        continue;
      }
      if (b === 44 && !inSingle && !inDouble) {
        appendNormalizedFreeFieldSpan(outSpans, sourceBytes, fieldStart, i);
        fieldStart = i + 1;
      }
    }
    appendNormalizedFreeFieldSpan(outSpans, sourceBytes, fieldStart, e);
    return outSpans;
  };

  const collectCardDataSpans = (fmt, sourceBytes, lineInfos, out) => {
    const infos = Array.isArray(lineInfos) ? lineInfos : [];
    const spans = Array.isArray(out) ? out : [];
    spans.length = 0;
    if (infos.length === 0) return spans;

    if (fmt === 'small') {
      for (let i = 0; i < infos.length; i++) {
        const info = infos[i];
        for (let f = 1; f <= 8; f++) {
          const rawStart = Number(info.startOffset) + (f * 8);
          const rawEnd = rawStart + 8;
          const span = trimByteRange(sourceBytes, rawStart, Math.min(Number(info.endOffset), rawEnd));
          let s = span[0];
          let e = span[1];
          if (f === 8 && e > s + 1 && (sourceBytes[e - 1] === 43 || sourceBytes[e - 1] === 42)) {
            const prev = sourceBytes[e - 2];
            if (prev !== 43 && prev !== 45) {
              const trimmed = trimByteRange(sourceBytes, s, e - 1);
              s = trimmed[0];
              e = trimmed[1];
            }
          }
          spans.push(s, e);
        }
      }
      return spans;
    }

    if (fmt === 'large') {
      const largeRanges = [
        [8, 24],
        [24, 40],
        [40, 56],
        [56, 72]
      ];
      for (let i = 0; i < infos.length; i++) {
        const info = infos[i];
        for (let r = 0; r < largeRanges.length; r++) {
          const c0 = largeRanges[r][0];
          const c1 = largeRanges[r][1];
          const rawStart = Number(info.startOffset) + c0;
          const rawEnd = Number(info.startOffset) + c1;
          const span = trimByteRange(sourceBytes, rawStart, Math.min(Number(info.endOffset), rawEnd));
          let s = span[0];
          let e = span[1];
          if (r === 3 && e > s && sourceBytes[e - 1] === 42) {
            e--;
            const r2 = trimByteRange(sourceBytes, s, e);
            s = r2[0];
            e = r2[1];
          }
          spans.push(s, e);
        }
      }
      return spans;
    }

    // free-field
    for (let i = 0; i < infos.length; i++) {
      const lineSpans = collectFreeFieldSpans(sourceBytes, infos[i], freeLineSpanScratch);
      const fields = spanCount(lineSpans);
      if (fields === 0) continue;
      let startField = 0;
      if (i === 0) {
        startField = 1; // drop card name
      } else if (spanIsFreeContinuationHead(lineSpans, 0, sourceBytes)) {
        startField = 1; // drop continuation marker
      }
      let endField = fields;
      if (fields > startField + 1) {
        const lastStart = spanStart(lineSpans, fields - 1);
        const lastEnd = spanEnd(lineSpans, fields - 1);
        const marker = String.fromCharCode(...sourceBytes.slice(lastStart, lastEnd)).trim();
        if (isFreeTrailingContinuationToken(marker, fields - 1)) endField = fields - 1;
      }
      for (let f = startField; f < endField; f++) {
        spans.push(spanStart(lineSpans, f), spanEnd(lineSpans, f));
      }
    }
    return spans;
  };

  const emitDirectIssue = (source, cardName, message, details) => {
    pushParseIssue(
      strictMode,
      errors,
      warnings,
      makeIssue('CARD_PARSE', message, { source, cardName, details })
    );
  };

  const parseSpanIntField = (sourceBytes, spans, i) => {
    if (spanIsBlank(spans, i)) return null;
    return parseNastranIntFromBytes(sourceBytes, spanStart(spans, i), spanEnd(spans, i));
  };

  const parseSpanFloatField = (sourceBytes, spans, i) => {
    if (spanIsBlank(spans, i)) return null;
    return parseNastranFloatFromBytes(sourceBytes, spanStart(spans, i), spanEnd(spans, i));
  };

  const parseSpanThetaOrMcidField = (sourceBytes, spans, i) => {
    if (spanIsBlank(spans, i)) return null;
    const iv = parseNastranIntFromBytes(sourceBytes, spanStart(spans, i), spanEnd(spans, i));
    if (Number.isFinite(iv)) return iv;
    const fv = parseNastranFloatFromBytes(sourceBytes, spanStart(spans, i), spanEnd(spans, i));
    return Number.isFinite(fv) ? fv : NaN;
  };

  const areScratchNodesUnique = (count) => {
    const n = Math.max(0, Number(count) | 0);
    for (let i = 0; i < n; i++) {
      const a = directNodeScratch[i];
      for (let j = i + 1; j < n; j++) {
        if (a === directNodeScratch[j]) return false;
      }
    }
    return true;
  };

  const collectOptionalAllOrNoneNodesToScratch = (
    sourceBytes,
    spans,
    startIdx,
    count,
    scratchStart,
    cardName,
    source,
    baseDetails
  ) => {
    let nonBlank = 0;
    for (let i = 0; i < count; i++) {
      if (!spanIsBlank(spans, startIdx + i)) nonBlank++;
    }
    if (nonBlank !== 0 && nonBlank !== count) {
      emitDirectIssue(
        source,
        cardName,
        `${cardName}: optional nodes must be all-or-none`,
        { ...baseDetails, optionalNonBlank: nonBlank, optionalExpected: count }
      );
      return -1;
    }
    if (nonBlank === 0) return 0;
    for (let i = 0; i < count; i++) {
      const v = parseSpanIntField(sourceBytes, spans, startIdx + i);
      if (!Number.isFinite(v)) {
        emitDirectIssue(
          source,
          cardName,
          `${cardName}: invalid optional node field`,
          { ...baseDetails, fieldIndex: startIdx + i }
        );
        return -1;
      }
      directNodeScratch[scratchStart + i] = v;
    }
    return count;
  };

  const tryParseDirectSoaCard = (name, fmt, sourceBytes, lineInfos, source) => {
    const upper = toUpper(name);
    if (!DIRECT_CARD_NAME_SET.has(upper)) return null;
    const spans = collectCardDataSpans(fmt, sourceBytes, lineInfos, directSpanScratch);

    if (upper === 'GRID') {
      const nid = parseSpanIntField(sourceBytes, spans, 0);
      if (!Number.isFinite(nid) || nid < 1) {
        emitDirectIssue(source, upper, 'GRID: invalid NID (expected integer > 0)', { nid });
        return null;
      }
      let cp = parseSpanIntField(sourceBytes, spans, 1);
      if (!spanIsBlank(spans, 1) && !Number.isFinite(cp)) {
        emitDirectIssue(source, upper, 'GRID: invalid CP (expected integer >= 0 or blank)', { cp });
        return null;
      }
      if (Number.isFinite(cp) && cp < 0) {
        emitDirectIssue(source, upper, 'GRID: invalid CP (expected integer >= 0 or blank)', { cp });
        return null;
      }

      const x1 = parseSpanFloatField(sourceBytes, spans, 2);
      const x2 = parseSpanFloatField(sourceBytes, spans, 3);
      const x3 = parseSpanFloatField(sourceBytes, spans, 4);
      if (![x1, x2, x3].every((v) => Number.isFinite(v))) {
        emitDirectIssue(source, upper, 'GRID: invalid or blank XYZ', { x1, x2, x3 });
        return null;
      }

      let cd = parseSpanIntField(sourceBytes, spans, 5);
      if (!spanIsBlank(spans, 5) && !Number.isFinite(cd)) {
        emitDirectIssue(source, upper, 'GRID: invalid CD (expected integer >= -1 or blank)', { cd });
        return null;
      }
      if (Number.isFinite(cd) && cd < -1) {
        emitDirectIssue(source, upper, 'GRID: invalid CD (expected integer >= -1 or blank)', { cd });
        return null;
      }

      const psMask = parseGridPsMaskFromBytes(sourceBytes, spanStart(spans, 6), spanEnd(spans, 6));
      if (psMask < 0) {
        emitDirectIssue(source, upper, 'GRID: invalid PS (expected unique digits 1-6)', {});
        return null;
      }

      let seid = parseSpanIntField(sourceBytes, spans, 7);
      if (!spanIsBlank(spans, 7) && !Number.isFinite(seid)) {
        emitDirectIssue(source, upper, 'GRID: invalid SEID (expected integer >= 0 or blank)', { seid });
        return null;
      }
      if (Number.isFinite(seid) && seid < 0) {
        emitDirectIssue(source, upper, 'GRID: invalid SEID (expected integer >= 0 or blank)', { seid });
        return null;
      }

      const idx = pushDirectGrid(nid, cp, x1, x2, x3, cd, psMask, seid);
      return {
        directSoaKind: 'grid',
        directSoaIndex: idx,
        directCardId: nid
      };
    }

    const eid = parseSpanIntField(sourceBytes, spans, 0);
    const pidRaw = parseSpanIntField(sourceBytes, spans, 1);
    const pid = spanIsBlank(spans, 1) ? eid : pidRaw;
    if (![eid, pid].every((v) => Number.isFinite(v))) {
      emitDirectIssue(source, upper, `${upper}: invalid EID/PID`, { eid, pid });
      return null;
    }

    if (upper === 'CTRIA3') {
      const g1 = parseSpanIntField(sourceBytes, spans, 2);
      const g2 = parseSpanIntField(sourceBytes, spans, 3);
      const g3 = parseSpanIntField(sourceBytes, spans, 4);
      if (![g1, g2, g3].every((v) => Number.isFinite(v))) {
        emitDirectIssue(source, upper, 'CTRIA3: invalid required nodes', { eid });
        return null;
      }
      const thetaMcid = parseSpanThetaOrMcidField(sourceBytes, spans, 5);
      const zOffset = parseSpanFloatField(sourceBytes, spans, 6);
      const tflag = parseSpanIntField(sourceBytes, spans, 9);
      const t1 = parseSpanFloatField(sourceBytes, spans, 10);
      const t2 = parseSpanFloatField(sourceBytes, spans, 11);
      const t3 = parseSpanFloatField(sourceBytes, spans, 12);
      directNodeScratch[0] = g1;
      directNodeScratch[1] = g2;
      directNodeScratch[2] = g3;
      const idx = pushDirectElement(DIRECT_CARD_TYPE.CTRIA3, eid, pid, 3, {
        thetaMcid: Number.isFinite(thetaMcid) ? thetaMcid : null,
        zOffset: Number.isFinite(zOffset) ? zOffset : null,
        tflag: Number.isFinite(tflag) ? tflag : null,
        t1: Number.isFinite(t1) ? t1 : null,
        t2: Number.isFinite(t2) ? t2 : null,
        t3: Number.isFinite(t3) ? t3 : null
      });
      return { directSoaKind: 'element', directSoaIndex: idx, directCardId: eid };
    }

    if (upper === 'CQUAD4') {
      const g1 = parseSpanIntField(sourceBytes, spans, 2);
      const g2 = parseSpanIntField(sourceBytes, spans, 3);
      const g3 = parseSpanIntField(sourceBytes, spans, 4);
      const g4 = parseSpanIntField(sourceBytes, spans, 5);
      if (![g1, g2, g3, g4].every((v) => Number.isFinite(v))) {
        emitDirectIssue(source, upper, 'CQUAD4: invalid required nodes', { eid });
        return null;
      }
      const thetaMcid = parseSpanThetaOrMcidField(sourceBytes, spans, 6);
      const zOffset = parseSpanFloatField(sourceBytes, spans, 7);
      const tflag = parseSpanIntField(sourceBytes, spans, 9);
      const t1 = parseSpanFloatField(sourceBytes, spans, 10);
      const t2 = parseSpanFloatField(sourceBytes, spans, 11);
      const t3 = parseSpanFloatField(sourceBytes, spans, 12);
      const t4 = parseSpanFloatField(sourceBytes, spans, 13);
      directNodeScratch[0] = g1;
      directNodeScratch[1] = g2;
      directNodeScratch[2] = g3;
      directNodeScratch[3] = g4;
      const idx = pushDirectElement(DIRECT_CARD_TYPE.CQUAD4, eid, pid, 4, {
        thetaMcid: Number.isFinite(thetaMcid) ? thetaMcid : null,
        zOffset: Number.isFinite(zOffset) ? zOffset : null,
        tflag: Number.isFinite(tflag) ? tflag : null,
        t1: Number.isFinite(t1) ? t1 : null,
        t2: Number.isFinite(t2) ? t2 : null,
        t3: Number.isFinite(t3) ? t3 : null,
        t4: Number.isFinite(t4) ? t4 : null
      });
      return { directSoaKind: 'element', directSoaIndex: idx, directCardId: eid };
    }

    if (upper === 'CTETRA') {
      const n1 = parseSpanIntField(sourceBytes, spans, 2);
      const n2 = parseSpanIntField(sourceBytes, spans, 3);
      const n3 = parseSpanIntField(sourceBytes, spans, 4);
      const n4 = parseSpanIntField(sourceBytes, spans, 5);
      if (![n1, n2, n3, n4].every((v) => Number.isFinite(v))) {
        emitDirectIssue(source, upper, 'CTETRA: invalid required nodes', { eid });
        return null;
      }
      directNodeScratch[0] = n1;
      directNodeScratch[1] = n2;
      directNodeScratch[2] = n3;
      directNodeScratch[3] = n4;
      if (!areScratchNodesUnique(4)) {
        emitDirectIssue(source, upper, 'CTETRA: corner nodes N1-N4 must be unique', { eid });
        return null;
      }
      const optCount = collectOptionalAllOrNoneNodesToScratch(sourceBytes, spans, 6, 6, 4, upper, source, { eid });
      if (optCount < 0) return null;
      const idx = pushDirectElement(DIRECT_CARD_TYPE.CTETRA, eid, pid, 4 + optCount);
      return { directSoaKind: 'element', directSoaIndex: idx, directCardId: eid, boundaryCornerCount: 4 };
    }

    if (upper === 'CHEXA') {
      let valid = true;
      for (let i = 0; i < 8; i++) {
        const v = parseSpanIntField(sourceBytes, spans, 2 + i);
        if (!Number.isFinite(v)) {
          valid = false;
          break;
        }
        directNodeScratch[i] = v;
      }
      if (!valid) {
        emitDirectIssue(source, upper, 'CHEXA: invalid required corner nodes', { eid });
        return null;
      }
      if (!areScratchNodesUnique(8)) {
        emitDirectIssue(source, upper, 'CHEXA: corner nodes G1-G8 must be unique', { eid });
        return null;
      }
      const optCount = collectOptionalAllOrNoneNodesToScratch(sourceBytes, spans, 10, 12, 8, upper, source, { eid });
      if (optCount < 0) return null;
      const idx = pushDirectElement(DIRECT_CARD_TYPE.CHEXA, eid, pid, 8 + optCount);
      return { directSoaKind: 'element', directSoaIndex: idx, directCardId: eid, boundaryCornerCount: 8 };
    }

    if (upper === 'CPENTA') {
      let valid = true;
      for (let i = 0; i < 6; i++) {
        const v = parseSpanIntField(sourceBytes, spans, 2 + i);
        if (!Number.isFinite(v)) {
          valid = false;
          break;
        }
        directNodeScratch[i] = v;
      }
      if (!valid) {
        emitDirectIssue(source, upper, 'CPENTA: invalid required corner nodes', { eid });
        return null;
      }
      if (!areScratchNodesUnique(6)) {
        emitDirectIssue(source, upper, 'CPENTA: corner nodes G1-G6 must be unique', { eid });
        return null;
      }
      const optCount = collectOptionalAllOrNoneNodesToScratch(sourceBytes, spans, 8, 9, 6, upper, source, { eid });
      if (optCount < 0) return null;
      const idx = pushDirectElement(DIRECT_CARD_TYPE.CPENTA, eid, pid, 6 + optCount);
      return { directSoaKind: 'element', directSoaIndex: idx, directCardId: eid, boundaryCornerCount: 6 };
    }

    if (upper === 'CPYRAM') {
      let valid = true;
      for (let i = 0; i < 5; i++) {
        const v = parseSpanIntField(sourceBytes, spans, 2 + i);
        if (!Number.isFinite(v)) {
          valid = false;
          break;
        }
        directNodeScratch[i] = v;
      }
      if (!valid) {
        emitDirectIssue(source, upper, 'CPYRAM: invalid required corner nodes', { eid });
        return null;
      }
      if (!areScratchNodesUnique(5)) {
        emitDirectIssue(source, upper, 'CPYRAM: corner nodes G1-G5 must be unique', { eid });
        return null;
      }
      const optCount = collectOptionalAllOrNoneNodesToScratch(sourceBytes, spans, 7, 8, 5, upper, source, { eid });
      if (optCount < 0) return null;
      const idx = pushDirectElement(DIRECT_CARD_TYPE.CPYRAM, eid, pid, 5 + optCount);
      return { directSoaKind: 'element', directSoaIndex: idx, directCardId: eid, boundaryCornerCount: 5 };
    }

    return null;
  };

  // Track progress against discovered file sources as they are actually parsed.
  // This avoids eager decode/materialization of every VFS text before parse starts.
  let totalLines = 1;
  const countedLineFiles = new Set();

  let processedLines = 0;
  let lastProgressAt = Date.now();
  let lastProgressLines = 0;
  let lastProgressPercent = 0;

  function maybeProgress(message) {
    const now = Date.now();
    const timeDue = now - lastProgressAt >= yieldEveryMs;
    const linesDue = processedLines - lastProgressLines >= yieldEveryNLines;
    if (!timeDue && !linesDue) return false;
    const rawPercent = Math.max(0, Math.min(100, Math.floor((processedLines / totalLines) * 100)));
    const percent = Math.max(lastProgressPercent, rawPercent);
    post('PARSE_PROGRESS', { percent, message: message || 'parsing', processedLines, totalLines });
    lastProgressAt = now;
    lastProgressLines = processedLines;
    lastProgressPercent = percent;
    return true;
  }

  async function parseFileText(source, fileKey) {
    const sourceBytes = getSourceBytesForFile(fileKey, source);
    if (shouldStoreSourceFiles) sourceFiles[fileKey] = sourceBytes;
    if (!countedLineFiles.has(fileKey)) {
      totalLines += countPhysicalLinesFromBytes(sourceBytes);
      countedLineFiles.add(fileKey);
      if (totalLines <= 0) totalLines = 1;
    }

    const lines = createLazyByteLineView(sourceBytes);
    let inBulk = false;
    for (let i = 0;;) {
      if (lines && typeof lines.releaseBefore === 'function') lines.releaseBefore(i - 1);
      const lineInfo = lines.getLineInfo(i);
      if (!lineInfo) break;
      processedLines++;
      if (maybeProgress(`parsing ${fileKey}`)) await yieldToEventLoop();

      if (isBlankLineBytes(sourceBytes, lineInfo.startOffset, lineInfo.endOffset)) {
        if (retainParseSession) {
          cardStream.push({ kind: 'blank', source: { file: fileKey, line: lineInfo.lineNo } });
        }
        i++;
        continue;
      }
      if (isCommentLineBytes(sourceBytes, lineInfo.startOffset, lineInfo.endOffset)) {
        if (retainParseSession) {
          const line = decodeLineByInfo(sourceBytes, lineInfo);
          cardStream.push({ kind: 'comment', raw: line, source: { file: fileKey, line: lineInfo.lineNo } });
        }
        i++;
        continue;
      }

      if (isInBulkBeginLineBytes(sourceBytes, lineInfo.startOffset, lineInfo.endOffset)) inBulk = true;
      if (isEndDataLineBytes(sourceBytes, lineInfo.startOffset, lineInfo.endOffset)) inBulk = false;

      let includeStmt = null;
      if (isIncludeLineBytes(sourceBytes, lineInfo.startOffset, lineInfo.endOffset)) {
        includeStmt = readIncludeStatement(
          {
            getLineInfo: (idx) => getLineInfoWithText(lines, sourceBytes, idx)
          },
          i,
          fileKey,
          inBulk
        );
      }
      if (includeStmt) {
        const includeRawInfos = Array.isArray(includeStmt.rawLineInfos) && includeStmt.rawLineInfos.length
          ? includeStmt.rawLineInfos
          : [lineInfo];
        const includeRawLines = Array.isArray(includeStmt.rawLines) && includeStmt.rawLines.length
          ? includeStmt.rawLines.map((v) => String(v ?? ''))
          : includeRawInfos.map((info) => String(info && info.line != null ? info.line : ''));
        const includeLineNo = includeRawInfos[0].lineNo;

        // Count additional consumed lines for progress
        if (includeStmt.consumed > 1) {
          processedLines += includeStmt.consumed - 1;
          if (maybeProgress(`include ${fileKey}`)) await yieldToEventLoop();
        }

        const includePathRaw = parseIncludePathFromLine(includeRawLines[0]);
        const includePathRaw2 = includeStmt.includePathRaw;
        const pathRaw = includePathRaw2 != null ? includePathRaw2 : includePathRaw;
        if (exportMode !== 'flatten') {
          includeRecords.push({
            includingFileKey: fileKey,
            includingLine: includeLineNo,
            pathRaw: String(pathRaw ?? ''),
            status: 'preserved',
            resolvedKey: null,
            rawLines: includeRawLines
          });
          // Preserve-mode is deferred; keep INCLUDE as a card-like record for now.
          const includeRec = {
            kind: 'card',
            name: 'INCLUDE',
            fmt: 'free',
            source: { file: fileKey, line: includeLineNo }
          };
          if (needsLineStorage) Object.assign(includeRec, buildLineStorageFromInfos(sourceBytes, includeRawInfos, false));
          if (retainRawLines) includeRec.rawLines = includeRawLines;
          if (retainParseSession) cardStream.push(includeRec);
          i += includeStmt.consumed;
          continue;
        }

        const candidates = normalizeIncludePath(pathRaw, fileKey, strictMode, errors, warnings);
        if (!candidates) {
          includeRecords.push({
            includingFileKey: fileKey,
            includingLine: includeLineNo,
            pathRaw: String(pathRaw ?? ''),
            status: 'unresolved',
            resolvedKey: null,
            rawLines: includeRawLines
          });
          // Unresolved include disables flatten export; treat as error regardless of strictness.
          errors.push(
            makeIssue('INCLUDE_UNRESOLVED', `INCLUDE could not be resolved: '${String(includePathRaw)}'`, {
              source: { file: fileKey, line: includeLineNo },
              details: { includePathRaw: String(pathRaw) }
            })
          );
          i += includeStmt.consumed;
          continue;
        }

        const includeKey = resolveIncludeToVfsKey(candidates, vfsIndex);
        if (!includeKey) {
          includeRecords.push({
            includingFileKey: fileKey,
            includingLine: includeLineNo,
            pathRaw: String(pathRaw ?? ''),
            status: 'not_found',
            resolvedKey: null,
            rawLines: includeRawLines
          });
          errors.push(
            makeIssue('INCLUDE_NOT_FOUND', `INCLUDE target not found in VFS`, {
              source: { file: fileKey, line: includeLineNo },
              details: {
                includePathRaw: String(includePathRaw),
                relativeResolved: candidates.relativeResolved,
                rootResolved: candidates.rootResolved
              }
            })
          );
          i += includeStmt.consumed;
          continue;
        }

        if (includeStack.includes(includeKey)) {
          includeRecords.push({
            includingFileKey: fileKey,
            includingLine: includeLineNo,
            pathRaw: String(pathRaw ?? ''),
            status: 'cycle',
            resolvedKey: includeKey,
            rawLines: includeRawLines
          });
          errors.push(
            makeIssue('INCLUDE_CYCLE', `INCLUDE cycle detected: ${includeStack.join(' -> ')} -> ${includeKey}`, {
              source: { file: fileKey, line: includeLineNo },
              details: { stack: [...includeStack], includeKey }
            })
          );
          i += includeStmt.consumed;
          continue;
        }

        if (includeStack.length >= maxIncludeDepth) {
          includeRecords.push({
            includingFileKey: fileKey,
            includingLine: includeLineNo,
            pathRaw: String(pathRaw ?? ''),
            status: 'max_depth',
            resolvedKey: includeKey,
            rawLines: includeRawLines
          });
          errors.push(
            makeIssue('INCLUDE_MAX_DEPTH', `INCLUDE max depth exceeded (${maxIncludeDepth})`, {
              source: { file: fileKey, line: includeLineNo },
              details: { maxIncludeDepth, includeKey, stack: [...includeStack] }
            })
          );
          i += includeStmt.consumed;
          continue;
        }

        const includeText = Object.prototype.hasOwnProperty.call(files || {}, includeKey)
          ? files[includeKey]
          : '';
        includeRecords.push({
          includingFileKey: fileKey,
          includingLine: includeLineNo,
          pathRaw: String(pathRaw ?? ''),
          status: 'expanded',
          resolvedKey: includeKey,
          rawLines: includeRawLines
        });
        includeStack.push(includeKey);
        await parseFileText(includeText, includeKey);
        includeStack.pop();
        i += includeStmt.consumed;
        continue;
      }
      // Card (small/large/free)
      const fmt = detectFormatFromBytes(sourceBytes, lineInfo.startOffset, lineInfo.endOffset);
      const startLineNo = lineInfo.lineNo;
      const rawLineInfos = [lineInfo];
      i++;
      while (
        true
      ) {
        const nextInfo = lines.getLineInfo(i);
        if (!nextInfo) break;
        const explicitContinuation = isContinuationLineBytes(fmt, sourceBytes, nextInfo.startOffset, nextInfo.endOffset);
        let blankLeadingContinuation = false;
        if (!explicitContinuation && isBlankLeadingBytes(sourceBytes, nextInfo.startOffset, nextInfo.endOffset)) {
          const nextLine = decodeLineByInfo(sourceBytes, nextInfo);
          blankLeadingContinuation = isBlankLeadingContinuationAllowed(fmt, nextLine, inBulk);
        }
        if (!(explicitContinuation || blankLeadingContinuation)) break;
        rawLineInfos.push(nextInfo);
        i++;
        processedLines++;
        if (maybeProgress(`parsing ${fileKey}`)) await yieldToEventLoop();
      }

      // Fixed-field correctness checks (80-column semantics)
      if (fmt === 'small' || fmt === 'large') {
        for (let k = 0; k < rawLineInfos.length; k++) {
          const infoK = rawLineInfos[k];
          const physicalLineNo = infoK.lineNo;
          if (hasTabsBytes(sourceBytes, infoK.startOffset, infoK.endOffset)) {
            warnings.push(
              makeIssue('LINE_HAS_TABS', 'Line contains tab characters; fixed-field decks should be space-aligned', {
                source: { file: fileKey, line: physicalLineNo }
              })
            );
          }
          if (hasNonSpaceAfterColumn80Bytes(sourceBytes, infoK.startOffset, infoK.endOffset)) {
            const issue = makeIssue('LINE_OVER_80', 'Non-space content after column 80 in fixed-field format', {
              source: { file: fileKey, line: physicalLineNo },
              details: {
                tail: decodeUtf8Slice(
                  sourceBytes,
                  Math.max(0, Number(infoK.startOffset) + 80),
                  Number(infoK.endOffset)
                )
              }
            });
            (strictMode ? errors : warnings).push(issue);
          }
        }
      }

      let name = '';
      if (fmt === 'free') {
        name = getFreeFieldName(decodeLineByInfo(sourceBytes, rawLineInfos[0]));
      } else {
        // BEGIN BULK is a multi-word directive; do not truncate it to columns 1-8.
        if (isInBulkBeginLineBytes(sourceBytes, rawLineInfos[0].startOffset, rawLineInfos[0].endOffset)) name = 'BEGIN BULK';
        else name = getFixedFieldNameFromBytes(sourceBytes, rawLineInfos[0].startOffset, rawLineInfos[0].endOffset);
      }

      const sourceRef = { file: fileKey, line: startLineNo };
      const directParsed = tryParseDirectSoaCard(name, fmt, sourceBytes, rawLineInfos, sourceRef);
      if (directParsed) {
        if (solidFaceSet && Number.isFinite(Number(directParsed.boundaryCornerCount))) {
          const elemIdx = Number(directParsed.directSoaIndex) | 0;
          const cornerCount = Number(directParsed.boundaryCornerCount) | 0;
          const connStart = Number(directSoa.elemConnStart[elemIdx]) | 0;
          const conn = directSoa.elemConn;
          const eid = directSoa.elemEid[elemIdx] >>> 0;
          if (name === 'CTETRA' && cornerCount >= 4) {
            const n1 = conn[connStart + 0];
            const n2 = conn[connStart + 1];
            const n3 = conn[connStart + 2];
            const n4 = conn[connStart + 3];
            solidFaceSet.toggleTri(n1, n2, n3, eid);
            solidFaceSet.toggleTri(n1, n2, n4, eid);
            solidFaceSet.toggleTri(n1, n3, n4, eid);
            solidFaceSet.toggleTri(n2, n3, n4, eid);
          } else if (name === 'CHEXA' && cornerCount >= 8) {
            const g1 = conn[connStart + 0];
            const g2 = conn[connStart + 1];
            const g3 = conn[connStart + 2];
            const g4 = conn[connStart + 3];
            const g5 = conn[connStart + 4];
            const g6 = conn[connStart + 5];
            const g7 = conn[connStart + 6];
            const g8 = conn[connStart + 7];
            solidFaceSet.toggleQuad(g1, g2, g3, g4, eid);
            solidFaceSet.toggleQuad(g5, g6, g7, g8, eid);
            solidFaceSet.toggleQuad(g1, g2, g6, g5, eid);
            solidFaceSet.toggleQuad(g2, g3, g7, g6, eid);
            solidFaceSet.toggleQuad(g3, g4, g8, g7, eid);
            solidFaceSet.toggleQuad(g4, g1, g5, g8, eid);
          } else if (name === 'CPENTA' && cornerCount >= 6) {
            const g1 = conn[connStart + 0];
            const g2 = conn[connStart + 1];
            const g3 = conn[connStart + 2];
            const g4 = conn[connStart + 3];
            const g5 = conn[connStart + 4];
            const g6 = conn[connStart + 5];
            solidFaceSet.toggleTri(g1, g2, g3, eid);
            solidFaceSet.toggleTri(g4, g5, g6, eid);
            solidFaceSet.toggleQuad(g1, g2, g5, g4, eid);
            solidFaceSet.toggleQuad(g2, g3, g6, g5, eid);
            solidFaceSet.toggleQuad(g3, g1, g4, g6, eid);
          } else if (name === 'CPYRAM' && cornerCount >= 5) {
            const g1 = conn[connStart + 0];
            const g2 = conn[connStart + 1];
            const g3 = conn[connStart + 2];
            const g4 = conn[connStart + 3];
            const g5 = conn[connStart + 4];
            solidFaceSet.toggleQuad(g1, g2, g3, g4, eid);
            solidFaceSet.toggleTri(g1, g2, g5, eid);
            solidFaceSet.toggleTri(g2, g3, g5, eid);
            solidFaceSet.toggleTri(g3, g4, g5, eid);
            solidFaceSet.toggleTri(g4, g1, g5, eid);
          }
        }

        if (retainParseSession) {
          const tokenized = tokenizeCardLineInfos(fmt, sourceBytes, rawLineInfos, name);
          cardStream.push({
            kind: 'card',
            name,
            fmt,
            tokens: Array.isArray(tokenized && tokenized.tokens) ? tokenized.tokens.slice() : [],
            tokensHydrationReady: true,
            directSoaKind: directParsed.directSoaKind,
            directSoaIndex: directParsed.directSoaIndex,
            directCardId: Number.isFinite(directParsed.directCardId) ? Number(directParsed.directCardId) : null,
            source: { file: fileKey, line: rawLineInfos[0] ? rawLineInfos[0].lineNo : lineInfo.lineNo }
          });
        }
        continue;
      }

      const tokenized = tokenizeCardLineInfos(fmt, sourceBytes, rawLineInfos, name);

      // Solid boundary extraction (corner nodes only).
      if (solidFaceSet && (name === 'CTETRA' || name === 'CHEXA' || name === 'CPENTA' || name === 'CPYRAM')) {
        const r = parseSolidCornerNodesFromTokens(name, tokenized.tokens);
        if (r && r.nodes) {
          const eid = r.eid >>> 0;
          const n = r.nodes;
          if (name === 'CTETRA' && n.length >= 4) {
            const n1 = n[0], n2 = n[1], n3 = n[2], n4 = n[3];
            solidFaceSet.toggleTri(n1, n2, n3, eid);
            solidFaceSet.toggleTri(n1, n2, n4, eid);
            solidFaceSet.toggleTri(n1, n3, n4, eid);
            solidFaceSet.toggleTri(n2, n3, n4, eid);
          } else if (name === 'CHEXA' && n.length >= 8) {
            const g1 = n[0], g2 = n[1], g3 = n[2], g4 = n[3], g5 = n[4], g6 = n[5], g7 = n[6], g8 = n[7];
            solidFaceSet.toggleQuad(g1, g2, g3, g4, eid);
            solidFaceSet.toggleQuad(g5, g6, g7, g8, eid);
            solidFaceSet.toggleQuad(g1, g2, g6, g5, eid);
            solidFaceSet.toggleQuad(g2, g3, g7, g6, eid);
            solidFaceSet.toggleQuad(g3, g4, g8, g7, eid);
            solidFaceSet.toggleQuad(g4, g1, g5, g8, eid);
          } else if (name === 'CPENTA' && n.length >= 6) {
            const g1 = n[0], g2 = n[1], g3 = n[2], g4 = n[3], g5 = n[4], g6 = n[5];
            solidFaceSet.toggleTri(g1, g2, g3, eid);
            solidFaceSet.toggleTri(g4, g5, g6, eid);
            solidFaceSet.toggleQuad(g1, g2, g5, g4, eid);
            solidFaceSet.toggleQuad(g2, g3, g6, g5, eid);
            solidFaceSet.toggleQuad(g3, g1, g4, g6, eid);
          } else if (name === 'CPYRAM' && n.length >= 5) {
            const g1 = n[0], g2 = n[1], g3 = n[2], g4 = n[3], g5 = n[4];
            solidFaceSet.toggleQuad(g1, g2, g3, g4, eid);
            solidFaceSet.toggleTri(g1, g2, g5, eid);
            solidFaceSet.toggleTri(g2, g3, g5, eid);
            solidFaceSet.toggleTri(g3, g4, g5, eid);
            solidFaceSet.toggleTri(g4, g1, g5, eid);
          }
        }
      }

      const includeFirstLine = (!needsLineStorage) && name === 'GRID' && (fmt === 'small' || fmt === 'large');
      const cardRecord = {
        kind: 'card',
        name,
        fmt,
        tokens: tokenized.tokens,
        tokensHydrationReady: true,
        source: sourceRef
      };
      if (includeFirstLine || needsLineStorage) {
        Object.assign(cardRecord, buildLineStorageFromInfos(sourceBytes, rawLineInfos, includeFirstLine));
      }
      if (tokenized.lineTokens) cardRecord.lineTokens = tokenized.lineTokens;
      if (tokenized.lineSlices) cardRecord.lineSlices = tokenized.lineSlices;
      cardStream.push(cardRecord);
    }
  }

  const effectiveEntryKey = String(entryFileKey || 'main.bdf');
  beginPhase('tokenize', { entryFileKey: effectiveEntryKey });
  await parseFileText(entryText, effectiveEntryKey);
  const directCardCount = Number(directSoa.gridCount || 0) + Number(directSoa.elemCount || 0);
  const semanticCardCount = retainParseSession ? cardStream.length : (cardStream.length + directCardCount);
  endPhase('tokenize', {
    cardCount: semanticCardCount,
    includeCount: includeRecords.length
  });

  const enforcedCardStream = applyTier1Enforcement(cardStream, strictMode, enforceTier1, options, errors, warnings);
  if (enforcedCardStream !== cardStream) {
    cardStream.length = 0;
    cardStream.push(...enforcedCardStream);
  }

  // Optional: attach per-card schema definitions so hydrateIndexes can produce
  // schema-driven hydrated objects without requiring bespoke hydrators.
  const schema = parseSchemaFromOptions(options);
  if (schema) {
    const enableSchemaHydration = !!(options && options.hydrateBySchema);
    for (const rec of cardStream) {
      if (!rec || rec.kind !== 'card') continue;
      const def = getCardDefFromSchema(schema, rec.name);
      if (def && Array.isArray(def.fields) && def.fields.length > 0) {
        rec.schemaDef = def;
        rec.enableSchemaHydration = enableSchemaHydration;
      }
    }
  }

  beginPhase('hydrate_indexes', { cardCount: cardStream.length });
  const indexes = hydrateIndexes(cardStream, strictMode, errors, warnings, directSoa, {
    skipDirectElementHydration
  });
  const hydratedNodeCount = indexes && indexes.nodes ? indexes.nodes.size : 0;
  const hydratedElementCount = (indexes && indexes.elements ? indexes.elements.size : 0)
    + (skipDirectElementHydration ? (Number(directSoa.elemCount) | 0) : 0);
  endPhase('hydrate_indexes', {
    nodeCount: hydratedNodeCount,
    elementCount: hydratedElementCount
  });
  indexes.includes = includeRecords;

  // Finalize CTETRA boundary surface (transferable typed array of node-id triplets).
  /** @type {any} */
  const surfaces = {};
  let surfaceTransfers = [];
  let coreTransfers = [];
  let coreModelTransfer = null;
  const forceCorePayload = true;
  const enableCoreTransfer = true;
  const buildCoreModelTransfer = () => {
    const nodeMap = indexes && indexes.nodes && typeof indexes.nodes.entries === 'function' ? indexes.nodes : null;
    const elemMap = indexes && indexes.elements && typeof indexes.elements.entries === 'function' ? indexes.elements : null;
    const coordMap = indexes && indexes.coords && typeof indexes.coords.entries === 'function' ? indexes.coords : null;
    const loadMap = indexes && indexes.loads && typeof indexes.loads.entries === 'function' ? indexes.loads : null;
    const constraintMap = indexes && indexes.constraints && typeof indexes.constraints.entries === 'function' ? indexes.constraints : null;
    const propertyMap = indexes && indexes.properties && typeof indexes.properties.entries === 'function' ? indexes.properties : null;
    const materialMap = indexes && indexes.materials && typeof indexes.materials.entries === 'function' ? indexes.materials : null;
    const massMap = indexes && indexes.masses && typeof indexes.masses.entries === 'function' ? indexes.masses : null;
    const nodeCount = nodeMap ? nodeMap.size : 0;

    const nodeIds = new Int32Array(nodeCount);
    const nodeCp = new Int32Array(nodeCount);
    const nodeCd = new Int32Array(nodeCount);
    const nodePosGlobal = new Float64Array(nodeCount * 3);
    const nodePosGlobal32 = new Float32Array(nodeCount * 3);
    const nodePos = new Float64Array(nodeCount * 3);
    const nodePos32 = new Float32Array(nodeCount * 3);
    const nidToIndex = new Map();
    let ni = 0;
    if (nodeMap) {
      for (const [nidRaw, node] of nodeMap.entries()) {
        const nid = Number(nidRaw);
        const cp = Number(node && node.cp);
        const cd = Number(node && node.cd);
        const xyz = (Array.isArray(node && node.xLocal) && node.xLocal.length >= 3)
          ? node.xLocal
          : (Array.isArray(node && node.x) && node.x.length >= 3 ? node.x : null);
        const xyzGlobal = (Array.isArray(node && node.x) && node.x.length >= 3)
          ? node.x
          : xyz;
        const x = xyz ? Number(xyz[0]) : NaN;
        const y = xyz ? Number(xyz[1]) : NaN;
        const z = xyz ? Number(xyz[2]) : NaN;
        const gx = xyzGlobal ? Number(xyzGlobal[0]) : NaN;
        const gy = xyzGlobal ? Number(xyzGlobal[1]) : NaN;
        const gz = xyzGlobal ? Number(xyzGlobal[2]) : NaN;
        nodeIds[ni] = Number.isFinite(nid) ? (nid | 0) : 0;
        nodeCp[ni] = Number.isFinite(cp) ? (cp | 0) : 0;
        nodeCd[ni] = Number.isFinite(cd) ? (cd | 0) : 0;
        const px = Number.isFinite(x) ? x : 0;
        const py = Number.isFinite(y) ? y : 0;
        const pz = Number.isFinite(z) ? z : 0;
        const pgx = Number.isFinite(gx) ? gx : px;
        const pgy = Number.isFinite(gy) ? gy : py;
        const pgz = Number.isFinite(gz) ? gz : pz;
        nodePos[ni * 3] = px;
        nodePos[ni * 3 + 1] = py;
        nodePos[ni * 3 + 2] = pz;
        nodePos32[ni * 3] = px;
        nodePos32[ni * 3 + 1] = py;
        nodePos32[ni * 3 + 2] = pz;
        nodePosGlobal[ni * 3] = pgx;
        nodePosGlobal[ni * 3 + 1] = pgy;
        nodePosGlobal[ni * 3 + 2] = pgz;
        nodePosGlobal32[ni * 3] = pgx;
        nodePosGlobal32[ni * 3 + 1] = pgy;
        nodePosGlobal32[ni * 3 + 2] = pgz;
        if (Number.isFinite(nid)) nidToIndex.set(nid | 0, ni | 0);
        ni++;
      }
    }

    const directElemCount = (skipDirectElementHydration && directSoa && typeof directSoa === 'object')
      ? (Number(directSoa.elemCount) | 0)
      : 0;
    const mapElemCount = elemMap ? elemMap.size : 0;
    const totalElemCount = directElemCount + mapElemCount;

    const extractElementRawNodes = (elem) => {
      if (Array.isArray(elem && elem.nids)) return elem.nids;
      if (Array.isArray(elem && elem.n)) return elem.n;
      const type = String(elem && elem.type ? elem.type : '').toUpperCase();
      if (type === 'RBE2') {
        const gn = Number(elem && elem.gn);
        const deps = Array.isArray(elem && elem.gmi)
          ? elem.gmi
          : (Array.isArray(elem && elem.deps) ? elem.deps : []);
        return Number.isFinite(gn) ? [gn, ...deps] : deps;
      }
      if (type === 'RBE3') {
        const refgrid = Number(elem && elem.refgrid);
        const inds = [];
        if (Array.isArray(elem && elem.inds)) {
          inds.push(...elem.inds);
        } else if (Array.isArray(elem && elem.groups)) {
          for (const group of elem.groups) {
            if (!group || !Array.isArray(group.gids)) continue;
            inds.push(...group.gids);
          }
        }
        return Number.isFinite(refgrid) ? [refgrid, ...inds] : inds;
      }
      if (Number.isFinite(Number(elem && elem.gn))) {
        const gn = Number(elem.gn);
        const deps = Array.isArray(elem && elem.deps)
          ? elem.deps
          : (Array.isArray(elem && elem.inds) ? elem.inds : []);
        return [gn, ...deps];
      }
      return [];
    };

    const mapDirectTypeToCoreType = (directTypeCode) => {
      switch (Number(directTypeCode) | 0) {
        case DIRECT_CARD_TYPE.CTRIA3: return CORE_ELEM_TYPE_CODES.CTRIA3;
        case DIRECT_CARD_TYPE.CQUAD4: return CORE_ELEM_TYPE_CODES.CQUAD4;
        case DIRECT_CARD_TYPE.CTETRA: return CORE_ELEM_TYPE_CODES.CTETRA;
        case DIRECT_CARD_TYPE.CHEXA: return CORE_ELEM_TYPE_CODES.CHEXA;
        case DIRECT_CARD_TYPE.CPENTA: return CORE_ELEM_TYPE_CODES.CPENTA;
        case DIRECT_CARD_TYPE.CPYRAM: return CORE_ELEM_TYPE_CODES.CPYRAM;
        default: return CORE_ELEM_TYPE_CODES.UNKNOWN;
      }
    };

    let mapNodeRefUpperBound = 0;
    if (elemMap) {
      for (const [, elem] of elemMap.entries()) {
        mapNodeRefUpperBound += extractElementRawNodes(elem).length;
      }
    }
    const directNodeRefUpperBound = directElemCount > 0 ? (Number(directSoa.elemConnUsed) | 0) : 0;
    const elemNodeCapacity = Math.max(0, directNodeRefUpperBound + mapNodeRefUpperBound);

    const elemIds = new Int32Array(totalElemCount);
    const elemPid = new Int32Array(totalElemCount);
    const elemTypeCode = new Int16Array(totalElemCount);
    const elemNodeOffsets = new Int32Array(totalElemCount + 1);
    const elemNodeIdsBuffer = new Int32Array(elemNodeCapacity);
    let elemNodeWrite = 0;
    let ei = 0;

    if (directElemCount > 0) {
      const directConn = directSoa.elemConn;
      const directConnUsed = Number(directSoa.elemConnUsed) | 0;
      for (let di = 0; di < directElemCount; di++) {
        const eid = Number(directSoa.elemEid[di]);
        const pid = Number(directSoa.elemPid[di]);
        const typeCode = mapDirectTypeToCoreType(directSoa.elemType[di]);
        const connStart = Number(directSoa.elemConnStart[di]) | 0;
        const connCount = Number(directSoa.elemConnCount[di]) | 0;
        const connEnd = Math.max(connStart, Math.min(directConnUsed, connStart + connCount));

        elemIds[ei] = Number.isFinite(eid) ? (eid | 0) : 0;
        elemPid[ei] = Number.isFinite(pid) ? (pid | 0) : 0;
        elemTypeCode[ei] = Number.isFinite(typeCode) ? typeCode : CORE_ELEM_TYPE_CODES.UNKNOWN;
        elemNodeOffsets[ei] = elemNodeWrite;

        for (let k = connStart; k < connEnd; k++) {
          const nid = Number(directConn[k]);
          if (!Number.isFinite(nid)) continue;
          const nodeIndex = nidToIndex.get(nid | 0);
          if (!Number.isFinite(nodeIndex)) continue;
          if (elemNodeWrite >= elemNodeIdsBuffer.length) break;
          elemNodeIdsBuffer[elemNodeWrite++] = nodeIndex | 0;
        }
        ei++;
      }
    }

    if (elemMap) {
      for (const [eidRaw, elem] of elemMap.entries()) {
        const eid = Number(eidRaw);
        const pid = Number(elem && elem.pid);
        const typeCode = coreElemTypeCodeFor(elem && elem.type);
        elemIds[ei] = Number.isFinite(eid) ? (eid | 0) : 0;
        elemPid[ei] = Number.isFinite(pid) ? (pid | 0) : 0;
        elemTypeCode[ei] = Number.isFinite(typeCode) ? typeCode : 0;
        elemNodeOffsets[ei] = elemNodeWrite;
        const rawNodes = extractElementRawNodes(elem);
        for (const nidRaw of rawNodes) {
          const nid = Number(nidRaw);
          if (!Number.isFinite(nid)) continue;
          const nodeIndex = nidToIndex.get(nid | 0);
          if (!Number.isFinite(nodeIndex)) continue;
          if (elemNodeWrite >= elemNodeIdsBuffer.length) break;
          elemNodeIdsBuffer[elemNodeWrite++] = nodeIndex | 0;
        }
        ei++;
      }
    }
    elemNodeOffsets[totalElemCount] = elemNodeWrite;
    const elemNodeIds = (elemNodeWrite === elemNodeIdsBuffer.length)
      ? elemNodeIdsBuffer
      : elemNodeIdsBuffer.slice(0, elemNodeWrite);

    const coordCards = [];
    if (coordMap) {
      for (const [cidRaw, coord] of coordMap.entries()) {
        const cid = Number(cidRaw);
        if (!Number.isFinite(cid) || !coord) continue;
        const type = String(coord.type || '').toUpperCase();
        const rid = Number(coord.rid);
        if (Array.isArray(coord.nodes) && coord.nodes.length >= 3) {
          coordCards.push({
            cid: cid | 0,
            type: type || 'CORD1R',
            rid: Number.isFinite(rid) ? (rid | 0) : 0,
            nodes: coord.nodes.map((n) => Number(n)).filter((n) => Number.isFinite(n)).map((n) => n | 0)
          });
          continue;
        }
        const origin = Array.isArray(coord.origin) ? coord.origin : null;
        const pointB = Array.isArray(coord.pointB) ? coord.pointB : null;
        const pointC = Array.isArray(coord.pointC) ? coord.pointC : null;
        if (origin && pointB && pointC) {
          coordCards.push({
            cid: cid | 0,
            type: type || 'CORD2R',
            rid: Number.isFinite(rid) ? (rid | 0) : 0,
            origin: [Number(origin[0]) || 0, Number(origin[1]) || 0, Number(origin[2]) || 0],
            pointB: [Number(pointB[0]) || 0, Number(pointB[1]) || 0, Number(pointB[2]) || 0],
            pointC: [Number(pointC[0]) || 0, Number(pointC[1]) || 0, Number(pointC[2]) || 0]
          });
        }
      }
    }

    const properties = [];
    if (propertyMap) {
      for (const [, prop] of propertyMap.entries()) {
        if (!prop || typeof prop !== 'object') continue;
        properties.push({ ...prop });
      }
    }
    const materials = [];
    if (materialMap) {
      for (const [, mat] of materialMap.entries()) {
        if (!mat || typeof mat !== 'object') continue;
        materials.push({ ...mat });
      }
    }
    const masses = [];
    if (massMap) {
      for (const [, mass] of massMap.entries()) {
        if (!mass || typeof mass !== 'object') continue;
        masses.push({ ...mass });
      }
    }

    const directElemIndexByEid = new Map();
    const buildDirectElemIndexByEid = () => {
      if (!skipDirectElementHydration || !directSoa || typeof directSoa !== 'object') return;
      if (directElemIndexByEid.size > 0) return;
      const directCount = Number(directSoa.elemCount) | 0;
      for (let i = 0; i < directCount; i++) {
        const eid = Number(directSoa.elemEid[i]);
        if (!Number.isFinite(eid)) continue;
        directElemIndexByEid.set(eid | 0, i | 0);
      }
    };

    const getElementNodeNidsByEid = (eidRaw) => {
      const eid = Number(eidRaw);
      if (!Number.isFinite(eid)) return [];
      if (elemMap && typeof elemMap.get === 'function') {
        const elem = elemMap.get(eid);
        if (elem) {
          const rawNodes = extractElementRawNodes(elem);
          return rawNodes.map((n) => Number(n)).filter((n) => Number.isFinite(n)).map((n) => n | 0);
        }
      }
      buildDirectElemIndexByEid();
      if (directElemIndexByEid.has(eid | 0) && directSoa && typeof directSoa === 'object') {
        const idx = directElemIndexByEid.get(eid | 0) | 0;
        const connStart = Number(directSoa.elemConnStart[idx]) | 0;
        const connCount = Number(directSoa.elemConnCount[idx]) | 0;
        const connEnd = Math.max(connStart, Math.min(Number(directSoa.elemConnUsed) | 0, connStart + connCount));
        const out = [];
        for (let k = connStart; k < connEnd; k++) {
          const nid = Number(directSoa.elemConn[k]);
          if (!Number.isFinite(nid)) continue;
          out.push(nid | 0);
        }
        return out;
      }
      return [];
    };

    const dedupeNids = (arr) => {
      if (!Array.isArray(arr) || arr.length <= 1) return Array.isArray(arr) ? arr : [];
      const seen = new Set();
      const out = [];
      for (const n of arr) {
        const nid = Number(n);
        if (!Number.isFinite(nid)) continue;
        const key = nid | 0;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
      }
      return out;
    };

    const forceLoads = [];
    const momentLoads = [];
    const ploadLoads = [];
    const combinationLoads = [];
    if (loadMap) {
      for (const [sidRaw, arr] of loadMap.entries()) {
        const sid = Number(sidRaw);
        const sidValue = Number.isFinite(sid) ? (sid | 0) : 0;
        if (!Array.isArray(arr)) continue;
        for (const rec of arr) {
          const type = String(rec && rec.type ? rec.type : '').toUpperCase();
          if (type === 'FORCE') {
            const nid = Number(rec && rec.g);
            const dir = Array.isArray(rec && rec.n) ? rec.n : [0, 0, 0];
            forceLoads.push({
              type: 'FORCE',
              sid: sidValue,
              nid: Number.isFinite(nid) ? (nid | 0) : 0,
              cid: Number.isFinite(Number(rec && rec.cid)) ? (Number(rec.cid) | 0) : 0,
              mag: Number.isFinite(Number(rec && rec.f)) ? Number(rec.f) : 0,
              dir: [Number(dir[0]) || 0, Number(dir[1]) || 0, Number(dir[2]) || 0]
            });
            continue;
          }
          if (type === 'MOMENT') {
            const nid = Number(rec && rec.g);
            const dir = Array.isArray(rec && rec.n) ? rec.n : [0, 0, 0];
            momentLoads.push({
              type: 'MOMENT',
              sid: sidValue,
              nid: Number.isFinite(nid) ? (nid | 0) : 0,
              cid: Number.isFinite(Number(rec && rec.cid)) ? (Number(rec.cid) | 0) : 0,
              mag: Number.isFinite(Number(rec && rec.m)) ? Number(rec.m) : 0,
              dir: [Number(dir[0]) || 0, Number(dir[1]) || 0, Number(dir[2]) || 0]
            });
            continue;
          }
          if (type === 'PLOAD2' || type === 'PLOAD4') {
            const eids = Array.isArray(rec && rec.eids)
              ? rec.eids.map((e) => Number(e)).filter((e) => Number.isFinite(e)).map((e) => e | 0)
              : (Number.isFinite(Number(rec && rec.eid)) ? [Number(rec.eid) | 0] : []);
            const nodes = [];
            for (const eid of eids) {
              const elemNodes = getElementNodeNidsByEid(eid);
              if (elemNodes.length) nodes.push(...elemNodes);
            }
            ploadLoads.push({
              type: type,
              sid: sidValue,
              eids,
              nodes: dedupeNids(nodes),
              p: Array.isArray(rec && rec.p)
                ? rec.p.map((v) => Number(v)).filter((v) => Number.isFinite(v))
                : (Number.isFinite(Number(rec && rec.p)) ? Number(rec.p) : 0),
              g1: Number.isFinite(Number(rec && rec.g1)) ? (Number(rec.g1) | 0) : null,
              g34: Number.isFinite(Number(rec && rec.g34)) ? (Number(rec.g34) | 0) : null
            });
            continue;
          }
          if (type === 'LOAD') {
            const entries = Array.isArray(rec && rec.entries)
              ? rec.entries
                .map((ent) => ({
                  lid: Number.isFinite(Number(ent && ent.lid)) ? (Number(ent.lid) | 0) : 0,
                  scale: Number.isFinite(Number(ent && ent.scale)) ? Number(ent.scale) : 0
                }))
              : [];
            combinationLoads.push({
              type: 'LOAD',
              sid: sidValue,
              scale: Number.isFinite(Number(rec && rec.scale)) ? Number(rec.scale) : 0,
              entries
            });
          }
        }
      }
    }

    const spc = [];
    const spc1Map = new Map();
    if (constraintMap) {
      for (const [sidRaw, arr] of constraintMap.entries()) {
        const sid = Number(sidRaw);
        const sidValue = Number.isFinite(sid) ? (sid | 0) : 0;
        if (!Array.isArray(arr)) continue;
        for (const rec of arr) {
          const type = String(rec && rec.type ? rec.type : '').toUpperCase();
          if (type === 'SPC') {
            const nid = Number(rec && rec.g);
            spc.push({
              type: 'SPC',
              sid: sidValue,
              g: Number.isFinite(nid) ? (nid | 0) : 0,
              c: String(rec && rec.c != null ? rec.c : '').trim(),
              d: Number.isFinite(Number(rec && rec.d)) ? Number(rec.d) : 0
            });
            continue;
          }
          if (type === 'SPC1') {
            const components = String(rec && rec.components != null ? rec.components : '').trim();
            const key = `${sidValue}:${components}`;
            const current = spc1Map.get(key) || { type: 'SPC1', sid: sidValue, components, nodes: [] };
            const nodes = Array.isArray(rec && rec.nodes)
              ? rec.nodes.map((n) => Number(n)).filter((n) => Number.isFinite(n)).map((n) => n | 0)
              : [];
            if (nodes.length) current.nodes.push(...nodes);
            spc1Map.set(key, current);
          }
        }
      }
    }
    const spc1 = Array.from(spc1Map.values()).map((grp) => ({
      ...grp,
      nodes: dedupeNids(grp.nodes)
    }));

    const temperatures = indexes && indexes.temperatures instanceof Map
      ? Array.from(indexes.temperatures.values(), (set) => ({
        sid: set.sid,
        defaultTemperature: set.defaultTemperature,
        nodeIds: Array.from(set.nodalValues.keys()),
        values: Array.from(set.nodalValues.values())
      })).sort((a, b) => a.sid - b.sid)
      : [];

    const snapshot = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      counts: {
        nodes: nodeCount,
        elements: totalElemCount,
        elementNodeRefs: elemNodeIds.length
      },
      nodeIds,
      nodeCp,
      nodeCd,
      nodePosGlobal,
      nodePosGlobal32,
      nodePos,
      nodePos32,
      elemIds,
      elemPid,
      elemTypeCode,
      elemNodeOffsets,
      elemNodeIds,
      loads: {
        force: forceLoads,
        moment: momentLoads,
        pload: ploadLoads,
        combination: combinationLoads
      },
      constraints: {
        spc,
        spc1
      },
      coords: coordCards,
      properties,
      materials,
      masses,
      temperatures,
      elemTypeCodes: CORE_ELEM_TYPE_CODES
    };
    const transfers = [
      nodeIds.buffer,
      nodeCp.buffer,
      nodeCd.buffer,
      nodePosGlobal.buffer,
      nodePosGlobal32.buffer,
      nodePos.buffer,
      nodePos32.buffer,
      elemIds.buffer,
      elemPid.buffer,
      elemTypeCode.buffer,
      elemNodeOffsets.buffer,
      elemNodeIds.buffer
    ];
    return { snapshot, transfers };
  };
  beginPhase('transfer_prepare');
  if (solidFaceSet) {
    const faces = solidFaceSet.toFaces();
    surfaces.solidBoundaryFaces = faces;
    surfaceTransfers = [faces.buffer];
    const chunkManifest = buildSolidBoundaryChunkManifest(
      faces,
      indexes && indexes.nodes && typeof indexes.nodes.get === 'function' ? indexes.nodes : null,
      8
    );
    if (chunkManifest && chunkManifest.manifest) {
      surfaces.solidBoundaryChunkManifest = chunkManifest.manifest;
      if (Array.isArray(chunkManifest.transfers) && chunkManifest.transfers.length) {
        surfaceTransfers.push(...chunkManifest.transfers);
      }
    }
  }
  if (enableCoreTransfer) {
    const core = buildCoreModelTransfer();
    coreModelTransfer = core.snapshot;
    coreTransfers = core.transfers;
  }
  if (forceCorePayload && !coreModelTransfer) {
    throw new Error('CORE_PAYLOAD_MODE_FAILED: core transferable snapshot was not produced.');
  }
  const allTransfers = [...surfaceTransfers, ...coreTransfers];
  endPhase('transfer_prepare', {
    transferBytes: allTransfers.reduce((sum, b) => sum + (b && b.byteLength ? b.byteLength : 0), 0)
  });

  const sourceSessionId = retainSourceSession ? nextSourceSessionId() : '';
  if (retainSourceSession) storeSourceSession(sourceSessionId, sourceFiles);
  const parseSessionId = retainParseSession ? nextParseSessionId() : '';
  if (retainParseSession) {
    storeParseSession(parseSessionId, {
      cardStream,
      indexes,
      sourceSessionId
    });
  }
  const modelPayload = {
    payloadMode: 'core_soa_only',
    parseSessionId,
    sourceSessionId,
    summary: {
      cardCount: semanticCardCount,
      nodeCount: indexes && indexes.nodes ? indexes.nodes.size : 0,
      elementCount: coreModelTransfer && coreModelTransfer.counts
        ? (Number(coreModelTransfer.counts.elements) | 0)
        : ((indexes && indexes.elements ? indexes.elements.size : 0)
          + (skipDirectElementHydration ? (Number(directSoa.elemCount) | 0) : 0))
    },
    warnings: [...warnings],
    tainted: warnings.length > 0,
    errors: [...errors]
  };
  if (includeSourceFilesInModel) modelPayload.sourceFiles = sourceFiles;

  return {
    model: modelPayload,
    surfaces,
    transferables: {
      coreModel: coreModelTransfer
    },
    _transfer: allTransfers,
    stats: {
      lines: countPhysicalLinesFromBytes(getSourceBytesForFile(effectiveEntryKey, entryText)),
      vfsFiles: files && typeof files === 'object' ? Object.keys(files).length : 0,
      exportMode,
      strictMode,
      payloadMode: 'core_soa_only',
      phaseDurationsMs,
      phaseTimeline
    },
    errors,
    warnings
  };
}

/** @param {WorkerMessage} msg */
function handleParseRequest(msg) {
  const text = Object.prototype.hasOwnProperty.call(msg || {}, 'textBytes') ? msg.textBytes : msg.text;
  const files = (msg && msg.files && typeof msg.files === 'object') ? { ...msg.files } : {};
  const filesBytes = (msg && msg.filesBytes && typeof msg.filesBytes === 'object') ? msg.filesBytes : null;
  if (filesBytes) {
    for (const k of Object.keys(filesBytes)) {
      if (Object.prototype.hasOwnProperty.call(files, k)) continue;
      files[k] = filesBytes[k];
    }
  }
  const options = msg.options ?? {};
  const perfRunId = msg && msg.perfRunId != null ? String(msg.perfRunId) : null;
  const parseOptions = perfRunId ? { ...options, perfRunId } : options;

  const entryFileKey = msg.entryFileKey ?? 'main.bdf';
  parseDeckToCardStream(text, entryFileKey, files, parseOptions)
    .then((result) => {
      const payload = {
        ...result,
        stats: {
          ...result.stats,
          options
        }
      };
      const transfers = Array.isArray(result && result._transfer) ? result._transfer : [];
      if (transfers && transfers.length) postWithTransfer('PARSE_COMPLETE', payload, transfers);
      else post('PARSE_COMPLETE', payload);
    })
    .catch((err) => {
      post('WORKER_ERROR', { error: asError(err) });
    });
}

/** @param {WorkerMessage} msg */
function handleWriteRequest(msg) {
  const options = msg && msg.options ? msg.options : {};
  const excludedElements = new Set(options.excludeElements || []);
  const normalizeWriteFormat = (v) => {
    const s = String(v ?? '').trim().toLowerCase();
    if (!s) return 'source';
    if (s === 'source' || s === 'asis' || s === 'as-is' || s === 'original') return 'source';
    if (s === 'short' || s === 'small' || s === '8') return 'small';
    if (s === 'long' || s === 'large' || s === '16') return 'large';
    if (s === 'comma' || s === 'free' || s === 'csv') return 'free';
    return 'source';
  };
  const writeFormat = normalizeWriteFormat(options.writeFormat ?? options.exportFormat ?? options.format);
  const strictWrite = !!(options && (options.strictWrite || options.enforceWriteFormat || options.failOnWriteFallbacks));

  const inferSourceFormatForRecord = (rec) => {
    const fmt = String(rec && rec.fmt ? rec.fmt : '');
    if (fmt === 'large' || String(rec && rec.name ? rec.name : '').trim().endsWith('*')) return 'large';
    if (fmt === 'free') return 'free';
    return 'small';
  };

  const model = msg && msg.model ? msg.model : msg;
  const parseSessionId = model && model.parseSessionId != null ? String(model.parseSessionId) : '';
  const parseSession = parseSessionId ? getParseSession(parseSessionId) : null;
  const modelIndexes = model && model.indexes && typeof model.indexes === 'object' ? model.indexes : null;
  const sessionIndexes = parseSession && parseSession.indexes ? parseSession.indexes : null;
  const selectIndexFamily = (familyName) => {
    const modelFamily = modelIndexes && modelIndexes[familyName];
    if (modelFamily && typeof modelFamily.get === 'function') {
      if (typeof modelFamily.size !== 'number' || modelFamily.size > 0) return modelFamily;
    }
    const sessionFamily = sessionIndexes && sessionIndexes[familyName];
    return sessionFamily && typeof sessionFamily.get === 'function' ? sessionFamily : modelFamily || null;
  };
  const modelFamilyHasOverrides = (familyName) => {
    const modelFamily = modelIndexes && modelIndexes[familyName];
    return !!(modelFamily && typeof modelFamily.get === 'function' && (typeof modelFamily.size !== 'number' || modelFamily.size > 0));
  };
  const semanticFamilyForCardName = (cardName) => {
    const name = toUpper(cardName).replace(/\*$/, '');
    if (name === 'GRID') return 'nodes';
    if (name === 'CORD1R' || name === 'CORD1C' || name === 'CORD2R' || name === 'CORD2C' || name === 'CORD2S') return 'coords';
    if (name === 'CTRIA3' || name === 'CTRIA6' || name === 'CQUAD4' || name === 'CQUAD8' || name === 'CTETRA' || name === 'CHEXA' || name === 'CPENTA' || name === 'CPYRAM' || name === 'CROD' || name === 'CBAR' || name === 'CBEAM' || name === 'CBUSH' || name === 'RBE2' || name === 'RBE3') return 'elements';
    if (name === 'PSHELL' || name === 'PSOLID' || name === 'PROD' || name === 'PBAR' || name === 'PBUSH' || name === 'PBEAM' || name === 'PCOMP') return 'properties';
    if (name === 'MAT1') return 'materials';
    if (name === 'CONM2') return 'masses';
    if (name === 'LOAD' || name === 'FORCE' || name === 'MOMENT' || name === 'PLOAD2' || name === 'PLOAD4') return 'loads';
    if (name === 'SPC' || name === 'SPC1') return 'constraints';
    return '';
  };
  const allowUntouchedSessionSourcePassThrough = !!(parseSession && !(model && Array.isArray(model.cardStream) && model.cardStream.length > 0));
  const cardStream = model && Array.isArray(model.cardStream) && model.cardStream.length > 0
    ? model.cardStream
    : (parseSession && Array.isArray(parseSession.cardStream) ? parseSession.cardStream : null);
  const nodes = selectIndexFamily('nodes');
  const coords = selectIndexFamily('coords');
  const elements = selectIndexFamily('elements');
  const properties = selectIndexFamily('properties');
  const materials = selectIndexFamily('materials');
  const loads = selectIndexFamily('loads');
  const constraints = selectIndexFamily('constraints');
  const masses = selectIndexFamily('masses');
  const sourceSessionId = model && model.sourceSessionId != null
    ? String(model.sourceSessionId)
    : (parseSession && parseSession.sourceSessionId ? String(parseSession.sourceSessionId) : '');
  const sourceFilesFromModel = model && model.sourceFiles && typeof model.sourceFiles === 'object' ? model.sourceFiles : null;
  const sourceFilesFromSession = sourceSessionId ? getSourceSessionFiles(sourceSessionId) : null;
  const sourceFiles = sourceFilesFromModel || sourceFilesFromSession || null;
  const sourceTextCache = new Map();

  const getRecordRawLinesFromSource = (rec) => {
    if (!sourceFiles || !rec || typeof rec !== 'object') return null;
    const source = rec.source && typeof rec.source === 'object' ? rec.source : null;
    const fileKey = source && source.file != null ? String(source.file) : '';
    if (!fileKey) return null;
    const sourceTextRaw = Object.prototype.hasOwnProperty.call(sourceFiles, fileKey) ? sourceFiles[fileKey] : null;
    if (sourceTextRaw == null) return null;
    let sourceText = sourceTextCache.get(fileKey);
    if (typeof sourceText !== 'string') {
      sourceText = coerceSourceText(sourceTextRaw);
      if (typeof sourceText === 'string') sourceTextCache.set(fileKey, sourceText);
    }
    if (typeof sourceText !== 'string') return null;
    const span = Array.isArray(rec.sourceSpan) && rec.sourceSpan.length >= 2 ? rec.sourceSpan : null;
    if (span) {
      const spanLines = sourceLinesFromSpanText(sourceText, span[0], span[1]);
      if (spanLines.length > 0) return spanLines;
    }
    const lineRanges = Array.isArray(rec.sourceLineRanges) ? rec.sourceLineRanges : null;
    if (!lineRanges || lineRanges.length === 0) {
      return typeof rec.sourceFirstLine === 'string' ? [rec.sourceFirstLine] : null;
    }
    const out = [];
    for (const range of lineRanges) {
      if (!Array.isArray(range) || range.length < 2) return null;
      const start = Math.max(0, Math.min(sourceText.length, Number(range[0]) | 0));
      const end = Math.max(start, Math.min(sourceText.length, Number(range[1]) | 0));
      out.push(sourceText.slice(start, end));
    }
    return out;
  };

  const getRecordRawLinesForWrite = (rec) => {
    if (Array.isArray(rec && rec.rawLines) && rec.rawLines.length > 0) {
      return rec.rawLines.map((line) => String(line ?? ''));
    }
    const fromSource = getRecordRawLinesFromSource(rec);
    if (Array.isArray(fromSource) && fromSource.length > 0) return fromSource;
    if (rec && typeof rec.sourceFirstLine === 'string' && rec.sourceFirstLine.length > 0) {
      return [rec.sourceFirstLine];
    }
    return null;
  };

  const rstripSpaces = (s) => {
    const str = String(s ?? '');
    let end = str.length;
    while (end > 0 && str[end - 1] === ' ') end--;
    return str.slice(0, end);
  };

  const formatRightString = (val, width) => {
    const s = String(val ?? '');
    if (s.length === 0) return ' '.repeat(width);
    if (s.length > width) return '*'.repeat(width);
    return s.padStart(width, ' ');
  };

  const formatCardField = (val, width) => {
    if (val == null) return ' '.repeat(width);
    if (typeof val === 'number') {
      if (Number.isInteger(val)) return formatInt(val, width);
      // PSOLID has no floats in Tier-1 definition, but keep this safe.
      const s = width === 16 ? formatFloat16(val) : formatFloat8(val);
      return s.trim().length === 0 ? ' '.repeat(width) : s;
    }
    const s = String(val).trim();
    if (s.length === 0) return ' '.repeat(width);
    if (s.length > width) return '*'.repeat(width);
    return formatRightString(s, width);
  };

  const formatCardFloatField = (val, width) => {
    if (val == null) return ' '.repeat(width);
    const n = typeof val === 'number' ? val : parseNastranFloat(val);
    if (!Number.isFinite(n)) return ' '.repeat(width);
    let s = width === 16 ? formatFloat16(n) : formatFloat8(n);
    // Normalize to avoid '.25' style fields.
    const core = s.trim();
    if (core.startsWith('-.')) {
      const fixed = '-0.' + core.slice(2);
      s = fixed.length > width ? '*'.repeat(width) : fixed.padStart(width, ' ');
    } else if (core.startsWith('.')) {
      const fixed = '0' + core;
      s = fixed.length > width ? '*'.repeat(width) : fixed.padStart(width, ' ');
    }
    return s.trim().length === 0 ? ' '.repeat(width) : s;
  };

  const asRealToken = (v) => {
    if (v === null || v === undefined || v === '') return '';
    const n = typeof v === 'number' ? v : parseNastranFloat(v);
    if (!Number.isFinite(n)) return '';
    if (Object.is(n, -0)) return '-0.';
    if (Number.isInteger(n)) return `${n}.`;
    return String(n);
  };
  const asIntToken = (v) => {
    if (v === null || v === undefined || v === '') return '';
    const n = typeof v === 'number' ? v : parseNastranInt(v);
    if (!Number.isFinite(n)) return '';
    return String(Math.round(n));
  };

  const writeCardByTokensWithFormat = (rec, tokens) => {
    const sourceMode = inferSourceFormatForRecord(rec);
    const mode = writeFormat === 'source' ? sourceMode : writeFormat;

    if (mode === 'free') return formatFreeLines(tokens);
    if (mode === 'small') return formatSmallFieldLinesFromTokens(tokens);
    if (mode === 'large') return formatLargeFieldLinesFromTokens(tokens);

    const preferLarge = sourceMode === 'large';
    if (!preferLarge) {
      const small = formatSmallFieldLinesFromTokens(tokens);
      if (small && small.length) return small;
    }
    const large = formatLargeFieldLinesFromTokens(tokens);
    if (large && large.length) return large;
    if (preferLarge) {
      const small = formatSmallFieldLinesFromTokens(tokens);
      if (small && small.length) return small;
    }
    return null;
  };

  const tryWriteProdFromIndexes = (rec) => {
    if (!rec || rec.kind !== 'card') return null;
    const name = toUpper(rec.name);
    if (name !== 'PROD') return null;
    if (!properties) return null;

    const t = getHydrationTokens(rec);
    const pid = parseNastranInt(t[1]);
    if (!Number.isFinite(pid)) return null;
    const prop = properties.get(pid);
    if (!prop || prop.type !== 'PROD') return null;

    const preferLarge = writeFormat === 'large'
      ? true
      : writeFormat === 'small'
        ? false
        : (String(rec.fmt || '') === 'large' || String(rec.name || '').trim().endsWith('*'));

    const fields = [
      { kind: 'int', v: prop.pid },
      { kind: 'int', v: prop.mid },
      { kind: 'float', v: prop.A },
      { kind: 'float', v: prop.j },
      { kind: 'float', v: prop.c },
      { kind: 'float', v: prop.nsm }
    ];

    const fmtField = (f, width) => {
      if (!f) return ' '.repeat(width);
      if (f.kind === 'int') return formatCardField(f.v, width);
      return formatCardFloatField(f.v, width);
    };

    const makeSmall = () => {
      let line = formatString('PROD', 8);
      for (const f of fields) line += fmtField(f, 8);
      return [rstripSpaces(line)];
    };

    const makeLarge = () => {
      /** @type {string[]} */
      const lines = [];
      let idx = 0;
      let line1 = formatString('PROD*', 8);
      for (let k = 0; k < 4 && idx < fields.length; k++, idx++) line1 += fmtField(fields[idx], 16);
      lines.push(rstripSpaces(line1));
      while (idx < fields.length) {
        let line = '*       ';
        for (let k = 0; k < 4 && idx < fields.length; k++, idx++) line += fmtField(fields[idx], 16);
        lines.push(rstripSpaces(line));
      }
      return lines;
    };

    if (writeFormat === 'free') {
      const toks = ['PROD', String(prop.pid), String(prop.mid), normalizeFreeNumber(prop.A), normalizeFreeNumber(prop.j), normalizeFreeNumber(prop.c), normalizeFreeNumber(prop.nsm)];
      return formatFreeLines(toks);
    }

    const smallOverflows = fields.some((f) => fmtField(f, 8) === '********');
    if (!preferLarge && !smallOverflows) {
      const lines = makeSmall();
      if (lines.some((ln) => ln.includes('********'))) return null;
      return lines;
    }

    const largeOverflows = fields.some((f) => fmtField(f, 16) === '*'.repeat(16));
    if (largeOverflows) return null;
    const lines = makeLarge();
    if (lines.some((ln) => ln.includes('*'.repeat(16)))) return null;
    return lines;
  };

  const tryWritePshellFromIndexes = (rec) => {
    if (!rec || rec.kind !== 'card') return null;
    if (toUpper(rec.name) !== 'PSHELL') return null;
    if (!properties) return null;

    const t = getHydrationTokens(rec);
    const pid = parseNastranInt(t[1]);
    if (!Number.isFinite(pid)) return null;
    const prop = properties.get(pid);
    if (!prop || toUpper(prop.type) !== 'PSHELL') return null;

    const mid1 = Number.isFinite(parseNastranInt(prop.mid1))
      ? parseNastranInt(prop.mid1)
      : parseNastranInt(prop.mid);
    const tval = parseNastranFloat(prop.t);
    if (!Number.isFinite(mid1) || !Number.isFinite(tval) || tval <= 0) return null;

    const parseOptInt = (v) => (Number.isFinite(parseNastranInt(v)) ? parseNastranInt(v) : null);
    const parseOptFloat = (v) => (Number.isFinite(parseNastranFloat(v)) ? parseNastranFloat(v) : null);
    const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-12;
    const blankIfSourceBlankAndDefault = (sourceTok, val, dflt) => (
      isBlankToken(sourceTok) && near(val, dflt) ? null : val
    );

    const mid2 = parseOptInt(prop.mid2);
    const i12t3Raw = parseOptFloat(prop.i12t3);
    const mid3 = parseOptInt(prop.mid3);
    const tstRaw = parseOptFloat(prop.tst);
    const nsmRaw = parseOptFloat(prop.nsm);
    const z1Raw = parseOptFloat(prop.z1);
    const z2Raw = parseOptFloat(prop.z2);
    const mid4 = parseOptInt(prop.mid4);

    const i12t3 = blankIfSourceBlankAndDefault(t[5], i12t3Raw, 1.0);
    const tst = blankIfSourceBlankAndDefault(t[7], tstRaw, 0.833333);
    const nsm = blankIfSourceBlankAndDefault(t[8], nsmRaw, 0.0);
    const z1 = blankIfSourceBlankAndDefault(t[9], z1Raw, -0.5 * tval);
    const z2 = blankIfSourceBlankAndDefault(t[10], z2Raw, 0.5 * tval);

    const tokens = [
      'PSHELL',
      asIntToken(pid),
      asIntToken(mid1),
      asRealToken(tval),
      asIntToken(mid2),
      asRealToken(i12t3),
      asIntToken(mid3),
      asRealToken(tst),
      asRealToken(nsm),
      asRealToken(z1),
      asRealToken(z2),
      asIntToken(mid4),
    ];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWritePbarFromIndexes = (rec) => {
    if (!rec || rec.kind !== 'card') return null;
    if (toUpper(rec.name) !== 'PBAR') return null;
    if (!properties) return null;

    const t = getHydrationTokens(rec);
    const pid = parseNastranInt(t[1]);
    if (!Number.isFinite(pid)) return null;
    const prop = properties.get(pid);
    if (!prop || toUpper(prop.type) !== 'PBAR') return null;

    const tokens = [
      'PBAR',
      asIntToken(prop.pid),
      asIntToken(prop.mid),
      asRealToken(prop.A),
      asRealToken(prop.I1),
      asRealToken(prop.I2),
      asRealToken(prop.J),
      asRealToken(prop.nsm),
      '',
      asRealToken(prop.C1),
      asRealToken(prop.C2),
      asRealToken(prop.D1),
      asRealToken(prop.D2),
      asRealToken(prop.E1),
      asRealToken(prop.E2),
      asRealToken(prop.F1),
      asRealToken(prop.F2),
      asRealToken(prop.K1),
      asRealToken(prop.K2),
      asRealToken(prop.I12),
    ];

    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWritePbushFromIndexes = (rec) => {
    if (!rec || rec.kind !== 'card') return null;
    if (toUpper(rec.name) !== 'PBUSH') return null;
    if (!properties) return null;

    const t = getHydrationTokens(rec);
    const pid = parseNastranInt(t[1]);
    if (!Number.isFinite(pid)) return null;
    const prop = properties.get(pid);
    if (!prop || toUpper(prop.type) !== 'PBUSH') return null;

    const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) < 1e-12;
    const kVals = [1, 2, 3, 4, 5, 6].map((i) => (Number.isFinite(Number(prop[`K${i}`])) ? Number(prop[`K${i}`]) : 0.0));
    const bVals = [1, 2, 3, 4, 5, 6].map((i) => (Number.isFinite(Number(prop[`B${i}`])) ? Number(prop[`B${i}`]) : 0.0));
    const geVals = [1, 2, 3, 4, 5, 6].map((i) => (Number.isFinite(Number(prop[`GE${i}`])) ? Number(prop[`GE${i}`]) : 0.0));
    const rcvVals = ['SA', 'ST', 'EA', 'ET'].map((k) => (Number.isFinite(Number(prop[k])) ? Number(prop[k]) : 1.0));

    const includeK = toUpper(prop.K) === 'K' || kVals.some((v) => !near(v, 0.0));
    const includeB = toUpper(prop.B) === 'B' || bVals.some((v) => !near(v, 0.0));
    const includeGE = toUpper(prop.GE) === 'GE' || geVals.some((v) => !near(v, 0.0));
    const includeRCV = toUpper(prop.RCV) === 'RCV' || rcvVals.some((v) => !near(v, 1.0));

    const tokens = ['PBUSH', asIntToken(prop.pid)];
    if (includeK) tokens.push('K', ...kVals.map((v) => asRealToken(v)));
    if (includeB) tokens.push('B', ...bVals.map((v) => asRealToken(v)));
    if (includeGE) tokens.push('GE', ...geVals.map((v) => asRealToken(v)));
    if (includeRCV) tokens.push('RCV', ...rcvVals.map((v) => asRealToken(v)));

    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWritePbeamFromIndexes = (rec) => {
    if (!rec || rec.kind !== 'card') return null;
    if (toUpper(rec.name) !== 'PBEAM') return null;
    if (!properties) return null;

    const t = getHydrationTokens(rec);
    const pid = parseNastranInt(t[1]);
    if (!Number.isFinite(pid)) return null;
    const prop = properties.get(pid);
    if (!prop || toUpper(prop.type) !== 'PBEAM') return null;

    const mid = parseNastranInt(prop.mid);
    const aA = parseNastranFloat(prop.a_a);
    if (!Number.isFinite(mid) || !Number.isFinite(aA) || !(aA > 0)) return null;
    const numOrBlank = (v) => (Number.isFinite(Number(v)) ? asRealToken(v) : '');

    const tokens = [
      'PBEAM',
      asIntToken(prop.pid),
      asIntToken(mid),
      asRealToken(aA),
      numOrBlank(prop.i1_a),
      numOrBlank(prop.i2_a),
      numOrBlank(prop.i12_a),
      numOrBlank(prop.j_a),
      numOrBlank(prop.nsm_a),
      numOrBlank(prop.c1_a),
      numOrBlank(prop.c2_a),
      numOrBlank(prop.d1_a),
      numOrBlank(prop.d2_a),
      numOrBlank(prop.e1_a),
      numOrBlank(prop.e2_a),
      numOrBlank(prop.f1_a),
      numOrBlank(prop.f2_a),
    ];

    const stations = Array.isArray(prop.stations) ? prop.stations : [];
    const validSo = new Set(['YES', 'YESA', 'NO']);
    for (const s of stations) {
      if (!s) continue;
      const so = String(s.so || '').trim().toUpperCase();
      const xxb = Number(s.x_xb);
      if (!validSo.has(so) || !Number.isFinite(xxb) || !(xxb > 0)) continue;
      tokens.push(
        so,
        asRealToken(xxb),
        numOrBlank(s.a),
        numOrBlank(s.i1),
        numOrBlank(s.i2),
        numOrBlank(s.i12),
        numOrBlank(s.j),
        numOrBlank(s.nsm),
        numOrBlank(s.c1),
        numOrBlank(s.c2),
        numOrBlank(s.d1),
        numOrBlank(s.d2),
        numOrBlank(s.e1),
        numOrBlank(s.e2),
        numOrBlank(s.f1),
        numOrBlank(s.f2),
      );
    }

    const tail = [
      prop.k1, prop.k2, prop.s1, prop.s2,
      prop.nsi_a, prop.nsi_b, prop.cw_a, prop.cw_b,
      prop.m1_a, prop.m2_a, prop.m1_b, prop.m2_b,
      prop.n1_a, prop.n2_a, prop.n1_b, prop.n2_b,
    ];
    if (tail.some((v) => Number.isFinite(Number(v)))) {
      tokens.push(...tail.map((v) => numOrBlank(v)));
    }

    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWritePcompFromIndexes = (rec) => {
    if (!rec || rec.kind !== 'card') return null;
    if (toUpper(rec.name) !== 'PCOMP') return null;
    if (!properties) return null;

    const t = getHydrationTokens(rec);
    const pid = parseNastranInt(t[1]);
    if (!Number.isFinite(pid)) return null;
    const prop = properties.get(pid);
    if (!prop || toUpper(prop.type) !== 'PCOMP') return null;

    const plies = Array.isArray(prop.plies) ? prop.plies : [];
    if (!plies.length) return null;
    const cleanPly = [];
    for (const p of plies) {
      const mid = parseNastranInt(p && p.mid);
      const th = parseNastranFloat(p && p.t);
      if (!Number.isFinite(mid) || !(mid > 0) || !Number.isFinite(th) || !(th > 0)) return null;
      const theta = parseNastranFloat(p && p.theta);
      const soutRaw = String((p && p.sout) || 'NO').trim().toUpperCase();
      const sout = (soutRaw === 'YES' || soutRaw === 'NO') ? soutRaw : 'NO';
      cleanPly.push({ mid, t: th, theta: Number.isFinite(theta) ? theta : 0.0, sout });
    }
    if (!cleanPly.length) return null;

    const z0Parsed = parseNastranFloat(prop.z0);
    const z0Tok = Number.isFinite(z0Parsed) ? asRealToken(z0Parsed) : '';
    const nsm = Number.isFinite(parseNastranFloat(prop.nsm)) ? parseNastranFloat(prop.nsm) : null;
    const sb = Number.isFinite(parseNastranFloat(prop.sb)) ? parseNastranFloat(prop.sb) : null;
    const tref = Number.isFinite(parseNastranFloat(prop.tref)) ? parseNastranFloat(prop.tref) : null;
    const ge = Number.isFinite(parseNastranFloat(prop.ge)) ? parseNastranFloat(prop.ge) : null;
    const ft = String(prop.ft || '').trim().toUpperCase();
    const lam = String(prop.lam || '').trim().toUpperCase();

    const tokens = [
      'PCOMP',
      asIntToken(prop.pid),
      z0Tok,
      asRealToken(nsm),
      asRealToken(sb),
      ft,
      asRealToken(tref),
      asRealToken(ge),
      lam,
    ];
    for (const p of cleanPly) {
      tokens.push(asIntToken(p.mid), asRealToken(p.t), asRealToken(p.theta), p.sout);
    }
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const writtenLoadBySidTypeCount = new Map();
  const sourceMatches = (a, b) => {
    if (!a || !b) return false;
    const af = String(a.file || '');
    const bf = String(b.file || '');
    const al = Number(a.line || 0);
    const bl = Number(b.line || 0);
    return af === bf && Number.isFinite(al) && Number.isFinite(bl) && al === bl;
  };
  const isSyntheticEditorSource = (source) => {
    if (!source || typeof source !== 'object') return false;
    return String(source.file || '') === '<editor>';
  };
  const tryWriteLoadFromIndexes = (rec) => {
    const load = getLoadForRecord(rec, 'LOAD');
    if (!load) return null;
    if (!Array.isArray(load.entries) || load.entries.length === 0) return null;
    const tokens = ['LOAD', asIntToken(load.sid), asRealToken(load.scale)];
    for (const ent of load.entries) {
      if (!ent) continue;
      const s = parseNastranFloat(ent.scale);
      const lid = parseNastranInt(ent.lid);
      if (!Number.isFinite(s) || !Number.isFinite(lid)) return null;
      tokens.push(asRealToken(s), asIntToken(lid));
    }
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const getLoadForRecord = (rec, expectedType) => {
    if (!rec || rec.kind !== 'card') return null;
    const typeUpper = toUpper(expectedType);
    if (toUpper(rec.name) !== typeUpper) return null;
    if (!loads) return null;

    const t = getHydrationTokens(rec);
    const sid = parseNastranInt(t[1]);
    if (!Number.isFinite(sid)) return null;
    const arr = loads.get(sid);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const typedCards = arr.filter((x) => x && toUpper(x.type) === typeUpper);
    if (typedCards.length === 0) return null;

    let load = null;
    if (rec.source && !isSyntheticEditorSource(rec.source)) {
      load = typedCards.find((x) => sourceMatches(x.source, rec.source)) || null;
    }
    if (!load) {
      const key = `${typeUpper}:${sid}`;
      const idx = writtenLoadBySidTypeCount.get(key) || 0;
      load = typedCards[idx] || null;
      writtenLoadBySidTypeCount.set(key, idx + 1);
    }
    return load;
  };

  const tryWriteForceFromIndexes = (rec) => {
    const load = getLoadForRecord(rec, 'FORCE');
    if (!load) return null;
    const sid = parseNastranInt(load.sid);
    const g = parseNastranInt(load.g);
    const cid = Number.isFinite(parseNastranInt(load.cid)) ? parseNastranInt(load.cid) : 0;
    const f = parseNastranFloat(load.f);
    const n = Array.isArray(load.n) ? load.n : [];
    if (!Number.isFinite(sid) || !Number.isFinite(g) || !Number.isFinite(f) || n.length < 3) return null;
    const n1 = parseNastranFloat(n[0]);
    const n2 = parseNastranFloat(n[1]);
    const n3 = parseNastranFloat(n[2]);
    if (![n1, n2, n3].every(Number.isFinite)) return null;
    const eps = 1e-15;
    if (Math.abs(n1) < eps && Math.abs(n2) < eps && Math.abs(n3) < eps) return null;

    const tokens = [
      'FORCE',
      asIntToken(sid),
      asIntToken(g),
      asIntToken(cid),
      asRealToken(f),
      asRealToken(n1),
      asRealToken(n2),
      asRealToken(n3),
    ];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWriteMomentFromIndexes = (rec) => {
    const load = getLoadForRecord(rec, 'MOMENT');
    if (!load) return null;
    const sid = parseNastranInt(load.sid);
    const g = parseNastranInt(load.g);
    const cid = Number.isFinite(parseNastranInt(load.cid)) ? parseNastranInt(load.cid) : 0;
    const m = parseNastranFloat(load.m);
    const n = Array.isArray(load.n) ? load.n : [];
    if (!Number.isFinite(sid) || !Number.isFinite(g) || !Number.isFinite(m) || n.length < 3) return null;
    const n1 = parseNastranFloat(n[0]);
    const n2 = parseNastranFloat(n[1]);
    const n3 = parseNastranFloat(n[2]);
    if (![n1, n2, n3].every(Number.isFinite)) return null;

    const tokens = [
      'MOMENT',
      asIntToken(sid),
      asIntToken(g),
      asIntToken(cid),
      asRealToken(m),
      asRealToken(n1),
      asRealToken(n2),
      asRealToken(n3),
    ];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWritePload2FromIndexes = (rec) => {
    const load = getLoadForRecord(rec, 'PLOAD2');
    if (!load) return null;
    const sid = parseNastranInt(load.sid);
    const p = parseNastranFloat(load.p);
    const eidsRaw = Array.isArray(load.eids) ? load.eids : [];
    if (eidsRaw.length === 0) return null;
    /** @type {number[]} */
    const parsedEids = [];
    for (const raw of eidsRaw) {
      const eid = parseNastranInt(raw);
      if (!Number.isFinite(eid) || eid < 1) return null;
      parsedEids.push(eid);
    }
    const eidSegments = buildThruSegmentsFromIds(parsedEids, 1, 3);
    const eidFields = flattenSegments(eidSegments);
    if (!Number.isFinite(sid) || !Number.isFinite(p) || eidFields.length === 0) return null;
    const tokens = ['PLOAD2', asIntToken(sid), asRealToken(p), ...eidFields.map((v) => String(v))];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWritePload4FromIndexes = (rec) => {
    const load = getLoadForRecord(rec, 'PLOAD4');
    if (!load) return null;
    const sid = parseNastranInt(load.sid);
    const eid = parseNastranInt(load.eid);
    const p = Array.isArray(load.p) ? load.p : [];
    if (!Number.isFinite(sid) || !Number.isFinite(eid) || p.length < 1) return null;
    const p1 = parseNastranFloat(p[0]);
    if (!Number.isFinite(p1)) return null;
    const p2v = p.length > 1 ? parseNastranFloat(p[1]) : p1;
    const p3v = p.length > 2 ? parseNastranFloat(p[2]) : p1;
    const p4v = p.length > 3 ? parseNastranFloat(p[3]) : p1;
    if (![p2v, p3v, p4v].every(Number.isFinite)) return null;
    const pEq = (v) => Math.abs(v - p1) <= 1e-12;
    const p2tok = pEq(p2v) ? '' : asRealToken(p2v);
    const p3tok = pEq(p3v) ? '' : asRealToken(p3v);
    const p4tok = pEq(p4v) ? '' : asRealToken(p4v);
    const g1 = Number.isFinite(parseNastranInt(load.g1)) ? parseNastranInt(load.g1) : null;
    const g34 = Number.isFinite(parseNastranInt(load.g34)) ? parseNastranInt(load.g34) : null;
    const eids = normalizeSortedUniqueIds(
      Array.isArray(load.eids) && load.eids.length > 0 ? load.eids : [eid],
      1
    );
    if (eids.length === 0) return null;
    const usesSolidFaceForm = g1 != null || g34 != null;
    if (usesSolidFaceForm && eids.length !== 1) return null;

    const cid = Number.isFinite(parseNastranInt(load.cid)) ? parseNastranInt(load.cid) : null;
    const n = Array.isArray(load.n) ? load.n : [];
    const n1 = Number.isFinite(parseNastranFloat(n[0])) ? parseNastranFloat(n[0]) : null;
    const n2 = Number.isFinite(parseNastranFloat(n[1])) ? parseNastranFloat(n[1]) : null;
    const n3 = Number.isFinite(parseNastranFloat(n[2])) ? parseNastranFloat(n[2]) : null;

    /** @type {string[]} */
    const lines = [];
    if (usesSolidFaceForm) {
      const tokens = [
        'PLOAD4',
        asIntToken(sid),
        asIntToken(eids[0]),
        asRealToken(p1),
        p2tok,
        p3tok,
        p4tok,
        asIntToken(g1),
        asIntToken(g34),
        asIntToken(cid),
        asRealToken(n1),
        asRealToken(n2),
        asRealToken(n3),
      ];
      return writeCardByTokensWithFormat(rec, tokens);
    }

    const eidSegments = buildThruSegmentsFromIds(eids, 1, 2);
    for (const seg of eidSegments) {
      const startEid = parseNastranInt(seg[0]);
      if (!Number.isFinite(startEid)) return null;
      const isThru = seg.length === 3 && String(seg[1]).toUpperCase() === 'THRU';
      const endEid = isThru ? parseNastranInt(seg[2]) : null;
      if (isThru && !Number.isFinite(endEid)) return null;

      const tokens = [
        'PLOAD4',
        asIntToken(sid),
        asIntToken(startEid),
        asRealToken(p1),
        p2tok,
        p3tok,
        p4tok,
        isThru ? 'THRU' : '',
        isThru ? asIntToken(endEid) : '',
        asIntToken(cid),
        asRealToken(n1),
        asRealToken(n2),
        asRealToken(n3),
      ];
      const out = writeCardByTokensWithFormat(rec, tokens);
      if (!out || out.length === 0) return null;
      lines.push(...out);
    }
    return lines;
  };

  const tryWriteRbe2FromIndexes = (rec) => {
    const elem = getElementForRecord(rec, 'RBE2');
    if (!elem) return null;
    const eid = parseNastranInt(elem.eid);
    const gn = parseNastranInt(elem.gn);
    const cm = parseNastranString(elem.cm);
    const gmiRaw = Array.isArray(elem.gmi) ? elem.gmi : (Array.isArray(elem.deps) ? elem.deps : []);
    const gmi = gmiRaw.map((v) => parseNastranInt(v)).filter(Number.isFinite);
    if (!Number.isFinite(eid) || !Number.isFinite(gn) || !cm || gmi.length === 0) return null;
    const alpha = parseNastranFloat(elem.alpha);
    const tref = parseNastranFloat(elem.tref);
    const hasAlpha = Number.isFinite(alpha) && Math.abs(alpha) > 1e-12;
    const hasTref = Number.isFinite(tref) && Math.abs(tref) > 1e-12;
    const tokens = ['RBE2', asIntToken(eid), asIntToken(gn), String(cm).trim(), ...gmi.map((v) => asIntToken(v))];
    if (hasAlpha || hasTref) {
      tokens.push(asRealToken(hasAlpha ? alpha : 0.0));
      if (hasTref) tokens.push(asRealToken(tref));
    }
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWriteRbe3FromIndexes = (rec) => {
    const elem = getElementForRecord(rec, 'RBE3');
    if (!elem) return null;
    const eid = parseNastranInt(elem.eid);
    const refgrid = Number.isFinite(parseNastranInt(elem.refgrid))
      ? parseNastranInt(elem.refgrid)
      : parseNastranInt(elem.gn);
    const refcRaw = parseNastranString(elem.refc);
    const refc = refcRaw || parseNastranString(elem.cm);
    if (!Number.isFinite(eid) || !Number.isFinite(refgrid) || !refc) return null;

    const groupsIn = Array.isArray(elem.groups) ? elem.groups : [];
    const groups = groupsIn.length > 0
      ? groupsIn
      : (() => {
        const inds = Array.isArray(elem.inds) ? elem.inds.map((v) => parseNastranInt(v)).filter(Number.isFinite) : [];
        if (inds.length === 0) return [];
        return [{ wt: 1.0, c: String(refc), gids: inds }];
      })();
    if (groups.length === 0) return null;

    const tokens = ['RBE3', asIntToken(eid), '', asIntToken(refgrid), String(refc).trim()];
    for (const g of groups) {
      const wt = parseNastranFloat(g && g.wt);
      const c = parseNastranString(g && g.c);
      const gids = Array.isArray(g && g.gids) ? g.gids.map((v) => parseNastranInt(v)).filter(Number.isFinite) : [];
      if (!Number.isFinite(wt) || !c || gids.length === 0) return null;
      tokens.push(asRealToken(wt));
      tokens.push(String(c).trim());
      for (const gid of gids) tokens.push(asIntToken(gid));
    }

    const um = Array.isArray(elem.um) ? elem.um : [];
    if (um.length > 0) {
      tokens.push('UM');
      for (const u of um) {
        const gm = parseNastranInt(u && u.gm);
        const cm = parseNastranString(u && u.cm);
        if (!Number.isFinite(gm) || !cm) return null;
        tokens.push(asIntToken(gm));
        tokens.push(String(cm).trim());
      }
    }

    const alpha = parseNastranFloat(elem.alpha);
    const tref = parseNastranFloat(elem.tref);
    const hasAlpha = Number.isFinite(alpha);
    const hasTref = Number.isFinite(tref);
    if (hasAlpha || hasTref) {
      tokens.push('ALPHA');
      tokens.push(asRealToken(hasAlpha ? alpha : 0.0));
      if (hasTref) tokens.push(asRealToken(tref));
    }
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWriteMat1FromIndexes = (rec) => {
    if (!rec || rec.kind !== 'card') return null;
    const name = toUpper(rec.name);
    if (name !== 'MAT1') return null;
    if (!materials) return null;

    const t = getHydrationTokens(rec);
    const mid = parseNastranInt(t[1]);
    if (!Number.isFinite(mid)) return null;
    const mat = materials.get(mid);
    if (!mat || mat.type !== 'MAT1') return null;
    if (!Number.isFinite(parseNastranFloat(mat.E))) return null;

    // Use the shared token writer for MAT1 to ensure correct small/large
    // continuation layout and avoid field-shift defects.
    const tokens = [
      'MAT1',
      asIntToken(mat.mid),
      asRealToken(mat.E),
      asRealToken(mat.G),
      asRealToken(mat.nu),
      asRealToken(mat.rho),
      asRealToken(mat.a),
      asRealToken(mat.tref),
      asRealToken(mat.ge),
      asRealToken(mat.st),
      asRealToken(mat.sc),
      asRealToken(mat.ss),
      asIntToken(mat.mcsid)
    ];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWritePsolidFromIndexes = (rec) => {
    if (!rec || rec.kind !== 'card') return null;
    const name = toUpper(rec.name);
    if (name !== 'PSOLID') return null;
    if (!properties) return null;

    const t = getHydrationTokens(rec);
    const pid = parseNastranInt(t[1]);
    if (!Number.isFinite(pid)) return null;
    const prop = properties.get(pid);
    if (!prop || prop.type !== 'PSOLID') return null;

    const preferLarge = writeFormat === 'large'
      ? true
      : writeFormat === 'small'
        ? false
        : (String(rec.fmt || '') === 'large' || String(rec.name || '').trim().endsWith('*'));

    // Preserve source sparsity for optional fields:
    // - If the input token is blank and the semantic value equals the hydrator
    //   default, keep it blank (do not expand defaults into the written deck).
    // - If the value is non-default (e.g., user edited), write it even if the
    //   original token was blank.
    const stressTokBlank = isBlankToken(t[5]);
    const fctnTokBlank = isBlankToken(t[7]);
    const stressDefault = 'GRID';
    const fctnDefault = 'SMECH';
    const stressOut = stressTokBlank && String(prop.stress || '').toUpperCase() === stressDefault ? null : prop.stress;
    const fctnOut = fctnTokBlank && String(prop.fctn || '').toUpperCase() === fctnDefault ? null : prop.fctn;

    const fields = [
      prop.pid,
      prop.mid,
      prop.cordm,
      prop.integ,
      stressOut,
      prop.isop,
      fctnOut,
    ];

    const makeSmall = () => {
      let line = formatString('PSOLID', 8);
      for (const v of fields) line += formatCardField(v, 8);
      return [rstripSpaces(line)];
    };

    const makeLarge = () => {
      /** @type {string[]} */
      const lines = [];
      let idx = 0;

      // First line: 4 fields
      let line1 = formatString('PSOLID*', 8);
      for (let k = 0; k < 4 && idx < fields.length; k++, idx++) line1 += formatCardField(fields[idx], 16);
      lines.push(rstripSpaces(line1));

      // Continuations: 4 fields per line
      while (idx < fields.length) {
        let line = '*       ';
        for (let k = 0; k < 4 && idx < fields.length; k++, idx++) line += formatCardField(fields[idx], 16);
        lines.push(rstripSpaces(line));
      }
      return lines;
    };

    if (writeFormat === 'free') {
      const toks = [
        'PSOLID',
        String(prop.pid),
        String(prop.mid),
        String(prop.cordm ?? 0),
        String(prop.integ ?? ''),
        String(stressOut ?? ''),
        String(prop.isop ?? ''),
        String(fctnOut ?? '')
      ];
      return formatFreeLines(toks);
    }

    // Decide small vs large based on overflow.
    const smallFields = fields.map((v) => formatCardField(v, 8));
    const smallOverflows = smallFields.some((tok) => tok === '********');
    if (!preferLarge && !smallOverflows) {
      const lines = makeSmall();
      if (lines.some((ln) => ln.includes('********'))) return null;
      return lines;
    }

    const largeFields = fields.map((v) => formatCardField(v, 16));
    const largeOverflows = largeFields.some((tok) => tok === '*'.repeat(16));
    if (largeOverflows) return null;
    const lines = makeLarge();
    if (lines.some((ln) => ln.includes('*'.repeat(16)))) return null;
    return lines;
  };

  const tryWriteConm2FromIndexes = (rec) => {
    if (!rec || rec.kind !== 'card') return null;
    if (toUpper(rec.name) !== 'CONM2') return null;
    if (!masses) return null;

    const t = getHydrationTokens(rec);
    const eid = parseNastranInt(t[1]);
    if (!Number.isFinite(eid)) return null;
    const mass = masses.get(eid);
    if (!mass || toUpper(mass.type) !== 'CONM2') return null;

    const g = parseNastranInt(mass.g);
    const cidRaw = parseNastranInt(mass.cid);
    const cid = Number.isFinite(cidRaw) ? cidRaw : 0;
    const m = parseNastranFloat(mass.m);
    if (!Number.isFinite(g) || g < 1 || !Number.isFinite(cid) || cid < -1 || !Number.isFinite(m) || m < 0.0) return null;

    const xSrc = Array.isArray(mass.x) ? mass.x : [];
    const iSrc = Array.isArray(mass.inertia) ? mass.inertia : [];
    const xVals = [0, 1, 2].map((i) => {
      const v = parseNastranFloat(xSrc[i]);
      return Number.isFinite(v) ? v : 0.0;
    });
    const iVals = [0, 1, 2, 3, 4, 5].map((i) => {
      const v = parseNastranFloat(iSrc[i]);
      return Number.isFinite(v) ? v : 0.0;
    });

    const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-12;
    const blankIfDefault = (sourceTok, val, dflt = 0.0) => (isBlankToken(sourceTok) && near(val, dflt) ? '' : asRealToken(val));
    const cidOut = isBlankToken(t[3]) && cid === 0 ? '' : asIntToken(cid);
    const mOut = blankIfDefault(t[4], m, 0.0);
    const x1Out = blankIfDefault(t[5], xVals[0], 0.0);
    const x2Out = blankIfDefault(t[6], xVals[1], 0.0);
    const x3Out = blankIfDefault(t[7], xVals[2], 0.0);
    const i11Out = blankIfDefault(t[8], iVals[0], 0.0);
    const i21Out = blankIfDefault(t[9], iVals[1], 0.0);
    const i22Out = blankIfDefault(t[10], iVals[2], 0.0);
    const i31Out = blankIfDefault(t[11], iVals[3], 0.0);
    const i32Out = blankIfDefault(t[12], iVals[4], 0.0);
    const i33Out = blankIfDefault(t[13], iVals[5], 0.0);

    const tokens = [
      'CONM2',
      asIntToken(eid),
      asIntToken(g),
      cidOut,
      mOut,
      x1Out,
      x2Out,
      x3Out,
      '',
      i11Out,
      i21Out,
      i22Out,
      i31Out,
      i32Out,
      i33Out,
    ];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWriteCpentaFromIndexes = (rec) => {
    const elem = getElementForRecord(rec, 'CPENTA');
    if (!elem || !Array.isArray(elem.nids)) return null;

    // Write-time safety validation: never emit a solver-invalid CPENTA.
    if (!Number.isFinite(parseNastranInt(elem.eid)) || !Number.isFinite(parseNastranInt(elem.pid))) return null;
    const nids = elem.nids.map((v) => parseNastranInt(v));
    if (!nids.every((v) => Number.isFinite(v))) return null;
    if (nids.length !== 6 && nids.length !== 15) return null;
    if (new Set(nids.slice(0, 6)).size !== 6) return null;
    if (nids.length === 15 && new Set(nids).size !== 15) return null;

    const preferLarge = writeFormat === 'large'
      ? true
      : writeFormat === 'small'
        ? false
        : (String(rec.fmt || '') === 'large' || String(rec.name || '').trim().endsWith('*'));

    // Fixed-width base layout (6- or 15-node supported).
    const fields = [elem.eid, elem.pid, ...nids];

    const makeSmall = () => {
      const width = 8;
      /** @type {string[]} */
      const lines = [];
      let idx = 0;
      let line1 = formatString('CPENTA', 8);
      // Small-field fixed format reserves the last 8 columns (field 10) for
      // continuation markers; avoid placing meaningful values there.
      // First line: up to 8 data fields (cols 9-72).
      for (; idx < fields.length && idx < 8; idx++) line1 += formatCardField(fields[idx], width);
      lines.push(rstripSpaces(line1));
      while (idx < fields.length) {
        // Continuation: put data in cols 9-72 (8 fields); keep the final 8 cols reserved.
        let line = '        ';
        for (let k = 0; k < 8 && idx < fields.length; k++, idx++) line += formatCardField(fields[idx], width);
        lines.push(rstripSpaces(line));
      }
      return lines;
    };

    const makeLarge = () => {
      const width = 16;
      /** @type {string[]} */
      const lines = [];
      let idx = 0;
      let line1 = formatString('CPENTA*', 8);
      for (let k = 0; k < 4 && idx < fields.length; k++, idx++) line1 += formatCardField(fields[idx], width);
      lines.push(rstripSpaces(line1));
      while (idx < fields.length) {
        let line = '*       ';
        for (let k = 0; k < 4 && idx < fields.length; k++, idx++) line += formatCardField(fields[idx], width);
        lines.push(rstripSpaces(line));
      }
      return lines;
    };

    if (writeFormat === 'free') {
      const toks = ['CPENTA', String(elem.eid), String(elem.pid), ...nids.map((v) => String(v))];
      return formatFreeLines(toks);
    }

    // Decide small vs large based on overflow.
    const smallOverflows = fields.some((v) => formatCardField(v, 8) === '********');
    if (!preferLarge && !smallOverflows) {
      const lines = makeSmall();
      if (lines.some((ln) => ln.includes('********'))) return null;
      return lines;
    }
    const largeOverflows = fields.some((v) => formatCardField(v, 16) === '*'.repeat(16));
    if (largeOverflows) return null;
    const lines = makeLarge();
    if (lines.some((ln) => ln.includes('*'.repeat(16)))) return null;
    return lines;
  };

  const tryWriteCpyramFromIndexes = (rec) => {
    const elem = getElementForRecord(rec, 'CPYRAM');
    if (!elem || !Array.isArray(elem.nids)) return null;
    if (elem.nids.length !== 5 && elem.nids.length !== 13) return null;
    if (![elem.eid, elem.pid].every((v) => Number.isFinite(parseNastranInt(v)))) return null;
    const nids = elem.nids.map((v) => parseNastranInt(v));
    if (!nids.every((v) => Number.isFinite(v))) return null;
    const tokens = ['CPYRAM', asIntToken(elem.eid), asIntToken(elem.pid), ...nids.map((v) => asIntToken(v))];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const getRecordCardId = (rec) => {
    if (!rec || rec.kind !== 'card') return null;
    const directId = Number(rec.directCardId);
    if (Number.isFinite(directId)) return directId;
    const t = getHydrationTokens(rec);
    const id = parseNastranInt(t[1]);
    return Number.isFinite(id) ? id : null;
  };

  const getNodeForRecord = (rec) => {
    if (!rec || rec.kind !== 'card') return null;
    if (!nodes) return null;
    if (toUpper(rec.name) !== 'GRID') return null;
    const nid = getRecordCardId(rec);
    if (!Number.isFinite(nid)) return null;
    const node = nodes.get(nid);
    if (!node || !Number.isFinite(parseNastranInt(node.nid))) return null;
    return node;
  };

  const tryWriteGridFromIndexes = (rec) => {
    const node = getNodeForRecord(rec);
    if (!node) return null;

    const sourceTokens = getHydrationTokens(rec);
    const nid = parseNastranInt(node.nid);
    if (!Number.isFinite(nid) || nid < 1) return null;

    const xyz = Array.isArray(node.xLocal) && node.xLocal.length >= 3
      ? node.xLocal
      : (Array.isArray(node.x) && node.x.length >= 3 ? node.x : null);
    if (!xyz) return null;
    const x1 = parseNastranFloat(xyz[0]);
    const x2 = parseNastranFloat(xyz[1]);
    const x3 = parseNastranFloat(xyz[2]);
    if (![x1, x2, x3].every(Number.isFinite)) return null;

    const cp = Number.isFinite(parseNastranInt(node.cp)) ? parseNastranInt(node.cp) : 0;
    if (cp < 0) return null;
    const cd = Number.isFinite(parseNastranInt(node.cd)) ? parseNastranInt(node.cd) : 0;
    if (cd < -1) return null;

    let ps = parseNastranString(node.ps);
    if (!ps) ps = '';
    if (ps) {
      if (!/^[1-6]+$/.test(ps)) return null;
      const seen = new Set();
      for (const ch of ps) {
        if (seen.has(ch)) return null;
        seen.add(ch);
      }
    }

    const seidFromNode = parseNastranInt(node.seid);
    const seidFromSource = parseNastranInt(sourceTokens[8]);
    const seid = Number.isFinite(seidFromNode)
      ? seidFromNode
      : (Number.isFinite(seidFromSource) ? seidFromSource : 0);
    if (seid < 0) return null;

    const cpOut = isBlankToken(sourceTokens[2]) && cp === 0 ? '' : asIntToken(cp);
    const cdOut = isBlankToken(sourceTokens[6]) && cd === 0 ? '' : asIntToken(cd);
    const psOut = isBlankToken(sourceTokens[7]) && !ps ? '' : ps;
    const seidOut = isBlankToken(sourceTokens[8]) && seid === 0 ? '' : asIntToken(seid);

    const tokens = [
      'GRID',
      asIntToken(nid),
      cpOut,
      asRealToken(x1),
      asRealToken(x2),
      asRealToken(x3),
      cdOut,
      psOut,
      seidOut,
    ];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const getCoordForRecord = (rec, expectedType) => {
    if (!rec || rec.kind !== 'card') return null;
    if (!coords) return null;
    const name = toUpper(rec.name);
    if (expectedType && name !== expectedType) return null;
    const t = getHydrationTokens(rec);
    const cid = parseNastranInt(t[1]);
    if (!Number.isFinite(cid) || cid < 1) return null;
    const coord = coords.get(cid);
    if (!coord) return null;
    const coordType = toUpper(coord.type);
    if (coordType !== name) return null;
    return { cid, coord };
  };

  const tryWriteCord1ByNodesFromIndexes = (rec, cardType) => {
    const hit = getCoordForRecord(rec, cardType);
    if (!hit) return null;
    const { cid, coord } = hit;
    const n = Array.isArray(coord.nodes) ? coord.nodes : null;
    if (!n || n.length < 3) return null;
    const g1 = parseNastranInt(n[0]);
    const g2 = parseNastranInt(n[1]);
    const g3 = parseNastranInt(n[2]);
    if (![g1, g2, g3].every((v) => Number.isFinite(v) && v > 0)) return null;
    if (g1 === g2 || g1 === g3 || g2 === g3) return null;
    const tokens = [cardType, asIntToken(cid), asIntToken(g1), asIntToken(g2), asIntToken(g3)];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWriteCord2ByPointsFromIndexes = (rec, cardType) => {
    const hit = getCoordForRecord(rec, cardType);
    if (!hit) return null;
    const { cid, coord } = hit;
    const rid = Number.isFinite(parseNastranInt(coord.rid)) ? parseNastranInt(coord.rid) : 0;
    if (rid < 0) return null;

    const origin = Array.isArray(coord.origin) && coord.origin.length >= 3 ? coord.origin : null;
    let pointB = Array.isArray(coord.pointB) && coord.pointB.length >= 3 ? coord.pointB : null;
    let pointC = Array.isArray(coord.pointC) && coord.pointC.length >= 3 ? coord.pointC : null;
    if ((!pointB || !pointC) && Array.isArray(coord.axes) && coord.axes.length === 3) {
      const axes = coord.axes;
      if (origin && axes.every((v) => Array.isArray(v) && v.length >= 3)) {
        const xAxis = axes[0];
        const zAxis = axes[2];
        pointB = [origin[0] + zAxis[0], origin[1] + zAxis[1], origin[2] + zAxis[2]];
        pointC = [origin[0] + xAxis[0], origin[1] + xAxis[1], origin[2] + xAxis[2]];
      }
    }
    if (!origin || !pointB || !pointC) return null;
    const all = [...origin, ...pointB, ...pointC].map((v) => parseNastranFloat(v));
    if (!all.every((v) => Number.isFinite(v))) return null;
    const tokens = [
      cardType,
      asIntToken(cid),
      asIntToken(rid),
      asRealToken(all[0]),
      asRealToken(all[1]),
      asRealToken(all[2]),
      asRealToken(all[3]),
      asRealToken(all[4]),
      asRealToken(all[5]),
      asRealToken(all[6]),
      asRealToken(all[7]),
      asRealToken(all[8]),
    ];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const getElementForRecord = (rec, expectedType) => {
    if (!rec || rec.kind !== 'card') return null;
    if (!elements) return null;
    if (toUpper(rec.name) !== expectedType) return null;
    const eid = getRecordCardId(rec);
    if (!Number.isFinite(eid)) return null;
    const elem = elements.get(eid);
    if (!elem || toUpper(elem.type) !== expectedType) return null;
    return elem;
  };

  const orientTokensFromElem = (elem) => {
    if (!elem || !elem.orient || typeof elem.orient !== 'object') return ['', '', ''];
    if (elem.orient.kind === 'g0' && Number.isFinite(parseNastranInt(elem.orient.g0))) {
      return [asIntToken(elem.orient.g0), '', ''];
    }
    if (elem.orient.kind === 'x' && Array.isArray(elem.orient.x) && elem.orient.x.length >= 3) {
      return [asRealToken(elem.orient.x[0]), asRealToken(elem.orient.x[1]), asRealToken(elem.orient.x[2])];
    }
    return ['', '', ''];
  };

  const tryWriteCrodFromIndexes = (rec) => {
    const elem = getElementForRecord(rec, 'CROD');
    if (!elem || !Array.isArray(elem.nids) || elem.nids.length !== 2) return null;
    const n1 = parseNastranInt(elem.nids[0]);
    const n2 = parseNastranInt(elem.nids[1]);
    if (![elem.eid, elem.pid, n1, n2].every((v) => Number.isFinite(parseNastranInt(v)))) return null;
    const tokens = ['CROD', asIntToken(elem.eid), asIntToken(elem.pid), asIntToken(n1), asIntToken(n2)];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWriteCbarFromIndexes = (rec) => {
    const elem = getElementForRecord(rec, 'CBAR');
    if (!elem || !Array.isArray(elem.nids) || elem.nids.length !== 2) return null;
    const ga = parseNastranInt(elem.nids[0]);
    const gb = parseNastranInt(elem.nids[1]);
    if (![elem.eid, elem.pid, ga, gb].every((v) => Number.isFinite(parseNastranInt(v)))) return null;
    const [o1, o2, o3] = orientTokensFromElem(elem);
    if (isBlankToken(o1) && isBlankToken(o2) && isBlankToken(o3)) return null;
    const intOrBlankDefault = (val, dflt) => {
      const v = parseNastranInt(val);
      if (!Number.isFinite(v)) return '';
      return v === dflt ? '' : asIntToken(v);
    };
    const realOrBlankDefault = (val, dflt) => {
      const v = parseNastranFloat(val);
      if (!Number.isFinite(v)) return '';
      return Math.abs(v - dflt) < 1e-12 ? '' : asRealToken(v);
    };
    const offtRaw = toUpper(parseNastranString(elem.offt) || '');
    const offt = offtRaw || 'GGG';
    if (!ALLOWED_BAR_BEAM_OFFT.has(offt)) return null;
    const offtTok = offt === 'GGG' ? '' : offt;
    const wa = Array.isArray(elem.wa) ? elem.wa : [];
    const wb = Array.isArray(elem.wb) ? elem.wb : [];
    const tokens = [
      'CBAR',
      asIntToken(elem.eid),
      asIntToken(elem.pid),
      asIntToken(ga),
      asIntToken(gb),
      o1,
      o2,
      o3,
      offtTok,
      intOrBlankDefault(elem.pa, 0),
      intOrBlankDefault(elem.pb, 0),
      realOrBlankDefault(wa[0], 0.0),
      realOrBlankDefault(wa[1], 0.0),
      realOrBlankDefault(wa[2], 0.0),
      realOrBlankDefault(wb[0], 0.0),
      realOrBlankDefault(wb[1], 0.0),
      realOrBlankDefault(wb[2], 0.0),
    ];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWriteCbeamFromIndexes = (rec) => {
    const elem = getElementForRecord(rec, 'CBEAM');
    if (!elem || !Array.isArray(elem.nids) || elem.nids.length !== 2) return null;
    const ga = parseNastranInt(elem.nids[0]);
    const gb = parseNastranInt(elem.nids[1]);
    if (![elem.eid, elem.pid, ga, gb].every((v) => Number.isFinite(parseNastranInt(v)))) return null;
    const [o1, o2, o3] = orientTokensFromElem(elem);

    const intOrBlankDefault = (val, dflt) => {
      const v = parseNastranInt(val);
      if (!Number.isFinite(v)) return '';
      return v === dflt ? '' : asIntToken(v);
    };
    const realOrBlankDefault = (val, dflt) => {
      const v = parseNastranFloat(val);
      if (!Number.isFinite(v)) return '';
      return Math.abs(v - dflt) < 1e-12 ? '' : asRealToken(v);
    };

    const offtRaw = toUpper(parseNastranString(elem.offt) || '');
    const offt = offtRaw || 'GGG';
    if (!ALLOWED_BAR_BEAM_OFFT.has(offt)) return null;
    const offtTok = offt === 'GGG' ? '' : offt;

    const wa = Array.isArray(elem.wa) ? elem.wa : [];
    const wb = Array.isArray(elem.wb) ? elem.wb : [];
    const tokens = [
      'CBEAM',
      asIntToken(elem.eid),
      asIntToken(elem.pid),
      asIntToken(ga),
      asIntToken(gb),
      o1,
      o2,
      o3,
      offtTok,
      intOrBlankDefault(elem.pa, 0),
      intOrBlankDefault(elem.pb, 0),
      realOrBlankDefault(wa[0], 0.0),
      realOrBlankDefault(wa[1], 0.0),
      realOrBlankDefault(wa[2], 0.0),
      realOrBlankDefault(wb[0], 0.0),
      realOrBlankDefault(wb[1], 0.0),
      realOrBlankDefault(wb[2], 0.0),
      intOrBlankDefault(elem.sa, 0),
      intOrBlankDefault(elem.sb, 0),
    ];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWriteCbushFromIndexes = (rec) => {
    const elem = getElementForRecord(rec, 'CBUSH');
    if (!elem || !Array.isArray(elem.nids) || elem.nids.length !== 2) return null;
    const ga = parseNastranInt(elem.nids[0]);
    const gb = parseNastranInt(elem.nids[1]);
    if (![elem.eid, elem.pid, ga, gb].every((v) => Number.isFinite(parseNastranInt(v)))) return null;
    const [o1, o2, o3] = orientTokensFromElem(elem);

    const cid = Number.isFinite(parseNastranInt(elem.cid)) ? asIntToken(elem.cid) : '';
    const sVal = parseNastranFloat(elem.s);
    const s = Number.isFinite(sVal) ? (Math.abs(sVal - 0.5) < 1e-12 ? '' : asRealToken(sVal)) : '';
    const ocidVal = parseNastranInt(elem.ocid);
    const ocid = Number.isFinite(ocidVal) ? (ocidVal === -1 ? '' : asIntToken(ocidVal)) : '';
    const si = Array.isArray(elem.si) ? elem.si : [];
    const s1 = Number.isFinite(parseNastranFloat(si[0])) ? asRealToken(si[0]) : '';
    const s2 = Number.isFinite(parseNastranFloat(si[1])) ? asRealToken(si[1]) : '';
    const s3 = Number.isFinite(parseNastranFloat(si[2])) ? asRealToken(si[2]) : '';
    const tokens = [
      'CBUSH',
      asIntToken(elem.eid),
      asIntToken(elem.pid),
      asIntToken(ga),
      asIntToken(gb),
      o1,
      o2,
      o3,
      cid,
      s,
      ocid,
      s1,
      s2,
      s3,
    ];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWriteCtetraFromIndexes = (rec) => {
    const elem = getElementForRecord(rec, 'CTETRA');
    if (!elem || !Array.isArray(elem.nids)) return null;
    if (elem.nids.length !== 4 && elem.nids.length !== 10) return null;
    if (![elem.eid, elem.pid].every((v) => Number.isFinite(parseNastranInt(v)))) return null;
    const nids = elem.nids.map((v) => parseNastranInt(v));
    if (!nids.every((v) => Number.isFinite(v))) return null;
    const tokens = ['CTETRA', asIntToken(elem.eid), asIntToken(elem.pid), ...nids.map((v) => asIntToken(v))];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWriteChexaFromIndexes = (rec) => {
    const elem = getElementForRecord(rec, 'CHEXA');
    if (!elem || !Array.isArray(elem.nids)) return null;
    if (elem.nids.length !== 8 && elem.nids.length !== 20) return null;
    if (![elem.eid, elem.pid].every((v) => Number.isFinite(parseNastranInt(v)))) return null;
    const nids = elem.nids.map((v) => parseNastranInt(v));
    if (!nids.every((v) => Number.isFinite(v))) return null;
    const tokens = ['CHEXA', asIntToken(elem.eid), asIntToken(elem.pid), ...nids.map((v) => asIntToken(v))];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const looksFloatLikeToken = (tok) => {
    if (isBlankToken(tok)) return false;
    const s = String(tok).trim();
    if (!s) return false;
    const looksPackedExp = /^([+-]?(?:\d+\.?\d*|\.?\d+))([+-]\d+)$/.test(s);
    return /[.eEdD]/.test(s) || looksPackedExp;
  };

  const thetaOrMcidToken = (value, sourceToken, explicitToken) => {
    const v = parseNastranFloat(value);
    if (!Number.isFinite(v)) return '';
    if (isBlankToken(sourceToken) && Math.abs(v) <= 1e-12) return '';

    const explicit = String(explicitToken ?? '').trim();
    if (explicit) {
      const ev = parseNastranFloat(explicit);
      if (Number.isFinite(ev) && Math.abs(ev - v) <= 1e-12) return explicit;
    }

    if (looksFloatLikeToken(sourceToken)) return asRealToken(v);
    if (Number.isInteger(v) && v >= 0) return asIntToken(v);
    return asRealToken(v);
  };

  const realOrBlankDefaultToken = (value, dflt, sourceToken) => {
    const v = parseNastranFloat(value);
    if (!Number.isFinite(v)) return '';
    if (isBlankToken(sourceToken) && Math.abs(v - dflt) <= 1e-12) return '';
    return asRealToken(v);
  };

  const intOrBlankDefaultToken = (value, dflt, sourceToken) => {
    const v = parseNastranInt(value);
    if (!Number.isFinite(v)) return '';
    if (isBlankToken(sourceToken) && v === dflt) return '';
    return asIntToken(v);
  };

  const tryWriteQuadraticShellFromIndexes = (rec) => {
    const type = toUpper(rec.name), count = type === 'CTRIA6' ? 6 : type === 'CQUAD8' ? 8 : 0;
    if (!count) return null;
    const elem = getElementForRecord(rec, type);
    if (!elem || !Array.isArray(elem.nids) || elem.nids.length !== count) return null;
    const values = [elem.eid, elem.pid, ...elem.nids].map(parseNastranInt);
    if (!values.every(Number.isFinite)) return null;
    // Regenerate connectivity from authority, preserving optional shell fields
    // in the synchronized source tokens until their semantic editor exists.
    const tail = getHydrationTokens(rec).slice(3 + count);
    return writeCardByTokensWithFormat(rec, [type, ...values.map(asIntToken), ...tail]);
  };

  const tryWriteCtria3FromIndexes = (rec) => {
    const elem = getElementForRecord(rec, 'CTRIA3');
    if (!elem || !Array.isArray(elem.nids) || elem.nids.length !== 3) return null;

    const eid = parseNastranInt(elem.eid);
    const pidParsed = parseNastranInt(elem.pid);
    const pid = Number.isFinite(pidParsed) ? pidParsed : eid;
    const n1 = parseNastranInt(elem.nids[0]);
    const n2 = parseNastranInt(elem.nids[1]);
    const n3 = parseNastranInt(elem.nids[2]);
    if (![eid, pid, n1, n2, n3].every((v) => Number.isFinite(v))) return null;

    const sourceTokens = getHydrationTokens(rec);
    const thetaRaw = elem.theta_mcid ?? elem.thetaMcid;
    const zoffsetRaw = elem.zoffset ?? elem.zoffs;
    const tflagRaw = elem.tflag;
    const tRaw = Array.isArray(elem.t) ? elem.t : (Array.isArray(elem.T) ? elem.T : []);

    const thetaTok = thetaOrMcidToken(thetaRaw, sourceTokens[6], elem.thetaToken);
    const zoffsetTok = realOrBlankDefaultToken(zoffsetRaw, 0.0, sourceTokens[7]);
    const tflagTok = intOrBlankDefaultToken(tflagRaw, 0, sourceTokens[10]);
    const t1Tok = Number.isFinite(parseNastranFloat(tRaw[0])) ? asRealToken(tRaw[0]) : '';
    const t2Tok = Number.isFinite(parseNastranFloat(tRaw[1])) ? asRealToken(tRaw[1]) : '';
    const t3Tok = Number.isFinite(parseNastranFloat(tRaw[2])) ? asRealToken(tRaw[2]) : '';

    const tokens = [
      'CTRIA3',
      asIntToken(eid),
      asIntToken(pid),
      asIntToken(n1),
      asIntToken(n2),
      asIntToken(n3),
      thetaTok,
      zoffsetTok,
      '',
      '',
      tflagTok,
      t1Tok,
      t2Tok,
      t3Tok,
    ];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const tryWriteCquad4FromIndexes = (rec) => {
    const elem = getElementForRecord(rec, 'CQUAD4');
    if (!elem || !Array.isArray(elem.nids) || elem.nids.length !== 4) return null;

    const eid = parseNastranInt(elem.eid);
    const pidParsed = parseNastranInt(elem.pid);
    const pid = Number.isFinite(pidParsed) ? pidParsed : eid;
    const n1 = parseNastranInt(elem.nids[0]);
    const n2 = parseNastranInt(elem.nids[1]);
    const n3 = parseNastranInt(elem.nids[2]);
    const n4 = parseNastranInt(elem.nids[3]);
    if (![eid, pid, n1, n2, n3, n4].every((v) => Number.isFinite(v))) return null;

    const sourceTokens = getHydrationTokens(rec);
    const thetaRaw = elem.theta_mcid ?? elem.thetaMcid;
    const zoffsetRaw = elem.zoffset ?? elem.zoffs;
    const tflagRaw = elem.tflag;
    const tRaw = Array.isArray(elem.t) ? elem.t : (Array.isArray(elem.T) ? elem.T : []);

    const thetaTok = thetaOrMcidToken(thetaRaw, sourceTokens[7], elem.thetaToken);
    const zoffsetTok = realOrBlankDefaultToken(zoffsetRaw, 0.0, sourceTokens[8]);
    const tflagTok = intOrBlankDefaultToken(tflagRaw, 0, sourceTokens[10]);
    const t1Tok = Number.isFinite(parseNastranFloat(tRaw[0])) ? asRealToken(tRaw[0]) : '';
    const t2Tok = Number.isFinite(parseNastranFloat(tRaw[1])) ? asRealToken(tRaw[1]) : '';
    const t3Tok = Number.isFinite(parseNastranFloat(tRaw[2])) ? asRealToken(tRaw[2]) : '';
    const t4Tok = Number.isFinite(parseNastranFloat(tRaw[3])) ? asRealToken(tRaw[3]) : '';

    const tokens = [
      'CQUAD4',
      asIntToken(eid),
      asIntToken(pid),
      asIntToken(n1),
      asIntToken(n2),
      asIntToken(n3),
      asIntToken(n4),
      thetaTok,
      zoffsetTok,
      '',
      tflagTok,
      t1Tok,
      t2Tok,
      t3Tok,
      t4Tok,
    ];
    return writeCardByTokensWithFormat(rec, tokens);
  };

  const normalizeFreeNumber = (n) => {
    const v = typeof n === 'number' ? n : parseNastranFloat(n);
    if (!Number.isFinite(v)) return '';
    if (Object.is(v, -0)) return '0';
    if (Number.isInteger(v)) return String(v);
    // Keep JS-native formatting (deterministic enough for our use) but avoid leading '.'
    const s = String(v);
    if (s.startsWith('-.')) return '-0.' + s.slice(2);
    if (s.startsWith('.')) return '0' + s;
    return s;
  };

  const formatFreeLine = (tokens, trimTrailing = true) => {
    let slice = tokens;
    if (trimTrailing) {
      // Trim trailing empty tokens only on the final physical line.
      let end = tokens.length;
      while (end > 0) {
        const t = tokens[end - 1];
        if (t == null) { end--; continue; }
        const s = String(t);
        if (s.length === 0) { end--; continue; }
        break;
      }
      slice = tokens.slice(0, end);
    }
    return slice.map((t) => (t == null ? '' : String(t))).join(',');
  };

  const formatFreeLines = (tokens, chunkSize = 8) => {
    if (!Array.isArray(tokens) || tokens.length === 0) return [];
    if (tokens.length <= 1 + chunkSize) return [formatFreeLine(tokens)];
    /** @type {string[]} */
    const lines = [];
    // Match pyNastran free-field segmentation:
    // first line -> card name + 8 data fields
    // continuation -> '+' + 8 data fields
    lines.push(formatFreeLine(tokens.slice(0, 1 + chunkSize), false));
    let idx = 1 + chunkSize;
    while (idx < tokens.length) {
      const seg = tokens.slice(idx, idx + chunkSize);
      const isLast = idx + chunkSize >= tokens.length;
      lines.push(formatFreeLine(['+', ...seg], isLast));
      idx += chunkSize;
    }
    return lines;
  };

  const formatSmallFieldLinesFromTokens = (tokens, contId = '+') => {
    // FEMAP-style small-field output:
    // - first line: NAME(8) + 8 fields (cols 9-72) + optional continuation id in cols 73-80
    // - continuation lines: CONTID(8) + 8 fields + optional CONTID marker in cols 73-80
    if (!Array.isArray(tokens) || tokens.length === 0) return null;

    const rawName = toUpper(tokens[0]);
    if (!rawName) return null;
    const cardName = rawName.endsWith('*') ? rawName.slice(0, -1) : rawName;

    const looksPackedExp = (s) => /^([+-]?(?:\d+\.?\d*|\.?\d+))([+-]\d+)$/.test(s);

    const coerceField8 = (tok) => {
      if (isBlankToken(tok)) return null;
      const s = String(tok).trim();
      if (s.length === 0) return null;

      // Treat float-like tokens as float even if integer-valued (e.g. '90.').
      const floatLike = /[.eEdD]/.test(s) || looksPackedExp(s);

      const asInt = parseNastranInt(s);
      if (!floatLike && Number.isFinite(asInt)) return { kind: 'int', v: asInt };

      const asFloat = parseNastranFloat(s);
      if (Number.isFinite(asFloat)) return { kind: 'float', v: asFloat };

      return { kind: 'string', v: s };
    };

    /** @type {({kind:'int'|'float'|'string', v:any} | null)[]} */
    const fields = [];
    for (let i = 1; i < tokens.length; i++) fields.push(coerceField8(tokens[i]));

    // wipe_empty_fields: trim trailing blanks
    while (fields.length > 0 && fields[fields.length - 1] == null) fields.pop();

    const fmtField8 = (f) => {
      if (!f) return ' '.repeat(8);
      if (f.kind === 'int') {
        const s = String(f.v);
        if (s.length > 8) return '********';
        return s.padStart(8, ' ');
      }
      if (f.kind === 'float') {
        return formatFloat8(f.v);
      }
      const s = String(f.v ?? '');
      if (s.length === 0) return ' '.repeat(8);
      if (s.length > 8) return '********';
      return s.padStart(8, ' ');
    };

    // Detect overflow
    for (const f of fields) {
      const tok = fmtField8(f);
      if (tok === '********') return null;
    }

    const cont = formatString(contId || '+', 8);

    /** @type {string[]} */
    const out = [];
    if (fields.length <= 8) {
      let line = formatString(cardName, 8);
      for (let i = 0; i < fields.length; i++) line += fmtField8(fields[i]);
      out.push(rstripSpaces(line));
      return out;
    }

    // First line: 8 fields + continuation marker
    let idx = 0;
    let line1 = formatString(cardName, 8);
    for (let k = 0; k < 8; k++, idx++) line1 += fmtField8(fields[idx] ?? null);
    line1 += cont;
    out.push(rstripSpaces(line1));

    while (idx < fields.length) {
      let line = cont;
      for (let k = 0; k < 8 && idx < fields.length; k++, idx++) line += fmtField8(fields[idx]);
      if (idx < fields.length) line += cont;
      out.push(rstripSpaces(line));
    }

    return out;
  };

  const formatLargeFieldLinesFromTokens = (tokens) => {
    // Match pyNastran print_card_16 semantics (field_writer_16.py):
    // - wipe_empty_fields (trim trailing blanks)
    // - pad payload to 8-field blocks
    // - wrap every 4 fields with "\n*       " continuation starts
    // - final rstrip(' *') and trailing '\n'
    if (!Array.isArray(tokens) || tokens.length === 0) return null;

    const rawName = toUpper(tokens[0]);
    if (!rawName) return null;
    const cardName = rawName.endsWith('*') ? rawName.slice(0, -1) : rawName;

    const coerceField16 = (tok) => {
      if (isBlankToken(tok)) return null;
      const s = String(tok).trim();
      if (s.length === 0) return null;

      // IMPORTANT:
      // JS Numbers don't preserve "float vs int" intent (e.g. parseFloat('0.') === 0),
      // but for Nastran, lexical style can matter and we must keep it for exact-text
      // comparisons and for dual-meaning fields (e.g. THETA/MCID).
      //
      // If the original token *looks like a float*, preserve that intent explicitly,
      // even if the numeric value is mathematically an integer.
      const looksPackedExp = /^([+-]?(?:\d+\.?\d*|\.?\d+))([+-]\d+)$/.test(s);
      const floatLike = /[.eEdD]/.test(s) || looksPackedExp;

      if (!floatLike) {
        const asInt = parseNastranInt(s);
        if (Number.isFinite(asInt)) return { kind: 'int', v: asInt };
      }

      const asFloat = parseNastranFloat(s);
      if (Number.isFinite(asFloat)) return { kind: floatLike ? 'float' : 'number', v: asFloat };

      return s;
    };

    /** @type {(string|number|null)[]} */
    let fields = [cardName];
    for (let i = 1; i < tokens.length; i++) {
      fields.push(coerceField16(tokens[i]));
    }

    // wipe_empty_fields: trim trailing blanks
    while (fields.length > 1) {
      const v = fields[fields.length - 1];
      if (v == null) { fields.pop(); continue; }
      if (typeof v === 'string' && v.trim() === '') { fields.pop(); continue; }
      break;
    }

    const payload = fields.slice(1);

    const printField16 = (v) => {
      if (v == null) return ' '.repeat(16);

      // Typed numeric wrapper from coerceField16 (preserves float-like intent).
      if (typeof v === 'object' && v && typeof v.kind === 'string' && 'v' in v) {
        const kind = String(v.kind);
        const vv = v.v;
        if (kind === 'int') {
          const n = typeof vv === 'number' ? vv : parseNastranInt(vv);
          if (!Number.isFinite(n)) return ' '.repeat(16);
          const s = String(Math.round(n));
          if (s.length > 16) {
            throw new Error(`WRITE_LARGE_FIELD_OVERFLOW: int token too wide (${s.length}>16) for ${cardName}: "${s}"`);
          }
          return s.padStart(16, ' ');
        }
        // 'float' or generic numeric: always render via float formatter to preserve '.' style.
        const n = typeof vv === 'number' ? vv : parseNastranFloat(vv);
        if (!Number.isFinite(n)) return ' '.repeat(16);
        const s = formatFloat16(n);
        if (String(s).length !== 16) {
          throw new Error(`WRITE_LARGE_FIELD_INTERNAL: formatFloat16 did not return 16 chars for ${cardName}: "${String(s)}"`);
        }
        return s;
      }

      if (typeof v === 'number') {
        if (!Number.isFinite(v)) return ' '.repeat(16);
        if (Number.isInteger(v)) {
          const s = String(v);
          if (s.length > 16) {
            throw new Error(`WRITE_LARGE_FIELD_OVERFLOW: int token too wide (${s.length}>16) for ${cardName}: "${s}"`);
          }
          return s.padStart(16, ' ');
        }
        const s = formatFloat16(v);
        if (String(s).length !== 16) {
          throw new Error(`WRITE_LARGE_FIELD_INTERNAL: formatFloat16 did not return 16 chars for ${cardName}: "${String(s)}"`);
        }
        return s;
      }

      const s = String(v);
      if (s.length === 0) return ' '.repeat(16);
      if (s.length > 16) {
        throw new Error(`WRITE_LARGE_FIELD_OVERFLOW: token too wide (${s.length}>16) for ${cardName}: "${s}"`);
      }
      return s.padStart(16, ' ');
    };

    // pyNastran pads to 8 payload fields before line-wrap.
    const nfieldsMain = payload.length;
    const nbdfLines = Math.ceil(nfieldsMain / 8);
    const nextra = (8 * nbdfLines) - nfieldsMain;
    const padded = payload.slice();
    for (let i = 0; i < nextra; i++) padded.push(null);

    let out = formatString(cardName + '*', 8);
    for (let i = 0; i < padded.length; i++) {
      out += printField16(padded[i]);
      if (((i + 1) % 4) === 0) {
        out = rstripSpaces(out);
        if (out.endsWith('\n')) out += '*';
        out += '\n*       ';
      }
    }
    out = out.replace(/[ *]+$/g, '');
    if (!out.endsWith('\n')) out += '\n';
    return out.slice(0, -1).split('\n');
  };

  const writtenSpcSid = new Set();
  const writtenSpc1Sid = new Set();

  const tryWriteSpcFromIndexes = (rec) => {
    if (!rec || rec.kind !== 'card') return null;
    if (!constraints) return null;
    const name = toUpper(rec.name);
    if (name !== 'SPC') return null;

    const t = getHydrationTokens(rec);
    const sid = parseNastranInt(t[1]);
    if (!Number.isFinite(sid)) return null;
    if (writtenSpcSid.has(sid)) return [];

    const arr = constraints.get(sid);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const spcs = arr.filter((x) => x && x.type === 'SPC');
    if (spcs.length === 0) return null;

    /** @type {string[]} */
    const lines = [];
    const mode = writeFormat === 'source' ? inferSourceFormatForRecord(rec) : writeFormat;
    for (let i = 0; i < spcs.length; i += 2) {
      const a = spcs[i];
      const b = spcs[i + 1] || null;

      if (mode === 'small') {
        let line = formatString('SPC', 8);
        line += formatCardField(sid, 8);
        line += formatCardField(a.g ?? null, 8);
        line += formatCardField(String(a.c ?? '0'), 8);
        line += formatCardFloatField(a.d ?? null, 8);
        if (b) {
          line += formatCardField(b.g ?? null, 8);
          line += formatCardField(String(b.c ?? '0'), 8);
          line += formatCardFloatField(b.d ?? null, 8);
        }
        lines.push(rstripSpaces(line));
        continue;
      }

      if (mode === 'large') {
        // Route through the generic large-field writer so padding/continuation
        // behavior matches the rest of the engine.
        const toks = ['SPC', String(sid), String(a.g ?? ''), String(a.c ?? '0'), String(a.d ?? '')];
        if (b) toks.push(String(b.g ?? ''), String(b.c ?? '0'), String(b.d ?? ''));
        const out = formatLargeFieldLinesFromTokens(toks);
        if (out) lines.push(...out);
        continue;
      }

      // Free-field output.
      const tokens = ['SPC', String(sid), String(a.g ?? ''), String(a.c ?? ''), normalizeFreeNumber(a.d)];
      if (b) tokens.push(String(b.g ?? ''), String(b.c ?? ''), normalizeFreeNumber(b.d));
      lines.push(...formatFreeLines(tokens));
    }

    writtenSpcSid.add(sid);
    return lines;
  };

  const normalizeSortedUniqueIds = (idsRaw, minValue = 1) => {
    const ids = Array.isArray(idsRaw)
      ? idsRaw
        .map((v) => (typeof v === 'number' ? v : parseNastranInt(v)))
        .filter((v) => Number.isFinite(v) && v >= minValue)
      : [];
    if (ids.length === 0) return [];
    return Array.from(new Set(ids)).sort((a, b) => a - b);
  };

  const buildThruSegmentsFromIds = (idsRaw, minValue = 1, minRunForThru = 3) => {
    const uniqueSorted = normalizeSortedUniqueIds(idsRaw, minValue);
    if (uniqueSorted.length === 0) return [];

    /** @type {(Array<number|string>)[]} */
    const segments = [];
    for (let i = 0; i < uniqueSorted.length; i++) {
      const start = uniqueSorted[i];
      let end = start;
      while (i + 1 < uniqueSorted.length && uniqueSorted[i + 1] === end + 1) {
        i++;
        end = uniqueSorted[i];
      }

      const runLen = end - start + 1;
      if (runLen >= minRunForThru) {
        segments.push([start, 'THRU', end]);
      } else {
        for (let v = start; v <= end; v++) segments.push([v]);
      }
    }
    return segments;
  };

  const buildSpc1NodeSegments = (nodesRaw) => {
    // SPC1 node ordering is not semantically significant; sort to enable stable THRU compression.
    return buildThruSegmentsFromIds(nodesRaw, 1, 3);
  };

  const flattenSegments = (segments) => {
    /** @type {(number|string)[]} */
    const out = [];
    for (const seg of segments) out.push(...seg);
    return out;
  };

  const tryWriteSpc1FromIndexes = (rec) => {
    if (!rec || rec.kind !== 'card') return null;
    if (!constraints) return null;
    const name = toUpper(rec.name);
    if (name !== 'SPC1') return null;

    const t = getHydrationTokens(rec);
    const sid = parseNastranInt(t[1]);
    if (!Number.isFinite(sid)) return null;
    if (writtenSpc1Sid.has(sid)) return [];

    const arr = constraints.get(sid);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const spc1s = arr.filter((x) => x && x.type === 'SPC1' && Number.isFinite(parseNastranInt(x.sid)));
    if (spc1s.length === 0) return null;

    /** @type {string[]} */
    const lines = [];
    const mode = writeFormat === 'source' ? inferSourceFormatForRecord(rec) : writeFormat;

    for (const s1 of spc1s) {
      const components = String(s1.components ?? '').trim();
      if (components === '0') {
        const hasGridRef = Array.isArray(s1.nodes) && s1.nodes.some((nid) => {
          const id = parseNastranInt(nid);
          return Number.isFinite(id) && nodes && nodes.has(id);
        });
        if (hasGridRef) return null;
      }
      const segments = buildSpc1NodeSegments(s1.nodes);
      const nodeFields = flattenSegments(segments);
      if (!components || nodeFields.length === 0) continue;

      if (mode === 'small') {
        // Small-field (QRG/pyNastran style): 8 fields per physical line after name.
        // First line: SID, C, then up to 6 grid fields. Continuation: blank name, then up to 8 fields.
        let segIdx = 0;
        let line1 = formatString('SPC1', 8);
        line1 += formatCardField(sid, 8);
        line1 += formatCardField(components, 8);

        let remaining = 6;
        while (remaining > 0 && segIdx < segments.length) {
          const seg = segments[segIdx];
          if (seg.length > remaining) break;
          for (const tok of seg) line1 += formatCardField(tok, 8);
          remaining -= seg.length;
          segIdx++;
        }

        lines.push(rstripSpaces(line1));

        while (segIdx < segments.length) {
          let line = '        '; // blank name (8 spaces)
          remaining = 8;
          while (remaining > 0 && segIdx < segments.length) {
            const seg = segments[segIdx];
            if (seg.length > remaining) break;
            for (const tok of seg) line += formatCardField(tok, 8);
            remaining -= seg.length;
            segIdx++;
          }
          lines.push(rstripSpaces(line));
        }
        continue;
      }

      if (mode === 'large') {
        const toks = ['SPC1', String(sid), components, ...nodeFields.map((v) => String(v))];
        const out = formatLargeFieldLinesFromTokens(toks);
        if (out) lines.push(...out);
        continue;
      }

      // Free-field output with '+' continuations.
      const base = ['SPC1', String(sid), components, ...nodeFields.map((v) => String(v))];
      lines.push(...formatFreeLines(base));
    }

    writtenSpc1Sid.add(sid);
    return lines;
  };

  const flushRemainingConstraints = () => {
    if (!constraints) return;
    const sids = Array.from(constraints.keys())
      .map((k) => parseNastranInt(k))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);

    for (const sid of sids) {
      const arr = constraints.get(sid);
      if (!Array.isArray(arr) || arr.length === 0) continue;

      // If there was no source record for these constraints, choose a stable default
      // for 'source' mode (short/8).
      const mode = writeFormat === 'source' ? 'small' : writeFormat;

      if (!writtenSpcSid.has(sid)) {
        const spcs = arr.filter((x) => x && x.type === 'SPC');
        if (spcs.length) {
          for (let i = 0; i < spcs.length; i += 2) {
            const a = spcs[i];
            const b = spcs[i + 1] || null;
            if (mode === 'small') {
              let line = formatString('SPC', 8);
              line += formatCardField(sid, 8);
              line += formatCardField(a.g ?? null, 8);
              line += formatCardField(String(a.c ?? '0'), 8);
              line += formatCardFloatField(a.d ?? null, 8);
              if (b) {
                line += formatCardField(b.g ?? null, 8);
                line += formatCardField(String(b.c ?? '0'), 8);
                line += formatCardFloatField(b.d ?? null, 8);
              }
              outLines.push(rstripSpaces(line));
            } else if (mode === 'large') {
              let line1 = formatString('SPC*', 8);
              line1 += formatCardField(sid, 16);
              line1 += formatCardField(a.g ?? null, 16);
              line1 += formatCardField(String(a.c ?? '0'), 16);
              line1 += formatCardFloatField(a.d ?? null, 16);
              outLines.push(rstripSpaces(line1));
              if (b) {
                let line2 = '*       ';
                line2 += formatCardField(b.g ?? null, 16);
                line2 += formatCardField(String(b.c ?? '0'), 16);
                line2 += formatCardFloatField(b.d ?? null, 16);
                line2 += ' '.repeat(16);
                outLines.push(rstripSpaces(line2));
              }
            } else {
              const tokens = ['SPC', String(sid), String(a.g ?? ''), String(a.c ?? ''), normalizeFreeNumber(a.d)];
              if (b) tokens.push(String(b.g ?? ''), String(b.c ?? ''), normalizeFreeNumber(b.d));
              outLines.push(...formatFreeLines(tokens));
            }
          }
          writtenSpcSid.add(sid);
        }
      }

      if (!writtenSpc1Sid.has(sid)) {
        const spc1s = arr.filter((x) => x && x.type === 'SPC1');
        if (spc1s.length) {
          for (const s1 of spc1s) {
            const components = String(s1.components ?? '').trim();
            if (components === '0') {
              const hasGridRef = Array.isArray(s1.nodes) && s1.nodes.some((nid) => {
                const id = parseNastranInt(nid);
                return Number.isFinite(id) && nodes && nodes.has(id);
              });
              if (hasGridRef) {
                throw new Error(`WRITE_TARGET_CARD_FAILED: SPC1 sid ${sid} uses component 0/blank with GRID ids; scalar points require C=0/blank.`);
              }
            }
            const segments = buildSpc1NodeSegments(s1.nodes);
            const nodeFields = flattenSegments(segments);
            if (!components || nodeFields.length === 0) continue;
            if (mode === 'small') {
              let segIdx = 0;
              let line1 = formatString('SPC1', 8);
              line1 += formatCardField(sid, 8);
              line1 += formatCardField(components, 8);

              let remaining = 6;
              while (remaining > 0 && segIdx < segments.length) {
                const seg = segments[segIdx];
                if (seg.length > remaining) break;
                for (const tok of seg) line1 += formatCardField(tok, 8);
                remaining -= seg.length;
                segIdx++;
              }

              outLines.push(rstripSpaces(line1));

              while (segIdx < segments.length) {
                let line = '        ';
                remaining = 8;
                while (remaining > 0 && segIdx < segments.length) {
                  const seg = segments[segIdx];
                  if (seg.length > remaining) break;
                  for (const tok of seg) line += formatCardField(tok, 8);
                  remaining -= seg.length;
                  segIdx++;
                }
                outLines.push(rstripSpaces(line));
              }
            } else if (mode === 'large') {
              const toks = ['SPC1', String(sid), components, ...nodeFields.map((v) => String(v))];
              const out = formatLargeFieldLinesFromTokens(toks);
              if (out) outLines.push(...out);
            } else {
              const base = ['SPC1', String(sid), components, ...nodeFields.map((v) => String(v))];
              outLines.push(...formatFreeLines(base));
            }
          }
          writtenSpc1Sid.add(sid);
        }
      }
    }
  };

  /** @type {string[]} */
  const outLines = [];
  if (!cardStream) {
    outLines.push('$ WRITE_REQUEST missing model.cardStream');
  } else {
    let inBulkWrite = false;
    for (const rec of cardStream) {
      if (!rec || typeof rec !== 'object') {
        outLines.push('$ <invalid record>');
        continue;
      }
      const kind = String(rec.kind || '');
      if (kind === 'card' && semanticFamilyForCardName(rec.name) === 'elements' && excludedElements.has(parseNastranInt(getHydrationTokens(rec)[1]))) continue;

      if (kind === 'blank') {
        outLines.push('');
        continue;
      }
      if (kind === 'comment') {
        outLines.push(String(rec.raw ?? ''));
        continue;
      }

      if (kind === 'raw' && /^\s*BEGIN\s+BULK\s*$/i.test(rec.raw || '')) {
        outLines.push('BEGIN BULK'); inBulkWrite = true; continue;
      }
      if (kind === 'card') {
        const upperName = toUpper(rec.name);
        if (upperName === 'BEGIN BULK') {
          outLines.push('BEGIN BULK');
          inBulkWrite = true;
          continue;
        }
        if (upperName === 'ENDDATA') {
          // If the user added new constraints (no existing records), emit them
          // before ENDDATA to keep the deck bulk-data-valid.
          flushRemainingConstraints();
          outLines.push('ENDDATA');
          inBulkWrite = false;
          continue;
        }

        const spcLines = tryWriteSpcFromIndexes(rec);
        if (spcLines) {
          outLines.push(...spcLines);
          continue;
        }

        const spc1Lines = tryWriteSpc1FromIndexes(rec);
        if (spc1Lines) {
          outLines.push(...spc1Lines);
          continue;
        }

        const pshellLines = tryWritePshellFromIndexes(rec);
        if (pshellLines) {
          outLines.push(...pshellLines);
          continue;
        }

        const prodLines = tryWriteProdFromIndexes(rec);
        if (prodLines) {
          outLines.push(...prodLines);
          continue;
        }

        const mat1Lines = tryWriteMat1FromIndexes(rec);
        if (mat1Lines) {
          outLines.push(...mat1Lines);
          continue;
        }

        const psolidLines = tryWritePsolidFromIndexes(rec);
        if (psolidLines) {
          outLines.push(...psolidLines);
          continue;
        }

        const conm2Lines = tryWriteConm2FromIndexes(rec);
        if (conm2Lines) {
          outLines.push(...conm2Lines);
          continue;
        }

        const cpentaLines = tryWriteCpentaFromIndexes(rec);
        if (cpentaLines) {
          outLines.push(...cpentaLines);
          continue;
        }

        const cpyramLines = tryWriteCpyramFromIndexes(rec);
        if (cpyramLines) {
          outLines.push(...cpyramLines);
          continue;
        }

        const crodLines = tryWriteCrodFromIndexes(rec);
        if (crodLines) {
          outLines.push(...crodLines);
          continue;
        }

        const cbarLines = tryWriteCbarFromIndexes(rec);
        if (cbarLines) {
          outLines.push(...cbarLines);
          continue;
        }

        const cbeamLines = tryWriteCbeamFromIndexes(rec);
        if (cbeamLines) {
          outLines.push(...cbeamLines);
          continue;
        }

        const cbushLines = tryWriteCbushFromIndexes(rec);
        if (cbushLines) {
          outLines.push(...cbushLines);
          continue;
        }

        const ctetraLines = tryWriteCtetraFromIndexes(rec);
        if (ctetraLines) {
          outLines.push(...ctetraLines);
          continue;
        }

        const chexaLines = tryWriteChexaFromIndexes(rec);
        if (chexaLines) {
          outLines.push(...chexaLines);
          continue;
        }

        const quadraticShellLines = tryWriteQuadraticShellFromIndexes(rec);
        if (quadraticShellLines) { outLines.push(...quadraticShellLines); continue; }

        const ctria3Lines = tryWriteCtria3FromIndexes(rec);
        if (ctria3Lines) {
          outLines.push(...ctria3Lines);
          continue;
        }

        const cquad4Lines = tryWriteCquad4FromIndexes(rec);
        if (cquad4Lines) {
          outLines.push(...cquad4Lines);
          continue;
        }

        const gridLines = tryWriteGridFromIndexes(rec);
        if (gridLines) {
          outLines.push(...gridLines);
          continue;
        }

        const cord1rLines = tryWriteCord1ByNodesFromIndexes(rec, 'CORD1R');
        if (cord1rLines) {
          outLines.push(...cord1rLines);
          continue;
        }
        const cord1cLines = tryWriteCord1ByNodesFromIndexes(rec, 'CORD1C');
        if (cord1cLines) {
          outLines.push(...cord1cLines);
          continue;
        }
        const cord2rLines = tryWriteCord2ByPointsFromIndexes(rec, 'CORD2R');
        if (cord2rLines) {
          outLines.push(...cord2rLines);
          continue;
        }
        const cord2cLines = tryWriteCord2ByPointsFromIndexes(rec, 'CORD2C');
        if (cord2cLines) {
          outLines.push(...cord2cLines);
          continue;
        }
        const cord2sLines = tryWriteCord2ByPointsFromIndexes(rec, 'CORD2S');
        if (cord2sLines) {
          outLines.push(...cord2sLines);
          continue;
        }

        const pbarLines = tryWritePbarFromIndexes(rec);
        if (pbarLines) {
          outLines.push(...pbarLines);
          continue;
        }

        const pbushLines = tryWritePbushFromIndexes(rec);
        if (pbushLines) {
          outLines.push(...pbushLines);
          continue;
        }

        const pbeamLines = tryWritePbeamFromIndexes(rec);
        if (pbeamLines) {
          outLines.push(...pbeamLines);
          continue;
        }

        const pcompLines = tryWritePcompFromIndexes(rec);
        if (pcompLines) {
          outLines.push(...pcompLines);
          continue;
        }

        const loadLines = tryWriteLoadFromIndexes(rec);
        if (loadLines) {
          outLines.push(...loadLines);
          continue;
        }

        const forceLines = tryWriteForceFromIndexes(rec);
        if (forceLines) {
          outLines.push(...forceLines);
          continue;
        }

        const momentLines = tryWriteMomentFromIndexes(rec);
        if (momentLines) {
          outLines.push(...momentLines);
          continue;
        }

        const pload2Lines = tryWritePload2FromIndexes(rec);
        if (pload2Lines) {
          outLines.push(...pload2Lines);
          continue;
        }

        const pload4Lines = tryWritePload4FromIndexes(rec);
        if (pload4Lines) {
          outLines.push(...pload4Lines);
          continue;
        }

        const rbe2Lines = tryWriteRbe2FromIndexes(rec);
        if (rbe2Lines) {
          outLines.push(...rbe2Lines);
          continue;
        }

        const rbe3Lines = tryWriteRbe3FromIndexes(rec);
        if (rbe3Lines) {
          outLines.push(...rbe3Lines);
          continue;
        }
      }

      if (kind === 'card') {
        const cardName = toUpper(rec.name);
        const forceStrictWriterCards = new Set([
          'GRID', 'CORD1R', 'CORD1C', 'CORD2R', 'CORD2C', 'CORD2S',
          'PBAR', 'PBUSH', 'PBEAM', 'PCOMP', 'LOAD', 'FORCE', 'MOMENT', 'PLOAD2', 'PLOAD4', 'RBE2', 'RBE3',
          'CROD', 'CBAR', 'CBEAM', 'CBUSH', 'CTETRA', 'CHEXA', 'CPENTA', 'CPYRAM', 'CTRIA3', 'CTRIA6', 'CQUAD4', 'CQUAD8',
          'PSHELL', 'PSOLID', 'PROD', 'MAT1', 'CONM2', 'SPC', 'SPC1'
        ]);

        if (forceStrictWriterCards.has(cardName)) {
          const family = semanticFamilyForCardName(cardName);
          if (allowUntouchedSessionSourcePassThrough && family && !modelFamilyHasOverrides(family)) {
            // Untouched parse-session-backed families can remain on source records until
            // their semantic writer path is explicitly promoted by the editor.
          } else {
          throw new Error(
            `WRITE_TARGET_CARD_FAILED: ${cardName} could not be rendered from semantic indexes at ` +
            `${String(rec && rec.source && rec.source.file ? rec.source.file : 'unknown')}:` +
            `${String(rec && rec.source && rec.source.line ? rec.source.line : '?')}` +
            ` [parseSession=${parseSession ? 'yes' : 'no'}, family=${family || 'unknown'}, modelOverride=${family ? (modelFamilyHasOverrides(family) ? 'yes' : 'no') : 'n/a'}]`
          );
          }
        }

        // Non-target cards remain verbatim passthrough until they are promoted
        // to explicit semantic writer coverage.
      }

      // Emit normalized comma/free-field output for bulk-data cards that are
      // not otherwise re-rendered:
      // - explicit free export
      // - source export when the source record itself is free-field
      // Keep non-bulk text verbatim to avoid corrupting case-control/executive sections.
      const sourceModeForRec = kind === 'card' ? inferSourceFormatForRecord(rec) : 'source';
      const normalizeFreeForRec = writeFormat === 'free' || (writeFormat === 'source' && sourceModeForRec === 'free');
      if (normalizeFreeForRec && kind === 'card' && inBulkWrite) {
        const upperName = toUpper(rec.name);
        if (upperName !== 'BEGIN BULK' && upperName !== 'ENDDATA') {
          const toks = getHydrationTokens(rec);
          if (Array.isArray(toks) && toks.length >= 1) {
            outLines.push(...formatFreeLines(toks));
            continue;
          }
        }
      }

      // If requested, emit large-field (16) output for bulk-data cards we are
      // not otherwise re-rendering. Keep non-bulk text verbatim to avoid
      // corrupting case-control/executive sections.
      if (writeFormat === 'large' && kind === 'card' && inBulkWrite) {
        const upperName = toUpper(rec.name);
        if (upperName !== 'BEGIN BULK' && upperName !== 'ENDDATA') {
          const toks = getHydrationTokens(rec);

          // Match FEMAP/NX golden decks: PARAM cards remain comma (free-field)
          // even in the "longformat" deck.
          const baseName = toUpper(Array.isArray(toks) && toks.length ? toks[0] : '').replace(/\*$/, '');
          if (baseName === 'PARAM') {
            if (Array.isArray(toks) && toks.length >= 1) {
              outLines.push(...formatFreeLines(toks));
              continue;
            }
          }

          const lines = formatLargeFieldLinesFromTokens(toks);
          if (lines && lines.length) {
            outLines.push(...lines);
            continue;
          }

          if (strictWrite && writeFormat !== 'source') {
            throw new Error(
              `WRITE_FORMAT_MISMATCH: cannot honor writeFormat=large for ${upperName} at ` +
              `${String(rec && rec.source && rec.source.file ? rec.source.file : 'unknown')}:` +
              `${String(rec && rec.source && rec.source.line ? rec.source.line : '?')}`
            );
          }
        }
      }

      // If requested, emit small-field (8) output for bulk-data cards we are
      // not otherwise re-rendering. Keep non-bulk text verbatim to avoid
      // corrupting case-control/executive sections.
      if (writeFormat === 'small' && kind === 'card' && inBulkWrite) {
        const upperName = toUpper(rec.name);
        if (upperName !== 'BEGIN BULK' && upperName !== 'ENDDATA') {
          const toks = getHydrationTokens(rec);
          const baseName = toUpper(Array.isArray(toks) && toks.length ? toks[0] : '').replace(/\*$/, '');

          // Match golden decks: PARAM is comma/free-field in the shortformat deck.
          if (baseName === 'PARAM') {
            if (Array.isArray(toks) && toks.length >= 1) {
              outLines.push(...formatFreeLines(toks));
              continue;
            }
          }

          // FEMAP coordinate systems use labeled '+' continuations.
          let contId = '+';
          if (baseName === 'CORD2C' || baseName === 'CORD2S') {
            const cid = Array.isArray(toks) ? parseNastranInt(toks[1]) : null;
            if (Number.isFinite(cid)) contId = `+FEMAPC${cid}`;
          }

          const lines = formatSmallFieldLinesFromTokens(toks, contId);
          if (lines && lines.length) {
            outLines.push(...lines);
            continue;
          }

          if (strictWrite && writeFormat !== 'source') {
            throw new Error(
              `WRITE_FORMAT_MISMATCH: cannot honor writeFormat=small for ${upperName} at ` +
              `${String(rec && rec.source && rec.source.file ? rec.source.file : 'unknown')}:` +
              `${String(rec && rec.source && rec.source.line ? rec.source.line : '?')}`
            );
          }
        }
      }

      // Authored GRAV sets have tokens but no retained source lines.
      if (writeFormat === 'source' && kind === 'card' && inBulkWrite && rec.name === 'GRAV' && !getRecordRawLinesForWrite(rec)?.length) {
        outLines.push(...formatFreeLines(getHydrationTokens(rec)));
        continue;
      }
      const sourceLines = getRecordRawLinesForWrite(rec);
      if (Array.isArray(sourceLines) && sourceLines.length) {
        for (const line of sourceLines) outLines.push(String(line));
        continue;
      }
      if (typeof rec.raw === 'string') {
        outLines.push(rec.raw);
        continue;
      }

      // Best-effort fallback; most tokenizer-produced records should have rawLines.
      if (kind === 'card' && rec.name) {
        outLines.push(`$ <unwritable card without rawLines: ${String(rec.name)}>`);
      } else {
        outLines.push(`$ <unwritable record kind=${kind}>`);
      }
    }
  }


  // If there was no ENDDATA record, append any remaining constraints at end.
  // (Most decks include ENDDATA, but keep this safe.)
  flushRemainingConstraints();

  let text = outLines.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  post('WRITE_COMPLETE', { text });
}

// eslint-disable-next-line no-restricted-globals
// F06 Parsing Logic
function parseF06Results(f06Text) {
  return parseF06ResultsV2(f06Text);
  const lines = f06Text.split(/\r?\n/);
  const results = {
    displacements: {},   // { gridId: { t1, t2, t3, r1, r2, r3 } }
    stresses: {},        // { elementId: { vonMises, normalX, normalY, shearXY, principalMajor, principalMinor, shearXZ, shearYZ, type } }
    strains: {},         // { elementId: { vonMises, normalX, normalY, shearXY, principalMajor, principalMinor, shearXZ, shearYZ, type } }
    elementForces: {},   // { elementId: { type, ...components, magnitude } }
    gpForces: {},        // { gridId: { t1, t2, t3, r1, r2, r3, magnitude } }
    mpcForces: {},       // { gridId: { t1, t2, t3, r1, r2, r3, magnitude } }
    oloadForces: {},     // { gridId: { t1, t2, t3, r1, r2, r3, magnitude } }
    subcaseId: 1
  };

  const parseNum = (v) => {
    if (v == null) return NaN;
    const s = String(v).trim().replace(/[dD]/g, 'E');
    if (!s) return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  };

  const toCompact = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
  const parseTypeFromLines = (startIdx) => {
    for (let j = startIdx; j < Math.min(lines.length, startIdx + 14); j++) {
      const compact = toCompact(lines[j]);
      if (!compact.includes('FORELEMENTTYPE')) continue;
      if (compact.includes('QUAD4')) return 'QUAD4';
      if (compact.includes('TRIA3')) return 'TRIA3';
      if (compact.includes('HEXA')) return 'HEXA';
      if (compact.includes('PENTA')) return 'PENTA';
      if (compact.includes('TETRA')) return 'TETRA';
      if (compact.includes('BUSH')) return 'BUSH';
      if (compact.includes('CBAR') || compact.includes('BAR')) return 'BAR';
      if (compact.includes('CBEAM') || compact.includes('BEAM')) return 'BEAM';
    }
    return 'UNKNOWN';
  };

  const mergeByMaxAbs = (target, values) => {
    for (const [key, val] of Object.entries(values || {})) {
      if (!Number.isFinite(val)) continue;
      if (!Number.isFinite(target[key]) || Math.abs(val) >= Math.abs(target[key])) {
        target[key] = val;
      }
    }
  };

  const withMagnitude = (obj) => {
    const vals = [];
    for (const [key, val] of Object.entries(obj || {})) {
      if (key === 'type' || key === 'coord') continue;
      if (Number.isFinite(val)) vals.push(val);
    }
    const sumSq = vals.reduce((acc, v) => acc + (v * v), 0);
    if (sumSq > 0) obj.magnitude = Math.sqrt(sumSq);
    return obj;
  };

  const assignTensorResult = (targetMap, eid, type, values) => {
    if (!Number.isFinite(eid) || !values || typeof values !== 'object') return;
    const prev = targetMap[eid] && typeof targetMap[eid] === 'object' ? targetMap[eid] : { type };
    const out = { ...prev, type };
    mergeByMaxAbs(out, values);

    if (!Number.isFinite(out.vonMises)) {
      const fallback = [
        out.principalMajor,
        out.principalMinor,
        out.normalX,
        out.normalY,
        out.shearXY,
        out.c1,
        out.c2,
        out.c3,
        out.c4,
        out.c5,
        out.c6
      ]
        .filter((v) => Number.isFinite(v))
        .map((v) => Math.abs(v));
      if (fallback.length) out.vonMises = Math.max(...fallback);
    }

    if (Number.isFinite(out.vonMises)) {
      targetMap[eid] = out;
    }
  };

  const assignVectorByGrid = (targetMap, nid, values) => {
    if (!Number.isFinite(nid) || !values || typeof values !== 'object') return;
    const prev = targetMap[nid] && typeof targetMap[nid] === 'object' ? targetMap[nid] : {};
    const out = { ...prev };
    mergeByMaxAbs(out, values);
    targetMap[nid] = withMagnitude(out);
  };

  const parseGridVectorTable = (targetMap) => {
    let headerIdx = -1;
    for (let j = i; j < Math.min(lines.length, i + 10); j++) {
      const compact = toCompact(lines[j]);
      if (compact.includes('GRID') && compact.includes('COORD') && compact.includes('T1') && compact.includes('R3')) {
        headerIdx = j;
        break;
      }
    }
    if (headerIdx < 0) return;

    i = headerIdx + 1;
    while (i < lines.length) {
      const row = lines[i];
      const trimmed = row.trim();
      if (!trimmed) { i++; continue; }
      if (row.startsWith('1 ') || row.includes('OUTPUT FOR SUBCASE')) { i--; break; }
      if (trimmed.startsWith('MAX*') || trimmed.startsWith('MIN*') || trimmed.startsWith('ABS*')) break;

      const parts = trimmed.split(/\s+/);
      if (parts.length >= 8 && /^\d+$/.test(parts[0]) && /^[-+]?\d+$/.test(parts[1])) {
        const nid = parseInt(parts[0], 10);
        const coord = parseInt(parts[1], 10);
        assignVectorByGrid(targetMap, nid, {
          coord,
          t1: parseNum(parts[2]),
          t2: parseNum(parts[3]),
          t3: parseNum(parts[4]),
          r1: parseNum(parts[5]),
          r2: parseNum(parts[6]),
          r3: parseNum(parts[7])
        });
      }
      i++;
    }
  };

  const parseShellTensorBlock = (targetMap, type) => {
    i++;
    let currentEid = null;
    while (i < lines.length) {
      const row = lines[i];
      const trimmed = row.trim();
      if (!trimmed) { i++; continue; }
      if (row.startsWith('1 ') || row.includes('OUTPUT FOR SUBCASE') || row.includes('>> LINK')) { i--; break; }
      if (trimmed.startsWith('MAX*') || trimmed.startsWith('MIN*') || trimmed.startsWith('ABS*')) { i++; continue; }
      if (/^\s*Elem\s+Location/i.test(row) || /^\s*ID\s+Distance/i.test(row) || /^\s*ID\s+Fibre/i.test(row)) { i++; continue; }

      const parts = trimmed.split(/\s+/);

      if (parts.length >= 12 && /^\d+$/.test(parts[0]) && /^CENTER$/i.test(parts[1])) {
        currentEid = parseInt(parts[0], 10);
        assignTensorResult(targetMap, currentEid, type, {
          fiberDistance: parseNum(parts[2]),
          normalX: parseNum(parts[3]),
          normalY: parseNum(parts[4]),
          shearXY: parseNum(parts[5]),
          principalAngle: parseNum(parts[6]),
          principalMajor: parseNum(parts[7]),
          principalMinor: parseNum(parts[8]),
          vonMises: parseNum(parts[9]),
          shearXZ: parseNum(parts[10]),
          shearYZ: parseNum(parts[11]),
          polyFitErr: parseNum(parts[12])
        });
        i++;
        continue;
      }

      if (Number.isFinite(currentEid) && parts.length >= 12 && /^GRD$/i.test(parts[0])) {
        assignTensorResult(targetMap, currentEid, type, {
          fiberDistance: parseNum(parts[2]),
          normalX: parseNum(parts[3]),
          normalY: parseNum(parts[4]),
          shearXY: parseNum(parts[5]),
          principalAngle: parseNum(parts[6]),
          principalMajor: parseNum(parts[7]),
          principalMinor: parseNum(parts[8]),
          vonMises: parseNum(parts[9]),
          shearXZ: parseNum(parts[10]),
          shearYZ: parseNum(parts[11]),
          polyFitErr: parseNum(parts[12])
        });
        i++;
        continue;
      }

      if (Number.isFinite(currentEid) && parts.length >= 9 && !/^\d+$/.test(parts[0]) && Number.isFinite(parseNum(parts[0]))) {
        assignTensorResult(targetMap, currentEid, type, {
          fiberDistance: parseNum(parts[0]),
          normalX: parseNum(parts[1]),
          normalY: parseNum(parts[2]),
          shearXY: parseNum(parts[3]),
          principalAngle: parseNum(parts[4]),
          principalMajor: parseNum(parts[5]),
          principalMinor: parseNum(parts[6]),
          vonMises: parseNum(parts[7]),
          shearXZ: parseNum(parts[8]),
          shearYZ: parseNum(parts[9]),
          polyFitErr: parseNum(parts[10])
        });
        i++;
        continue;
      }

      i++;
    }
  };

  let i = 0;
  let currentGpForceGrid = null;
  while (i < lines.length) {
    const line = lines[i];
    const cleanLine = line.replace(/\s+/g, '');

    {
      const m = line.match(/OUTPUT\s+FOR\s+SUBCASE\s+(\d+)/i);
      if (m) {
        const sc = parseInt(m[1], 10);
        if (Number.isFinite(sc)) results.subcaseId = sc;
      }
    }

    // Detect Displacement Table — handles both NX/MSC ("DISPLACEMENT VECTOR")
    // and MYSTRAN ("D I S P L A C E M E N T S") output formats.
    if (/D\s*I\s*S\s*P\s*L\s*A\s*C\s*E\s*M\s*E\s*N\s*T/.test(line) &&
      !line.includes('STRESSES') && !line.includes('SPC') && !line.includes('AUTOSPC')) {
      // Skip to column header line (look for POINT ID or GRID within next 5 lines)
      let headerFound = false;
      for (let skip = 1; skip <= 5 && (i + skip) < lines.length; skip++) {
        const hdr = lines[i + skip];
        if (hdr.includes('POINT ID') || hdr.includes('GRID')) {
          i += skip + 1; // Move past column header
          // Some formats have a second header line (e.g. "SYS")
          if (i < lines.length && lines[i].trim().match(/^SYS\b|^$/)) i++;
          headerFound = true;
          break;
        }
      }
      if (headerFound) {
        while (i < lines.length) {
          const row = lines[i];
          if (!row.trim() || row.startsWith('1') || row.includes('---') ||
            row.includes('MAX*') || row.includes('MIN*') || row.includes('ABS*')) break;
          // Guard against running into next table
          if (row.includes('STRESSES') || /D\s*I\s*S\s*P\s*L\s*A\s*C\s*E/.test(row) ||
            row.includes('SPC Force') || row.includes('OLOAD') || row.includes('LINK')) {
            i--; break;
          }

          // Whitespace-split parsing (robust across NX/MSC/MYSTRAN)
          const parts = row.trim().split(/\s+/);
          // First numeric field is grid ID; skip any non-numeric prefix (e.g. coord sys column)
          let startIdx = 0;
          const pointId = parseInt(parts[startIdx], 10);

          if (!isNaN(pointId) && parts.length >= 4) {
            // Find which index holds the first DOF value (could be index 1 or 2 depending on COORD column)
            let dofStart = 1;
            // If parts[1] looks like a coordinate system ID (small integer, usually 0), skip it
            const maybeCoord = parseInt(parts[1], 10);
            if (!isNaN(maybeCoord) && parts.length >= 5 && Math.abs(maybeCoord) < 100) {
              dofStart = 2;
            }

            const t1 = parseFloat(parts[dofStart] || '0') || 0;
            const t2 = parseFloat(parts[dofStart + 1] || '0') || 0;
            const t3 = parseFloat(parts[dofStart + 2] || '0') || 0;
            const r1 = parseFloat(parts[dofStart + 3] || '0') || 0;
            const r2 = parseFloat(parts[dofStart + 4] || '0') || 0;
            const r3 = parseFloat(parts[dofStart + 5] || '0') || 0;

            results.displacements[pointId] = { t1, t2, t3, r1, r2, r3 };
          }
          i++;
        }
      }
    }

    // Applied Forces (OLOAD)
    else if (/A\s*P\s*P\s*L\s*I\s*E\s*D\s+F\s*O\s*R\s*C\s*E\s*S/i.test(line)) {
      parseGridVectorTable(results.oloadForces);
    }

    // MPC Forces
    else if (/M\s*P\s*C\s+F\s*O\s*R\s*C\s*E\s*S/i.test(line)) {
      parseGridVectorTable(results.mpcForces);
    }

    // Grid Point Force Balance (GPFORCE)
    else if (/G\s*R\s*I\s*D\s+P\s*O\s*I\s*N\s*T\s+F\s*O\s*R\s*C\s*E\s+B\s*A\s*L\s*A\s*N\s*C\s*E/i.test(line)) {
      i++;
      while (i < lines.length) {
        const row = lines[i];
        if (!row.trim()) { i++; continue; }
        if (row.startsWith('1 ') || row.includes('OUTPUT FOR SUBCASE')) { i--; break; }

        const gp = row.match(/FORCE\s+BALANCE\s+FOR\s+GRID\s+POINT\s+(\d+)/i);
        if (gp) {
          currentGpForceGrid = parseInt(gp[1], 10);
          i++;
          continue;
        }

        if (/^\s*TOTALS\s*:/i.test(row) && Number.isFinite(currentGpForceGrid)) {
          const nums = row.match(/[+-]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[DE][+-]?\d+)?/gi) || [];
          if (nums.length >= 6) {
            assignVectorByGrid(results.gpForces, currentGpForceGrid, {
              t1: parseNum(nums[nums.length - 6]),
              t2: parseNum(nums[nums.length - 5]),
              t3: parseNum(nums[nums.length - 4]),
              r1: parseNum(nums[nums.length - 3]),
              r2: parseNum(nums[nums.length - 2]),
              r3: parseNum(nums[nums.length - 1])
            });
          }
        }
        i++;
      }
    }

    // Element engineering forces
    else if (/E\s*L\s*E\s*M\s*E\s*N\s*T\s+E\s*N\s*G\s*I\s*N\s*E\s*E\s*R\s*I\s*N\s*G\s+F\s*O\s*R\s*C\s*E\s*S/i.test(line)) {
      const type = parseTypeFromLines(i + 1);
      i++;
      while (i < lines.length) {
        const row = lines[i];
        const trimmed = row.trim();
        if (!trimmed) { i++; continue; }
        if (row.startsWith('1 ') || row.includes('OUTPUT FOR SUBCASE') || row.includes('>> LINK')) { i--; break; }
        if (trimmed.startsWith('MAX*') || trimmed.startsWith('MIN*') || trimmed.startsWith('ABS*') || /TOTALS\s*:/i.test(trimmed)) { i++; continue; }
        if (/^\s*Element\b/i.test(row) || /^\s*ID\b/i.test(row) || /Normal\s+Forces/i.test(row) || /Moment/i.test(row)) { i++; continue; }

        const parts = trimmed.split(/\s+/);
        if (!parts.length || !/^\d+$/.test(parts[0])) { i++; continue; }
        const eid = parseInt(parts[0], 10);

        if (type === 'BUSH' && parts.length >= 7) {
          const out = withMagnitude({
            type,
            fx: parseNum(parts[1]),
            fy: parseNum(parts[2]),
            fz: parseNum(parts[3]),
            mx: parseNum(parts[4]),
            my: parseNum(parts[5]),
            mz: parseNum(parts[6])
          });
          const prev = results.elementForces[eid] && typeof results.elementForces[eid] === 'object' ? results.elementForces[eid] : { type };
          const merged = { ...prev, type };
          mergeByMaxAbs(merged, out);
          results.elementForces[eid] = withMagnitude(merged);
          i++;
          continue;
        }

        if (parts.length >= 9) {
          const out = withMagnitude({
            type,
            nxx: parseNum(parts[1]),
            nyy: parseNum(parts[2]),
            nxy: parseNum(parts[3]),
            mxx: parseNum(parts[4]),
            myy: parseNum(parts[5]),
            mxy: parseNum(parts[6]),
            qx: parseNum(parts[7]),
            qy: parseNum(parts[8])
          });
          const prev = results.elementForces[eid] && typeof results.elementForces[eid] === 'object' ? results.elementForces[eid] : { type };
          const merged = { ...prev, type };
          mergeByMaxAbs(merged, out);
          results.elementForces[eid] = withMagnitude(merged);
        }
        i++;
      }
    }

    // Detect MYSTRAN shell stress table in local element coordinates
    // Example header (spaced chars):
    // E L E M E N T   S T R E S S E S   I N   L O C A L   E L E M E N T   C O O R D I N A T E ...
    else if (/E\s*L\s*E\s*M\s*E\s*N\s*T\s+S\s*T\s*R\s*E\s*S\s*S\s*E\s*S/.test(line) &&
      /L\s*O\s*C\s*A\s*L\s+E\s*L\s*E\s*M\s*E\s*N\s*T\s+C\s*O\s*O\s*R\s*D\s*I\s*N\s*A\s*T\s*E/.test(line)) {
      const type = parseTypeFromLines(i + 1);
      if (type === 'BUSH') {
        i++;
        while (i < lines.length) {
          const row = lines[i];
          const trimmed = row.trim();
          if (!trimmed) { i++; continue; }
          if (row.startsWith('1 ') || row.includes('OUTPUT FOR SUBCASE')) { i--; break; }
          if (trimmed.startsWith('MAX*') || trimmed.startsWith('MIN*') || trimmed.startsWith('ABS*')) { i++; continue; }
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 7 && /^\d+$/.test(parts[0])) {
            const eid = parseInt(parts[0], 10);
            assignTensorResult(results.stresses, eid, type, {
              c1: parseNum(parts[1]),
              c2: parseNum(parts[2]),
              c3: parseNum(parts[3]),
              c4: parseNum(parts[4]),
              c5: parseNum(parts[5]),
              c6: parseNum(parts[6])
            });
          }
          i++;
        }
      } else {
        parseShellTensorBlock(results.stresses, type === 'UNKNOWN' ? 'SHELL' : type);
      }
    }

    // Detect MYSTRAN shell strain table in local element coordinates
    else if (/E\s*L\s*E\s*M\s*E\s*N\s*T\s+S\s*T\s*R\s*A\s*I\s*N\s*S/.test(line) &&
      /L\s*O\s*C\s*A\s*L\s+E\s*L\s*E\s*M\s*E\s*N\s*T\s+C\s*O\s*O\s*R\s*D\s*I\s*N\s*A\s*T\s*E/.test(line)) {
      const type = parseTypeFromLines(i + 1);
      if (type === 'BUSH') {
        i++;
        while (i < lines.length) {
          const row = lines[i];
          const trimmed = row.trim();
          if (!trimmed) { i++; continue; }
          if (row.startsWith('1 ') || row.includes('OUTPUT FOR SUBCASE')) { i--; break; }
          if (trimmed.startsWith('MAX*') || trimmed.startsWith('MIN*') || trimmed.startsWith('ABS*')) { i++; continue; }
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 7 && /^\d+$/.test(parts[0])) {
            const eid = parseInt(parts[0], 10);
            assignTensorResult(results.strains, eid, type, {
              c1: parseNum(parts[1]),
              c2: parseNum(parts[2]),
              c3: parseNum(parts[3]),
              c4: parseNum(parts[4]),
              c5: parseNum(parts[5]),
              c6: parseNum(parts[6])
            });
          }
          i++;
        }
      } else {
        parseShellTensorBlock(results.strains, type === 'UNKNOWN' ? 'SHELL' : type);
      }
    }

    // Detect CQUAD4/CTRIA3 Stress Table
    // Pattern: STRESSESIN...ELEMENTS(QUAD4/TRIA3)
    else if (cleanLine.includes('STRESSESIN') && cleanLine.includes('ELEMENTS') &&
      (cleanLine.includes('(QUAD4)') || cleanLine.includes('(TRIA3)'))) {
      const type = cleanLine.includes('QUAD4') ? 'QUAD4' : 'TRIA3';

      i++;
      // Dynamic header skip
      while (i < lines.length) {
        const row = lines[i];
        if (!row.trim()) { i++; continue; }
        // Stop if new table
        if (row.replace(/\s+/g, '').includes('STRESSESIN')) {
          i--; break;
        }
        // Skip secondary headers
        if (row.includes('ELEMENT') || row.includes('FIBER') || row.includes('GRID-ID') || row.includes('Action')) {
          i++; continue;
        }
        break; // Data start
      }

      while (i < lines.length) {
        const row = lines[i];
        if (!row.trim() || row.startsWith('1')) break;
        if (row.includes('STRESSES') || row.includes('DISPLACEMENT')) { i--; break; }

        // Check for CEN/4 or CEN/3 row (Centroid stress)
        if (row.includes('CEN/4') || row.includes('CEN/3')) {
          const parts = row.trim().split(/\s+/);
          // Last column is Von Mises
          const vonMises = parseFloat(parts[parts.length - 1]);

          let eidStr = parts[0];
          if (eidStr === '0') eidStr = parts[1];
          const eid = parseInt(eidStr, 10);

          if (!isNaN(eid) && !isNaN(vonMises)) {
            assignTensorResult(results.stresses, eid, type, { vonMises });
          }
        }
        i++;
      }
    }

    // Detect CHEXA/CPENTA/CTETRA Stress Table
    else if (cleanLine.includes('STRESSESIN') && cleanLine.includes('ELEMENTS') &&
      (cleanLine.includes('(HEXA)') || cleanLine.includes('(PENTA)') || cleanLine.includes('(TETRA)'))) {
      let type = 'SOLID';
      if (cleanLine.includes('HEXA')) type = 'HEXA';
      if (cleanLine.includes('PENTA')) type = 'PENTA';
      if (cleanLine.includes('TETRA')) type = 'TETRA';

      i += 2; // Skip headers (Title + 1 line usually)
      while (i < lines.length) {
        const row = lines[i];
        if (!row.trim() || row.startsWith('1')) break;
        if (row.includes('STRESSES') || row.includes('DISPLACEMENT')) { i--; break; }

        // Look for CENTER row
        // 0         1           0GRID CS  8 GP
        const eidMatch = row.match(/^\s*0\s+(\d+)\s+/);
        if (eidMatch) {
          const currentEid = parseInt(eidMatch[1], 10);
          // Verify next line is CENTER
          if (i + 1 < lines.length && lines[i + 1].includes('CENTER')) {
            const centerRow = lines[i + 1];
            const parts = centerRow.trim().split(/\s+/);
            const vmStr = parts[parts.length - 1];
            const vonMises = parseFloat(vmStr);
            if (!isNaN(vonMises)) {
              assignTensorResult(results.stresses, currentEid, type, { vonMises });
            }
          }
        }
        i++;
      }
    }

    // Detect CBAR/CBEAM Stress
    else if (cleanLine.includes('STRESSESIN') && cleanLine.includes('ELEMENTS') &&
      (cleanLine.includes('(CBAR)') || cleanLine.includes('(CBEAM)') || cleanLine.includes('(BAR)') || cleanLine.includes('(BEAM)'))) {
      const type = cleanLine.includes('BEAM') ? 'BEAM' : 'BAR';
      i += 2;
      while (i < lines.length) {
        const row = lines[i];
        if (!row.trim() || row.startsWith('1')) break;
        if (row.includes('STRESSES') || row.includes('DISPLACEMENT')) { i--; break; }

        const parts = row.trim().split(/\s+/);
        let eidStr = parts[0];
        let valStart = 1;
        if (eidStr === '0') { eidStr = parts[1]; valStart = 2; }
        const eid = parseInt(eidStr, 10);

        // Find max stress value in the line
        let maxStress = 0;
        for (let k = valStart; k < parts.length; k++) {
          const v = Math.abs(parseFloat(parts[k]));
          if (!isNaN(v) && v > maxStress) maxStress = v;
        }
        assignTensorResult(results.stresses, eid, type, { vonMises: maxStress });
        i++;
      }
    }

    i++;
  }

  return results;
}

function parseF06ResultsV2(f06Text) {
  const lines = String(f06Text || '').split(/\r?\n/);
  const results = {
    displacements: {},
    stresses: {},
    strains: {},
    elementForces: {},
    gpForces: {},
    mpcForces: {},
    oloadForces: {},
    subcaseId: 1,
    activeSetId: '',
    resultSets: [],
    eigenSummaries: []
  };

  const parseNum = (v) => {
    if (v == null) return NaN;
    const s = String(v).trim().replace(/[dD]/g, 'E');
    if (!s) return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  };

  const toCompact = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
  const parseTypeFromLines = (startIdx) => {
    for (let j = startIdx; j < Math.min(lines.length, startIdx + 14); j++) {
      const compact = toCompact(lines[j]);
      if (!compact.includes('FORELEMENTTYPE')) continue;
      if (compact.includes('QUAD4')) return 'QUAD4';
      if (compact.includes('TRIA3')) return 'TRIA3';
      if (compact.includes('HEXA')) return 'HEXA';
      if (compact.includes('PENTA')) return 'PENTA';
      if (compact.includes('TETRA')) return 'TETRA';
      if (compact.includes('BUSH')) return 'BUSH';
      if (compact.includes('CBAR') || compact.includes('BAR')) return 'BAR';
      if (compact.includes('CBEAM') || compact.includes('BEAM')) return 'BEAM';
    }
    return 'UNKNOWN';
  };

  const mergeByMaxAbs = (target, values) => {
    for (const [key, val] of Object.entries(values || {})) {
      if (!Number.isFinite(val)) continue;
      if (!Number.isFinite(target[key]) || Math.abs(val) >= Math.abs(target[key])) {
        target[key] = val;
      }
    }
  };

  const withMagnitude = (obj) => {
    const vals = [];
    for (const [key, val] of Object.entries(obj || {})) {
      if (key === 'type' || key === 'coord') continue;
      if (Number.isFinite(val)) vals.push(val);
    }
    const sumSq = vals.reduce((acc, v) => acc + (v * v), 0);
    if (sumSq > 0) obj.magnitude = Math.sqrt(sumSq);
    return obj;
  };

  const createResultSet = (meta = {}) => ({
    setId: String(meta.setId || ''),
    kind: String(meta.kind || 'subcase'),
    label: String(meta.label || ''),
    subcaseId: Number.isFinite(Number(meta.subcaseId)) ? Number(meta.subcaseId) : null,
    outputSetId: Number.isFinite(Number(meta.outputSetId)) ? Number(meta.outputSetId) : null,
    modeNumber: Number.isFinite(Number(meta.modeNumber)) ? Number(meta.modeNumber) : null,
    eigenvectorNumber: Number.isFinite(Number(meta.eigenvectorNumber)) ? Number(meta.eigenvectorNumber) : null,
    eigenvalue: Number.isFinite(Number(meta.eigenvalue)) ? Number(meta.eigenvalue) : NaN,
    loadFactor: Number.isFinite(Number(meta.loadFactor)) ? Number(meta.loadFactor) : NaN,
    radians: Number.isFinite(Number(meta.radians)) ? Number(meta.radians) : NaN,
    cycles: Number.isFinite(Number(meta.cycles)) ? Number(meta.cycles) : NaN,
    generalizedMass: Number.isFinite(Number(meta.generalizedMass)) ? Number(meta.generalizedMass) : NaN,
    generalizedStiffness: Number.isFinite(Number(meta.generalizedStiffness)) ? Number(meta.generalizedStiffness) : NaN,
    displacements: {},
    stresses: {},
    strains: {},
    elementForces: {},
    gpForces: {},
    mpcForces: {},
    oloadForces: {}
  });

  const resultSetMap = new Map();
  let currentSet = null;
  let lastSubcaseId = 1;
  let currentGpForceGrid = null;
  let currentEigenSummary = null;
  let nextEigenSummaryId = 1;

  const formatSetLabel = (set) => {
    if (!set) return 'Results';
    if (set.kind === 'eigenvector') {
      const mode = Number.isFinite(set.modeNumber) ? set.modeNumber : set.eigenvectorNumber;
      if (Number.isFinite(set.loadFactor)) {
        return `Buckling Mode ${mode != null ? mode : '?'} (LF ${Number(set.loadFactor).toPrecision(6)})`;
      }
      if (Number.isFinite(set.cycles)) {
        return `Mode ${mode != null ? mode : '?'} (${Number(set.cycles).toPrecision(6)} cycles)`;
      }
      if (Number.isFinite(set.eigenvalue)) {
        return `Eigenvector ${mode != null ? mode : '?'} (${Number(set.eigenvalue).toPrecision(6)})`;
      }
      return `Eigenvector ${mode != null ? mode : '?'}`;
    }
    if (Number.isFinite(set.subcaseId)) return `Subcase ${set.subcaseId}`;
    return 'Results';
  };

  const isOutputSetBoundary = (row) => /OUTPUT\s+FOR\s+(?:SUBCASE|EIGENVECTOR)/i.test(String(row || ''));
  const isSetPopulated = (set) => !!(
    set
    && (
      Object.keys(set.displacements || {}).length
      || Object.keys(set.stresses || {}).length
      || Object.keys(set.strains || {}).length
      || Object.keys(set.elementForces || {}).length
      || Object.keys(set.gpForces || {}).length
      || Object.keys(set.mpcForces || {}).length
      || Object.keys(set.oloadForces || {}).length
    )
  );

  const ensureSet = (setId, meta = {}) => {
    const key = String(setId || '');
    if (!key) return null;
    if (resultSetMap.has(key)) {
      const existing = resultSetMap.get(key);
      for (const [field, value] of Object.entries(meta || {})) {
        if (field === 'setId' || value == null) continue;
        if (typeof value === 'string') {
          if (!existing[field] && value) existing[field] = value;
          continue;
        }
        if (Number.isFinite(Number(value))) {
          if (!Number.isFinite(Number(existing[field]))) existing[field] = Number(value);
          continue;
        }
        if (existing[field] == null) existing[field] = value;
      }
      existing.label = formatSetLabel(existing);
      return existing;
    }
    const set = createResultSet({ ...meta, setId: key });
    set.label = formatSetLabel(set);
    resultSetMap.set(key, set);
    results.resultSets.push(set);
    return set;
  };

  const ensureSubcaseSet = (subcaseId) => {
    const sc = Number.isFinite(Number(subcaseId)) ? Number(subcaseId) : lastSubcaseId;
    if (Number.isFinite(sc)) lastSubcaseId = sc;
    return ensureSet(`subcase:${lastSubcaseId}`, {
      kind: 'subcase',
      subcaseId: lastSubcaseId,
      outputSetId: lastSubcaseId
    });
  };

  const ensureEigenvectorSet = (modeNumber) => {
    const mode = Number.isFinite(Number(modeNumber)) ? Number(modeNumber) : 0;
    const summary = currentEigenSummary && currentEigenSummary.modes instanceof Map
      ? currentEigenSummary.modes.get(mode)
      : null;
    const summaryId = currentEigenSummary && Number.isFinite(Number(currentEigenSummary.summaryId))
      ? Number(currentEigenSummary.summaryId)
      : 0;
    return ensureSet(`eigenvector:${summaryId}:${mode}`, {
      kind: 'eigenvector',
      subcaseId: summary && Number.isFinite(Number(summary.subcaseId))
        ? Number(summary.subcaseId)
        : (currentEigenSummary && Number.isFinite(Number(currentEigenSummary.subcaseId))
          ? Number(currentEigenSummary.subcaseId)
          : lastSubcaseId),
      outputSetId: mode,
      modeNumber: mode,
      eigenvectorNumber: mode,
      eigenvalue: summary ? summary.eigenvalue : NaN,
      loadFactor: summary ? summary.loadFactor : NaN,
      radians: summary ? summary.radians : NaN,
      cycles: summary ? summary.cycles : NaN,
      generalizedMass: summary ? summary.generalizedMass : NaN,
      generalizedStiffness: summary ? summary.generalizedStiffness : NaN
    });
  };

  const activeMaps = () => {
    if (!currentSet) currentSet = ensureSubcaseSet(lastSubcaseId);
    return currentSet || ensureSubcaseSet(lastSubcaseId);
  };

  const syncFlatFromSet = (set) => {
    const active = set || createResultSet({ setId: 'empty', subcaseId: lastSubcaseId });
    results.activeSetId = String(active.setId || '');
    results.activeSet = active;
    results.displacements = active.displacements || {};
    results.stresses = active.stresses || {};
    results.strains = active.strains || {};
    results.elementForces = active.elementForces || {};
    results.gpForces = active.gpForces || {};
    results.mpcForces = active.mpcForces || {};
    results.oloadForces = active.oloadForces || {};
    results.subcaseId = Number.isFinite(Number(active.subcaseId)) ? Number(active.subcaseId) : lastSubcaseId;
  };

  const assignTensorResult = (targetMap, eid, type, values) => {
    if (!Number.isFinite(eid) || !values || typeof values !== 'object') return;
    const prev = targetMap[eid] && typeof targetMap[eid] === 'object' ? targetMap[eid] : { type };
    const out = { ...prev, type };
    mergeByMaxAbs(out, values);
    if (!Number.isFinite(out.vonMises)) {
      const fallback = [
        out.principalMajor, out.principalMinor, out.normalX, out.normalY, out.shearXY,
        out.c1, out.c2, out.c3, out.c4, out.c5, out.c6
      ].filter((v) => Number.isFinite(v)).map((v) => Math.abs(v));
      if (fallback.length) out.vonMises = Math.max(...fallback);
    }
    if (Number.isFinite(out.vonMises)) targetMap[eid] = out;
  };

  const assignVectorByGrid = (targetMap, nid, values) => {
    if (!Number.isFinite(nid) || !values || typeof values !== 'object') return;
    const prev = targetMap[nid] && typeof targetMap[nid] === 'object' ? targetMap[nid] : {};
    const out = { ...prev };
    mergeByMaxAbs(out, values);
    targetMap[nid] = withMagnitude(out);
  };

  const parseGridVectorTable = (targetMap) => {
    let headerIdx = -1;
    for (let j = i; j < Math.min(lines.length, i + 10); j++) {
      const compact = toCompact(lines[j]);
      if (compact.includes('GRID') && compact.includes('COORD') && compact.includes('T1') && compact.includes('R3')) {
        headerIdx = j;
        break;
      }
    }
    if (headerIdx < 0) return;
    i = headerIdx + 1;
    while (i < lines.length) {
      const row = lines[i];
      const trimmed = row.trim();
      if (!trimmed) { i++; continue; }
      if (row.startsWith('1 ') || row.includes('>> LINK') || isOutputSetBoundary(row)) { i--; break; }
      if (trimmed.startsWith('MAX*') || trimmed.startsWith('MIN*') || trimmed.startsWith('ABS*')) break;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 8 && /^\d+$/.test(parts[0]) && /^[-+]?\d+$/.test(parts[1])) {
        assignVectorByGrid(targetMap, parseInt(parts[0], 10), {
          coord: parseInt(parts[1], 10),
          t1: parseNum(parts[2]),
          t2: parseNum(parts[3]),
          t3: parseNum(parts[4]),
          r1: parseNum(parts[5]),
          r2: parseNum(parts[6]),
          r3: parseNum(parts[7])
        });
      }
      i++;
    }
  };

  const parseShellTensorBlock = (targetMap, type) => {
    i++;
    let currentEid = null;
    while (i < lines.length) {
      const row = lines[i];
      const trimmed = row.trim();
      if (!trimmed) { i++; continue; }
      if (row.startsWith('1 ') || row.includes('>> LINK') || isOutputSetBoundary(row)) { i--; break; }
      if (trimmed.startsWith('MAX*') || trimmed.startsWith('MIN*') || trimmed.startsWith('ABS*')) { i++; continue; }
      if (/^\s*Elem\s+Location/i.test(row) || /^\s*ID\s+Distance/i.test(row) || /^\s*ID\s+Fibre/i.test(row)) { i++; continue; }
      // Fixed-width reports can print adjacent values without whitespace.
      const parts = trimmed.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?|[A-Za-z]+/g) || [];
      if (parts.length >= 10 && /^\d+$/.test(parts[0]) && /^CENTER$/i.test(parts[1])) {
        currentEid = parseInt(parts[0], 10);
        assignTensorResult(targetMap, currentEid, type, {
          fiberDistance: parseNum(parts[2]),
          normalX: parseNum(parts[3]),
          normalY: parseNum(parts[4]),
          shearXY: parseNum(parts[5]),
          principalAngle: parseNum(parts[6]),
          principalMajor: parseNum(parts[7]),
          principalMinor: parseNum(parts[8]),
          vonMises: parseNum(parts[9]),
          shearXZ: parseNum(parts[10]),
          shearYZ: parseNum(parts[11]),
          polyFitErr: parseNum(parts[12])
        });
        i++;
        continue;
      }
      if (Number.isFinite(currentEid) && parts.length >= 10 && /^GRD$/i.test(parts[0])) {
        assignTensorResult(targetMap, currentEid, type, {
          fiberDistance: parseNum(parts[2]),
          normalX: parseNum(parts[3]),
          normalY: parseNum(parts[4]),
          shearXY: parseNum(parts[5]),
          principalAngle: parseNum(parts[6]),
          principalMajor: parseNum(parts[7]),
          principalMinor: parseNum(parts[8]),
          vonMises: parseNum(parts[9]),
          shearXZ: parseNum(parts[10]),
          shearYZ: parseNum(parts[11]),
          polyFitErr: parseNum(parts[12])
        });
        i++;
        continue;
      }
      if (Number.isFinite(currentEid) && parts.length >= 8 && !/^\d+$/.test(parts[0]) && Number.isFinite(parseNum(parts[0]))) {
        assignTensorResult(targetMap, currentEid, type, {
          fiberDistance: parseNum(parts[0]),
          normalX: parseNum(parts[1]),
          normalY: parseNum(parts[2]),
          shearXY: parseNum(parts[3]),
          principalAngle: parseNum(parts[4]),
          principalMajor: parseNum(parts[5]),
          principalMinor: parseNum(parts[6]),
          vonMises: parseNum(parts[7]),
          shearXZ: parseNum(parts[8]),
          shearYZ: parseNum(parts[9]),
          polyFitErr: parseNum(parts[10])
        });
        i++;
        continue;
      }
      i++;
    }
  };

  const parseRealEigenvalueSummary = () => {
    let descriptor = '';
    let headerIdx = -1;
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
      const trimmed = String(lines[j] || '').trim();
      if (!trimmed) continue;
      if (!descriptor && /^\(.*\)$/.test(trimmed)) descriptor = trimmed;
      if (/MODE\s+EXTRACTION/i.test(trimmed)) {
        headerIdx = j;
        break;
      }
    }
    if (headerIdx < 0) return;

    const descriptorLower = descriptor.toLowerCase();
    const summary = {
      summaryId: nextEigenSummaryId++,
      kind: descriptorLower.includes('buckling') ? 'buckling' : 'modal',
      subcaseId: lastSubcaseId,
      descriptor,
      modes: new Map()
    };
    const subcaseMatch = descriptor.match(/subcase\s+(\d+)/i);
    if (subcaseMatch) {
      const sc = parseInt(subcaseMatch[1], 10);
      if (Number.isFinite(sc)) summary.subcaseId = sc;
    }

    let j = headerIdx + 1;
    while (j < lines.length && !/^\s*\d+/.test(String(lines[j] || ''))) {
      const row = String(lines[j] || '');
      const trimmed = row.trim();
      if (!trimmed) { j++; continue; }
      if (row.startsWith('1 ') || />>\s*LINK/i.test(row) || isOutputSetBoundary(row)) break;
      j++;
    }

    for (; j < lines.length; j++) {
      const row = String(lines[j] || '');
      const trimmed = row.trim();
      if (!trimmed) {
        if (summary.modes.size > 0) break;
        continue;
      }
      if (row.startsWith('1 ') || />>\s*LINK/i.test(row) || isOutputSetBoundary(row)) {
        j--;
        break;
      }
      const parts = trimmed.split(/\s+/);
      if (!(parts.length >= 3 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]))) {
        if (summary.modes.size > 0) {
          j--;
          break;
        }
        continue;
      }
      const mode = parseInt(parts[0], 10);
      const extractionOrder = parseInt(parts[1], 10);
      const eigenvalue = parseNum(parts[2]);
      const meta = {
        modeNumber: mode,
        eigenvectorNumber: mode,
        extractionOrder,
        subcaseId: summary.subcaseId,
        eigenvalue
      };
      if (summary.kind === 'buckling') {
        meta.loadFactor = eigenvalue;
      } else {
        meta.radians = parseNum(parts[3]);
        meta.cycles = parseNum(parts[4]);
        meta.generalizedMass = parseNum(parts[5]);
        meta.generalizedStiffness = parseNum(parts[6]);
      }
      summary.modes.set(mode, meta);
    }

    currentEigenSummary = summary;
    results.eigenSummaries.push({
      summaryId: summary.summaryId,
      kind: summary.kind,
      subcaseId: summary.subcaseId,
      descriptor: summary.descriptor,
      modes: Array.from(summary.modes.values()).map((entry) => ({
        modeNumber: entry.modeNumber,
        eigenvectorNumber: entry.eigenvectorNumber,
        extractionOrder: entry.extractionOrder,
        eigenvalue: entry.eigenvalue,
        loadFactor: entry.loadFactor,
        radians: entry.radians,
        cycles: entry.cycles,
        generalizedMass: entry.generalizedMass,
        generalizedStiffness: entry.generalizedStiffness
      }))
    });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const cleanLine = line.replace(/\s+/g, '');

    const subcaseMatch = line.match(/OUTPUT\s+FOR\s+SUBCASE\s+(\d+)/i);
    if (subcaseMatch) {
      const sc = parseInt(subcaseMatch[1], 10);
      if (Number.isFinite(sc)) currentSet = ensureSubcaseSet(sc);
    }
    const eigenvectorMatch = line.match(/OUTPUT\s+FOR\s+EIGENVECTOR\s+(\d+)/i);
    if (eigenvectorMatch) {
      const mode = parseInt(eigenvectorMatch[1], 10);
      if (Number.isFinite(mode)) currentSet = ensureEigenvectorSet(mode);
    }

    if (/R\s*E\s*A\s*L\s+E\s*I\s*G\s*E\s*N\s*V\s*A\s*L\s*U\s*E\s*S/i.test(line)) {
      parseRealEigenvalueSummary();
    }

    if ((/D\s*I\s*S\s*P\s*L\s*A\s*C\s*E\s*M\s*E\s*N\s*T/.test(line)
      || /E\s*I\s*G\s*E\s*N\s*V\s*E\s*C\s*T\s*O\s*R/.test(line))
      && !line.includes('STRESSES')
      && !line.includes('SPC')
      && !line.includes('AUTOSPC')) {
      const target = activeMaps().displacements;
      let headerFound = false;
      for (let skip = 1; skip <= 5 && (i + skip) < lines.length; skip++) {
        const hdr = lines[i + skip];
        if (hdr.includes('POINT ID') || hdr.includes('GRID')) {
          i += skip + 1;
          if (i < lines.length && lines[i].trim().match(/^SYS\b|^$/)) i++;
          headerFound = true;
          break;
        }
      }
      if (headerFound) {
        while (i < lines.length) {
          const row = lines[i];
          if (!row.trim() || row.startsWith('1') || row.includes('---')
            || row.includes('MAX*') || row.includes('MIN*') || row.includes('ABS*')) break;
          if (row.includes('STRESSES')
            || /D\s*I\s*S\s*P\s*L\s*A\s*C\s*E/.test(row)
            || /E\s*I\s*G\s*E\s*N\s*V\s*E\s*C\s*T\s*O\s*R/.test(row)
            || row.includes('SPC Force') || row.includes('OLOAD') || row.includes('LINK') || isOutputSetBoundary(row)) {
            i--;
            break;
          }
          const parts = row.trim().split(/\s+/);
          const pointId = parseInt(parts[0], 10);
          if (!isNaN(pointId) && parts.length >= 4) {
            let dofStart = 1;
            const maybeCoord = parseInt(parts[1], 10);
            if (!isNaN(maybeCoord) && parts.length >= 5 && Math.abs(maybeCoord) < 100) dofStart = 2;
            target[pointId] = {
              t1: parseFloat(parts[dofStart] || '0') || 0,
              t2: parseFloat(parts[dofStart + 1] || '0') || 0,
              t3: parseFloat(parts[dofStart + 2] || '0') || 0,
              r1: parseFloat(parts[dofStart + 3] || '0') || 0,
              r2: parseFloat(parts[dofStart + 4] || '0') || 0,
              r3: parseFloat(parts[dofStart + 5] || '0') || 0
            };
          }
          i++;
        }
      }
    } else if (/A\s*P\s*P\s*L\s*I\s*E\s*D\s+F\s*O\s*R\s*C\s*E\s*S/i.test(line)) {
      parseGridVectorTable(activeMaps().oloadForces);
    } else if (/M\s*P\s*C\s+F\s*O\s*R\s*C\s*E\s*S/i.test(line)) {
      parseGridVectorTable(activeMaps().mpcForces);
    } else if (/G\s*R\s*I\s*D\s+P\s*O\s*I\s*N\s*T\s+F\s*O\s*R\s*C\s*E\s+B\s*A\s*L\s*A\s*N\s*C\s*E/i.test(line)) {
      const target = activeMaps().gpForces;
      i++;
      while (i < lines.length) {
        const row = lines[i];
        if (!row.trim()) { i++; continue; }
        if (row.startsWith('1 ') || row.includes('>> LINK') || isOutputSetBoundary(row)) { i--; break; }
        const gp = row.match(/FORCE\s+BALANCE\s+FOR\s+GRID\s+POINT\s+(\d+)/i);
        if (gp) {
          currentGpForceGrid = parseInt(gp[1], 10);
          i++;
          continue;
        }
        if (/^\s*TOTALS\s*:/i.test(row) && Number.isFinite(currentGpForceGrid)) {
          const nums = row.match(/[+-]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[DE][+-]?\d+)?/gi) || [];
          if (nums.length >= 6) {
            assignVectorByGrid(target, currentGpForceGrid, {
              t1: parseNum(nums[nums.length - 6]),
              t2: parseNum(nums[nums.length - 5]),
              t3: parseNum(nums[nums.length - 4]),
              r1: parseNum(nums[nums.length - 3]),
              r2: parseNum(nums[nums.length - 2]),
              r3: parseNum(nums[nums.length - 1])
            });
          }
        }
        i++;
      }
    } else if (/E\s*L\s*E\s*M\s*E\s*N\s*T\s+E\s*N\s*G\s*I\s*N\s*E\s*E\s*R\s*I\s*N\s*G\s+F\s*O\s*R\s*C\s*E\s*S/i.test(line)) {
      const target = activeMaps().elementForces;
      const type = parseTypeFromLines(i + 1);
      i++;
      while (i < lines.length) {
        const row = lines[i];
        const trimmed = row.trim();
        if (!trimmed) { i++; continue; }
        if (row.startsWith('1 ') || row.includes('>> LINK') || isOutputSetBoundary(row)) { i--; break; }
        if (trimmed.startsWith('MAX*') || trimmed.startsWith('MIN*') || trimmed.startsWith('ABS*') || /TOTALS\s*:/i.test(trimmed)) { i++; continue; }
        if (/^\s*Element\b/i.test(row) || /^\s*ID\b/i.test(row) || /Normal\s+Forces/i.test(row) || /Moment/i.test(row)) { i++; continue; }
        const parts = trimmed.split(/\s+/);
        if (!parts.length || !/^\d+$/.test(parts[0])) { i++; continue; }
        const eid = parseInt(parts[0], 10);
        if (type === 'BUSH' && parts.length >= 7) {
          const out = withMagnitude({
            type,
            fx: parseNum(parts[1]),
            fy: parseNum(parts[2]),
            fz: parseNum(parts[3]),
            mx: parseNum(parts[4]),
            my: parseNum(parts[5]),
            mz: parseNum(parts[6])
          });
          const prev = target[eid] && typeof target[eid] === 'object' ? target[eid] : { type };
          const merged = { ...prev, type };
          mergeByMaxAbs(merged, out);
          target[eid] = withMagnitude(merged);
          i++;
          continue;
        }
        if (parts.length >= 9) {
          const out = withMagnitude({
            type,
            nxx: parseNum(parts[1]),
            nyy: parseNum(parts[2]),
            nxy: parseNum(parts[3]),
            mxx: parseNum(parts[4]),
            myy: parseNum(parts[5]),
            mxy: parseNum(parts[6]),
            qx: parseNum(parts[7]),
            qy: parseNum(parts[8])
          });
          const prev = target[eid] && typeof target[eid] === 'object' ? target[eid] : { type };
          const merged = { ...prev, type };
          mergeByMaxAbs(merged, out);
          target[eid] = withMagnitude(merged);
        }
        i++;
      }
    } else if (cleanLine.includes('ELEMENTSTRESSESINMATERIALCOORDINATESYSTEM')
      && ['HEXA', 'PENTA', 'TETRA'].includes(parseTypeFromLines(i + 1))) {
      // MYSTRAN/Vibestran solid stresses: the CENTER row contains the six
      // tensor components and von Mises; subsequent GRD rows are extrapolated.
      // Keep centroid values, matching the existing Nastran solid result path.
      const target = activeMaps().stresses, type = parseTypeFromLines(i + 1);
      i++;
      while (i < lines.length) {
        const row = lines[i], parts = row.trim().split(/\s+/);
        if (row.startsWith('1 ') || row.includes('>> LINK') || isOutputSetBoundary(row)) { i--; break; }
        if (parts.length >= 9 && /^\d+$/.test(parts[0]) && /^CENTER$/i.test(parts[1])) {
          assignTensorResult(target, parseInt(parts[0], 10), type, {
            normalX: parseNum(parts[2]), normalY: parseNum(parts[3]), normalZ: parseNum(parts[4]),
            shearXY: parseNum(parts[5]), shearYZ: parseNum(parts[6]), shearXZ: parseNum(parts[7]), vonMises: parseNum(parts[8])
          });
        }
        i++;
      }
    } else if (/E\s*L\s*E\s*M\s*E\s*N\s*T\s+S\s*T\s*R\s*E\s*S\s*S\s*E\s*S/.test(line)
      && /L\s*O\s*C\s*A\s*L\s+E\s*L\s*E\s*M\s*E\s*N\s*T\s+C\s*O\s*O\s*R\s*D\s*I\s*N\s*A\s*T\s*E/.test(line)) {
      const target = activeMaps().stresses;
      const type = parseTypeFromLines(i + 1);
      if (type === 'BUSH') {
        i++;
        while (i < lines.length) {
          const row = lines[i];
          const trimmed = row.trim();
          if (!trimmed) { i++; continue; }
          if (row.startsWith('1 ') || row.includes('>> LINK') || isOutputSetBoundary(row)) { i--; break; }
          if (trimmed.startsWith('MAX*') || trimmed.startsWith('MIN*') || trimmed.startsWith('ABS*')) { i++; continue; }
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 7 && /^\d+$/.test(parts[0])) {
            assignTensorResult(target, parseInt(parts[0], 10), type, {
              c1: parseNum(parts[1]),
              c2: parseNum(parts[2]),
              c3: parseNum(parts[3]),
              c4: parseNum(parts[4]),
              c5: parseNum(parts[5]),
              c6: parseNum(parts[6])
            });
          }
          i++;
        }
      } else {
        parseShellTensorBlock(target, type === 'UNKNOWN' ? 'SHELL' : type);
      }
    } else if (/E\s*L\s*E\s*M\s*E\s*N\s*T\s+S\s*T\s*R\s*A\s*I\s*N\s*S/.test(line)
      && /L\s*O\s*C\s*A\s*L\s+E\s*L\s*E\s*M\s*E\s*N\s*T\s+C\s*O\s*O\s*R\s*D\s*I\s*N\s*A\s*T\s*E/.test(line)) {
      const target = activeMaps().strains;
      const type = parseTypeFromLines(i + 1);
      if (type === 'BUSH') {
        i++;
        while (i < lines.length) {
          const row = lines[i];
          const trimmed = row.trim();
          if (!trimmed) { i++; continue; }
          if (row.startsWith('1 ') || row.includes('>> LINK') || isOutputSetBoundary(row)) { i--; break; }
          if (trimmed.startsWith('MAX*') || trimmed.startsWith('MIN*') || trimmed.startsWith('ABS*')) { i++; continue; }
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 7 && /^\d+$/.test(parts[0])) {
            assignTensorResult(target, parseInt(parts[0], 10), type, {
              c1: parseNum(parts[1]),
              c2: parseNum(parts[2]),
              c3: parseNum(parts[3]),
              c4: parseNum(parts[4]),
              c5: parseNum(parts[5]),
              c6: parseNum(parts[6])
            });
          }
          i++;
        }
      } else {
        parseShellTensorBlock(target, type === 'UNKNOWN' ? 'SHELL' : type);
      }
    } else if (cleanLine.includes('STRESSESIN') && cleanLine.includes('ELEMENTS')
      && (cleanLine.includes('(QUAD4)') || cleanLine.includes('(TRIA3)'))) {
      const target = activeMaps().stresses;
      const type = cleanLine.includes('QUAD4') ? 'QUAD4' : 'TRIA3';
      i++;
      while (i < lines.length) {
        const row = lines[i];
        if (!row.trim()) { i++; continue; }
        if (row.replace(/\s+/g, '').includes('STRESSESIN')) { i--; break; }
        if (row.includes('ELEMENT') || row.includes('FIBER') || row.includes('GRID-ID') || row.includes('Action')) { i++; continue; }
        break;
      }
      while (i < lines.length) {
        const row = lines[i];
        if (!row.trim() || row.startsWith('1')) break;
        if (row.includes('STRESSES') || row.includes('DISPLACEMENT') || isOutputSetBoundary(row)) { i--; break; }
        if (row.includes('CEN/4') || row.includes('CEN/3')) {
          const parts = row.trim().split(/\s+/);
          const vonMises = parseFloat(parts[parts.length - 1]);
          let eidStr = parts[0];
          if (eidStr === '0') eidStr = parts[1];
          const eid = parseInt(eidStr, 10);
          if (!isNaN(eid) && !isNaN(vonMises)) assignTensorResult(target, eid, type, { vonMises });
        }
        i++;
      }
    } else if (cleanLine.includes('STRESSESIN') && cleanLine.includes('ELEMENTS')
      && (cleanLine.includes('(HEXA)') || cleanLine.includes('(PENTA)') || cleanLine.includes('(TETRA)'))) {
      const target = activeMaps().stresses;
      let type = 'SOLID';
      if (cleanLine.includes('HEXA')) type = 'HEXA';
      if (cleanLine.includes('PENTA')) type = 'PENTA';
      if (cleanLine.includes('TETRA')) type = 'TETRA';
      i += 2;
      while (i < lines.length) {
        const row = lines[i];
        if (!row.trim() || row.startsWith('1')) break;
        if (row.includes('STRESSES') || row.includes('DISPLACEMENT') || isOutputSetBoundary(row)) { i--; break; }
        const eidMatch = row.match(/^\s*0\s+(\d+)\s+/);
        if (eidMatch) {
          const currentEid = parseInt(eidMatch[1], 10);
          if (i + 1 < lines.length && lines[i + 1].includes('CENTER')) {
            const parts = lines[i + 1].trim().split(/\s+/);
            const vonMises = parseFloat(parts[parts.length - 1]);
            if (!isNaN(vonMises)) assignTensorResult(target, currentEid, type, { vonMises });
          }
        }
        i++;
      }
    } else if (cleanLine.includes('STRESSESIN') && cleanLine.includes('ELEMENTS')
      && (cleanLine.includes('(CBAR)') || cleanLine.includes('(CBEAM)') || cleanLine.includes('(BAR)') || cleanLine.includes('(BEAM)'))) {
      const target = activeMaps().stresses;
      const type = cleanLine.includes('BEAM') ? 'BEAM' : 'BAR';
      i += 2;
      while (i < lines.length) {
        const row = lines[i];
        if (!row.trim() || row.startsWith('1')) break;
        if (row.includes('STRESSES') || row.includes('DISPLACEMENT') || isOutputSetBoundary(row)) { i--; break; }
        const parts = row.trim().split(/\s+/);
        let eidStr = parts[0];
        let valStart = 1;
        if (eidStr === '0') { eidStr = parts[1]; valStart = 2; }
        const eid = parseInt(eidStr, 10);
        let maxStress = 0;
        for (let k = valStart; k < parts.length; k++) {
          const v = Math.abs(parseFloat(parts[k]));
          if (!isNaN(v) && v > maxStress) maxStress = v;
        }
        assignTensorResult(target, eid, type, { vonMises: maxStress });
        i++;
      }
    }

    i++;
  }

  const defaultSet = results.resultSets.find((set) => set.kind === 'subcase' && isSetPopulated(set))
    || results.resultSets.find((set) => isSetPopulated(set))
    || results.resultSets[0]
    || null;
  if (defaultSet) syncFlatFromSet(defaultSet);
  for (const set of results.resultSets) set.label = formatSetLabel(set);
  return results;
}

function cloneParseSessionCardStream(cardStream) {
  if (!Array.isArray(cardStream)) return [];
  return cardStream.map((rec) => {
    if (!rec || typeof rec !== 'object') return rec;
    return {
      ...rec,
      tokens: Array.isArray(rec.tokens) ? rec.tokens.slice() : rec.tokens,
      lineTokens: Array.isArray(rec.lineTokens)
        ? rec.lineTokens.map((row) => Array.isArray(row) ? row.slice() : row)
        : rec.lineTokens,
      rawLines: Array.isArray(rec.rawLines) ? rec.rawLines.slice() : rec.rawLines,
      source: rec.source && typeof rec.source === 'object' ? { ...rec.source } : rec.source
    };
  });
}

function handleGetParseSessionCardStreamRequest(msg) {
  const requestId = String(msg && msg.requestId ? msg.requestId : '');
  const parseSessionId = msg && msg.parseSessionId != null ? String(msg.parseSessionId) : '';
  const parseSession = parseSessionId ? getParseSession(parseSessionId) : null;
  const cardStream = parseSession && Array.isArray(parseSession.cardStream)
    ? cloneParseSessionCardStream(parseSession.cardStream)
    : [];
  post('PARSE_SESSION_CARD_STREAM_RESULT', {
    requestId,
    parseSessionId,
    cardStream
  });
}

function handleGetSourceSessionCardStreamRequest(msg) {
  const requestId = String(msg && msg.requestId ? msg.requestId : '');
  const sourceSessionId = msg && msg.sourceSessionId != null ? String(msg.sourceSessionId) : '';
  const requestedEntryFileKey = msg && msg.entryFileKey != null ? String(msg.entryFileKey) : '';
  const sourceFiles = sourceSessionId ? getSourceSessionFiles(sourceSessionId) : null;
  if (!sourceFiles || typeof sourceFiles !== 'object') {
    post('WORKER_ERROR', { error: asError(new Error('SOURCE_SESSION_CARD_STREAM_SOURCE_MISSING')) });
    return;
  }

  let entryFileKey = requestedEntryFileKey;
  if (!entryFileKey || !Object.prototype.hasOwnProperty.call(sourceFiles, entryFileKey)) {
    const keys = Object.keys(sourceFiles);
    entryFileKey = keys.length > 0 ? String(keys[0]) : '';
  }
  const entryText = entryFileKey && Object.prototype.hasOwnProperty.call(sourceFiles, entryFileKey)
    ? coerceSourceText(sourceFiles[entryFileKey])
    : null;
  if (typeof entryText !== 'string') {
    post('WORKER_ERROR', { error: asError(new Error('SOURCE_SESSION_CARD_STREAM_ENTRY_MISSING')) });
    return;
  }

  parseDeckToCardStream(entryText, entryFileKey, sourceFiles, {
    strictMode: false,
    exportMode: 'flatten',
    retainRawLines: false,
    retainSourceSpans: true,
    retainSourceLineRanges: false,
    includeLineTokenMetadata: false,
    includeSourceFilesInModel: false,
    retainParseSession: true
  })
    .then((result) => {
      const parseSessionId = result && result.model && result.model.parseSessionId != null
        ? String(result.model.parseSessionId)
        : '';
      const parseSession = parseSessionId ? getParseSession(parseSessionId) : null;
      const cardStream = parseSession && Array.isArray(parseSession.cardStream)
        ? cloneParseSessionCardStream(parseSession.cardStream)
        : [];
      post('SOURCE_SESSION_CARD_STREAM_RESULT', {
        requestId,
        sourceSessionId,
        parseSessionId,
        cardStream
      });
    })
    .catch((err) => {
      post('WORKER_ERROR', { error: asError(err) });
    });
}

function createSemanticCacheMirrorState() {
  return {
    initialized: false,
    revision: 0,
    lastTxId: 0,
    lastInitReason: '',
    snapshot: null
  };
}

function handleSemanticProtocolMessage(state, msg) {
  const mirror = state && typeof state === 'object' ? state : createSemanticCacheMirrorState();
  if (!msg || typeof msg !== 'object') return null;

  if (msg.type === 'InitSemanticSnapshot') {
    const revision = Number.isFinite(Number(msg.revision)) ? Math.max(0, Number(msg.revision)) : 0;
    mirror.initialized = true;
    mirror.revision = revision;
    mirror.lastTxId = 0;
    mirror.lastInitReason = String(msg.reason || '');
    mirror.snapshot = msg.snapshot && typeof msg.snapshot === 'object'
      ? JSON.parse(JSON.stringify(msg.snapshot))
      : null;
    return {
      mode: 'init',
      status: 'accepted',
      revision: mirror.revision,
      txId: mirror.lastTxId
    };
  }

  if (msg.type === 'ApplyTransactions') {
    if (!mirror.initialized) {
      return {
        mode: 'apply',
        status: 'requires-init',
        revision: mirror.revision,
        txId: mirror.lastTxId
      };
    }
    const txs = Array.isArray(msg.transactions) ? msg.transactions : [];
    if (txs.length === 0) {
      return {
        mode: 'apply',
        status: 'noop',
        revision: mirror.revision,
        txId: mirror.lastTxId
      };
    }

    let nextRevision = mirror.revision;
    let nextTxId = mirror.lastTxId;
    for (const tx of txs) {
      const txId = Number(tx && tx.txId);
      const baseRevision = Number(tx && tx.baseRevision);
      const revision = Number(tx && tx.revision);
      if (!Number.isFinite(txId) || !Number.isFinite(baseRevision) || !Number.isFinite(revision)) {
        return {
          mode: 'apply',
          status: 'invalid',
          revision: mirror.revision,
          txId: mirror.lastTxId
        };
      }
      if (baseRevision !== nextRevision || revision !== baseRevision + 1 || txId <= nextTxId) {
        return {
          mode: 'apply',
          status: 'stale',
          revision: mirror.revision,
          txId: mirror.lastTxId
        };
      }
      nextRevision = revision;
      nextTxId = txId;
    }

    mirror.revision = nextRevision;
    mirror.lastTxId = nextTxId;
    return {
      mode: 'apply',
      status: 'accepted',
      revision: mirror.revision,
      txId: mirror.lastTxId
    };
  }

  return null;
}

const semanticCacheMirror = createSemanticCacheMirrorState();

self.onmessage = (ev) => {
  const msg = ev && ev.data ? ev.data : {};
  try {
    const semanticAck = handleSemanticProtocolMessage(semanticCacheMirror, msg);
    if (semanticAck) {
      post('SEMANTIC_SYNC_ACK', semanticAck);
      return;
    }
    switch (msg.type) {
      case 'PING':
        post('PONG', { now: Date.now() });
        return;
      case 'PARSE_REQUEST':
        return handleParseRequest(msg);
      case 'WRITE_REQUEST':
        return handleWriteRequest(msg);
      case 'GET_PARSE_SESSION_CARD_STREAM':
        return handleGetParseSessionCardStreamRequest(msg);
      case 'GET_SOURCE_SESSION_CARD_STREAM':
        return handleGetSourceSessionCardStreamRequest(msg);
      case 'PARSE_F06_REQUEST':
        const results = parseF06Results(msg.f06Text);
        post('F06_PARSE_RESULT', { results });
        return;
      case 'DEBUG_FORMAT_REQUEST':
        const { kind, val, width } = msg;
        let res = '';
        if (kind === 'int') res = formatInt(val, width || 8);
        else if (kind === 'string') res = formatString(val, width || 8);
        else if (kind === 'float8') res = formatFloat8(val);
        else if (kind === 'float16') res = formatFloat16(val);
        post('DEBUG_FORMAT_RESULT', { result: res });
        return;
      default:
        post('WORKER_ERROR', { error: { message: `unknown message type: ${String(msg.type)}` } });
        return;
    }
  } catch (err) {
    post('WORKER_ERROR', { error: asError(err) });
  }
};

};
