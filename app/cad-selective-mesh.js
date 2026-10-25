/* Public actions for retaining unchanged CAD coverage and replacing shell patches. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.WebMeshCadSelective=factory();}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const copy=x=>JSON.parse(JSON.stringify(x)),PENDING='cad-patch-required-v1';
  function classified(d){
    const faces=(d.faces||[]).map(f=>({...copy(f),elements:[]})),members=new Map(faces.map(f=>[f.id,new Set(f.nodes)]));
    for(const c of d.cards||[])if(c.family==='elems'){
      const hits=faces.filter(f=>members.get(f.id).size&&c.value.n.every(n=>members.get(f.id).has(n)));
      if(hits.length!==1)return null;hits[0].elements.push(c.id);
    }return faces;
  }
  function retain(object,before,after,matches,geometryKey){
    const old=object.definition,map=new Map(matches.map(m=>[m.family+':'+m.id,m])),exact=(f,id)=>{const m=map.get(f+':'+id);return m?.status==='exact'?m.target:null;},target=(f,id)=>map.get(f+':'+id)?.target??null;
    if(object.facts?.suspendedReason||old.actionEdits?.length||old.embeddedBy||old.pendingReplacement)return null;
    const faceExact=id=>{const target=exact('faces',id),f=before.faces.find(f=>f.id===id),g=after.faces.find(f=>f.id===target);return target!==null&&f&&g&&f.edges.length===g.edges.length&&f.edges.every(e=>{const n=exact('edges',Math.abs(e));return n!==null&&g.edges.map(Math.abs).includes(n);});};
    const shell=old.generator==='cad-shell-v1',targets=old.targets.filter(id=>shell?faceExact(id):exact('volumes',id)!==null);
    // A volume's measure/bounds alone cannot prove that its boundary is unchanged.
    if(!shell&&(!targets.length||targets.length!==old.targets.length||old.targets.some(id=>before.volumes.find(v=>v.id===id)?.faces.some(f=>!faceExact(Math.abs(f))))))return null;
    const faces=shell?classified(old):old.faces;if(!faces)return null;
    const keepFace=new Set(shell?targets:faces.map(f=>f.id)),keptElements=new Set(shell?faces.filter(f=>keepFace.has(f.id)).flatMap(f=>f.elements):(old.cards||[]).filter(c=>c.family==='elems').map(c=>c.id));
    const edges=(old.edges||[]).filter(e=>exact('edges',e.id)!==null).map(e=>({...copy(e),id:exact('edges',e.id)}));
    const keptNodes=new Set([...old.cards.filter(c=>c.family==='elems'&&keptElements.has(c.id)).flatMap(c=>c.value.n),...edges.flatMap(e=>e.nodes)]);
    if(shell&&faces.some(f=>new Set(old.cards.filter(c=>c.family==='elems'&&f.elements.includes(c.id)).map(c=>c.value.zoffs||0)).size>1))return null;
    if(!keptElements.size||(old.nodeFrames||[]).some(b=>!keptNodes.has(b.node)))return null;
    const o=copy(object),d=o.definition;d.geometryKey=geometryKey;d.targets=targets.map(id=>exact(shell?'faces':'volumes',id));
    d.faces=faces.filter(f=>keepFace.has(f.id)&&exact('faces',f.id)!==null).map(f=>({...copy(f),id:exact('faces',f.id)}));d.edges=edges;
    d.sourceVolumes=(old.sourceVolumes||[]).map(id=>target('volumes',id)).filter(id=>id!==null);
    d.cards=old.cards.filter(c=>c.family==='nodes'?keptNodes.has(c.id):c.family!=='elems'||keptElements.has(c.id)).map(copy);
    d.sections=old.sections.map(s=>{const volumes=s.volumes.map(id=>target(shell?'faces':'volumes',id)).filter(id=>id!==null);return {...copy(s),volumes,key:geometryKey+(shell?'/shell/':'/solid/')+volumes.join('-')};});
    if(d.settings?.sizing)d.settings.sizing.edges=(d.settings.sizing.edges||[]).filter(e=>exact('edges',e.id)!==null).map(e=>({...e,id:exact('edges',e.id)}));
    if(d.settings?.shell?.selectedFaces)d.settings.shell.selectedFaces=d.targets.slice();if(d.settings?.mesh?.selectedVolumes&&!shell)d.settings.mesh.selectedVolumes=d.targets.slice();
    const changed=shell?old.targets.filter(id=>!keepFace.has(id)):[];
    if(changed.some(id=>target('faces',id)===null))return null;
    if(changed.length){
      const pending={faces:changed.map(id=>({before:id,target:target('faces',id),pid:old.sections.find(s=>s.volumes.includes(id))?.pid,zoffs:old.cards.find(c=>c.family==='elems'&&faces.find(f=>f.id===id).elements.includes(c.id))?.value.zoffs||0})),boundaryEdges:edges.filter(e=>changed.some(id=>before.faces.find(f=>f.id===id)?.edges.some(oid=>exact('edges',Math.abs(oid))===e.id)))};
      d.pendingReplacement=pending;d.replacementTargets=pending.faces.map(f=>f.target).filter(id=>id!==null);
    }
    return {object:o,pending:changed.length?{id:o.id+'/replacement-patch',name:o.name+' · Changed faces',kind:'mesh',dependsOn:[o.id,old.source],definition:{generator:PENDING,mesh:o.id,part:old.part,faces:copy(d.pendingReplacement.faces),cards:[]},facts:{suspendedReason:'Remesh the changed CAD faces. Unchanged faces and boundary identities are retained.'}}:null};
  }
  function patch(input,state,nextIds){
    const old=state.project.objects.find(o=>o.id===input.id),d=old?.definition,pending=d?.pendingReplacement;
    if(!pending||input.kind!=='shell')throw Error('Select a pending shell mesh patch.');
    const faces=[...new Set(input.faces)].sort((a,b)=>a-b),expected=pending.faces.map(f=>f.target);
    if(!input.mesh?.nodes?.length||!input.mesh.elements?.length)throw Error('Generate a nonempty patch mesh.');
    if(expected.some(f=>f===null)||faces.length!==expected.length||expected.some(f=>!faces.includes(f)))throw Error('Match each changed CAD face before remeshing its patch.');
    if(faces.some(f=>!input.mesh.elements.some(e=>e.face===f)))throw Error('Every changed face requires replacement elements.');
    if(input.mesh.elements.some(e=>!faces.includes(e.face)||!['CQUAD4','CTRIA3'].includes(e.type)))throw Error('Patch contains elements outside the reviewed shell faces.');
    const nodes=new Map(d.cards.filter(c=>c.family==='nodes').map(c=>[c.id,c.value])),local=new Map(input.mesh.nodes.map(n=>[n.id,n])),mapped=new Map();
    if(local.size!==input.mesh.nodes.length||input.mesh.nodes.some(n=>!Number.isSafeInteger(n.id)||n.id<1||!['x','y','z'].every(k=>Number.isFinite(n[k])))||input.mesh.elements.some(e=>e.nodes.some(n=>!local.has(n))))throw Error('Patch nodes must have unique positive IDs, finite coordinates and complete connectivity.');
    const close=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)<1e-6;
    for(const edge of pending.boundaryEdges){
      const ids=input.mesh.edgeNodes?.[edge.id];if(!ids||ids.length!==edge.nodes.length)throw Error('Edge '+edge.id+': retain its '+edge.nodes.length+' boundary nodes. Use matching edge divisions before reviewing the patch.');
      const used=new Set();for(const n of ids){const hits=edge.nodes.filter(id=>close(local.get(n),nodes.get(id)));if(hits.length!==1||used.has(hits[0]))throw Error('Edge '+edge.id+': boundary coordinates do not match uniquely.');used.add(hits[0]);if(mapped.has(n)&&mapped.get(n)!==hits[0])throw Error('Shared boundary node correspondence conflicts.');mapped.set(n,hits[0]);}
    }
    const fresh=ns=>Math.max(nextIds[ns]||1,...state.project.reservations.filter(r=>r.namespace===ns).map(r=>r.end+1)),generation=(d.layout.patchGeneration||0)+1,prefix='patch-'+generation,nr=prefix+'/nodes',er=prefix+'/elements',nodeStart=fresh('node'),elementStart=fresh('element');
    const added=[];let nid=nodeStart;for(const n of input.mesh.nodes)if(!mapped.has(n.id)){mapped.set(n.id,nid);added.push({family:'nodes',id:nid,role:nr+'/'+(nid-nodeStart),allocationRole:nr,value:{x:n.x,y:n.y,z:n.z,cp:0,cd:0,ps:''}});nid++;}
    const elementCards=input.mesh.elements.map((e,i)=>{const section=pending.faces.find(f=>f.target===e.face),pid=section.pid;if(!pid)throw Error('Patch section is missing.');return {family:'elems',bucket:e.type==='CQUAD4'?'quad':'tri',id:elementStart+i,role:er+'/'+i,allocationRole:er,value:{type:e.type,eid:elementStart+i,pid,n:e.nodes.map(n=>mapped.get(n)),...(section.zoffs?{zoffs:section.zoffs}:{})}};});
    const o=copy(old),out=o.definition;out.cards.push(...added,...elementCards);out.targets=[...d.targets,...faces].sort((a,b)=>a-b);out.layout.patchGeneration=generation;if(out.settings?.shell?.selectedFaces)out.settings.shell.selectedFaces=out.targets.slice();
    for(const face of faces){const t=input.topology.faces.find(f=>f.id===face),ids=input.mesh.faceNodes?.[face];if(!t||!ids?.length)throw Error('Patch CAD face classification is missing.');out.faces.push({id:face,type:t.type,center:t.center,normal:t.normal||null,nodes:ids.map(n=>mapped.get(n)).sort((a,b)=>a-b),elements:input.mesh.elements.flatMap((e,i)=>e.face===face?[elementStart+i]:[])});}
    const edges=new Map(out.edges.map(e=>[e.id,e]));for(const [id,ids]of Object.entries(input.mesh.edgeNodes||{})){const points=ids.map(n=>local.get(n));edges.set(Number(id),{id:Number(id),nodes:ids.map(n=>mapped.get(n)),center:['x','y','z'].map(k=>points.reduce((s,n)=>s+n[k],0)/points.length)});}out.edges=[...edges.values()];
    delete out.pendingReplacement;delete out.replacementTargets;
    const reservations=[...(nid>nodeStart?[{owner:o.id,namespace:'node',role:nr,start:nodeStart,count:nid-nodeStart}]:[]),{owner:o.id,namespace:'element',role:er,start:elementStart,count:elementCards.length}];
    const request={label:'Remesh changed faces · '+o.name,objects:[o],removeObjects:[o.id+'/replacement-patch'],reservations};
    return {owner:o.id,newMeshIdentity:false,mesh:{name:o.name,nodes:out.cards.filter(c=>c.family==='nodes').map(c=>({id:c.id,...c.value})),elements:out.cards.filter(c=>c.family==='elems').map(c=>({id:c.id,type:c.value.type,pid:c.value.pid,nodes:c.value.n,zoffs:c.value.zoffs}))},request};
  }
  return Object.freeze({PENDING,classified,retain,patch});
}));
