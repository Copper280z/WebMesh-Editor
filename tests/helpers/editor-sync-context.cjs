const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return '';
  let offset = source.indexOf('{', start) + 1, depth = 1;
  for (; depth && offset < source.length; offset++) {
    if (source[offset] === '{') depth++;
    else if (source[offset] === '}') depth--;
  }
  if (depth) throw Error(`Incomplete function ${name}`);
  return source.slice(start, offset);
}

module.exports = function createSyncContext(nodeCount, elementCount, source = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'editor-engine.js'), 'utf8')) {
  const nodes = new Map(Array.from({ length: nodeCount }, (_, i) => [i + 1, { x: i % 41, y: Math.floor(i / 41) % 31, z: Math.floor(i / 1271), cp: 0, cd: 0, ps: '' }]));
  const elements = Array.from({ length: elementCount }, (_, i) => ({ type: 'CHEXA', eid: i + 1, pid: 1, n: Array.from({ length: 8 }, (_, j) => (i * 7 + j) % nodeCount + 1) }));
  const byId = new Map(elements.map(e => [e.eid, e]));
  const model = { nodes, elems: { tri: [], quad: [], hex: elements, tet: [], penta: [], pyram: [], rod: [], bar: [], beam: [], bush: [], rbe2: [], rbe3: [] },
    loads: { force: [], moment: [], pload: [], combination: [] }, spc: [], spc1: [], coords: new Map(), masses: new Map(),
    materials: new Map([[1, { type: 'MAT1', mid: 1, E: 210000, nu: 0.3, G: 80769.23076923, rho: 7.85e-9 }]]),
    properties: new Map([[1, { type: 'PSOLID', pid: 1, mid: 1 }]]) };
  const warnings = [], counts = { fullIndexPasses: 0, indexedRecords: 0 };
  const context = vm.createContext({ Map, Set, model, workerModel: null,
    workerCards: { indexedStream: null, indexedLength: -1, gridByNid: new Map(), ctria3ByEid: new Map(), cquad4ByEid: new Map(), byKey: new Map() },
    ELEMENT_GROUP_KEYS: Object.keys(model.elems),
    syncWorkerModelDebugRef() {}, assertCoordinateContractBeforeExport() {}, flushPendingSemanticWorkerTransactions() {},
    assertSemanticNodeUsesLocalCoordinates: node => node,
    ensureSemanticRelationshipIndexes: () => ({ elementRefsByEid: byId }),
    refreshSemanticRelationshipIndexes: () => ({ elementRefsByEid: byId }),
    workerModelRecordSourceLines: () => [],
    console: { warn: (...items) => warnings.push(items.map(String).join(' ')) }
  });
  const names = ['indexWorkerCardRecord', 'indexWorkerCardStream', 'ensureWorkerBackedModelReady', 'upsertGridRecordFromModel',
    'deleteWorkerCardByNameId', 'upsertCtria3RecordFromModel', 'upsertCquad4RecordFromModel', 'upsertSimpleIdCardTokens', 'insertCardBeforeEnddata', 'syncWorkerFromEditorModel'];
  vm.runInContext(names.map(name => functionSource(source, name)).join('\n'), context);
  const fullIndex = context.indexWorkerCardStream;
  context.indexWorkerCardStream = cards => { counts.fullIndexPasses++; return fullIndex(cards); };
  const indexRecord = context.indexWorkerCardRecord;
  if (indexRecord) context.indexWorkerCardRecord = record => { counts.indexedRecords++; return indexRecord(record); };
  return { context, model, warnings, counts };
};
