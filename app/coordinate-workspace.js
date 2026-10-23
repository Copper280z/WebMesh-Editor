(()=>{
  'use strict';
  const F=window.WebMeshCoordinates,esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const field=(k,label,v)=>`<label class="wb-field"><span>${esc(label)}</span><input data-frame="${k}" aria-label="${esc(label)}" value="${esc(v)}"></label>`;
  const button=(k,label)=>`<button class="wb-btn" data-frame-action="${k}">${label}</button>`;
  window.WebMeshCoordinateWorkspace={create(h){
    const body=()=>document.getElementById('wb-dialog-body'),state=()=>h.engine().getProjectOwnership(),objects=()=>state()?.project.objects||[],get=k=>body().querySelector(`[data-frame="${k}"]`).value;
    const show=(title,html)=>h.dialog(title,html+'<p data-frame-error role="alert"></p>');
    const action=(key,fn)=>body().querySelector(`[data-frame-action="${key}"]`)?.addEventListener('click',()=>h.run(async()=>{try{await fn();}catch(e){const el=body().querySelector('[data-frame-error]');if(el)el.textContent=e.message;else throw e;}}));
    function list(){show('Reusable coordinate frames','<p>Rectangular frames share directions across attachments, loads and support DOFs. Explicit positions are measured in basic XYZ.</p>'+button('new','New rectangular frame')+button('assign','Assign GRID displacement frame')+objects().filter(o=>o.definition.generator===F.GENERATOR).map(o=>`<p><button class="wb-owner-link" data-frame-owner="${esc(o.id)}">${esc(o.name)}</button> · CORD2R ${o.definition.cards[0].id}</p>`).join(''));action('new',()=>edit());action('assign',assign);body().querySelectorAll('[data-frame-owner]').forEach(b=>b.onclick=()=>edit(b.dataset.frameOwner));}
    function edit(id){
      const old=objects().find(o=>o.id===id),v=old?.definition.cards[0].value||{origin:[0,0,0],zAxisPt:[0,0,1],xzPlanePt:[1,0,0]};
      show(old?'Edit coordinate frame':'New coordinate frame',field('name','Frame name',old?.name||'Motor axes')+[['origin','Origin'],['zAxisPt','Point on +Z axis'],['xzPlanePt','Point in +X/Z half-plane']].map(([k,label])=>field(k,label,v[k].join(', '))).join('')+'<p>Three points in basic XYZ. +Y follows the right-hand rule. Changing this frame rotates every referencing stiffness/load/support direction without moving mesh nodes.</p><pre data-frame-axes></pre>'+button('axes','Show resolved axes')+button('review','Review frame')+(old?button('remove','Review removal'):'')+button('back','All coordinate frames'));
      const input=()=>({id:id||'frame-'+crypto.randomUUID(),name:get('name'),...Object.fromEntries(['origin','zAxisPt','xzPlanePt'].map(k=>[k,get(k).trim().split(/[\s,]+/).map(Number)]))});
      action('axes',()=>{const a=F.axes(input());body().querySelector('[data-frame-axes]').textContent=a.map((v,i)=>'XYZ'[i]+' → basic ('+v.map(x=>Number(x.toPrecision(6))).join(', ')+')').join('\n');});
      action('review',()=>h.review(F.build(input(),state(),h.engine().getNextIds()),{owner:id,note:'CORD2R points are in basic XYZ (RID=0). All existing references keep the same coordinate ID.'}));action('back',list);if(old)action('remove',()=>h.review(F.remove(state(),id)));
    }
    function assign(){show('Assign GRID displacement frame',field('nodes','GRID IDs',h.engine().getState().selection.nodes.join(', '))+`<label class="wb-field"><span>Displacement frame</span><select data-frame="frame" aria-label="Displacement frame"><option value="">Basic XYZ</option>${objects().filter(o=>o.definition.generator===F.GENERATOR).map(o=>`<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select></label><p>Sets GRID CD for project-owned nodes. This changes the directions of all SPC and rigid-element components at those nodes, and their output components. Positions (CP) are unchanged. Existing support sets with conflicting frame expectations block Apply.</p>`+button('review','Review GRID frames'));
      action('review',()=>h.review(F.assign({nodes:get('nodes').split(/[\s,]+/).filter(Boolean).map(Number),frame:get('frame')},state()),{note:'Review every GRID CD change and dependent constraint.'}));}
    return{list,open(id){if(objects().find(o=>o.id===id)?.definition.generator!==F.GENERATOR)return false;edit(id);return true;}};
  }};
})();
