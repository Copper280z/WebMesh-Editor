// node build.cjs /tmp/selective-start.webmesh
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),vm=require('node:vm'),root=path.resolve(__dirname,'../../../..');
const O=require(root+'/app/engine-ownership.js'),Mount=require(root+'/app/attachment-project.js'),Assembly=require(root+'/app/assembly-project.js'),Analysis=require(root+'/app/analysis-project.js'),Runs=require(root+'/app/analysis-runs.js'),{apply,ids,empty}=require(root+'/tests/helpers/project-actions.cjs');
const p=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,'../project-workspace/rover-remesh.webmesh.gz'))));
let s={ownership:p.ownership,semantic:empty()};O.putAll(s.semantic,s.ownership.owners.map(e=>e.card));s.semantic.loads.load=[{type:'LOAD',sid:3,scale:1,entries:[{lid:1,scale:1},{lid:2,scale:1}]}];
const part=s.ownership.project.objects.find(o=>o.name==='rover_chassis'),src=s.ownership.project.objects.find(o=>o.id===part.definition.source);src.definition.topology=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,'before-topology.json.gz'))));
for(const o of s.ownership.project.objects.filter(o=>o.id.startsWith('mount-')))s=apply(s,Mount.region({id:o.id,name:o.name,mesh:o.definition.selector.mesh,kind:'edge',faces:o.definition.selector.faces,pattern:true},s.ownership));
const motor=s.ownership.project.objects.find(o=>o.id==='motor-right-rear');s=apply(s,Assembly.connection({...motor.definition,id:motor.id,name:motor.name,overrides:{stiffness:[110000,100000,100000,1e6,1e6,1e6]}},s.ownership,ids(s.ownership)));
async function save(){
 if(s.semantic.loads.load){s.semantic.loads.combination=s.semantic.loads.load;delete s.semantic.loads.load;}
 const sync=require(root+'/tests/helpers/editor-sync-context.cjs')(0,0).context;for(const [k,v]of Object.entries(s.semantic))sync.model[k]=['nodes','properties','materials','coords','masses'].includes(k)?new Map(v):v;
 sync.ensureSemanticRelationshipIndexes=sync.refreshSemanticRelationshipIndexes=()=>({elementRefsByEid:new Map(Object.values(s.semantic.elems).flat().map(e=>[e.eid,e]))});sync.syncWorkerFromEditorModel();
 const messages=[],worker=vm.createContext({Map,Set,self:{postMessage:m=>messages.push(m)},console,TextEncoder,TextDecoder,performance,setTimeout,clearTimeout});vm.runInContext(require(root+'/tests/helpers/worker-source.cjs'),worker);worker.handleWriteRequest({model:sync.workerModel,options:{writeFormat:'free',projectSave:true}});
 p.ownership=s.ownership;p.deck=Analysis.projectDeck(messages.find(m=>m.type==='WRITE_COMPLETE').text,s.ownership);p.snapshotDigest=await Runs.digest(p.deck+'\0'+O.canonical(s.ownership));p.analysisRuns=[];p.name='Rover selective CAD replacement';
 fs.writeFileSync(process.argv[2],JSON.stringify(p));console.log('Saved',process.argv[2]);
}save().catch(e=>{console.error(e);process.exitCode=1;});
