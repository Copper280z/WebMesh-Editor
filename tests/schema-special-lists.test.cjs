const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app/editor-engine.js'),'utf8');
function implementation(name){const start=source.indexOf(`  function ${name}(`);assert.ok(start>=0,name);const end=source.indexOf('\n  function ',start+10);return source.slice(start,end<0?undefined:end);}
const names=['schemaPrepareFields','schemaFieldByNameLower','schemaGetRawFieldValue','schemaSetRawFieldValue','schemaParsePositiveIdList','schemaNormalizePositiveIdList','schemaMergeUniqueIds','schemaCollectFieldNamesByPattern','schemaBuildListTextFromFieldNames','schemaCollectRbeGmNames','schemaCollectRbe3IndependentNames','schemaCollectSpcNodeNames','schemaReadSpecialIdList','schemaWriteSpecialIdList','schemaSyncSpecialIdFields','schemaApplyBulkIdsToFields','schemaApplySpecialEditorOverrides','schemaCaptureSpecialPayload','schemaCloneSpecialValue','schemaCreateParseValues','schemaCreateAddCard'];
function fixture(card){
  const schemaContext={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/nastran-schema.js'),'utf8'),schemaContext);
  const vals={}, elements=new Map([[1,{eid:1,n:[1,2,3,4]}],[2,{eid:2,n:[2,3,4,5]}]]);
  const model={nodes:new Map(Array.from({length:20},(_,i)=>[i+1,{}])),spc:[],spc1:[],loads:{force:[],moment:[],pload:[]}};
  const c=vm.createContext({model,workerModel:null,schemaCreateState:{fields:[]},schemaCreateCardValues:()=>vals,schemaCreateFriendlyFieldLabel:n=>n.toUpperCase(),getElementByEidFast:id=>elements.get(id)});
  vm.runInContext(names.map(implementation).join('\n'),c);
  const fields=c.schemaPrepareFields(schemaContext.window.WebMeshNastranSchema,card);c.schemaCreateState.fields=fields;
  const set=(name,value)=>c.schemaSetRawFieldValue(vals,fields,name,String(value));
  const key=card.startsWith('PLOAD')?'__targetElemList':'__targetNodeList', textKey=card.startsWith('PLOAD')?'__targetElemText':'__targetNodeText';
  const fieldNames=card==='SPC'||card==='SPC1'?fields.filter(f=>/^g\d+$/.test(f.nameLower)).map(f=>f.nameLower):card==='PLOAD2'?fields.filter(f=>/^eid\d+$/.test(f.nameLower)).map(f=>f.nameLower):[card==='PLOAD4'?'eid':'g'];
  function bulk(ids){c.schemaWriteSpecialIdList(vals,key,textKey,ids);c.schemaSyncSpecialIdFields(vals,fields,fieldNames,ids,key);}
  bulk([]);
  return {c,vals,model,fields,set,bulk,key,textKey,fieldNames,create:()=>c.schemaCreateAddCard(card,c.schemaCreateParseValues(card))};
}
const plain=v=>JSON.parse(JSON.stringify(v));

test('SPC1 manually entered G1 survives the initially empty bulk editor through actual card creation',()=>{
  const f=fixture('SPC1');f.set('sid',1);f.set('components','123');f.set('g1',1);
  f.create();assert.deepEqual(plain(f.model.spc1),[{sid:1,components:'123',nodes:[1]}]);
});

test('typing SPC grid slots retains separate components and displacements',()=>{
  const f=fixture('SPC');f.set('sid',2);f.set('g1',1);f.set('c1','123');f.set('d1',0);f.set('g2',2);f.set('c2','6');f.set('d2',0.25);
  f.create();assert.deepEqual(plain(f.model.spc),[{sid:2,g:1,c:'123',d:0},{sid:2,g:2,c:'6',d:0.25}]);
});

for(const card of ['FORCE','MOMENT'])test(`${card} manual target fields create the requested load after bulk editor initialization`,()=>{
  const f=fixture(card);f.set('sid',3);f.set('g',2);f.set(card==='FORCE'?'f':'m',100);f.set('n1',1);f.set('n2',0);f.set('n3',0);
  f.create();const loads=f.model.loads[card==='FORCE'?'force':'moment'];assert.equal(loads.length,1);assert.equal(loads[0].nid,2);assert.equal(loads[0].mag,100);
});

for(const card of ['PLOAD2','PLOAD4'])test(`${card} typed EID survives empty bulk target initialization`,()=>{
  const f=fixture(card);f.set('sid',4);f.set(card==='PLOAD2'?'p':'p1',20);f.set(card==='PLOAD2'?'eid1':'eid',1);
  f.create();assert.equal(f.model.loads.pload.length,1);assert.equal(f.model.loads.pload[0].eids[0],1);
});

test('bulk list changes update scalar fields, and explicit Clear remains authoritative',()=>{
  const f=fixture('SPC1');f.set('sid',5);f.set('components','123');f.bulk([1,2,3]);
  assert.equal(f.c.schemaGetRawFieldValue(f.vals,f.fields,'g1'),'1');assert.equal(f.c.schemaGetRawFieldValue(f.vals,f.fields,'g3'),'3');
  f.bulk([]);assert.equal(f.c.schemaGetRawFieldValue(f.vals,f.fields,'g1'),'');assert.throws(f.create,/at least one node/);assert.equal(f.model.spc1.length,0);
});

test('editing a scalar target preserves bulk IDs beyond the fixed schema slots',()=>{
  const f=fixture('SPC1');f.set('sid',6);f.set('components','123');const ids=Array.from({length:12},(_,i)=>i+1);f.bulk(ids);f.set('g1',15);
  f.create();assert.deepEqual(plain(f.model.spc1[0].nodes),[15,2,3,4,5,6,7,8,9,10,11,12]);
});
