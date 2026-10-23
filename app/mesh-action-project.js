(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./mesh-actions.js'));else root.WebMeshActionProject=factory(root.WebMeshActions);}(typeof globalThis!=='undefined'?globalThis:this,function(A){
  'use strict';
  const GENERATOR='mesh-actions-v1',copy=x=>JSON.parse(JSON.stringify(x));
  const meshOf=semantic=>({nodes:(semantic.nodes||[]).map(([id,n])=>({id,...n})),elements:Object.values(semantic.elems||{}).flat().map(e=>({id:e.eid,type:e.type,pid:e.pid,nodes:e.n||[],...(e.zoffs!=null?{zoffs:e.zoffs}:{})}))});
  const buckets={CTRIA3:'tri',CQUAD4:'quad',CHEXA:'hex',CTETRA:'tet',CPENTA:'penta'};
  function cardsOf(result){return [...result.nodes.map(n=>({family:'nodes',id:n.id,role:'grid-'+n.id,value:{x:n.x,y:n.y,z:n.z,cp:0,cd:0,ps:''}})),...result.elements.map(e=>({family:'elems',bucket:buckets[e.type],id:e.id,role:'element-'+e.id,value:{type:e.type,eid:e.id,pid:e.pid,n:e.nodes}}))];}
  function dependencies(state,cards,sourceKeys=[]){const owners=new Map((state?.owners||[]).map(e=>[e.key,e.owner]));return [...new Set([...sourceKeys,...cards.flatMap(c=>c.family==='elems'?['property:'+c.value.pid,...c.value.n.map(n=>'node:'+n)]:[])].map(k=>owners.get(k)).filter(Boolean))];}
  function build(input,state,semantic,ids){
    if(!input.id||!input.name?.trim())throw Error('Enter an action name.');
    if(state?.project.objects.some(o=>o.id===input.id))throw Error('Create a new action identity. Remove/recreate a manual action to change its inputs.');
    const mesh=meshOf(semantic),rows=new Map([...(semantic.nodes||[]).map(([id,v])=>['node:'+id,{family:'nodes',id,value:v}]),...Object.entries(semantic.elems||{}).flatMap(([bucket,es])=>es.map(v=>['element:'+v.eid,{family:'elems',id:v.eid,bucket,value:v}]))]);
    const steps=input.steps||[],sourceKeys=new Set();
    for(const s of steps){
      const sourceElements=[...(s.elements||[]),...(s.facets||[]).map(f=>f.element)];
      for(const id of sourceElements){const e=rows.get('element:'+id);if(!e)throw Error('Missing source element '+id+'.');sourceKeys.add('element:'+id);for(const n of e.value.n||[])sourceKeys.add('node:'+n);}
      for(const n of [...(s.nodes||[]),...(s.connectivity||[]).flat(),...(s.pairs||[]).flat()])sourceKeys.add('node:'+n);
      if(s.pid){const p=semantic.properties.find(([id])=>id===s.pid)?.[1],solid=s.action==='extrude-shells'||s.action==='create-elements'&&['CHEXA','CTETRA','CPENTA'].includes(s.type);if(p?.type!==(solid?'PSOLID':'PSHELL'))throw Error('Choose an existing '+(solid?'PSOLID':'PSHELL')+' section.');}
    }
    for(const k of sourceKeys){const r=rows.get(k);if(!r)throw Error('Missing input '+k+'.');if(r.family==='nodes'&&(r.value.cp||r.value.cd))throw Error('Mesh actions currently require basic-coordinate source GRID records.');}
    const result=A.execute(mesh,steps,ids),cards=cardsOf(result),modifiedOwners=[];
    for(const e of result.updatedElements){
      const entry=state?.owners.find(o=>o.key==='element:'+e.id),owner=state?.project.objects.find(o=>o.id===entry?.owner);
      if(!owner||owner.kind!=='mesh')throw Error('Node sharing requires project-owned mesh elements; plain elements can be recreated with explicit shared connectivity.');
      if(state.project.objects.some(o=>o.definition.modifiedOwners?.some(m=>m.before.id===owner.id)||o.definition.embeddedShell===owner.id))throw Error('This mesh already has a connectivity edit; remove that edit before sharing more nodes.');
      let m=modifiedOwners.find(m=>m.before.id===owner.id);if(!m){m={before:copy(owner),after:copy(owner)};modifiedOwners.push(m);}
      m.after.definition.cards.find(c=>c.family==='elems'&&c.id===e.id).value.n=e.nodes;
    }
    for(const id of result.removedNodes){
      const entry=state?.owners.find(o=>o.key==='node:'+id),owner=state?.project.objects.find(o=>o.id===entry?.owner);
      if(!owner||owner.kind!=='mesh')throw Error('Retiring source nodes requires mesh-owned GRIDs. Clear “Retire unused source nodes” to retain plain/reference GRIDs.');
      let m=modifiedOwners.find(m=>m.before.id===owner.id);if(!m){m={before:copy(owner),after:copy(owner)};modifiedOwners.push(m);}
      m.after.definition.cards=m.after.definition.cards.filter(c=>c.family!=='nodes'||c.id!==id);sourceKeys.delete('node:'+id);
    }
    for(const m of modifiedOwners){
      m.after.definition.actionEdits=[...(m.after.definition.actionEdits||[]),input.id];
      m.after.dependsOn=[...new Set([...m.after.dependsOn,...dependencies(state,m.after.definition.cards)])].filter(id=>id!==m.after.id);
      // Rewire provenance only when every element using the old node was selected.
      const pairs=steps.filter(s=>s.action==='share-nodes').flatMap(s=>s.pairs),still=new Set(m.after.definition.cards.filter(c=>c.family==='elems').flatMap(c=>c.value.n||[]));
      const mapping=new Map(pairs.filter(([a])=>!still.has(a)));
      for(const family of ['faces','edges'])for(const f of m.after.definition[family]||[])f.nodes=f.nodes.map(n=>mapping.get(n)||n);
      // Keep original GRID cards for reversible manual editing and any external references.
    }
    const changed=new Map(modifiedOwners.flatMap(m=>m.after.definition.cards.filter(c=>c.family==='elems').map(c=>['element:'+c.id,c])));
    const inputs=[...sourceKeys].map(k=>({key:k,card:copy(changed.get(k)||rows.get(k))}));
    // Reused nodes may be outside the explicit seed selection.
    for(const c of cards.filter(c=>c.family==='elems'))for(const n of c.value.n)if(rows.has('node:'+n)&&!sourceKeys.has('node:'+n)){if(rows.get('node:'+n).value.cp||rows.get('node:'+n).value.cd)throw Error('Reused nodes must use basic coordinates.');sourceKeys.add('node:'+n);inputs.push({key:'node:'+n,card:copy(rows.get('node:'+n))});}
    const excluded=input.excludeElements||[],analysisExcluded=excluded.map(id=>{const e=rows.get('element:'+id)?.value;if(!e)throw Error('Missing element to exclude: '+id);return {id,type:e.type,n:e.n};});
    const object={id:input.id,name:input.name.trim(),kind:'mesh',dependsOn:dependencies(state,cards,[...sourceKeys,...excluded.map(id=>'element:'+id)]),definition:{generator:GENERATOR,actions:result.trace,inputs,modifiedOwners,analysisExcluded,cards}};
    return {request:{label:'Mesh action: '+object.name,objects:[...modifiedOwners.map(m=>m.after),object]},mesh:result.mesh,object};
  }
  function participation(input,state,semantic){
    const id=input.id,old=state?.project.objects.find(o=>o.id===id);if(old&&old.definition.generator!=='analysis-participation-v1')throw Error('Wrong participation identity.');
    const elements=Object.values(semantic.elems).flat(),selected=[...new Set(input.elements)];if(!selected.length)throw Error('Select elements to exclude.');
    const excluded=selected.map(id=>{const e=elements.find(e=>e.eid===id);if(!e||!e.n)throw Error('Select structural elements with explicit connectivity.');return{id,type:e.type,n:e.n};});
    return{label:'Exclude elements from analysis',objects:[{id,name:input.name||'Excluded reference elements',kind:'selection',dependsOn:dependencies(state,[],selected.map(id=>'element:'+id)),definition:{generator:'analysis-participation-v1',analysisExcluded:excluded,cards:[]}}]};
  }
  function rebuild(state,request){
    const changed=new Map((request.objects||[]).map(o=>[o.id,copy(o)])),removed=new Set([...(request.removeObjects||[]),...(request.convertToPlain||[])]),affected=new Set([...changed.keys(),...removed]);
    let more=true;while(more){more=false;for(const o of state?.project.objects||[])if(!removed.has(o.id)&&!affected.has(o.id)&&o.dependsOn.some(id=>affected.has(id))){affected.add(o.id);more=true;}}
    for(const o of state?.project.objects||[])if(!removed.has(o.id)&&affected.has(o.id)&&!changed.has(o.id)&&[GENERATOR,'analysis-participation-v1'].includes(o.definition.generator))changed.set(o.id,copy(o));
    return{...copy(request),objects:[...changed.values()]};
  }
  function removal(state,id){
    const old=state.project.objects.find(o=>o.id===id);if(!old)throw Error('Missing action.');
    const users=state.project.objects.filter(o=>o.id!==id&&o.dependsOn.includes(id));if(users.length)throw Error('Resolve dependent objects first: '+users.map(o=>o.name).join(', '));
    return {label:'Remove '+old.name,objects:(old.definition.modifiedOwners||[]).map(m=>copy(m.before)),removeObjects:[id]};
  }
  return Object.freeze({GENERATOR,meshOf,cardsOf,dependencies,build,participation,rebuild,removal});
}));
