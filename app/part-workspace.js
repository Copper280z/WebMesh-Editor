/* Per-part CAD drafts and the assembly inspector. Solver changes use review(). */
(()=>{
  'use strict';const P=window.WebMeshParts,C=window.WebMeshCadProject,R=window.WebMeshCadReplacement;
  const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const btn=(action,label,id='')=>`<button class="wb-btn" data-part-action="${action}" data-part-id="${esc(id)}">${esc(label)}</button>`;
  const field=(key,label,value)=>`<label class="wb-field"><span>${esc(label)}</span><input data-part-field="${key}" aria-label="${esc(label)}" value="${esc(value)}"></label>`;
  window.WebMeshPartWorkspace={create(h){
    const drafts=new Map(),versions=new Map(),bindings=new Map();let active=null,referenceEntries=[];
    const state=()=>h.engine().getProjectOwnership(),objects=()=>state()?.project.objects||[],part=id=>objects().find(o=>o.id===id),cad=()=>h.cad();
    const version=id=>part(part(id)?.definition.source)?.definition.replacement?.revisionId||'initial';
    const versionKey=(id,v)=>JSON.stringify([id,v]);
    function stash(){const draft=cad().captureDraft();if(active&&draft){draft.partId=active;drafts.set(active,draft);versions.set(versionKey(active,bindings.get(active)||'initial'),draft);}}
    function live(){return objects().filter(P.isPart);}
    function synchronize(history=false){if(active&&!P.isPart(part(active))){stash();cad().clear();active=null;h.engine().setActiveCadSource?.(null);}if(history)return syncVersions();}
    async function syncVersions(){const view=h.engine().getProjectView?.().preferences;stash();for(const p of live())if(bindings.has(p.id)&&bindings.get(p.id)!==version(p.id)){
      const wanted=version(p.id);let d=versions.get(versionKey(p.id,wanted));
      if(!d){d=await cad().stageRestore(part(p.definition.source).definition.snapshot,null,p.id);await cad().adoptRestore?.(d);}
      if(version(p.id)!==wanted)continue;d.partId=p.id;drafts.set(p.id,d);bindings.set(p.id,wanted);if(active===p.id)cad().restoreDraft(d);
    }if(!active){const restored=live().find(p=>p.definition.source&&drafts.has(p.id));if(restored){active=restored.id;h.engine().setActiveCadSource?.(restored.definition.source);cad().restoreDraft(drafts.get(active));}}refreshVisibility();if(view)h.engine().setProjectView?.(view);}
    function render(){synchronize();return {body:`<div class="wb-owner-actions">${btn('add','Add CAD part…')}${btn('show','Fit assembly')}</div><div class="ws-part-list">${live().map(p=>`<button class="wb-owner-link" data-part-action="owner" data-part-id="${esc(p.id)}">${esc(p.name)}</button>`).join('')||'<p>Add a CAD part, create a primitive, or open a project.</p>'}</div>`,foot:''};}
    function partEditor(id){
      const p=part(id),map=new Map(objects().map(o=>[o.id,o])),meshes=P.sourceMeshes(map,id),instances=objects().filter(o=>P.isInstance(o)&&o.definition.part===id),reference=map.has(id+'/source-participation');
      h.dialog(p.name,`<div class="ws-editor-summary"><strong>Part</strong><span>${meshes.length} mesh regions · ${instances.length} live instances</span></div>${field('name','Part name',p.name)}<dl class="ws-part-meta"><dt>CAD source</dt><dd>${esc(map.get(p.definition.source)?.definition.snapshot?.filename||'Independent mesh')}</dd><dt>Source placement</dt><dd>${reference?'Reference only':'Included in analysis'}</dd></dl><div class="wb-owner-actions">${p.definition.source?btn('preparePart','Prepare / mesh',id):''}${btn('instancePart','Add live instance',id)}${btn('renamePart','Review name',id)}</div><h3>Meshes</h3>${meshes.map(m=>btn('meshPart',m.name,m.id)).join('')||'<p>No mesh yet.</p>'}${instances.length?'<h3>Instances</h3>'+instances.map(i=>btn('placementPart',i.name,i.id)).join(''):''}<details class="ws-help"><summary>Analysis participation & removal</summary><p>Visibility only changes the display. Source participation changes which elements are exported for analysis.</p>${meshes.length?btn('participationPart',reference?'Include source in analysis':'Use source as reference',id):''}${btn('removePart','Delete…',id)}</details><p data-part-error role="alert"></p>`);
      if(p.definition.source){
        const controls=document.createElement('div');controls.className='wb-owner-actions';controls.innerHTML=btn('replaceSource','Replace CAD source…',id)+'<input type="file" data-part-replacement accept=".step,.stp,.iges,.igs,.brep" hidden>';
        body().querySelector('.wb-owner-actions').append(controls);
        const input=controls.querySelector('input');action('replaceSource',()=>input.click());input.onchange=()=>{const file=input.files?.[0];input.value='';if(file)h.run(()=>replaceFile(id,file));};
      }
      const affected=R?.closure(state(),[...meshes.map(m=>m.id),...instances.map(i=>i.id)]),suspended=objects().filter(o=>affected?.has(o.id)&&o.facts?.suspendedReason&&!o.definition.instance&&!o.definition.assemblyMember);
      if(suspended.length){const panel=document.createElement('section');panel.innerHTML='<h3>Repair before analysis</h3>'+suspended.map(o=>`<div class="ws-repair-row"><span>${esc(o.name)}</span>${btn('repairObject',o.definition.generator.startsWith('cad-')&&o.kind==='mesh'?'Remesh':'Repair / reactivate',o.id)}</div>`).join('');body().append(panel);panel.querySelectorAll('button').forEach(b=>b.onclick=()=>h.run(()=>repairObject(b.dataset.partId)));}
      action('preparePart',()=>edit(id));action('instancePart',()=>editor(null,id));action('renamePart',()=>h.review(P.part({id,name:get('name'),source:p.definition.source},state()),{owner:id}));action('participationPart',()=>h.review(P.sourceReference(state(),id,!reference),{owner:id}));action('removePart',()=>h.remove(id));
      body().querySelectorAll('[data-part-action="meshPart"]').forEach(b=>b.onclick=()=>h.owner(b.dataset.partId));body().querySelectorAll('[data-part-action="placementPart"]').forEach(b=>b.onclick=()=>editor(b.dataset.partId));
    }
    async function legacyDraft(){
      if(active)return null;const d=cad().captureDraft();if(!d)return null;
      const roots=(d.data.meshes||[]).map(m=>part(m.projectOwner)).filter(Boolean),sourceId=roots[0]?.definition.source||'source-'+crypto.randomUUID();
      const id='part-'+crypto.randomUUID(),snapshot=await cad().serializeDraft(d),src=part(sourceId)||{id:sourceId,name:d.file.name+' · CAD source',kind:'source',definition:{generator:'cad-source-v1',geometryKey:await C.geometryFingerprint(d.imported.topology),snapshot,cards:[]}};
      const p=P.part({id,name:d.file.name.replace(/\.[^.]+$/,''),source:sourceId},{project:{objects:[...objects().filter(o=>o.id!==src.id),src]}}).objects[0];
      const meshes=objects().filter(o=>['cad-mapped-v1','cad-shell-v1'].includes(o.definition.generator)&&o.definition.source===sourceId).map(o=>({...structuredClone(o),dependsOn:[...o.dependsOn,id],definition:{...structuredClone(o.definition),part:id}}));
      d.partId=id;return{id,draft:d,objects:[src,p,...meshes]};
    }
    async function addFile(file){
      if(file.size>23*1024*1024)throw Error('Choose a CAD file smaller than 23 MB.');
      const content=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(file);});
      return addImported(await cad().stageRestore({filename:file.name,content}));
    }
    function chooseReplacement(id){partEditor(id);body().querySelector('[data-part-replacement]').click();}
    async function replaceFile(id,file){
      if(file.size>23*1024*1024)throw Error('Choose a CAD file smaller than 23 MB.');
      const content=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(file);});
      return replaceImported(id,await cad().stageRestore({filename:file.name,content},null,id));
    }
    async function replaceImported(id,staged){
      stash();let handedOff=false;
      try{
        const base=JSON.stringify(state()),p=part(id),src=part(p?.definition.source);if(!src)throw Error('Select a CAD part.');
        // Retain even uncommitted preparation and its complete executable history.
        const old=drafts.get(id);if(old){await cad().serializeDraft(old);versions.set(versionKey(id,version(id)),old);}
        let before=src.definition.topology,beforePreview=null;
        if(old&&await C.geometryFingerprint(old.imported.topology)===src.definition.geometryKey)beforePreview=old.imported.preview;
        if(!before||!beforePreview){const restored=await cad().stageRestore(src.definition.snapshot);try{before=restored.imported.topology;beforePreview=restored.imported.preview;}finally{await cad().discardRestore?.(restored);}}
        const topology=staged.imported.topology,patterns=window.WebMeshCadPatterns.report(state(),src.id,before,topology),rows=R.report(state(),src.id,before,topology),snapshot=await cad().serializeDraft(staged),geometryKey=await C.geometryFingerprint(topology),revisionId=crypto.randomUUID();
        const currentDraft=cad().captureDraft(),wasVisible=h.engine().getCadState?.().visible,previousView=h.engine().getProjectView?.().preferences;let comparing=false;
        function endComparison(){if(!comparing)return;comparing=false;if(currentDraft)cad().restoreDraft(currentDraft);else h.engine().clearCadGeometry?.();h.engine().setActiveCadSource?.(part(active)?.definition.source||null);h.engine().setCadVisible?.(!!wasVisible);if(previousView)h.engine().setProjectView?.(previousView);}
        function inspectMatch(row){comparing=true;if(previousView)h.engine().setProjectView?.({...previousView,objects:{...previousView.objects,[id]:false}});h.engine().setActiveCadSource?.(null);h.engine().setCadGeometry?.(staged.imported.preview,{topology,name:snapshot.filename,fit:true});h.engine().setCadVisible?.(true);h.engine().setCadSelectionMode?.('none');
          if(!row)return;const entity=before[row.family]?.find(e=>e.id===row.id),faceIds=row.family==='volumes'?entity?.faces||[]:row.family==='faces'?[row.id]:[],edgeIds=new Set(row.family==='edges'?[row.id]:faceIds.flatMap(id=>before.faces.find(f=>f.id===id)?.edges||[]).map(Math.abs)),positions=[];
          for(const e of beforePreview?.edges||[])if(edgeIds.has(e.id))for(let i=3;i<e.points.length;i+=3)positions.push(...e.points.slice(i-3,i+3));
          h.engine().getCadViewport?.()?.setOverlay('source-before',{type:'lines',positions,color:0xffb454,depthTest:false,renderOrder:20,includeInFit:true});const v=body().querySelector(`[data-cad-match="${rows.indexOf(row)}"]`).value;h.engine().selectCad?.({[row.family]:v?[Number(v)]:[]});h.engine().fitView?.();
        }
        h.dialog('Replace CAD source · '+p.name,`<div class="ws-editor-summary"><strong>${esc(src.definition.snapshot.filename)} → ${esc(snapshot.filename)}</strong><span>${rows.filter(r=>r.status==='exact').length} exact · ${rows.filter(r=>r.status!=='exact').length} need a decision</span></div><p>Exact mesh coverage and mounting nodes stay unchanged. Changed faces and unmatched patterns require repair before analysis.</p><h3>Named patterns</h3>${patterns.map((p,i)=>`<label class="wb-field"><span>${esc(p.name)}<small> · ${esc(p.status)} · ${p.pattern.holes.length} holes</small></span><select data-pattern-match="${i}" aria-label="Replacement pattern ${esc(p.name)}"><option value="">Leave unresolved</option>${p.candidates.map((c,j)=>`<option value="${j}" ${p.target&&JSON.stringify(p.target)===JSON.stringify(c.ids)?'selected':''}>${c.distance<1e-6?'Exact':'Moved '+Number(c.distance.toPrecision(5))+' model units'} · edges ${c.ids.join(', ')}</option>`).join('')}</select><button class="wb-btn" data-inspect-pattern="${i}">Inspect pattern</button></label>`).join('')||'<p>No named patterns. Define one in Mounting region.</p>'}<details><summary>Individual CAD entities</summary><div class="ws-topology-matches">${rows.map((r,i)=>`<label class="wb-field"><span>${esc(r.family)} ${r.id} · ${esc(r.status)}<small> ${esc(r.users.join(', '))}${r.anchor?.center?' · old center '+r.anchor.center.map(n=>Number(n.toPrecision(5))).join(', '):''}</small></span><select data-cad-match="${i}" aria-label="Replacement ${r.family} ${r.id}"><option value="">Leave unresolved</option>${(topology[r.family]||[]).map(e=>`<option value="${e.id}" ${e.id===r.target?'selected':''}>${e.id} · ${esc(e.type||r.family)}${r.candidates.some(c=>c.id===e.id)?' · candidate':''}${e.center?' · '+e.center.map(n=>Number(n.toPrecision(5))).join(', '):''}</option>`).join('')}</select><button class="wb-btn" data-inspect-match="${i}">Inspect old / new</button></label>`).join('')||'<p>No existing CAD selections to match.</p>'}</div></details><p class="ws-match-legend">Amber: old boundary · Highlight: proposed selection</p><details class="ws-help"><summary>What is retained?</summary><p>Part identity, names, live placements, materials, recipes, overrides and the old CAD draft/history. Automatic matches require unique geometry and adjacency; entity numbers and counts are never identity. Prepared sheets and cuts must be recreated if absent in this file. Local meshing controls are reviewed again on the replacement.</p></details>${btn('inspectReplacement','View replacement')}${btn('reviewReplacement','Review source replacement')}${btn('discardReplacement','Discard')}<p data-part-error role="alert"></p>`);
        h.onClose?.(()=>{endComparison();return cad().discardRestore?.(staged);});handedOff=true;
        body().querySelectorAll('[data-inspect-pattern]').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.inspectPattern),p=patterns[i];inspectMatch(null);const edges=new Set(p.pattern.holes.map(h=>h.id)),positions=[];for(const e of beforePreview.edges||[])if(edges.has(e.id))for(let j=3;j<e.points.length;j+=3)positions.push(...e.points.slice(j-3,j+3));h.engine().getCadViewport?.()?.setOverlay('source-before',{type:'lines',positions,color:0xffb454,depthTest:false,renderOrder:20,includeInFit:true});const value=body().querySelector(`[data-pattern-match="${i}"]`).value;h.engine().selectCad?.({edges:value===''?[]:p.candidates[Number(value)].ids});h.engine().fitView?.();});
        action('inspectReplacement',()=>inspectMatch(null));body().querySelectorAll('[data-inspect-match]').forEach(b=>b.onclick=()=>inspectMatch(rows[Number(b.dataset.inspectMatch)]));
        action('discardReplacement',()=>h.close());
        action('reviewReplacement',async()=>{
          if(JSON.stringify(state())!==base)throw Error('The project changed while matching. Discard and replace the source again.');
          const choices=Object.fromEntries(rows.map((r,i)=>{const v=body().querySelector(`[data-cad-match="${i}"]`).value;return [r.family+':'+r.id,v?Number(v):null];}));
          const patternChoices=Object.fromEntries(patterns.map((p,i)=>{const v=body().querySelector(`[data-pattern-match="${i}"]`).value;return [p.id,v===''?null:p.candidates[Number(v)].ids];}));
          const request=R.build(state(),{part:id,topology,snapshot,geometryKey,before,choices,patternChoices,revisionId});
          const roots=request.objects.filter(o=>['cad-mapped-v1','cad-shell-v1'].includes(o.definition.generator));
          staged.data.meshes=roots.map((o,i)=>({id:i+1,kind:o.definition.generator==='cad-shell-v1'?'shell':'hex',label:o.name,projectOwner:o.id,volumes:o.definition.generator==='cad-mapped-v1'?o.definition.replacementTargets||o.definition.targets||[]:[],faces:o.definition.generator==='cad-shell-v1'?o.definition.replacementTargets||o.definition.targets||[]:[],elements:o.facts?.suspendedReason?[]:o.definition.cards.filter(c=>c.family==='elems').map(c=>c.id),properties:o.definition.sections.map(s=>s.pid),stale:!!o.facts?.suspendedReason||!!o.definition.pendingReplacement}));
          staged.data.editingOwner=roots[0]?.id||null;staged.data.regionName=roots[0]?.name||'';
          endComparison();h.onClose?.(null);
          try{await h.review(request,{owner:id,onDiscard:()=>cad().discardRestore?.(staged),async beforeCommit(){if(JSON.stringify(state())!==base)throw Error('The project changed. Review the source replacement again.');await cad().adoptRestore?.(staged);},onApplied(){stash();staged.partId=id;drafts.set(id,staged);bindings.set(id,revisionId);versions.set(versionKey(id,revisionId),staged);active=id;h.engine().setActiveCadSource?.(src.id);cad().restoreDraft(staged);refreshVisibility();h.parts();},note:'Exact coverage retains its solver cards. Remesh changed faces and repair unresolved patterns; Solve remains blocked until those repairs are complete.'});}catch(error){await cad().discardRestore?.(staged);throw error;}
        });
      }catch(error){if(!handedOff)await cad().discardRestore?.(staged);throw error;}
    }
    async function repairObject(id){const o=part(id);if(o?.definition.generator==='cad-patch-required-v1')return editMesh(o.definition.mesh);if(['cad-mapped-v1','cad-shell-v1'].includes(o?.definition.generator))return editMesh(id);return h.review(R.resume(state(),id),{owner:id});}
    async function addImported(staged){
      stash();try{const before=JSON.stringify(state()),legacy=await legacyDraft(),file=staged.file;
      const id=staged.scope||'part-'+crypto.randomUUID(),source=id+'/source',snapshot=await cad().serializeDraft(staged),geometryKey=await C.geometryFingerprint(staged.imported.topology);
      const src={id:source,name:file.name+' · CAD source',kind:'source',definition:{generator:'cad-source-v1',geometryKey,topology:structuredClone(staged.imported.topology),snapshot,cards:[]}};
      const p=P.part({id,name:file.name.replace(/\.[^.]+$/,''),source},{project:{objects:[...objects(),src]}}).objects[0];
      await h.review({label:'Add part '+p.name,objects:[...(legacy?.objects||[]),src,p]},{owner:id,onDiscard:()=>cad().discardRestore?.(staged),async beforeCommit(){if(JSON.stringify(state())!==before)throw Error('The project changed while importing. Add this part again.');await cad().adoptRestore?.(staged);},onApplied(){if(legacy)drafts.set(legacy.id,legacy.draft);staged.partId=id;drafts.set(id,staged);bindings.set(id,version(id));active=id;h.engine().setActiveCadSource?.(source);cad().restoreDraft(staged);refreshVisibility();h.parts();}});
      }catch(error){await cad().discardRestore?.(staged);throw error;}
    }
    async function edit(id,restore=null){
      stash();const p=part(id);if(!P.isPart(p))throw Error('This part is no longer in the project.');
      await syncVersions();let d=restore?await cad().stageRestore(restore,null,id):drafts.get(id);
      if(!d){const src=part(p.definition.source);if(!src)throw Error('This independent mesh has no CAD draft.');d=await cad().stageRestore(src.definition.snapshot,null,id);}
      await cad().adoptRestore?.(d);d.partId=id;drafts.set(id,d);bindings.set(id,version(id));active=id;h.engine().setActiveCadSource?.(p.definition.source);cad().restoreDraft(d);h.mesh();refreshVisibility();
    }
    async function editMesh(id){
      const o=part(id);if(!o?.definition.part)throw Error('This mesh has no owning part.');
      await edit(o.definition.part);const d=cad().captureDraft(),saved=C.restoreData(state(),id),records=d.data.meshes||[],known=new Set(saved.meshes.map(m=>m.projectOwner));let counter=Math.max(0,...records.map(m=>m.id));
      const meshes=[...records.filter(m=>!m.projectOwner||!known.has(m.projectOwner)),...saved.meshes.map(m=>({...m,id:records.find(r=>r.projectOwner===m.projectOwner)?.id||++counter}))];
      cad().restoreDraft({...d,data:{...d.data,settings:saved.settings,editingOwner:id,regionName:o.name,meshes},selection:null,pick:null});stash();h.mesh();
    }
    function refreshVisibility(){
      stash();const entries=live().filter(p=>p.definition.source).map(p=>({id:p.definition.source,preview:drafts.get(p.id)?.imported.preview})).filter(e=>e.preview);
      if(entries.length!==referenceEntries.length||entries.some((e,i)=>e.id!==referenceEntries[i].id||e.preview!==referenceEntries[i].preview)){referenceEntries=entries;h.engine().setProjectCadReferences?.(entries);}
    }
    function show(){stash();h.engine().setCadVisible?.(false);refreshVisibility();h.engine().fitView?.();}
    function editor(id,partId){const old=part(id),p=part(partId||old?.definition.part);if(!P.isPart(p))throw Error('Select a part.');const t=old?.definition.transform||P.identity();h.dialog(old?'Edit '+old.name:'Add instance of '+p.name,field('name','Instance name',old?.name||p.name+' instance')+field('translation','Translation X, Y, Z (model units)',t.translation.join(', '))+field('rotation','Rotation X, Y, Z (degrees)',t.rotation.join(', '))+`<label class="wb-field"><span>Reflect before rotation</span><select data-part-field="reflection" aria-label="Reflect before rotation">${[['none','None'],['x','Across YZ'],['y','Across XZ'],['z','Across XY']].map(([v,l])=>`<option value="${v}" ${t.reflection===v?'selected':''}>${l}</option>`).join('')}</select></label><p>Reflect about the source origin, rotate about global X, then Y, then Z, then translate. Every placement shares source mesh and section changes. Supports and payloads belong to the assembly.</p>${btn('reviewInstance','Review placement')}${old?btn('scope','Create instance region',old.id)+btn('unique','Make independent mesh',old.id)+btn('remove','Delete…',old.id):''}<p data-part-error role="alert"></p>`);bindDialog();
      action('reviewInstance',()=>{const vec=k=>get(k).split(/[\s,]+/).filter(Boolean).map(Number);return h.review(P.instance({id:old?.id||'instance-'+crypto.randomUUID(),part:p.id,name:get('name'),transform:{translation:vec('translation'),rotation:vec('rotation'),reflection:get('reflection')}},state(),h.engine().getNextIds()),{owner:old?.id});});}
    const body=()=>document.getElementById('wb-dialog-body'),get=k=>body().querySelector(`[data-part-field="${k}"]`)?.value;
    const action=(k,fn)=>body().querySelector(`[data-part-action="${k}"]`)?.addEventListener('click',()=>h.run(async()=>{try{await fn();}catch(e){const el=body().querySelector('[data-part-error]');if(el)el.textContent=e.message;else throw e;}}));
    function scope(id){const options=objects().filter(o=>o.definition.generator==='cad-mount-region-v1'||window.WebMeshRegions.isRegion(o)&&!o.definition.scope);h.dialog('Region on '+part(id).name,field('name','Region name',part(id).name+' mounting region')+`<label class="wb-field"><span>Source region</span><select data-part-field="region" aria-label="Source region">${options.map(o=>`<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select></label><p>This region follows the source region through remeshing and this instance through placement changes. Explicit source regions still require repair when their entities change.</p>${btn('reviewScope','Review instance region')}<p data-part-error role="alert"></p>`);action('reviewScope',()=>{const r=P.region({id:'region-'+crypto.randomUUID(),name:get('name'),instance:id,region:get('region')},state()),d=r.objects.find(o=>o.definition.scope)?.definition;return h.review(r,{note:part(id).name+': '+d.resolved.nodes.length+' mapped nodes'+(d.entity==='element'?' / '+d.resolved.elements.length+' elements':'')+'. Membership follows the selected source region and this placement.'});});}
    function bindDialog(){action('scope',()=>scope(body().querySelector('[data-part-action="scope"]').dataset.partId));action('unique',()=>{const id=body().querySelector('[data-part-action="unique"]').dataset.partId;return h.review(P.makeUnique(state(),id),{owner:id+'/unique',note:'Retain this placement as an independent mesh snapshot. Its nodes, elements and assembly references keep their IDs. It will no longer follow CAD remeshing; use mesh actions to edit it independently. Shared materials and sections remain shared.'});});action('remove',()=>h.remove(body().querySelector('[data-part-action="remove"]').dataset.partId));}
    function bind(){document.querySelectorAll('#wb-panel-body [data-part-action]').forEach(b=>b.onclick=()=>b.dataset.partAction==='owner'?h.owner(b.dataset.partId):h.run(async()=>{const id=b.dataset.partId;switch(b.dataset.partAction){case'add':document.getElementById('wb-part-file').click();break;case'show':show();break;case'edit':await edit(id);break;case'instance':editor(null,id);break;case'editInstance':editor(id);break;case'owner':h.owner(id);break;case'participation':await h.review(P.sourceReference(state(),id,!part(id+'/source-participation')));break;case'remove':await h.remove(id);break;case'rename':{const p=part(id);h.dialog('Rename '+p.name,field('name','Part name',p.name)+btn('renamePart','Review name'));action('renamePart',()=>h.review(P.part({id,name:get('name'),source:p.definition.source},state()),{owner:id}));break;}}}));}
    function savedDraft(data,id){const result=structuredClone(data);result.meshes=(result.meshes||[]).filter(m=>!m.projectOwner||part(m.projectOwner)?.definition.part===id);if(result.editingOwner&&part(result.editingOwner)?.definition.part!==id){result.editingOwner=null;result.regionName='';}return result;}
    async function serialize(){synchronize();stash();const entries=[],history=[];for(const p of live()){const draft=drafts.get(p.id);if(p.definition.source&&draft)entries.push({part:p.id,data:savedDraft(await cad().serializeDraft(draft),p.id)});}for(const [key,d]of versions){const [id,v]=JSON.parse(key);if(P.isPart(part(id))&&part(id).definition.source&&v!==version(id))history.push({part:id,version:v,data:savedDraft(await cad().serializeDraft(d),id)});}return{version:1,active,entries,...(history.length?{history}:{})};}
    async function stageRestore(data,ownership){
      if(!data)return null;if(data.version!==1||!Array.isArray(data.entries))throw Error('Invalid saved part drafts.');
      const ids=new Set(),map=new Map((ownership?.project.objects||[]).map(o=>[o.id,o])),entries=[];
      // Validate the complete envelope before opening any server sessions.
      for(const item of data.entries){
        if(!item?.data||(item.data.meshes||[]).some(m=>m.projectOwner&&map.get(m.projectOwner)?.definition.part!==item.part)||item.data.editingOwner&&map.get(item.data.editingOwner)?.definition.part!==item.part)throw Error('Saved mesh draft belongs to a different part.');
        if(ids.has(item.part)||!P.isPart(map.get(item.part))||!map.get(item.part).definition.source)throw Error('Saved CAD draft has no unique part.');
        ids.add(item.part);cad().validateRestore?.(item.data);
      }
      const historyKeys=new Set();
      if(data.history!==undefined&&!Array.isArray(data.history))throw Error('Invalid CAD replacement history.');
      for(const item of data.history||[]){const key=versionKey(item.part,item.version);if(!ids.has(item.part)||typeof item.version!=='string'||!item.version||historyKeys.has(key)||!item.data)throw Error('Invalid CAD replacement history entry.');historyKeys.add(key);cad().validateRestore?.(item.data);if((item.data.meshes||[]).some(m=>m.projectOwner&&map.get(m.projectOwner)?.definition.part!==item.part)||item.data.editingOwner&&map.get(item.data.editingOwner)?.definition.part!==item.part)throw Error('Historical CAD mesh belongs to a different part.');}
      if(data.active!=null&&!ids.has(data.active))throw Error('Saved active CAD part is missing.');
      if(!data.entries.length)return null;
      const transaction=await cad().beginRestore();
      try{for(const item of data.entries){const d=await cad().stageRestore(item.data,transaction,item.part);d.partId=item.part;entries.push([item.part,d]);}
        const history=[];for(const item of data.history||[]){const d=await cad().stageRestore(item.data,transaction,item.part+'@'+item.version);d.partId=item.part;history.push([versionKey(item.part,item.version),d]);}
        return {active:data.active,entries,history,transaction};
      }catch(error){await cad().abortRestore(transaction);throw error;}
    }
    async function retain(){stash();for(const draft of new Set([...drafts.values(),...versions.values()]))await cad().serializeDraft(draft,{checkpoint:false});}
    async function finishRestore(data,commit){if(data?.transaction)return commit?cad().finishRestore(data.transaction,true):cad().abortRestore(data.transaction);}

    function commitRestore(data){drafts.clear();versions.clear();bindings.clear();active=null;referenceEntries=[];cad().clear();h.engine().setActiveCadSource?.(null);h.engine().setProjectCadReferences?.([]);if(!data)return;for(const[id,d]of data.entries){drafts.set(id,d);bindings.set(id,version(id));}for(const [key,d]of data.history||[])versions.set(key,d);active=data.active||data.entries[0]?.[0]||null;if(active){h.engine().setActiveCadSource?.(part(active)?.definition.source);cad().restoreDraft(drafts.get(active));}refreshVisibility();}
    function captureState(){stash();return {active,entries:[...drafts],history:[...versions],legacy:active?null:cad().captureDraft()};}
    function restoreState(snapshot){commitRestore(snapshot);if(snapshot?.legacy)cad().restoreDraft(snapshot.legacy);}
    function activate(value){if(value){stash();show();}}
    function open(id){const o=part(id);if(P.isPart(o)){partEditor(id);return true;}if(o?.kind==='source'){const p=live().find(p=>p.definition.source===id);if(p){partEditor(p.id);return true;}}if(P.isInstance(o)){editor(id);return true;}if(o?.definition.generator===P.MESH){editor(o.definition.instance);return true;}return false;}
    return{render,bind,open,addFile,addImported,replaceFile,replaceImported,chooseReplacement,repairObject,edit,editMesh,activate,show,serialize,retain,captureState,restoreState,stageRestore,finishRestore,commitRestore,synchronize,refreshVisibility,clear(){drafts.clear();versions.clear();bindings.clear();active=null;referenceEntries=[];cad().clear();h.engine().setActiveCadSource?.(null);h.engine().setProjectCadReferences?.([]);},active:()=>active};
  }};
})();
