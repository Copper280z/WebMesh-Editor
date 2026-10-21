/* Task-oriented UI for the Nastran engine. No solver data lives in the view layer. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const engine = () => window.WebMeshAPI;
  const modeling = () => window.WebMeshModeling;
  const paths = {
    cube:'M12 3 3 8v9l9 5 9-5V8L12 3Zm0 10L3 8m9 5 9-5m-9 5v9M7.5 5.5l9 5',
    plate:'m3 11 9-6 9 6-9 7-9-7Zm5-3 9 7m-10-1 9-7',
    cylinder:'M5 6v12c0 4 14 4 14 0V6M5 6c0-4 14-4 14 0S5 10 5 6Z',
    ring:'M21 12c0 5-18 5-18 0S21 7 21 12Zm-14 0c0 2 10 2 10 0s-10-2-10 0Zm-4 0v4c0 5 18 5 18 0v-4',
    mesh:'M3 4h18v16H3V4Zm0 5h18M3 15h18M9 4v16m6-16v16M3 4l6 5 6-5 6 5M3 15l6 5 6-5 6 5',
    pattern:'M3 3h6v6H3V3Zm12 0h6v6h-6V3ZM3 15h6v6H3v-6Zm12 0h6v6h-6v-6',
    setup:'m12 3 2 4 4-1 1 4 3 2-3 2-1 4-4-1-2 4-2-4-4 1-1-4-3-2 3-2 1-4 4 1 2-4Zm0 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
    results:'M4 3v18h17M8 16v-5m5 5V6m5 10V9',
    file:'M14 3H5v18h14V8l-5-5Zm0 0v6h5M8 13h8m-8 4h5',
    folder:'M3 6h7l2 3h9v11H3V6Z',
    upload:'M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5',
    download:'M12 3v13m-5-5 5 5 5-5M4 15v5h16v-5',
    undo:'M8 4 3 9l5 5M3 9h10a7 7 0 0 1 0 14',
    redo:'m16 4 5 5-5 5m5-5H11a7 7 0 0 0 0 14',
    fit:'M3 9V3h6m6 0h6v6m0 6v6h-6m-6 0H3v-6M8 8h8v8H8V8Z',
    plus:'M12 4v16M4 12h16',
    close:'m6 6 12 12M6 18 18 6',
    check:'m5 12 4 4L19 6',
    arrow:'M4 12h16m-6-6 6 6-6 6',
    select:'m5 3 14 10-7 1-4 7L5 3Z',
    node:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
    material:'m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
    load:'M12 3v16m-6-6 6 6 6-6M4 22h16',
    lock:'M6 10h12v11H6V10Zm3 0V6a3 3 0 0 1 6 0v4m-3 5v2',
    eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
    help:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM9 9a3 3 0 0 1 6 0c0 2-3 2-3 5m0 3h.01',
    rotate:'M20 8a8 8 0 1 0 0 8m0-13v5h-5',
    grid:'M3 3h18v18H3V3Zm0 6h18M3 15h18M9 3v18m6-18v18',
    search:'m16 16 5 5M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z',
    info:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 7v7m0-10h.01'
  };
  const icon = name => `<svg class="wb-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.cube}"/></svg>`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const button = (id,label,name,cls='') => `<button type="button" id="${id}" class="wb-btn ${cls}">${name?icon(name):''}${label}</button>`;
  const field = (key,label,value,type='number',extra='') => `<label class="wb-field"><span>${label}</span><input aria-label="${label}" data-key="${key}" type="${type}" value="${esc(value)}" ${type==='number'?'step="any"':''} ${extra}></label>`;
  const select = (key,label,options,value) => `<label class="wb-field"><span>${label}</span><select aria-label="${label}" data-key="${key}">${options.map(([v,t])=>`<option value="${v}" ${String(value)===String(v)?'selected':''}>${t}</option>`).join('')}</select></label>`;
  const vector = (key,label,values,labels=['X','Y','Z']) => `<div class="wb-vector"><span>${label}</span><div>${values.map((v,i)=>`<label><em>${labels[i]}</em><input aria-label="${label} ${labels[i]}" data-key="${key}${i}" type="number" step="any" value="${v}"></label>`).join('')}</div></div>`;
  const help = (text) => `<details class="wb-inline-help"><summary>Details</summary><p>${text}</p></details>`;
  const patternMatrix = () => `<div class="wb-matrix" role="group" aria-label="Linear pattern directions"><div class="wb-matrix-row headings"><span>Direction</span><span>Count</span><span>ΔX</span><span>ΔY</span><span>ΔZ</span></div>${['A','B','C'].map((axis,i)=>`<div class="wb-matrix-row"><span>${axis}</span><input aria-label="Direction ${axis} count" title="Total instances including the original" data-key="counts${i}" type="number" min="1" step="1" value="${i===0?3:1}">${[0,1,2].map(j=>`<input aria-label="Direction ${axis} ${['X','Y','Z'][j]} spacing" data-key="vector${axis}${j}" type="number" step="any" value="${i===j?[120,80,50][i]:0}">`).join('')}</div>`).join('')}</div><div class="wb-footnote">Counts include the original. Set unused directions to 1.</div>`;
  const section = (title,body,note='') => `<section class="wb-section"><div class="wb-section-title">${title}${note?`<small>${note}</small>`:''}</div>${body}</section>`;
  const tool = (key,title,subtitle,name) => `<button class="wb-tool-card" data-tool="${key}">${icon(name)}<span><strong>${title}</strong><small>${subtitle}</small></span></button>`;
  let activeTab = 'build', primitive = 'block', patternKind = 'linear', preview = null, busy = false;
  let projectName = 'Untitled model', historyItems = [], moved = [], lastState = '', operationRevision = 0;
  const savedForms = new Map();
  const formKey = () => activeTab+':'+(activeTab==='build'?primitive:activeTab==='pattern'?patternKind:'');
  function rememberForm() {savedForms.set(formKey(),Object.fromEntries(Array.from($('wb-panel-body').querySelectorAll('[data-key]'),el=>[el.dataset.key,el.type==='checkbox'?el.checked:el.value])));}
  const app = $('app');
  app.insertAdjacentHTML('beforeend', `
    <div class="wb-topbar">
      <div class="wb-brand"><span class="wb-logo">${icon('cube')}</span>WebMesh <small>STUDIO</small></div>
      <div class="wb-project"><span id="wb-project">Untitled model</span><i title="Local workspace"></i></div>
      <div class="wb-spacer"></div>
      <div class="wb-actions">
        ${button('wb-new','New','plus','ghost wb-hide-mobile')}${button('wb-open','Open','folder','ghost')}
        ${button('wb-save','Save project','file')}${button('wb-export','Export deck','download','primary')}
        ${button('wb-help','<span class="wb-help-label">Help</span>','help','ghost')}
      </div>
    </div>
    <nav class="wb-tabs" aria-label="Workspace">
      ${[['build','Geometry','cube'],['mesh','CAD & mesh','mesh'],['pattern','Pattern','pattern'],['setup','Model setup','setup'],['results','Post-process','results']].map(([id,label,name])=>`<button class="wb-tab ${id==='build'?'active':''}" data-tab="${id}">${icon(name)}${label}</button>`).join('')}
      <div class="wb-tabs-end"><span class="wb-unit-label">Consistent units</span><span style="color:#35485e">|</span><span class="wb-engine"><i id="wb-engine-dot" class="wb-dot"></i><span id="wb-engine-status">Browser engine</span></span></div>
    </nav>
    <nav class="wb-rail" aria-label="Tools">
      ${[['build','cube','Create geometry'],['mesh','mesh','CAD meshing'],['pattern','pattern','Pattern mesh'],['setup','material','Materials and analysis'],['results','results','Results']].map(([tab,name,label])=>`<button data-tab="${tab}" class="${tab==='build'?'active':''}" title="${label}" aria-label="${label}">${icon(name)}</button>`).join('')}
      <div class="wb-spacer"></div><button id="wb-display" title="Display settings" aria-label="Display settings">${icon('eye')}</button><button id="wb-quality" title="Check mesh" aria-label="Check mesh">${icon('check')}</button>
    </nav>
    <aside class="wb-panel" aria-label="Active tool"><div class="wb-panel-head" id="wb-panel-head"></div><div class="wb-panel-body" id="wb-panel-body"></div><div class="wb-panel-foot" id="wb-panel-foot"></div></aside>
    <aside class="wb-inspector" aria-label="Model browser">
      <div class="wb-inspector-head"><span>Model</span><span class="wb-pane-actions">${icon('material')}</span></div>
      <div class="wb-tree-search"><input id="wb-tree-filter" type="search" aria-label="Filter model tree" placeholder="Filter model tree"></div>
      <div class="wb-outline"><div class="wb-tree-root">${icon('folder')}<span id="wb-tree-name">Untitled model</span></div><div id="wb-tree"></div></div>
      <div class="wb-inspector-section"><h3>Model statistics</h3><div class="wb-stat-grid"><div><span>NODES</span><strong id="wb-nodes">0</strong></div><div><span>ELEMENTS</span><strong id="wb-elements">0</strong></div><div><span>PROPERTIES</span><strong id="wb-properties">0</strong></div><div><span>MATERIALS</span><strong id="wb-materials">0</strong></div></div></div>
      <div class="wb-inspector-section"><h3>Selection</h3><div class="wb-selection-tools"><button data-select="node" class="active">Nodes</button><button data-select="element">Elements</button><button id="wb-selection-more" title="Selection settings">···</button></div><p class="wb-inspector-note" id="wb-selection-info">Click an entity to inspect it.<br>Alt + drag to select a region.</p><div style="display:flex;gap:5px;margin-top:12px">${button('wb-select-all','Select all',null,'ghost')}${button('wb-clear-selection','Clear',null,'ghost')}</div></div>
      <div class="wb-inspector-section"><h3>Recent operations</h3><div id="wb-history" class="wb-inspector-note">Your modeling operations appear here.</div></div>
      <div class="wb-inspector-bottom">Nastran model · consistent units</div>
    </aside>
    <footer class="wb-statusbar"><span class="message" id="wb-message">${icon('check')}Ready to build</span><div class="wb-spacer"></div><span class="wb-unit-label">GLOBAL · XYZ</span><button id="wb-log">Activity log</button><span>WebMesh 3.0</span></footer>
    <dialog id="wb-dialog" class="wb-dialog"><div class="wb-dialog-head"><h2 id="wb-dialog-title"></h2>${button('wb-dialog-close','','close','ghost icon')}</div><div id="wb-dialog-body" class="wb-dialog-body"></div></dialog>
    <input id="wb-project-file" type="file" accept=".webmesh,.json" hidden>
    <input id="wb-cad-file" type="file" accept=".step,.stp,.iges,.igs,.brep,.stl" hidden>
  `);
  $('viewport').insertAdjacentHTML('beforeend', `<div class="wb-view-head"><div><div class="wb-view-title"><strong id="wb-viewport-name">Untitled model</strong><span id="wb-view-type">Geometry</span></div></div><button id="wb-projection" class="wb-view-mode" title="Toggle orthographic/perspective">Orthographic</button></div>
    <div id="wb-empty" class="wb-empty"><h2>No model loaded</h2><p>Create a primitive, import CAD, or open a Nastran deck.</p>${button('wb-example','Load example',null)}<small>Geometry · CAD & mesh · Open</small></div>
    <div class="wb-view-toolbar" role="toolbar" aria-label="Viewport tools"><button id="wb-undo" title="Undo (Ctrl+Z)" aria-label="Undo">${icon('undo')}</button><button id="wb-redo" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">${icon('redo')}</button><span class="divider"></span><button id="wb-fit" title="Fit model (F)" aria-label="Fit model">${icon('fit')}</button><button id="wb-edges" title="Toggle element edges" aria-label="Toggle element edges">${icon('mesh')}</button><button id="wb-shading" title="Toggle shading" aria-label="Toggle shading">${icon('cube')}</button><span class="divider"></span><button id="wb-view-iso" title="Isometric view">ISO</button><button id="wb-measure" title="Measure selection" aria-label="Measure selection">${icon('search')}</button></div><div class="wb-mesh-badge">FINITE ELEMENT WORKSPACE</div>`);

  function message(text,error=false) {
    $('wb-message').innerHTML = `${icon(error?'info':'check')}${esc(text)}`;
    $('wb-message').classList.toggle('error',error);
    $('wb-message').title=text;
  }
  function logOperation(text) {
    historyItems.unshift({text,time:new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})});
    historyItems=historyItems.slice(0,5);
    $('wb-history').innerHTML=historyItems.map(item=>`<div style="display:flex;gap:8px;margin-bottom:8px"><span style="color:#5cd9bb">·</span><span>${esc(item.text)}</span><span style="margin-left:auto;font-size:9px;white-space:nowrap;color:#4f6984">${esc(item.time)}</span></div>`).join('');
  }
  function nameProject(name) {projectName=name;$('wb-project').textContent=name;$('wb-tree-name').textContent=name;$('wb-viewport-name').textContent=name;document.title=`${name} — WebMesh Studio`;}
  function get(key) {const el=$('wb-panel-body').querySelector(`[data-key="${key}"]`);return el?.type==='checkbox'?el.checked:el?.value;}
  function num(key) {const v=get(key);if(v==null||String(v).trim()===''||!Number.isFinite(Number(v)))throw Error(`Enter a finite value for ${key}.`);return Number(v);}
  function vec(key){return [0,1,2].map(i=>num(key+i));}
  function setBusy(value) {
    busy=value;window.__WEBMESH_WORKBENCH_BUSY__=value;
    document.querySelectorAll('[data-operation],#wb-new,#wb-open,#wb-save,#wb-export,#wb-example,#wb-upload-cad,#wb-select-all,#wb-clear-selection').forEach(el=>el.disabled=value);
    $('wb-panel-body').querySelectorAll('input,select,button').forEach(el=>el.disabled=value);
    if(!value&&activeTab==='mesh')cadWorkspace.updateAvailability();
    syncUndoButtons();
  }
  async function run(fn) {
    if(busy)return;
    setBusy(true);const revision=operationRevision;
    try {await fn(revision);refresh(true);}catch(err){message(err.message||String(err),true);const report=$('wb-report');if(report){report.textContent=err.message||String(err);report.className='wb-report bad';}}
    finally{setBusy(false);refresh(true);}
  }
  const cadWorkspace=window.WebMeshCadWorkspace.create({engine,run,message,render:renderPanel,refresh:()=>refresh(true),name:nameProject,log:logOperation,appendMesh:appendCadMesh,isBusy:()=>busy});
  const boltWorkspace=window.WebMeshBoltWorkspace.create({engine,run,message,render:renderPanel,clearPreview:invalidatePreview,log:logOperation,isBusy:()=>busy});
  function invalidatePreview() {preview=null;engine()?.previewMesh?.(null);const el=$('wb-preview-info');if(el)el.textContent='Preview updates before adding to the model.';}
  function setTab(tab) {
    if(busy)return;
    closeDialog();app.classList.remove('parameters-hidden');
    rememberForm();cadWorkspace.activate(false);activeTab=tab;cadWorkspace.activate(tab==='mesh');invalidatePreview();
    document.querySelectorAll('[data-tab]').forEach(el=>el.classList.toggle('active',el.dataset.tab===tab));
    $('wb-view-type').textContent={build:'Geometry',mesh:'Meshing',pattern:'Patterns',setup:'Model setup',results:'Post-processing'}[tab];
    renderPanel();
  }
  function topologyOptions(kind) {return kind==='plate'?[['quad','Quadrilateral'],['tri','Triangle']]:kind==='annulus'?[['quad','Quad ring shell'],['tri','Triangle ring shell'],['hex','Hollow structured hex'],['tet','Hollow tetrahedra']]:[['hex','Structured hex'],['tet','Tetrahedron'],...(kind==='cylinder'?[['quad','Quad shell'],['tri','Triangle shell']]:[])];}
  function syncUndoButtons() {
    const cad=activeTab==='mesh'&&cadWorkspace?.historyActive?.();
    $('wb-undo').disabled=busy||(cad?!cadWorkspace.canUndo():$('btnUndo').disabled);
    $('wb-redo').disabled=busy||(cad?!cadWorkspace.canRedo():$('btnRedo').disabled);
    $('wb-undo').title=cad?'Undo geometry change (Ctrl+Z)':'Undo (Ctrl+Z)';$('wb-redo').title=cad?'Redo geometry change (Ctrl+Shift+Z)':'Redo (Ctrl+Shift+Z)';
  }
  function renderPanel() {
    const titles={build:['CREATE','Geometry','Parametric primitives and structured meshes.'],mesh:['CAD WORKFLOW','Hex meshing','Prepare CAD, solve edge counts and map hex elements.'],pattern:['REPEAT & ASSEMBLE','Pattern','Repeat mesh instances and connect interfaces.'],setup:['PRE-PROCESS','Model setup','Materials, sections and boundary conditions.'],results:['POST-PROCESS','Results','MYSTRAN output and load contours.']};
    const [eyebrow,title,description]=titles[activeTab];
    $('wb-panel-head').innerHTML=`<div class="wb-eyebrow">${eyebrow}</div><h2>${title}</h2><p>${description}</p>`;
    let html='',foot='';
    if(activeTab==='build') {
      const options=[['block','Block','cube'],['plate','Plate','plate'],['cylinder','Cylinder','cylinder'],['annulus','Annulus','ring']];
      html=section('Primitive',`<div class="wb-primitive-grid">${options.map(([id,label,name])=>`<button class="wb-primitive ${primitive===id?'active':''}" data-primitive="${id}">${icon(name)}${label}</button>`).join('')}</div>`);
      html+=section('Geometry',field('name','Name',`${primitive[0].toUpperCase()+primitive.slice(1)} ${historyItems.length+1}`,'text')+(['block','plate'].includes(primitive)?vector('size','Size',[100,60,primitive==='block'?20:0]):`${field('radius','Outer radius',30)}${primitive==='annulus'?field('innerRadius','Inner radius',15):field('length','Length',80)}${primitive==='annulus'?field('length','Depth',20):''}`)+vector('origin','Origin',[0,0,0]),'model units');
      html+=section('Mesh definition',select('topology','Element topology',topologyOptions(primitive),topologyOptions(primitive)[0][0])+select('order','Element order',[[1,'First order · linear'],[2,'Second order · quadratic']],1)+(['block','plate'].includes(primitive)?vector('divisions','Divisions',[10,6,primitive==='block'?2:1],['U','V','W']):`<div class="wb-two">${field('segments','Circumferential',24,'number','min="4" step="1"')}${field('radialDivisions','Radial divisions',3,'number','min="1" step="1"')}</div>${field('axialDivisions','Axial divisions (solid or cylinder)',8,'number','min="1" step="1"')}`));
      html+=`<details class="wb-section"><summary class="wb-section-title">Material &amp; section</summary>${field('E','Young’s modulus',210000)}${field('nu','Poisson’s ratio',0.3)}${field('rho','Density',7.85e-9)}${field('thickness','Shell thickness',1)}<div class="wb-footnote">Creates a new property and material. Use consistent units.</div></details><div id="wb-report"></div>`;
      foot=`<div id="wb-preview-info" class="wb-preview-info">Conforming, connected elements</div>${button('wb-preview','Preview mesh','eye')}${button('wb-create','Add to model','plus','primary')}`;
    } else if(activeTab==='mesh') {
      const view=cadWorkspace.render();html=view.body;foot=view.foot;
    } else if(activeTab==='pattern') {
      html=section('Pattern',`<div class="wb-primitive-grid"><button data-pattern="linear" class="wb-primitive ${patternKind==='linear'?'active':''}">${icon('pattern')}Linear</button><button data-pattern="circular" class="wb-primitive ${patternKind==='circular'?'active':''}">${icon('rotate')}Circular</button><button data-pattern="bolts" class="wb-primitive ${patternKind==='bolts'?'active':''}">Bolts</button></div>`);
      if(patternKind==='bolts'){const view=boltWorkspace.render();html+=view.body;foot=view.foot;}
      else {
      html+=select('scope','Source',[['selected','Selected elements'],['all','Entire model']], 'selected');
      if(patternKind==='linear') html+=section('Directions',patternMatrix());
      else html+=section('Rotation',field('count','Instances',6,'number','min="2" step="1"')+field('angle','Sweep (°)',360)+vector('axis','Axis',[0,0,1])+vector('center','Center',[0,0,0])+`<div class="wb-footnote">360° closes the circle; partial sweeps include endpoints.</div>`);
      html+=section('Connectivity',field('mergeTolerance','Merge tolerance',0)+`<div class="wb-footnote">0 = separate nodes. Positive values weld coincident nodes.</div>`+help('Copies preserve element connectivity and properties. Loads and constraints stay on the source. Weld searches include all existing model nodes.'))+`<div id="wb-report"></div>`;
      foot=`<div id="wb-preview-info" class="wb-preview-info">Original entities stay in place</div>${button('wb-preview-pattern','Preview pattern','eye')}${button('wb-apply-pattern','Create pattern','pattern','primary')}`;
      }
    } else if(activeTab==='setup') {
      html=section('Physical definitions',`<div class="wb-tool-list">${tool('material','Materials','Isotropic elasticity, density and material IDs','material')}${tool('property','Element properties','Shell thickness, solid regions and beam sections','plate')}</div>`);
      html+=section('Boundary conditions',`<div class="wb-tool-list">${tool('load','Loads','Forces, moments, pressure and load combinations','load')}${tool('constraint','Constraints','Single-point constraints and constrained DOFs','lock')}${tool('coordinate','Coordinate systems','Define local rectangular or cylindrical frames','cube')}</div>`);
      html+=section('Connections',`<button class="wb-tool-card" id="wb-bolt-tool"><span><strong>Simulated bolts</strong><small>RBE2 attachments with CBUSH or rod shanks; single or patterned</small></span></button>`);
      html+=section('Model editing',`<div class="wb-tool-list">${tool('cards','Create nodes','Individual GRID cards and coordinate references','node')}${tool('element','Create elements','Shells, solids, beams, rods and rigid elements','mesh')}${tool('modify','Modify entities','Edit existing cards with schema-driven forms','setup')}${tool('selection','Selection & inspection','Pick, select by ID, filter and edit node coordinates','select')}${tool('transform','Transform mesh','Move, rotate, reflect and merge nodes','rotate')}</div>`)+`<div id="wb-report"></div>`;
      foot=button('wb-check-mesh','Check mesh connectivity','check','primary');
    } else {
      html=section('Results source',`<button class="wb-upload" id="wb-load-results" style="width:100%">${icon('results')}<strong>Import MYSTRAN results</strong><small>F06 · Multiple subcases &amp; modes</small></button><p class="wb-hint">Open the matching model deck first. Results attach to its node and element IDs. Temperatures can be viewed directly from TEMP and TEMPD cards.</p>`);
      html+=section('Review',`<div class="wb-tool-list">${tool('results','Contours & deformation','Output sets, vectors, palettes, legends and animation','results')}${tool('measure','Measurements','Distance, angle, centroid and selected area','search')}${tool('display','Display & section view','Visibility, clipping, labels, shading and backgrounds','eye')}</div>`);
      html+=section('Model interchange',`<div class="wb-tool-list">${tool('file','Deck & results files','INCLUDE-aware multi-file and folder import','folder')}${tool('csv','Spreadsheet exchange','Import and export schema CSV for bulk editing','grid')}</div>`);
      foot=button('wb-results-options','Open result controls','results','primary');
    }
    // The CAD workspace re-renders often (every server reply): patch it in place so
    // fields keep focus and scrolled lists keep their place.
    if(activeTab==='mesh'&&window.WebMeshDom){window.WebMeshDom.morph($('wb-panel-body'),html);window.WebMeshDom.morph($('wb-panel-foot'),foot);}
    else{$('wb-panel-body').innerHTML=html;$('wb-panel-foot').innerHTML=foot;}
    $('wb-panel-foot').querySelectorAll('button').forEach(el=>el.dataset.operation='true');
    const saved=savedForms.get(formKey());if(saved){for(const el of $('wb-panel-body').querySelectorAll('[data-key]'))if(Object.hasOwn(saved,el.dataset.key))el.value=saved[el.dataset.key];}
    if(activeTab==='mesh')cadWorkspace.bind();
    if(activeTab==='pattern'&&patternKind==='bolts')boltWorkspace.bind();
    bindPanel();
    if(activeTab==='mesh')checkBridge();
    syncUndoButtons();
  }

  function primitiveOptions() {
    const ids=engine().getNextIds();
    const opts={kind:primitive,name:get('name'),origin:vec('origin'),topology:get('topology'),order:num('order'),pid:ids.property,startNode:ids.node,startElement:ids.element};
    if(['block','plate'].includes(primitive)){opts.size=vec('size');opts.divisions=vec('divisions');}
    else {opts.radius=num('radius');opts.segments=num('segments');opts.radialDivisions=num('radialDivisions');opts.axialDivisions=num('axialDivisions');opts.length=num('length');opts.innerRadius=primitive==='annulus'?num('innerRadius'):0;}
    return opts;
  }
  function previewInfo(mesh) {
    const report=modeling().validateMesh(mesh);
    if(!report.valid)throw Error(report.errors.join('\n'));
    const info=$('wb-preview-info');if(info)info.textContent=`${mesh.nodes.length.toLocaleString()} nodes · ${mesh.elements.length.toLocaleString()} elements`;
    const el=$('wb-report');if(el){el.className='wb-report good';el.textContent=`${mesh.name||'Mesh'}\n${mesh.nodes.length.toLocaleString()} nodes · ${mesh.elements.length.toLocaleString()} elements\n${Object.entries(report.stats.topologies||{}).map(([key,value])=>`${key}: ${value}`).join(' · ')}${report.warnings?.length?'\n'+report.warnings.join('\n'):''}`;}
    engine().previewMesh?.(mesh);return mesh;
  }
  async function addPrimitive() {
    const mesh=modeling().createPrimitive(primitiveOptions());mesh.name=get('name')||primitive;
    const ids=engine().getNextIds();
    await engine().appendMesh(mesh,{material:{id:ids.material,E:num('E'),nu:num('nu'),rho:num('rho')},thickness:num('thickness')});
    preview=null;engine().previewMesh?.(null);engine().fitView?.();
    logOperation(`Created ${mesh.name}`);message(`Added ${mesh.elements.length.toLocaleString()} elements to the model.`);
  }
  function patternMesh() {
    const source=engine().getMesh({selectedOnly:get('scope')==='selected'});
    if(!source.elements.length)throw Error('Select one or more elements, or choose Entire model.');
    const ids=engine().getNextIds();
    const opts={includeSeed:false,startNode:ids.node,startElement:ids.element,mergeTolerance:num('mergeTolerance'),mergeNodes:engine().getMesh().nodes};
    let mesh;
    if(patternKind==='linear')mesh=modeling().linearPattern(source,{...opts,counts:vec('counts'),vectors:[vec('vectorA'),vec('vectorB'),vec('vectorC')]});
    else mesh=modeling().circularPattern(source,{...opts,count:num('count'),angle:num('angle'),axis:vec('axis'),center:vec('center')});
    if(!mesh.elements.length)throw Error('Increase at least one instance count to create copies.');
    return mesh;
  }
  function bindPanel() {
    $('wb-bolt-tool')?.addEventListener('click',()=>{if(!busy){patternKind='bolts';setTab('pattern');}});
    document.querySelectorAll('[data-primitive]').forEach(el=>el.onclick=()=>{if(busy)return;rememberForm();primitive=el.dataset.primitive;invalidatePreview();renderPanel();});
    document.querySelectorAll('[data-pattern]').forEach(el=>el.onclick=()=>{if(busy)return;rememberForm();patternKind=el.dataset.pattern;invalidatePreview();renderPanel();});
    $('wb-preview')?.addEventListener('click',()=>run(()=>{preview=previewInfo(modeling().createPrimitive(primitiveOptions()));message('Mesh preview ready. Add it to commit the operation.');}));
    $('wb-create')?.addEventListener('click',()=>run(addPrimitive));
    $('wb-preview-pattern')?.addEventListener('click',()=>run(()=>{preview=patternMesh();const info=$('wb-preview-info');if(info)info.textContent=`${preview.nodes.length} new nodes · ${preview.elements.length} new elements`;engine().previewMesh?.({...preview,nodes:[...engine().getMesh({selectedOnly:false}).nodes,...preview.nodes]});message('Pattern preview ready.');}));
    $('wb-apply-pattern')?.addEventListener('click',()=>run(async()=>{const mesh=patternMesh();await engine().appendMesh(mesh);engine().previewMesh?.(null);preview=null;engine().fitView?.();logOperation(`Created ${patternKind} pattern`);message(`Added ${mesh.elements.length.toLocaleString()} patterned elements.`);}));
    document.querySelectorAll('[data-tool]').forEach(el=>el.onclick=()=>openTool(el.dataset.tool).catch(error=>message(error.message,true)));
    $('wb-check-mesh')?.addEventListener('click',checkMesh);
    $('wb-load-results')?.addEventListener('click',()=>$('fileResults').click());
    $('wb-results-options')?.addEventListener('click',()=>openTool('results'));
  }
  async function checkBridge() {
    if(location.protocol==='file:')return;
    try {
      const response=await fetch('/api/health');if(!response.ok)throw Error('unavailable');const health=await response.json();
      const available=!!(health.gmsh?.available??health.gmshAvailable??health.available??health.gmsh);
      $('wb-engine-dot').classList.toggle('connected',available);$('wb-engine-status').textContent=available?'Gmsh connected':'Browser engine';
      const el=$('wb-bridge-info');if(el)el.textContent=available?`Local Gmsh engine connected. CAD files stay on this machine.`:'Gmsh was not found. Install Gmsh and restart python3 server.py. Scratch modeling works in the browser.';
    }catch{
      const el=$('wb-bridge-info');if(el)el.innerHTML='Start the CAD bridge with <code>python3 server.py</code>, then open <code>http://127.0.0.1:8765</code>. Scratch modeling works in the browser.';
    }
  }
  async function appendCadMesh(result,filename,{topology,order,previousMesh,ownerTag,thickness=1}) {
    const owned=engine().getMeshOwner(ownerTag);
    previousMesh=owned.elements.length?{...previousMesh,properties:owned.properties}:null;
    const ids=engine().getNextIds(),nodeMap=new Map(),nodeIds=result.mesh.nodes.map((node,i)=>{nodeMap.set(node.id,ids.node+i);return {...node,id:ids.node+i};});
    const definitions=engine().getState();const regionType=['hex','tet'].includes(topology)?'PSOLID':'PSHELL';
    const reusable=(previousMesh?.properties||[]).filter(id=>definitions.properties.some(p=>p.id===id&&p.type===regionType));
    const regions=new Map();let nextProperty=ids.property;for(const el of result.mesh.elements)if(!regions.has(el.pid))regions.set(el.pid,reusable[regions.size]??nextProperty++);
    const mesh={name:filename,nodes:nodeIds,elements:result.mesh.elements.map((el,i)=>({...el,id:ids.element+i,pid:regions.get(el.pid),nodes:el.nodes.map(id=>nodeMap.get(id))}))};
    const material=definitions.materials.some(m=>m.id===previousMesh?.material)?previousMesh.material:ids.material;
    await engine().appendMesh(mesh,{material:{id:material,E:210000,nu:0.3,rho:7.85e-9},thickness,ownerTag,replaceOwner:true,...(regionType==='PSHELL'?{shellThickness:thickness}:{})});
    engine().fitView?.();logOperation(`Meshed ${filename}`);message(`CAD mesh added: ${mesh.nodes.length.toLocaleString()} nodes · ${mesh.elements.length.toLocaleString()} elements.`);
    const report=$('wb-report');if(report){report.className='wb-report good';report.textContent=`${filename}\n${mesh.nodes.length.toLocaleString()} nodes · ${mesh.elements.length.toLocaleString()} ${topology} elements\nOrder ${order}${result.log?'\n\n'+result.log.slice(-1600):''}`;}
    return {elements:mesh.elements.map(el=>el.id),properties:[...regions.values()],material};
  }

  function closeDialog() {
    engine()?.closeTool?.();
    for(const {node,marker,classes} of moved){marker.replaceWith(node);node.className=classes;}moved=[];
    $('wb-dialog').close();if(activeTab==='mesh')cadWorkspace.activate(true);
  }
  function dialog(title,content) {
    closeDialog();$('wb-dialog').classList.remove('docked');$('wb-dialog-title').textContent=title;$('wb-dialog-body').classList.remove('grouped');$('wb-dialog-body').innerHTML=content;$('wb-dialog').showModal();
  }
  function mountLegacy(id,title) {
    closeDialog();cadWorkspace.activate(false);const nodes=(Array.isArray(id)?id:[id]).map($).filter(Boolean);if(!nodes.length){message('This editor is still initializing. Try again shortly.',true);return;}
    for(const node of nodes){const marker=document.createComment('workbench tool position');node.replaceWith(marker);moved.push({node,marker,classes:node.className});node.classList.remove('collapsed');}
    app.classList.remove('parameters-hidden');$('wb-dialog').classList.add('docked');$('wb-dialog-title').textContent=title;$('wb-dialog-body').classList.toggle('grouped',nodes.length>1);$('wb-dialog-body').replaceChildren(...nodes);$('wb-dialog').show();
  }
  async function openTool(key) {
    if(busy)return;
    const cards={results:['resultsCard','Results & load contours'],selection:['selectionCard','Selection & entity details'],display:[['inspectDisplayCard','inspectVisibilityCard','inspectClippingCard','inspectLabelsCard'],'Display, visibility & section view'],measure:['inspectMeasureCard','Measurements'],file:['inspectFileCard','Open model & results'],transform:['transformToolsCard','Transform mesh'],csv:['selectionCard','Spreadsheet exchange']};
    const schema={material:'MAT1',property:'PSHELL',load:'FORCE',constraint:'SPC1',coordinate:'CORD2R',cards:'GRID',element:'CQUAD4'};
    if(schema[key]){mountLegacy('schemaCreateCardPanel',`${{material:'Material',property:'Property',load:'Load',constraint:'Constraint',coordinate:'Coordinate system',cards:'Node',element:'Element'}[key]}`);await engine()?.editCard?.(schema[key],'create');return;}
    if(key==='modify'){const selected=engine().getMesh({selectedOnly:true});mountLegacy('schemaEditCardPanel','Modify entity');await engine()?.editCard?.(selected.elements[0]?.type||'GRID','modify');return;}
    const card=cards[key];if(card){
      if(!$(card[0])){
        const alternatives={measure:['measureCard'],transform:['meshToolsCard','modifyMeshCard','transformCard'],csv:['csvExchangeCard','inspectCsvCard','spreadsheetCard']};
        const found=alternatives[key]?.find(id=>$(id));if(found)card[0]=found;
      }
      mountLegacy(...card);
    }
  }
  function checkMesh() {run(()=>{const mesh=engine().getMesh();if(!mesh.elements.length)throw Error('Create or open a model before checking connectivity.');const report=modeling().validateMesh(mesh);const stats=report.stats;dialog('Mesh connectivity check',`<div class="wb-report ${report.valid?'good':'bad'}">${esc(`${report.valid?'Connectivity checks passed':'Connectivity problems found'}\n\n${Object.entries(stats).map(([k,v])=>`${k}: ${typeof v==='object'?JSON.stringify(v):v}`).join('\n')}\n\n${[...report.errors,...report.warnings].join('\n')}`)}</div><p style="color:#7e97b2;font-size:11px;margin-top:16px">Checks cover references, duplicate connectivity, degenerate elements and boundary topology. Solver-specific quality and curved second-order Jacobians need additional verification.</p>`);message(report.valid?'Mesh connectivity checks passed.':'Mesh connectivity issues found.',!report.valid);});}

  function refresh(force=false) {
    if(!engine())return;
    const state=engine().getState(),counts=state.counts||state;
    const properties=Array.isArray(state.properties)?state.properties:[],materials=Array.isArray(state.materials)?state.materials:[];
    const nodes=Number(counts.nodes)||0,elements=Number(counts.elements)||0;
    const selection=state.selection||{},selectedNodes=selection.nodes||[],selectedElements=selection.elems||selection.elements||[];
    const key=JSON.stringify([nodes,elements,properties.length,materials.length,selectedNodes.length,selectedElements.length,state.history]);if(key===lastState&&!force)return;lastState=key;
    $('wb-nodes').textContent=nodes.toLocaleString();$('wb-elements').textContent=elements.toLocaleString();$('wb-properties').textContent=properties.length;$('wb-materials').textContent=materials.length;
    $('wb-empty').style.display=nodes||elements||preview||cadWorkspace.hasGeometry()?'none':'flex';
    $('wb-selection-info').innerHTML=selectedNodes.length||selectedElements.length?`${selectedNodes.length.toLocaleString()} nodes · ${selectedElements.length.toLocaleString()} elements selected<br><span style="color:#5cd9bb">Ready to inspect or pattern.</span>`:'Click an entity to inspect it.<br>Alt + drag to select a region.';
    const rows=[['cube','Elements',elements,'selection'],['node','Nodes',nodes,'selection'],['plate','Properties',properties.length,'property'],['material','Materials',materials.length,'material'],['load','Loads',counts.loads||0,'load'],['lock','Constraints',counts.constraints||0,'constraint']];
    $('wb-tree').innerHTML=rows.map(([name,label,count,toolKey])=>`<button class="wb-tree-row" data-outline-tool="${toolKey}">${icon(name)}${label}<span class="count">${count.toLocaleString()}</span></button>`).join('')+(properties.length?`<div class="wb-body-list">${properties.slice(0,8).map(p=>`<button data-property-id="${p.id??p.pid}">↳ ${esc(p.type||'Property')} · ${esc(p.id??p.pid)}</button>`).join('')}</div>`:'');
    $('wb-tree').querySelectorAll('[data-outline-tool]').forEach(el=>el.onclick=()=>openTool(el.dataset.outlineTool));
    $('wb-tree').querySelectorAll('[data-property-id]').forEach(el=>el.onclick=async()=>{if(busy)return;const id=Number(el.dataset.propertyId),property=properties.find(p=>Number(p.id??p.pid)===id);engine().select?.({props:[id],mode:'property'});mountLegacy('schemaEditCardPanel',`Property ${id}`);try{await engine().editCard(property.type,'modify');}catch(error){message(error.message,true);}});
    syncUndoButtons();
  }
  function download(text,filename,type='text/plain') {const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);}
  async function saveProject() {
    const deck=await engine().exportDeck();
    const cad=await cadWorkspace.serialize();
    download(JSON.stringify({format:'webmesh-project',version:1,name:projectName,deck,cad,history:historyItems},null,2),projectName.replace(/[^\w.-]+/g,'_')+'.webmesh','application/json');
    message('Project saved with the model deck and source CAD.');
  }
  async function example() {
    if(cadWorkspace.hasGeometry()||(engine().getState().counts?.elements||engine().getState().elements)>0)throw Error('Start a new model before loading the example.');
    const ids=engine().getNextIds();
    const mesh=modeling().createPrimitive({kind:'annulus',origin:[0,0,0],radius:45,innerRadius:26,length:1,segments:32,radialDivisions:4,axialDivisions:1,topology:'quad',order:2,pid:ids.property,startNode:ids.node,startElement:ids.element});
    mesh.name='Annular flange';
    await engine().appendMesh(mesh,{material:{id:ids.material,E:210000,nu:0.3,rho:7.85e-9},thickness:3});
    const next=engine().getNextIds();
    const rib=modeling().createPrimitive({kind:'block',origin:[45,-4,0],size:[28,8,12],divisions:[7,2,3],topology:'hex',order:1,pid:next.property,startNode:next.node,startElement:next.element});
    await engine().appendMesh(rib,{material:{id:next.material,E:210000,nu:0.3,rho:7.85e-9},thickness:1});
    const next2=engine().getNextIds();const copies=modeling().circularPattern(rib,{count:8,angle:360,axis:[0,0,1],center:[0,0,0],includeSeed:false,startNode:next2.node,startElement:next2.element,mergeTolerance:0});
    await engine().appendMesh(copies);nameProject('Flange assembly · Example');engine().fitView?.();logOperation('Created flange assembly example');message('Example ready. Try patterns, selection, setup and mesh checks.');refresh(true);
  }
  document.querySelectorAll('[data-tab]').forEach(el=>el.onclick=()=>setTab(el.dataset.tab));
  $('wb-dialog-close').onclick=closeDialog;
  $('wb-dialog').addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
  $('wb-dialog').addEventListener('click',event=>{if(event.target===$('wb-dialog')){const r=event.target.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeDialog();}});
  $('wb-open').onclick=()=>{if(!busy)dialog('Open a model or project',`<p style="color:#8da4be">Open a Nastran deck with its INCLUDE files, or restore a saved WebMesh project.</p><div style="display:flex;gap:10px;margin-top:20px">${button('wb-open-deck-dialog','Open Nastran deck','folder','primary')}${button('wb-open-project-dialog','Open project','file')}</div>`);};
  $('wb-dialog-body').addEventListener('click',event=>{if(event.target.closest('#wb-help-example')){closeDialog();run(example);}if(event.target.closest('#wb-open-deck-dialog')){closeDialog();$('file').click();}if(event.target.closest('#wb-open-project-dialog')){closeDialog();$('wb-project-file').click();}});
  $('wb-new').onclick=()=>{
    if(busy)return;
    const state=engine()?.getState(),counts=state?.counts||state||{};
    if(!counts.nodes&&!counts.elements&&!cadWorkspace.hasGeometry()){nameProject('Untitled model');return;}
    dialog('Start a new model',`<p style="color:#9cb2ca">Save your project to keep the current model before clearing the workspace.</p><div style="display:flex;gap:10px;margin-top:20px">${button('wb-save-before-new','Save project','file')}${button('wb-confirm-new','Clear workspace','plus','primary')}</div>`);
  };
  $('wb-dialog-body').addEventListener('click',event=>{
    if(busy)return;
    if(event.target.closest('#wb-save-before-new'))run(saveProject);
    if(event.target.closest('#wb-confirm-new')){operationRevision++;closeDialog();engine().previewMesh?.(null);$('btnClear').click();cadWorkspace.clear();historyItems=[];$('wb-history').textContent='Your modeling operations appear here.';nameProject('Untitled model');invalidatePreview();message('New workspace ready.');renderPanel();refresh(true);}
  });
  $('wb-export').onclick=()=>run(async()=>{download(await engine().exportDeck(),projectName.replace(/[^\w.-]+/g,'_')+'.bdf');message('Nastran deck exported.');});
  $('wb-save').onclick=()=>run(saveProject);
  $('wb-project-file').onchange=event=>run(async()=>{
    const file=event.target.files[0];event.target.value='';if(!file)return;
    const data=JSON.parse(await file.text());if(data.format!=='webmesh-project'||data.version!==1||typeof data.deck!=='string'||(data.name!=null&&typeof data.name!=='string'))throw Error('This is not a supported WebMesh project.');
    const cadRestore=await cadWorkspace.stageRestore(data.cad);
    await engine().loadDeck(data.deck,data.name||file.name);nameProject(data.name||file.name);historyItems=Array.isArray(data.history)?data.history.filter(item=>item&&typeof item.text==='string'&&typeof item.time==='string').slice(0,5):[];
    if(cadRestore&&Array.isArray(data.cad?.mesh?.elements))await engine().bindMeshOwner(cadRestore.imported.cadId,data.cad.mesh.elements);
    cadWorkspace.commitRestore(cadRestore);nameProject(data.name||file.name);
    operationRevision++;message('Project restored.');logOperation('Opened project');renderPanel();event.target.value='';
  });
  $('wb-cad-file').onchange=event=>{const file=event.target.files[0];event.target.value='';if(file&&!busy)run(()=>cadWorkspace.importFile(file));};
  $('file').addEventListener('change',event=>{if(event.target.files[0]){operationRevision++;invalidatePreview();cadWorkspace.clear();nameProject(event.target.files[0].name.replace(/\.[^.]+$/,''));}});
  $('fileResults').addEventListener('change',()=>{logOperation('Imported results file');message('Results file selected. Open result controls to inspect output.');});
  $('wb-example').onclick=()=>run(example);
  // While preparing CAD, the view's undo/redo walk the geometry history instead of the model's.
  const cadHistory=()=>activeTab==='mesh'&&cadWorkspace.historyActive?.();
  $('wb-undo').onclick=()=>{if(busy)return;if(cadHistory()){cadWorkspace.undo();return;}$('btnUndo').click();invalidatePreview();refresh(true);message('Undid the last model operation.');};
  $('wb-redo').onclick=()=>{if(busy)return;if(cadHistory()){cadWorkspace.redo();return;}$('btnRedo').click();invalidatePreview();refresh(true);message('Redid the model operation.');};
  $('wb-fit').onclick=()=>$('btnReset').click();$('wb-view-iso').onclick=()=>engine().setView?.('iso');
  $('wb-edges').onclick=()=>$('showFilledEdges').click();$('wb-shading').onclick=()=>$('shadingToggle').click();
  $('wb-projection').onclick=()=>{$('parallelToggle').click();$('wb-projection').textContent=$('parallelToggle').getAttribute('aria-pressed')==='true'?'Orthographic':'Perspective';};
  $('wb-display').onclick=()=>openTool('display');$('wb-measure').onclick=()=>openTool('measure');$('wb-quality').onclick=checkMesh;
  $('wb-selection-more').onclick=()=>openTool('selection');$('wb-clear-selection').onclick=()=>{if(!busy)$('btnClearSelectionToolbar').click();};$('wb-select-all').onclick=()=>{if(busy)return;const mesh=engine().getMesh();engine().select($('selEntity').value==='element'?{elements:mesh.elements.map(e=>e.id)}:{nodes:mesh.nodes.map(n=>n.id)});refresh(true);};
  document.querySelectorAll('[data-select]').forEach(el=>el.onclick=()=>{if(busy)return;engine()?.setCadSelectionMode?.('none');const selectEl=$('selEntity');selectEl.value=el.dataset.select;selectEl.dispatchEvent(new Event('change',{bubbles:true}));document.querySelectorAll('[data-select]').forEach(other=>other.classList.toggle('active',other===el));});
  $('wb-log').onclick=()=>mountLegacy('statusDock','Activity log');
  $('wb-help').onclick=()=>dialog('WebMesh Studio',`<p style="color:#9fb3ca">Build a mesh in Geometry, repeat it with Pattern, and finish your solver definitions in Model setup. Open existing Nastran decks and MYSTRAN F06 results through Open and Post-process.</p><div style="margin-top:12px">${button('wb-help-example','Load example model',null)}</div><h3 style="font-size:12px;margin-top:24px">Viewport controls</h3><div class="wb-shortcuts"><span>Orbit</span><kbd>Left drag</kbd><span>Pan</span><kbd>Ctrl + left drag</kbd><span>Zoom</span><kbd>Scroll wheel</kbd><span>Box select</span><kbd>Alt + drag</kbd><span>Polygon select</span><kbd>Ctrl + Shift + click</kbd><span>Set pivot</span><kbd>Double-click</kbd><span>Fit model</span><kbd>F</kbd><span>Undo / redo</span><kbd>Ctrl + Z / Shift + Z</kbd></div><h3 style="font-size:12px;margin-top:24px">CAD meshing</h3><p style="color:#829cb8;font-size:12px">Run <code>python3 server.py</code> in the project directory and open <code>http://127.0.0.1:8765</code>. Gmsh must be on PATH. Import CAD, then work through <b>Prepare → Size → Mesh</b>. Pick a solid, face, edge or vertex and the context card suggests slices, bounded cuts and feature removals; picked edges or vertex pairs build a Cut that stops where they stop, and picked neighboring solids can be fused back together. Every change is previewed before you apply it, and Auto-fix can decompose solids into mapped blocks for you; when it stops short, its cuts stay so you can finish by hand. Size solves the edge-count equations so blocks conform; Mesh builds native HEX8/HEX20 elements with a quality preview. Gmsh tet, tri, quad and sweep methods remain under Mesh → Other.</p><div class="wb-shortcuts"><span>Pick solid / face / edge / vertex</span><kbd>1 · 2 · 3 · 4</kbd><span>Add to selection</span><kbd>Shift or Ctrl + click</kbd><span>Apply / cancel preview</span><kbd>Enter · Esc</kbd><span>Edge count − / +, fix</span><kbd>− · + · L</kbd><span>Hide solids, show all, X-ray</span><kbd>H · Shift+H · X</kbd></div><p style="color:#829cb8;font-size:12px">The editor uses consistent units of your choice. Default material values assume mm, N, s and tonne. It prepares and reviews models; run your analysis in an external Nastran-compatible solver.</p>`);
  document.addEventListener('keydown',event=>{
    if(/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)||$('wb-dialog').open)return;
    if(event.key.toLowerCase()==='f'&&!event.ctrlKey&&!event.metaKey){event.preventDefault();$('btnReset').click();}
  });
  window.addEventListener('webmesh:change',()=>{operationRevision++;refresh(true);});
  $('wb-tree-filter').addEventListener('input',event=>{const term=event.target.value.toLowerCase();$('wb-tree').querySelectorAll('button').forEach(el=>el.hidden=!el.textContent.toLowerCase().includes(term));});
  window.WebMeshWorkbench={setTab,openTool,refresh,cad:cadWorkspace,example:()=>run(example)};
  $('wb-panel-body').addEventListener('input',invalidatePreview);
  $('flyoutCloseBtn').click();nameProject('Untitled model');
  renderPanel();refresh(true);checkBridge();setInterval(()=>refresh(),700);
})();
