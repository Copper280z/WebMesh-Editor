/* Independent sources and reviewed live mesh placements. No browser or engine state. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./mesh-region-project.js'),require('./attachment-project.js'));
  else root.WebMeshParts=factory(root.WebMeshRegions,root.WebMeshAttachmentProject);
}(typeof globalThis!=='undefined'?globalThis:this,function(Regions,Mount){
  'use strict';
  const PART='part-v1',INSTANCE='part-instance-v1',MESH='instance-mesh-v1',COPY='independent-mesh-v1';
  const clone=v=>JSON.parse(JSON.stringify(v)),canonical=v=>Array.isArray(v)?'['+v.map(canonical)+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k]))+'}':JSON.stringify(v);
  const catalog=state=>new Map((state?.project.objects||[]).map(o=>[o.id,o]));
  const isPart=o=>o?.definition.generator===PART,isInstance=o=>o?.definition.generator===INSTANCE;
  const named=s=>{if(typeof s!=='string'||!s.trim())throw Error('Enter a name.');return s.trim();};
  const identity=()=>({translation:[0,0,0],rotation:[0,0,0],reflection:'none'});
  function transform(raw){
    const t={...identity(),...clone(raw||{})};
    for(const k of ['translation','rotation'])if(!Array.isArray(t[k])||t[k].length!==3||!t[k].every(Number.isFinite))throw Error('Enter three finite '+k+' values.');
    if(!['none','x','y','z'].includes(t.reflection))throw Error('Choose a reflection plane normal or None.');
    const angles=t.rotation.map(x=>x*Math.PI/180),mirrored=t.reflection!=='none';
    function point(p){let q=p.slice();if(mirrored)q['xyz'.indexOf(t.reflection)]*=-1;for(let axis=0;axis<3;axis++){const a=(axis+1)%3,b=(axis+2)%3,c=Math.cos(angles[axis]),s=Math.sin(angles[axis]),v=q[a];q[a]=c*v-s*q[b];q[b]=s*v+c*q[b];}return q.map((v,i)=>v+t.translation[i]);}
    return{value:t,point,mirrored};
  }
  const corners={CTRIA3:[0,2,1],CTRIA6:[0,2,1],CQUAD4:[0,3,2,1],CQUAD8:[0,3,2,1],CTETRA:[0,2,1,3],CHEXA:[0,3,2,1,4,7,6,5],CPENTA:[0,2,1,3,5,4],CPYRAM:[0,3,2,1,4]};
  const edges={CTRIA6:[[0,1],[1,2],[2,0]],CQUAD8:[[0,1],[1,2],[2,3],[3,0]],CTETRA:[[0,1],[1,2],[2,0],[0,3],[1,3],[2,3]],CHEXA:[[0,1],[1,2],[2,3],[3,0],[0,4],[1,5],[2,6],[3,7],[4,5],[5,6],[6,7],[7,4]],CPENTA:[[0,1],[1,2],[2,0],[0,3],[1,4],[2,5],[3,4],[4,5],[5,3]],CPYRAM:[[0,1],[1,2],[2,3],[3,0],[0,4],[1,4],[2,4],[3,4]]};
  function reflected(type,ns){const p=corners[type];if(!p)throw Error('Unsupported instance element '+type+'.');if(ns.length===p.length)return p.map(i=>ns[i]);const es=edges[type];if(!es||ns.length!==p.length+es.length)throw Error('Unsupported instance element order.');return [...p.map(i=>ns[i]),...es.map(([a,b])=>{const i=es.findIndex(([x,y])=>x===p[a]&&y===p[b]||x===p[b]&&y===p[a]);if(i<0)throw Error('Invalid midside ordering.');return ns[p.length+i];})];}
  function part(input,state){
    const map=catalog(state),old=map.get(input.id);if(old&&!isPart(old))throw Error('This identity is not a part.');
    if(input.source&&!map.has(input.source))throw Error('The part CAD source is missing.');
    return{label:(old?'Rename ':'Add ')+named(input.name),objects:[{id:input.id,name:named(input.name),kind:'part',dependsOn:input.source?[input.source]:[],definition:{generator:PART,source:input.source||null,cards:[]}}]};
  }
  function sourceMeshes(map,partId){
    const part=map.get(partId);if(!isPart(part))throw Error('Select a part.');
    const members=new Set([...map.values()].filter(o=>o.definition.part===partId&&!isInstance(o)&&o.definition.generator!==MESH).map(o=>o.id));
    // Include analyst-authored mesh actions and local shell/solid interfaces. Do
    // not replicate assembly supports, payloads or motor connections.
    let more=true;while(more){more=false;for(const o of map.values())if(!members.has(o.id)&&['mesh-actions-v1','shell-solid-embedded-v1','shell-solid-rbe3-v1'].includes(o.definition.generator)&&o.dependsOn?.some(id=>members.has(id))){members.add(o.id);more=true;}}
    return [...members].map(id=>map.get(id)).sort((a,b)=>a.id.localeCompare(b.id));
  }
  function source(map,partId){
    const meshes=sourceMeshes(map,partId),rows=meshes.flatMap(o=>(o.definition.cards||[]).filter(c=>['nodes','elems'].includes(c.family)).map(c=>({owner:o.id,card:c}))),nodes=rows.filter(r=>r.card.family==='nodes'),elements=rows.filter(r=>r.card.family==='elems');
    if(meshes.some(o=>o.facts?.suspendedReason))throw Error('A part mesh is suspended. Repair it before generating instances.');
    if(!elements.length)throw Error('Mesh this part before adding an instance.');
    const nodeIds=new Set(nodes.map(r=>r.card.id));
    for(const {card:c}of elements){const n=c.value.n||[c.value.gn,...(c.value.deps||c.value.inds||[])];if(n.some(id=>!nodeIds.has(id)))throw Error('The part has mesh connectivity outside its own nodes. Include or repair the missing mesh before instancing.');if(!corners[c.value.type]&&!['RBE2','RBE3'].includes(c.value.type))throw Error('Instances do not support '+c.value.type+' in the part mesh.');}
    const properties=new Map();for(const o of map.values())for(const c of o.definition.cards||[])if(c.family==='properties')properties.set(c.id,o.id);
    const dependencies=[...new Set([...meshes.map(o=>o.id),...elements.map(({card:c})=>properties.get(c.value.pid)).filter(Boolean)])];
    const excluded=new Set([...map.values()].filter(o=>!o.definition.partSource).flatMap(o=>o.definition.analysisExcluded||[]).map(e=>e.id));
    return {nodes,elements,dependencies,excluded,key:canonical(rows.map(({owner,card:c})=>[owner,c.role,c.family,c.id,c.value.type||'GRID',c.value.n||c.value.deps||c.value.inds||null]))};
  }
  function materialize(instance,map,layout){
    const s=source(map,instance.definition.part),t=transform(instance.definition.transform),nodeMap=new Map(s.nodes.map(({card:c},i)=>[c.id,layout.node+i])),elementMap=new Map(s.elements.map(({card:c},i)=>[c.id,layout.element+i]));
    const cards=s.nodes.map(({card:c},i)=>{const n=c.value;if(n.cp||![n.x,n.y,n.z].every(Number.isFinite))throw Error('Part instances require basic-coordinate GRID positions.');const [x,y,z]=t.point([n.x,n.y,n.z]);return{family:'nodes',id:layout.node+i,role:'generation-'+layout.generation+'/node/'+i,allocationRole:'generation-'+layout.generation+'/nodes',value:{x,y,z,cp:0,cd:0,ps:''}};});
    for(const [{card:c},i]of s.elements.map((r,i)=>[r,i])){
      const v=clone(c.value),id=layout.element+i;v.eid=id;
      if(v.n){if(v.theta||v.mcid)throw Error('Resolve non-basic element material directions before instancing.');v.n=(t.mirrored?reflected(v.type,v.n):v.n).map(n=>nodeMap.get(n));}
      else{v.gn=nodeMap.get(v.gn);if(v.deps)v.deps=v.deps.map(n=>nodeMap.get(n));if(v.inds)v.inds=v.inds.map(n=>nodeMap.get(n));if(v.groups)for(const g of v.groups)g.gids=g.gids.map(n=>nodeMap.get(n));if(v.cm&&v.cm!=='123'&&v.cm!=='123456'||v.refc&&v.refc!=='123'&&v.refc!=='123456'||v.groups?.some(g=>g.c!=='123'&&g.c!=='123456'))throw Error('Instances require full translation sets for internal rigid connections.');}
      cards.push({family:'elems',bucket:c.bucket,id,role:'generation-'+layout.generation+'/element/'+i,allocationRole:'generation-'+layout.generation+'/elements',value:v});
    }
    const analysisExcluded=cards.filter(c=>c.family==='elems'&&s.excluded.has(s.elements[c.id-layout.element].card.id)).map(c=>({id:c.id,type:c.value.type,...(c.value.n?{n:c.value.n}:{})}));
    const nodeFrames=map.get(instance.id+'/mesh')?.definition.nodeFrames;
    const frames=[...new Set((nodeFrames||[]).map(b=>b.frame).filter(Boolean))];
    for(const b of nodeFrames||[]){const c=cards.find(c=>c.family==='nodes'&&c.role===b.role);if(c)c.value.cd=b.frame?map.get(b.frame)?.definition.cards?.[0]?.id||0:0;}
    return{id:instance.id+'/mesh',name:instance.name+' · Mesh',kind:'mesh',dependsOn:[instance.id,...s.dependencies,...frames],definition:{generator:MESH,instance:instance.id,part:instance.definition.part,layout:{...layout,key:layout.sourceKey?'instance-layout:'+instance.id+':'+layout.generation:s.key,...(layout.sourceKey?{sourceKey:s.key}:{})},mapping:{nodes:[...nodeMap],elements:[...elementMap]},cards,analysisExcluded,...(nodeFrames?{nodeFrames:clone(nodeFrames)}:{})}};
  }
  function instance(input,state,ids){
    const map=catalog(state),old=map.get(input.id);if(old&&!isInstance(old))throw Error('This identity is not a live instance.');if(old&&old.definition.part!==input.part)throw Error('A live instance cannot switch parts. Create another instance.');
    const o={id:input.id,name:named(input.name),kind:'instance',dependsOn:[input.part],definition:{generator:INSTANCE,part:input.part,transform:transform(input.transform).value,cards:[]}};
    return rebuild(state,{label:(old?'Update ':'Add ')+o.name,objects:[o]},ids);
  }
  function rebuild(state,request,ids={}){
    const map=catalog(state),changed=new Map((request.objects||[]).map(o=>[o.id,clone(o)])),removed=[...(request.removeObjects||[]),...(request.convertToPlain||[])];
    for(const [id,o]of changed)map.set(id,o);for(const id of removed)map.delete(id);
    for(const p of map.values())if(isPart(p)&&changed.has(p.definition.source)){changed.set(p.id,clone(p));for(const m of sourceMeshes(map,p.id))if(!changed.has(m.id))changed.set(m.id,clone(m));}
    const blocks=[...(request.reservations||[])],next={};
    for(const [ns,family]of [['node','nodes'],['element','elems']]){next[ns]=ids[ns]||1;for(const r of state?.project.reservations||[])if(r.namespace===ns)next[ns]=Math.max(next[ns],r.end+1);for(const r of blocks)if(r.namespace===ns)next[ns]=Math.max(next[ns],r.start+r.count);for(const o of map.values())for(const c of o.definition.cards||[])if(c.family===family)next[ns]=Math.max(next[ns],c.id+1);}
    for(const i of map.values())if(isInstance(i)){
      const s=source(map,i.definition.part),old=map.get(i.id+'/mesh'),same=(old?.definition.layout.sourceKey??old?.definition.layout.key)===s.key;
      const generation=same?old.definition.layout.generation:(old?.definition.layout.generation||0)+1;
      const layout={...(same?old.definition.layout:{node:next.node,element:next.element}),key:'instance-layout:'+i.id+':'+generation,sourceKey:s.key,generation};
      if(!same)for(const [ns,count]of [['node',s.nodes.length],['element',s.elements.length]]){blocks.push({owner:i.id+'/mesh',namespace:ns,role:'generation-'+layout.generation+'/'+(ns==='node'?'nodes':'elements'),start:next[ns],count});next[ns]+=count;}
      const mesh=materialize(i,map,layout);
      if(!old||canonical(mesh.definition)!==canonical(old.definition)||mesh.name!==old.name||i.dependsOn?.some(id=>changed.has(id))||s.dependencies.some(id=>changed.has(id))||changed.has(i.id)){changed.set(i.id,clone(i));changed.set(mesh.id,mesh);map.set(mesh.id,mesh);}
    }
    for(const o of map.values())if(o.definition.partSource){const meshes=sourceMeshes(map,o.definition.partSource),elements=meshes.flatMap(m=>(m.definition.cards||[]).filter(c=>c.family==='elems'));const next={...clone(o),dependsOn:[o.definition.partSource,...meshes.map(m=>m.id)],definition:{...clone(o.definition),analysisExcluded:elements.map(c=>({id:c.id,type:c.value.type,...(c.value.n?{n:c.value.n}:{})}))}};if(canonical(next.definition)!==canonical(o.definition)||next.dependsOn.some(id=>changed.has(id)))changed.set(o.id,next);}
    return{...clone(request),objects:[...changed.values()],reservations:blocks};
  }
  function scopedRegions(state,request){
    const map=catalog(state),changed=new Map((request.objects||[]).map(o=>[o.id,clone(o)]));for(const[id,o]of changed)map.set(id,o);for(const id of [...(request.removeObjects||[]),...(request.convertToPlain||[])])map.delete(id);
    for(const o of map.values())if(o.definition.scope?.instance){const s=o.definition.scope,base=map.get(s.region),mesh=map.get(s.instance+'/mesh');if(!base||!mesh)throw Error('Instance region source is missing.');const resolved=Regions.isRegion(base)?Regions.resolve(base,map):Mount.resolveRegion(base,map);map.set(base.id,resolved);if(canonical(base.definition)!==canonical(resolved.definition))changed.set(base.id,resolved);
      const entity=o.definition.entity,ids=resolved.definition.resolved[entity==='node'?'nodes':'elements'],mapping=new Map(mesh.definition.mapping[entity==='node'?'nodes':'elements']);if(!ids?.length||ids.some(id=>!mapping.has(id)))throw Error(o.name+': source region is outside the instance part.');
      const built=Regions.build({id:o.id,name:o.name,entity,ids:ids.map(n=>mapping.get(n))},{project:{objects:[...map.values()]}},null).objects[0];built.definition.scope=clone(s);built.dependsOn=[...new Set([...built.dependsOn,s.region,s.instance])].sort();
      if(canonical(built.definition)!==canonical(o.definition)||[...built.dependsOn].some(id=>changed.has(id))){changed.set(o.id,built);map.set(o.id,built);}
    }return{...clone(request),objects:[...changed.values()]};
  }
  function region(input,state){
    const map=catalog(state),base=map.get(input.region),i=map.get(input.instance);if(!isInstance(i)||!base||base.definition.scope)throw Error('Select a source region and a live instance.');
    const entity=base.definition.entity||'node',o={id:input.id,name:named(input.name),kind:'region',dependsOn:[],definition:{generator:Regions.GENERATOR,entity,scope:{instance:i.id,region:base.id},cards:[]}};
    return scopedRegions(state,{label:'Scope '+o.name+' to '+i.name,objects:[o]});
  }
  function remove(state,id){const map=catalog(state),o=map.get(id);if(!isInstance(o)&&!isPart(o))throw Error('Select a part or instance.');let removed=isInstance(o)?[id,id+'/mesh']:[id,...sourceMeshes(map,id).map(o=>o.id),...(o.definition.source?[o.definition.source]:[])];const users=[...map.values()].filter(o=>!removed.includes(o.id)&&o.dependsOn.some(id=>removed.includes(id)));if(users.length)throw Error('Repair or remove dependent objects first: '+users.map(o=>o.name).join(', '));return{label:'Remove '+o.name,removeObjects:removed};}
  function sourceReference(state,id,reference=true){
    const map=catalog(state);if(!isPart(map.get(id)))throw Error('Select a part.');const key=id+'/source-participation';
    if(!reference){if(!map.has(key))throw Error('The source already participates.');return{label:'Include source placement',removeObjects:[key]};}
    return rebuild(state,{label:'Use source placement as reference only',objects:[{id:key,name:map.get(id).name+' · Reference source placement',kind:'selection',dependsOn:[id],definition:{generator:'part-source-participation-v1',partSource:id,analysisExcluded:[],cards:[]}}]});
  }
  function makeUnique(state,id){
    const map=catalog(state),i=map.get(id),m=map.get(id+'/mesh');if(!isInstance(i)||!m)throw Error('Select a meshed instance.');
    // Keep the materialization owner/roles/IDs, so existing assembly connections
    // remain valid. The independent mesh snapshot is deliberately explicit.
    const p={...clone(i),id:id+'/unique',kind:'part',dependsOn:[],definition:{generator:PART,source:null,cards:[],copiedFrom:i.definition.part}};
    const mesh={...clone(m),definition:{...clone(m.definition),generator:COPY,part:p.id,recipe:{kind:'mesh-snapshot',cards:clone(m.definition.cards)}}};delete mesh.definition.instance;mesh.dependsOn=[p.id,...new Set((m.definition.nodeFrames||[]).map(b=>b.frame).filter(Boolean)),...[...map.values()].filter(o=>o.definition.cards?.some(c=>c.family==='properties'&&m.definition.cards.some(e=>e.family==='elems'&&e.value.pid===c.id))).map(o=>o.id)];
    const scoped=[...map.values()].filter(o=>o.definition.scope?.instance===id).map(o=>{const r=clone(o);delete r.definition.scope;r.dependsOn=r.dependsOn.filter(x=>x!==id&&x!==o.definition.scope.region);return r;});
    return{label:'Make '+i.name+' independent',objects:[p,mesh,...scoped],removeObjects:[id]};
  }
  function validate(object,map){
    const d=object.definition;
    if(isPart(object)){if(d.source&&map.get(d.source)?.definition.generator!=='cad-source-v1')throw Error('Part source is missing.');if(canonical(object.dependsOn)!==canonical(d.source?[d.source]:[])||d.cards?.length)throw Error('Invalid part dependencies.');}
    if(['cad-mapped-v1','cad-shell-v1',COPY].includes(d.generator)&&d.part){const p=map.get(d.part);if(!isPart(p)||!object.dependsOn.includes(p.id)||d.generator!==COPY&&d.source!==p.definition.source)throw Error('Mesh ownership disagrees with its part source.');}
    if(isInstance(object)){transform(d.transform);if(!isPart(map.get(d.part))||canonical(object.dependsOn)!==canonical([d.part])||d.cards?.length||map.get(object.id+'/mesh')?.definition.generator!==MESH)throw Error('Live instance definition is incomplete.');}
    if(d.partSource){const meshes=sourceMeshes(map,d.partSource),excluded=meshes.flatMap(m=>(m.definition.cards||[]).filter(c=>c.family==='elems').map(c=>({id:c.id,type:c.value.type,...(c.value.n?{n:c.value.n}:{})})));if(d.generator!=='part-source-participation-v1'||d.cards?.length||canonical(d.analysisExcluded)!==canonical(excluded)||canonical([...object.dependsOn].sort())!==canonical([d.partSource,...meshes.map(m=>m.id)].sort()))throw Error('Source placement participation disagrees with its part.');}
    if(d.generator===MESH){const i=map.get(d.instance);if(!isInstance(i))throw Error('Instance mesh has no placement.');const expected=materialize(i,map,d.layout);if(canonical(expected.definition)!==canonical(d)||canonical(expected.dependsOn.sort())!==canonical([...object.dependsOn].sort()))throw Error(object.name+': generated mesh disagrees with its live instance.');}
  }
  return Object.freeze({PART,INSTANCE,MESH,COPY,isPart,isInstance,identity,transform,reflected,part,sourceMeshes,instance,rebuild,scopedRegions,region,remove,sourceReference,makeUnique,validate});
}));
