/* Conservative CAD correspondence and reversible suspension. No engine or DOM. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.WebMeshCadReplacement=factory();}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const copy=v=>JSON.parse(JSON.stringify(v)),objects=s=>s?.project.objects||[],mesh=o=>['cad-mapped-v1','cad-shell-v1'].includes(o.definition.generator);
  const families=['faces','edges','volumes'],measure={faces:'area',edges:'length',volumes:'volume'};
  const center=e=>e.center||e.bounds?.slice(0,3).map((x,i)=>(x+e.bounds[i+3])/2)||null;
  function anchor(topology,family,id){
    const e=topology?.[family]?.find(e=>e.id===id);if(!e)return null;
    // Revision-local entity numbers are deliberately absent from the signature.
    const adjacent=family==='faces'?'edges':'faces',other=adjacent==='edges'?'length':'area';
    const context=(e[adjacent]||[]).map(n=>topology[adjacent]?.find(a=>a.id===Math.abs(n))).filter(Boolean).map(a=>[a.type||'',a[other]||0]).sort((a,b)=>a[0].localeCompare(b[0])||a[1]-b[1]);
    return {type:e.type||family,center:center(e),bounds:e.bounds||null,measure:e[measure[family]],normal:e.normal||e.surface?.normal||null,radius:e.radius||e.surface?.radius||null,context};
  }
  function near(a,b,tolerance){if(a===b)return true;if(typeof a==='number'&&typeof b==='number')return Math.abs(a-b)<=tolerance*Math.max(1,Math.abs(a),Math.abs(b));if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>near(v,b[i],tolerance));return false;}
  function exact(a,b){return a&&b&&a.type===b.type&&['center','bounds','measure','normal','radius','context'].every(k=>near(a[k],b[k],1e-7))&&a.center&&a.bounds&&Number.isFinite(a.measure);}
  function match(before,after){
    const result=[];
    for(const family of families){
      const old=(before?.[family]||[]).map(e=>({id:e.id,anchor:anchor(before,family,e.id)})),next=(after?.[family]||[]).map(e=>({id:e.id,anchor:anchor(after,family,e.id)}));
      for(const a of old){
        const hits=next.filter(b=>exact(a.anchor,b.anchor)),unique=hits.length===1&&old.filter(o=>exact(o.anchor,hits[0].anchor)).length===1;
        const candidates=next.filter(b=>b.anchor.type===a.anchor.type).map(b=>({id:b.id,center:b.anchor.center,score:a.anchor.center&&b.anchor.center?Math.hypot(...a.anchor.center.map((x,i)=>x-b.anchor.center[i])):Infinity})).sort((a,b)=>a.score-b.score||a.id-b.id).slice(0,8).map(({id,center})=>({id,center}));
        result.push({family,id:a.id,anchor:a.anchor,status:unique?'exact':hits.length?'ambiguous':'missing',target:unique?hits[0].id:null,candidates});
      }
    }return result;
  }
  function references(state,source){
    const refs=new Map(),add=(family,ids,o)=>{for(const id of ids||[]){const key=family+':'+id;if(!refs.has(key))refs.set(key,{family,id,users:[]});if(!refs.get(key).users.includes(o.name))refs.get(key).users.push(o.name);}};
    const roots=objects(state).filter(o=>mesh(o)&&o.definition.source===source),rootIds=new Set(roots.map(o=>o.id));
    for(const o of roots){add(o.definition.generator==='cad-shell-v1'?'faces':'volumes',o.definition.targets,o);for(const e of o.definition.settings?.sizing?.edges||[])add('edges',[e.id],o);}
    for(const o of objects(state)){const d=o.definition;if(d.generator==='cad-mount-region-v1'&&rootIds.has(d.selector.mesh))add(d.selector.kind==='edge'?'edges':'faces',d.selector.faces,o);if(rootIds.has(d.shell)||rootIds.has(d.solid)){add('edges',d.edges,o);add('faces',d.faces,o);}}
    return [...refs.values()];
  }
  function report(state,source,before,after){const matches=match(before,after);return references(state,source).map(r=>({...r,...(matches.find(m=>m.family===r.family&&m.id===r.id)||{anchor:null,status:'missing',target:null,candidates:[]})}));}
  function closure(state,seeds){const ids=new Set(seeds);let more=true;while(more){more=false;for(const o of objects(state))if(!ids.has(o.id)&&(o.dependsOn?.some(id=>ids.has(id))||ids.has(o.definition.embeddedBy)||(o.definition.actionEdits||[]).some(id=>ids.has(id)))){ids.add(o.id);more=true;}}return ids;}
  function build(state,{part,topology,snapshot,geometryKey,before,choices={},revisionId}){
    const p=objects(state).find(o=>o.id===part&&o.definition.generator==='part-v1'),src=objects(state).find(o=>o.id===p?.definition.source);if(!src)throw Error('Select a CAD part.');
    if(!snapshot?.content||!snapshot?.prepared?.content||typeof geometryKey!=='string'||!geometryKey||typeof revisionId!=='string'||!revisionId||revisionId===src.definition.replacement?.revisionId)throw Error('A replacement requires a prepared CAD checkpoint.');
    const matches=report(state,src.id,before,topology),selected=new Map();
    for(const r of matches){const key=r.family+':'+r.id,value=Object.hasOwn(choices,key)?choices[key]:r.target;if(value!==null&&(!Number.isSafeInteger(value)||!topology[r.family]?.some(e=>e.id===value)))throw Error('Choose an existing replacement '+r.family+' entity.');selected.set(key,value);const automatic=r.target;r.target=value;r.status=value===null?r.status:value===automatic?'exact':'accepted';}
    for(const family of families){const values=matches.filter(r=>r.family===family&&r.target!==null).map(r=>r.target);if(new Set(values).size!==values.length)throw Error('Two old '+family+' entities cannot share one replacement. Split/merge selections must be repaired explicitly.');}
    const mapped=(family,ids)=>(ids||[]).map(id=>selected.get(family+':'+id)??null),complete=ids=>ids.every(id=>id!==null);
    const roots=objects(state).filter(o=>mesh(o)&&o.definition.source===src.id),affected=closure(state,[...roots.map(o=>o.id),...objects(state).filter(o=>o.definition.generator==='part-instance-v1'&&o.definition.part===part).map(o=>o.id)]);
    const next=copy(src);next.name=snapshot.filename+' · CAD source';next.definition={...next.definition,geometryKey,topology:copy(topology),snapshot:copy(snapshot),replacement:{revisionId,previousGeometryKey:src.definition.geometryKey,matches},cards:[]};
    const changed=[next,copy(p)];
    for(const old of objects(state))if(affected.has(old.id)){
      const o=copy(old),d=o.definition;let reason='CAD source replaced. Rebuild or repair this object before analysis.';
      if(mesh(o)){const family=d.generator==='cad-shell-v1'?'faces':'volumes',ids=mapped(family,d.targets);d.replacementTargets=complete(ids)?ids:null;reason=complete(ids)?'CAD source replaced. Remesh this region on the matched topology.':'CAD source replaced. Select replacement mesh targets and remesh.';}
      if(d.generator==='cad-mount-region-v1'){const family=d.selector.kind==='edge'?'edges':'faces',ids=mapped(family,d.selector.faces);if(complete(ids)){d.selector.faces=ids;d.selector.geometryKey=geometryKey;}else reason='CAD mounting selection has missing or ambiguous matches. Repair this region after remeshing.';}
      if(['shell-solid-rbe3-v1','shell-solid-embedded-v1'].includes(d.generator)){const edges=mapped('edges',d.edges),faces=mapped('faces',d.faces);if(complete(edges)&&complete(faces)){d.edges=edges;d.faces=faces;d.geometryKey=geometryKey;}}
      o.facts={...o.facts,suspendedReason:reason};changed.push(o);
    }
    return {label:'Replace CAD source · '+p.name,objects:changed};
  }
  // Run existing generators on the active dependency graph. Retained suspended
  // definitions are merged back before the guarded engine transaction.
  function active(state,request){
    const map=new Map(objects(state).map(o=>[o.id,o]));for(const o of request.objects||[])map.set(o.id,o);for(const id of request.removeObjects||[])map.delete(id);
    const suspended=new Set([...map.values()].filter(o=>o.facts?.suspendedReason).map(o=>o.id));
    for(const o of map.values())if(!suspended.has(o.id)&&o.dependsOn?.some(id=>suspended.has(id)))throw Error(o.name+': repair suspended dependencies first.');
    const retained=(request.objects||[]).filter(o=>suspended.has(o.id));
    return {state:state?{...state,project:{...state.project,objects:objects(state).filter(o=>!suspended.has(o.id))}}:state,request:{...request,objects:(request.objects||[]).filter(o=>!suspended.has(o.id))},merge:r=>({...r,objects:[...r.objects||[],...retained]})};
  }
  function resume(state,id){
    let o=objects(state).find(o=>o.id===id);if(o?.definition.instance||o?.definition.assemblyMember){id=o.definition.instance||o.definition.assemblyMember;o=objects(state).find(o=>o.id===id);}if(!o?.facts?.suspendedReason)throw Error('Select a suspended definition.');if(mesh(o))throw Error('Remesh this CAD region to reactivate it.');
    // Instances and connection recipes own materializations; review them together.
    const bundle=objects(state).filter(x=>x.id===id||x.definition.instance===id||x.definition.assemblyMember===id),ids=new Set(bundle.map(o=>o.id));
    for(const x of bundle)for(const parent of x.dependsOn||[])if(!ids.has(parent)&&objects(state).find(o=>o.id===parent)?.facts?.suspendedReason)throw Error('Repair '+objects(state).find(o=>o.id===parent).name+' first.');
    return {label:'Repair '+o.name,objects:bundle.map(x=>({...copy(x),facts:{...x.facts,suspendedReason:null}}))};
  }
  return Object.freeze({anchor,match,references,report,build,active,resume,closure});
}));
