/* Explicit mesh regions. Identity is checked independently of numeric membership. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.WebMeshRegions=factory();
}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const GENERATOR='mesh-region-v1',copy=v=>JSON.parse(JSON.stringify(v));
  const canonical=v=>Array.isArray(v)?'['+v.map(canonical)+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k]))+'}':JSON.stringify(v);
  const objects=s=>s?.project.objects||[];
  const isRegion=o=>o?.definition.generator===GENERATOR;
  const isNodeRegion=o=>isRegion(o)&&o.definition.entity==='node';
  function ids(values){
    if(!Array.isArray(values)||!values.length||values.some(n=>!Number.isSafeInteger(n)||n<1||n>2147483647))throw Error('Select one or more positive mesh IDs.');
    return [...new Set(values)].sort((a,b)=>a-b);
  }
  function index(catalog,semantic){
    const rows=new Map(),owners=new Map();
    if(semantic){
      for(const [id,value] of semantic.nodes||[])rows.set('node:'+id,value);
      for(const e of Object.values(semantic.elems||{}).flat())rows.set('element:'+e.eid,e);
    }
    for(const o of catalog.values())if(!o.facts?.suspendedReason)for(const c of o.definition.cards||[]){
      const kind=c.family==='nodes'?'node':c.family==='elems'?'element':null;if(!kind)continue;
      const key=kind+':'+c.id;owners.set(key,{owner:o.id,role:c.role,layout:o.definition.layout?.key??null});
      if(!semantic)rows.set(key,c.value);
    }
    return {rows,owners};
  }
  function shape(kind,value){
    if(kind==='node'){
      if(value.cp||![value.x,value.y,value.z].every(Number.isFinite))throw Error('Mesh regions currently require finite basic-coordinate GRID positions.');
      return {x:value.x,y:value.y,z:value.z,cp:0};
    }
    if(!['CTRIA3','CTRIA6','CQUAD4','CQUAD8','CTETRA','CHEXA','CPENTA','CPYRAM'].includes(value.type)||!value.n?.length)throw Error('Element regions require structural shell or solid elements.');
    return {type:value.type,n:value.n.slice()};
  }
  function build(input,state,semantic){
    const old=objects(state).find(o=>o.id===input.id);
    if(!input.id||!input.name?.trim())throw Error('Enter a region name.');
    if(old&&(!isRegion(old)||old.definition.entity!==input.entity))throw Error('A saved region cannot change entity kind; create another region.');
    if(!['node','element'].includes(input.entity))throw Error('Choose nodes or elements.');
    const selected=ids(input.ids),catalog=new Map(objects(state).map(o=>[o.id,o])),ix=index(catalog,semantic),bindings=new Map();
    function bind(kind,id){
      const key=kind+':'+id,value=ix.rows.get(key);if(!value)throw Error('Missing '+key+'.');
      const binding={kind,id,...(ix.owners.get(key)||{}),shape:shape(kind,value)};bindings.set(key,binding);
      if(kind==='element')for(const n of value.n)bind('node',n);
    }
    for(const id of selected)bind(input.entity,id);
    const o={id:input.id,name:input.name.trim(),kind:'region',dependsOn:[...new Set([...bindings.values()].map(b=>b.owner).filter(Boolean))],definition:{generator:GENERATOR,entity:input.entity,ids:selected,bindings:[...bindings.values()],cards:[]}};
    return {label:(old?'Update ':'Create ')+o.name,objects:[resolve(o,catalog,semantic)]};
  }
  function resolve(object,catalog,semantic){
    const d=object.definition;if(!isRegion(object)||!['node','element'].includes(d.entity))throw Error('Invalid mesh region.');
    const selected=ids(d.ids),ix=index(catalog,semantic),bound=new Map(),fail=message=>{throw Error('Region “'+object.name+'”: '+message+' Repair its selection on the proposed mesh.');};
    for(const b of d.bindings||[]){
      const key=b.kind+':'+b.id;if(bound.has(key)||!['node','element'].includes(b.kind))fail('invalid duplicate entity binding.');
      ids([b.id]);bound.set(key,b);
      const owner=ix.owners.get(key);
      if(b.owner?(owner?.owner!==b.owner||owner.role!==b.role||owner.layout!==(b.layout??null)):!!owner)fail(key+' changed owner or mesh identity.');
      const current=ix.rows.get(key)||(!semantic&&!b.owner?b.shape:null);
      if(!current)fail(key+' is missing.');
      if(canonical(shape(b.kind,current))!==canonical(b.shape))fail(key+' changed geometry or connectivity.');
    }
    const needed=new Set(selected.map(id=>d.entity+':'+id)),nodes=new Set();
    for(const id of selected){const b=bound.get(d.entity+':'+id);if(!b)fail('membership is not bound.');for(const n of d.entity==='node'?[id]:b.shape.n){needed.add('node:'+n);nodes.add(n);}}
    if(needed.size!==bound.size||[...needed].some(k=>!bound.has(k)))fail('entity bindings do not match the region membership.');
    const deps=[...new Set([...bound.values()].map(b=>b.owner).filter(Boolean))];
    if(d.scope){
      const base=catalog.get(d.scope.region),mesh=catalog.get(d.scope.instance+'/mesh'),mapping=new Map(mesh?.definition.mapping?.[d.entity==='node'?'nodes':'elements']||[]);
      const expected=base?.definition.resolved?.[d.entity==='node'?'nodes':'elements']?.map(id=>mapping.get(id));
      if(!expected?.length||expected.some(id=>!id)||canonical(ids(expected))!==canonical(selected))fail('instance membership differs from its source region.');
      deps.push(d.scope.region,d.scope.instance);
    }
    const dependencies=[...new Set(deps)].sort();
    const ns=[...nodes].sort((a,b)=>a-b),points=ns.map(id=>bound.get('node:'+id).shape);
    return {...copy(object),dependsOn:dependencies,definition:{...copy(d),resolved:{nodes:ns,elements:d.entity==='element'?selected:[],centroid:['x','y','z'].map(k=>points.reduce((v,p)=>v+p[k],0)/points.length)},cards:[]}};
  }
  function validate(object,catalog,semantic){
    const resolved=resolve(object,catalog,semantic);
    if(canonical(resolved.definition.resolved)!==canonical(object.definition.resolved)||canonical(resolved.dependsOn)!==canonical([...(object.dependsOn||[])].sort())||object.definition.cards?.length)throw Error(object.name+': inconsistent saved region resolution or dependencies.');
  }
  function rebuild(state,semantic,request){
    const catalog=new Map(objects(state).map(o=>[o.id,o])),changed=new Map((request.objects||[]).map(o=>[o.id,o]));
    for(const [id,o]of changed)catalog.set(id,o);for(const id of [...(request.removeObjects||[]),...(request.convertToPlain||[])])catalog.delete(id);
    const affected=new Set([...changed.keys(),...(request.removeObjects||[]),...(request.convertToPlain||[])]);
    let more=true;while(more){more=false;for(const o of catalog.values())if(!affected.has(o.id)&&o.dependsOn?.some(id=>affected.has(id))){affected.add(o.id);more=true;}}
    for(const o of catalog.values())if(isRegion(o)&&(affected.has(o.id)||o.dependsOn.some(id=>affected.has(id))))changed.set(o.id,resolve(o,catalog,semantic));
    return {...copy(request),objects:[...changed.values()]};
  }
  function remove(state,id){
    const o=objects(state).find(o=>o.id===id);if(!isRegion(o))throw Error('Select a mesh region.');
    const users=objects(state).filter(o=>o.dependsOn.includes(id));if(users.length)throw Error('Repair or remove region users first: '+users.map(o=>o.name).join(', '));
    return {label:'Remove '+o.name,removeObjects:[id]};
  }
  return Object.freeze({GENERATOR,isRegion,isNodeRegion,build,resolve,validate,rebuild,remove});
}));
