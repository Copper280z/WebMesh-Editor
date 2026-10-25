/* Conservative CAD correspondence and reversible suspension. No engine or DOM. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./cad-selective-mesh.js'),require('./cad-patterns.js'));else root.WebMeshCadReplacement=factory(root.WebMeshCadSelective,root.WebMeshCadPatterns);}(typeof globalThis!=='undefined'?globalThis:this,function(Selective,Patterns){
  'use strict';
  const copy=v=>JSON.parse(JSON.stringify(v)),objects=s=>s?.project.objects||[],mesh=o=>['cad-mapped-v1','cad-shell-v1'].includes(o.definition.generator);
  const families=['faces','edges','volumes'],measure={faces:'area',edges:'length',volumes:'volume'};
  const center=e=>e.center||e.bounds?.slice(0,3).map((x,i)=>(x+e.bounds[i+3])/2)||null;
  function anchor(topology,family,id){
    const e=topology?.[family]?.find(e=>e.id===id);if(!e)return null;
    // Revision-local entity numbers are deliberately absent from the signature.
    const adjacent=family==='faces'?'edges':'faces',other=adjacent==='edges'?'length':'area';
    const context=(e[adjacent]||[]).map(n=>topology[adjacent]?.find(a=>a.id===Math.abs(n))).filter(Boolean).map(a=>[a.type||'',family==='edges'?(a.normal||a.surface?.normal||[]):a[other]||0]).sort((a,b)=>a[0].localeCompare(b[0])||JSON.stringify(a[1]).localeCompare(JSON.stringify(b[1])));
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
  function build(state,{part,topology,snapshot,geometryKey,before,choices={},patternChoices={},selective=true,revisionId}){
    const p=objects(state).find(o=>o.id===part&&o.definition.generator==='part-v1'),src=objects(state).find(o=>o.id===p?.definition.source);if(!src)throw Error('Select a CAD part.');
    if(!snapshot?.content||!snapshot?.prepared?.content||typeof geometryKey!=='string'||!geometryKey||typeof revisionId!=='string'||!revisionId||revisionId===src.definition.replacement?.revisionId)throw Error('A replacement requires a prepared CAD checkpoint.');
    const matches=match(before,topology),selected=new Map(),patterns=Patterns.report(state,src.id,before,topology);
    for(const p of patterns){
      const ids=Object.hasOwn(patternChoices,p.id)?patternChoices[p.id]:p.target;
      if(ids!==null&&!p.candidates.some(c=>JSON.stringify(c.ids)===JSON.stringify(ids)))throw Error('Choose a complete candidate for '+p.name+'.');
      const old=objects(state).find(o=>o.id===p.id);
      p.target=ids;p.status=ids?(p.status==='exact'&&JSON.stringify(ids)===JSON.stringify(Patterns.match(p.pattern,topology).target)?'exact':'accepted'):p.status;
      for(let i=0;i<old.definition.pattern.holes.length;i++)choices={...choices,['edges:'+old.definition.pattern.holes[i].id]:ids?.[i]??null};
    }
    for(const r of matches){const key=r.family+':'+r.id,value=Object.hasOwn(choices,key)?choices[key]:r.target;if(value!==null&&(!Number.isSafeInteger(value)||!topology[r.family]?.some(e=>e.id===value)))throw Error('Choose an existing replacement '+r.family+' entity.');selected.set(key,value);const automatic=r.target;r.target=value;r.status=value===null?r.status:value===automatic?'exact':'accepted';}
    for(const family of families){const values=matches.filter(r=>r.family===family&&r.target!==null).map(r=>r.target);if(new Set(values).size!==values.length)throw Error('Two old '+family+' entities cannot share one replacement. Split/merge selections must be repaired explicitly.');}
    const mapped=(family,ids)=>(ids||[]).map(id=>selected.get(family+':'+id)??null),complete=ids=>ids.every(id=>id!==null);
    const roots=objects(state).filter(o=>mesh(o)&&o.definition.source===src.id),affected=closure(state,[...roots.map(o=>o.id),...objects(state).filter(o=>o.definition.generator==='part-instance-v1'&&o.definition.part===part).map(o=>o.id)]);
    const next=copy(src);next.name=snapshot.filename+' · CAD source';next.definition={...next.definition,geometryKey,topology:copy(topology),snapshot:copy(snapshot),replacement:{revisionId,previousGeometryKey:src.definition.geometryKey,matches,patterns},cards:[]};
    const changed=[next,copy(p)],kept=new Map(),suspend=new Set();
    if(selective)for(const root of roots){const result=Selective.retain(root,before,topology,matches,geometryKey);if(result){kept.set(root.id,result.object);if(result.pending)changed.push(result.pending);}}
    for(const root of roots)if(!kept.has(root.id))suspend.add(root.id);
    for(const old of objects(state))if(affected.has(old.id)){
      const o=kept.get(old.id)||copy(old),d=o.definition;let reason='CAD source replaced. Rebuild or repair this object before analysis.';
      if(mesh(o)&&!kept.has(o.id)){const family=d.generator==='cad-shell-v1'?'faces':'volumes',ids=mapped(family,d.targets);d.replacementTargets=complete(ids)?ids:null;reason=complete(ids)?'CAD source replaced. Remesh this region on the matched topology.':'CAD source replaced. Select replacement mesh targets and remesh.';}
      if(d.generator==='cad-mount-region-v1'){
        const family=d.selector.kind==='edge'?'edges':'faces',ids=mapped(family,d.selector.faces),parent=kept.get(d.selector.mesh);
        if(complete(ids)){d.selector.faces=ids;d.selector.geometryKey=geometryKey;if(d.pattern)d.pattern=Patterns.define(topology,ids);}
        if(!complete(ids)||!parent||ids.some(id=>!parent.definition[family].some(f=>f.id===id))){suspend.add(o.id);reason='CAD mounting pattern or selection requires explicit repair on the replacement mesh.';}
      }
      if(['shell-solid-rbe3-v1','shell-solid-embedded-v1'].includes(d.generator)){const edges=mapped('edges',d.edges),faces=mapped('faces',d.faces);if(complete(edges)&&complete(faces)){d.edges=edges;d.faces=faces;d.geometryKey=geometryKey;}suspend.add(o.id);}
      if(!selective)suspend.add(o.id);
      o.facts={...o.facts,...(suspend.has(o.id)?{suspendedReason:reason}:{})};changed.push(o);
    }
    const removedNodes=new Set(roots.flatMap(o=>o.definition.cards.filter(c=>c.family==='nodes'&&!kept.get(o.id)?.definition.cards.some(n=>n.family==='nodes'&&n.id===c.id)).map(c=>c.id)));
    for(const o of objects(state))if(affected.has(o.id)&&o.definition.bindings?.some(b=>b.kind==='node'&&removedNodes.has(b.id)))suspend.add(o.id);
    for(const o of kept.values())for(const section of o.definition.sections){const prior=objects(state).find(x=>x.id===section.id);if(prior&&!changed.some(x=>x.id===prior.id)){const s=copy(prior);s.definition.region={geometryKey,[o.definition.generator==='cad-shell-v1'?'faces':'volumes']:section.volumes};changed.push(s);}}
    const downstream=closure(state,suspend);
    for(const o of changed)if(downstream.has(o.id))o.facts={...o.facts,suspendedReason:o.facts?.suspendedReason||'CAD replacement removed a required selection. Repair its upstream region first.'};
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
    let o=objects(state).find(o=>o.id===id);if(o?.definition.instance||o?.definition.assemblyMember){id=o.definition.instance||o.definition.assemblyMember;o=objects(state).find(o=>o.id===id);}if(!o?.facts?.suspendedReason)throw Error('Select a suspended definition.');if(o?.definition.generator===Selective.PENDING)throw Error('Remesh the changed faces through their CAD mesh owner.');if(mesh(o))throw Error('Remesh this CAD region to reactivate it.');
    // Instances and connection recipes own materializations; review them together.
    const bundle=objects(state).filter(x=>x.id===id||x.definition.instance===id||x.definition.assemblyMember===id),ids=new Set(bundle.map(o=>o.id));
    for(const x of bundle)for(const parent of x.dependsOn||[])if(!ids.has(parent)&&objects(state).find(o=>o.id===parent)?.facts?.suspendedReason)throw Error('Repair '+objects(state).find(o=>o.id===parent).name+' first.');
    return {label:'Repair '+o.name,objects:bundle.map(x=>({...copy(x),facts:{...x.facts,suspendedReason:null}}))};
  }
  function reactivate(state,request){
    const map=new Map(objects(state).map(o=>[o.id,o])),changed=new Map((request.objects||[]).map(o=>[o.id,o])),affected=closure(state,changed.keys());for(const [id,o]of changed)map.set(id,o);
    let more=true;while(more){more=false;for(const id of affected){const o=map.get(id);if(!o?.facts?.suspendedReason||mesh(o)||o.definition.generator===Selective.PENDING)continue;
      try{const r=resume({project:{objects:[...map.values()]}},id);for(const x of r.objects){changed.set(x.id,x);map.set(x.id,x);}more=true;}catch{/* A different unresolved input still blocks this object. */}
    }}return {...request,objects:[...changed.values()]};
  }
  return Object.freeze({anchor,match,references,report,build,active,resume,closure,reactivate});
}));
