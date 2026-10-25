(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./analysis-actions.js'),require('./attachment-project.js'),require('./coordinate-project.js'));else root.WebMeshAnalysisProject=factory(root.WebMeshAnalysisActions,root.WebMeshAttachmentProject,root.WebMeshCoordinates);}(typeof globalThis!=='undefined'?globalThis:this,function(A,Mount,F){
  'use strict';
  const SET='analysis-set-v1',CASE='static-case-v1',copy=v=>JSON.parse(JSON.stringify(v)),objects=s=>s?.project.objects||[],map=s=>new Map(objects(s).map(o=>[o.id,o]));
  function existing(input,state,generator){const old=map(state).get(input.id);if(!input.id||!input.name?.trim())throw Error('Enter a name.');if(old&&old.definition.generator!==generator)throw Error('This identity belongs to another object.');return old;}
  function resolve(o,catalog){
    const d=copy(o.definition),a=d.action;let dependsOn=[];
    if(d.frame)dependsOn.push(d.frame);
    if(a.action!=='support')a.cid=F.frame({project:{objects:[...catalog.values()]}},d.frame).cid;
    if(a.action==='support'||a.action==='force'){
      if(d.region){const region=catalog.get(d.region);if(region?.definition.generator!==Mount.REGION&&!(region?.definition.generator==='mesh-region-v1'&&region.definition.entity==='node'))throw Error(o.name+': mounting region is missing.');const r=Mount.resolveRegion(region,catalog);a.nodes=r.definition.resolved.nodes;dependsOn.push(d.region,...r.dependsOn);}
      else for(const source of d.sources||[]){const owner=catalog.get(source.owner),card=owner?.definition.cards.find(c=>c.family==='nodes'&&c.id===source.id&&c.role===source.role);if(!card)throw Error(o.name+': selected GRID '+source.id+' was replaced. Repair this GRID selection first.');dependsOn.push(source.owner);}
      for(const parent of catalog.values())if((parent.definition.cards||[]).some(c=>c.family==='nodes'&&(a.action==='force'?[a.node]:a.nodes).includes(c.id)))dependsOn.push(parent.id);
    }
    return {...copy(o),dependsOn:[...new Set(dependsOn)],definition:{...d,cards:[A.execute(a)],actions:[copy(a)]}};
  }
  function set(input,state,semantic){
    const old=existing(input,state,SET),family=input.action==='support'?'constraintSets':'loadSets',ns=input.action==='support'?'constraint':'load';
    const sid=old?.definition.action.sid||Math.max(0,...A.rows(semantic).filter(c=>c.family===family).map(c=>c.id),...(state?.project.reservations||[]).filter(r=>r.namespace===ns).map(r=>r.end))+1;
    const action={action:input.action,sid,...(input.action==='support'?{components:input.components,nodes:input.nodes||[]}:{vector:input.vector,...(input.action==='force'?{node:input.node}:{})})};
    const sources=[],inputs=[],catalog=map(state),nodes=new Map(semantic.nodes);
    if(['support','force'].includes(input.action)&&!input.region)for(const n of (input.action==='force'?[input.node]:input.nodes||[])){if(!nodes.has(n))throw Error('Missing '+input.action+' GRID '+n+'.');const owner=objects(state).find(o=>(o.definition.cards||[]).some(c=>c.family==='nodes'&&c.id===n));if(owner)sources.push({id:n,owner:owner.id,role:owner.definition.cards.find(c=>c.family==='nodes'&&c.id===n).role});else inputs.push({key:'node:'+n,card:{family:'nodes',id:n,value:copy(nodes.get(n))}});}
    const object={id:input.id,name:input.name.trim(),kind:input.action==='support'?'support':'load',definition:{generator:SET,action,...(input.frame!==undefined?{frame:input.frame||null}:{}),region:input.region||null,sources,inputs,cards:[]}};
    const resolved=resolve(object,catalog),request={label:(old?'Update ':'Create ')+object.name,objects:[resolved]};
    if(input.action==='support'&&input.frame!==undefined){const assigned=F.assign({nodes:resolved.definition.action.nodes,frame:input.frame,source:input.id},state);request.objects.unshift(...assigned.objects);}
    return request;
  }
  function caseObject(input,state,semantic){
    const old=existing(input,state,CASE),subcase=old?.definition.subcase||Math.max(0,...objects(state).filter(o=>o.definition.generator===CASE).map(o=>o.definition.subcase))+1;
    const dependsOn=objects(state).filter(o=>(o.definition.cards||[]).some(c=>c.family==='loadSets'&&c.id===input.load||c.family==='constraintSets'&&c.id===input.support)).map(o=>o.id);
    const o={id:input.id,name:input.name.trim(),kind:'analysis',dependsOn,definition:{generator:CASE,subcase,load:input.load,support:input.support,outputs:input.outputs,cards:[]}};
    A.validateCases({project:{objects:[...objects(state).filter(o=>o.id!==input.id),o]}},semantic);return{label:(old?'Update ':'Create ')+o.name,objects:[o]};
  }
  function rebuild(state,request){
    const catalog=map(state),changed=new Map((request.objects||[]).map(o=>[o.id,o])),affected=new Set([...changed.keys(),...(request.removeObjects||[]),...(request.convertToPlain||[])]);
    for(const [id,o]of changed)catalog.set(id,o);for(const id of [...(request.removeObjects||[]),...(request.convertToPlain||[])])catalog.delete(id);
    let again=true;while(again){again=false;for(const o of catalog.values())if(!affected.has(o.id)&&o.dependsOn?.some(id=>affected.has(id))){affected.add(o.id);again=true;}}
    for(const o of catalog.values())if(affected.has(o.id)){if(o.definition.generator===SET){const next=resolve(o,catalog);changed.set(o.id,next);catalog.set(o.id,next);}else if(o.definition.generator===CASE)changed.set(o.id,copy(o));}
    return{...copy(request),objects:[...changed.values()]};
  }
  function catalog(state,semantic){return A.rows(semantic).map(c=>{const o=objects(state).find(o=>(o.definition.cards||[]).some(v=>v.family===c.family&&v.id===c.id));return{...c,name:o?.name||((c.family==='loadSets'?'Load':'Support')+' set '+c.id),owner:o?.id||null};});}
  function remove(state,id){const users=objects(state).filter(o=>o.dependsOn.includes(id));if(users.length)throw Error('Resolve dependent objects first: '+users.map(o=>o.name).join(', '));return{label:'Remove '+map(state).get(id).name,removeObjects:[id]};}
  function caseControl(state){return objects(state).filter(o=>!o.facts?.suspendedReason&&o.definition.generator===CASE).sort((a,b)=>a.definition.subcase-b.definition.subcase).map(o=>{const d=o.definition;return'SUBCASE '+d.subcase+'\n  LABEL = '+o.name+'\n  LOAD = '+d.load+'\n  SPC = '+d.support+'\n'+d.outputs.map(v=>'  '+v+' = ALL').join('\n');}).join('\n');}
  function projectDeck(deck,state){const control=caseControl(state);if(!control&&!objects(state).some(o=>o.definition.generator===CASE))return deck;const bulk=deck.match(/(?:^|\n)\s*BEGIN\s+BULK\s*\n/i);if(!bulk)throw Error('Cannot find BEGIN BULK in the exported deck.');return'SOL 101\nCEND\n'+control+'\nBEGIN BULK\n'+deck.slice(bulk.index+bulk[0].length);}
  return Object.freeze({SET,CASE,set,caseObject,rebuild,catalog,remove,caseControl,projectDeck});
}));
