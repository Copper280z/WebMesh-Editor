(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./analysis-actions.js'));else root.WebMeshAnalysisRuns=factory(root.WebMeshAnalysisActions);}(typeof globalThis!=='undefined'?globalThis:this,function(A){
  'use strict';
  const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
  async function digest(text){const cryptoApi=typeof crypto!=='undefined'?crypto:require('node:crypto').webcrypto;return [...new Uint8Array(await cryptoApi.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
  function profile(deck,solver,options={}){
    if(!['mystran','vibestran'].includes(solver))throw Error('Select MYSTRAN or Vibestran.');
    if(!/^SOL\s+101\b/m.test(deck)||!/^SUBCASE\s+\d+/m.test(deck))throw Error('Create at least one static analysis case first.');
    if(/(?:^|\n)\s*(?:INCLUDE|ASSIGN|ALTER|DMAP|SYSTEM)\b/i.test(deck))throw Error('Run snapshots require a self-contained deck without executable or external-file directives.');
    const changes=[],lines=[];let bulk=false;
    for(const line of deck.split(/\r?\n/)){
      if(/^\s*BEGIN\s+BULK\s*$/i.test(line)){bulk=true;lines.push(line);continue;}
      if(!bulk||!line.trim()||line.trim().startsWith('$')){lines.push(line);continue;}
      if(/^\s*PARAM\s*,\s*AUTOSPC\s*,/i.test(line)){changes.push('AUTOSPC set explicitly by the run options');continue;}
      if(solver==='mystran'){
        if(/^\s*\+,?\s*$/.test(line)){changes.push('Removed empty continuation');continue;}
        const t=line.split(',');
        if(t[0]==='PSOLID'&&!t[4]){while(t.length<5)t.push('');t[4]='2';changes.push('PSOLID '+t[1]+': explicit integration order 2');}
        for(let i=0;i<t.length;i++)if(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t[i])&&/[.eE]/.test(t[i])){
          const v=Number(t[i]).toPrecision(11).replace(/(\.\d*?[1-9])0+(?=e|$)|\.0+(?=e|$)/,'$1');t[i]=/[.eE]/.test(v)?v:v+'.';if(t[i].length>16)throw Error('MYSTRAN free field exceeds 16 characters.');
        }
        lines.push(t.join(','));
      }else lines.push(line);
    }
    const end=lines.findIndex(l=>/^ENDDATA\s*$/.test(l));if(end<0)throw Error('Missing ENDDATA.');
    lines.splice(end,0,'PARAM,AUTOSPC,'+(options.autospc?'YES':'NO'));
    if(solver==='mystran')changes.unshift('Real fields rounded to 11 significant digits (maximum 16 characters)');
    return{deck:lines.join('\n').trim()+'\n',profile:{id:solver+'-static-v1',solver,autospc:!!options.autospc,transformations:[...new Set(changes)]}};
  }
  function equilibrium(f06,coordinates){
    if(!coordinates)return {status:'not-checked',message:'Balance requires basic-coordinate GRIDs and OLOAD/SPCFORCES output.'};
    const grids=new Map(coordinates),cases=new Map();let current=null,table=null;
    for(const line of f06.split('\n')){
      const found=line.match(/OUTPUT FOR SUBCASE\s+(\d+)/);if(found){current=Number(found[1]);if(!cases.has(current))cases.set(current,{applied:new Map(),reaction:new Map()});table=null;}
      if(/A\s*P\s*P\s*L\s*I\s*E\s*D\s+F\s*O\s*R\s*C\s*E\s*S/.test(line))table='applied';
      if(/S\s*P\s*C\s+F\s*O\s*R\s*C\s*E\s*S/.test(line))table='reaction';
      if(/MAX\*|MIN\*|ABS\*|TOTALS|D\s*I\s*S\s*P\s*L\s*A\s*C\s*E/.test(line))table=null;
      if(table&&current){const f=line.trim().split(/\s+/);if(f.length===8&&/^\d+$/.test(f[0])&&f[1]==='0'){const v=f.slice(2).map(Number);if(v.every(Number.isFinite))cases.get(current)[table].set(Number(f[0]),v);}}
    }
    const reports=[];
    for(const [id,tables] of cases){
      if(!tables.applied.size||!tables.reaction.size)continue;
      const totals={};let valid=true;
      for(const key of ['applied','reaction']){const total=[0,0,0,0,0,0];for(const [nid,v]of tables[key]){const p=grids.get(nid);if(!p){valid=false;break;}const moment=[p[1]*v[2]-p[2]*v[1],p[2]*v[0]-p[0]*v[2],p[0]*v[1]-p[1]*v[0]];for(let i=0;i<6;i++)total[i]+=v[i]+(i>2?moment[i-3]:0);}totals[key]=total;}
      if(!valid)continue;
      const residual=totals.applied.map((v,i)=>v+totals.reaction[i]),passed=residual.every((v,i)=>Math.abs(v)<=1e-5*Math.max(1,Math.abs(totals.applied[i]),Math.abs(totals.reaction[i])));
      reports.push({subcase:id,...totals,residual,passed});
    }
    return {status:reports.length?reports.every(r=>r.passed)?'passed':'failed':'not-checked',cases:reports,message:reports.length?'Sum of applied loads and SPC reactions about the basic origin; tolerance 1e−5 of each resultant (minimum scale 1).':'No complete basic-frame OLOAD/SPCFORCES tables found.'};
  }
  function diagnostics(f06,log,coordinates){
    const text=f06+'\n'+log,epsilon=[...text.matchAll(/EPSILON ERROR ESTIMATE\s*=\s*([\d.Ee+-]+)/g)].map(m=>Number(m[1])),residual=[...log.matchAll(/relative residual.*?=\s*([\d.eE+-]+)/g)].map(m=>Number(m[1]));
    const fatal=text.split('\n').filter(l=>/FATAL ERROR|\bFATAL\b|singular matrix/i.test(l)&&!/(?:0|NO)\s+FATAL|NUMBER OF FATAL.*=\s*0/i.test(l));
    const inaccurate=[...epsilon,...residual].some(x=>!Number.isFinite(x)||Math.abs(x)>1e-8);
    return{epsilon,residual,fatal:fatal.slice(0,30),numericalStatus:fatal.length?'failed':inaccurate?'check-failed':epsilon.length||residual.length?'indicator-passed':'not-reported',equilibrium:equilibrium(f06,coordinates)};
  }
  async function validate(run){
    if(run?.format!=='webmesh-analysis-run'||run.version!==1||typeof run.id!=='string'||!run.id||typeof run.deck!=='string'||typeof run.snapshot?.deck!=='string'||!['mystran','vibestran'].includes(run.profile?.solver)||!Array.isArray(run.cases)||!run.cases.length||!['prepared','queued','running','completed','failed','cancelled'].includes(run.status))throw Error('Invalid analysis run.');
    if(run.cases.some(c=>!Number.isSafeInteger(c.id)||c.id<1||typeof c.name!=='string')||new Set(run.cases.map(c=>c.id)).size!==run.cases.length)throw Error('Invalid run subcases.');
    if(run.result&&(typeof run.result.f06!=='string'||typeof run.result.log!=='string'||!run.result.diagnostics))throw Error('Invalid run result.');
    if(await digest(run.deck)!==run.deckDigest||await digest(run.snapshot.deck+'\0'+canonical(run.snapshot.ownership||null))!==run.modelDigest)throw Error('Analysis run deck or model digest disagrees.');
    if(run.result&&await digest(run.result.f06)!==run.result.digest)throw Error('Analysis run result digest disagrees.');
    const {integrity,...content}=run;if(await digest(canonical(content))!==integrity)throw Error('Analysis run metadata integrity disagrees.');
    return run;
  }
  async function seal(content){const copy=JSON.parse(JSON.stringify(content));delete copy.integrity;return{...copy,integrity:await digest(canonical(copy))};}
  return Object.freeze({canonical,digest,profile,equilibrium,diagnostics,seal,validate});
}));
