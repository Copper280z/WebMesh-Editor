/* Reusable assemblies compose the same attachment, point, mass and rigid actions
 * exposed in the workspaces. No live engine mutation occurs here. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./attachment-project.js'),require('./connection-actions.js'),require('./coordinate-project.js'),require('./part-project.js'));else root.WebMeshAssembly=factory(root.WebMeshAttachmentProject,root.WebMeshConnectionActions,root.WebMeshCoordinates,root.WebMeshParts);}(typeof globalThis!=='undefined'?globalThis:this,function(M,A,F,Parts){
  'use strict';
  const TEMPLATE='assembly-recipe-v1',CONNECTION='assembly-connection-v1',copy=v=>JSON.parse(JSON.stringify(v));
  const canonical=v=>Array.isArray(v)?'['+v.map(canonical)+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k]))+'}':JSON.stringify(v);
  const equal=(a,b)=>canonical(a)===canonical(b),catalog=s=>new Map((s?.project.objects||[]).map(o=>[o.id,o]));
  const keys=['mount','shaft','mass','massOffset','components','stiffness'];
  const defaults=()=>({mount:[0,0,0],shaft:[20,0,0],mass:0,massOffset:[-20,0,0],components:'123',stiffness:[1e5,1e5,1e5,1e6,1e6,1e6]});
  const isTemplate=o=>o?.definition.recipe?.generator===TEMPLATE;
  function parameters(raw,state){
    if(Object.keys(raw).some(k=>!keys.includes(k)))throw Error('Unknown connection recipe parameter.');
    const p={...defaults(),...copy(raw)},units=state?.project.units||{mass:'t',length:'mm'};
    for(const k of ['mount','shaft','massOffset']){if(!Array.isArray(p[k])||p[k].length!==3)throw Error(k+' requires XYZ values.');p[k]=p[k].map(v=>A.quantity(v,'length',units));}
    p.mass=A.quantity(p.mass,'mass',units);if(p.mass<0)throw Error('Mass must be nonnegative; zero omits the mass.');
    if(!/^[1-3]+$/.test(p.components)||new Set(p.components).size!==p.components.length)throw Error('Use distinct dependent translation components 1–3.');
    M.template({id:'validation',name:'Recipe',stiffness:p.stiffness},null,{property:1});
    if(!Math.hypot(...p.mount.map((v,i)=>v-p.shaft[i])))throw Error('Mount and shaft points must be distinct.');return p;
  }
  function template(input,state,ids){
    const old=catalog(state).get(input.id);if(old&&!isTemplate(old))throw Error('Select a connection recipe.');
    const p=parameters(input.parameters,state),t=M.template({id:input.id,name:input.name,stiffness:p.stiffness},state,ids);
    t.definition.recipe={generator:TEMPLATE,parameters:p};return{label:(old?'Update ':'Create ')+t.name,objects:[t]};
  }
  function nextIds(state,map,ids={}){
    const result={node:ids.node||1,element:ids.element||1,property:ids.property||1,coordinate:ids.coordinate||1};
    for(const r of state?.project.reservations||[])if(r.namespace in result)result[r.namespace]=Math.max(result[r.namespace],r.end+1);
    for(const o of map.values())for(const c of o.definition.cards||[]){const ns={nodes:'node',elems:'element',masses:'element',properties:'property',coords:'coordinate'}[c.family];if(ns)result[ns]=Math.max(result[ns],c.id+1);}return result;
  }
  function resolve(root,map,state,ids){
    const d=root.definition,t=map.get(d.template);if(!isTemplate(t)||t.facts?.suspendedReason)throw Error(root.name+': connection recipe is missing or suspended.');
    const overrides=d.overrides||{};if(Object.keys(overrides).some(k=>!keys.includes(k)))throw Error('Unknown connection override.');
    const p=parameters({...t.definition.recipe.parameters,...overrides},state),localState={...state,project:{...state?.project,objects:[...map.values()]}},children=[],identities=copy(d.identities||{});
    let point=v=>v.slice(),direction=v=>v.slice(),frame=d.frame||null;
    if(d.placement&&d.frame)throw Error('Choose a live placement or a frame, not both.');
    if(d.placement){
      const placement=map.get(d.placement);if(!Parts.isInstance(placement)||placement.facts?.suspendedReason)throw Error('Select an active live placement.');
      const transform=Parts.transform(placement.definition.transform);point=transform.point;const origin=point([0,0,0]);direction=v=>point(v).map((x,i)=>x-origin[i]);
      frame=root.id+'/frame';const built=F.build({id:frame,name:root.name+' · Stiffness directions',origin,zAxisPt:point([0,0,1]),xzPlanePt:point([1,0,0])},localState,{coordinate:identities.coordinate||ids.coordinate});
      const f=built.objects[0];identities.coordinate=f.definition.cards[0].id;children.push(f);map.set(f.id,f);
    }else if(frame){const f=F.frame(localState,frame),origin=map.get(frame).definition.cards[0].value.origin;direction=v=>F.vector(v,f.axes);point=v=>direction(v).map((x,i)=>x+origin[i]);}
    let stiffness=t.id;
    if(Object.hasOwn(overrides,'stiffness')){const privateId=root.id+'/stiffness',property=M.template({id:privateId,name:root.name+' · Stiffness override',stiffness:p.stiffness},localState,{property:identities.property||ids.property});identities.property=property.definition.cards[0].id;children.push(property);map.set(property.id,property);stiffness=property.id;}
    // Adapt this recipe's owned attachment to the public attachment action.
    const alias={...copy(root),definition:{...copy(d),generator:M.ATTACHMENT,points:root.id+'/points',cards:(d.cards||[]).filter(c=>['mount','bush'].includes(c.role))}};
    if(alias.definition.cards.length)map.set(root.id,alias);else map.delete(root.id);
    const built=M.attachment({id:root.id,name:root.name,region:d.region,mount:point(p.mount),shaft:point(p.shaft),components:p.components,template:stiffness,frame},{...state,project:{...state?.project,objects:[...map.values()]}},ids);
    const points=built.objects.find(o=>o.kind==='point'),attachment=built.objects.find(o=>o.kind==='connection');const priorPoints=map.get(points.id);
    if(priorPoints?.definition.nodeFrames){points.definition.nodeFrames=copy(priorPoints.definition.nodeFrames);for(const b of points.definition.nodeFrames){const c=points.definition.cards.find(c=>c.role===b.role);if(c)c.value.cd=F.frame(localState,b.frame).cid;}}
    children.push(points);map.set(points.id,points);
    const mount=points.definition.cards.find(c=>c.role==='mount').id,shaft=points.definition.cards.find(c=>c.role==='shaft').id;
    let eid=Math.max(ids.element,...attachment.definition.cards.map(c=>c.id+1)),steps=[],extraDeps=[];
    if(p.mass){identities.mass=identities.mass||eid++;steps.push({action:'mass',id:identities.mass,node:mount,mass:p.mass,offset:direction(p.massOffset),inertia:[0,0,0,0,0,0],role:'mass'});}
    if(d.drivenRegion){const raw=map.get(d.drivenRegion);if(!raw)throw Error(root.name+': driven region is missing.');const region=M.resolveRegion(raw,map);identities.driven=identities.driven||eid++;steps.push({action:'rbe2',id:identities.driven,node:shaft,components:p.components,nodes:region.definition.resolved.nodes,role:'driven'});extraDeps.push(region.id,...region.dependsOn);}
    const grids=[...map.values()].flatMap(o=>(o.definition.cards||[]).filter(c=>c.family==='nodes').map(c=>({id:c.id,...c.value}))),generated=A.execute(grids,steps);
    const extraNodes=new Set(steps.flatMap(s=>s.nodes||[]));for(const o of map.values())if(o.definition.cards?.some(c=>c.family==='nodes'&&extraNodes.has(c.id)))extraDeps.push(o.id);
    for(const c of children){c.definition.assemblyMember=root.id;if(c.kind==='point')c.dependsOn=[...new Set([...(d.placement?[d.placement]:[]),...(d.frame?[d.frame]:[]),...(c.definition.nodeFrames||[]).map(b=>b.frame).filter(Boolean)])];}
    const result={...copy(root),dependsOn:[...new Set([...attachment.dependsOn,...extraDeps,t.id,...(d.placement?[d.placement]:[])])],definition:{...copy(d),points:points.id,identities,resolved:p,actions:[{action:'attachment',region:d.region,mount:point(p.mount),shaft:point(p.shaft),components:p.components,template:stiffness,frame},...generated.actions],cards:[...attachment.definition.cards,...generated.cards]}};
    return [...children,result];
  }
  function connection(input,state,ids){
    const map=catalog(state),old=map.get(input.id);if(!input.id||!input.name?.trim()||old&&old.definition.generator!==CONNECTION)throw Error('Enter a connection name and valid identity.');
    const t=map.get(input.template);if(!isTemplate(t))throw Error('Select a connection recipe.');
    const overrides=copy(input.overrides||{}),p=parameters({...t.definition.recipe.parameters,...overrides},state);for(const key of Object.keys(overrides))overrides[key]=p[key];
    const root={id:input.id,kind:'connection',name:input.name.trim(),definition:{generator:CONNECTION,template:input.template,region:input.region,drivenRegion:input.drivenRegion||null,placement:input.placement||null,frame:input.frame||null,overrides,identities:old?.definition.identities||{},cards:old?.definition.cards||[]}};
    return rebuild(state,{label:(old?'Update ':'Create ')+root.name,objects:[root]},ids);
  }
  function rebuild(state,request,ids={}){
    const map=catalog(state),changed=new Map((request.objects||[]).map(o=>[o.id,copy(o)])),removed=new Set(request.removeObjects||[]),converted=new Set(request.convertToPlain||[]);
    for(const [id,o]of changed)map.set(id,o);for(const id of [...removed,...converted])map.delete(id);
    const affected=new Set([...changed.keys(),...removed,...converted]);let more=true;while(more){more=false;for(const o of map.values())if(!affected.has(o.id)&&o.dependsOn?.some(id=>affected.has(id))){affected.add(o.id);more=true;}}
    for(const root of [...map.values()])if(root.definition.generator===CONNECTION&&affected.has(root.id)){
      const generated=resolve(root,new Map(map),state,nextIds(state,map,ids)),members=new Set(generated.map(o=>o.id));
      for(const o of map.values())if(o.definition.assemblyMember===root.id&&!members.has(o.id)){removed.add(o.id);map.delete(o.id);changed.delete(o.id);}
      for(const o of generated){map.set(o.id,o);changed.set(o.id,o);}
    }
    return{...copy(request),objects:[...changed.values()],removeObjects:[...removed]};
  }
  function rootFor(state,id){const map=catalog(state),o=map.get(id);return o?.definition.assemblyMember?map.get(o.definition.assemblyMember):o;}
  function remove(state,id){const map=catalog(state),root=rootFor(state,id);if(!root||!isTemplate(root)&&root.definition.generator!==CONNECTION)throw Error('Select an assembly connection or recipe.');const ids=[root.id,...[...map.values()].filter(o=>o.definition.assemblyMember===root.id).map(o=>o.id)],users=[...map.values()].filter(o=>!ids.includes(o.id)&&o.dependsOn?.some(id=>ids.includes(id)));if(users.length)throw Error('Resolve dependent objects first: '+users.map(o=>o.name).join(', '));return{label:'Remove '+root.name,removeObjects:ids};}
  function detach(state,id,ids={}){
    const root=rootFor(state,id);if(root?.definition.generator!==CONNECTION)throw Error('Select a recipe connection.');
    const map=catalog(state),key=root.id+'/recipe';if(map.has(key))throw Error('This connection already has its independent recipe.');
    const t=template({id:key,name:root.name+' · Independent recipe',parameters:root.definition.resolved},state,nextIds(state,map,ids)).objects[0];t.definition.recipe.detachedFrom=root.definition.template;
    const o=copy(root);o.definition.template=key;o.definition.overrides={};return rebuild(state,{label:'Make '+root.name+' independent',objects:[t,o]},ids);
  }
  function validate(o,map){
    if(isTemplate(o)){const p=parameters(o.definition.recipe.parameters);if(!equal(p,o.definition.recipe.parameters)||!equal(p.stiffness,[1,2,3,4,5,6].map(i=>o.definition.cards[0].value['K'+i])))throw Error('Recipe and shared stiffness disagree.');}
    if(o.definition.assemblyMember&&map.get(o.definition.assemblyMember)?.definition.generator!==CONNECTION)throw Error('Assembly member has no connection recipe.');
    if(o.definition.generator!==CONNECTION)return;
    const state={project:{objects:[...map.values()],reservations:[]}},expected=resolve(o,new Map(map),state,nextIds(state,map));
    for(const e of expected){const actual=map.get(e.id);if(!actual||!equal(e.definition,actual.definition)||!equal([...e.dependsOn||[]].sort(),[...actual.dependsOn||[]].sort()))throw Error(o.name+': generated connection disagrees with its recipe. Edit the recipe or an explicit override.');}
    if([...map.values()].some(c=>c.definition.assemblyMember===o.id&&!expected.some(e=>e.id===c.id)))throw Error('Unexpected assembly member.');
  }
  return Object.freeze({TEMPLATE,CONNECTION,defaults,isTemplate,template,connection,rebuild,rootFor,remove,detach,validate});
}));
