(()=>{
  'use strict';
  const P=window.WebMeshSelections,R=window.WebMeshRegions;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const field=(k,label,value)=>`<label class="wb-field"><span>${esc(label)}</span><input data-repair="${k}" aria-label="${esc(label)}" value="${esc(value)}"></label>`;
  const button=(k,label)=>`<button class="wb-btn" data-repair-action="${k}">${esc(label)}</button>`;
  const select=(k,label,items,value)=>`<label class="wb-field"><span>${esc(label)}</span><select data-repair="${k}" aria-label="${esc(label)}">${items.map(([id,name])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(name)}</option>`).join('')}</select></label>`;
  const parseIds=text=>{const out=[];for(const token of text.trim().split(/[\s,]+/).filter(Boolean)){const range=token.match(/^(\d+)-(\d+)$/);if(range){const a=Number(range[1]),b=Number(range[2]);if(b<a||b-a>100000)throw Error('Use an ascending ID range of at most 100001 entries.');for(let i=a;i<=b;i++)out.push(i);}else if(/^\d+$/.test(token))out.push(Number(token));else throw Error('Use positive IDs or ranges such as 5-9.');}if(out.some(n=>!Number.isSafeInteger(n)||n<1||n>2147483647))throw Error('Use positive 32-bit IDs.');return [...new Set(out)];};
  window.WebMeshSelectionWorkspace={create(h){
    const body=()=>document.getElementById('wb-dialog-body'),state=()=>h.engine().getProjectOwnership(),get=k=>body().querySelector(`[data-repair="${k}"]`)?.value;
    const action=(key,fn)=>body().querySelector(`[data-repair-action="${key}"]`)?.addEventListener('click',()=>h.run(async()=>{try{await fn();}catch(e){const el=body().querySelector('[data-repair-error]');if(el)el.textContent=e.message;else throw e;}}));
    const tail='<p data-repair-error role="alert"></p>';
    async function context(request,options={}){
      const semantic=await h.engine().getAuthoringModel(),current=state(),stamp=JSON.stringify([current,semantic]);
      if(options.repairBaseline&&options.repairBaseline!==stamp)throw Error('The model changed while selection repair was pending. Discard this proposal and regenerate it.');
      return {semantic,pending:P.project(current,semantic,request),options:{...options,repairBaseline:stamp}};
    }
    async function check(options){if(JSON.stringify([state(),await h.engine().getAuthoringModel()])!==options.repairBaseline)throw Error('The model changed. Discard and regenerate this proposal.');}
    const merge=(request,objects)=>({...request,objects:[...new Map([...(request.objects||[]),...objects].map(o=>[o.id,o])).values()]});
    function pickerMarkup(pending,entity){
      const owners=pending.state.project.objects.filter(o=>o.kind==='mesh'&&o.definition.cards?.some(c=>c.family==='elems'));
      return `<fieldset class="wb-region-picker"><legend>Viewport selection · proposed model</legend>${select('pickMode','Pick entities',entity==='element'?[['element','Elements']]:[['node','Nodes'],['face','Face nodes']],entity==='element'?'element':'node')}${select('pickTool','Selection tool',[['pick','Click'],['box','Box'],['navigate','Navigate / orbit']],'pick')}${select('pickOwner','Mesh scope',[['','All mesh owners and plain cards'],...owners.map(o=>[o.id,o.name])],'')}<label><input type="checkbox" data-repair-visible checked> Visible surface only</label><p>Click or drag a box. Shift adds; Ctrl/⌘ subtracts. Face nodes selects the complete clicked facet. Boxes select nodes or facet centers. Use Navigate to orbit; view buttons and wheel zoom remain available.</p><p data-repair-count aria-live="polite"></p>${button('clearPick','Clear picked selection')}${button('fitPick','Fit proposed mesh')}</fieldset>`;
    }
    function startPicker(pending,entity,initial,onChange){
      let picker,selected=initial.slice();
      const mesh=window.WebMeshActionProject.meshOf(pending.semantic),all=pending.state.project.objects;
      function start(){
        const owner=get('pickOwner'),object=all.find(o=>o.id===owner),cards=object?.definition.cards||[];
        const elements=owner?new Set(cards.filter(c=>c.family==='elems').map(c=>c.id)):null;
        const es=mesh.elements.filter(e=>!elements||elements.has(e.id)),nodes=owner?new Set([...cards.filter(c=>c.family==='nodes').map(c=>c.id),...es.flatMap(e=>e.nodes)]):null;
        const available=new Set(entity==='element'?es.map(e=>e.id):mesh.nodes.filter(n=>!nodes||nodes.has(n.id)).map(n=>n.id));
        picker=h.engine().beginMeshSelection({mesh:{nodes:mesh.nodes.filter(n=>!nodes||nodes.has(n.id)),elements:es},mode:get('pickMode'),selected,onChange:ids=>{selected=ids;body().querySelector('[data-repair-count]').textContent=ids.length+' '+(entity==='element'?'elements':'nodes')+' selected'+(ids.some(id=>!available.has(id))?' · '+ids.filter(id=>!available.has(id)).length+' missing or outside this scope':'')+' · '+ids.join(', ');onChange(ids);}});
        picker.configure({tool:get('pickTool'),visibleOnly:body().querySelector('[data-repair-visible]').checked});
      }
      h.dock();start();
      for(const key of ['pickMode','pickTool'])body().querySelector(`[data-repair="${key}"]`).onchange=()=>picker.configure({mode:get('pickMode'),tool:get('pickTool')});
      body().querySelector('[data-repair-visible]').onchange=e=>picker.configure({visibleOnly:e.target.checked});
      body().querySelector('[data-repair="pickOwner"]').onchange=start;
      action('clearPick',()=>picker.set([]));action('fitPick',()=>picker.fit());
      return {get:()=>selected.slice(),set:ids=>picker.set(ids)};
    }
    async function list(request={objects:[],label:'Repair selections'},options={},failure=''){
      const c=await context(request,options);options=c.options;
      const entries=P.inspect(state(),c.semantic,request),all=c.pending.state.project.objects;
      h.dialog('Selections & repair',`<p>${request.objects?.length?'Changes remain pending. Repair selections, then review dependent cards together. Closing or discarding leaves the model unchanged.':'Create reusable mesh regions or inspect existing selections. Explicit regions bind entity identities and require repair after incompatible remeshing.'}</p><div class="wb-owner-actions">${button('newNodes','New node region')}${button('newElements','New element region')}</div>${failure?'<p role="alert">'+esc(failure)+'</p>':''}${entries.map(r=>`<details ${r.issues.length?'open':''}><summary>${esc(r.name)} · ${r.issues.length?'Repair needed':'Inputs available'} · ${r.nodes.length} nodes / ${r.elements.length} elements</summary><p>${esc(r.issues.join(' ')||'Selection resolves on this model.')}</p><p>Dependents: ${esc(r.dependents.join(', ')||'None')}</p><p>GRID IDs: ${esc(r.nodes.join(', '))}<br>Element IDs: ${esc(r.elements.join(', '))}</p><button class="wb-btn" data-repair-highlight="${esc(r.id)}">Highlight current</button> <button class="wb-btn" data-repair-edit="${esc(r.id)}">Inspect / replace selection</button></details>`).join('')||'<p>No authored selections yet.</p>'}${tail}${button('review','Review complete change')}${button('discard','Discard / close')}`);
      body().querySelectorAll('[data-repair-highlight]').forEach(b=>b.onclick=()=>{const r=P.inspect(state(),c.semantic).find(r=>r.id===b.dataset.repairHighlight)||entries.find(r=>r.id===b.dataset.repairHighlight);h.engine().select({nodes:r.nodes,elements:r.elements,mode:r.elements.length?'element':'node'});});
      body().querySelectorAll('[data-repair-edit]').forEach(b=>b.onclick=()=>h.run(()=>edit(entries.find(r=>r.id===b.dataset.repairEdit),all.find(o=>o.id===b.dataset.repairEdit),request,options)));
      action('newNodes',()=>regionEditor(null,'node',request,options));action('newElements',()=>regionEditor(null,'element',request,options));
      action('review',async()=>{await check(options);return h.review(request,options);});action('discard',()=>h.close());
    }
    async function regionEditor(o,entity,request={objects:[],label:'Edit mesh region'},options={}){
      if(o?.definition.scope){
        const c=await context(request,options);options=c.options;const all=c.pending.state.project.objects,base=all.find(x=>x.id===o.definition.scope.region),instance=all.find(x=>x.id===o.definition.scope.instance);if(!base||!instance)throw Error('The source region or instance is missing.');
        const entry=P.inspect(state(),c.semantic,request).find(r=>r.id===o.id);
        h.dialog('Instance region · '+o.name,field('name','Region name',o.name)+`<p>Source: ${esc(base.name)} · Placement: ${esc(instance.name)}.</p><p>${o.definition.resolved.nodes.length} mapped nodes / ${o.definition.resolved.elements.length} elements. Membership follows the source region; edit its selection to change every scoped copy.</p>${entry?.issues.length?'<p role="alert">'+esc(entry.issues.join(' '))+'</p>':''}`+button('sourceRegion','Inspect / repair source region')+button('scopeHighlight','Highlight current mapped nodes')+button('scopeName','Review name')+button('scopeRemove','Review region removal')+tail);
        action('sourceRegion',()=>edit(P.inspect(state(),c.semantic,request).find(r=>r.id===base.id),base,request,options));
        action('scopeHighlight',()=>{const live=state()?.project.objects.find(x=>x.id===o.id);if(live)h.engine().select({nodes:live.definition.resolved.nodes,elements:live.definition.resolved.elements,mode:entity==='element'?'element':'node'});});
        action('scopeName',async()=>{await check(options);const name=get('name').trim();if(!name)throw Error('Enter a region name.');return h.review({...merge(request,[{...structuredClone(o),name}]),label:'Rename '+o.name},options);});
        action('scopeRemove',async()=>{await check(options);const r=R.remove(c.pending.state,o.id);return h.review({...request,label:r.label,objects:(request.objects||[]).filter(x=>x.id!==o.id),removeObjects:[...(request.removeObjects||[]),o.id]},options);});return;
      }
      const c=await context(request,options);options=c.options;
      const old=o?.definition.ids||h.engine().getState().selection[entity==='node'?'nodes':'elems'];
      const issues=o?P.inspect(state(),c.semantic,request).find(r=>r.id===o.id)?.issues||[]:[];
      h.dialog(o?'Edit '+o.name:'New '+entity+' region',(issues.length?'<p role="alert">'+esc(issues.join(' '))+'</p>':'')+field('name','Region name',o?.name||(entity==='node'?'Support nodes':'Reference elements'))+field('ids',entity==='node'?'Region GRID IDs':'Region element IDs',old.join(', '))+`<p>Explicit ${entity} membership is bound to this mesh. Remeshing never substitutes new entities by proximity or recycled IDs. Dependent objects regenerate only after you review a replacement.</p>`+pickerMarkup(c.pending,entity)+button('useIds','Show typed IDs')+button('apply',request.objects?.length?'Stage region selection':'Review region')+(o?button('remove','Review region removal'):'')+button('back','Back to selections')+tail);
      const picked=startPicker(c.pending,entity,old,ids=>{body().querySelector('[data-repair="ids"]').value=ids.join(', ');});
      action('useIds',()=>picked.set(parseIds(get('ids'))));
      action('apply',async()=>{await check(options);const id=o?.id||'region-'+crypto.randomUUID(),built=R.build({id,name:get('name'),entity,ids:parseIds(get('ids'))},c.pending.state,c.pending.semantic),next=merge(request,built.objects);if(request.objects?.length)return list(next,options);return h.review({...next,label:built.label},{...options,owner:id});});
      action('back',()=>list(request,options));
      if(o)action('remove',async()=>{await check(options);const removal=R.remove(c.pending.state,o.id);return h.review({...request,label:removal.label,objects:(request.objects||[]).filter(x=>x.id!==o.id),removeObjects:[...(request.removeObjects||[]),o.id]},options);});
    }
    async function edit(entry,o,request,options){
      if(R.isRegion(o))return regionEditor(o,o.definition.entity,request,options);
      const c=await context(request,options);options=c.options;
      if(o.definition.generator==='analysis-participation-v1'&&o.definition.region){const region=c.pending.state.project.objects.find(x=>x.id===o.definition.region);if(!region)throw Error('The selected element region is missing.');return regionEditor(region,'element',request,options);}
      const d=o.definition,region=entry.type==='region',inter=entry.type==='interface',support=d.generator===window.WebMeshAnalysisProject.SET&&d.action.action==='support',exclusion=d.generator==='analysis-participation-v1'&&!d.region;
      const graphical=!region&&!inter,entity=exclusion?'element':'node';
      h.dialog('Repair '+o.name,`<p>${esc(entry.issues.join(' ')||'Explicitly accept the current selection or provide replacements.')}</p>`+(region?field('mesh','Mesh owner',d.selector.mesh)+field('kind','Entity kind (face or edge)',d.selector.kind||'face')+field('faces','Replacement CAD face/edge IDs',d.selector.faces.join(', ')):inter?field('edges','Replacement shell edge IDs',d.edges.join(', '))+field('faces','Replacement solid face IDs',d.faces.join(', ')):support?field('selectedNodes','Replacement support GRID IDs',d.action.nodes.join(', ')):exclusion?field('selectedElements','Replacement element IDs',entry.elements.join(', ')):field('nodes','GRID replacements (old:new, …)','')+field('elements','Element replacements (old:new, …)','')+select('oldNode','GRID to replace',entry.nodes.map(n=>[String(n),String(n)]),String(entry.nodes[0]))+button('mapNode','Map picked node to this GRID'))+(graphical?pickerMarkup(c.pending,entity):'<p>CAD selectors refer to the proposed topology. Accepting them confirms their intended meaning.</p>')+tail+button('apply','Stage selection repair')+button('back','Back to selections'));
      let picked;if(graphical)picked=startPicker(c.pending,entity,support?d.action.nodes:exclusion?entry.elements:[],ids=>{const target=body().querySelector(`[data-repair="${support?'selectedNodes':'selectedElements'}"]`);if(target)target.value=ids.join(', ');});
      action('mapNode',()=>{const ns=picked.get();if(ns.length!==1)throw Error('Pick exactly one replacement GRID.');const input=body().querySelector('[data-repair="nodes"]'),old=get('oldNode');input.value=[...input.value.split(/[\s,]+/).filter(v=>v&&!v.startsWith(old+':')),old+':'+ns[0]].join(', ');});
      const pairs=k=>(get(k)||'').split(/[\s,]+/).filter(Boolean).map(s=>s.split(':').map(Number));
      action('apply',async()=>{await check(options);const input={id:o.id,...(region?{mesh:get('mesh'),kind:get('kind'),faces:parseIds(get('faces'))}:inter?{edges:parseIds(get('edges')),faces:parseIds(get('faces'))}:support?{selectedNodes:parseIds(get('selectedNodes'))}:exclusion?{selectedElements:parseIds(get('selectedElements'))}:{nodes:pairs('nodes'),elements:pairs('elements')})};const next=P.repair(state(),c.semantic,request,input,h.engine().getNextIds());await list(next,options);});
      action('back',()=>list(request,options));
    }
    async function open(id){const o=state()?.project.objects.find(o=>o.id===id);if(!R.isRegion(o))return false;await regionEditor(o,o.definition.entity);return true;}
    return {list,open};
  }};
})();
