const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app/cad-workspace.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));

function fixture({edgeCount=4}={}){
  let workspace,elements=[],view={},busy=false,visible=true,draws=0;
  const calls={requests:[],errors:[],messages:[],modes:[],appends:[]},listeners=new Map(),owned={elements:[],properties:[]};
  const session={cadId:'a'.repeat(32),revision:0,filename:'fixture.step',history:[],preview:{},topology:{discrete:false,bounds:[0,0,0,10,10,10],faces:[1,2,3].map(id=>({id,type:'Plane',area:10,bounds:[0,0,id,10,10,id],center:[5,5,id],normal:[0,0,1]})),edges:Array.from({length:edgeCount},(_,i)=>({id:i+1,type:'Line',length:10})),volumes:[{id:1}],layeredSweeps:[]}};
  const match=(element,selector)=>{
    if(selector.startsWith('.'))return String(element.attrs.class||'').split(/\s+/).includes(selector.slice(1));
    const parsed=selector.match(/^\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]$/);return !!parsed&&Object.hasOwn(element.attrs,parsed[1])&&(parsed[2]===undefined||element.attrs[parsed[1]]===parsed[2]);
  };
  const panel={querySelectorAll:selector=>elements.filter(el=>match(el,selector)),querySelector:selector=>elements.find(el=>match(el,selector))||null};
  function attrs(text){return Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));}
  function node(a,value=''){
    const handlers={},classes=new Set((a.class||'').split(/\s+/));
    const element={attrs:a,dataset:{},value,checked:false,disabled:false,open:false,textContent:'',className:a.class||'',onclick:null,
      classList:{toggle(key,on){if(on)classes.add(key);else classes.delete(key);},contains:key=>classes.has(key)},setAttribute(key,value){a[key]=value;},addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),dispatch(name){for(const fn of handlers[name]||[])fn({target:element});}};
    for(const [key,v] of Object.entries(a))if(key.startsWith('data-'))element.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;
    return element;
  }
  function draw(){
    draws++;view=workspace.render();elements=[];const html=view.body+view.foot;
    for(const m of html.matchAll(/<input\b([^>]+)>|<select\b([^>]+)>([\s\S]*?)<\/select>|<button\b([^>]+)>/g)){
      const a=attrs(m[1]||m[2]||m[4]);
      const options=m[3]?[...m[3].matchAll(/<option\b([^>]+)>([^<]*)<\/option>/g)]:[],option=options.find(o=>/\bselected\b/.test(o[1]))||options[0];
      const element=node(a,option?attrs(option[1]).value:a.value||'');element.checked=/\bchecked\b/.test(m[1]||'');elements.push(element);
    }
    for(const m of html.matchAll(/<(?:div|span|details)\b([^>]+)>/g)){
      const a=attrs(m[1]);if(!a.id&&!String(a.class||'').includes('cad-sizing'))continue;const element=node(a);element.open=/\bopen\b/.test(m[1]);elements.push(element);
    }
    workspace.bind();return view;
  }
  const emit=detail=>(listeners.get('webmesh:cad-selection')||[]).forEach(fn=>fn({detail}));
  const emitChange=detail=>(listeners.get('webmesh:change')||[]).forEach(fn=>fn({detail}));
  const engine={setCadGeometry(){},clearCadGeometry(){},setCadSelectionMode(mode){calls.modes.push(mode);},getCadState:()=>({visible}),setCadVisible(value){visible=value;},setCadSplitPlane(){},selectCad:emit,getMeshOwner:()=>owned};
  const document={activeElement:null,getElementById:id=>id==='wb-panel-body'?panel:elements.find(el=>el.attrs.id===id)||null,querySelector:selector=>panel.querySelector(selector),querySelectorAll:selector=>panel.querySelectorAll(selector)};
  const context={window:{addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);}},document,location:{protocol:'http:'},File,btoa,atob,structuredClone,AbortController,setTimeout,clearTimeout,
    async fetch(url,request){const data=JSON.parse(request.body);calls.requests.push({url,data});const action=url.split('/').pop();let result;
      if(action==='import')result=structuredClone(session);
      else if(action==='prepare'||action==='undo')result={...structuredClone(session),revision:1,history:[{label:'Imported'},{label:'Changed'}]};
      else if(action==='export')result={filename:'fixture.brep',format:'brep',content:btoa('prepared'),history:[]};
      else if(action==='mesh')result={mesh:{nodes:[{id:1,x:0,y:0,z:0}],elements:[{id:1,type:'CHEXA',pid:1,nodes:[1]}]},quality:{components:1,minScaledJacobian:0.45,achievedEdgeDivisions:[{id:2,requested:3,achieved:3}],optimization:{method:'HighOrder',initialMinScaledJacobian:0.11,finalMinScaledJacobian:0.45}}};
      else throw Error('Unexpected API '+url);return {ok:true,json:async()=>result};}
  };
  const hooks={engine:()=>engine,isBusy:()=>busy,render:draw,refresh(){},name(){},log(){},message:(text,error)=>calls.messages.push({text,error}),async appendMesh(result,name,options){calls.appends.push({result,name,options});Object.assign(owned,{elements:[100],properties:[3]});await Promise.resolve();emitChange({reason:'history',reasons:['model','history']});return {elements:[100],properties:[3],stale:false};},async run(fn){if(busy)return;busy=true;try{await fn();}catch(error){calls.errors.push(error.message);}finally{busy=false;}}};
  vm.runInNewContext(source,context);workspace=context.window.WebMeshCadWorkspace.create(hooks);draw();
  const api={workspace,calls,emit,emitChange,document,draw,get draws(){return draws;},get view(){return view;},get visible(){return visible;},setOwner(elements,properties=[]){Object.assign(owned,{elements,properties});},field:key=>panel.querySelector(`[data-cad="${key}"]`),find:selector=>panel.querySelector(selector),
    set(key,value,event='change'){const input=api.field(key);assert.ok(input,'Rendered field '+key);input.value=String(value);document.activeElement=input;input.dispatch(event);},
    async action(name){const button=panel.querySelector(`[data-cad-action="${name}"]`);assert.ok(button,'Rendered action '+name);await button.onclick();},
    async start(){await workspace.importFile(new File(['STEP'],'fixture.step'));await api.action('next');api.set('method','quad');},
    async serialize(){return workspace.serialize();}};
  return api;
}

