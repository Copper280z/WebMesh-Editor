/* Rectangular frame actions. Positions stay basic; GRID CD controls DOF directions. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.WebMeshCoordinates=factory();}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const GENERATOR='rectangular-frame-v1',copy=v=>JSON.parse(JSON.stringify(v)),objects=s=>s?.project.objects||[];
  const sub=(a,b)=>a.map((v,i)=>v-b[i]),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],unit=v=>v.map(x=>x/Math.hypot(...v));
  function axes(v){
    for(const p of [v.origin,v.zAxisPt,v.xzPlanePt])if(!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite))throw Error('Frame points require three finite basic XYZ coordinates.');
    const z=sub(v.zAxisPt,v.origin),p=sub(v.xzPlanePt,v.origin),y=cross(z,p);
    if(![...z,...p,...y].every(Number.isFinite)||!Number.isFinite(Math.hypot(...y))||!Math.hypot(...z)||!Math.hypot(...p)||Math.hypot(...y)<=1e-10*Math.hypot(...z)*Math.hypot(...p))throw Error('Frame points must be distinct and noncollinear.');
    const ez=unit(z),ey=unit(y);return [cross(ey,ez),ey,ez].map(v=>v.map(x=>x||0));
  }
  function vector(v,basis){return [0,1,2].map(i=>v.reduce((s,x,j)=>s+x*basis[j][i],0));}
  function frame(state,id){if(!id)return {cid:0,axes:[[1,0,0],[0,1,0],[0,0,1]]};const o=objects(state).find(o=>o.id===id);if(o?.definition.generator!==GENERATOR||o.facts?.suspendedReason)throw Error('Select an active rectangular frame.');const c=o.definition.cards[0];return {cid:c.id,axes:axes(c.value)};}
  function build(input,state,ids){
    const old=objects(state).find(o=>o.id===input.id);if(!input.id||!input.name?.trim()||old&&old.definition.generator!==GENERATOR)throw Error('Enter a frame name and valid identity.');
    const cid=old?.definition.cards[0].id||Math.max(ids.coordinate||1,...(state?.project.reservations||[]).filter(r=>r.namespace==='coordinate').map(r=>r.end+1));
    const value={type:'CORD2R',cid,rid:0,origin:input.origin,zAxisPt:input.zAxisPt,xzPlanePt:input.xzPlanePt};axes(value);
    return {label:(old?'Update ':'Create ')+input.name,objects:[{id:input.id,name:input.name.trim(),kind:'frame',dependsOn:[],definition:{generator:GENERATOR,actions:[{action:'rectangular-frame',...copy(value)}],cards:[{family:'coords',id:cid,role:'frame',value:copy(value)}]}}]};
  }
  function overlay(state,request){const s=copy(state||{project:{objects:[],reservations:[]},owners:[]}),m=new Map(objects(s).map(o=>[o.id,o]));for(const o of request.objects||[])m.set(o.id,copy(o));for(const id of [...(request.removeObjects||[]),...(request.convertToPlain||[])])m.delete(id);s.project.objects=[...m.values()];return s;}
  // A public assignment action, also composed by support authoring. Metadata
  // belongs to the GRID owner and is reapplied after its geometric generator.
  function assign(input,state){
    const f=frame(state,input.frame),changed=new Map();if(!input.nodes?.length||new Set(input.nodes).size!==input.nodes.length)throw Error('Select distinct owned GRIDs.');
    for(const id of input.nodes){const original=objects(state).find(o=>o.definition.cards?.some(c=>c.family==='nodes'&&c.id===id));if(!original)throw Error('GRID '+id+' is not project-owned. Assign its CD in the card editor.');
      const o=changed.get(original.id)||copy(original),c=o.definition.cards.find(c=>c.family==='nodes'&&c.id===id);if(c.value.cp)throw Error('Frame assignment currently requires basic GRID positions (CP=0).');
      const assignments=o.definition.nodeFrames||[];o.definition.nodeFrames=assignments.filter(a=>a.role!==c.role);o.definition.nodeFrames.push({role:c.role,node:id,frame:input.frame||null,...(input.source?{source:input.source}:{})});c.value.cd=f.cid;changed.set(o.id,o);
    }
    for(const o of changed.values()){const frames=new Set((o.definition.nodeFrames||[]).map(b=>b.frame).filter(Boolean));const prior=new Set((objects(state).find(x=>x.id===o.id)?.definition.nodeFrames||[]).map(b=>b.frame).filter(Boolean));o.dependsOn=[...new Set([...(o.dependsOn||[]).filter(id=>!prior.has(id)),...frames])];}
    return {label:'Assign GRID displacement frame',objects:[...changed.values()]};
  }
  function rebuild(state,request){
    const s=overlay(state,request),changed=new Map((request.objects||[]).map(o=>[o.id,copy(o)])),old=new Map(objects(state).map(o=>[o.id,o]));
    for(const current of objects(s)){
      const raw=current.definition.nodeFrames??old.get(current.id)?.definition.nodeFrames;const bindings=raw?.map(b=>{if(b.source&&!objects(s).some(o=>o.id===b.source)){const x=copy(b);delete x.source;return x;}return b;});if(!bindings?.length)continue;
      if(!changed.has(current.id)&&!bindings.some(b=>changed.has(b.frame)))continue;
      const o=copy(current);o.definition.nodeFrames=copy(bindings.filter(b=>!b.source));
      const prior=new Set((old.get(o.id)?.definition.nodeFrames||[]).map(b=>b.frame).filter(Boolean));
      o.dependsOn=(o.dependsOn||[]).filter(id=>!prior.has(id));
      for(const b of bindings.filter(b=>!b.source)){const c=o.definition.cards.find(c=>c.family==='nodes'&&c.role===b.role);if(!c&&!b.frame){o.definition.nodeFrames=o.definition.nodeFrames.filter(a=>a.role!==b.role);continue;}if(!c)throw Error(o.name+': displacement-frame selection '+b.role+' was replaced. Repair its GRID selection.');c.value.cd=frame(s,b.frame).cid;if(b.frame)o.dependsOn.push(b.frame);}
      o.dependsOn=[...new Set(o.dependsOn)];changed.set(o.id,o);
    }
    // Support guides compose assignments; region-backed support membership can
    // change on remesh. Reapply these bindings after the support resolver.
    for(const support of objects(s).filter(o=>o.definition.generator==='analysis-set-v1'&&o.definition.action.action==='support'&&Object.hasOwn(o.definition,'frame'))){
      const d=support.definition,cid=frame(s,d.frame).cid;
      for(const id of d.action.nodes){const original=objects(s).find(o=>o.definition.cards?.some(c=>c.family==='nodes'&&c.id===id));if(!original)throw Error(support.name+': support frame requires owned GRID '+id+'.');
        const o=changed.get(original.id)||copy(original),c=o.definition.cards.find(c=>c.family==='nodes'&&c.id===id);
        if(changed.has(o.id)&&c.value.cd!==cid&&(o.definition.nodeFrames||[]).some(b=>b.role===c.role&&b.source!==support.id))throw Error(support.name+': GRID '+id+' displacement frame differs from the support frame.');
        const binding={role:c.role,node:id,frame:d.frame||null,source:support.id};
        const existing=(o.definition.nodeFrames||[]).find(b=>b.role===c.role);
        if(existing?.source&&existing.source!==support.id&&existing.frame!==binding.frame)throw Error('Conflicting support frames at GRID '+id+'.');
        if(c.value.cd!==cid||JSON.stringify(existing)!==JSON.stringify(binding)){
          c.value.cd=cid;o.definition.nodeFrames=[...(o.definition.nodeFrames||[]).filter(b=>b.role!==c.role),binding];o.dependsOn=[...new Set([...(o.dependsOn||[]),...(d.frame?[d.frame]:[])])];changed.set(o.id,o);
        }
      }
    }
    return {...copy(request),objects:[...changed.values()]};
  }
  function resultCoordinates(semantic){
    try{return semantic.nodes.map(([id,n])=>{if(n.cp)throw Error('Nonbasic position');const cid=n.cd||0,c=semantic.coords.find(([id])=>id===cid)?.[1];if(cid&&(c?.type!=='CORD2R'||c.rid))throw Error('Unsupported output frame');return [id,[n.x,n.y,n.z],...(cid?[{cid,axes:axes(c)}]:[])];});}catch{return null;}
  }
  function normalizeResults(results,semantic){
    const grids=new Map(semantic.nodes),coords=new Map(semantic.coords),seen=new Set(),changes=[];
    for(const set of [results,...(results.resultSets||[])])for(const family of ['displacements','gpForces','mpcForces','oloadForces'])for(const [nid,row]of Object.entries(set[family]||{})){
      if(seen.has(row)||row.vectorFrame==='basic')continue;seen.add(row);
      const cid=row.coord??grids.get(Number(nid))?.cd??0;if(!cid)continue;
      const c=coords.get(cid);if(c?.type!=='CORD2R'||c.rid)throw Error('Cannot display nodal vectors in unresolved output frame '+cid+'.');
      const basis=axes(c),values={};for(const keys of [['t1','t2','t3'],['r1','r2','r3']]){const local=keys.map(k=>row[k]);if(!local.every(Number.isFinite))throw Error('Incomplete nodal vector in output frame '+cid+'.');vector(local,basis).forEach((v,i)=>values[keys[i]]=v);}
      changes.push([row,{...values,sourceCoord:cid,coord:0,vectorFrame:'basic'}]);
    }
    for(const [row,values]of changes)Object.assign(row,values);return results;
  }
  function remove(state,id){if(objects(state).some(o=>o.dependsOn?.includes(id)))throw Error('Reassign frame users before removing this frame.');return {label:'Remove coordinate frame',removeObjects:[id]};}
  return Object.freeze({GENERATOR,axes,vector,frame,build,assign,rebuild,overlay,remove,resultCoordinates,normalizeResults});
}));
