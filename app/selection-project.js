/* Pending selection inspection/repair never writes the live model. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./coordinate-project.js'),require('./attachment-project.js'),require('./mass-project.js'),require('./analysis-project.js'),require('./mesh-action-project.js'),require('./interface-project.js'),require('./embedded-interface.js'),require('./mesh-region-project.js'));else root.WebMeshSelections=factory(root.WebMeshCoordinates,root.WebMeshAttachmentProject,root.WebMeshMassProject,root.WebMeshAnalysisProject,root.WebMeshActionProject,root.WebMeshInterfaceProject,root.WebMeshEmbeddedInterface,root.WebMeshRegions);}(typeof globalThis!=='undefined'?globalThis:this,function(F,M,Mass,Analysis,Mesh,Tie,Embedded,R){
  'use strict';
  const copy=v=>JSON.parse(JSON.stringify(v)),canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v),objects=s=>s?.project.objects||[];
  function project(state,semantic,request={}){
    const s=F.overlay(state,request),m=copy(semantic),changed=new Set([...(request.objects||[]).map(o=>o.id),...(request.removeObjects||[])]);
    const old=objects(state).filter(o=>changed.has(o.id)).flatMap(o=>o.definition.cards||[]),retired=new Map();for(const c of old){if(!retired.has(c.family))retired.set(c.family,new Set());retired.get(c.family).add(c.id);}
    for(const family of ['nodes','properties','materials','coords','masses'])m[family]=(m[family]||[]).filter(([id])=>!retired.get(family)?.has(id));
    for(const bucket of Object.keys(m.elems||{}))m.elems[bucket]=m.elems[bucket].filter(v=>!retired.get('elems')?.has(v.eid));
    for(const o of request.objects||[])for(const c of o.definition.cards||[]){if(c.family==='elems')(m.elems[c.bucket]||=[]).push(copy(c.value));else if(['nodes','properties','materials','coords','masses'].includes(c.family))m[c.family].push([c.id,copy(c.value)]);}
    return {state:s,semantic:m};
  }
  function inspect(state,semantic,request={}){
    const pending=project(state,semantic,request),catalog=new Map(objects(pending.state).map(o=>[o.id,o])),nodes=new Map(pending.semantic.nodes),elements=new Map(Object.values(pending.semantic.elems).flat().map(e=>[e.eid,e])),entries=[],ownedNodes=new Map([...catalog.values()].flatMap(o=>(o.definition.cards||[]).filter(c=>c.family==='nodes').map(c=>[c.id,{owner:o.id,role:c.role}])));
    for(const o of catalog.values()){
      const d=o.definition,issues=[],ns=new Set(),es=new Set();let type=null;
      const bindings=d.nodeFrames??objects(state).find(x=>x.id===o.id)?.definition.nodeFrames;
      for(const b of bindings||[])if(!b.source&&b.frame){type='frames';const c=d.cards.find(c=>c.family==='nodes'&&c.role===b.role);ns.add(b.node);if(!c)issues.push('GRID '+b.node+' displacement frame selection was replaced.');}
      if(R.isRegion(o)){type='mesh-region';try{const r=R.resolve(o,catalog,pending.semantic);r.definition.resolved.nodes.forEach(n=>ns.add(n));r.definition.resolved.elements.forEach(e=>es.add(e));}catch(e){issues.push(e.message);(d.resolved?.nodes||[]).forEach(n=>ns.add(n));(d.resolved?.elements||[]).forEach(e=>es.add(e));}}
      if(d.generator===M.REGION){type='region';try{M.resolveRegion(o,catalog).definition.resolved.nodes.forEach(n=>ns.add(n));}catch(e){issues.push(e.message);(d.resolved?.nodes||[]).forEach(n=>ns.add(n));}}
      if([Tie.GENERATOR,Embedded.GENERATOR].includes(d.generator)){
        type='interface';const shell=catalog.get(d.shell),solid=catalog.get(d.solid);
        if(catalog.get(shell?.definition.source)?.definition.geometryKey!==d.geometryKey)issues.push('The CAD topology changed; confirm replacement shell edges and solid faces.');
        for(const [ids,mesh,family] of [[d.edges,shell,'edges'],[d.faces,solid,'faces']])for(const id of ids||[]){const f=mesh?.definition[family]?.find(f=>f.id===id);if(!f?.nodes.length)issues.push('Missing '+family+' '+id+'.');else f.nodes.forEach(n=>ns.add(n));}
      }
      if((d.sources?.length||d.inputs?.length)&&![M.REGION,Tie.GENERATOR,Embedded.GENERATOR].includes(d.generator))type='explicit';
      if(d.generator==='analysis-participation-v1'){type='elements';if(d.region){const region=catalog.get(d.region);try{const r=R.resolve(region,catalog,pending.semantic);r.definition.resolved.elements.forEach(e=>es.add(e));}catch(e){issues.push('Repair the named element region first: '+(region?.name||d.region)+'.');}}}
      for(const source of d.sources||[]){ns.add(source.id);if(ownedNodes.get(source.id)?.owner!==source.owner||ownedNodes.get(source.id)?.role!==source.role)issues.push('GRID '+source.id+' no longer has its selected owner/role.');}
      for(const i of d.inputs||[]){const node=i.card.family==='nodes',current=(node?nodes:elements).get(i.card.id);(node?ns:es).add(i.card.id);if(!current)issues.push('Missing '+i.key+'.');else if(canonical(current)!==canonical(i.card.value))issues.push('Changed explicit input '+i.key+'; review and accept or replace it.');}
      for(const e of (d.region?[]:d.analysisExcluded)||[]){es.add(e.id);const current=elements.get(e.id);if(!current||current.type!==e.type||canonical(current.n)!==canonical(e.n))issues.push('Excluded element '+e.id+' was replaced.');}
      if(type)entries.push({id:o.id,name:o.name,type,nodes:[...ns],elements:[...es],issues,dependents:objects(pending.state).filter(x=>x.dependsOn?.includes(o.id)).map(x=>x.name)});
    }
    return entries;
  }
  function repair(state,semantic,request,input,ids){
    const pending=project(state,semantic,request),s=pending.state,m=pending.semantic,o=objects(s).find(o=>o.id===input.id);if(!o)throw Error('Selection owner is missing.');
    const d=o.definition,nmap=new Map(input.nodes||[]),emap=new Map(input.elements||[]),n=id=>nmap.get(id)??id,e=id=>emap.get(id)??id;
    for(const pairs of [input.nodes||[],input.elements||[]]){if(new Set(pairs.map(p=>p[0])).size!==pairs.length||pairs.some(p=>p.length!==2||p.some(v=>!Number.isSafeInteger(v)||v<1)))throw Error('Use distinct positive old → new ID pairs.');}
    let built;
    ids={...ids};for(const [family,ns] of [['nodes','node'],['elems','element']])ids[ns]=Math.max(ids[ns]||1,...objects(s).flatMap(o=>(o.definition.cards||[]).filter(c=>(c.family===family||family==='elems'&&c.family==='masses')).map(c=>c.id+1)));
    const bindings=d.nodeFrames??objects(state).find(x=>x.id===o.id)?.definition.nodeFrames;
    if(bindings?.length&&['cad-mapped-v1','cad-shell-v1','analysis-point-v1'].includes(d.generator)){const next=copy(o);next.definition.nodeFrames=bindings.filter(b=>!b.source).map(b=>{const id=n(b.node),card=next.definition.cards.find(c=>c.family==='nodes'&&c.id===id);if(!card)throw Error('Select a replacement for GRID '+b.node+'.');return {...b,node:id,role:card.role};});built={objects:[next]};}
    else if(R.isRegion(o))built=R.build({id:o.id,name:o.name,entity:d.entity,ids:d.entity==='node'?(input.selectedNodes||d.ids.map(n)):(input.selectedElements||d.ids.map(e))},s,m);
    else if(d.generator===M.REGION)built=M.region({id:o.id,name:o.name,mesh:input.mesh||d.selector.mesh,kind:input.kind||d.selector.kind,faces:input.faces||d.selector.faces},s);
    else if([Tie.GENERATOR,Embedded.GENERATOR].includes(d.generator))built=(d.generator===Tie.GENERATOR?Tie:Embedded).build({...d,id:o.id,name:o.name,edges:input.edges||d.edges,faces:input.faces||d.faces},s,ids);
    else if(d.generator===Analysis.SET){const a=d.action;built=Analysis.set({...a,id:o.id,name:o.name,region:d.region,frame:d.frame,nodes:input.selectedNodes||a.nodes?.map(n),node:a.node?n(a.node):undefined},s,m);}
    else if([Mass.MASS,Mass.DISTRIBUTION].includes(d.generator)){const a=d.action;built=Mass.direct({...a,id:o.id,name:o.name,node:n(a.node),groups:a.groups?.map(g=>({...g,gids:g.gids.map(n)}))},s,m,ids);}
    else if(d.generator==='analysis-participation-v1')built=Mesh.participation({id:o.id,name:o.name,region:d.region,elements:input.selectedElements||d.analysisExcluded.map(x=>e(x.id))},s,m);
    else if(d.generator===Mesh.GENERATOR){
      if(d.modifiedOwners?.length)throw Error('Restore/remove this node-sharing action before replacing its connectivity inputs.');
      const steps=d.actions.map(raw=>{const a=copy(raw);delete a.createdNodes;delete a.createdElements;for(const k of ['nodes','connectivity','pairs'])if(a[k])a[k]=k==='nodes'?a[k].map(n):a[k].map(row=>row.map(n));if(a.elements)a.elements=a.elements.map(e);if(a.facets)a.facets=a.facets.map(f=>({...f,element:e(f.element)}));return a;});
      // Build detached from the old outputs, then retain slots only for a recipe
      // with the same output shape. New topology receives new identities.
      const clean=project(s,m,{removeObjects:[o.id]});const r=Mesh.build({id:o.id,name:o.name,steps,excludeElements:(d.analysisExcluded||[]).map(x=>e(x.id))},clean.state,clean.semantic,ids);
      const cards=r.object.definition.cards,old=d.cards,same=cards.length===old.length&&cards.every((c,i)=>c.family===old[i].family&&c.value.type===old[i].value.type);
      if(same){const nm=new Map(cards.filter(c=>c.family==='nodes').map(c=>[c.id,old[cards.indexOf(c)].id]));cards.forEach((c,i)=>{c.id=old[i].id;c.role=old[i].role;if(c.family==='elems'){c.value.eid=c.id;c.value.n=c.value.n.map(id=>nm.get(id)||id);}});}
      built=r.request;
    }else throw Error('This selection must be edited through its owner editor.');
    const changed=new Map((request.objects||[]).map(o=>[o.id,o]));for(const o of built.objects||[])changed.set(o.id,o);
    return {...copy(request),label:request.label||'Repair '+o.name,objects:[...changed.values()]};
  }
  return Object.freeze({project,inspect,repair});
}));
