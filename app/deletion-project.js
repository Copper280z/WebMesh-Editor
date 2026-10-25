/* Reviewed deletion composes independent authoring. No live model mutations. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./engine-ownership.js'),require('./part-project.js'),require('./assembly-project.js'),require('./mesh-region-project.js'));
  else root.WebMeshDeletion=factory(root.WebMeshOwnership,root.WebMeshParts,root.WebMeshAssembly,root.WebMeshRegions);
}(typeof globalThis!=='undefined'?globalThis:this,function(O,P,A,R){
  'use strict';
  const GENERATOR='independent-object-v1',copy=v=>JSON.parse(JSON.stringify(v)),objects=s=>s?.project.objects||[];
  const namespace={nodes:'node',elems:'element',masses:'element',properties:'property',materials:'material',coords:'coordinate',loadSets:'load',constraintSets:'constraint'};
  const key=c=>namespace[c.family]+':'+c.id,catalog=s=>new Map(objects(s).map(o=>[o.id,o]));
  const blank=()=>({nodes:[],elems:{},masses:[],materials:[],properties:[],coords:[],loads:{},spc:[],spc1:[],temperatures:[]});
  function rootFor(state,id){
    const map=catalog(state),o=map.get(id);if(!o)throw Error('Select a project object.');
    const parent=o.definition.assemblyMember||o.definition.instance||o.definition.attachment||o.definition.payload;
    if(parent&&map.has(parent))return map.get(parent);
    if(o.kind==='source')return objects(state).find(p=>P.isPart(p)&&p.definition.source===id)||o;
    return o;
  }
  function bundle(map,id){
    const o=map.get(id),ids=new Set([id]);if(!o)return ids;
    if(P.isPart(o)&&o.definition.source)ids.add(o.definition.source);
    for(const x of map.values())if(x.definition.assemblyMember===id||x.definition.instance===id||x.definition.attachment===id||x.definition.payload===id||x.definition.partSource===id)ids.add(x.id);
    return ids;
  }
  function affected(state,seeds){
    const map=catalog(state),ids=new Set(seeds);let more=true;
    while(more){more=false;for(const o of map.values())if(!ids.has(o.id)&&((o.dependsOn||[]).some(d=>ids.has(d))||[o.definition.embeddedBy,...o.definition.actionEdits||[],o.definition.assemblyMember,o.definition.instance,o.definition.attachment,o.definition.payload,o.definition.partSource].some(d=>ids.has(d)))){ids.add(o.id);more=true;}}
    return ids;
  }
  function describe(state,id){
    const root=rootFor(state,id),map=catalog(state),selected=bundle(map,root.id),all=affected(state,selected),groups=[];
    const covered=new Set(selected);
    for(const oid of all){if(covered.has(oid))continue;const o=rootFor(state,oid);if(selected.has(o.id))continue;const members=bundle(map,o.id);for(const m of members)covered.add(m);groups.push({id:o.id,name:o.name,kind:o.kind,members:[...members]});}
    return {root,selected:[...selected],dependents:groups};
  }
  function model(state,semantic,map){
    const m=blank(),owned=new Set((state?.owners||[]).map(e=>e.key));
    if(semantic)O.putAll(m,[...O.rows(semantic)].filter(([k])=>!owned.has(k)).map(([,c])=>c));
    O.putAll(m,[...map.values()].filter(o=>!o.facts?.suspendedReason).flatMap(o=>o.definition.cards||[]));return m;
  }
  function provenance(o){return o.definition.independent||{from:o.definition.generator||o.kind,definition:copy(o.definition)};}
  function frozen(o){
    const d=o.definition;
    return {...copy(o),definition:{generator:o.kind==='mesh'?P.COPY:GENERATOR,independent:provenance(o),cards:copy(d.cards||[]),...(d.layout?{layout:copy(d.layout)}:{}),...(d.part?{part:d.part}:{}),...(d.nodeFrames?{nodeFrames:copy(d.nodeFrames).map(({source,...b})=>b)}:{}),...(d.analysisExcluded?{analysisExcluded:copy(d.analysisExcluded)}:{})}};
  }
  // Names, owner IDs, card roles and allocations do not change on detachment.
  function independent(state,id,semantic){
    const map=catalog(state),o=map.get(id);if(!o)throw Error('Select an object to make independent.');
    if(A.isTemplate(map.get(o.definition.template))&&o.definition.generator===A.CONNECTION){const request=A.detach(state,id);return {...request,objects:request.objects.map(x=>x.id===id?{...x,definition:{...x.definition,independent:provenance(o)}}:x)};}
    if(P.isInstance(o)){
      const request=P.makeUnique(state,id);
      for(const x of request.objects){x.definition.independent=provenance(map.get(x.id)||o);if(x.definition.generator===P.COPY)x.definition={...frozen(x).definition,part:id+'/unique'};}
      return request;
    }
    if(o.kind==='region'){
      const ids=o.definition.ids||o.definition.resolved?.nodes||[],entity=o.definition.entity||'node',original=copy(o);
      original.definition={generator:R.GENERATOR,entity,ids,cards:[],independent:provenance(o)};
      const s={...state,project:{...state.project,objects:objects(state).map(x=>({...copy(x.id===id?original:x),facts:{...x.facts,suspendedReason:null}}))}};
      const retained=model(state,semantic,catalog(s));
      const r=R.build({id,name:o.name,entity,ids},s,retained).objects[0];r.facts=copy(o.facts||{});r.definition.independent=provenance(o);return {label:'Make '+o.name+' independent',objects:[r]};
    }
    return {label:'Make '+o.name+' independent',objects:[frozen(o)]};
  }
  function bind(state,semantic,map,o,context=null){
    const own=new Set((o.definition.cards||[]).map(key)),owners=context?.owners||new Map([...map.values()].flatMap(x=>(x.definition.cards||[]).map(c=>[key(c),x.id])));
    const refs=context?.refs||O.references(model(state,semantic,map)),deps=new Set(),missing=[];
    for(const r of refs.refs)if(own.has(r.from)){if(!refs.cards.has(r.to))missing.push(r.to);const owner=owners.get(r.to);if(owner&&owner!==o.id)deps.add(owner);}
    // Suspended objects' cards are absent from the active model. Index their
    // retained cards separately to explain missing geometry and permit repair.
    if(o.facts?.suspendedReason){const retained=blank();O.putAll(retained,o.definition.cards||[]);for(const r of O.references(retained).refs)if(!own.has(r.to)){if(!refs.cards.has(r.to))missing.push(r.to);const owner=owners.get(r.to);if(owner&&owner!==o.id)deps.add(owner);}}
    if(o.kind==='region')for(const b of o.definition.bindings||[]){const k=b.kind+':'+b.id;if(!refs.cards.has(k))missing.push(k);if(owners.get(k)&&owners.get(k)!==o.id)deps.add(owners.get(k));}
    if(o.definition.generator==='static-case-v1')for(const k of ['load:'+o.definition.load,'constraint:'+o.definition.support]){if(!refs.cards.has(k))missing.push(k);if(owners.get(k))deps.add(owners.get(k));}
    if(o.definition.part&&map.has(o.definition.part))deps.add(o.definition.part);
    for(const b of o.definition.nodeFrames||[])if(b.frame&&map.has(b.frame))deps.add(b.frame);
    return {dependsOn:[...deps],missing:[...new Set(missing)]};
  }
  function build(state,{id,mode='keep',choices={},cleanup=true},semantic){
    if(!['keep','delete'].includes(mode)||Object.values(choices).some(v=>!['keep','delete'].includes(v)))throw Error('Choose Keep or Delete.');
    const info=describe(state,id),old=catalog(state),map=new Map(old),removed=new Set(info.selected),changed=new Map(),retained=new Set();
    for(const g of info.dependents)for(const member of g.members)((choices[g.id]||mode)==='delete'?removed:retained).add(member);
    for(const oid of removed)retained.delete(oid);
    // Detach instances and recipes while their original inputs still exist.
    let working=state;
    for(const g of info.dependents)if(retained.has(g.id)&&(P.isInstance(old.get(g.id))||old.get(g.id).definition.generator===A.CONNECTION&&removed.has(old.get(g.id).definition.template))){
      const request=independent(working,g.id,semantic);for(const o of request.objects){map.set(o.id,o);changed.set(o.id,o);}for(const oid of request.removeObjects||[]){removed.add(oid);retained.delete(oid);map.delete(oid);}working={...state,project:{...state.project,objects:[...map.values()]}};
    }
    // Snapshot remaining affected definitions. The original recipe remains as
    // provenance; current cards stay named and owned, never anonymous hand cards.
    for(const oid of retained){const original=old.get(oid);if(!original||changed.has(oid))continue;let o;
      if(original.kind==='region')o=independent(state,oid,semantic).objects[0];
      else if(['static-case-v1','rectangular-frame-v1'].includes(original.definition.generator)){o=copy(original);o.definition.independent=provenance(original);delete o.definition.assemblyMember;}
      else o=frozen(original);
      if(o.kind==='mesh'){const ids=new Set((o.definition.cards||[]).filter(c=>c.family==='elems').map(c=>c.id));const exclusions=[...old.values()].filter(x=>x.definition.partSource).flatMap(x=>x.definition.analysisExcluded||[]).filter(e=>ids.has(e.id));o.definition.analysisExcluded=[...new Map([...(o.definition.analysisExcluded||[]),...exclusions].map(e=>[e.id,e])).values()];}
      changed.set(oid,o);map.set(oid,o);
    }
    // Keep detached recipe materializations parameterized; they already had a
    // public independent recipe action applied above.
    for(const oid of removed)map.delete(oid);
    for(const o of changed.values()){
      if(o.definition.part&&!map.has(o.definition.part))delete o.definition.part;
      if(o.kind==='mesh'&&!o.definition.part){const parent=info.root.id+'/retained-meshes';if(old.has(parent)&&!P.isPart(old.get(parent)))throw Error('Retained mesh part identity is in use.');if(!map.has(parent)){const p={id:parent,name:info.root.name+' · Independent meshes',kind:'part',dependsOn:[],definition:{generator:P.PART,source:null,cards:[]}};map.set(parent,p);changed.set(parent,p);}o.definition.part=parent;}
      o.dependsOn=(o.dependsOn||[]).filter(d=>map.has(d));
    }
    const snapshots=[...changed.values()].filter(o=>o.definition.independent||o.definition.generator==='static-case-v1');
    // All remaining affected objects are explicit definitions. Infer necessary
    // references and suspend to a fixed point so no active card can dangle.
    let again=true;while(again){again=false;const context={refs:O.references(model(state,semantic,map)),owners:new Map([...map.values()].flatMap(x=>(x.definition.cards||[]).map(c=>[key(c),x.id])))};for(const o of snapshots){
      const b=bind(state,semantic,map,o,context),parents=b.dependsOn.filter(id=>map.get(id)?.facts?.suspendedReason);
      if(o.definition.generator===A.CONNECTION)continue;
      o.dependsOn=b.dependsOn;
      if((b.missing.length||parents.length)&&!o.facts?.suspendedReason){o.facts={...o.facts,suspendedReason:'Deletion removed required inputs. Repair '+(b.missing.join(', ')||parents.map(id=>map.get(id).name).join(', '))+'.'};again=true;}
    }}
    if(cleanup){
      const candidates=new Set();for(const oid of removed){const o=old.get(oid);if(o?.kind==='mesh')for(const x of old.values())if(['material','section'].includes(x.kind)&&x.id.startsWith(oid+'/'))candidates.add(x.id);for(const dep of o?.dependsOn||[])if(['material','section'].includes(old.get(dep)?.kind))candidates.add(dep);}
      let more=true;while(more){more=false;const used=new Set([...map.values()].flatMap(o=>o.dependsOn||[])),refs=O.references(model(state,semantic,map));for(const oid of candidates){const o=map.get(oid);if(!o||used.has(oid)||(o.definition.cards||[]).some(c=>refs.refs.some(r=>r.to===key(c))))continue;map.delete(oid);changed.delete(oid);removed.add(oid);for(const dep of o.dependsOn||[])if(['material','section'].includes(old.get(dep)?.kind))candidates.add(dep);more=true;}}
    }
    const request={label:'Delete '+info.root.name,objects:[...changed.values()].filter(o=>!removed.has(o.id)),removeObjects:[...removed]};
    return {request,root:info.root,dependents:info.dependents,outcomes:[...removed].filter(id=>!P.isInstance(old.get(id))||!map.has(id+'/unique')).map(id=>({id,name:old.get(id)?.name||id,action:'Delete'})).concat(request.objects.map(o=>({id:o.id,name:o.name,action:o.facts?.suspendedReason?'Keep · repair required':o.definition.independent?'Keep · independent':'Keep',reason:o.facts?.suspendedReason||''})))};
  }
  function edit(state,id,{name,cards},semantic){
    const map=catalog(state),old=map.get(id);if(!old?.definition.independent||!cards||cards.length!==(old.definition.cards||[]).length)throw Error('Select an independent object.');
    if(!name?.trim())throw Error('Enter a name.');
    const o={...copy(old),name:name.trim(),facts:{...old.facts,suspendedReason:null},definition:{...copy(old.definition),cards:copy(cards),nodeFrames:[]}};
    for(let i=0;i<cards.length;i++)if(cards[i].id!==old.definition.cards[i].id||cards[i].role!==old.definition.cards[i].role||cards[i].family!==old.definition.cards[i].family||cards[i].value.type!==old.definition.cards[i].value.type)throw Error('Independent editing preserves card identities.');
    map.set(id,o);const b=bind(state,semantic,map,o);if(b.missing.length)throw Error('Missing inputs: '+b.missing.join(', '));if(b.dependsOn.some(id=>map.get(id)?.facts?.suspendedReason))throw Error('Repair suspended inputs first.');o.dependsOn=b.dependsOn;
    return {label:'Edit '+o.name,objects:[o]};
  }
  return Object.freeze({GENERATOR,rootFor,describe,independent,build,edit});
}));
