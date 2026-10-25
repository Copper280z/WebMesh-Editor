// Numeric proof independent of CAD edge metadata and the patch implementation.
// node docs/design/validation/seam-connectivity/verify.cjs
const fs=require('node:fs'),path=require('node:path'),z=require('node:zlib'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../../..'),read=n=>z.gunzipSync(fs.readFileSync(path.join(__dirname,n))).toString();
const key=p=>p.map(v=>Math.round(v*1e6)).join(':'),pair=(a,b)=>[a,b].sort().join('/'),near=(a,b)=>Math.abs(a-b)<1e-6;
function model(text){
 const nodes=new Map(),quads=new Map();for(const line of text.split('\n')){const c=line.split(',');if(c[0]==='GRID'){assert.equal(+c[2],0);nodes.set(+c[1],c.slice(3,6).map(Number));}if(c[0]==='CQUAD4')quads.set(+c[1],c.slice(3,7).map(Number));}
 const floor=[],wall=[];for(const nn of quads.values()){if(nn.every(n=>near(nodes.get(n)[2],27)))floor.push(nn);if(nn.every(n=>near(nodes.get(n)[0],93)))wall.push(nn);}
 const bottom=p=>near(p[0],93)&&near(p[2],27)&&p[1]>=-93-1e-6&&p[1]<=43.5+1e-6;
 const boundary=elements=>{const points=new Map(),segments=new Map();for(const nn of elements)nn.forEach((a,i)=>{const b=nn[(i+1)%nn.length];if([a,b].every(n=>bottom(nodes.get(n)))){points.set(key(nodes.get(a)),a);points.set(key(nodes.get(b)),b);segments.set(pair(key(nodes.get(a)),key(nodes.get(b))),pair(a,b));}});return{points,segments};};
 const f=boundary(floor),w=boundary(wall);assert.equal(f.points.size,29);assert.equal(w.points.size,29);assert.deepEqual([...f.points.keys()].sort(),[...w.points.keys()].sort());assert.equal(f.segments.size,28);assert.deepEqual([...f.segments.keys()].sort(),[...w.segments.keys()].sort());
 const pairs=[...f.points].map(([k,a])=>[a,w.points.get(k)]),sharedSegments=[...f.segments].filter(([k,v])=>w.segments.get(k)===v).length;
 return{nodes,quads,pairs,sharedSegments};
}
function parse(f06){const c=vm.createContext({self:{postMessage(){}},TextEncoder,TextDecoder,performance,setTimeout,clearTimeout});vm.runInContext(require(root+'/tests/helpers/worker-source.cjs'),c);return c.parseF06Results(f06).resultSets.filter(s=>s.kind==='eigenvector');}
const models={},report={};
const staticDeck=fs.readFileSync(path.join(__dirname,'../selective-replacement/rover.bdf'),'utf8');
assert.equal(read('fixed-modal.bdf.gz').split('EIGRL,1,0.,,12\n')[1],staticDeck.split('BEGIN BULK')[1].trimStart(),'Modal bulk data must match the corrected browser export');
for(const name of ['broken','fixed']){
 const deck=read(name+'-modal.bdf.gz'),m=model(deck),f06=read(name+'-modal.F06.gz'),log=read(name+'-modal.log.gz'),sets=parse(f06);models[name]=m;
 assert.match(log,/MYSTRAN terminated normally/);assert.equal(sets.length,12);
 const modes=sets.map(s=>{const u=s.displacements;assert.equal(Object.keys(u).length,m.nodes.size);const magnitude=v=>Math.hypot(v.t1,v.t2,v.t3),peak=Math.max(...Object.values(u).map(magnitude));let jump=0,at=null;for(const [a,b]of m.pairs){const value=Math.hypot(...['t1','t2','t3'].map(k=>u[a][k]-u[b][k]));if(value>jump){jump=value;at=[a,b];}}return{mode:s.modeNumber,Hz:s.cycles,maxBottomSeamJumpOverPeakTranslation:jump/peak,gridPair:at};});
 report[name]={deckSHA256:crypto.createHash('sha256').update(deck).digest('hex'),grids:m.nodes.size,quads:m.quads.size,bottomSeamPoints:m.pairs.length,sharedBottomSeamNodes:m.pairs.filter(([a,b])=>a===b).length,sharedBottomSeamSegments:m.sharedSegments,modes};
}
assert.equal(report.broken.sharedBottomSeamNodes,0);assert.equal(report.broken.sharedBottomSeamSegments,0);
assert.equal(report.fixed.sharedBottomSeamNodes,29);assert.equal(report.fixed.sharedBottomSeamSegments,28);
assert.ok(report.broken.modes.some(s=>s.maxBottomSeamJumpOverPeakTranslation>.1));assert.ok(report.fixed.modes.every(s=>s.maxBottomSeamJumpOverPeakTranslation===0));
assert.equal(models.broken.quads.size,models.fixed.quads.size);for(const [id,nn]of models.broken.quads)assert.deepEqual(nn.map(n=>key(models.broken.nodes.get(n))),models.fixed.quads.get(id).map(n=>key(models.fixed.nodes.get(n))),'Element geometry changed: '+id);
const unchanged=deck=>deck.split('\n').filter(l=>/^(MAT1|PSHELL|PBUSH|CONM2|CORD2R|SPC1|PARAM),/.test(l));assert.deepEqual(unchanged(read('broken-modal.bdf.gz')),unchanged(read('fixed-modal.bdf.gz')));
fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
console.log('PASS: identical shell geometry/properties/masses/supports; original bottom seam cracked; repaired seam shares all 29 nodes and 28 segments; 12 modal vectors continuous.');
