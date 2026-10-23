(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./coordinate-project.js'));
  else root.WebMeshAttachmentProject=factory(root.WebMeshCoordinates);
}(typeof globalThis!=='undefined'?globalThis:this,function(F){
  'use strict';
  const REGION='cad-mount-region-v1', ATTACHMENT='rbe2-cbush-v1', TEMPLATE='pbush-basic-v1';
  const copy=v=>JSON.parse(JSON.stringify(v));
  const catalog=state=>new Map((state?.project.objects||[]).map(o=>[o.id,o]));
  const named=name=>{if(typeof name!=='string'||!name.trim())throw Error('Enter a name.');return name.trim();};
  function vector(v,label){if(!Array.isArray(v)||v.length!==3||!v.every(Number.isFinite))throw Error(label+' requires three finite basic XYZ coordinates.');return v.slice();}
  function next(state,ids,ns){return Math.max(ids[ns]||1,...(state?.project.reservations||[]).filter(r=>r.namespace===ns).map(r=>r.end+1));}
  function existing(map,id,generator){const o=map.get(id);if(o&&o.definition.generator!==generator)throw Error('This identity belongs to another project object.');return o;}
  function get(map,id,generator,label){const o=map.get(id);if(!o||o.definition.generator!==generator)throw Error('Select a valid '+label+'.');if(o.facts?.suspendedReason)throw Error(o.name+' is suspended.');return o;}
  function resolveRegion(object,map){
    const d=object.definition,s=d.selector,mesh=map.get(s.mesh),source=map.get(mesh?.definition.source);
    if(!mesh||!['cad-mapped-v1','cad-shell-v1'].includes(mesh.definition.generator)||mesh.facts?.suspendedReason)throw Error('Select an active committed CAD mesh.');
    const fail=reason=>{throw Error('Mounting region “'+object.name+'”: '+reason);};
    if(source?.definition.geometryKey!==s.geometryKey)fail('the CAD geometry changed. Repair this region on the proposed mesh before applying the topology change.');
    if(!Array.isArray(s.faces)||!s.faces.length||s.faces.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(s.faces).size!==s.faces.length)fail('select one or more distinct CAD faces.');
    const kind=s.kind||'face';if(!['face','edge'].includes(kind)||kind==='edge'&&mesh.definition.generator!=='cad-shell-v1')fail('edge regions require a committed shell mesh.');
    const faces=s.faces.map(id=>mesh.definition[kind==='edge'?'edges':'faces']?.find(f=>f.id===id));
    if(faces.some(f=>!f?.nodes.length))fail('a selected face/edge is not meshed. Restore its solid to the mesh scope or redefine the region. Older projects need one reviewed mesh regeneration.');
    const nodes=[...new Set(faces.flatMap(f=>f.nodes))].sort((a,b)=>a-b);
    const grids=new Map([...map.values()].filter(o=>!o.facts?.suspendedReason).flatMap(o=>(o.definition.cards||[]).filter(c=>c.family==='nodes').map(c=>[c.id,c.value])));
    const points=nodes.map(id=>{const n=grids.get(id);if(!n||n.cp)fail('node '+id+' has no basic-coordinate mesh resolution.');return vector([n.x,n.y,n.z],'Resolved node');});
    if(nodes.length<3)fail('at least three support nodes are required.');
    const a=points[0],delta=p=>p.map((x,i)=>x-a[i]),v=points.map(delta),span=v.reduce((m,p)=>Math.max(m,Math.hypot(...p)),0);
    const b=v.reduce((best,p)=>Math.hypot(...p)>Math.hypot(...best)?p:best,[0,0,0]);
    const area=v.reduce((m,p)=>Math.max(m,Math.hypot(b[1]*p[2]-b[2]*p[1],b[2]*p[0]-b[0]*p[2],b[0]*p[1]-b[1]*p[0])),0);
    if(!span||area<=span*span*1e-10)fail('support nodes are coincident or collinear.');
    return {...copy(object),dependsOn:[mesh.id,mesh.definition.source],definition:{...copy(d),resolved:{meshKey:mesh.definition.layout.key,nodes,centroid:[0,1,2].map(i=>points.reduce((sum,p)=>sum+p[i],0)/points.length)},cards:[]}};
  }
  function region(input,state){
    const map=catalog(state),old=existing(map,input.id,REGION),mesh=map.get(input.mesh);
    if(!mesh||!['cad-mapped-v1','cad-shell-v1'].includes(mesh.definition.generator))throw Error('Select a committed CAD shell or solid mesh.');
    const geometryKey=map.get(mesh.definition.source).definition.geometryKey;
    const object=resolveRegion({id:input.id,kind:'region',name:named(input.name),definition:{generator:REGION,selector:{mesh:mesh.id,geometryKey,...(input.kind?{kind:input.kind}:{}),faces:[...new Set(input.faces)].sort((a,b)=>a-b)}}},map);
    return {label:(old?'Update ':'Create ')+object.name,objects:[object]};
  }
  function template(input,state,ids){
    const old=existing(catalog(state),input.id,TEMPLATE),K=input.stiffness;
    if(!Array.isArray(K)||K.length!==6||!K.every(k=>Number.isFinite(k)&&k>=0)||!K.some(k=>k>0))throw Error('Enter six nonnegative stiffness values, with at least one positive value.');
    const pid=old?.definition.cards[0].id||next(state,ids,'property');
    const value={type:'PBUSH',pid,K:'K'};K.forEach((k,i)=>value['K'+(i+1)]=k);
    return {id:input.id,kind:'template',name:named(input.name),definition:{generator:TEMPLATE,frame:'basic',cards:[{family:'properties',id:pid,role:'stiffness',value}]}};
  }
  function resolveAttachment(object,map){
    const d=object.definition,region=get(map,d.region,REGION,'mounting region'),points=map.get(d.points),t=get(map,d.template,TEMPLATE,'shared PBUSH template');
    if(!points||points.kind!=='point'||points.definition.attachment!==object.id)throw Error('Attachment point ownership is missing.');
    const mount=points.definition.cards.find(c=>c.role==='mount'),shaft=points.definition.cards.find(c=>c.role==='shaft');
    const xyz=c=>vector(c&&[c.value.x,c.value.y,c.value.z],'Mount and shaft');
    const m=xyz(mount),s=xyz(shaft);if(!Math.hypot(...s.map((x,i)=>x-m[i])))throw Error('Mount and shaft points must be distinct.');
    if(!/^[1-3]+$/.test(d.components)||new Set(d.components).size!==d.components.length)throw Error('Mounting regions support dependent translations 1, 2 and 3 (normally 123).');
    const coordinate=F.frame({project:{objects:[...map.values()]}},d.frame);
    const rbe=object.definition.cards.find(c=>c.role==='mount'),bush=object.definition.cards.find(c=>c.role==='bush');
    return {...copy(object),dependsOn:[...new Set([...(d.frame?[d.frame]:[]),region.id,region.definition.selector.mesh,points.id,t.id,...[...map.values()].filter(o=>(o.definition.cards||[]).some(c=>c.family==='nodes'&&region.definition.resolved.nodes.includes(c.id))).map(o=>o.id)])],definition:{...copy(d),cards:[
      {family:'elems',bucket:'rbe2',id:rbe.id,role:'mount',value:{type:'RBE2',eid:rbe.id,gn:mount.id,cm:d.components,deps:region.definition.resolved.nodes.slice()}},
      // The explicit CID defines the six PBUSH stiffness directions.
      {family:'elems',bucket:'bush',id:bush.id,role:'bush',value:{type:'CBUSH',eid:bush.id,pid:t.definition.cards[0].id,n:[mount.id,shaft.id],cid:coordinate.cid,orient:{kind:'x',x:[0,1,0]}}}
    ]}};
  }
  function attachment(input,state,ids){
    const map=catalog(state),old=existing(map,input.id,ATTACHMENT),name=named(input.name),objects=[];
    if(input.newTemplate){const t=template(input.newTemplate,state,ids);if(map.has(t.id))throw Error('Choose the existing template to reuse it.');map.set(t.id,t);objects.push(t);}
    const region=get(map,input.region,REGION,'mounting region');
    map.set(region.id,resolveRegion(region,map));
    const pointId=old?.definition.points||input.id+'/points',oldPoints=map.get(pointId),nid=next(state,ids,'node');
    if(!old&&oldPoints)throw Error('The point identity is already in use.');
    const points={id:pointId,kind:'point',name:name+' · Points',definition:{attachment:input.id,cards:['mount','shaft'].map((role,i)=>{
      const p=vector(input[role],role),id=oldPoints?.definition.cards.find(c=>c.role===role).id||nid+i;
      return {family:'nodes',id,role,value:{x:p[0],y:p[1],z:p[2],cp:0,cd:0,ps:''}};
    })}};
    map.set(pointId,points);objects.push(points);
    const eid=next(state,ids,'element');
    const object={id:input.id,kind:'connection',name,definition:{generator:ATTACHMENT,region:input.region,points:pointId,template:input.newTemplate?.id||input.template,components:input.components,frame:input.frame||null,
      cards:old?.definition.cards||[{role:'mount',id:eid},{role:'bush',id:eid+1}]}};
    objects.push(resolveAttachment(object,map));
    return {label:(old?'Update ':'Create ')+name,objects};
  }
  // Evaluate only known downstream generators. Unknown consumers retain the
  // core's invalid check, rather than being silently certified by this module.
  function rebuild(state,request){
    const map=catalog(state),changed=new Map((request.objects||[]).map(o=>[o.id,copy(o)])),affected=new Set([...changed.keys(),...(request.removeObjects||[]),...(request.convertToPlain||[])]);
    for(const [id,o] of changed)map.set(id,o);
    for(const id of [...(request.removeObjects||[]),...(request.convertToPlain||[])])map.delete(id);
    let more=true;while(more){more=false;for(const o of map.values())if(!affected.has(o.id)&&(o.dependsOn||[]).some(id=>affected.has(id))){affected.add(o.id);more=true;}}
    for(const generator of [REGION,ATTACHMENT])for(const o of map.values())if(affected.has(o.id)&&o.definition.generator===generator){
      const resolved=generator===REGION?resolveRegion(o,map):resolveAttachment(o,map);map.set(o.id,resolved);changed.set(o.id,resolved);
    }
    return {...copy(request),objects:[...changed.values()]};
  }
  function rootFor(state,id){return state?.project.objects.find(o=>o.definition.generator===ATTACHMENT&&(o.id===id||o.definition.points===id))||null;}
  function removal(state,id){
    const map=catalog(state),root=rootFor(state,id),object=map.get(id);if(!object)throw Error('Unknown project object.');
    if(!root&&![REGION,TEMPLATE].includes(object.definition.generator))throw Error('Unsupported attachment owner.');
    const ids=root?[root.id,root.definition.points]:[id];
    const users=[...map.values()].filter(o=>!ids.includes(o.id)&&o.dependsOn.some(d=>ids.includes(d)));
    if(users.length)throw Error('Resolve dependent objects first: '+users.map(o=>o.name).join(', ')+'.');
    return {label:'Remove '+(root||object).name,removeObjects:ids};
  }
  function describe(state,request){
    const map=catalog(state),notes=[];
    for(const o of request.objects||[]){const old=map.get(o.id),d=o.definition;
      if(d.generator===REGION)notes.push(o.name+': CAD '+(d.selector.kind==='edge'?'edges ':'faces ')+d.selector.faces.join(', ')+'; '+(old?old.definition.resolved.nodes.length+' → ':'')+d.resolved.nodes.length+' support nodes.');
      if(d.generator===ATTACHMENT){const r=d.cards.find(c=>c.role==='mount').value,b=d.cards.find(c=>c.role==='bush').value;
        notes.push(o.name+': RBE2 '+r.eid+', dependent DOFs '+(old?old.definition.components+' → ':'')+r.cm+', mount GRID '+r.gn+'; CBUSH '+b.eid+' → shaft GRID '+b.n[1]+', PBUSH '+b.pid+' in coordinate '+b.cid+'.');}
      if(d.generator===TEMPLATE){const users=[...map.values()].filter(c=>c.definition.generator===ATTACHMENT&&c.definition.template===o.id);notes.push(o.name+': shared PBUSH '+d.cards[0].id+(users.length?' used by '+users.map(u=>u.name).join(', '):'')+'.');}
    }
    return notes.join(' ');
  }
  return Object.freeze({REGION,ATTACHMENT,TEMPLATE,resolveRegion,region,template,attachment,rebuild,removal,rootFor,describe});
}));
