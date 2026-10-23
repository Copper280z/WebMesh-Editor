(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.WebMeshConnectionActions=factory();}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const copy=v=>JSON.parse(JSON.stringify(v));
  function id(n){if(!Number.isInteger(n)||n<1||n>2147483647)throw Error('Card IDs must be positive 32-bit integers.');return n;}
  function vector(v,label,length=3){if(!Array.isArray(v)||v.length!==length||!v.every(Number.isFinite))throw Error(label+' requires '+length+' finite values.');return v.slice();}
  function quantity(value,dimension,units){
    const scales={mass:{g:.001,kg:1,t:1000,tonne:1000},length:{mm:.001,cm:.01,m:1,in:.0254,ft:.3048}};
    if(typeof value==='number'&&Number.isFinite(value))return value;
    const match=String(value).trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)$/i);
    if(!match||!Number.isFinite(Number(match[1])))throw Error('Enter a finite '+dimension+' value, optionally with a unit suffix.');
    if(!match[2])return Number(match[1]);
    const table=scales[dimension],from=table?.[match[2].toLowerCase()],to=table?.[units[dimension]];
    if(!from||!to)throw Error('Unsupported '+dimension+' unit conversion to '+units[dimension]+'. Enter a value in model units.');
    const n=Number(match[1])*from/to;if(!Number.isFinite(n))throw Error('Unit conversion overflow.');return n;
  }
  function inertia(values){
    const v=vector(values,'COM inertia',6),scale=Math.max(...v.map(Math.abs));if(!scale)return v;
    // Nastran stores products of inertia I21/I31/I32, with negative off-diagonals
    // in the inertia tensor. The second-moment tensor must be positive semidefinite.
    const [xx,xy,yy,xz,yz,zz]=v.map(n=>n/scale),half=(xx+yy+zz)/2;
    const a=half-xx,b=half-yy,c=half-zz,tol=1e-12;
    if(Math.min(a,b,c,a*b-xy*xy,a*c-xz*xz,b*c-yz*yz,a*b*c+2*xy*xz*yz-a*yz*yz-b*xz*xz-c*xy*xy)<-tol)throw Error('Inertia must describe a physically admissible mass distribution about its COM. Check signs, principal moments and units.');
    return v;
  }
  function massValue(input){
    id(input.id);id(input.node);if(!Number.isFinite(input.mass)||input.mass<=0)throw Error('Mass must be positive in model mass units.');
    return {type:'CONM2',eid:input.id,g:input.node,cid:0,m:input.mass,x:vector(input.offset||[0,0,0],'Mass offset'),inertia:inertia(input.inertia||[0,0,0,0,0,0])};
  }
  function distributionValue(input){
    id(input.id);id(input.node);
    if(input.components&&input.components!=='123456')throw Error('This RBE3 action requires reference components 123456.');
    if(!Array.isArray(input.groups)||!input.groups.length)throw Error('Add at least one independent support group.');
    const seen=new Set([input.node]);
    const groups=input.groups.map(g=>{
      if(!Number.isFinite(g.wt)||g.wt<=0||g.c!=='123'||!Array.isArray(g.gids)||!g.gids.length)throw Error('Each support group needs a positive weight, independent components 123 and GRID IDs.');
      for(const n of g.gids){id(n);if(seen.has(n))throw Error('RBE3 groups overlap or include their reference GRID '+n+'.');seen.add(n);}
      return {wt:g.wt,c:'123',gids:g.gids.slice()};
    });
    const inds=groups.flatMap(g=>g.gids);if(inds.length<3)throw Error('RBE3 needs at least three noncollinear support nodes.');
    return {type:'RBE3',eid:input.id,gn:input.node,cm:'123456',weight:1,inds,groups};
  }
  function supportGeometry(value,nodes){
    const point=n=>{const p=nodes.get(n);if(!p||p.cp||p.cd)throw Error('GRID '+n+' must exist in basic coordinates (CP=CD=0).');return vector([p.x,p.y,p.z],'GRID '+n);};
    point(value.gn);
    const points=value.inds.map(point),a=points[0],vectors=points.map(p=>p.map((v,i)=>v-a[i])),longest=vectors.reduce((a,b)=>Math.hypot(...a)>Math.hypot(...b)?a:b),span=Math.hypot(...longest);
    if(!Number.isFinite(span)||!span)throw Error('RBE3 support nodes are coincident.');
    const b=longest.map(v=>v/span),area=vectors.reduce((max,p)=>{const q=p.map(v=>v/span);return Math.max(max,Math.hypot(b[1]*q[2]-b[2]*q[1],b[2]*q[0]-b[0]*q[2],b[0]*q[1]-b[1]*q[0]));},0);
    if(area<1e-8)throw Error('RBE3 support is collinear or ill-conditioned; it cannot transmit all six reference DOFs.');
  }
  // All three operations are directly exposed by the connection workspace.
  // A guide supplies IDs and sequences these same operations on a detached map.
  function execute(source,steps){
    const nodes=new Map(source.map(n=>[n.id,copy(n)])),cards=[],trace=[];
    for(const s of steps){
      let card;
      if(s.action==='point'){
        id(s.id);if(nodes.has(s.id))throw Error('Point GRID '+s.id+' already exists.');const p=vector(s.position,'Point');
        const value={x:p[0],y:p[1],z:p[2],cp:0,cd:0,ps:''};nodes.set(s.id,{id:s.id,...value});card={family:'nodes',id:s.id,value};
      }else if(s.action==='mass'){
        const n=nodes.get(s.node);if(!n||n.cp||n.cd)throw Error('Mass attachment GRID must exist in basic coordinates (CP=CD=0).');
        card={family:'masses',id:s.id,value:massValue(s)};
      }else if(s.action==='rbe3'){
        const value=distributionValue(s);supportGeometry(value,nodes);card={family:'elems',bucket:'rbe3',id:s.id,value};
      }else throw Error('Unsupported connection action: '+s.action);
      card.role=s.role||s.action;cards.push(card);trace.push(copy(s));
    }
    return {cards,actions:trace};
  }
  return Object.freeze({execute,quantity,inertia,massValue,distributionValue,supportGeometry});
}));
