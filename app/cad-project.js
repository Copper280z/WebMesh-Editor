(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./engine-ownership.js'),require('./modeling.js'));
  else root.WebMeshCadProject=factory(root.WebMeshOwnership,root.WebMeshModeling);
}(typeof globalThis!=='undefined'?globalThis:this,function(O,Modeling){
  'use strict';
  const GENERATOR='cad-mapped-v1',copy=v=>JSON.parse(JSON.stringify(v));
  async function digest(value){const data=new TextEncoder().encode(O.canonical(value));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),v=>v.toString(16).padStart(2,'0')).join('');}
  function rootFor(state,owner){return state?.project.objects.find(o=>o.definition.generator===GENERATOR&&[o.id,o.definition.source,o.definition.material,...o.definition.sections.map(s=>s.id)].includes(owner))||null;}
  function bundle(state,owner){const root=rootFor(state,owner);if(!root)throw Error('This owner is not a mapped CAD mesh.');return [root.id,root.definition.source,root.definition.material,...root.definition.sections.map(s=>s.id)];}
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
    if(!input.id||!input.name||!input.snapshot?.prepared?.content||!input.snapshot.content)throw Error('Mapped CAD ownership requires the original and prepared source snapshots.');
    if(find(input.id)&&!old)throw Error('The requested CAD mesh identity belongs to another object.');
    const mesh=input.mesh;
    if(!mesh?.nodes?.length||!mesh.elements?.length)throw Error('Generate a nonempty mapped hex mesh.');
    const target=[...new Set(input.volumes)].sort((a,b)=>a-b);
    if(!target.length||target.some(id=>!Number.isSafeInteger(id)||id<1))throw Error('Select explicit CAD solid regions.');
    const topo=input.topology;
    if(target.some(id=>!topo.volumes.some(v=>v.id===id)))throw Error('A target solid does not exist in this CAD snapshot.');
    const geometryKey=await digest({bounds:topo.bounds,vertices:topo.vertices,edges:topo.edges,faces:topo.faces,volumes:topo.volumes,sheets:topo.sheets||[]});
    const layoutKey=await digest({geometryKey,target,nodes:mesh.nodes,elements:mesh.elements,perSolid:!!input.perSolid});
    const same=old?.definition.layout.key===layoutKey;
    const fresh=ns=>Math.max(nextIds[ns]||1,...(state?.project.reservations||[]).filter(r=>r.namespace===ns).map(r=>r.end+1));
    const layout=same?copy(old.definition.layout):{key:layoutKey,generation:(old?.definition.layout.generation||0)+1,node:fresh('node'),element:fresh('element')};
    const sourceId=input.id+'/source',materialId=input.id+'/material';
    const material=old?copy(find(materialId)): {id:materialId,kind:'material',name:input.name+' · Material',definition:{cards:[{family:'materials',id:fresh('material'),role:'elastic',value:{type:'MAT1',mid:fresh('material'),E:210000,nu:.3,G:210000/2.6,rho:7.85e-9}}]}};
    const mid=material.definition.cards[0].id;
    let pid=fresh('property');
    const regionGroups=input.perSolid?target.map(v=>[v]):[target];
    const sections=regionGroups.map(volumes=>{
      const key=geometryKey+'/solid/'+volumes.join('-'),previous=old?.definition.sections.find(s=>s.key===key);
      return previous?copy(previous):{id:input.id+'/section/'+layout.generation+'/'+key,key,volumes,pid:pid++};
    });
    const nodeMap=new Map(),nodes=mesh.nodes.map((n,i)=>{if(nodeMap.has(n.id))throw Error('Repeated CAD mesh node ID.');nodeMap.set(n.id,layout.node+i);return {...n,id:layout.node+i};});
    const elements=mesh.elements.map((e,i)=>{
      const type=({CHEXA8:'CHEXA',CHEXA20:'CHEXA'})[e.type]||e.type;
      if(type!=='CHEXA'||![8,20].includes(e.nodes.length)||!target.includes(e.volume))throw Error('Mapped CAD elements require HEX8/HEX20 connectivity and an explicit source solid.');
      return {id:layout.element+i,type,pid:sections.find(s=>s.volumes.includes(e.volume)).pid,nodes:e.nodes.map(id=>nodeMap.get(id))};
    });
    const generated={name:input.name,nodes,elements},validation=Modeling.validateMesh(generated);
    if(!validation.valid)throw Error(validation.errors.join('\n'));
    const role='mesh-'+layout.generation,nr=role+'/nodes',er=role+'/elements';
    const cards=nodes.map((n,i)=>({family:'nodes',id:n.id,role:nr+'/'+i,allocationRole:nr,value:{x:n.x,y:n.y,z:n.z,cp:0,cd:0,ps:''}}));
    elements.forEach((e,i)=>cards.push({family:'elems',bucket:'hex',id:e.id,role:er+'/'+i,allocationRole:er,value:{type:e.type,eid:e.id,pid:e.pid,n:e.nodes}}));
    const source=old&&find(sourceId).definition.geometryKey===geometryKey?copy(find(sourceId)):{id:sourceId,kind:'source',name:input.name+' · CAD source',definition:{generator:'cad-source-v1',geometryKey,snapshot:copy(input.snapshot)}};
    const objects=[source,material,...sections.map(s=>({id:s.id,kind:'section',name:input.name+' · Solid'+(s.volumes.length===1?' '+s.volumes[0]:'s '+s.volumes.join(', ')),dependsOn:[materialId],definition:{region:{geometryKey,volumes:s.volumes},cards:[{family:'properties',id:s.pid,role:'solid',value:{type:'PSOLID',pid:s.pid,mid}}]}})),
      {id:input.id,kind:'mesh',name:input.name,dependsOn:[sourceId,...sections.map(s=>s.id)],definition:{generator:GENERATOR,source:sourceId,material:materialId,sections,layout,settings:copy(input.settings),targets:target,cards}}];
    const removeObjects=(old?.definition.sections||[]).filter(s=>!sections.some(n=>n.id===s.id)).map(s=>s.id);
    return {mesh:generated,owner:input.id,newMeshIdentity:!!old&&!same,regions:sections,request:{label:(old?'Replace ':'Create ')+input.name,objects,removeObjects,reservations:[{owner:input.id,namespace:'node',role:nr,start:layout.node,count:nodes.length},{owner:input.id,namespace:'element',role:er,start:layout.element,count:elements.length}]}};
  }
  function restoreData(state,owner){
    const root=rootFor(state,owner);if(!root)throw Error('Unknown CAD owner.');
    const source=state.project.objects.find(o=>o.id===root.definition.source),entries=state.owners.filter(o=>o.owner===root.id&&o.card.family==='elems');
    return {...copy(source.definition.snapshot),settings:copy(root.definition.settings),meshes:[{id:1,kind:'hex',label:root.name,projectOwner:root.id,volumes:root.definition.targets,faces:[],elements:entries.map(e=>e.card.id),properties:root.definition.sections.map(s=>s.pid),material:state.project.objects.find(o=>o.id===root.definition.material).definition.cards[0].id,stale:false}]};
  }
  return Object.freeze({GENERATOR,build,rootFor,bundle,removal,materialChange,restoreData});
}));
