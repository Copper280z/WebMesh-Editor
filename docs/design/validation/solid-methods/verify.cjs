const fs=require('fs'),assert=require('node:assert/strict');
const path=require('node:path'),root=path.resolve(__dirname,'../../../..'),H=require(root+'/app/hex-mapping'),L=require(root+'/app/cad-local-mesh');
function read(file){const p=JSON.parse(fs.readFileSync(file)),d=p.ownership.project.objects.find(o=>o.definition.generator==='cad-mapped-v1').definition,t=p.ownership.project.objects.find(o=>'topology' in o.definition).definition.topology;return {p,d,t};}
const before=read(process.argv[2]||root+'/test-results/flexure-hex/flexure-local-remesh.webmesh'),after=read(process.argv[3]||root+'/test-results/flexure-hex/flexure-ogrid.webmesh');
const changed=[145,150,155,161];
const d=after.d,byId=new Map(d.cards.map(c=>[c.family+':'+c.id,c])),members=new Map(d.volumeElements.map(v=>[v.id,v.elements]));
const keep=before.d.volumeElements.filter(v=>!changed.includes(v.id)).flatMap(v=>v.elements),keepSet=new Set(keep),kn=new Set(before.d.cards.filter(c=>c.family==='elems'&&keepSet.has(c.id)).flatMap(c=>c.value.n));
for(const c of before.d.cards)if(c.family==='elems'?keepSet.has(c.id):kn.has(c.id))assert.deepEqual(byId.get(c.family+':'+c.id),c);
let checks=0;for(const f of after.t.faces.filter(f=>f.volumes.length===2)){const nodes=d.faces.find(x=>x.id===f.id).nodes;const [x,y]=f.volumes.map(v=>L.faceSignatures(members.get(v).map(id=>({nodes:byId.get('elems:'+id).value.n})),nodes));assert.ok(x.length);assert.deepEqual(x,y);checks++;}
const data=JSON.parse(require('zlib').gunzipSync(fs.readFileSync(root+'/tests/fixtures/flexure-hex/complete.json.gz'))),analysis=H.analyze(data.topology),geo=H.createGeometry(data.topology,data.preview),s=after.d.settings,solved=L.solve(analysis,s);
const quality={};for(const order of [1,2]){const old=H.generateMesh(analysis,solved,geo,{order,volumes:changed}),next=H.generateMesh(analysis,solved,geo,{order,volumes:changed,solidMethods:s.mesh.solidMethods});quality['HEX'+(order===1?8:20)]={beforeMinSJ:old.quality.minScaledJacobian,afterMinSJ:next.quality.minScaledJacobian,beforeElements:old.elements.length,afterElements:next.elements.length,inverted:next.quality.inverted};}
const result={solids:changed,retainedSolids:169-changed.length,retainedElements:keep.length,retainedNodes:kn.size,elements:d.cards.filter(c=>c.family==='elems').length,nodes:d.cards.filter(c=>c.family==='nodes').length,sharedFaces:checks,methods:d.settings.mesh.solidMethods,quality};
console.log(JSON.stringify(result,null,2));
