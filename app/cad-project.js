(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./engine-ownership.js'),require('./modeling.js'),require('./cad-selective-mesh.js'),require('./cad-local-mesh.js'));
  else root.WebMeshCadProject=factory(root.WebMeshOwnership,root.WebMeshModeling,root.WebMeshCadSelective,root.WebMeshCadLocal);
}(typeof globalThis!=='undefined'?globalThis:this,function(O,Modeling,Selective,Local){
  'use strict';
  const GENERATOR='cad-mapped-v1', SHELL='cad-shell-v1',copy=v=>JSON.parse(JSON.stringify(v));
  async function digest(value){const data=new TextEncoder().encode(O.canonical(value));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),v=>v.toString(16).padStart(2,'0')).join('');}
  const geometryFingerprint = topo => digest({bounds:topo.bounds,vertices:topo.vertices,edges:topo.edges,faces:topo.faces,volumes:topo.volumes,sheets:topo.sheets||[]});
  function rootFor(state,owner){return state?.project.objects.find(o=>[GENERATOR,SHELL].includes(o.definition.generator)&&[o.id,o.definition.source,o.definition.material,...o.definition.sections.map(s=>s.id)].includes(owner))||null;}
  function bundle(state,owner){const root=rootFor(state,owner);if(!root)throw Error('This owner is not a mapped CAD mesh.');const ids=[root.id,root.definition.material,...root.definition.sections.map(s=>s.id)];if(!state.project.objects.some(o=>o.id!==root.id&&o.dependsOn.includes(root.definition.source)))ids.push(root.definition.source);return ids;}
  function removal(state,owner,convert=false){
    const ids=bundle(state,owner),root=rootFor(state,owner);
    const dependents=state.project.objects.filter(o=>!ids.includes(o.id)&&o.dependsOn.some(id=>ids.includes(id)));
    if(dependents.length)throw Error('Resolve dependent objects first: '+dependents.map(o=>o.name).join(', ')+'.');
    return {label:(convert?'Convert ':'Remove ')+root.name+(convert?' to plain cards':''),[convert?'convertToPlain':'removeObjects']:ids};
  }
  function materialChange(state,owner,values){
    const root=rootFor(state,owner),ids=bundle(state,owner),objects=state.project.objects.filter(o=>ids.includes(o.id)).map(copy);
    const m=objects.find(o=>o.id===root.definition.material),card=m.definition.cards[0];
    card.value={type:'MAT1',mid:card.id,E:values.E,nu:values.nu,rho:values.rho,G:values.E/(2*(1+values.nu))};
    return {label:'Update '+root.name+' material',objects};
  }
  async function build(input,state,nextIds){
    const old=rootFor(state,input.id),find=id=>state?.project.objects.find(o=>o.id===id);
    if(!input.id||!input.name||!input.snapshot?.prepared?.content||!input.snapshot.content)throw Error('CAD mesh ownership requires the original and prepared source snapshots.');
    if(find(input.id)&&!old)throw Error('The requested CAD mesh identity belongs to another object.');
    if(old?.definition.pendingReplacement){if(await geometryFingerprint(input.topology)!==find(old.definition.source).definition.geometryKey)throw Error('The patch must use the current committed CAD source.');const result=Selective.patch(input,state,nextIds),validation=Modeling.validateMesh(result.mesh);if(!validation.valid)throw Error(validation.errors.join('\n'));return result;}
    if(input.localRemesh){
      if(!old||await geometryFingerprint(input.topology)!==old.definition.geometryKey)throw Error('Local remeshing requires unchanged CAD geometry.');
      const result=Local.patch(input,state,nextIds),validation=Modeling.validateMesh(result.mesh);if(!validation.valid)throw Error(validation.errors.join('\n'));return result;
    }
    const shell=input.kind==='shell',mesh=input.mesh;
    if(!mesh?.nodes?.length||!mesh.elements?.length)throw Error('Generate a nonempty CAD mesh.');
    const target=[...new Set(shell?input.faces:input.volumes)].sort((a,b)=>a-b);
    if(!target.length||target.some(id=>!Number.isSafeInteger(id)||id<1))throw Error('Select explicit CAD mesh regions.');
    const topo=input.topology;
    if(target.some(id=>!(shell?topo.faces:topo.volumes).some(v=>v.id===id)))throw Error('A target entity does not exist in this CAD snapshot.');
    const geometryKey=await geometryFingerprint(topo);
    const partId=old?.definition.part||input.part||null,part=partId?find(partId):null;
    if(partId&&part?.definition.generator!=='part-v1')throw Error('Select the owning part.');
    const sourceId=old?.definition.source||part?.definition.source||input.sourceId||input.id+'/source',materialId=input.id+'/material';
    const shared=find(sourceId),siblings=(state?.project.objects||[]).filter(o=>o.id!==input.id&&[GENERATOR,SHELL].includes(o.definition.generator)&&o.definition.source===sourceId);
    if(shared&&shared.definition.generator!=='cad-source-v1')throw Error('Invalid shared CAD source.');
    if(shared&&shared.definition.geometryKey!==geometryKey&&siblings.some(o=>!o.facts?.suspendedReason))throw Error('Shared CAD topology changed. Restore the committed source or remove its mesh regions and interfaces before changing topology.');
    const sourceVolumes=shell?topo.volumes.filter(v=>v.faces.some(f=>target.includes(Math.abs(f)))).map(v=>v.id):target;
    for(const other of siblings){
      if(other.facts?.suspendedReason)continue;
      const d=other.definition,otherShell=d.generator===SHELL;
      if(shell===otherShell&&target.some(id=>d.targets.includes(id)))throw Error('Mesh coverage overlaps '+other.name+'. Edit that mesh region instead.');
      if(shell!==otherShell&&(shell?sourceVolumes.some(v=>d.targets.includes(v)):(d.sourceVolumes||[]).some(v=>target.includes(v))))throw Error('Shell and solid idealizations overlap in '+other.name+'. Partition the CAD first and assign disjoint solid regions.');
    }
    const layoutKey=await digest({geometryKey,target,nodes:mesh.nodes,elements:mesh.elements,perSolid:!!input.perSolid,kind:shell?'shell':'solid'});
    const same=old?.definition.layout.key===layoutKey;
    const fresh=ns=>Math.max(nextIds[ns]||1,...(state?.project.reservations||[]).filter(r=>r.namespace===ns).map(r=>r.end+1));
    const layout=same?copy(old.definition.layout):{key:layoutKey,generation:(old?.definition.layout.generation||0)+1,node:fresh('node'),element:fresh('element')};
    const material=old?copy(find(materialId)): {id:materialId,kind:'material',name:input.name+' · Material',definition:{cards:[{family:'materials',id:fresh('material'),role:'elastic',value:{type:'MAT1',mid:fresh('material'),E:210000,nu:.3,G:210000/2.6,rho:7.85e-9}}]}};
    const mid=material.definition.cards[0].id;
    let pid=fresh('property');
    const regionGroups=shell?[...new Set(mesh.elements.map(e=>e.pid))].sort((a,b)=>a-b).map(pid=>[...new Set(mesh.elements.filter(e=>e.pid===pid).map(e=>e.face))].sort((a,b)=>a-b)):input.perSolid?target.map(v=>[v]):[target];
    const sections=regionGroups.map(volumes=>{
      const key=geometryKey+(shell?'/shell/':'/solid/')+volumes.join('-'),previous=old?.definition.sections.find(s=>s.key===key);
      return previous?copy(previous):{id:input.id+'/section/'+layout.generation+'/'+key,key,volumes,pid:pid++};
    });
    const nodeMap=new Map(),nodes=mesh.nodes.map((n,i)=>{if(nodeMap.has(n.id))throw Error('Repeated CAD mesh node ID.');nodeMap.set(n.id,layout.node+i);return {...n,id:layout.node+i};});
    const faces=Object.entries(mesh.faceNodes||{}).map(([id,localNodes])=>{
      const face=topo.faces.find(f=>f.id===Number(id));
      if(!face||!localNodes.length||localNodes.some(n=>!nodeMap.has(n)))throw Error('Invalid mapped CAD face membership.');
      return {elements:mesh.elements.flatMap((e,i)=>e.face===face.id?[layout.element+i]:[]),id:face.id,type:face.type,center:face.center,normal:face.normal||face.surface?.normal||null,nodes:[...new Set(localNodes.map(n=>nodeMap.get(n)))].sort((a,b)=>a-b)};
    });
    const elements=mesh.elements.map((e,i)=>{
      const type=({CHEXA8:'CHEXA',CHEXA20:'CHEXA'})[e.type]||e.type;
      if(shell?(!['CTRIA3','CQUAD4'].includes(type)||!target.includes(e.face)):(type!=='CHEXA'||![8,20].includes(e.nodes.length)||!target.includes(e.volume)))throw Error('Elements require supported connectivity and explicit CAD membership.');
      return {id:layout.element+i,type,pid:sections.find(s=>s.volumes.includes(shell?e.face:e.volume)).pid,nodes:e.nodes.map(id=>nodeMap.get(id)),...(e.zoffs!=null?{zoffs:e.zoffs}:{})};
    });
    const generated={name:input.name,nodes,elements},validation=Modeling.validateMesh(generated);
    if(!validation.valid)throw Error(validation.errors.join('\n'));
    const role='mesh-'+layout.generation,nr=role+'/nodes',er=role+'/elements';
    const cards=nodes.map((n,i)=>({family:'nodes',id:n.id,role:nr+'/'+i,allocationRole:nr,value:{x:n.x,y:n.y,z:n.z,cp:0,cd:0,ps:''}}));
    elements.forEach((e,i)=>cards.push({family:'elems',bucket:shell?(e.type==='CQUAD4'?'quad':'tri'):'hex',id:e.id,role:er+'/'+i,allocationRole:er,value:{type:e.type,eid:e.id,pid:e.pid,n:e.nodes,...(e.zoffs!=null?{zoffs:e.zoffs}:{})}}));
    const source=shared&&shared.definition.geometryKey===geometryKey?copy(shared):{id:sourceId,kind:'source',name:input.name+' · CAD source',definition:{...(shared?copy(shared.definition):{}),generator:'cad-source-v1',geometryKey,topology:copy(topo),snapshot:copy(input.snapshot)}};
    source.definition.topology=copy(topo);
    // Preserve exact membership; interface selectors never infer CAD IDs from proximity.
    const localPoints=new Map(mesh.nodes.map(n=>[n.id,n]));
    const edges=Object.entries(mesh.edgeNodes||{}).map(([id,ids])=>({id:Number(id),nodes:ids.map(n=>nodeMap.get(n)).filter(Boolean),center:['x','y','z'].map(axis=>ids.reduce((sum,n)=>sum+localPoints.get(n)[axis],0)/ids.length)}));
    if(shell&&target.some(id=>!faces.some(f=>f.id===id)))throw Error('Shell face provenance is missing. Regenerate with the current CAD server.');
    const sectionObjects=sections.map(s=>{
      const original=mesh.elements.find(e=>s.volumes.includes(shell?e.face:e.volume));
      const t=Number(input.thicknessByProperty?.[original.pid]??input.thickness);
      if(shell&&!(t>0&&Number.isFinite(t)))throw Error('Shell sections require positive thickness.');
      return {id:s.id,kind:'section',name:input.name+' · '+(shell?'Shell faces ':'Solids ')+s.volumes.join(', '),dependsOn:[materialId],definition:{region:{geometryKey,[shell?'faces':'volumes']:s.volumes},cards:[{family:'properties',id:s.pid,role:shell?'shell':'solid',value:shell?{type:'PSHELL',pid:s.pid,mid1:mid,mid2:mid,mid3:mid,t}:{type:'PSOLID',pid:s.pid,mid}}]}};
    });
    const objects=[source,material,...sectionObjects,
      {id:input.id,kind:'mesh',name:input.name,dependsOn:[sourceId,...(partId?[partId]:[]),...sections.map(s=>s.id)],definition:{...(partId?{part:partId}:{}),generator:shell?SHELL:GENERATOR,geometryKey,source:sourceId,material:materialId,sections,layout,settings:copy(input.settings),targets:target,sourceVolumes,faces,edges,...(!shell?{volumeElements:target.map(id=>({id,elements:mesh.elements.flatMap((e,i)=>e.volume===id?[layout.element+i]:[])}))}:{}),cards}}];
    const removeObjects=(old?.definition.sections||[]).filter(s=>!sections.some(n=>n.id===s.id)&&!(state?.project.objects||[]).some(o=>o.id!==old.id&&o.facts?.suspendedReason&&o.dependsOn?.includes(s.id))).map(s=>s.id);
    return {mesh:generated,owner:input.id,newMeshIdentity:!!old&&!same,regions:sections,request:{label:(old?'Replace ':'Create ')+input.name,objects,removeObjects,reservations:[{owner:input.id,namespace:'node',role:nr,start:layout.node,count:nodes.length},{owner:input.id,namespace:'element',role:er,start:layout.element,count:elements.length}]}};
  }
  function restoreData(state,owner){
    const root=rootFor(state,owner);if(!root)throw Error('Unknown CAD owner.');
    const source=state.project.objects.find(o=>o.id===root.definition.source);
    const meshes=state.project.objects.filter(o=>[GENERATOR,SHELL].includes(o.definition.generator)&&o.definition.source===source.id).map((o,i)=>({id:i+1,kind:o.definition.generator===SHELL?'shell':'hex',label:o.name,projectOwner:o.id,volumes:o.definition.generator===SHELL?[]:o.definition.targets,faces:o.definition.generator===SHELL?o.definition.targets:[],elements:state.owners.filter(e=>e.owner===o.id&&e.card.family==='elems').map(e=>e.card.id),properties:o.definition.sections.map(s=>s.pid),stale:false}));
    let settings=copy(root.definition.settings);
    if((root.facts?.suspendedReason||root.definition.pendingReplacement)&&source.definition.replacement){
      const targets=root.definition.replacementTargets||[],shell=root.definition.generator===SHELL;
      settings={version:2,step:'mesh',sizing:{size:settings.sizing?.size,minCount:settings.sizing?.minCount||1,edges:[]},mesh:{...settings.mesh,method:shell?'shell':'mapped',scope:'selected',selectedVolumes:shell?[]:targets},shell:{...settings.shell,element:settings.shell?.element||'quad',mesher:settings.shell?.mesher||'recombined',thickness:settings.shell?.thickness||1,placement:settings.shell?.placement||'surface',offset:settings.shell?.offset||0,size:settings.shell?.size||null,scope:'selected',selectedFaces:shell?targets:[]}};
      if(root.definition.pendingReplacement){settings.sizing.edges=Selective.pendingBoundaries(root.definition,source.definition.topology).map(e=>({id:e.id,count:e.nodes.length-(source.definition.topology.edges.find(t=>t.id===e.id)?.type==='Circle'?0:1)}));const pid=root.definition.pendingReplacement.faces[0]?.pid;settings.shell.thickness=state.project.objects.flatMap(o=>o.definition.cards||[]).find(c=>c.family==='properties'&&c.id===pid)?.value.t||settings.shell.thickness;}
      for(const m of meshes){const o=state.project.objects.find(o=>o.id===m.projectOwner);if(o.facts?.suspendedReason){m.volumes=o.definition.generator===GENERATOR?o.definition.replacementTargets||[]:[];m.faces=o.definition.generator===SHELL?o.definition.replacementTargets||[]:[];m.stale=true;}}
    }
    return {...copy(source.definition.snapshot),settings,editingOwner:root.id,regionName:root.name,meshes};
  }
  return Object.freeze({GENERATOR,SHELL,geometryFingerprint,build,rootFor,bundle,removal,materialChange,restoreData});
}));
