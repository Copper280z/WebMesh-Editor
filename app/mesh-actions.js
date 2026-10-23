/* Shared, deterministic mesh actions. Guides and direct tools call this API. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.WebMeshActions=factory();}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const copy=x=>JSON.parse(JSON.stringify(x)),xyz=n=>[n.x,n.y,n.z],sub=(a,b)=>a.map((x,i)=>x-b[i]),dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],norm=a=>Math.hypot(...a);
  const faces={CHEXA:[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]],CTETRA:[[0,2,1],[0,1,3],[1,2,3],[2,0,3]],CPENTA:[[0,2,1],[3,4,5],[0,1,4,3],[1,2,5,4],[2,0,3,5]]};
  const counts={CTRIA3:3,CQUAD4:4,CTETRA:4,CHEXA:8,CPENTA:6},key=ns=>[...ns].sort((a,b)=>a-b).join(':'),type=t=>({CHEXA8:'CHEXA',CTETRA4:'CTETRA',CPENTA6:'CPENTA'}[t]||t);
  function positiveId(n){if(!Number.isInteger(n)||n<1||n>2147483647)throw Error('IDs must be positive 32-bit integers.');return n;}
  function validateElement(e,nodes){
    const p=e.nodes.map(id=>{const n=nodes.get(id);if(!n)throw Error('Missing GRID '+id+'.');return xyz(n);}),t=type(e.type);
    if(!counts[t]||counts[t]!==p.length||new Set(e.nodes).size!==p.length)throw Error('Use distinct nodes and supported linear connectivity for '+t+'.');
    if(p.some(p=>!p.every(Number.isFinite)))throw Error('Coordinates must be finite.');
    const scale=Math.max(...p.map(q=>norm(sub(q,p[0])))),area=scale*scale*1e-10,volume=scale**3*1e-10;
    if(!scale)throw Error('Degenerate element.');
    const n=cross(sub(p[1],p[0]),sub(p[2],p[0]));
    if(t==='CTRIA3'||t==='CQUAD4'){
      if(norm(n)<=area)throw Error('Degenerate shell.');
      if(t==='CQUAD4')for(let i=0;i<4;i++)if(dot(cross(sub(p[(i+1)%4],p[i]),sub(p[(i+3)%4],p[i])),n)<=area*norm(n))throw Error('Crossed or degenerate quadrilateral; enter perimeter node order.');
    }else if(t==='CTETRA'){
      if(dot(sub(p[1],p[0]),cross(sub(p[2],p[0]),sub(p[3],p[0])))<=volume)throw Error('Inverted or degenerate tetrahedron.');
    }else{
      const samples=t==='CHEXA'?[-1,0,1].flatMap(r=>[-1,0,1].flatMap(s=>[-1,0,1].map(z=>[r,s,z]))):[[0,0],[1,0],[0,1],[1/3,1/3]].flatMap(([r,s])=>[-1,0,1].map(z=>[r,s,z]));
      for(const [r,s,z] of samples){
        const derivatives=t==='CHEXA'?[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]].map(([a,b,c])=>[a*(1+b*s)*(1+c*z)/8,b*(1+a*r)*(1+c*z)/8,c*(1+a*r)*(1+b*s)/8]):[-1,1].flatMap(c=>[[-(1+c*z)/2,-(1+c*z)/2,c*(1-r-s)/2],[(1+c*z)/2,0,c*r/2],[0,(1+c*z)/2,c*s/2]]);
        const j=[0,1,2].map(d=>[0,1,2].map(k=>p.reduce((v,q,i)=>v+(q[k]-p[0][k])*derivatives[i][d],0)));
        if(dot(j[0],cross(j[1],j[2]))<=volume)throw Error('Inverted, folded or degenerate solid Jacobian. Check node order, vector and layer size.');
      }
    }
    return true;
  }
  function facets(mesh,elementIds){
    const selected=new Set(elementIds||mesh.elements.map(e=>e.id)),all=[];
    for(const e of mesh.elements){
      const t=type(e.type);if(!faces[t]||e.nodes.length!==counts[t]){if(selected.has(e.id))throw Error('Solid faces require linear HEX8, TET4 or PENTA6 elements.');continue;}
      faces[t].forEach((f,i)=>all.push({element:e.id,face:i+1,nodes:f.map(j=>e.nodes[j])}));
    }
    if(new Set(all.filter(f=>selected.has(f.element)).map(f=>f.element)).size!==selected.size)throw Error('A selected solid element is missing.');
    const uses=new Map();for(const f of all)uses.set(key(f.nodes),(uses.get(key(f.nodes))||0)+1);
    return all.filter(f=>selected.has(f.element)).map(f=>({...f,uses:uses.get(key(f.nodes))}));
  }
  function execute(mesh,steps,ids={}){
    const result=copy(mesh),nodes=new Map(result.nodes.map(n=>[n.id,n])),elements=new Map(result.elements.map(e=>[e.id,e]));
    const addedNodes=[],addedElements=[],updatedElements=[],removedNodes=[],trace=[];
    let nid=result.nodes.reduce((next,n)=>Math.max(next,n.id+1),ids.node||1),eid=result.elements.reduce((next,e)=>Math.max(next,e.id+1),ids.element||1);
    const signatures=new Set(result.elements.map(e=>type(e.type)+'/'+key(e.nodes)));
    const addElement=(t,ns,pid)=>{
      positiveId(pid);t=type(t);const e={id:positiveId(eid++),type:t,nodes:ns.slice(),pid};validateElement(e,nodes);
      const sig=t+'/'+key(ns);if(signatures.has(sig))throw Error('Duplicate '+t+' connectivity.');signatures.add(sig);elements.set(e.id,e);result.elements.push(e);addedElements.push(e);return e;
    };
    const sourceElements=ids=>{if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length)throw Error('Select distinct source elements.');return ids.map(id=>{const e=elements.get(id);if(!e)throw Error('Missing source element '+id+'.');return e;});};
    const points=ns=>ns.map(id=>{positiveId(id);if(!nodes.has(id))throw Error('Missing GRID '+id+'.');return xyz(nodes.get(id));});
    for(const raw of steps){
      const s=copy(raw),before={nodes:addedNodes.length,elements:addedElements.length};
      if(s.action==='create-elements')for(const ns of s.connectivity||[])addElement(s.type,ns,s.pid);
      else if(s.action==='shells-on-faces'){
        const available=facets(result,[...new Set((s.facets||[]).map(f=>f.element))]);
        const used=new Set();for(const f of s.facets||[]){const hit=available.find(a=>a.element===f.element&&a.face===f.face);if(!hit)throw Error('Missing solid facet '+f.element+':'+f.face+'.');if(used.has(key(hit.nodes)))continue;used.add(key(hit.nodes));addElement(hit.nodes.length===4?'CQUAD4':'CTRIA3',s.reverse?[...hit.nodes].reverse():hit.nodes,s.pid);}
      }else if(s.action==='extrude-edges'||s.action==='extrude-shells'){
        if(!Array.isArray(s.vector)||s.vector.length!==3||!s.vector.every(Number.isFinite)||!norm(s.vector))throw Error('Enter a nonzero finite total extrusion vector.');
        if(!Number.isInteger(s.layers)||s.layers<1||s.layers>200)throw Error('Layer count must be an integer from 1 to 200.');
        if(s.reuse&&(!Number.isFinite(s.tolerance)||s.tolerance<=0))throw Error('Reuse tolerance must be positive.');
        let seeds;
        if(s.action==='extrude-shells')seeds=sourceElements(s.elements).map(e=>{if(!['CTRIA3','CQUAD4'].includes(e.type)||(e.zoffs||0)!==0)throw Error('Extrude linear CTRIA3/CQUAD4 shells with zero offset; offset the nodes explicitly first.');validateElement(e,nodes);return e.nodes;});
        else{if(!Array.isArray(s.nodes)||s.nodes.length<2||new Set(s.nodes).size!==s.nodes.length)throw Error('Enter an ordered chain of at least two distinct GRID IDs.');points(s.nodes);seeds=s.nodes.slice(1).map((n,i)=>[s.nodes[i],n]);}
        const base=[...new Set(seeds.flat())];if(base.length*s.layers>100000||seeds.length*s.layers>100000)throw Error('Extrusion exceeds 100,000 new nodes/elements.');
        const columns=new Map(base.map(id=>[id,[id]])),bins=new Map();
        const bin=p=>p.map(v=>Math.floor(v/s.tolerance));
        const indexNode=n=>{const k=bin(xyz(n)).join(':');if(!bins.has(k))bins.set(k,[]);bins.get(k).push(n);};
        if(s.reuse)for(const n of nodes.values())indexNode(n);
        const nearby=p=>{const cell=bin(p),hits=new Map();for(let i=-1;i<=1;i++)for(let j=-1;j<=1;j++)for(let k=-1;k<=1;k++)for(const n of bins.get([cell[0]+i,cell[1]+j,cell[2]+k].join(':'))||[])if(norm(sub(xyz(n),p))<=s.tolerance)hits.set(n.id,n);return [...hits.values()];};
        for(let layer=1;layer<=s.layers;layer++)for(const id of base){
          const p=xyz(nodes.get(id)).map((v,i)=>v+s.vector[i]*layer/s.layers);
          const matches=s.reuse?nearby(p):[];
          if(matches.length>1)throw Error('Ambiguous node reuse at '+p.join(', ')+'. Reduce tolerance or resolve coincident nodes.');
          let hit=matches[0];if(!hit){hit={id:positiveId(nid++),x:p[0],y:p[1],z:p[2]};nodes.set(hit.id,hit);result.nodes.push(hit);addedNodes.push(hit);if(s.reuse)indexNode(hit);}columns.get(id).push(hit.id);
        }
        for(const seed of seeds)for(let layer=0;layer<s.layers;layer++){
          let a=seed.map(n=>columns.get(n)[layer]),b=seed.map(n=>columns.get(n)[layer+1]);
          if(seed.length===2)addElement('CQUAD4',[a[0],a[1],b[1],b[0]],s.pid);
          else{const p=points(a);if(dot(cross(sub(p[1],p[0]),sub(p[2],p[0])),s.vector)<0){a=a.slice().reverse();b=b.slice().reverse();}addElement(seed.length===4?'CHEXA':'CPENTA',a.concat(b),s.pid);}
        }
      }else if(s.action==='share-nodes'){
        const mapping=new Map((s.pairs||[]).map(p=>p));if(!mapping.size||mapping.size!==(s.pairs||[]).length)throw Error('Enter distinct source/target node pairs.');
        if(!Number.isFinite(s.tolerance)||s.tolerance<0)throw Error('Sharing tolerance must be nonnegative.');
        for(const [a,b] of mapping){const [p,q]=points([a,b]);if(a===b||norm(sub(p,q))>s.tolerance)throw Error('Shared nodes must be distinct and coincident within tolerance.');}
        for(const e of sourceElements(s.elements)){const changed={...e,nodes:e.nodes.map(n=>mapping.get(n)||n)};validateElement(changed,nodes);if(key(changed.nodes)!==key(e.nodes)&&signatures.has(type(e.type)+'/'+key(changed.nodes)))throw Error('Node sharing would duplicate an element.');signatures.delete(type(e.type)+'/'+key(e.nodes));signatures.add(type(changed.type)+'/'+key(changed.nodes));Object.assign(e,changed);updatedElements.push(copy(e));}
        if(s.retireSources){
          const referenced=new Set(result.elements.flatMap(e=>e.nodes));
          for(const [from] of mapping)if(!referenced.has(from)){
            if(nodes.get(from).ps||nodes.get(from).seid)throw Error('Resolve permanent constraints/superelement membership before retiring GRID '+from+'.');
            removedNodes.push(from);nodes.delete(from);
          }
          result.nodes=result.nodes.filter(n=>!removedNodes.includes(n.id));
        }
      }else throw Error('Unknown mesh action: '+s.action);
      if(addedElements.length===before.elements&&updatedElements.length===0)throw Error('The action creates or changes no elements.');
      trace.push({...s,createdNodes:addedNodes.length-before.nodes,createdElements:addedElements.length-before.elements});
    }
    return {mesh:result,nodes:addedNodes,elements:addedElements,updatedElements,removedNodes,trace};
  }
  return Object.freeze({execute,facets,validateElement,faces,xyz,sub,dot,cross,norm,key});
}));
