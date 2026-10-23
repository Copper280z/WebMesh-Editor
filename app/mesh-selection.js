/* Detached mesh picking: never reads or writes the editor's live selection. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.WebMeshMeshSelection=factory();
}(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const solidFaces={CHEXA:[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]],CTETRA:[[0,2,1],[0,1,3],[1,2,3],[2,0,3]],CPENTA:[[0,2,1],[3,4,5],[0,1,4,3],[1,2,5,4],[2,0,3,5]],CPYRAM:[[0,3,2,1],[0,1,4],[1,2,4],[2,3,4],[3,0,4]]};
  const edgeOrders={CHEXA:[[0,1],[1,2],[2,3],[3,0],[0,4],[1,5],[2,6],[3,7],[4,5],[5,6],[6,7],[7,4]],CTETRA:[[0,1],[1,2],[2,0],[0,3],[1,3],[2,3]]};
  const key=ns=>[...ns].sort((a,b)=>a-b).join(':'),point=n=>[n.x,n.y,n.z];
  function surfaces(mesh){
    const nodes=new Map(mesh.nodes.map(n=>[n.id,n])),all=[],counts=new Map();
    for(const e of mesh.elements){
      const type=e.type.replace(/(CHEXA|CTETRA|CPENTA)(8|20|4|10|6)$/,'$1'),solid=solidFaces[type],corners=type.startsWith('CTRIA')?3:type.startsWith('CQUAD')?4:0;
      if(!solid&&!corners)continue;
      const edges=solid?edgeOrders[type]:Array.from({length:corners},(_,i)=>[i,(i+1)%corners]);
      const offset=solid?(type==='CHEXA'?8:type==='CTETRA'?4:e.nodes.length):corners;
      const quadratic=edges&&e.nodes.length===offset+edges.length;
      (solid||[Array.from({length:corners},(_,i)=>i)]).forEach((f,i)=>{
        const perimeter=f.flatMap((a,j)=>{const b=f[(j+1)%f.length],mid=quadratic?edges.findIndex(([x,y])=>x===a&&y===b||x===b&&y===a):-1;return mid<0?[e.nodes[a]]:[e.nodes[a],e.nodes[offset+mid]];});
        if(perimeter.some(id=>!nodes.has(id)))throw Error('Proposed element '+e.id+' has missing nodes.');
        const record={element:e.id,face:i+1,nodes:perimeter,key:key(perimeter),solid:!!solid};all.push(record);
        if(solid)counts.set(record.key,(counts.get(record.key)||0)+1);
      });
    }
    return all.filter(f=>!f.solid||counts.get(f.key)!==2);
  }
  function createPicker(T,mesh){
    const nodes=new Map(mesh.nodes.filter(n=>!n.cp&&point(n).every(Number.isFinite)).map(n=>[n.id,n]));
    const faces=surfaces({...mesh,elements:mesh.elements.filter(e=>e.nodes.every(n=>nodes.has(n)))}),positions=[],triangles=[];
    for(const f of faces){
      const ps=f.nodes.map(n=>point(nodes.get(n))),center=[0,1,2].map(i=>ps.reduce((s,p)=>s+p[i],0)/ps.length);f.center=center;
      ps.forEach((p,i)=>{positions.push(...center,...p,...ps[(i+1)%ps.length]);triangles.push(f);});
    }
    const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(positions,3));
    const surface=new T.Mesh(geometry,new T.MeshBasicMaterial({color:0x395d70,side:T.DoubleSide,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1}));surface.updateMatrixWorld(true);
    const ray=new T.Raycaster(),scale=new T.Box3().setFromObject(surface).getSize(new T.Vector3()).length()||1;
    function hits(camera,rect,x,y){camera.updateMatrixWorld(true);ray.setFromCamera(new T.Vector2((x-rect.left)/rect.width*2-1,1-(y-rect.top)/rect.height*2),camera);return ray.intersectObject(surface,false);}
    function screen(camera,rect,p){const v=new T.Vector3(...p).project(camera);return{x:rect.left+(v.x+1)*rect.width/2,y:rect.top+(1-v.y)*rect.height/2,z:v.z};}
    function visible(camera,rect,p,element){const q=screen(camera,rect,p);if(q.z < -1||q.z>1)return false;const h=hits(camera,rect,q.x,q.y)[0];if(!h)return true;return h.point.distanceTo(new T.Vector3(...p))<scale*1e-5||(element!=null&&triangles[h.faceIndex]?.element===element);}
    function pick(camera,rect,x,y,mode='node',visibleOnly=true){
      if(mode!=='node'){const h=hits(camera,rect,x,y)[0],f=h&&triangles[h.faceIndex];return f?(mode==='face'?f.nodes.slice():[f.element]):[];}
      const candidates=[...nodes.values()].map(n=>({n,q:screen(camera,rect,point(n))})).filter(({q})=>q.z>=-1&&q.z<=1&&Math.hypot(q.x-x,q.y-y)<=10).sort((a,b)=>Math.hypot(a.q.x-x,a.q.y-y)-Math.hypot(b.q.x-x,b.q.y-y)||a.q.z-b.q.z);
      const hit=candidates.find(({n})=>!visibleOnly||visible(camera,rect,point(n)));return hit?[hit.n.id]:[];
    }
    function box(camera,rect,bounds,mode='node',visibleOnly=true){
      const inside=p=>{const q=screen(camera,rect,p);return q.z>=-1&&q.z<=1&&q.x>=bounds[0]&&q.x<=bounds[2]&&q.y>=bounds[1]&&q.y<=bounds[3];};
      if(mode==='node')return [...nodes.values()].filter(n=>inside(point(n))&&(!visibleOnly||visible(camera,rect,point(n)))).map(n=>n.id);
      return [...new Set(faces.filter(f=>inside(f.center)&&(!visibleOnly||visible(camera,rect,f.center,f.element))).flatMap(f=>mode==='face'?f.nodes:[f.element]))];
    }
    return {surface,faces,nodes,pick,box,dispose(){geometry.dispose();surface.material.dispose();}};
  }
  function create({THREE:T,scene,canvas,getCamera,getControls,mesh,onChange,selected=[],mode='node'}){
    const picker=createPicker(T,mesh),group=new T.Group(),hidden=scene.children.filter(o=>!o.isLight&&!o.isCamera).map(o=>[o,o.visible]);
    for(const [o]of hidden)o.visible=false;
    group.add(picker.surface);scene.add(group);
    const edges=[],seen=new Set();for(const f of picker.faces)for(let i=0;i<f.nodes.length;i++){const ns=[f.nodes[i],f.nodes[(i+1)%f.nodes.length]],k=key(ns);if(seen.has(k))continue;seen.add(k);edges.push(...point(picker.nodes.get(ns[0])),...point(picker.nodes.get(ns[1])));}
    const geometry=values=>{const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(values,3));return g;};
    group.add(new T.LineSegments(geometry(edges),new T.LineBasicMaterial({color:0x6fcdbb})));
    const points=new T.Points(geometry([...picker.nodes.values()].flatMap(point)),new T.PointsMaterial({color:0xbcd8e5,size:5,sizeAttenuation:false}));group.add(points);
    let highlight=null,selection=new Set(selected),tool='pick',visibleOnly=true,start=null,disposed=false;
    const bounds=document.createElement('div');bounds.className='wb-proposal-box';document.body.appendChild(bounds);
    const listeners=[],listen=(target,event,fn)=>{target.addEventListener(event,fn,true);listeners.push([target,event,fn]);};
    const stop=e=>{e.preventDefault();e.stopImmediatePropagation();};
    function update(){
      if(highlight){group.remove(highlight);highlight.geometry.dispose();highlight.material.dispose();}
      const values=mode==='element'?picker.faces.filter(f=>selection.has(f.element)).flatMap(f=>f.nodes.flatMap((n,i)=>[...point(picker.nodes.get(n)),...point(picker.nodes.get(f.nodes[(i+1)%f.nodes.length]))])):[...selection].filter(n=>picker.nodes.has(n)).flatMap(n=>point(picker.nodes.get(n)));
      highlight=mode==='element'?new T.LineSegments(geometry(values),new T.LineBasicMaterial({color:0xffd257,depthTest:false})):new T.Points(geometry(values),new T.PointsMaterial({color:0xffd257,size:10,sizeAttenuation:false,depthTest:false}));highlight.renderOrder=10;group.add(highlight);
      points.visible=mode!=='element';onChange?.([...selection].sort((a,b)=>a-b));
    }
    function choose(found,operation){if(operation==='replace')selection.clear();for(const id of found)operation==='subtract'?selection.delete(id):selection.add(id);update();}
    listen(canvas,'pointerdown',e=>{if(tool==='navigate'||e.button!==0)return;stop(e);start={x:e.clientX,y:e.clientY,operation:e.ctrlKey||e.metaKey?'subtract':e.shiftKey?'add':'replace'};canvas.setPointerCapture?.(e.pointerId);});
    listen(canvas,'pointermove',e=>{if(!start)return;stop(e);if(tool==='box'){Object.assign(bounds.style,{display:'block',left:Math.min(start.x,e.clientX)+'px',top:Math.min(start.y,e.clientY)+'px',width:Math.abs(e.clientX-start.x)+'px',height:Math.abs(e.clientY-start.y)+'px'});}});
    listen(canvas,'pointerup',e=>{if(!start)return;stop(e);const s=start;start=null;bounds.style.display='none';canvas.releasePointerCapture?.(e.pointerId);const rect=canvas.getBoundingClientRect(),camera=getCamera();choose(tool==='box'?picker.box(camera,rect,[Math.min(s.x,e.clientX),Math.min(s.y,e.clientY),Math.max(s.x,e.clientX),Math.max(s.y,e.clientY)],mode,visibleOnly):Math.hypot(s.x-e.clientX,s.y-e.clientY)<5?picker.pick(camera,rect,e.clientX,e.clientY,mode,visibleOnly):[],s.operation);});
    listen(canvas,'pointercancel',()=>{start=null;bounds.style.display='none';});
    for(const event of ['click','dblclick','mousedown','mouseup','mousemove','contextmenu'])listen(canvas,event,e=>stop(e));
    update();
    return {
      get:()=>[...selection].sort((a,b)=>a-b),
      set(ids){selection=new Set(ids);update();},
      configure(options){if(options.mode&&options.mode!==mode){const changed=(options.mode==='element')!==(mode==='element');mode=options.mode;if(changed)selection.clear();}if(options.tool)tool=options.tool;if(options.visibleOnly!==undefined){visibleOnly=options.visibleOnly;points.material.depthTest=visibleOnly;}update();},
      fit(){const box=new T.Box3().setFromObject(group),center=box.getCenter(new T.Vector3()),controls=getControls(),camera=getCamera(),span=box.getSize(new T.Vector3()).length()||1,direction=camera.position.clone().sub(controls.target).normalize();controls.target.copy(center);if(camera.isOrthographicCamera){const aspect=canvas.clientWidth/Math.max(1,canvas.clientHeight);camera.left=-span*Math.max(1,aspect)*.65;camera.right=-camera.left;camera.top=span*Math.max(1,1/aspect)*.65;camera.bottom=-camera.top;camera.zoom=1;}camera.position.copy(center).addScaledVector(direction,span*2.5);camera.updateProjectionMatrix();controls.update();},
      dispose(){if(disposed)return;disposed=true;for(const [target,event,fn]of listeners)target.removeEventListener(event,fn,true);bounds.remove();scene.remove(group);group.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});for(const [o,visible]of hidden)if(o.parent===scene)o.visible=visible;}
    };
  }
  return Object.freeze({surfaces,createPicker,create});
}));
