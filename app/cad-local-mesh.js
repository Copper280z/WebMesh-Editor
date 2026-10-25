/* Public local-mesh actions: solve sizing, explain its impact, splice a verified
 * solid patch. A draft never changes the committed mesh or its dependents. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./hex-mapping.js'));
  else root.WebMeshCadLocal=factory(root.WebMeshHexMapping);
}(typeof globalThis!=='undefined'?globalThis:this,function(H){
  'use strict';
  const copy=x=>JSON.parse(JSON.stringify(x)), sorted=xs=>[...new Set(xs)].sort((a,b)=>a-b);
  const faceIds=(analysis,id)=>Object.values(analysis.volumes.get(id)?.block?.sides||{}).flatMap(s=>s.faces);
  const edgesOf=(analysis,id)=>sorted(faceIds(analysis,id).flatMap(f=>analysis.faces.get(f).chains.flat().map(e=>e.edge)));
  function solve(analysis,settings){const s=settings.sizing||{};return H.solveIntervals(analysis,{size:s.size,minCount:s.minCount,controls:new Map((s.edges||[]).map(e=>[e.id,e])),solidSizes:new Map((s.solids||[]).map(v=>[v.id,v.size]))});}
  function impact(analysis,before,after,targets,solved){
    const previous=solve(analysis,before),next=solved||solve(analysis,after);
    const changedEdges=sorted([...next.counts].filter(([id,n])=>previous.counts.get(id)!==n).map(([id])=>id));
    const changed=new Set(changedEdges),oldControls=new Map((before.sizing?.edges||[]).map(e=>[e.id,e])),newControls=new Map((after.sizing?.edges||[]).map(e=>[e.id,e]));
    const editedEdges=new Set([...oldControls.keys(),...newControls.keys()].filter(id=>JSON.stringify(oldControls.get(id))!==JSON.stringify(newControls.get(id))));
    const a=new Map((before.sizing?.solids||[]).map(v=>[v.id,v.size])),b=new Map((after.sizing?.solids||[]).map(v=>[v.id,v.size]));
    const editedSolids=new Set([...a.keys(),...b.keys()].filter(id=>a.get(id)!==b.get(id)));
    const all=Number(before.mesh?.order||1)!==Number(after.mesh?.order||1)||!!before.mesh?.pidPerSolid!==!!after.mesh?.pidPerSolid;
    const global=before.sizing?.size!==after.sizing?.size||before.sizing?.minCount!==after.sizing?.minCount||all;
    const affected=[],direct=[],propagated=[],reasons={};
    for(const id of targets){const edges=edgesOf(analysis,id),changedHere=edges.filter(e=>changed.has(e));if(!all&&!changedHere.length)continue;
      affected.push(id);(global||editedSolids.has(id)||edges.some(e=>editedEdges.has(e))?direct:propagated).push(id);
      reasons[id]=all?'Element order or section grouping changed':'Changed edge counts: '+changedHere.map(e=>'E'+e+' '+previous.counts.get(e)+'→'+next.counts.get(e)).join(', ');
    }
    return {affected,direct,propagated,changedEdges,reasons,conflicts:next.conflicts,unchanged:targets.filter(id=>!affected.includes(id)),all};
  }
  function provenance(d,baseline){
    if(d.volumeElements){
      const flat=d.volumeElements.flatMap(v=>v.elements),known=new Set(flat),actual=d.cards.filter(c=>c.family==='elems').map(c=>c.id);
      if(d.volumeElements.length!==d.targets.length||new Set(d.volumeElements.map(v=>v.id)).size!==d.targets.length||d.volumeElements.some(v=>!v.elements.length)||known.size!==actual.length||flat.length!==actual.length||actual.some(id=>!known.has(id))||d.volumeElements.some(v=>!d.targets.includes(v.id)))throw Error('Invalid solid element provenance. Regenerate the complete region.');
      return copy(d.volumeElements);
    }
    // Older projects did not save solid membership. Recover it only by exact
    // reproduction of ALL committed connectivity and coordinates, never by a
    // bounding-box/proximity assignment of an element to a solid.
    const nodes=new Map(d.cards.filter(c=>c.family==='nodes').map(c=>[c.id,c.value])),elems=new Map(d.cards.filter(c=>c.family==='elems').map(c=>[c.id,c.value]));
    if(!baseline||baseline.nodes.length!==nodes.size||baseline.elements.length!==elems.size)throw Error('This older mesh needs a verified baseline before local remeshing. Reopen its committed CAD mesh.');
    const map=new Map(baseline.nodes.map((n,i)=>[n.id,d.layout.node+i]));
    const close=(a,b)=>a&&b&&Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<1e-9;
    if(baseline.nodes.some(n=>!close(n,nodes.get(map.get(n.id))))||baseline.elements.some((e,i)=>JSON.stringify(e.nodes.map(n=>map.get(n)))!==JSON.stringify(elems.get(d.layout.element+i)?.n)))throw Error('The committed mesh cannot be reproduced exactly. Regenerate the complete region before using local remeshing.');
    return d.targets.map(id=>({id,elements:baseline.elements.flatMap((e,i)=>e.volume===id?[d.layout.element+i]:[])}));
  }
  const quadIndices=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
  function faceSignatures(elements,nodes){
    const member=new Set(nodes),result=[];
    for(const e of elements)for(const q of quadIndices){let ids=q.map(i=>e.nodes[i]);if(!ids.every(n=>member.has(n)))continue;
      if(e.nodes.length===20)ids.push(...H.constants.HEX20_EDGES.flatMap(([a,b],i)=>q.includes(a)&&q.includes(b)?[e.nodes[8+i]]:[]));
      if(!ids.every(n=>member.has(n)))throw Error('Incomplete quadratic boundary membership.');
      result.push(ids.sort((a,b)=>a-b).join(':'));
    }
    return result.sort();
  }
  function patch(input,state,nextIds){
    const old=state.project.objects.find(o=>o.id===input.id),d=old.definition,targets=sorted(input.volumes),mesh=input.mesh;
    if(d.actionEdits?.length||d.embeddedBy)throw Error('This region has authored connectivity changes. Remesh the complete region and review those dependents.');
    if(d.generator!=='cad-mapped-v1'||d.pendingReplacement||targets.some(v=>!d.targets.includes(v)))throw Error('Local remeshing requires solids in the current mapped mesh region.');
    if(Number(d.settings.mesh?.order||1)!==Number(input.settings.mesh?.order||1)||!!d.settings.mesh?.pidPerSolid!==!!input.perSolid)throw Error('Changing element order or section grouping requires remeshing the complete region.');
    const analysis=H.analyze(input.topology),change=impact(analysis,d.settings,input.settings,d.targets);
    if(change.conflicts.length)throw Error('Resolve sizing conflicts before remeshing.');
    if(change.affected.some(id=>!targets.includes(id)))throw Error('Include every dependent solid in the local remesh: '+change.affected.filter(id=>!targets.includes(id)).join(', ')+'.');
    const membership=provenance(d,input.baselineMesh),remove=new Set(membership.filter(v=>targets.includes(v.id)).flatMap(v=>v.elements));
    if((d.analysisExcluded||[]).some(id=>remove.has(id)))throw Error('The patch contains analysis-excluded elements. Review their exclusion before remeshing.');
    const retained=d.cards.filter(c=>c.family==='elems'&&!remove.has(c.id)),used=new Set(retained.flatMap(c=>c.value.n));
    const nodes=new Map(d.cards.filter(c=>c.family==='nodes').map(c=>[c.id,c])),local=new Map(mesh.nodes.map(n=>[n.id,n])),mapped=new Map();
    if(!targets.length||local.size!==mesh.nodes.length||mesh.nodes.some(n=>!Number.isSafeInteger(n.id)||n.id<1||!['x','y','z'].every(k=>Number.isFinite(n[k])))||mesh.elements.some(e=>!targets.includes(e.volume)||e.type!=='CHEXA'||e.nodes.length!==(Number(input.settings.mesh.order)===2?20:8)||e.nodes.some(n=>!local.has(n)))||targets.some(v=>!mesh.elements.some(e=>e.volume===v)))throw Error('Generate a complete, valid solid patch with CAD membership.');
    const byFace=new Map(d.faces.map(f=>[f.id,f])),requiredFaces=sorted(targets.flatMap(id=>faceIds(analysis,id)));
    const close=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<1e-8;
    for(const id of requiredFaces){
      const fresh=mesh.faceNodes?.[id],previous=byFace.get(id)?.nodes||[];
      if(!fresh?.length||fresh.some(n=>!local.has(n)))throw Error('Missing CAD face provenance for face '+id+'.');
      const boundary=previous.filter(n=>used.has(n)),claimed=new Set();
      for(const n of boundary){const hits=fresh.filter(i=>close(local.get(i),nodes.get(n).value));if(hits.length!==1||claimed.has(hits[0]))throw Error('Face '+id+': retained boundary nodes do not match. Include its dependent solids.');
        const i=hits[0];claimed.add(i);if(mapped.has(i)&&mapped.get(i)!==n)throw Error('Ambiguous shared boundary node.');mapped.set(i,n);
      }
    }
    const fresh=ns=>Math.max(nextIds[ns]||1,...state.project.reservations.filter(r=>r.namespace===ns).map(r=>r.end+1));
    const generation=(d.layout.patchGeneration||0)+1,nr='solid-patch-'+generation+'/nodes',er='solid-patch-'+generation+'/elements',start=fresh('node'),eid=fresh('element'),added=[];
    for(const n of mesh.nodes)if(!mapped.has(n.id)){const id=start+added.length;mapped.set(n.id,id);added.push({family:'nodes',id,role:nr+'/'+added.length,allocationRole:nr,value:{x:n.x,y:n.y,z:n.z,cp:0,cd:0,ps:''}});}
    const elements=mesh.elements.map((e,i)=>({family:'elems',bucket:'hex',id:eid+i,role:er+'/'+i,allocationRole:er,value:{type:'CHEXA',eid:eid+i,pid:d.sections.find(s=>s.volumes.includes(e.volume)).pid,n:e.nodes.map(n=>mapped.get(n))}}));
    const asMesh=cards=>cards.map(c=>({id:c.id,type:c.value.type,pid:c.value.pid,nodes:c.value.n}));
    // Equal node counts or a single connected component do not prove a closed
    // seam. Compare real quadrilateral faces, including every HEX20 midside.
    for(const id of requiredFaces){const prior=byFace.get(id),retainedFaces=faceSignatures(asMesh(retained),prior?.nodes||[]);if(!retainedFaces.length)continue;
      const replacement=faceSignatures(asMesh(elements),mesh.faceNodes[id].map(n=>mapped.get(n)));
      if(JSON.stringify(retainedFaces)!==JSON.stringify(replacement))throw Error('Face '+id+': replacement elements do not share the retained quadrilateral interface.');
    }
    const out=copy(old);out.definition.cards=[...d.cards.filter(c=>c.family==='nodes'&&used.has(c.id)),...added,...retained,...elements];
    out.definition.volumeElements=membership.filter(v=>!targets.includes(v.id)).concat(targets.map(id=>({id,elements:mesh.elements.flatMap((e,i)=>e.volume===id?[eid+i]:[])}))).sort((a,b)=>a.id-b.id);
    out.definition.faces=d.faces.map(f=>mesh.faceNodes?.[f.id]?{...copy(f),nodes:sorted(mesh.faceNodes[f.id].map(n=>mapped.get(n)))}:copy(f));
    out.definition.edges=(d.edges||[]).map(e=>mesh.edgeNodes?.[e.id]?{...copy(e),nodes:sorted(mesh.edgeNodes[e.id].map(n=>mapped.get(n)))}:copy(e));
    const allNodes=new Set(out.definition.cards.filter(c=>c.family==='nodes').map(c=>c.id));
    if([...out.definition.faces,...out.definition.edges].some(f=>f.nodes.some(n=>!allNodes.has(n))))throw Error('The patch is missing updated CAD boundary membership.');
    out.definition.settings=copy(input.settings);out.definition.layout.patchGeneration=generation;
    // The old full-mesh layout hash must never claim equality after a patch.
    out.definition.layout.key='local-patch:'+generation+':'+d.layout.key;
    const reservations=[...(added.length?[{owner:old.id,namespace:'node',role:nr,start,count:added.length}]:[]),{owner:old.id,namespace:'element',role:er,start:eid,count:elements.length}];
    return {owner:old.id,newMeshIdentity:false,localRemesh:{solids:targets,retainedElements:retained.length,retainedNodes:used.size},mesh:{name:old.name,nodes:out.definition.cards.filter(c=>c.family==='nodes').map(c=>({id:c.id,...c.value})),elements:asMesh(out.definition.cards.filter(c=>c.family==='elems'))},request:{label:'Remesh '+targets.length+' solid'+(targets.length===1?'':'s')+' · '+old.name,objects:[out],reservations}};
  }
  return Object.freeze({solve,impact,edgesOf,provenance,faceSignatures,patch});
}));