test('local edge divisions and face sizes reach the mesh API with explicit revision ownership',async()=>{
  const f=fixture();await f.start();f.set('localRule','divisions');f.set('localIds','2-3');f.set('localValue',3);await f.action('add-size');
  f.set('localEntity','face');assert.equal(f.field('localIds').value,'');f.set('localIds','1');f.set('localValue',0.4);await f.action('add-size');await f.action('mesh');
  assert.deepEqual(f.calls.errors,[]);const payload=f.calls.requests.find(r=>r.url.endsWith('/mesh')).data;
  assert.deepEqual(payload.edgeDivisions,[{id:2,divisions:3},{id:3,divisions:3}]);assert.deepEqual(payload.faceSizes,[{id:1,size:0.4}]);assert.equal(payload.cadId,'a'.repeat(32));assert.equal(payload.revision,0);
});

test('edge sizing replacement removes the conflicting division rule and removal persists',async()=>{
  const f=fixture();await f.start();f.set('localIds','2');f.set('localRule','divisions');f.set('localValue',3);await f.action('add-size');
  f.set('localRule','size');f.set('localValue',0.5);await f.action('add-size');let saved=await f.serialize();assert.deepEqual(plain(saved.settings.localSizing),{edgeSizes:[{id:2,size:0.5}],faceSizes:[],edgeDivisions:[]});
  await f.find('[data-remove-size="edgeSizes:2"]').onclick();saved=await f.serialize();assert.deepEqual(plain(saved.settings.localSizing.edgeSizes),[]);
});

