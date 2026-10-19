/* CAD preparation UI. Geometry stays separate from the finite-element model. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const field = (key, label, value, type='number', attrs='') => `<label class="wb-field"><span>${label}</span><input data-cad="${key}" aria-label="${label}" type="${type}" value="${esc(value)}" ${type==='number'?'step="any"':''} ${attrs}></label>`;
  const select = (key,label,options,value) => `<label class="wb-field"><span>${label}</span><select data-cad="${key}" aria-label="${label}">${options.map(([v,t])=>`<option value="${v}" ${String(v)===String(value)?'selected':''}>${t}</option>`).join('')}</select></label>`;
  const btn = (key,text,cls='') => `<button type="button" class="wb-btn ${cls}" data-cad-action="${key}">${text}</button>`;
  const section = (label,content) => `<section class="wb-section"><div class="wb-section-title">${label}</div>${content}</section>`;
  const passageDefault=()=>({axis:'x',center:[0,0,0],width:6,height:6,range:[0,10]});
  const MAX_LOCAL_CONTROLS=256;
  function checkSavedControlCounts(data){for(const key of ['edgeSizes','faceSizes','edgeDivisions'])if(Array.isArray(data?.settings?.localSizing?.[key])&&data.settings.localSizing[key].length>MAX_LOCAL_CONTROLS)throw Error(`Saved ${key} exceeds ${MAX_LOCAL_CONTROLS} local controls. Reduce the saved control list before restoring this project.`);}
  function ids(text) {
    if(!String(text).trim())return [];
    const result=new Set();
    for(const token of String(text).trim().split(/[\s,;]+/)) {
      if(!/^\d+(?:-\d+)?$/.test(token))throw Error('Use entity IDs separated by commas, or ranges such as 3-7.');
      const [a,b=a]=token.split('-').map(Number);
      if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<1||b<a||b-a>5000)throw Error('Enter safe positive integer IDs or a valid ascending range.');
      for(let n=a;n<=b;n++){result.add(n);if(result.size>5000)throw Error('Use at most 5,000 entity IDs per selection.');}
    }
    return [...result];
  }
  const finite = (value,label) => {if(String(value).trim()===''||!Number.isFinite(Number(value)))throw Error(`Enter a finite ${label}.`);return Number(value);};
  const base64 = buffer => {let s='';const bytes=new Uint8Array(buffer);for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(s);};
  const fromBase64 = text => Uint8Array.from(atob(text),c=>c.charCodeAt(0));
  window.WebMeshCadWorkspace = {create(hooks) {
    let source=null,session=null,stage='prepare',tool='inspect',selected=[],selectedEdges=[],report=null,active=false,generated=null,committingMesh=false,auditHistory=[],passages=[passageDefault()],localSizingOpen=false,localSizing={edgeSizes:[],faceSizes:[],edgeDivisions:[]};
    const values={axis:'x',position:0,volumes:'',faceIds:'',method:'sweep',order:'1',size:1.5,layers:8,divisions:6,sourceFace:'',targetFace:'',sweepAxis:'z',localEntity:'edge',localRule:'size',localValue:3,localIds:''};
    const engine=hooks.engine;
    const root=()=>document.getElementById('wb-panel-body');
    const get=key=>root()?.querySelector(`[data-cad="${key}"]`)?.value??values[key];
    const remember=()=>{root()?.querySelectorAll('[data-cad]').forEach(el=>{values[el.dataset.cad]=el.value;});root()?.querySelectorAll('[data-passage]').forEach(el=>{const [index,key,component]=el.dataset.passage.split(':');if(!passages[index])return;if(component!=null)passages[index][key][Number(component)]=el.value;else passages[index][key]=el.value;});const sizing=root()?.querySelector('.cad-sizing');if(sizing)localSizingOpen=sizing.open;};
    const meshParameter=key=>['method','order','size','layers','divisions','sourceFace','targetFace','sweepAxis'].includes(key)||/^layer\d+$/.test(key);
    function invalidateMeshReport(message='Mesh settings changed. Generate again to update the CAD mesh.'){
      if(generated)generated.stale=true;report=null;
      const previous=document.getElementById('cad-report');
      if(previous){previous.className='cad-stale';previous.textContent=message;}
      document.getElementById('cad-verified-divisions')?.remove?.();
    }
    function matchesGenerated(owned){
      const expected=new Set((generated?.elements||[]).map(Number));
      return expected.size>0&&expected.size===owned.elements.length&&owned.elements.every(id=>expected.has(Number(id)));
    }
    function passageControls(){
      const input=(i,key,label,value,component)=>`<label><span>${label}</span><input data-passage="${i}:${key}${component==null?'':':'+component}" aria-label="Passage ${i+1} ${label}" type="number" step="any" value="${esc(value)}"></label>`;
      return passages.map((p,i)=>`<details class="cad-passage" open><summary>Passage ${i+1} · ${p.axis.toUpperCase()} <button type="button" data-remove-passage="${i}" aria-label="Remove passage ${i+1}">×</button></summary><label class="wb-field"><span>Through axis</span><select data-passage="${i}:axis" aria-label="Passage ${i+1} axis">${['x','y','z'].map(a=>`<option value="${a}" ${p.axis===a?'selected':''}>${a.toUpperCase()}</option>`).join('')}</select></label><div class="cad-passage-row">${p.center.map((v,j)=>input(i,'center','Center '+['X','Y','Z'][j],v,j)).join('')}</div><div class="cad-passage-row two">${input(i,'width','Width',p.width)}${input(i,'height','Height',p.height)}</div><div class="cad-passage-row two">${input(i,'range','From',p.range[0],0)}${input(i,'range','To',p.range[1],1)}</div></details>`).join('')+btn('add-passage','Add passage');
    }
    async function api(path,payload) {
      if(location.protocol==='file:')throw Error('Start python3 server.py and open http://127.0.0.1:8765 to work with CAD.');
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),110000);
      try {
        const response=await fetch('/api/cad/'+path,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        const data=await response.json();
        if(!response.ok||data.error)throw Error(data.error||'CAD operation failed.');
        return data;
      } catch(error) {
        if(error.name==='AbortError')throw Error('The CAD operation timed out. Reduce mesh density or simplify the selected geometry.');
        if(error instanceof TypeError)throw Error('Cannot reach the local CAD service. Start python3 server.py.');
        throw error;
      } finally {clearTimeout(timer);}
    }
    function token(){if(!session)throw Error('Import CAD geometry first.');return {cadId:session.cadId,revision:session.revision};}
    function accept(data,{fit=true}={}) {
      Object.keys(values).filter(key=>/^layer\d+$/.test(key)).forEach(key=>delete values[key]);
      localSizing={edgeSizes:[],faceSizes:[],edgeDivisions:[]};localSizingOpen=false;selectedEdges=[];values.localIds='';
      session=data;if(data.topology.discrete){stage='mesh';values.method='tet';}selected=[];values.faceIds='';values.sourceFace='';values.targetFace='';report=null;
      engine().setCadGeometry(data.preview,{name:source?.name||data.filename,cadId:data.cadId,revision:data.revision,fit});
      engine().setCadSelectionMode(active?'face':'none');
      hooks.refresh();
    }
    async function importFile(file) {
      if(file.size>23*1024*1024)throw Error('Choose a CAD file smaller than 23 MB.');
      hooks.message(`Reading ${file.name}…`);
      const format=({stp:'step',igs:'iges'}[file.name.split('.').pop().toLowerCase()]||file.name.split('.').pop().toLowerCase());
      const data=await api('import',{filename:file.name,format,content:base64(await file.arrayBuffer())});
      source=file;generated=null;auditHistory=[];stage='prepare';tool='inspect';accept(data);hooks.name(file.name.replace(/\.[^.]+$/,''));hooks.render();
      hooks.log(`Imported CAD ${file.name}`);hooks.message(`${file.name}: geometry displayed · ${session.topology.faces.length} faces.`);
    }
    function faces(){return session?.topology?.faces||[];}
    function volumes(){return session?.topology?.volumes||[];}
    function faceId(face){return Number(face.id??face.tag);}
    function setSelected(list) {
      selected=[...new Set(list)];values.faceIds=selected.join(', ');
      engine().selectCad({faces:selected,edges:[]});syncSelection();
    }
    function syncSelection() {
      const input=root()?.querySelector('[data-cad="faceIds"]');if(input&&document.activeElement!==input)input.value=selected.join(', ');
      root()?.querySelectorAll('[data-face]').forEach(el=>{el.classList.toggle('selected',selected.includes(Number(el.dataset.face)));el.setAttribute('aria-pressed',String(selected.includes(Number(el.dataset.face))));});
      const count=document.getElementById('cad-selection-count');if(count)count.textContent=`${selected.length} selected`;
      const localCount=document.getElementById('cad-local-selection');if(localCount)localCount.textContent=`${selected.length} faces · ${selectedEdges.length} edges selected`;
    }
    function sizingControls(){
      const rows=Object.entries(localSizing).flatMap(([kind,controls])=>{
        const groups=new Map();
        for(const control of controls){const value=kind==='edgeDivisions'?control.divisions:control.size;if(!groups.has(value))groups.set(value,[]);groups.get(value).push(control);}
        return [...groups].map(([value,items])=>{
          const content=items.map(control=>`<div class="cad-size-row"><span>${kind==='faceSizes'?'Face':'Edge'} ${control.id}</span><span>${kind==='edgeDivisions'?control.divisions+' divisions':'Size '+control.size}</span><button type="button" data-remove-size="${kind}:${control.id}" aria-label="Remove ${kind} ${control.id}">×</button></div>`).join('');
          return items.length>3?`<details class="cad-size-group"><summary>${items.length} ${kind==='faceSizes'?'faces':'edges'} · ${kind==='edgeDivisions'?value+' divisions':'size '+value}</summary>${content}</details>`:content;
        });
      });
      const count=Object.values(localSizing).reduce((sum,controls)=>sum+controls.length,0);
      const entities=values.localEntity==='face'?faces():session.topology.edges||[];
      return `<details class="wb-section cad-sizing" ${localSizingOpen?'open':''}><summary class="wb-section-title">Local sizing${count?' ('+count+')':''}</summary>${rows.join('')}${select('localEntity','Entities',[['edge','Edges'],['face','Faces']],values.localEntity)}${select('localRule','Control',values.localEntity==='edge'?[['size','Element size'],['divisions','Edge divisions']]:[['size','Element size']],values.localRule)}${field('localIds','Entity IDs',values.localIds,'text','placeholder="Pick or enter IDs"')}<div class="cad-inline-actions">${btn('pick-local','Pick '+values.localEntity+'s')}${btn('use-local','Use selected')}</div><span id="cad-local-selection" class="wb-footnote">${selected.length} faces · ${selectedEdges.length} edges selected</span>${field('localValue',values.localRule==='divisions'?'Divisions':'Local size',values.localValue)}${btn('add-size','Apply control')}<details class="cad-history"><summary>${values.localEntity==='face'?'Face':'Edge'} ID list</summary><div class="cad-entity-list">${entities.map(entity=>`<button type="button" data-size-entity="${entity.id}" title="${esc(entity.type||'')} ${Number(entity.length??entity.area??0).toPrecision(4)}">${entity.id}</button>`).join('')}</div></details><p class="wb-footnote">Local controls refine selected features while the global size governs the bulk. Division counts refer to linear element edges; midside nodes are additional.</p></details>`;
    }
    function addSizeControl(){
      remember();const requested=ids(values.localIds),entity=values.localEntity,rule=entity==='face'?'size':values.localRule;
      if(!requested.length)throw Error('Pick faces or edges and use the selection, or enter entity IDs.');
      const available=new Set((entity==='face'?faces():session.topology.edges||[]).map(e=>e.id));if(requested.some(id=>!available.has(id)))throw Error('A local control references an entity outside this CAD revision.');
      const value=finite(values.localValue,'local mesh control');if(value<=0||rule==='divisions'&&(!Number.isInteger(value)||value>200))throw Error('Enter a positive size or an integer division count from 1 to 200.');
      const key=entity==='face'?'faceSizes':rule==='divisions'?'edgeDivisions':'edgeSizes';
      const replacement=localSizing[key].filter(item=>!requested.includes(item.id));replacement.push(...requested.map(id=>({id,[rule==='divisions'?'divisions':'size']:value})));
      if(replacement.length>MAX_LOCAL_CONTROLS)throw Error(`Use at most ${MAX_LOCAL_CONTROLS} local controls of each type. No controls were changed.`);localSizing[key]=replacement;
      if(entity==='edge'){const other=key==='edgeSizes'?'edgeDivisions':'edgeSizes';localSizing[other]=localSizing[other].filter(item=>!requested.includes(item.id));}
      if(generated)generated.stale=true;report=null;localSizingOpen=true;hooks.render();hooks.message(`Applied local ${rule} to ${requested.length} ${entity}${requested.length===1?'':'s'}. Generate the mesh to apply it.`);
    }
    function guide() {
      if(!active||!session||stage!=='prepare'||tool!=='split'){engine()?.setCadSplitPlane?.(null);return;}
      const position=Number(get('position'));if(Number.isFinite(position))engine().setCadSplitPlane?.({axis:get('axis'),position});
    }
    function render() {
      const has=!!session;
      let body=section('Source geometry',`<div class="cad-source"><span title="${esc(source?.name)}">${esc(source?.name||'No CAD imported')}</span>${btn('import',has?'Replace…':'Import CAD…')}</div>${has?`<div class="cad-summary">${volumes().length} solids · ${faces().length} faces · revision ${session.revision}</div><label class="wb-check"><input type="checkbox" data-cad-visible ${engine()?.getCadState?.().visible!==false?'checked':''}> Show geometry</label>`:'<p class="wb-hint">STEP · IGES · BREP · STL<br>Geometry appears immediately after import.</p>'}`);
      if(!has)return {body,foot:'',ready:false};
      body+=`<div class="cad-stages" role="tablist" aria-label="CAD workflow">${['prepare','mesh'].map(s=>`<button role="tab" data-cad-stage="${s}" aria-selected="${s===stage}" ${s==='prepare'&&session.topology.discrete?'disabled title="STL contains discrete facets; import STEP or BREP to prepare geometry"':''}>${s==='prepare'?'Prepare geometry':'Mesh'}</button>`).join('')}</div>`;
      if(stage==='prepare') {
        body+=section('Geometry tools',select('prepTool','Operation',[['inspect','Inspect / select'],['split','Split solid by plane'],['defeature','Remove faces & heal'],['passages','Simplify holes to passages'],['project','Partition by face projection'],['heal','Heal geometry']],tool));
        if(tool==='split')body+=section('Cutting plane',select('axis','Normal axis',[['x','X'],['y','Y'],['z','Z']],values.axis)+field('position','Position',values.position)+field('volumes','Solid IDs',values.volumes,'text','placeholder="All solids"')+'<p class="wb-footnote">The translucent plane shows the cut. Shared interfaces connect the resulting regions.</p>');
        if(tool==='project')body+=section('Face projection',select('axis','Projection axis',[['x','X'],['y','Y'],['z','Z']],values.axis)+btn('select-floors','Select internal floors')+'<p class="wb-footnote">Select planar floor or end faces. Their outlines divide the solid along this axis into sweepable columns.</p>');
        if(tool==='defeature')body+=`<p class="wb-hint">Select all faces of a hole, fillet, or protrusion. Adjacent surfaces extend to close the removed feature.</p>`;
        if(tool==='passages')body+='<p class="wb-footnote">Selected feature faces are healed, then the defined rectangular passages are cut in the same operation. Keep structurally relevant openings and their surrounding ligaments.</p>'+section('Through passages',passageControls()+'<p class="wb-footnote">Width and height follow the other two global axes in XYZ order. From / To set the extent along the through axis; its center coordinate is ignored.</p>');
        if(tool!=='heal'&&tool!=='split') {
          body+=section('Face selection',field('faceIds','Face IDs',values.faceIds,'text','placeholder="Pick or enter IDs"')+`<div class="cad-inline-actions">${btn('select','Select IDs')}${btn('clear-selection','Clear')}<span id="cad-selection-count">${selected.length} selected</span></div><div class="cad-face-head"><span>ID</span><span>Surface</span><span>Area</span></div><div class="cad-face-list" role="group" aria-label="CAD faces">${faces().map(face=>{const id=faceId(face),b=face.bounds||face.bbox,loc=b?` · ${b.slice(0,3).map(n=>Number(n).toFixed(2)).join(', ')}`:'';return `<button type="button" data-face="${id}" class="${selected.includes(id)?'selected':''}" aria-pressed="${selected.includes(id)}" title="Face ${id}${esc(loc)}"><span>${id}</span><span>${esc(face.type||'Surface')}</span><small>${Number(face.area??face.mass??0).toLocaleString(undefined,{maximumFractionDigits:2})}</small></button>`;}).join('')}</div><p class="wb-footnote">Click faces in the viewport; Ctrl / Cmd adds to the selection. The list also reaches hidden faces.</p>`);
        }
        if(tool==='heal')body+='<p class="wb-hint">Repair small edges and faces, sew surfaces, and rebuild solids. Review the geometry before meshing.</p>';
        const history=[...auditHistory,...(session.history||[])];
        if(history.length)body+=`<details class="cad-history"><summary>Preparation history (${history.length})</summary><ol>${history.map(item=>`<li>${esc(typeof item==='string'?item:item.label||item.description||item.kind||JSON.stringify(item))}</li>`).join('')}</ol></details>`;
      } else {
        body+=section('Mesh method',select('method','Method',(session.topology.discrete?[['tet','Tetrahedral volume'],['tri','Triangular surface']]:[['tet','Tetrahedral volume'],['tri','Triangular surface'],['quad','Quadrilateral surface'],['sweep','Sweep quads → hex'],['layered','Sweep partitioned columns'],['mapped','Map prepared blocks']]),values.method)+select('order','Element order',[[1,'First order'],[2,'Second order']],values.order));
        if(values.method==='sweep')body+=section('Sweep definition',field('sourceFace','Source face',values.sourceFace,'number','min="1" step="1"')+btn('use-source','Use selection as source')+field('targetFace','Target face',values.targetFace,'number','min="1" step="1" placeholder="Detect opposite"')+btn('use-target','Use selection as target')+field('size','Surface size',values.size,'number','min="0.000001"')+field('layers','Through layers',values.layers,'number','min="1" max="80" step="1"')+'<p class="wb-footnote">Choose a planar source face on a constant-section solid. Remove transverse features or split the solid first. The sweep is checked against the prepared CAD.</p>');
        else if(values.method==='layered') {
          const plan=(session.topology.layeredSweeps||[]).find(p=>p.axis===values.sweepAxis);
          body+=section('Column sweep',select('sweepAxis','Sweep axis',[['x','X'],['y','Y'],['z','Z']],values.sweepAxis)+field('size','Surface size',values.size,'number','min="0.000001"'));
          if(plan) {
            body+=section('Layer intervals',`<div class="cad-layer-head"><span>From</span><span>To</span><span>Layers</span></div>${plan.intervals.map((interval,i)=>{const key='layer'+i;if(values[key]==null)values[key]=Math.max(1,Math.ceil((interval.end-interval.start)/Math.max(Number(values.size),0.01)));return `<div class="cad-layer-row"><span>${Number(interval.start).toFixed(3)}</span><span>${Number(interval.end).toFixed(3)}</span><input data-cad="${key}" aria-label="Layers from ${Number(interval.start.toFixed(6))} to ${Number(interval.end.toFixed(6))}" type="number" min="1" max="80" step="1" value="${esc(values[key])}"></div>`;}).join('')}<p class="wb-footnote">${plan.columns.length} columns share these elevations and layer counts.</p>`);
            body+=`<details class="cad-history"><summary>Sweep columns</summary><ol>${plan.columns.map(column=>`<li>Solid ${column.volumeId}: face ${column.sourceFace} → ${column.targetFace}, ${Number(column.min).toFixed(2)} to ${Number(column.max).toFixed(2)}</li>`).join('')}</ol></details>`;
          } else body+='<p class="cad-stale">Partition the solid by projecting its floor or end faces along this axis. Every resulting column must have matching planar ends.</p>';
        }
        else if(values.method==='mapped')body+=section('Block controls',field('divisions','Edge divisions',values.divisions,'number','min="1" max="80" step="1"')+'<p class="wb-footnote">Split solids into compatible blocks with four-sided faces. Matching edge counts produce shared interface nodes.</p>');
        else body+=section('Sizing',field('size','Element size',values.size,'number','min="0.000001"'));
        if(values.method==='sweep')body+=`<div class="cad-inline-actions">${btn('pick-source','Pick source face')}${btn('clear-selection','Clear selection')}</div><div class="wb-footnote" id="cad-selection-count">${selected.length} selected</div>`;
        if(!session.topology.discrete)body+=sizingControls();
      }
      if(generated?.stale)body+='<p class="cad-stale">Geometry, sizing, or the model changed. Generate the CAD mesh again to update it.</p>';
      if(report)body+=`<div id="cad-report" class="wb-report ${report.error?'bad':'good'}">${esc(report.text)}</div>`;
      if(report?.divisions?.length>4)body+=`<details id="cad-verified-divisions" class="cad-history"><summary>Verified edge divisions (${report.divisions.length})</summary><div class="cad-division-head"><span>Edge</span><span>Requested</span><span>Actual</span></div>${report.divisions.map(item=>`<div class="cad-division-row"><span>${esc(item.id)}</span><span>${esc(item.requested)}</span><span>${esc(item.achieved)}</span></div>`).join('')}</details>`;
      body+='<div id="wb-report"></div>';
      const foot=stage==='prepare'?`${btn('undo','Undo preparation')}${tool==='inspect'?btn('next','Continue to mesh','primary'):btn('apply',tool==='split'?'Split solid':tool==='defeature'?'Remove & heal':tool==='passages'?'Create passages':tool==='project'?'Partition solid':'Heal geometry','primary')}`:btn('mesh','Generate mesh','primary');
      return {body,foot,ready:true};
    }
    async function prepare() {
      remember();let operation;
      if(tool==='split')operation={kind:'split',axis:values.axis,position:finite(values.position,'plane position'),volumeIds:ids(values.volumes)};
      else if(tool==='defeature') {const faceIds=ids(values.faceIds);if(!faceIds.length)throw Error('Select the faces to remove.');operation={kind:'defeature',faceIds};}
      else if(tool==='project'){const faceIds=ids(values.faceIds);if(!faceIds.length)throw Error('Select the planar faces to project.');operation={kind:'project',axis:values.axis,faceIds};}
      else if(tool==='passages'){if(!passages.length)throw Error('Define at least one passage.');operation={kind:'passages',faceIds:ids(values.faceIds),passages:passages.map(p=>({axis:p.axis,center:p.center.map(n=>finite(n,'passage center')),width:finite(p.width,'passage width'),height:finite(p.height,'passage height'),range:p.range.map(n=>finite(n,'passage extent'))}))};}
      else operation={kind:'heal'};
      hooks.message('Preparing CAD geometry…');const data=await api('prepare',{...token(),operation});
      accept(data,{fit:false});if(generated)generated.stale=true;hooks.render();hooks.log(operation.kind==='split'?'Split CAD solid':operation.kind==='defeature'?'Removed CAD features':operation.kind==='passages'?'Simplified holes to explicit passages':operation.kind==='project'?'Partitioned CAD by face projection':'Healed CAD');hooks.message('Geometry updated. Review the result before meshing.');
    }
    async function mesh() {
      remember();const method=values.method,isHex=['sweep','layered','mapped'].includes(method);
      const payload={...token(),topology:isHex?'hex':method,dimension:['tri','quad'].includes(method)?2:3,order:Number(values.order),size:method==='mapped'?1:finite(values.size,'element size'),divisions:method==='mapped'?finite(values.divisions,'edge divisions'):6};
      if(isHex)payload.method=method;
      if(method==='sweep') {payload.sourceFace=finite(values.sourceFace,'source face ID');payload.layers=finite(values.layers,'layer count');if(String(values.targetFace).trim())payload.targetFace=finite(values.targetFace,'target face ID');}
      if(method==='layered'){const plan=(session.topology.layeredSweeps||[]).find(p=>p.axis===values.sweepAxis);if(!plan)throw Error('Prepare constant-section columns along this axis before meshing.');payload.axis=values.sweepAxis;payload.layerCounts=plan.intervals.map((interval,i)=>finite(values['layer'+i],`layer count for interval ${i+1}`));}
      Object.assign(payload,structuredClone(localSizing));
      hooks.message('Generating and checking the CAD mesh…');
      const result=await api('mesh',payload);
      committingMesh=true;
      try{generated=await hooks.appendMesh(result,source.name,{...payload,previousMesh:generated,ownerTag:session.cadId});}
      finally{committingMesh=false;}
      const q=result.quality||result.stats?.quality||{};
      report={text:`${result.mesh.nodes.length.toLocaleString()} nodes · ${result.mesh.elements.length.toLocaleString()} elements${q.connectedComponents!=null?'\nConnected regions: '+q.connectedComponents:q.components!=null?'\nConnected regions: '+q.components:''}${q.minScaledJacobian!=null?'\nMinimum scaled Jacobian: '+Number(q.minScaledJacobian).toPrecision(4):''}${q.minDetJac!=null?'\nMinimum Jacobian: '+Number(q.minDetJac).toPrecision(4):''}${q.cadEquivalence?'\nCAD sweep difference: '+Number(q.cadEquivalence.missingVolume+q.cadEquivalence.addedVolume).toPrecision(3):''}${q.midsideConformityChecked?'\nShared midside nodes verified':''}`};
      if(Array.isArray(q.achievedEdgeDivisions)&&q.achievedEdgeDivisions.length){
        report.divisions=q.achievedEdgeDivisions;
        if(report.divisions.length<=4)report.text+='\nEdge divisions (requested → actual): '+report.divisions.map(item=>`${item.id}: ${item.requested} → ${item.achieved}`).join(', ');
        else{
          const counts=new Map();for(const item of report.divisions){const key=`${item.requested} → ${item.achieved}`;counts.set(key,(counts.get(key)||0)+1);}
          report.text+='\nEdge divisions (requested → actual): '+[...counts].map(([key,count])=>`${count} edges: ${key}`).join('; ');
        }
      }
      if(q.optimization&&Number.isFinite(q.optimization.initialMinScaledJacobian)&&Number.isFinite(q.optimization.finalMinScaledJacobian))report.text+=`\n${q.optimization.method||'High-order'} optimization minSJ: ${q.optimization.initialMinScaledJacobian.toPrecision(4)} → ${q.optimization.finalMinScaledJacobian.toPrecision(4)}`;
      engine().setCadVisible(false);engine().setCadSelectionMode('none');hooks.render();
    }
    function updateAvailability() {
      const undo=document.querySelector('[data-cad-action=undo]');if(undo)undo.disabled=(session?.history?.length||0)<2;
      const prepareTab=document.querySelector('[data-cad-stage=prepare]');if(prepareTab)prepareTab.disabled=!!session?.topology.discrete;
    }
    function bind() {
      root().querySelectorAll('[data-passage]').forEach(el=>el.addEventListener('change',()=>{remember();const [index,key]=el.dataset.passage.split(':');if(key==='axis')el.closest('.cad-passage').querySelector('summary').firstChild.textContent=`Passage ${Number(index)+1} · ${el.value.toUpperCase()} `;}));
      root().querySelectorAll('[data-remove-passage]').forEach(el=>el.onclick=event=>{event.preventDefault();if(hooks.isBusy?.())return;remember();passages.splice(Number(el.dataset.removePassage),1);hooks.render();});
      root().querySelectorAll('[data-remove-size]').forEach(el=>el.onclick=()=>{if(hooks.isBusy?.())return;remember();const [key,id]=el.dataset.removeSize.split(':');localSizing[key]=localSizing[key].filter(item=>item.id!==Number(id));if(generated)generated.stale=true;report=null;hooks.render();});
      root().querySelectorAll('[data-size-entity]').forEach(el=>el.onclick=()=>{if(hooks.isBusy?.())return;try{remember();const requested=new Set(ids(values.localIds)),id=Number(el.dataset.sizeEntity);requested.has(id)?requested.delete(id):requested.add(id);values.localIds=[...requested].join(', ');if(values.localEntity==='edge')engine().selectCad({faces:[],edges:[...requested]});else setSelected([...requested]);root().querySelector('[data-cad=localIds]').value=values.localIds;}catch(error){hooks.message(error.message,true);}});
      root().querySelectorAll('[data-cad]').forEach(el=>{
        el.addEventListener('input',()=>{if(meshParameter(el.dataset.cad)){remember();invalidateMeshReport();}});
        el.addEventListener('change',()=>{remember();if(meshParameter(el.dataset.cad))invalidateMeshReport();if(el.dataset.cad==='prepTool'){tool=el.value;hooks.render();}else if(el.dataset.cad==='method')hooks.render();else if(['localEntity','localRule'].includes(el.dataset.cad)){if(el.dataset.cad==='localEntity')values.localIds='';if(values.localEntity==='face')values.localRule='size';hooks.render();}else if(el.dataset.cad==='sweepAxis'){Object.keys(values).filter(k=>/^layer\d+$/.test(k)).forEach(k=>delete values[k]);hooks.render();}else if(['axis','position'].includes(el.dataset.cad))guide();});
      });
      root().querySelectorAll('[data-cad-stage]').forEach(el=>el.onclick=()=>{if(hooks.isBusy?.())return;remember();stage=el.dataset.cadStage;if(stage==='prepare'){engine().setCadVisible(true);engine().setCadSelectionMode('face');}hooks.render();});
      root().querySelectorAll('[data-face]').forEach(el=>el.onclick=()=>{if(hooks.isBusy?.())return;const id=Number(el.dataset.face);setSelected(selected.includes(id)?selected.filter(n=>n!==id):[...selected,id]);});
      root().querySelector('[data-cad-visible]')?.addEventListener('change',event=>{engine().setCadVisible(event.target.checked);engine().setCadSelectionMode(event.target.checked?'face':'none');});
      document.querySelectorAll('[data-cad-action]').forEach(el=>el.onclick=()=>{
        if(hooks.isBusy?.())return;const action=el.dataset.cadAction;
        if(action==='import'){document.getElementById('wb-cad-file').click();return;}
        if(action==='pick-local'){remember();engine().setCadVisible(true);engine().setCadSelectionMode(values.localEntity);hooks.message(`Pick CAD ${values.localEntity}s, then choose Use selected.`);return;}
        if(action==='use-local'){remember();values.localIds=(values.localEntity==='face'?selected:selectedEdges).join(', ');root().querySelector('[data-cad=localIds]').value=values.localIds;return;}
        if(action==='add-size'){try{addSizeControl();}catch(error){hooks.message(error.message,true);}return;}
        if(action==='select-floors'){remember();const axis=['x','y','z'].indexOf(values.axis),bounds=session.topology.bounds,tol=Math.max(1e-5,(bounds[axis+3]-bounds[axis])*1e-8);setSelected(faces().filter(face=>face.type==='Plane'&&face.bounds[axis+3]-face.bounds[axis]<tol&&face.center[axis]>bounds[axis]+tol&&face.center[axis]<bounds[axis+3]-tol&&(face.normal?.[axis]||0)>0).map(faceId));hooks.message(`Selected ${selected.length} internal floor faces. Review the highlighted selection before partitioning.`);return;}
        if(action==='add-passage'){if(passages.length>=24){hooks.message('Use at most 24 passages per operation.',true);return;}remember();passages.push(passageDefault());hooks.render();return;}
        if(action==='select'){try{const requested=ids(get('faceIds')),available=new Set(faces().map(faceId));if(requested.some(id=>!available.has(id)))throw Error('A face ID does not exist in this CAD revision.');setSelected(requested);}catch(error){hooks.message(error.message,true);}return;}
        if(action==='clear-selection'){setSelected([]);return;}
        if(action==='next'){remember();stage='mesh';hooks.render();return;}
        if(action==='pick-source'){engine().setCadVisible(true);engine().setCadSelectionMode('face');hooks.message('Click a face, then choose Use selection as source.');return;}
        if(action==='use-source'||action==='use-target'){if(selected.length!==1){hooks.message('Select exactly one CAD face.',true);return;}remember();values[action==='use-source'?'sourceFace':'targetFace']=selected[0];hooks.render();return;}
        return hooks.run(async()=>{try{if(action==='apply')await prepare();else if(action==='undo'){accept(await api('undo',token()));if(generated)generated.stale=true;hooks.render();hooks.message('Undid CAD preparation.');}else if(action==='mesh')await mesh();}catch(error){report={error:true,text:error.message};hooks.render();throw error;}});
      });
      updateAvailability();guide();
    }
    window.addEventListener('webmesh:cad-selection',event=>{if(!session)return;selected=event.detail?.faces||[];selectedEdges=event.detail?.edges||[];values.faceIds=selected.join(', ');if(active)syncSelection();});
    window.addEventListener('webmesh:change',event=>{
      if(!session||!generated||committingMesh)return;
      const reasons=event.detail?.reasons||[event.detail?.reason];
      if(!reasons.some(reason=>['load','undo','redo','history','model'].includes(reason)))return;
      remember();invalidateMeshReport('The model changed. Generate the CAD mesh again to update its quality report.');
      if(!engine().getMeshOwner(session.cadId).elements.length){engine().setCadVisible(true);engine().setCadSelectionMode(active?'face':'none');}
      if(active)hooks.render();
    });
    return {
      render,bind,importFile,updateAvailability,hasGeometry:()=>!!session,getFile:()=>source,
      activate(value){active=value;if(!value)remember();if(value&&session&&stage==='prepare')engine()?.setCadVisible(true);engine()?.setCadSelectionMode?.(value&&session?'face':'none');if(!value)engine()?.setCadSplitPlane?.(null);},
      clear(){source=null;session=null;selected=[];report=null;generated=null;auditHistory=[];engine()?.clearCadGeometry?.();},
      async serialize(){
        if(!source)return null;remember();
        const owned=generated?engine().getMeshOwner(session.cadId):null;
        if(owned&&!matchesGenerated(owned))invalidateMeshReport('The model changed. Generate the CAD mesh again to update its quality report.');
        const original={filename:source.name,content:base64(await source.arrayBuffer()),settings:{values:{...values},stage,tool,passages:structuredClone(passages),localSizing:structuredClone(localSizing)},report};
        if(session){original.prepared=await api('export',token());original.prepared.history=[...auditHistory,...(original.prepared.history||[])];}
        if(owned?.elements.length)original.mesh={...generated,elements:owned.elements,properties:owned.properties};
        return original;
      },
      async stageRestore(data) {
        if(!data)return null;
        checkSavedControlCounts(data);
        if(typeof data.filename!=='string'||typeof data.content!=='string')throw Error('Invalid CAD source in the project.');
        const file=new File([fromBase64(data.content)],data.filename),prepared=data.prepared?.content?data.prepared:null;
        const format=prepared?.format||({stp:'step',igs:'iges'}[file.name.split('.').pop().toLowerCase()]||file.name.split('.').pop().toLowerCase());
        const imported=await api('import',{filename:prepared?.filename||file.name,format,content:prepared?.content||data.content});
        return {data,file,imported};
      },
      commitRestore(staged) {
        if(staged)checkSavedControlCounts(staged.data);
        this.clear();if(!staged)return;
        const {data,file,imported}=staged;source=file;
        auditHistory=Array.isArray(data.prepared?.history)?data.prepared.history.filter(h=>typeof h==='string'||h&&typeof h.label==='string').map(h=>typeof h==='string'?{label:'Saved: '+h}:{...h,label:'Saved: '+h.label}):[];
        accept(imported);
        if(data.mesh&&Array.isArray(data.mesh.elements))generated=data.mesh;
        if(data.settings?.values) {
          for(const key of Object.keys(data.settings.values).filter(k=>Object.hasOwn(values,k)||/^layer\d{1,2}$/.test(k))){const value=data.settings.values[key];if(typeof value==='string'||typeof value==='number')values[key]=value;}
          stage=data.settings.stage==='mesh'?'mesh':'prepare';tool=['inspect','split','defeature','passages','project','heal'].includes(data.settings.tool)?data.settings.tool:'inspect';
          if(!['tet','tri','quad','sweep','layered','mapped'].includes(values.method))values.method='tet';
          if(session?.topology.discrete){stage='mesh';values.method=['tet','tri'].includes(values.method)?values.method:'tet';}
        }
        if(Array.isArray(data.settings?.passages)&&data.settings.passages.length<=24)passages=data.settings.passages.filter(p=>p&&['x','y','z'].includes(p.axis)&&Array.isArray(p.center)&&p.center.length===3&&Array.isArray(p.range)&&p.range.length===2&&[...p.center,...p.range,p.width,p.height].every(n=>Number.isFinite(Number(n)))).map(p=>({axis:p.axis,center:p.center.map(Number),range:p.range.map(Number),width:Number(p.width),height:Number(p.height)}));
        let invalidSavedSizing=false;
        if(data.settings?.localSizing){
          for(const key of ['edgeSizes','faceSizes','edgeDivisions'])if(Array.isArray(data.settings.localSizing[key])){
            const available=new Set((key==='faceSizes'?faces():session.topology.edges||[]).map(entity=>entity.id)),controls=new Map(),property=key==='edgeDivisions'?'divisions':'size';
            for(const control of data.settings.localSizing[key]){
              const value=control?.[property];
              if(!control||!Number.isSafeInteger(control.id)||!available.has(control.id)||!Number.isFinite(value)||value<=0||(key==='edgeDivisions'&&(!Number.isInteger(value)||value>200))||controls.size>=MAX_LOCAL_CONTROLS){invalidSavedSizing=true;continue;}
              if(controls.has(control.id))invalidSavedSizing=true;controls.set(control.id,{id:control.id,[property]:value});
            }
            localSizing[key]=[...controls.values()];
          }
          const exact=new Set(localSizing.edgeDivisions.map(control=>control.id));
          if(localSizing.edgeSizes.some(control=>exact.has(control.id))){invalidSavedSizing=true;localSizing.edgeSizes=localSizing.edgeSizes.filter(control=>!exact.has(control.id));}
        }
        if(data.report&&typeof data.report.text==='string')report={text:data.report.text.slice(0,6000),error:!!data.report.error};
        if(report&&Array.isArray(data.report.divisions))report.divisions=data.report.divisions.slice(0,MAX_LOCAL_CONTROLS).filter(item=>item&&Number.isSafeInteger(item.id)&&item.id>0&&Number.isInteger(item.requested)&&item.requested>0&&item.requested<=200&&Number.isInteger(item.achieved)&&item.achieved>0&&item.achieved<=200).map(item=>({id:item.id,requested:item.requested,achieved:item.achieved}));
        if(invalidSavedSizing){if(generated)generated.stale=true;report=null;hooks.message('Some saved local controls do not match this CAD revision. Review sizing and generate the mesh again.',true);}
        const owned=generated?engine().getMeshOwner(session.cadId):null,complete=owned&&matchesGenerated(owned);
        if(generated&&!complete)generated.stale=true;
        if(report&&!report.error&&(!complete||generated.stale))report=null;
        if(generated)engine().setCadVisible(!complete);
      },
      getState(){return {cadId:session?.cadId,revision:session?.revision,filename:source?.name,stage,tool,selected:[...selected],topology:session?.topology,report};}
    };
  }};
})();
