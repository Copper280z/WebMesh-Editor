// Verify portable CAD history against the existing solved rover. --unpack writes a loadable project.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../../..'),R=require(root+'/app/analysis-runs.js');
const read=p=>JSON.parse(zlib.gunzipSync(fs.readFileSync(p)));
const project=read(path.join(__dirname,'../project-workspace/rover-remesh.webmesh.gz'));
const parts=read(path.join(__dirname,'redo-cad-parts.json.gz'));
const hash=raw=>crypto.createHash('sha256').update(raw).digest('hex');
(async()=>{
 assert.equal(parts.entries.length,2);
 const histories=parts.entries.map(({part,data})=>{
  const cp=data.prepared.checkpoint,raw=Buffer.from(cp.content,'base64');assert.equal(hash(raw),cp.sha256);
  const archive=JSON.parse(zlib.gunzipSync(raw));assert.equal(archive.version,1);assert.equal(archive.cursor,0);
  assert.ok(project.ownership.project.objects.some(o=>o.id===part&&o.definition.generator==='part-v1'));
  for(const state of archive.states){assert.ok(Buffer.from(state.geometry,'base64').length);assert.ok(state.result.topology.faces.length);assert.ok(state.result.preview.positions.length);}
  if(data.filename==='wheel.step'){
   assert.equal(archive.states.length,2);assert.equal(archive.revision,2);
   assert.equal(archive.states[0].sheets[0].thickness,2);assert.equal(archive.states[0].sheets[0].offset,-1);
   assert.equal(archive.states[1].sheets[0].thickness,2.2);assert.equal(archive.states[1].sheets[0].offset,-1.1);
   assert.equal(data.settings.shell.size,3);assert.equal(data.settings.shell.perCircle,12);
  }else assert.equal(archive.states.length,1);
  return {file:data.filename,states:archive.states.length,cursor:archive.cursor,revision:archive.revision,sha256:cp.sha256};
 });
 const digest=await R.digest(project.deck+'\0'+R.canonical(project.ownership));assert.equal(project.snapshotDigest,digest);assert.equal(project.analysisRuns.at(-1).modelDigest,digest);
 for(const run of project.analysisRuns)await R.validate(run);
 project.cadParts=parts;
 if(process.argv.includes('--unpack')){
  const target=path.join(__dirname,'rover-cad-redo.webmesh');fs.writeFileSync(target,JSON.stringify(project));console.log('Open '+target);
 }
 console.log(JSON.stringify({modelDigest:digest,savedRuns:project.analysisRuns.length,histories},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
