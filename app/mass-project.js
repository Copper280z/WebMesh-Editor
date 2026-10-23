(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./connection-actions.js'),require('./attachment-project.js'));else root.WebMeshMassProject=factory(root.WebMeshConnectionActions,root.WebMeshAttachmentProject);}(typeof globalThis!=='undefined'?globalThis:this,function(A,Mount){
  'use strict';
  const POINT='analysis-point-v1',MASS='point-mass-v1',DISTRIBUTION='rbe3-distribution-v1',PAYLOAD='distributed-payload-v1';
  const copy=v=>JSON.parse(JSON.stringify(v)),catalog=state=>new Map((state?.project.objects||[]).map(o=>[o.id,o]));
  const next=(state,ids,ns)=>Math.max(ids[ns]||1,...(state?.project.reservations||[]).filter(r=>r.namespace===ns).map(r=>r.end+1));
  const units=state=>state?.project.units||{mass:'t',length:'mm',force:'N',time:'s'};
  function oldObject(input,state,generator){const o=catalog(state).get(input.id);if(!input.id||!input.name?.trim())throw Error('Enter a name.');if(o&&o.definition.generator!==generator)throw Error('This identity belongs to another object.');return o;}
  function gridIndex(map){const result=new Map();for(const o of map.values())if(!o.facts?.suspendedReason)for(const c of o.definition.cards||[])if(c.family==='nodes')result.set(c.id,{owner:o.id,role:c.role,value:c.value});return result;}
  function parseValues(input,state){const u=units(state),v=(p,label)=>{if(!Array.isArray(p)||p.length!==3)throw Error(label+' needs XYZ values.');return p.map(x=>A.quantity(x,'length',u));};return {...copy(input),...(input.mass!=null?{mass:A.quantity(input.mass,'mass',u)}:{}),...(input.position?{position:v(input.position,'Position')}:{}),...(input.offset?{offset:v(input.offset,'Offset')}:{}),...(input.reference?{reference:v(input.reference,'Reference')}:{}),inertia:input.inertia||[0,0,0,0,0,0]};}
  function resolveDirect(object,map){
    const d=object.definition,index=gridIndex(map),nodes=new Map((d.inputs||[]).map(i=>[i.card.id,{id:i.card.id,...i.card.value}]));
    for(const s of d.sources||[]){const g=index.get(s.id);if(!g||g.owner!==s.owner||g.role!==s.role)throw Error(object.name+': selected GRID '+s.id+' was replaced. Edit this object and repair its selection before remeshing.');nodes.set(s.id,{id:s.id,...g.value});}
    const action=d.action,result=A.execute([...nodes.values()],[action]);
    return {...copy(object),dependsOn:[...new Set((d.sources||[]).map(s=>s.owner))],definition:{...copy(d),cards:result.cards,actions:result.actions}};
  }
  function direct(input,state,semantic,ids){
    const generator={point:POINT,mass:MASS,rbe3:DISTRIBUTION}[input.action];if(!generator)throw Error('Choose a point, mass or RBE3 action.');
    const old=oldObject(input,state,generator),p=parseValues(input,state),action={action:input.action,id:old?.definition.action.id||next(state,ids,input.action==='point'?'node':'element')};
    if(input.action==='point')action.position=p.position;
    if(input.action==='mass')Object.assign(action,{node:input.node,mass:p.mass,offset:p.offset||[0,0,0],inertia:p.inertia});
    if(input.action==='rbe3')Object.assign(action,{node:input.node,components:'123456',groups:copy(input.groups)});
    const index=gridIndex(catalog(state)),plain=new Map(semantic.nodes),selected=[...new Set(input.action==='point'?[]:[input.node,...(input.groups||[]).flatMap(g=>g.gids)])],sources=[],inputs=[];
    for(const id of selected){const owned=index.get(id);if(owned)sources.push({id,owner:owned.owner,role:owned.role});else{const n=plain.get(id);if(!n)throw Error('Missing GRID '+id+'.');inputs.push({key:'node:'+id,card:{family:'nodes',id,value:copy(n)}});}}
    const object={id:input.id,name:input.name.trim(),kind:input.action==='point'?'point':'connection',definition:{generator,action,sources,inputs,cards:[]}};
    return {label:(old?'Update ':'Create ')+object.name,objects:[resolveDirect(object,catalog(state))]};
  }
  function payloadResolution(object,map){
    const d=object.definition,p=d.parameters,index=gridIndex(map),seen=new Set(),regions=new Set(),resolved=[];
    if(!Array.isArray(p.supports)||!p.supports.length)throw Error('Select one or more named mounting regions.');
    const groups=p.supports.map(s=>{
      if(regions.has(s.region))throw Error('Select each mounting region once.');regions.add(s.region);
      const region=map.get(s.region);if(region?.definition.generator!==Mount.REGION||region.facts?.suspendedReason)throw Error(object.name+': a mounting region is missing or suspended.');
      if(!Number.isFinite(s.weight)||s.weight<=0)throw Error('Each region influence must be positive.');
      const nodes=region.definition.resolved.nodes.slice();
      for(const n of nodes){if(seen.has(n))throw Error('Selected regions overlap at GRID '+n+'. Use disjoint regions or one combined region.');seen.add(n);if(!index.has(n))throw Error('Region support GRID '+n+' is missing.');}
      resolved.push({region:region.id,name:region.name,nodes,weight:s.weight,perNode:s.weight/nodes.length});
      return{wt:s.weight/nodes.length,c:'123',gids:nodes};
    });
    const com=p.reference.map((x,i)=>x+p.offset[i]),node=d.identities.node;
    const steps=[{action:'point',id:node,position:com,role:'com'},{action:'mass',id:d.identities.mass,node,mass:p.mass,offset:[0,0,0],inertia:p.inertia,role:'mass'},{action:'rbe3',id:d.identities.distribution,node,components:'123456',groups,role:'distribution'}];
    const source=[...index].filter(([id])=>id!==node).map(([id,g])=>({id,...g.value})),result=A.execute(source,steps);
    const point={id:d.point,kind:'point',name:object.name+' · Center of mass',definition:{generator:'payload-point-v1',payload:object.id,cards:result.cards.filter(c=>c.family==='nodes')}};
    const deps=[d.point,...regions,...[...seen].map(n=>index.get(n).owner)];
    return [point,{...copy(object),dependsOn:[...new Set(deps)],definition:{...copy(d),resolved:{com,regions:resolved,nodes:[...seen]},actions:result.actions,cards:result.cards.filter(c=>c.family!=='nodes')}}];
  }
  function payload(input,state,ids){
    const old=oldObject(input,state,PAYLOAD),p=parseValues(input,state),map=catalog(state),eid=next(state,ids,'element');
    const identities=old?.definition.identities||{node:next(state,ids,'node'),mass:eid,distribution:eid+1},point=old?.definition.point||input.id+'/com';
    if(!old&&map.has(point))throw Error('The COM point identity is already in use.');
    for(const s of input.supports||[]){const r=map.get(s.region);if(r?.definition.generator===Mount.REGION)map.set(r.id,Mount.resolveRegion(r,map));}
    const object={id:input.id,name:input.name.trim(),kind:'connection',definition:{generator:PAYLOAD,point,identities,parameters:{mass:p.mass,reference:p.reference,offset:p.offset||[0,0,0],inertia:p.inertia,supports:copy(input.supports)}}};
    return {label:(old?'Update ':'Create ')+object.name,objects:payloadResolution(object,map)};
  }
  function rebuild(state,request){
    const map=catalog(state),changed=new Map((request.objects||[]).map(o=>[o.id,copy(o)])),removed=new Set([...(request.removeObjects||[]),...(request.convertToPlain||[])]),affected=new Set([...changed.keys(),...removed]);
    for(const [id,o] of changed)map.set(id,o);for(const id of removed)map.delete(id);
    let more=true;while(more){more=false;for(const o of map.values())if(!affected.has(o.id)&&(o.dependsOn||[]).some(d=>affected.has(d))){affected.add(o.id);more=true;}}
    const done=new Set();
    function evaluate(o){
      if(done.has(o.id)||!affected.has(o.id))return;done.add(o.id);
      for(const id of o.dependsOn||[])if(map.has(id))evaluate(map.get(id));
      if(o.definition.generator===PAYLOAD)for(const r of payloadResolution(o,map)){map.set(r.id,r);changed.set(r.id,r);}
      if([POINT,MASS,DISTRIBUTION].includes(o.definition.generator)){const r=resolveDirect(o,map);map.set(r.id,r);changed.set(r.id,r);}
    }
    for(const o of map.values())evaluate(o);
    return {...copy(request),objects:[...changed.values()]};
  }
  function rootFor(state,id){const map=catalog(state),o=map.get(id);return o?.definition.payload?map.get(o.definition.payload):o;}
  function removal(state,id){const o=rootFor(state,id);if(!o||![POINT,MASS,DISTRIBUTION,PAYLOAD].includes(o.definition.generator))throw Error('Unknown mass/connection object.');const ids=o.definition.generator===PAYLOAD?[o.id,o.definition.point]:[o.id];const users=[...catalog(state).values()].filter(c=>!ids.includes(c.id)&&(c.dependsOn||[]).some(d=>ids.includes(d)));if(users.length)throw Error('Resolve dependent objects first: '+users.map(o=>o.name).join(', '));return{label:'Remove '+o.name,removeObjects:ids};}
  function describe(state,request){const u=units(state);return(request.objects||[]).filter(o=>o.definition.generator===PAYLOAD).map(o=>{const d=o.definition;return o.name+': '+d.parameters.mass+' '+u.mass+' at COM ('+d.resolved.com.join(', ')+') '+u.length+'; '+d.resolved.nodes.length+' support nodes. Region influence is divided equally among its nodes. Reference DOFs 123456; independent DOFs 123. Mesh material mass is retained.';}).join(' ');}
  return Object.freeze({POINT,MASS,DISTRIBUTION,PAYLOAD,units,direct,payload,rebuild,rootFor,removal,describe});
}));
