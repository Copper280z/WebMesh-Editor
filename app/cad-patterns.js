/* Analyst-named circular-hole patterns. A moved candidate is never identity. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.WebMeshCadPatterns=factory();}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const copy=x=>JSON.parse(JSON.stringify(x)),distance=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i])),tol=1e-6;
  function hole(topology,id){
    const e=topology.edges?.find(e=>e.id===id);if(!e||e.type!=='Circle'||!e.bounds||!(e.length>0))return null;
    const center=e.bounds.slice(0,3).map((x,i)=>(x+e.bounds[i+3])/2),radius=e.length/(2*Math.PI),span=e.bounds.slice(0,3).map((x,i)=>e.bounds[i+3]-x),axis=span.indexOf(Math.min(...span));
    // Full circular loops only. Arcs need a richer loop rule.
    if(span[axis]>tol||span.some((s,i)=>i!==axis&&Math.abs(s-2*radius)>tol))return null;
    return {id,center,radius,axis};
  }
  function define(topology,ids){
    if(!Array.isArray(ids)||ids.length<2||new Set(ids).size!==ids.length)throw Error('Select at least two distinct full circular hole edges.');
    const holes=ids.map(id=>hole(topology,id));if(holes.some(h=>!h))throw Error('A hole pattern requires full circular edges on coordinate-aligned planes.');
    if(holes.some(h=>h.axis!==holes[0].axis||Math.abs(h.center[h.axis]-holes[0].center[h.axis])>tol))throw Error('Pattern holes must lie on one plane.');
    return {kind:'circular-hole-pattern-v1',holes:copy(holes),center:[0,1,2].map(i=>holes.reduce((s,h)=>s+h.center[i],0)/holes.length)};
  }
  function match(pattern,topology){
    const holes=pattern.holes,available=(topology.edges||[]).map(e=>hole(topology,e.id)).filter(Boolean),same=(a,b)=>a.axis===b.axis&&Math.abs(a.radius-b.radius)<tol;
    if(!holes?.length)throw Error('Pattern anchors are missing.');
    const candidates=[],seen=new Set();let ambiguous=false;
    for(const seed of available.filter(h=>same(h,holes[0]))){
      const delta=seed.center.map((x,i)=>x-holes[0].center[i]);
      // Translation within the original mounting plane only, never the opposite wall.
      if(Math.abs(delta[seed.axis])>tol)continue;
      const mapped=holes.map(h=>available.filter(n=>same(h,n)&&distance(n.center,h.center.map((x,i)=>x+delta[i]))<tol));
      if(mapped.some(m=>m.length!==1)){if(Math.hypot(...delta)<tol&&mapped.every(m=>m.length))ambiguous=true;continue;}
      const ids=mapped.map(m=>m[0].id);if(new Set(ids).size!==ids.length)continue;const key=ids.slice().sort((a,b)=>a-b).join(',');if(seen.has(key))continue;seen.add(key);
      candidates.push({ids,translation:delta,distance:Math.hypot(...delta)});
    }
    candidates.sort((a,b)=>a.distance-b.distance);const exact=candidates.filter(c=>c.distance<tol);
    return {status:exact.length===1&&!ambiguous?'exact':exact.length||ambiguous?'ambiguous':'missing',target:exact.length===1&&!ambiguous?exact[0].ids:null,candidates};
  }
  function report(state,source,before,after){
    const meshes=new Set((state?.project.objects||[]).filter(o=>o.definition.source===source).map(o=>o.id));
    return (state?.project.objects||[]).filter(o=>o.definition.generator==='cad-mount-region-v1'&&meshes.has(o.definition.selector.mesh)&&o.definition.pattern).map(o=>({id:o.id,name:o.name,pattern:copy(o.definition.pattern),...match(o.definition.pattern,after)}));
  }
  return Object.freeze({hole,define,match,report});
}));
