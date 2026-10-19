(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WebMeshModeling = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_NODES = 500000;
  const MAX_ELEMENTS = 250000;
  const MAX_ID = 2147483647;
  const TYPES = {
    CROD: { corners: 2, edges: [[0,1]], solid: false, line: true },
    CBUSH: { corners: 2, edges: [[0,1]], solid: false, line: true },
    CTRIA3: { corners: 3, edges: [[0,1],[1,2],[2,0]], solid: false },
    CTRIA6: { corners: 3, edges: [[0,1],[1,2],[2,0]], solid: false },
    CQUAD4: { corners: 4, edges: [[0,1],[1,2],[2,3],[3,0]], solid: false },
    CQUAD8: { corners: 4, edges: [[0,1],[1,2],[2,3],[3,0]], solid: false },
    CTETRA4: { corners: 4, edges: [[0,1],[1,2],[2,0],[0,3],[1,3],[2,3]], solid: true },
    CTETRA10: { corners: 4, edges: [[0,1],[1,2],[2,0],[0,3],[1,3],[2,3]], solid: true },
    CHEXA8: { corners: 8, edges: [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]], solid: true },
    CHEXA20: { corners: 8, edges: [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]], solid: true }
  };
  const HEX_FACES = [[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
  const TET_FACES = [[0,2,1],[0,1,3],[1,2,3],[2,0,3]];
  const add = (a,b) => a.map((v,i) => v+b[i]);
  const sub = (a,b) => a.map((v,i) => v-b[i]);
  const scale = (a,s) => a.map(v => v*s);
  const dot = (a,b) => a.reduce((v,x,i) => v+x*b[i],0);
  const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const norm = a => Math.hypot(...a);
  const point = n => [n.x,n.y,n.z];
  const edgeKey = (a,b) => a < b ? a+':'+b : b+':'+a;
  function resolvedType(element) {
    const type=String(element.type||'').toUpperCase(), count=Array.isArray(element.nodes)?element.nodes.length:0;
    if(type==='CHEXA') return count>8?'CHEXA20':'CHEXA8';
    if(type==='CTETRA') return count>4?'CTETRA10':'CTETRA4';
    return type;
  }

  function finite(value, label, fallback) {
    if (value === undefined && fallback !== undefined) return fallback;
    if (value === null || value === '' || typeof value === 'boolean' || !Number.isFinite(Number(value))) throw new Error(label+' must be a finite number.');
    return Number(value);
  }
  function positive(value,label,fallback) {
    const n = finite(value,label,fallback);
    if (n <= 0) throw new Error(label+' must be greater than zero.');
    return n;
  }
  function integer(value,label,fallback,min=1,max=MAX_ID) {
    const n = finite(value,label,fallback);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(label+' must be an integer from '+min+' to '+max+'.');
    return n;
  }
  function vector(value,label,fallback) {
    const v = value === undefined ? fallback : value;
    if (!Array.isArray(v) || v.length !== 3) throw new Error(label+' must have three components.');
    return v.map((x,i) => finite(x,label+'['+i+']'));
  }
  function capacity(nodes,elements) {
    if (nodes > MAX_NODES || elements > MAX_ELEMENTS) throw new Error('Mesh exceeds the interactive limit of '+MAX_NODES+' nodes or '+MAX_ELEMENTS+' elements. Reduce divisions or pattern counts.');
  }
  function builder(options) {
    let nextNode = integer(options.startNode,'Start node ID',1);
    let nextElement = integer(options.startElement,'Start element ID',1);
    const mesh = { name: '', nodes: [], elements: [] };
    function node(p) {
      if(!p.every(Number.isFinite)) throw new Error('Generated coordinates are outside the supported numeric range.');
      if (nextNode > MAX_ID) throw new Error('Node IDs exceed the supported range.');
      capacity(mesh.nodes.length+1,mesh.elements.length);
      const id = nextNode++;
      mesh.nodes.push({id,x:p[0],y:p[1],z:p[2]});
      return id;
    }
    function element(type,nodes,pid,extra={}) {
      if (nextElement > MAX_ID) throw new Error('Element IDs exceed the supported range.');
      capacity(mesh.nodes.length,mesh.elements.length+1);
      const record={...extra,id:nextElement++,type,pid,nodes};
      mesh.elements.push(record);
      return record;
    }
    return {mesh,node,element};
  }
  function triangulate(q) {
    // A globally chosen diagonal also makes adjacent tetrahedral cells conform.
    const k = q.indexOf(Math.min(...q));
    const r = q.map((_,i) => q[(i+k)%4]);
    return [[r[0],r[1],r[2]],[r[0],r[2],r[3]]];
  }
  function signedTet(p) { return dot(sub(p[1],p[0]),cross(sub(p[2],p[0]),sub(p[3],p[0])))/6; }

  /** Generate a conforming structured primitive. Lengths are in the model's units. */
  function createPrimitive(options={}) {
    const kind = options.kind || 'block';
    if (!['block','plate','cylinder','annulus'].includes(kind)) throw new Error('Unknown primitive: '+kind);
    const topology = options.topology || (kind === 'plate' || kind === 'annulus' ? 'quad' : 'hex');
    if (!['quad','tri','hex','tet'].includes(topology)) throw new Error('Topology must be quad, tri, hex, or tet.');
    if (kind === 'plate' && !['quad','tri'].includes(topology)) throw new Error('A plate requires quad or tri shell elements.');
    if (kind === 'block' && !['hex','tet'].includes(topology)) throw new Error('A block requires hex or tet solid elements.');
    const order = integer(options.order,'Element order',1,1,2);
    const pid = integer(options.pid,'Property ID',1);
    const origin = vector(options.origin,'Origin',[0,0,0]);
    const b = builder(options);
    const points = new Map();
    const pushNode = p => { const global = add(p,origin), id=b.node(global); points.set(id,global); return id; };
    const solid = topology === 'hex' || topology === 'tet';
    const addQuad = ids => {
      if (topology === 'tri') triangulate(ids).forEach(t => b.element('CTRIA3',t,pid));
      else b.element('CQUAD4',ids,pid);
    };
    const addHex = ids => {
      if (topology === 'hex') { b.element('CHEXA8',ids,pid); return; }
      // Cell centers avoid incompatible face diagonals in mapped and ring grids.
      const c=pushNode(scale(ids.reduce((a,id)=>add(a,sub(points.get(id),origin)),[0,0,0]),1/8));
      HEX_FACES.forEach(face => triangulate(face.map(i=>ids[i])).forEach(t => {
        const tet=[...t,c];
        if (signedTet(tet.map(id=>points.get(id))) < 0) [tet[1],tet[2]]=[tet[2],tet[1]];
        b.element('CTETRA4',tet,pid);
      }));
    };
    let projectMidpoint;
    if (kind === 'plate' || kind === 'block') {
      const size=vector(options.size,'Size',[10,10,10]);
      size.forEach((v,i)=>{if ((i<2 || solid) && v<=0) throw new Error('Active dimensions must be greater than zero.');});
      const d=vector(options.divisions,'Divisions',[4,4,4]).map((v,i)=>integer(v,'Divisions['+i+']'));
      const [nx,ny]=d, nz=solid?d[2]:0;
      capacity((nx+1)*(ny+1)*(nz+1)+(topology==='tet'?nx*ny*nz:0),nx*ny*(solid?nz:1)*(topology==='tet'?12:topology==='tri'?2:1));
      const ids=[];
      const at=(i,j,k=0)=>ids[(k*(ny+1)+j)*(nx+1)+i];
      for(let k=0;k<=nz;k++) for(let j=0;j<=ny;j++) for(let i=0;i<=nx;i++) ids.push(pushNode([i*size[0]/nx,j*size[1]/ny,solid?k*size[2]/nz:0]));
      for(let k=0;k<(solid?nz:1);k++) for(let j=0;j<ny;j++) for(let i=0;i<nx;i++) {
        const q=[at(i,j,k),at(i+1,j,k),at(i+1,j+1,k),at(i,j+1,k)];
        if(solid) addHex(q.concat([at(i,j,k+1),at(i+1,j,k+1),at(i+1,j+1,k+1),at(i,j+1,k+1)]));
        else addQuad(q);
      }
    } else {
      const radius=positive(options.radius,'Radius',5);
      const hollow=kind==='annulus';
      const inner=hollow?positive(options.innerRadius,'Inner radius',radius/2):0;
      if(inner>=radius) throw new Error('Inner radius must be smaller than outer radius.');
      const length=positive(options.length,'Length',10);
      const segments=integer(options.segments,'Circumferential divisions',24,3,10000);
      const radial=integer(options.radialDivisions,'Radial divisions',2);
      const axial=integer(options.axialDivisions,'Axial divisions',4);
      const nz=solid || !hollow?axial:0;
      const crossPoints=[], quads=[];
      if(!solid && !hollow) {
        capacity(segments*(axial+1),segments*axial*(topology==='tri'?2:1));
        const ids=[];
        for(let k=0;k<=axial;k++) for(let s=0;s<segments;s++) {
          const a=2*Math.PI*s/segments;
          ids.push(pushNode([radius*Math.cos(a),radius*Math.sin(a),length*k/axial]));
        }
        for(let k=0;k<axial;k++) for(let s=0;s<segments;s++) {
          const t=(s+1)%segments;
          addQuad([ids[k*segments+s],ids[k*segments+t],ids[(k+1)*segments+t],ids[(k+1)*segments+s]]);
        }
      } else {
        if(hollow) {
          capacity(segments*(radial+1)*(nz+1)+(topology==='tet'?segments*radial*nz:0),segments*radial*(solid?nz:1)*(topology==='tet'?12:topology==='tri'?2:1));
          for(let r=0;r<=radial;r++) for(let s=0;s<segments;s++) {
            const a=2*Math.PI*s/segments, rr=inner+(radius-inner)*r/radial;
            crossPoints.push([rr*Math.cos(a),rr*Math.sin(a),0]);
          }
          for(let r=0;r<radial;r++) for(let s=0;s<segments;s++) {
            const t=(s+1)%segments;
            quads.push([r*segments+s,(r+1)*segments+s,(r+1)*segments+t,r*segments+t]);
          }
        } else {
          if(segments%4!==0) throw new Error('Mapped solid cylinders require circumferential divisions divisible by 4.');
          const n=segments/4, half=radius*0.35;
          const np=(n+1)*(n+1)+segments*radial, ne=n*n+segments*radial;
          capacity(np*(nz+1)+(topology==='tet'?ne*nz:0),ne*nz*(topology==='tet'?12:1));
          for(let j=0;j<=n;j++) for(let i=0;i<=n;i++) crossPoints.push([-half+2*half*i/n,-half+2*half*j/n,0]);
          for(let j=0;j<n;j++) for(let i=0;i<n;i++) {const a=j*(n+1)+i;quads.push([a,a+1,a+n+2,a+n+1]);}
          let boundary=[];
          for(let i=0;i<n;i++) boundary.push(i);
          for(let j=0;j<n;j++) boundary.push(j*(n+1)+n);
          for(let i=n;i>0;i--) boundary.push(n*(n+1)+i);
          for(let j=n;j>0;j--) boundary.push(j*(n+1));
          const coreBoundary=boundary.slice();
          for(let r=1;r<=radial;r++) {
            const next=[];
            for(let s=0;s<segments;s++) {
              const p=crossPoints[coreBoundary[s]], a=Math.atan2(p[1],p[0]), t=r/radial;
              next.push(crossPoints.length);
              crossPoints.push([(1-t)*p[0]+t*radius*Math.cos(a),(1-t)*p[1]+t*radius*Math.sin(a),0]);
            }
            for(let s=0;s<segments;s++) {const t=(s+1)%segments;quads.push([boundary[s],next[s],next[t],boundary[t]]);}
            boundary=next;
          }
        }
        const ids=[];
        for(let k=0;k<=nz;k++) crossPoints.forEach(p=>ids.push(pushNode([p[0],p[1],solid?length*k/nz:0])));
        for(let k=0;k<(solid?nz:1);k++) quads.forEach(q=>{
          const base=q.map(i=>ids[k*crossPoints.length+i]);
          if(solid) addHex(base.concat(q.map(i=>ids[(k+1)*crossPoints.length+i])));
          else addQuad(base);
        });
      }
      projectMidpoint=(a,c,m)=>{
        const pa=sub(a,origin), pc=sub(c,origin);
        if(Math.abs(pa[2]-pc[2])>1e-10*length) return m;
        const ra=Math.hypot(pa[0],pa[1]), rc=Math.hypot(pc[0],pc[1]);
        const rr=[radius,inner].find(r=>r>0 && Math.abs(ra-r)<radius*1e-9 && Math.abs(rc-r)<radius*1e-9);
        if(!rr) return m;
        const v=sub(m,origin), r=Math.hypot(v[0],v[1]);
        if(r<radius*1e-12) return m;
        return [origin[0]+v[0]*rr/r,origin[1]+v[1]*rr/r,m[2]];
      };
    }
    if(order===2) elevate(b,projectMidpoint);
    b.mesh.name=(options.name || kind[0].toUpperCase()+kind.slice(1))+' · '+topology+' · order '+order;
    const report=validateMesh(b.mesh);
    if(!report.valid) throw new Error('Primitive is invalid at this scale. '+report.errors.slice(0,2).join(' '));
    return b.mesh;
  }

  function elevate(b,project) {
    const nodeMap=new Map(b.mesh.nodes.map(n=>[n.id,point(n)])), edges=new Map();
    const elevated={CTRIA3:'CTRIA6',CQUAD4:'CQUAD8',CTETRA4:'CTETRA10',CHEXA8:'CHEXA20'};
    for(const e of b.mesh.elements) {
      const spec=TYPES[e.type], mids=[];
      for(const [a,c] of spec.edges) {
        const key=edgeKey(e.nodes[a],e.nodes[c]);
        if(!edges.has(key)) {
          const p=nodeMap.get(e.nodes[a]), q=nodeMap.get(e.nodes[c]);
          let m=scale(add(p,q),0.5);
          if(project) m=project(p,q,m);
          edges.set(key,b.node(m));
        }
        mids.push(edges.get(key));
      }
      e.nodes=e.nodes.concat(mids);e.type=elevated[e.type];
    }
  }

  function assertMesh(mesh) {
    if(!mesh || !Array.isArray(mesh.nodes) || !Array.isArray(mesh.elements)) throw new Error('A mesh needs node and element arrays.');
    capacity(mesh.nodes.length,mesh.elements.length);
    const report=validateMesh(mesh);
    if(!report.valid) throw new Error('Invalid mesh: '+report.errors.slice(0,3).join(' '));
  }

  function pattern(mesh,transforms,options,name) {
    assertMesh(mesh);
    capacity(mesh.nodes.length*transforms.length,mesh.elements.length*transforms.length);
    const tolerance=finite(options.mergeTolerance,'Merge tolerance',0);
    if(tolerance<0) throw new Error('Merge tolerance cannot be negative.');
    const includeSeed=options.includeSeed!==false;
    if(options.mergeNodes!==undefined && (includeSeed || !Array.isArray(options.mergeNodes))) throw new Error('mergeNodes must be a node array used with includeSeed:false.');
    const referenceNodes=new Map(mesh.nodes.map(n=>[n.id,n]));
    for(const n of options.mergeNodes||[]) {
      if(!n || !Number.isSafeInteger(n.id) || n.id<1 || n.id>MAX_ID || ![n.x,n.y,n.z].every(Number.isFinite)) throw new Error('External merge nodes need valid IDs and finite coordinates.');
      const old=referenceNodes.get(n.id);
      if(old && (old.x!==n.x || old.y!==n.y || old.z!==n.z)) throw new Error('Conflicting coordinates for merge node '+n.id+'.');
      referenceNodes.set(n.id,n);
    }
    const buildOptions=includeSeed?options:Object.assign({},options,{
      startNode:options.startNode===undefined?Array.from(referenceNodes.values()).reduce((max,n)=>Math.max(max,n.id),0)+1:options.startNode,
      startElement:options.startElement===undefined?mesh.elements.reduce((max,e)=>Math.max(max,e.id),0)+1:options.startElement
    });
    const b=builder(buildOptions), buckets=new Map();
    const nodeIds=new Set(referenceNodes.keys()), elementIds=new Set(mesh.elements.map(e=>e.id));
    if(!includeSeed && (nodeIds.has(buildOptions.startNode)||elementIds.has(buildOptions.startElement))) throw new Error('Copied instance IDs must not overlap the seed IDs.');
    const bucketNode=n=>{
      const cell=[n.x,n.y,n.z].map(v=>Math.floor(v/tolerance));
      if(cell.some(v=>!Number.isSafeInteger(v))) throw new Error('Merge tolerance is too small for these coordinates.');
      const key=cell.join(':');
      if(!buckets.has(key)) buckets.set(key,[]);
      buckets.get(key).push(n);
    };
    if(!includeSeed && tolerance) referenceNodes.forEach(bucketNode);
    const merged=p=>{
      if(!tolerance) return b.node(p);
      const cell=p.map(v=>Math.floor(v/tolerance));
      if(cell.some(v=>!Number.isSafeInteger(v))) throw new Error('Merge tolerance is too small for these coordinates.');
      for(let x=-1;x<=1;x++) for(let y=-1;y<=1;y++) for(let z=-1;z<=1;z++) {
        const candidates=buckets.get([cell[0]+x,cell[1]+y,cell[2]+z].join(':')) || [];
        for(const n of candidates) if(Math.hypot(n.x-p[0],n.y-p[1],n.z-p[2])<=tolerance) return n.id;
      }
      const id=b.node(p);
      bucketNode(b.mesh.nodes[b.mesh.nodes.length-1]);
      return id;
    };
    for(const transform of includeSeed?transforms:transforms.slice(1)) {
      const map=new Map();
      mesh.nodes.forEach(n=>map.set(n.id,merged(transform(point(n)))));
      mesh.elements.forEach(e=>{
        const extra={};
        if(e.cm!=null)extra.cm=e.cm;
        if(e.type==='CBUSH') {
          if(e.cid!=null||e.orient?.kind==='g0')throw new Error('Pattern CBUSH connectors with explicit orientation vectors; coordinate-system and G0 orientations require individual card editing.');
          if(e.orient?.kind==='x')extra.orient={kind:'x',x:sub(transform(e.orient.x),transform([0,0,0]))};
          for(const key of ['s','ocid','si'])if(e[key]!=null)extra[key]=Array.isArray(e[key])?e[key].slice():e[key];
        }
        b.element(e.type,e.nodes.map(id=>map.get(id)),e.pid,extra);
      });
    }
    const combined=includeSeed?b.mesh:{nodes:Array.from(referenceNodes.values()).concat(b.mesh.nodes),elements:mesh.elements.concat(b.mesh.elements)};
    const report=validateMesh(combined);
    if(!report.valid) throw new Error('Pattern produces an invalid mesh. Reduce merge tolerance. '+report.errors.slice(0,2).join(' '));
    b.mesh.name=(mesh.name || 'Model')+' · '+name;
    if(Array.isArray(mesh.properties))b.mesh.properties=JSON.parse(JSON.stringify(mesh.properties));
    if(mesh.area!=null)b.mesh.area=mesh.area;
    return b.mesh;
  }

  /** Counts are total instances in each direction, including the seed at [0,0,0]. */
  function linearPattern(mesh,options={}) {
    const counts=vector(options.counts,'Pattern counts',[2,1,1]).map((n,i)=>integer(n,'Pattern count '+(i+1)));
    const vectors=options.vectors===undefined?[[1,0,0],[0,1,0],[0,0,1]]:options.vectors;
    if(!Array.isArray(vectors)||vectors.length!==3) throw new Error('Linear pattern needs three direction vectors.');
    const dirs=vectors.map((v,i)=>vector(v,'Direction '+(i+1)));
    counts.forEach((c,i)=>{if(c>1 && norm(dirs[i])===0)throw new Error('An active pattern direction cannot have zero spacing.');});
    if(!mesh || !Array.isArray(mesh.nodes)||!Array.isArray(mesh.elements)) throw new Error('A mesh needs node and element arrays.');
    const total=counts.reduce((a,c)=>a*c,1);
    capacity(mesh.nodes.length*total,mesh.elements.length*total);
    if(total>MAX_ELEMENTS) throw new Error('Too many pattern instances.');
    const transforms=[];
    for(let k=0;k<counts[2];k++) for(let j=0;j<counts[1];j++) for(let i=0;i<counts[0];i++) {
      const t=add(add(scale(dirs[0],i),scale(dirs[1],j)),scale(dirs[2],k));
      transforms.push(p=>add(p,t));
    }
    return pattern(mesh,transforms,options,'linear pattern');
  }

  /** Full circles omit the duplicate endpoint. Partial arcs include both endpoints. Angles use degrees. */
  function circularPattern(mesh,options={}) {
    const count=integer(options.count,'Instance count',6,1,MAX_ELEMENTS);
    const angle=finite(options.angle,'Sweep angle',360);
    if(angle===0 || Math.abs(angle)>360) throw new Error('Sweep angle must be nonzero and at most 360 degrees.');
    const axis=vector(options.axis,'Rotation axis',[0,0,1]), center=vector(options.center,'Rotation center',[0,0,0]);
    const axisScale=Math.max(...axis.map(Math.abs));
    if(!axisScale) throw new Error('Rotation axis cannot be zero.');
    const scaledAxis=axis.map(v=>v/axisScale), u=scale(scaledAxis,1/norm(scaledAxis)), transforms=[];
    const denom=Math.abs(angle)===360?count:Math.max(1,count-1);
    for(let i=0;i<count;i++) {
      const a=angle*Math.PI/180*i/denom, c=Math.cos(a), s=Math.sin(a);
      transforms.push(p=>{const v=sub(p,center);return add(center,add(add(scale(v,c),scale(cross(u,v),s)),scale(u,dot(u,v)*(1-c))));});
    }
    return pattern(mesh,transforms,options,'circular pattern');
  }

  function unit(value,label,fallback) {
    const v=vector(value,label,fallback), length=norm(v);
    if(!length||!Number.isFinite(length))throw new Error(label+' cannot be zero.');
    return scale(v,1/length);
  }
  function perpendicular(axis) {
    const basis=Math.abs(axis[0])<=Math.abs(axis[1])&&Math.abs(axis[0])<=Math.abs(axis[2])?[1,0,0]:Math.abs(axis[1])<=Math.abs(axis[2])?[0,1,0]:[0,0,1];
    const projected=sub(basis,scale(axis,dot(basis,axis)));
    return scale(projected,1/norm(projected));
  }
  function boltLocations(options={}) {
    const kind=options.kind||'single', center=vector(options.center,'Pattern center',[0,0,0]);
    if(!['single','linear','circular'].includes(kind))throw new Error('Bolt pattern must be single, linear, or circular.');
    const count=kind==='single'?1:integer(options.count,'Bolt count',2,1,1000);
    if(kind==='single')return [center];
    if(kind==='linear') {
      const pitch=vector(options.pitch,'Bolt pitch',[10,0,0]);
      if(count>1&&!norm(pitch))throw new Error('Bolt pitch cannot be zero for an array.');
      return Array.from({length:count},(_,i)=>add(center,scale(pitch,i)));
    }
    const axis=unit(options.patternAxis,'Circle axis',options.axis||[0,0,1]), radius=positive(options.radius,'Pattern radius',10);
    const raw=vector(options.radialDirection,'Radial direction',perpendicular(axis)), projected=sub(raw,scale(axis,dot(raw,axis)));
    if(norm(projected)<=norm(raw)*1e-12)throw new Error('Radial direction must have a component perpendicular to the circle axis.');
    const radial=scale(projected,1/norm(projected)), tangent=cross(axis,radial);
    const angle=finite(options.angle,'Pattern angle',360), start=finite(options.startAngle,'Start angle',0);
    if(!angle||Math.abs(angle)>360)throw new Error('Pattern angle must be nonzero and at most 360 degrees.');
    const denominator=Math.abs(angle)===360?count:Math.max(1,count-1);
    return Array.from({length:count},(_,i)=>{const a=(start+angle*i/denominator)*Math.PI/180;return add(center,scale(add(scale(radial,Math.cos(a)),scale(tangent,Math.sin(a))),radius));});
  }
  function boundaryNodeIds(mesh) {
    const faces=new Map(), boundary=new Set();
    for(const e of mesh.elements) {
      const spec=TYPES[resolvedType(e)];
      if(!spec||spec.line||!Array.isArray(e.nodes))continue;
      if(!spec.solid) {e.nodes.forEach(id=>boundary.add(id));continue;}
      const templates=spec.corners===4?TET_FACES:HEX_FACES;
      for(const face of templates) {
        const key=face.map(i=>e.nodes[i]).sort((a,b)=>a-b).join(':');
        if(faces.has(key)){faces.get(key).count++;continue;}
        const slots=new Set(face);
        if(e.nodes.length>spec.corners)spec.edges.forEach(([a,b],i)=>{if(slots.has(a)&&slots.has(b))slots.add(spec.corners+i);});
        faces.set(key,{count:1,nodes:[...slots].map(i=>e.nodes[i])});
      }
    }
    faces.forEach(face=>{if(face.count===1)face.nodes.forEach(id=>boundary.add(id));});
    return boundary;
  }
  /** RBE2 attachment discs and an explicitly oriented six-DOF CBUSH per bolt.
   *  Stiffnesses are user-specified connector values, not calculated bolt/contact
   *  behavior. The CROD alternative transfers axial force only (zero torsion).
   */
  function createBoltPattern(existingMesh,options={}) {
    if(!existingMesh||!Array.isArray(existingMesh.nodes)||!Array.isArray(existingMesh.elements))throw new Error('Existing mesh nodes and elements are required for bolt attachments.');
    const sourceNodes=new Map();
    for(const n of existingMesh.nodes){if(!n||!Number.isSafeInteger(n.id)||n.id<1||![n.x,n.y,n.z].every(Number.isFinite)||sourceNodes.has(n.id))throw new Error('Attachment mesh contains invalid or duplicate nodes.');sourceNodes.set(n.id,n);}
    const axis=unit(options.axis,'Bolt axis',[0,0,1]), orientation=perpendicular(axis), grip=positive(options.grip,'Grip length',10);
    const radius=positive(options.attachmentRadius,'Attachment radius',5), tolerance=positive(options.tolerance,'Attachment plane tolerance',0.1);
    if(tolerance>=grip/2)throw new Error('Attachment plane tolerance must be smaller than half the grip length.');
    const components=String(options.components??'123');
    if(!/^[1-6]+$/.test(components)||new Set(components).size!==components.length)throw new Error('Dependent components must contain unique digits from 1 to 6.');
    const connection=String(options.connection||'CBUSH').toUpperCase();
    if(!['CBUSH','CROD'].includes(connection))throw new Error('Bolt connection must be CBUSH or CROD.');
    const pid=integer(options.pid,'Bolt property ID',1), centers=boltLocations(options);
    const b=builder({...options,startNode:options.startNode??existingMesh.nodes.reduce((max,n)=>Math.max(max,n.id),0)+1,startElement:options.startElement??existingMesh.elements.reduce((max,e)=>Math.max(max,e.id),0)+1});
    const boundary=options.boundaryOnly===false?new Set(sourceNodes.keys()):boundaryNodeIds(existingMesh);
    function candidates(ids,label) {
      if(ids==null)return new Set(boundary);
      if(!Array.isArray(ids)||ids.some(id=>!sourceNodes.has(Number(id))))throw new Error(label+' must identify existing mesh nodes.');
      return new Set(ids.map(Number));
    }
    const pools=[candidates(options.headNodes,'Head node IDs'),candidates(options.nutNodes,'Nut node IDs')], dependent=new Set();
    for(const e of existingMesh.elements)if(e.type==='RBE2'&&String(e.cm||'123456').split('').some(c=>components.includes(c)))for(const id of (e.nodes||[]).slice(1))dependent.add(id);
    function attachment(center,pool,label) {
      const picked=[];
      for(const id of pool){const n=sourceNodes.get(id), delta=sub(point(n),center), axial=dot(delta,axis);if(Math.abs(axial)<=tolerance&&norm(sub(delta,scale(axis,axial)))<=radius)picked.push(id);}
      if(picked.length<3)throw new Error(label+' needs at least three nearby attachment nodes; found '+picked.length+'. Adjust radius, plane tolerance, or location.');
      const origin=point(sourceNodes.get(picked[0])), span=picked.slice(1).map(id=>sub(point(sourceNodes.get(id)),origin));
      if(!span.some(a=>span.some(b=>norm(cross(a,b))>radius*radius*1e-10)))throw new Error(label+' attachment nodes are collinear and cannot transmit a general connector moment.');
      for(const id of picked){if(dependent.has(id))throw new Error('Node '+id+' would be dependent in overlapping rigid spiders. Reduce attachment radii or choose distinct candidate nodes.');dependent.add(id);}
      return picked;
    }
    const bolts=[];
    for(let i=0;i<centers.length;i++) {
      const center=centers[i], headPoint=sub(center,scale(axis,grip/2)), nutPoint=add(center,scale(axis,grip/2));
      const headNodes=attachment(headPoint,pools[0],'Bolt '+(i+1)+' head'),nutNodes=attachment(nutPoint,pools[1],'Bolt '+(i+1)+' nut');
      const head=b.node(headPoint),nut=b.node(nutPoint);
      if(sourceNodes.has(head)||sourceNodes.has(nut))throw new Error('Generated bolt node IDs overlap existing nodes.');
      b.element(connection,[head,nut],pid,connection==='CBUSH'?{orient:{kind:'x',x:orientation.slice()}}:{});
      b.element('RBE2',[head,...headNodes],0,{cm:components});b.element('RBE2',[nut,...nutNodes],0,{cm:components});
      bolts.push({center,head,nut,headNodes,nutNodes});
    }
    const existingIds=new Set(existingMesh.elements.map(e=>e.id));if(b.mesh.elements.some(e=>existingIds.has(e.id)))throw new Error('Generated bolt element IDs overlap existing elements.');
    b.mesh.name=options.name||'Simulated bolt pattern';b.mesh.bolts=bolts;
    if(connection==='CBUSH') {
      if(!Array.isArray(options.stiffness)||options.stiffness.length!==6)throw new Error('Specify all six connector stiffnesses K1 through K6 in the bolt coordinate system.');
      const stiffness=options.stiffness.map((v,i)=>finite(v,'K'+(i+1)));
      if(stiffness.some(k=>k<0)||!stiffness.some(k=>k>0))throw new Error('Connector stiffnesses must be nonnegative, with at least one positive value.');
      b.mesh.properties=[{id:pid,type:'PBUSH',stiffness}];
    } else b.mesh.area=positive(options.area,'Rod area',1);
    return b.mesh;
  }

  function hexJacobians(p) {
    const signs=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
    const g=1/Math.sqrt(3), samples=[[0,0,0]];
    for(const x of [-g,g]) for(const y of [-g,g]) for(const z of [-g,g]) samples.push([x,y,z]);
    return samples.map(([x,y,z])=>{
      const cols=[[0,0,0],[0,0,0],[0,0,0]];
      signs.forEach(([a,b,c],i)=>{
        const weights=[a*(1+b*y)*(1+c*z)/8,b*(1+a*x)*(1+c*z)/8,c*(1+a*x)*(1+b*y)/8];
        weights.forEach((w,j)=>{cols[j]=add(cols[j],scale(p[i],w));});
      });
      return dot(cols[0],cross(cols[1],cols[2]));
    });
  }

  function validateMesh(mesh) {
    const errors=[],warnings=[];
    const stats={nodes:0,elements:0,topologies:{},freeEdges:0,boundaryFaces:0,degenerateElements:0,nonManifoldEdges:0,nonManifoldFaces:0};
    if(!mesh || !Array.isArray(mesh.nodes)||!Array.isArray(mesh.elements)) return {valid:false,errors:['A mesh needs node and element arrays.'],warnings,stats};
    stats.nodes=mesh.nodes.length;stats.elements=mesh.elements.length;
    if(!stats.nodes || !stats.elements) errors.push('Mesh must contain nodes and elements.');
    if(stats.nodes>MAX_NODES || stats.elements>MAX_ELEMENTS) errors.push('Mesh exceeds interactive limits.');
    const nodes=new Map(), elementIds=new Set(), shellEdges=new Map(), faces=new Map(), used=new Set(), duplicateElements=new Set(), midsides=new Map(), rigidDependencies=new Map();
    for(const n of mesh.nodes) {
      if(!n || !Number.isSafeInteger(n.id)||n.id<1||n.id>MAX_ID) {errors.push('Node has an invalid ID.');continue;}
      if(nodes.has(n.id)) errors.push('Duplicate node ID '+n.id+'.');
      if(![n.x,n.y,n.z].every(Number.isFinite)) errors.push('Node '+n.id+' has nonfinite coordinates.');
      nodes.set(n.id,n);
    }
    for(const e of mesh.elements) {
      if(!e || !Number.isSafeInteger(e.id)||e.id<1||e.id>MAX_ID) {errors.push('Element has an invalid ID.');continue;}
      if(elementIds.has(e.id)) errors.push('Duplicate element ID '+e.id+'.');
      elementIds.add(e.id);
      const type=resolvedType(e), spec=TYPES[type];
      if(type==='RBE2') {
        stats.topologies[type]=(stats.topologies[type]||0)+1;
        if(!Array.isArray(e.nodes)||e.nodes.length<2||new Set(e.nodes).size!==e.nodes.length||e.nodes.some(id=>!nodes.has(id)))errors.push('Rigid element '+e.id+' needs distinct existing independent and dependent nodes.');
        else e.nodes.forEach(id=>used.add(id));
        const cm=String(e.cm??'123456');if(!/^[1-6]+$/.test(cm)||new Set(cm).size!==cm.length)errors.push('Rigid element '+e.id+' has invalid dependent components.');
        for(const id of (e.nodes||[]).slice(1))for(const component of cm){const key=id+':'+component;if(rigidDependencies.has(key))errors.push('Node '+id+' component '+component+' is dependent in multiple rigid elements.');rigidDependencies.set(key,e.id);}
        continue;
      }
      if(!Number.isSafeInteger(e.pid)||e.pid<1||e.pid>MAX_ID) errors.push('Element '+e.id+' has an invalid property ID.');
      if(!spec) {errors.push('Element '+e.id+' uses '+e.type+'. This mesh checker and pattern tool support triangles, quads, tetrahedra, hexes, CROD, CBUSH and RBE2; use the card editor for other structural types.');continue;}
      stats.topologies[type]=(stats.topologies[type]||0)+1;
      const quadratic=['CTRIA6','CQUAD8','CTETRA10','CHEXA20'].includes(type);
      const expected=spec.corners+(quadratic?spec.edges.length:0);
      if(!Array.isArray(e.nodes)||e.nodes.length!==expected) {errors.push('Element '+e.id+' needs '+expected+' node IDs.');continue;}
      if(e.nodes.some(id=>!nodes.has(id))) {errors.push('Element '+e.id+' references missing nodes.');continue;}
      e.nodes.forEach(id=>used.add(id));
      let degenerate=new Set(e.nodes).size!==e.nodes.length;
      const corner=e.nodes.slice(0,spec.corners), p=corner.map(id=>point(nodes.get(id)));
      const length=Math.max(...spec.edges.map(([a,b])=>norm(sub(p[a],p[b]))));
      if(type==='CBUSH') {
        if(length===0&&!(Number.isInteger(e.cid)&&e.cid>=0))errors.push('Coincident CBUSH '+e.id+' requires an explicit coordinate system.');
        if(length>0&&e.cid==null) {
          const orient=e.orient?.kind==='x'?e.orient.x:e.orient?.kind==='g0'&&nodes.has(e.orient.g0)?sub(point(nodes.get(e.orient.g0)),p[0]):null;
          if(!e.orient)warnings.push('CBUSH '+e.id+' has no transverse orientation; verify its property contains only axial/torsional stiffness.');
          else if(!Array.isArray(orient)||orient.length!==3||!orient.every(Number.isFinite)||norm(cross(sub(p[1],p[0]),orient))<=length*norm(orient)*1e-12)errors.push('CBUSH '+e.id+' requires a nonparallel orientation vector or explicit coordinate system.');
        }
      }
      const eps=Math.max(Number.MIN_VALUE,length*length*1e-12);
      if(spec.line) {
        if((length<=0&&type!=='CBUSH') || !Number.isFinite(length)) degenerate=true;
      } else if(!spec.solid) {
        const area=norm(cross(sub(p[1],p[0]),sub(p[2],p[0])))/2;
        if(area<=eps) degenerate=true;
        if(spec.corners===4) {
          const a=cross(sub(p[1],p[0]),sub(p[2],p[0])), b=cross(sub(p[2],p[0]),sub(p[3],p[0]));
          if(norm(b)/2<=eps || dot(a,b)<=0) degenerate=true;
        }
        spec.edges.forEach(([a,b])=>{const key=edgeKey(corner[a],corner[b]);shellEdges.set(key,(shellEdges.get(key)||0)+1);});
      } else {
        const epsV=Math.max(Number.MIN_VALUE,length*length*length*1e-12);
        if(spec.corners===4) {if(signedTet(p)<=epsV)degenerate=true;}
        else if(hexJacobians(p).some(j=>j<=epsV/8)) degenerate=true;
        (spec.corners===4?TET_FACES:HEX_FACES).forEach(f=>{const key=f.map(i=>corner[i]).sort((a,b)=>a-b).join(':');faces.set(key,(faces.get(key)||0)+1);});
      }
      if(quadratic) spec.edges.forEach(([a,b],i)=>{
        const key=edgeKey(corner[a],corner[b]), id=e.nodes[spec.corners+i];
        if(midsides.has(key)&&midsides.get(key)!==id) errors.push('Nonconforming midside nodes on edge '+key+'.');
        midsides.set(key,id);
      });
      if(degenerate) {stats.degenerateElements++;errors.push('Element '+e.id+' is degenerate or inverted.');}
      const key=type+':'+corner.slice().sort((a,b)=>a-b).join(':');
      if(duplicateElements.has(key)) warnings.push('Overlapping duplicate element '+e.id+'.');
      duplicateElements.add(key);
    }
    shellEdges.forEach(n=>{if(n===1)stats.freeEdges++;else if(n>2)stats.nonManifoldEdges++;});
    faces.forEach(n=>{if(n===1)stats.boundaryFaces++;else if(n>2)stats.nonManifoldFaces++;});
    if(stats.nonManifoldEdges||stats.nonManifoldFaces) warnings.push('Mesh contains nonmanifold connections.');
    if(used.size<nodes.size) warnings.push((nodes.size-used.size)+' unused nodes.');
    return {valid:errors.length===0,errors,warnings,stats};
  }

  function toBdf(mesh,options={}) {
    assertMesh(mesh);
    const material=options.material||{};
    const mid=integer(material.id,'Material ID',1), E=positive(material.E,'Young’s modulus',210000);
    const nu=finite(material.nu,'Poisson ratio',0.3), rho=finite(material.rho,'Density',0);
    if(nu<=-1||nu>=0.5) throw new Error('Poisson ratio must be between -1 and 0.5.');
    if(rho<0)throw new Error('Density cannot be negative.');
    const thickness=positive(options.thickness,'Shell thickness',1), area=positive(options.area,'Rod area',1), properties=new Map();
    for(const e of mesh.elements) {
      const type=resolvedType(e);if(type==='RBE2')continue;
      const spec=TYPES[type], kind=type==='CBUSH'?'bush':spec.solid?'solid':spec.line?'rod':'shell';
      if(properties.has(e.pid)&&properties.get(e.pid)!==kind) throw new Error('Property '+e.pid+' is shared by incompatible element dimensions. Assign separate property IDs before export.');
      properties.set(e.pid,kind);
    }
    const number=v=>{if(!Number.isFinite(v))throw new Error('Cannot export nonfinite values.');return Number(v.toPrecision(13)).toString();};
    let continuation=0;
    const lines=['$ WebMesh Studio — '+String(mesh.name||'Model').replace(/[\r\n]/g,' '),'BEGIN BULK'];
    function card(name,fields) {
      const values=fields.map(v=>typeof v==='number'?number(v):String(v));
      let head=name;
      while(values.length>8) {const label='+W'+(++continuation);lines.push([head,...values.splice(0,8),label].join(','));head=label;}
      lines.push([head,...values].join(','));
    }
    if([...properties.values()].some(kind=>kind!=='bush'))card('MAT1',[mid,E,'',nu,rho]);
    properties.forEach((kind,pid)=>{
      if(kind==='bush') {
        const property=(mesh.properties||[]).find(p=>p.id===pid&&p.type==='PBUSH');
        if(!property||!Array.isArray(property.stiffness)||property.stiffness.length!==6||property.stiffness.some(k=>!Number.isFinite(k)||k<0))throw new Error('CBUSH export requires its PBUSH property and six nonnegative stiffnesses.');
        card('PBUSH',[pid,'K',...property.stiffness]);
      } else card(kind==='solid'?'PSOLID':kind==='rod'?'PROD':'PSHELL',kind==='solid'?[pid,mid]:kind==='rod'?[pid,mid,mesh.area??area]:[pid,mid,thickness,mid,1,mid,5/6]);
    });
    mesh.nodes.forEach(n=>card('GRID',[n.id,'',n.x,n.y,n.z]));
    mesh.elements.forEach(e=>{
      const type=resolvedType(e);
      if(type==='RBE2')card(type,[e.id,e.nodes[0],e.cm??'123456',...e.nodes.slice(1)]);
      else if(type==='CBUSH') {
        const orientation=e.orient?.kind==='x'?e.orient.x.map(v=>{const text=number(v);return /[.eE]/.test(text)?text:text+'.';}):[e.orient?.g0??'','',''];
        card(type,[e.id,e.pid,...e.nodes,...orientation,e.cid??'']);
      } else card(type.startsWith('CTETRA')?'CTETRA':type.startsWith('CHEXA')?'CHEXA':type,[e.id,e.pid,...e.nodes]);
    });
    lines.push('ENDDATA','');
    return lines.join('\n');
  }

  return {createPrimitive,linearPattern,circularPattern,boltLocations,createBoltPattern,validateMesh,toBdf,limits:{maxNodes:MAX_NODES,maxElements:MAX_ELEMENTS}};
}));
