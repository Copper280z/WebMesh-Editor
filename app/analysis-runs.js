(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./analysis-actions.js'));else root.WebMeshAnalysisRuns=factory(root.WebMeshAnalysisActions);}(typeof globalThis!=='undefined'?globalThis:this,function(A){
  'use strict';
  const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
  async function digest(text){const cryptoApi=typeof crypto!=='undefined'?crypto:require('node:crypto').webcrypto;return [...new Uint8Array(await cryptoApi.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
  function profile(deck,solver,options={}){
    if(!['mystran','vibestran'].includes(solver))throw Error('Select MYSTRAN or Vibestran.');
    if(!/^SOL\s+101\b/m.test(deck)||!/^SUBCASE\s+\d+/m.test(deck))throw Error('Create at least one static analysis case first.');
    if(/(?:^|\n)\s*(?:INCLUDE|ASSIGN|ALTER|DMAP|SYSTEM)\b/i.test(deck))throw Error('Run snapshots require a self-contained deck without executable or external-file directives.');
    const changes=[],lines=[],source=deck.split(/\r?\n/);let bulk=false;
    for(let lineIndex=0;lineIndex<source.length;lineIndex++){
      const line=source[lineIndex];
      if(/^\s*BEGIN\s+BULK\s*$/i.test(line)){bulk=true;lines.push(line);continue;}
      if(!bulk||!line.trim()||line.trim().startsWith('$')){lines.push(line);continue;}
      if(/^\s*PARAM\s*,\s*AUTOSPC\s*,/i.test(line)){changes.push('AUTOSPC set explicitly by the run options');continue;}
      if(solver==='mystran'){
        if(/^\s*\+,?\s*$/.test(line)){changes.push('Removed empty continuation');continue;}
        const t=line.split(',');
        if(t[0]==='SPC1'){
          const fields=t.slice(3);while(/^\s*\+,/.test(source[lineIndex+1]||''))fields.push(...source[++lineIndex].split(',').slice(1));
          const nodes=[];for(let i=0;i<fields.length;i++){if(!fields[i].trim())continue;const start=Number(fields[i]);if(!Number.isSafeInteger(start)||start<1)throw Error('Invalid SPC1 GRID in solver input.');
            if(fields[i+1]?.trim().toUpperCase()==='THRU'){const end=Number(fields[i+2]);if(!Number.isSafeInteger(end)||end<start||end-start>1000000)throw Error('Invalid SPC1 THRU range.');for(let n=start;n<=end;n++)nodes.push(n);i+=2;}else nodes.push(start);
          }
          if(!nodes.length)throw Error('SPC1 requires support nodes.');for(const n of new Set(nodes))lines.push(['SPC1',t[1],t[2],n].join(','));changes.push('SPC1 memberships expanded into explicit GRID entries');continue;
        }
        if(t[0]==='CBUSH'&&t[8]?.trim()){t[5]=t[6]=t[7]='';changes.push('CBUSH uses its explicit CID without a redundant orientation vector');}

        if(t[0]==='PSOLID'&&!t[4]){while(t.length<5)t.push('');t[4]='2';changes.push('PSOLID '+t[1]+': explicit integration order 2');}
        for(let i=0;i<t.length;i++)if(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t[i])&&/[.eE]/.test(t[i])){
          const n=Number(t[i]);if(!Number.isFinite(n))throw Error('Nonfinite solver field.');
          const trim=v=>v.replace(/(\.\d*?[1-9])0+(?=e|$)|\.0+(?=e|$)/,'$1');
          let v=trim(n.toPrecision(11));v=/[.eE]/.test(v)?v:v+'.';
          for(let digits=10;v.length>16&&digits>=0;digits--)v=trim(n.toExponential(digits));
          if(v.length>16)throw Error('MYSTRAN free field exceeds 16 characters.');t[i]=v;
        }
        lines.push(t.join(','));
      }else lines.push(line);
    }
    const end=lines.findIndex(l=>/^ENDDATA\s*$/.test(l));if(end<0)throw Error('Missing ENDDATA.');
    lines.splice(end,0,'PARAM,AUTOSPC,'+(options.autospc?'YES':'NO'));
    if(solver==='mystran')changes.unshift('Real fields rounded to at most 11 significant digits (maximum 16 characters)');
    return{deck:lines.join('\n').trim()+'\n',profile:{id:solver+'-static-v1',solver,autospc:!!options.autospc,transformations:[...new Set(changes)]}};
  }
  function equilibrium(f06,coordinates){
    if(!coordinates)return {status:'not-checked',message:'Balance requires resolved GRID positions/output frames and OLOAD/SPCFORCES output.'};
    // MYSTRAN prints exact zero as 0.0; nonzero scientific fields retain a
    // half-last-digit rounding bound. This is separate from numerical balance.
    const printedError=t=>{if(Number(t)===0)return 0;const [m,e]=t.toLowerCase().split('e');return .5*10**((Number(e)||0)-(m.split('.')[1]?.length||0));};
    const grids=new Map(coordinates.map(([id,p,frame])=>[id,{p,frame}])),cases=new Map();let current=null,table=null;
    for(const line of f06.split('\n')){
      const found=line.match(/OUTPUT FOR SUBCASE\s+(\d+)/);if(found){current=Number(found[1]);if(!cases.has(current))cases.set(current,{applied:new Map(),reaction:new Map()});table=null;}
      if(/A\s*P\s*P\s*L\s*I\s*E\s*D\s+F\s*O\s*R\s*C\s*E\s*S/.test(line))table='applied';
      if(/S\s*P\s*C\s+F\s*O\s*R\s*C\s*E\s*S/.test(line))table='reaction';
      if(/MAX\*|MIN\*|ABS\*|TOTALS|D\s*I\s*S\s*P\s*L\s*A\s*C\s*E/.test(line))table=null;
      if(table&&current){const f=line.trim().split(/\s+/);if(f.length===8&&/^\d+$/.test(f[0])&&/^\d+$/.test(f[1])){const v=f.slice(2).map(Number);if(v.every(Number.isFinite))cases.get(current)[table].set(Number(f[0]),{v,error:f.slice(2).map(printedError),cid:Number(f[1])});}}
    }
    const reports=[];
    for(const [id,tables] of cases){
      if(!tables.applied.size||!tables.reaction.size)continue;
      const totals={},absolute={},rounding={};let valid=true;
      for(const key of ['applied','reaction']){
        const total=Array(6).fill(0),magnitude=Array(6).fill(0),error=Array(6).fill(0);
        for(const [nid,row]of tables[key]){
          const g=grids.get(nid);if(!g||row.cid&&g.frame?.cid!==row.cid){valid=false;break;}
          const p=g.p,rotate=(values,abs=false)=>row.cid?[0,3].flatMap(offset=>[0,1,2].map(i=>values.slice(offset,offset+3).reduce((sum,x,j)=>sum+x*(abs?Math.abs(g.frame.axes[j][i]):g.frame.axes[j][i]),0))):values;
          const v=rotate(row.v),q=rotate(row.error,true),moment=[p[1]*v[2]-p[2]*v[1],p[2]*v[0]-p[0]*v[2],p[0]*v[1]-p[1]*v[0]];
          const lever=values=>[Math.abs(p[1])*values[2]+Math.abs(p[2])*values[1],Math.abs(p[2])*values[0]+Math.abs(p[0])*values[2],Math.abs(p[0])*values[1]+Math.abs(p[1])*values[0]],momentError=lever(q),momentMagnitude=lever(v.map(Math.abs));
          for(let i=0;i<6;i++){total[i]+=v[i]+(i>2?moment[i-3]:0);magnitude[i]+=Math.abs(v[i])+(i>2?momentMagnitude[i-3]:0);error[i]+=q[i]+(i>2?momentError[i-3]:0);}
        }
        totals[key]=total;absolute[key]=magnitude;rounding[key]=error;
      }
      if(!valid)continue;
      const residual=totals.applied.map((v,i)=>v+totals.reaction[i]),scale=absolute.applied.map((v,i)=>Math.max(1,v,absolute.reaction[i])),printBound=rounding.applied.map((v,i)=>v+rounding.reaction[i]),tolerance=scale.map((v,i)=>1e-5*v+printBound[i]);
      const passed=residual.every((v,i)=>Math.abs(v)<=tolerance[i]),strictResultantPassed=residual.every((v,i)=>Math.abs(v)<=1e-5*Math.max(1,Math.abs(totals.applied[i]),Math.abs(totals.reaction[i])));
      reports.push({subcase:id,...totals,residual,scale,printBound,tolerance,normalizedResidual:residual.map((v,i)=>v/scale[i]),strictResultantPassed,passed});
    }
    return {status:reports.length?reports.every(r=>r.passed)?'passed':'failed':'not-checked',cases:reports,message:reports.length?'Sum of applied loads and SPC reactions about the basic origin. Each component uses 1e−5 of its largest absolute contributing load sum (minimum scale 1), plus the F06 rounding bound. Cancelling resultants do not set the normalization scale.':'No complete OLOAD/SPCFORCES tables with resolved frames found.'};
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
