(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.WebMeshAnalysisActions=factory();}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
  const copy=v=>JSON.parse(JSON.stringify(v));
  const id=n=>{if(!Number.isSafeInteger(n)||n<1||n>2147483647)throw Error('Set IDs must be positive 32-bit integers.');return n;};
  function rows(s){
    const loads=new Map(),supports=new Map();
    const add=(map,bucket,v)=>{const sid=id(v.sid);if(!map.has(sid))map.set(sid,[]);map.get(sid).push({bucket,value:copy(v)});};
    for(const bucket of Object.keys(s.loads||{}).sort())for(const v of s.loads[bucket])add(loads,bucket,v);
    for(const bucket of ['spc','spc1'])for(const v of s[bucket]||[])add(supports,bucket,v);
    return [['loadSets','LOADSET',loads],['constraintSets','SUPPORTSET',supports]].flatMap(([family,type,map])=>[...map].map(([sid,entries])=>({family,id:sid,value:{type,sid,entries}})));
  }
  function remove(s,family,sid){if(family==='loadSets'){for(const b of Object.keys(s.loads||{}))s.loads[b]=s.loads[b].filter(v=>v.sid!==sid);}else for(const b of ['spc','spc1'])s[b]=(s[b]||[]).filter(v=>v.sid!==sid);}
  function put(s,c){remove(s,c.family,c.id);for(const e of c.value.entries){if(c.family==='loadSets')((s.loads||={})[e.bucket]||=[]).push(copy(e.value));else(s[e.bucket]||=[]).push(copy(e.value));}}
  function execute(a){
    id(a.sid);let value,bucket,family;
    if(a.action==='acceleration'){
      if(!Array.isArray(a.vector)||a.vector.length!==3||!a.vector.every(Number.isFinite)||!Math.hypot(...a.vector))throw Error('Enter a finite, nonzero acceleration vector in model length/time².');
      value={type:'GRAV',sid:a.sid,cid:0,scale:1,vector:a.vector.slice(),mb:0};bucket='gravity';family='loadSets';
    }else if(a.action==='support'){
      if(!/^[1-6]+$/.test(a.components)||new Set(a.components).size!==a.components.length)throw Error('Support DOFs must be distinct digits 1–6.');
      if(!Array.isArray(a.nodes)||!a.nodes.length||new Set(a.nodes).size!==a.nodes.length)throw Error('Select distinct support GRIDs.');a.nodes.forEach(id);
      value={sid:a.sid,components:a.components,nodes:a.nodes.slice().sort((a,b)=>a-b)};bucket='spc1';family='constraintSets';
    }else throw Error('Unknown analysis action.');
    return {family,id:a.sid,role:'set',value:{type:family==='loadSets'?'LOADSET':'SUPPORTSET',sid:a.sid,entries:[{bucket,value}]}};
  }
  function validateSet(c,kind){
    if(kind!=='load'&&kind!=='support')throw Error('Load/support sets require their own project objects.');
    const entries=c.value?.entries;if(!Array.isArray(entries)||entries.length!==1)throw Error('An authored set requires one explicit action.');
    const e=entries[0],v=e.value,a=c.family==='loadSets'?{action:'acceleration',sid:c.id,vector:v.vector}:{action:'support',sid:c.id,nodes:v.nodes,components:v.components};
    const expected=execute(a);
    if(kind!==(c.family==='loadSets'?'load':'support')||canonical(expected.value)!==canonical(c.value))throw Error('Invalid authored load/support set.');
  }
  function number(t){const s=String(t??'').trim().replace(/d/i,'e').replace(/([\d.])([+-]\d+)$/,'$1e$2');const n=Number(s);if(!Number.isFinite(n))throw Error('Invalid Nastran numeric value: '+t);return n;}
  function gravityCards(cards){return(cards||[]).filter(c=>c.kind==='card'&&c.name==='GRAV').map(c=>{const t=c.tokens;return{type:'GRAV',sid:id(number(t[1])),cid:number(t[2]||0),scale:number(t[3]),vector:[4,5,6].map(i=>number(t[i]||0)),mb:number(t[7]||0)};});}
  function validateCases(state,s){
    const sets=rows(s),cases=(state?.project.objects||[]).filter(o=>o.definition.generator==='static-case-v1'),used=new Set();
    for(const o of cases){const d=o.definition;id(d.subcase);if(used.has(d.subcase))throw Error('Duplicate analysis subcase '+d.subcase+'.');used.add(d.subcase);
      for(const [family,key] of [['loadSets','load'],['constraintSets','support']])if(!sets.some(c=>c.family===family&&c.id===d[key]))throw Error(o.name+': missing '+key+' set '+d[key]+'.');
      if(!o.name||/[^\x20-\x7e]/.test(o.name)||o.name.length>65)throw Error('Case names must be one line of ASCII text, up to 65 characters.');
      if(!Array.isArray(d.outputs)||!d.outputs.length||d.outputs.some(v=>!['DISPLACEMENT','SPCFORCES','STRESS','OLOAD','FORCE'].includes(v)))throw Error(o.name+': unsupported output request.');
    }
  }
  return Object.freeze({rows,remove,put,execute,validateSet,gravityCards,validateCases,number});
}));
