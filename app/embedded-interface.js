/* Guided recipe composed exclusively from public mesh actions. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./mesh-actions.js'),require('./mesh-action-project.js'));else root.WebMeshEmbeddedInterface=factory(root.WebMeshActions,root.WebMeshActionProject);}(typeof globalThis!=='undefined'?globalThis:this,function(A,P){
  'use strict';
  const GENERATOR='shell-solid-embedded-v1',copy=x=>JSON.parse(JSON.stringify(x));
  const catalog=state=>new Map((state?.project.objects||[]).map(o=>[o.id,o]));
  function restoreShell(shell,definition){return shell.definition.embeddedBy?copy(definition.baseShell):copy(shell);}
  function resolve(object,map,ids){
    const d=object.definition,fail=message=>{throw Error('Embedded interface “'+object.name+'”: '+message);};
    let shell=map.get(d.shell);const solid=map.get(d.solid),source=map.get(shell?.definition.source);
    if(shell?.definition.generator!=='cad-shell-v1'||solid?.definition.generator!=='cad-mapped-v1')fail('select CAD shell and mapped-solid mesh regions.');
    if(shell.definition.source!==solid.definition.source||source?.definition.geometryKey!==d.geometryKey)fail('both regions must share the unchanged CAD source.');
    if(shell.definition.embeddedBy&&shell.definition.embeddedBy!==object.id)fail('only one embedded interface per shell region is currently supported.');
    if([...map.values()].some(o=>o.id!==object.id&&o.definition.shell===shell.id&&['shell-solid-rbe3-v1',GENERATOR].includes(o.definition.generator)))fail('remove the other interface on this shell region first.');
    shell=restoreShell(shell,d);const baseShell=copy(shell);
    const sc=shell.definition.cards,vc=solid.definition.cards,sg=new Map(sc.filter(c=>c.family==='nodes').map(c=>[c.id,c.value])),vg=new Map(vc.filter(c=>c.family==='nodes').map(c=>[c.id,c.value]));
    const se=sc.filter(c=>c.family==='elems'),ve=vc.filter(c=>c.family==='elems');
    if(se.some(c=>c.value.type!=='CQUAD4'||c.value.n.length!==4||c.value.zoffs)||ve.some(c=>c.value.type!=='CHEXA'||c.value.n.length!==8))fail('use zero-offset CQUAD4 and HEX8 with a matching internal nodal plane; regenerate quadratic regions as linear first.');
    if(![1,2].includes(d.rows)||!Array.isArray(d.direction)||d.direction.length!==3||!d.direction.every(Number.isFinite)||!A.norm(d.direction)||!Number.isFinite(d.tolerance)||d.tolerance<=0)fail('enter one or two rows, a nonzero penetration direction and positive matching tolerance.');
    const direction=d.direction.map(v=>v/A.norm(d.direction)),tol=d.tolerance;
    const select=(ids,items,label)=>{if(!ids?.length||new Set(ids).size!==ids.length)fail('select distinct '+label+'.');return ids.flatMap(id=>{const hit=items.find(f=>f.id===id);if(!hit)fail('missing '+label+' '+id+'.');return hit.nodes;});};
    const boundary=new Set(select(d.edges,shell.definition.edges,'shell edges')),receiving=new Set(select(d.faces,solid.definition.faces,'receiving faces'));
    const point=(g,n)=>{const p=g.get(n);if(!p||p.cp)fail('basic-coordinate source GRIDs are required.');return A.xyz(p);};
    const edges=new Map();for(const c of se)c.value.n.forEach((a,i)=>{const b=c.value.n[(i+1)%4],key=A.key([a,b]);const entry=edges.get(key)||{nodes:[a,b],cards:[]};entry.cards.push(c);edges.set(key,entry);});
    let front=[...edges.values()].filter(e=>e.cards.length===1&&e.nodes.every(n=>boundary.has(n)));
    if(!front.length||new Set(front.flatMap(e=>e.nodes)).size!==boundary.size)fail('select complete shell boundary edges.');
    const degree=new Map();for(const e of front)for(const n of e.nodes)degree.set(n,(degree.get(n)||0)+1);if([...degree.values()].some(n=>n>2))fail('branching shell boundaries are unsupported.');
    const first=front[0].cards[0].value.n.map(n=>point(sg,n)),normal=A.cross(A.sub(first[1],first[0]),A.sub(first[2],first[0])),unit=normal.map(v=>v/A.norm(normal)),origin=first[0];
    if(Math.abs(A.dot(direction,unit))>1e-7)fail('penetration direction must lie in the shell plane.');
    for(const e of front)for(const n of e.cards[0].value.n)if(Math.abs(A.dot(A.sub(point(sg,n),origin),unit))>tol)fail('the selected shell boundary must be planar.');
    const pairs=[];for(const n of boundary){const p=point(sg,n),matches=[...receiving].filter(id=>A.norm(A.sub(point(vg,id),p))<=tol);if(matches.length!==1)fail('GRID '+n+' has '+matches.length+' matching solid entry nodes. Align subdivisions and the internal nodal plane, or reduce tolerance.');pairs.push([n,matches[0]]);}
    if(new Set(pairs.map(p=>p[1])).size!==pairs.length)fail('matching tolerance collapses boundary nodes.');
    const mapping=new Map(pairs),solidMesh={nodes:[...vg].map(([id,n])=>({id,...n})),elements:ve.map(c=>({id:c.id,type:c.value.type,pid:c.value.pid,nodes:c.value.n}))};
    const internal=new Map();for(const f of A.facets(solidMesh))if(f.uses===2&&f.nodes.every(n=>Math.abs(A.dot(A.sub(point(vg,n),origin),unit))<=tol))internal.set(A.key(f.nodes),f);
    const picked=[],used=new Set();front=front.map(e=>({nodes:e.nodes.map(n=>mapping.get(n)),pid:e.cards[0].value.pid}));
    for(let row=0;row<d.rows;row++){
      const next=[];
      for(const edge of front){
        const [a,b]=edge.nodes,candidates=[];
        for(const [key,f] of internal){if(used.has(key)||!f.nodes.includes(a)||!f.nodes.includes(b))continue;
          const i=f.nodes.indexOf(a),j=f.nodes.indexOf(b);if((i+1)%4!==j&&(j+1)%4!==i)continue;
          const otherA=f.nodes[(i+((i+1)%4===j?3:1))%4],otherB=f.nodes[(j+((j+1)%4===i?3:1))%4];
          const va=A.sub(point(vg,otherA),point(vg,a)),vb=A.sub(point(vg,otherB),point(vg,b));
          if(A.dot(va,direction)<=tol||A.dot(vb,direction)<=tol||A.norm(A.cross(va,direction))>tol||A.norm(A.cross(vb,direction))>tol)continue;
          candidates.push({key,facet:f,next:[otherA,otherB],depth:[A.norm(va),A.norm(vb)]});
        }
        if(candidates.length!==1)fail('no unique conforming internal quad for row '+(row+1)+' at edge '+a+'–'+b+'. Align the solid layers and penetration direction.');
        const hit=candidates[0];used.add(hit.key);picked.push({...hit,pid:edge.pid,row:row+1});next.push({nodes:hit.next,pid:edge.pid});
      }
      front=next;
    }
    const allMesh={nodes:[...sg,...vg].map(([id,n])=>({id,...n})),elements:[...se,...ve].map(c=>({id:c.id,type:c.value.type,pid:c.value.pid,nodes:c.value.n}))};
    const steps=[{action:'share-nodes',elements:se.filter(c=>c.value.n.some(n=>boundary.has(n))).map(c=>c.id),pairs,tolerance:tol,retireSources:true}];
    for(const p of picked){const ns=p.facet.nodes.map(n=>point(vg,n)),reverse=A.dot(A.cross(A.sub(ns[1],ns[0]),A.sub(ns[2],ns[0])),normal)<0;steps.push({action:'shells-on-faces',facets:[{element:p.facet.element,face:p.facet.face}],pid:p.pid,reverse});}
    const result=A.execute(allMesh,steps,ids),cards=P.cardsOf(result),old=d.cards||[];
    // Preserve roles only when their exact connectivity/property survives.
    for(const card of cards){const prior=old.find(c=>c.value.pid===card.value.pid&&A.key(c.value.n)===A.key(card.value.n));if(prior){card.id=prior.id;card.value.eid=prior.id;card.role=prior.role;}}
    const changed=new Map(result.updatedElements.map(e=>[e.id,e]));
    shell.definition.cards=sc.filter(c=>c.family!=='nodes'||!result.removedNodes.includes(c.id)).map(c=>c.family==='elems'&&changed.has(c.id)?{...c,value:{...c.value,n:changed.get(c.id).nodes}}:c);
    for(const family of ['faces','edges'])for(const f of shell.definition[family]||[])f.nodes=f.nodes.map(n=>mapping.get(n)||n);
    shell.dependsOn=[...new Set([...shell.dependsOn,solid.id])];shell.definition.embeddedBy=object.id;
    const ownerOfProperty=pid=>[...map.values()].find(o=>o.definition.cards?.some(c=>c.family==='properties'&&c.id===pid))?.id;
    const dependsOn=[...new Set([shell.id,solid.id,source.id,...cards.map(c=>ownerOfProperty(c.value.pid))].filter(Boolean))];
    const overlapArea=picked.reduce((sum,p)=>{const q=p.facet.nodes.map(n=>point(vg,n));return sum+(A.norm(A.cross(A.sub(q[1],q[0]),A.sub(q[2],q[0])))+A.norm(A.cross(A.sub(q[2],q[0]),A.sub(q[3],q[0]))))/2;},0);
    const overlapVolume=picked.reduce((sum,p)=>{const prop=map.get(ownerOfProperty(p.pid))?.definition.cards.find(c=>c.id===p.pid)?.value;const q=p.facet.nodes.map(n=>point(vg,n));const area=(A.norm(A.cross(A.sub(q[1],q[0]),A.sub(q[2],q[0])))+A.norm(A.cross(A.sub(q[2],q[0]),A.sub(q[3],q[0]))))/2;return sum+area*(prop?.t||0);},0);
    let addedMass=0;for(const p of picked){
      const prop=map.get(ownerOfProperty(p.pid))?.definition.cards.find(c=>c.id===p.pid)?.value;
      const material=[...map.values()].flatMap(o=>o.definition.cards||[]).find(c=>c.family==='materials'&&c.id===prop?.mid1)?.value;
      const q=p.facet.nodes.map(n=>point(vg,n)),area=(A.norm(A.cross(A.sub(q[1],q[0]),A.sub(q[2],q[0])))+A.norm(A.cross(A.sub(q[2],q[0]),A.sub(q[3],q[0]))))/2;
      addedMass+=area*(prop?.t||0)*(material?.rho||0);
    }
    const next={...copy(object),dependsOn,definition:{...copy(d),baseShell,embeddedShell:shell.id,actions:result.trace,cards,resolved:{pairs,facets:picked.map(p=>({...p.facet,row:p.row,depth:p.depth})),overlapArea,overlapVolume,addedMass}}};
    return [shell,next];
  }
  function nextIds(state,map,ids){return{...ids,element:Math.max(ids?.element||1,...[...map.values()].flatMap(o=>(o.definition.cards||[]).filter(c=>c.family==='elems').map(c=>c.id+1)),...(state?.project.reservations||[]).filter(r=>r.namespace==='element').map(r=>r.end+1))};}
  function build(input,state,ids){
    const map=catalog(state),old=map.get(input.id);if(old&&old.definition.generator!==GENERATOR)throw Error('Remove the old formulation before creating an embedded interface.');
    if(!input.name?.trim())throw Error('Enter an interface name.');
    const source=map.get(map.get(input.shell)?.definition.source),object={id:input.id,name:input.name.trim(),kind:'connection',definition:{...copy(old?.definition||{}),generator:GENERATOR,shell:input.shell,solid:input.solid,geometryKey:source?.definition.geometryKey,edges:input.edges,faces:input.faces,direction:input.direction,rows:input.rows,tolerance:input.tolerance}};
    return{label:(old?'Update ':'Create ')+object.name,objects:resolve(object,map,nextIds(state,map,ids))};
  }
  function rebuild(state,request,ids){
    const map=catalog(state),changed=new Map((request.objects||[]).map(o=>[o.id,copy(o)])),removed=[...(request.removeObjects||[]),...(request.convertToPlain||[])],affected=new Set([...changed.keys(),...removed]);
    for(const [id,o] of changed)map.set(id,o);for(const id of removed)map.delete(id);
    let more=true;while(more){more=false;for(const o of map.values())if(!affected.has(o.id)&&(o.dependsOn||[]).some(id=>affected.has(id))){affected.add(o.id);more=true;}}
    for(const o of map.values())if(o.definition.generator===GENERATOR&&[o.id,o.definition.shell,o.definition.solid].some(id=>affected.has(id))){
      for(const next of resolve(o,map,nextIds(state,map,ids))){changed.set(next.id,next);map.set(next.id,next);}
    }
    return{...copy(request),objects:[...changed.values()]};
  }
  function removal(state,id){const o=state.project.objects.find(o=>o.id===id);if(!o)throw Error('Missing interface.');const users=state.project.objects.filter(x=>x.dependsOn.includes(id));if(users.length)throw Error('Resolve dependent objects first: '+users.map(o=>o.name).join(', '));return{label:'Remove '+o.name,objects:[copy(o.definition.baseShell)],removeObjects:[id]};}
  return Object.freeze({GENERATOR,build,rebuild,removal});
}));