test('entity picks use the correct selection channel for edge and face sizing',async()=>{
  const f=fixture();await f.start();await f.action('pick-local');assert.equal(f.calls.modes.at(-1),'edge');f.emit({edges:[2,3],faces:[]});await f.action('use-local');assert.equal(f.field('localIds').value,'2, 3');
  f.set('localEntity','face');await f.action('pick-local');assert.equal(f.calls.modes.at(-1),'face');f.emit({edges:[],faces:[1]});await f.action('use-local');assert.equal(f.field('localIds').value,'1');
});

test('unsafe IDs, invalid division counts and unknown revision IDs reject without saved controls',async()=>{
  const f=fixture();await f.start();
  for(const invalid of ['9007199254740992','1-5000,5001','0','2-1','bad']){f.set('localIds',invalid);await f.action('add-size');assert.equal(f.calls.messages.at(-1).error,true);}
  f.set('localIds','999');await f.action('add-size');assert.match(f.calls.messages.at(-1).text,/outside this CAD revision/);
  f.set('localIds','2');f.set('localRule','divisions');for(const invalid of [0,2.5,201]){f.set('localValue',invalid);await f.action('add-size');assert.equal(f.calls.messages.at(-1).error,true);}
  assert.deepEqual(plain((await f.serialize()).settings.localSizing),{edgeSizes:[],faceSizes:[],edgeDivisions:[]});
});

test('ID-list clicks gracefully report invalid draft text instead of throwing',async()=>{
  const f=fixture();await f.start();f.set('localIds','bad');assert.doesNotThrow(()=>f.find('[data-size-entity="1"]').onclick());assert.match(f.calls.messages.at(-1).text,/Use entity IDs/);
});

test('local control batches and saved projects reject above256 without partial changes',async()=>{
  const f=fixture({edgeCount:300});await f.start();f.set('localIds','1-257');await f.action('add-size');assert.match(f.calls.messages.at(-1).text,/at most 256/);
  const saved=await f.serialize();assert.deepEqual(plain(saved.settings.localSizing.edgeSizes),[]);saved.settings.localSizing.edgeSizes=Array.from({length:257},(_,i)=>({id:i+1,size:1}));
  const requests=f.calls.requests.length;await assert.rejects(f.workspace.stageRestore(saved),/exceeds 256 local controls/);assert.equal(f.calls.requests.length,requests);assert.equal(f.workspace.hasGeometry(),true);
});

test('global typing invalidates success without replacing the focused form controls',async()=>{
  const f=fixture();await f.start();await f.action('mesh');const input=f.field('size'),draws=f.draws;
  f.set('size',2,'input');assert.equal(f.draws,draws);assert.equal(f.field('size'),input);assert.equal(f.workspace.getState().report,null);
  assert.match(f.document.getElementById('cad-report').textContent,/Mesh settings changed/);assert.equal((await f.serialize()).mesh.stale,true);
});

test('mesh report exposes achieved edge divisions and high-order quality improvement',async()=>{
  const f=fixture();await f.start();await f.action('mesh');const text=f.workspace.getState().report.text;assert.match(text,/requested → actual.*2: 3 → 3/);assert.match(text,/HighOrder optimization minSJ: 0.1100 → 0.4500/);
});

test('local sizing stays expanded while changing entity and rule before any controls exist',async()=>{
  const f=fixture();await f.start();f.find('.cad-sizing').open=true;f.set('localRule','divisions');assert.equal(f.find('.cad-sizing').open,true);f.set('localEntity','face');assert.equal(f.find('.cad-sizing').open,true);
});

test('valid sizing survives project restoration and a new CAD revision clears it',async()=>{
  const f=fixture();await f.start();f.set('localIds','2');f.set('localValue',0.3);await f.action('add-size');const saved=await f.serialize();
  const staged=await f.workspace.stageRestore(saved);f.workspace.commitRestore(staged);f.draw();assert.deepEqual(plain((await f.serialize()).settings.localSizing.edgeSizes),[{id:2,size:0.3}]);
  await f.find('[data-cad-stage="prepare"]').onclick();f.set('prepTool','split');f.set('position',5);await f.action('apply');assert.deepEqual(f.calls.errors,[]);assert.deepEqual(plain((await f.serialize()).settings.localSizing),{edgeSizes:[],faceSizes:[],edgeDivisions:[]});
});

