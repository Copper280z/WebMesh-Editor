/* Object hierarchy and display membership. No solver mutations or DOM state. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.WebMeshProjectView=factory();
}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const groups=[['parts','Parts'],['regions','Regions'],['definitions','Materials & sections'],['connections','Connections'],['points','Points & frames'],['loads','Loads & supports'],['analyses','Analyses'],['other','Other objects']];
  const category={part:'parts',instance:'parts',mesh:'parts',source:'parts',region:'regions',material:'definitions',section:'definitions',template:'connections',connection:'connections',point:'points',frame:'points',load:'loads',support:'loads',analysis:'analyses'};
  const empty=()=>({nodes:new Set(),elems:new Set(),loads:new Set(),spc:new Set(),coords:new Set(),sources:new Set()});
  const add=(to,from)=>{for(const k of Object.keys(to))for(const id of from[k]||[])to[k].add(id);return to;};
  function nodeIds(e){return [...new Set([...(e.n||e.nodes||[]),e.gn,e.refgrid,...(e.deps||[]),...(e.inds||[]),...(e.groups||[]).flatMap(g=>g.gids||[]),e.g].filter(n=>Number.isInteger(n)&&n>0))];}
  function build(state){
    const objects=state?.project?.objects||[],map=new Map(objects.map(o=>[o.id,o])),entries=new Map(),roots=[];
    const excluded=new Set(objects.flatMap(o=>(o.definition.analysisExcluded||[]).map(e=>e.id)));
    for(const [key,name]of groups){const o={id:'@'+key,name,kind:'group',parent:null,children:[],own:empty(),members:empty()};entries.set(o.id,o);roots.push(o.id);}
    for(const o of objects){const d=o.definition||{};let parent='@'+(category[o.kind]||'other');
      if(d.assemblyMember&&map.has(d.assemblyMember))parent=d.assemblyMember;
      else if(o.kind==='source')parent=objects.find(p=>p.kind==='part'&&p.definition.source===o.id)?.id||parent;
      else if(d.instance&&map.has(d.instance)&&o.kind==='mesh')parent=d.instance;
      else if(d.part&&map.has(d.part)&&['mesh','instance'].includes(o.kind))parent=d.part;
      else if(d.partSource&&map.has(d.partSource))parent=d.partSource;
      else if(d.template&&map.get(d.template)?.kind==='template'&&o.kind==='connection')parent=d.template;
      const own=empty();
      for(const c of d.cards||[]){
        if(c.family==='nodes')own.nodes.add(c.id);
        if(c.family==='elems'||c.family==='masses'){own.elems.add(c.id);for(const n of nodeIds(c.value))own.nodes.add(n);}
        if(c.family==='loads'||c.family==='loadSets')own.loads.add(c.value.sid??c.id);
        if(c.family==='spc'||c.family==='spc1'||c.family==='constraintSets')own.spc.add(c.value.sid??c.id);
        if(c.family==='coords')own.coords.add(c.id);
      }
      if(o.kind==='source')own.sources.add(o.id);
      if(o.kind==='region'){for(const n of d.resolved?.nodes||[])own.nodes.add(n);for(const e of d.resolved?.elements||[])own.elems.add(e);}
      entries.set(o.id,{id:o.id,name:o.name,kind:o.kind,generator:d.generator,parent,children:[],own,members:empty(),reference:!!d.partSource||o.kind==='mesh'&&own.elems.size>0&&[...own.elems].every(id=>excluded.has(id)),sourceDefault:o.kind==='source'&&!objects.some(m=>m.kind==='mesh'&&m.definition.source===o.id),overrides:Object.keys(d.overrides||{}).length});
    }
    for(const e of entries.values())if(e.parent){if(!entries.has(e.parent)||e.parent===e.id)e.parent='@other';entries.get(e.parent).children.push(e.id);}
    const visiting=new Set(),done=new Set();
    function visit(id){const e=entries.get(id);if(done.has(id))return e.members;if(visiting.has(id))return empty();visiting.add(id);add(e.members,e.own);e.children.sort((a,b)=>{const x=entries.get(a),y=entries.get(b),rank=k=>({source:0,mesh:1,instance:2,selection:3}[k]??4);return rank(x.kind)-rank(y.kind)||x.name.localeCompare(y.name,undefined,{numeric:true});});for(const c of e.children)add(e.members,visit(c));visiting.delete(id);done.add(id);return e.members;}
    roots.forEach(visit);
    return {entries,roots:roots.filter(id=>entries.get(id).children.length)};
  }
  function preferences(raw){
    const p={version:1,objects:{},isolate:null};
    if(!raw||typeof raw!=='object')return p;
    for(const [id,value]of Object.entries(raw.objects||{}))if(typeof value==='boolean'&&id!=='__proto__')Object.defineProperty(p.objects,id,{value,enumerable:true,writable:true,configurable:true});
    if(typeof raw.isolate==='string')p.isolate=raw.isolate;
    return p;
  }
  function inherited(index,p,id){const seen=new Set();while(id&&index.entries.has(id)&&!seen.has(id)){seen.add(id);if(Object.hasOwn(p.objects,id))return p.objects[id];id=index.entries.get(id).parent;}return undefined;}
  function setVisibility(index,raw,id,visible){
    if(!index.entries.has(id))throw Error('This object is no longer in the project.');const p=preferences(raw);
    const change=id=>{p.objects[id]=!!visible;index.entries.get(id).children.forEach(change);};change(id);return p;
  }
  function mask(index,raw,semantic={},excluded={elems:[],nodes:[]}){
    const p=preferences(raw),out=empty(),shown=empty(),isolate=index.entries.get(p.isolate),allowed=isolate?.members;
    for(const e of index.entries.values()){
      if(e.kind==='group')continue;const v=inherited(index,p,e.id);
      if(v===false)add(out,e.own);else if(v===true)add(shown,e.own);
      if(e.kind==='source'&&v===undefined&&!e.sourceDefault)out.sources.add(e.id);
    }
    for(const e of excluded.elems||[])if(!shown.elems.has(e))out.elems.add(e);
    for(const n of excluded.nodes||[])if(!shown.nodes.has(n))out.nodes.add(n);
    const elements=[...Object.values(semantic.elems||{}).flat(),...(semantic.masses instanceof Map?[...semantic.masses.values()]:(semantic.masses||[]).map(row=>row[1]))];
    const hiddenNodeCandidates=new Set(out.nodes),used=new Set();
    if(allowed){
      // Node regions isolate their incident elements; element/part isolation
      // keeps only those elements, including their referenced shared nodes.
      const byNodes=!allowed.elems.size&&allowed.nodes.size;
      for(const e of elements)if(!allowed.elems.has(e.eid)&&!(byNodes&&nodeIds(e).some(n=>allowed.nodes.has(n))))out.elems.add(e.eid);else out.elems.delete(e.eid);
      for(const e of index.entries.values())for(const k of ['loads','spc','coords','sources'])for(const id of e.own[k])if(!allowed[k].has(id))out[k].add(id);else out[k].delete(id);
    }
    for(const e of elements){const ns=nodeIds(e);if(out.elems.has(e.eid))ns.forEach(n=>hiddenNodeCandidates.add(n));else ns.forEach(n=>used.add(n));}
    // Hiding a mesh must not hide shared nodes still used by visible elements.
    out.nodes=new Set([...hiddenNodeCandidates].filter(n=>!used.has(n)));
    if(allowed)for(const [n]of semantic.nodes||[])if(!used.has(n)&&!allowed.nodes.has(n))out.nodes.add(n);else out.nodes.delete(n);
    return out;
  }
  function rows(index,raw,maskValue){
    const p=preferences(raw);
    return [...index.entries.values()].map(e=>{let total=0,visible=0;for(const k of ['elems','loads','spc','coords','sources'])for(const id of e.members[k]){total++;if(!maskValue[k].has(id))visible++;}if(!total)for(const id of e.members.nodes){total++;if(!maskValue.nodes.has(id))visible++;}
      return {id:e.id,name:e.name,kind:e.kind,generator:e.generator,parent:e.parent,children:e.children.slice(),nodes:e.members.nodes.size,elements:e.members.elems.size,hasVisual:total>0,visibility:visible===0&&total?'hidden':visible<total?'mixed':'visible',explicit:inherited(index,p,e.id),reference:e.reference,overrides:e.overrides};});
  }
  return Object.freeze({build,preferences,inherited,setVisibility,mask,rows,nodeIds});
}));
