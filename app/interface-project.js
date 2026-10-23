(function(root,factory){
  'use strict';
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.WebMeshInterfaceProject=factory();
}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const GENERATOR='shell-solid-rbe3-v1',copy=v=>JSON.parse(JSON.stringify(v));
  const sub=(a,b)=>a.map((v,i)=>v-b[i]),dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const norm=a=>Math.hypot(...a),xyz=n=>[n.x,n.y,n.z];
  const catalog=state=>new Map((state?.project.objects||[]).map(o=>[o.id,o]));
  function segmentDistance(p,a,b){const v=sub(b,a),t=Math.max(0,Math.min(1,dot(sub(p,a),v)/(dot(v,v)||1)));return norm(sub(p,a.map((x,i)=>x+t*v[i])));}
  function triangleDistance(p,a,b,c){
    const u=sub(b,a),v=sub(c,a),w=sub(p,a),uu=dot(u,u),uv=dot(u,v),vv=dot(v,v),den=uu*vv-uv*uv;
    if(den>0){const s=(dot(w,u)*vv-dot(w,v)*uv)/den,t=(dot(w,v)*uu-dot(w,u)*uv)/den;if(s>=-1e-10&&t>=-1e-10&&s+t<=1+1e-10)return Math.abs(dot(w,cross(u,v)))/norm(cross(u,v));}
    return Math.min(segmentDistance(p,a,b),segmentDistance(p,b,c),segmentDistance(p,c,a));
  }
  const hexFaces=[[0,1,2,3],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
  function resolve(object,map,allocate){
    const d=object.definition,fail=reason=>{throw Error('Shell–solid interface “'+object.name+'”: '+reason);};
    const shell=map.get(d.shell),solid=map.get(d.solid),source=map.get(shell?.definition.source);
    if(shell?.definition.generator!=='cad-shell-v1'||solid?.definition.generator!=='cad-mapped-v1')fail('select an owned CAD shell mesh and mapped solid mesh.');
    if(shell.definition.embeddedBy)fail('remove the existing embedded interface before adding an RBE3 tie to this shell region.');
    if(shell.definition.source!==solid.definition.source||source?.definition.geometryKey!==d.geometryKey)fail('both meshes must use the same unchanged CAD source.');
    if(shell.facts?.suspendedReason||solid.facts?.suspendedReason)fail('a mesh region is suspended.');
    if(!Number.isFinite(d.radius)||d.radius<=0||!Number.isFinite(d.gap)||d.gap<0)fail('enter a positive support radius and nonnegative gap tolerance in model length units.');
    const select=(ids,items,label)=>{if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length)fail('select distinct '+label+'.');return ids.map(id=>{const f=items?.find(f=>f.id===id);if(!f?.nodes.length)fail(label+' '+id+' is missing or no longer meshed.');return f;});};
    const edges=select(d.edges,shell.definition.edges,'shell boundary edges'),faces=select(d.faces,solid.definition.faces,'solid faces');
    const shellNodes=[...new Set(edges.flatMap(f=>f.nodes))].sort((a,b)=>a-b),solidNodes=[...new Set(faces.flatMap(f=>f.nodes))].sort((a,b)=>a-b);
    const grids=mesh=>new Map(mesh.definition.cards.filter(c=>c.family==='nodes').map(c=>[c.id,c.value]));
    const sg=grids(shell),vg=grids(solid),point=(map,id)=>{const n=map.get(id);if(!n||n.cp)fail('support requires basic-coordinate GRID records.');return xyz(n);};
    const triangles=[];
    for(const f of faces){
      const on=new Set(f.nodes);
      for(const card of solid.definition.cards.filter(c=>c.family==='elems'))for(const face of hexFaces){const ids=face.map(i=>card.value.n[i]);if(ids.every(id=>on.has(id))){const p=ids.map(id=>point(vg,id));triangles.push([p[0],p[1],p[2]],[p[0],p[2],p[3]]);}}
    }
    if(!triangles.length)fail('selected solid faces have no resolved element facets.');
    const old=new Map((d.cards||[]).map(c=>[c.role,c])),patches=[];
    const cards=shellNodes.map(nid=>{
      const p=point(sg,nid),gap=triangles.reduce((best,t)=>Math.min(best,triangleDistance(p,...t)),Infinity);
      if(gap>d.gap+1e-8)fail('shell GRID '+nid+' is '+gap.toPrecision(5)+' from the selected solid face, beyond the gap tolerance.');
      const support=solidNodes.filter(n=>norm(sub(point(vg,n),p))<=d.radius+1e-8);
      if(support.length<3)fail('shell GRID '+nid+' has fewer than three solid support nodes; increase radius or refine the solid region.');
      const points=support.map(n=>point(vg,n)),a=points[0],vectors=points.map(q=>sub(q,a)),longest=vectors.reduce((b,v)=>norm(v)>norm(b)?v:b,[0,0,0]),span=norm(longest);
      const area=Math.max(...vectors.map(v=>norm(cross(longest,v))));
      if(!span||area<span*span*1e-6)fail('shell GRID '+nid+' has collinear or ill-conditioned solid support; rotations cannot be transferred.');
      const role='shell-'+nid,eid=old.get(role)?.id||allocate();
      patches.push({node:nid,nodes:support,gap});
      return {family:'elems',bucket:'rbe3',id:eid,role,value:{type:'RBE3',eid,gn:nid,cm:'123456',weight:1,inds:support,groups:[{wt:1,c:'123',gids:support}]}};
    });
    return {...copy(object),dependsOn:[shell.id,solid.id,source.id],definition:{...copy(d),resolved:{shellKey:shell.definition.layout.key,solidKey:solid.definition.layout.key,patches},cards}};
  }
  function allocator(state,objects,ids={}){let eid=Math.max(ids.element||1,...(state?.project.reservations||[]).filter(r=>r.namespace==='element').map(r=>r.end+1),objects.reduce((max,o)=>(o.definition.cards||[]).reduce((m,c)=>['elems','masses'].includes(c.family)?Math.max(m,c.id+1):m,max),1));return()=>eid++;}
  function build(input,state,ids){
    const map=catalog(state),old=map.get(input.id);if(old&&old.definition.generator!==GENERATOR)throw Error('This identity belongs to another object.');
    if(!input.name?.trim())throw Error('Enter an interface name.');
    const source=map.get(map.get(input.shell)?.definition.source);
    const object={id:input.id,kind:'connection',name:input.name.trim(),definition:{generator:GENERATOR,shell:input.shell,solid:input.solid,geometryKey:source?.definition.geometryKey,edges:input.edges,faces:input.faces,radius:input.radius,gap:input.gap,cards:old?.definition.cards||[]}};
    return {label:(old?'Update ':'Create ')+object.name,objects:[resolve(object,map,allocator(state,[...map.values()],ids))]};
  }
  function rebuild(state,request,ids){
    const map=catalog(state),changed=new Map((request.objects||[]).map(o=>[o.id,copy(o)])),affected=new Set([...changed.keys(),...(request.removeObjects||[]),...(request.convertToPlain||[])]);
    for(const [id,o] of changed)map.set(id,o);
    for(const id of [...(request.removeObjects||[]),...(request.convertToPlain||[])])map.delete(id);
    let more=true;while(more){more=false;for(const o of map.values())if(!affected.has(o.id)&&(o.dependsOn||[]).some(id=>affected.has(id))){affected.add(o.id);more=true;}}
    const allocate=allocator(state,[...map.values()],ids);
    for(const o of map.values())if(affected.has(o.id)&&o.definition.generator===GENERATOR)changed.set(o.id,resolve(o,map,allocate));
    return {...copy(request),objects:[...changed.values()]};
  }
  function removal(state,id){const users=state.project.objects.filter(o=>o.dependsOn.includes(id));if(users.length)throw Error('Resolve dependent objects first: '+users.map(o=>o.name).join(', '));return{label:'Remove shell–solid interface',removeObjects:[id]};}
  return Object.freeze({GENERATOR,build,rebuild,removal});
}));