test('invalid restored controls are discarded and a saved success report is invalidated',async()=>{
  const f=fixture();await f.start();await f.action('mesh');const saved=await f.serialize();saved.settings.localSizing={edgeSizes:[{id:999,size:1},{id:2,size:1}],faceSizes:[],edgeDivisions:[{id:2,divisions:3},{id:3,divisions:2.5}]};
  f.workspace.commitRestore(await f.workspace.stageRestore(saved));f.draw();const restored=await f.serialize();assert.deepEqual(plain(restored.settings.localSizing),{edgeSizes:[],faceSizes:[],edgeDivisions:[{id:2,divisions:3}]});assert.equal(restored.mesh.stale,true);assert.equal(f.workspace.getState().report,null);
});

test('Undo removes the obsolete quality report and reveals CAD; Redo remains stale until regeneration',async()=>{
  const f=fixture();await f.start();f.workspace.activate(true);f.set('localRule','divisions');f.set('localIds','2');f.set('localValue',3);await f.action('add-size');await f.action('mesh');
  assert.ok(f.workspace.getState().report);assert.equal(f.visible,false);
  f.setOwner([]);f.emitChange({reason:'undo',reasons:['model','undo']});
  assert.equal(f.workspace.getState().report,null);assert.equal(f.visible,true);assert.match(f.view.body,/the model changed/);
  const saved=await f.serialize();assert.equal(saved.report,null);assert.equal(saved.mesh,undefined);assert.deepEqual(plain(saved.settings.localSizing.edgeDivisions),[{id:2,divisions:3}]);
  f.setOwner([100],[3]);f.emitChange({reason:'redo',reasons:['model','redo']});
  assert.equal(f.workspace.getState().report,null);assert.equal((await f.serialize()).mesh.stale,true);
  await f.action('mesh');assert.ok(f.workspace.getState().report);assert.equal((await f.serialize()).mesh.stale,false);assert.equal(f.visible,false);
});

test('view and selection events preserve quality while a model edit invalidates unchanged element IDs',async()=>{
  const f=fixture();await f.start();await f.action('mesh');const report=f.workspace.getState().report;
  for(const reason of ['view','display','selection','cad-selection'])f.emitChange({reason,reasons:[reason]});
  assert.equal(f.workspace.getState().report,report);
  f.emitChange({reason:'history',reasons:['model','history']});assert.equal(f.workspace.getState().report,null);assert.equal((await f.serialize()).mesh.stale,true);
});

test('saving reconciles live ownership even when no history event was delivered',async()=>{
  const f=fixture();await f.start();await f.action('mesh');f.setOwner([]);
  const saved=await f.serialize();assert.equal(saved.mesh,undefined);assert.equal(saved.report,null);
});

test('restoring an incomplete owned mesh clears saved quality and shows CAD without adopting missing IDs',async()=>{
  const f=fixture();await f.start();await f.action('mesh');const saved=await f.serialize();saved.mesh.elements=[100,101];
  f.workspace.commitRestore(await f.workspace.stageRestore(saved));f.draw();
  assert.equal(f.workspace.getState().report,null);assert.equal(f.visible,true);const restored=await f.serialize();assert.equal(restored.mesh.stale,true);assert.deepEqual(plain(restored.mesh.elements),[100]);
});

test('restoring a complete live owned mesh preserves its quality report',async()=>{
  const f=fixture();await f.start();await f.action('mesh');const saved=await f.serialize();
  f.workspace.commitRestore(await f.workspace.stageRestore(saved));assert.equal(f.workspace.getState().report.text,saved.report.text);assert.equal(f.visible,false);
});
