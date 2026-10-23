/* Editors for named CAD mounting regions and owned RBE2/CBUSH idealizations. */
(() => {
  'use strict';
  const A=window.WebMeshAttachmentProject;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const field=(key,label,value,type='text')=>`<label class="wb-field"><span>${label}</span><input data-mount="${key}" aria-label="${label}" type="${type}" step="any" value="${esc(value)}"></label>`;
  const select=(key,label,options,value)=>`<label class="wb-field"><span>${label}</span><select data-mount="${key}" aria-label="${label}">${options.map(([id,name])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(name)}</option>`).join('')}</select></label>`;
  const button=(key,label)=>`<button type="button" class="wb-btn" data-mount-action="${key}">${esc(label)}</button>`;
  const vector=(key,label,v)=>`<div class="wb-vector"><span>${label}</span><div>${v.map((n,i)=>`<label><em>${'XYZ'[i]}</em><input data-mount="${key}${i}" aria-label="${label} ${'XYZ'[i]}" type="number" step="any" value="${esc(n)}"></label>`).join('')}</div></div>`;
  const stiffness=v=>`<p>Basic XYZ frame (CID=0). K1–K3: force/length; K4–K6: moment/radian. Use consistent model units.</p>${v.map((k,i)=>field('k'+i,'K'+(i+1)+' · '+['X','Y','Z','RX','RY','RZ'][i],k,'number')).join('')}`;
  const defaults=[1e5,1e5,1e5,1e4,1e4,1e4];
  window.WebMeshAttachmentWorkspace={create(hooks){
    const body=()=>document.getElementById('wb-dialog-body');
    const state=()=>hooks.engine().getProjectOwnership();
    const objects=()=>state()?.project.objects||[];
    const get=key=>body().querySelector(`[data-mount="${key}"]`).value;
    const number=key=>{const raw=get(key),n=Number(raw);if(!raw.trim()||!Number.isFinite(n))throw Error('Enter a finite '+key+' value.');return n;};
    const vec=key=>[0,1,2].map(i=>number(key+i));
    const uuid=prefix=>prefix+'-'+crypto.randomUUID();
    const action=(key,fn)=>body().querySelector(`[data-mount-action="${key}"]`)?.addEventListener('click',()=>hooks.run(async()=>{try{await fn();}catch(e){const error=body().querySelector('[data-mount-error]');if(error)error.textContent=e.message;else throw e;}}));
    const show=(title,html)=>{hooks.dialog(title,`<div data-mount-editor>${html}<p data-mount-error role="alert"></p></div>`);};
    const removable=id=>action('remove',()=>hooks.review(A.removal(state(),id)));
    function list(){
      const all=objects(),groups=[[A.REGION,'Mounting regions'],[A.ATTACHMENT,'Attachments'],[A.TEMPLATE,'Shared stiffness templates']];
      show('Mounting regions & attachments',`<p>Create a named CAD face region, then connect it to explicit mount and shaft points. Each change is reviewed before it affects the model.</p><div class="wb-owner-actions">${button('region','New mounting region')}${button('attachment','New RBE2/CBUSH attachment')}</div>${groups.map(([g,title])=>`<h3>${title}</h3>${all.filter(o=>o.definition.generator===g).map(o=>`<p><button class="wb-owner-link" data-mount-owner="${esc(o.id)}">${esc(o.name)}</button></p>`).join('')||'<p>None yet.</p>'}`).join('')}`);
      action('region',()=>regionEditor());action('attachment',()=>attachmentEditor());
      body().querySelectorAll('[data-mount-owner]').forEach(b=>b.onclick=()=>open(b.dataset.mountOwner));
    }
    function regionEditor(id,meshId){
      const all=objects(),old=all.find(o=>o.id===id),meshes=all.filter(o=>o.definition.generator==='cad-mapped-v1');
      if(!meshes.length){show('New mounting region','<p>First create and apply a native mapped CAD mesh in CAD & mesh.</p>');return;}
      meshId=meshId||old?.definition.selector.mesh||meshes[0].id;
      const mesh=meshes.find(o=>o.id===meshId),faces=mesh.definition.faces||[],checked=new Set(old?.definition.selector.mesh===meshId?old.definition.selector.faces:[]);
      show(old?'Edit mounting region':'New mounting region',`${field('name','Region name',old?.name||'Motor mount')}${select('mesh','Committed mesh',meshes.map(o=>[o.id,o.name]),meshId)}<p>Choose CAD faces from the committed mesh. Shared edge nodes are included once; HEX20 midside nodes are included.</p>${faces.length?`<div class="wb-mount-faces">${faces.map(f=>`<label><input type="checkbox" data-mount-face="${f.id}" ${checked.has(f.id)?'checked':''}>Face ${f.id} · ${esc(f.type)} · ${f.nodes.length} nodes · center (${f.center.map(n=>Number(n.toPrecision(5))).join(', ')})</label>`).join('')}</div>`:'<p>This saved mesh has no face membership. Reopen its committed CAD snapshot and review/apply an unchanged regeneration first.</p>'}<p data-mount-resolution></p><div class="wb-owner-actions">${button('cad-selection','Use selected CAD faces')}${button('highlight','Highlight support nodes')}</div><p>To pick faces in the viewport, close this editor, select them in CAD & mesh, then return here and use the selected CAD faces. The geometry must match this committed mesh.</p><div class="wb-review-actions">${button('review','Review region')}${old?button('attach','Create attachment')+button('remove','Review removal'):''}</div>`);
      if(old)action('attach',()=>attachmentEditor(null,id));
      const input=()=>({id:id||uuid('region'),name:get('name'),mesh:get('mesh'),faces:[...body().querySelectorAll('[data-mount-face]:checked')].map(b=>Number(b.dataset.mountFace))});
      const selection=()=>{const chosen=new Set(input().faces),nodes=[...new Set(faces.filter(f=>chosen.has(f.id)).flatMap(f=>f.nodes))];body().querySelector('[data-mount-resolution]').textContent=chosen.size+(chosen.size===1?' face · ':' faces · ')+nodes.length+' resolved nodes';return nodes;};
      selection();body().querySelectorAll('[data-mount-face]').forEach(b=>b.onchange=selection);
      body().querySelector('[data-mount="mesh"]').onchange=()=>regionEditor(id,get('mesh'));
      action('highlight',()=>{hooks.engine().select({nodes:selection(),mode:'node'});hooks.engine().fitView?.();});
      action('cad-selection',async()=>{
        const draft=hooks.cadState();if(draft.selection.kind!=='face'||!draft.selection.ids.length)throw Error('Select CAD faces in CAD & mesh first.');
        const source=all.find(o=>o.id===mesh.definition.source);
        if(await window.WebMeshCadProject.geometryFingerprint(draft.topology)!==source.definition.geometryKey)throw Error('The CAD draft geometry differs from the committed mesh. Reopen the committed snapshot before selecting faces.');
        if(draft.selection.ids.some(id=>!faces.some(f=>f.id===id)))throw Error('Some selected faces are outside this committed mesh.');
        body().querySelectorAll('[data-mount-face]').forEach(b=>b.checked=draft.selection.ids.includes(Number(b.dataset.mountFace)));selection();
      });
      action('review',()=>{const request=A.region(input(),state());return hooks.review(request,{owner:request.objects[0].id});});
      if(old)removable(id);
    }
    function attachmentEditor(id,regionId){
      const all=objects(),old=all.find(o=>o.id===id),regions=all.filter(o=>o.definition.generator===A.REGION),templates=all.filter(o=>o.definition.generator===A.TEMPLATE);
      if(!regions.length){show('New RBE2/CBUSH attachment',`<p>Create a mounting region first.</p>${button('region','New mounting region')}`);action('region',()=>regionEditor());return;}
      const region=regions.find(o=>o.id===(regionId||old?.definition.region))||regions[0],points=all.find(o=>o.id===old?.definition.points);
      const xyz=role=>{const v=points?.definition.cards.find(c=>c.role===role).value;return v?[v.x,v.y,v.z]:null;};
      const mount=xyz('mount')||region.definition.resolved.centroid,mesh=all.find(o=>o.id===region.definition.selector.mesh);
      const normal=mesh.definition.faces.find(f=>f.id===region.definition.selector.faces[0])?.normal||[0,0,1];
      const shaft=xyz('shaft')||mount.map((n,i)=>n+20*normal[i]);
      const template=old?.definition.template||templates[0]?.id||'';
      show(old?'Edit attachment':'New RBE2/CBUSH attachment',`${field('name','Attachment name',old?.name||'Motor attachment')}${select('region','Mounting region',regions.map(o=>[o.id,o.name+' · '+o.definition.resolved.nodes.length+' nodes']),region.id)}<p>RBE2 couples region translations to the independent mount point. CBUSH connects that point to the shaft. Points are explicit basic coordinates and stay fixed when the mesh changes.</p>${vector('mount','Mount point',mount)}${vector('shaft','Shaft point',shaft)}${button('place','Place points from selected region')}<p>Place points uses the support-node centroid and a 20-unit offset along the first selected face normal. Review these estimates.</p>${field('components','Dependent DOFs',old?.definition.components||'123')}<p>Solid nodes: translations 123 are recommended. Reduced components may leave a mechanism.</p>${select('template','Stiffness template',[['','New shared template'],...templates.map(o=>[o.id,o.name+' · PBUSH '+o.definition.cards[0].id])],template)}<div data-mount-new-template>${field('templateName','Template name','Motor stiffness')}${stiffness(defaults)}</div><p data-mount-shared-note></p><div class="wb-review-actions">${button('review','Review attachment')}${old?button('remove','Review removal'):''}</div>`);
      const updateTemplate=()=>{const t=templates.find(o=>o.id===get('template'));body().querySelector('[data-mount-new-template]').hidden=!!t;body().querySelector('[data-mount-shared-note]').textContent=t?'Uses '+t.name+' in basic XYZ: '+Array.from({length:6},(_,i)=>'K'+(i+1)+'='+t.definition.cards[0].value['K'+(i+1)]).join(', ')+'. Edit the shared template to change all its attachments.':'';};
      updateTemplate();body().querySelector('[data-mount="template"]').onchange=updateTemplate;
      action('place',()=>{
        const r=regions.find(o=>o.id===get('region')),m=all.find(o=>o.id===r.definition.selector.mesh),center=r.definition.resolved.centroid;
        const n=m.definition.faces.find(f=>f.id===r.definition.selector.faces[0])?.normal||[0,0,1];
        ['mount','shaft'].forEach(role=>center.forEach((x,i)=>body().querySelector(`[data-mount="${role}${i}"]`).value=x+(role==='shaft'?20*n[i]:0)));
      });
      action('review',()=>{
        const input={id:id||uuid('attachment'),name:get('name'),region:get('region'),mount:vec('mount'),shaft:vec('shaft'),components:get('components').trim(),template:get('template')};
        if(!input.template)input.newTemplate={id:uuid('template'),name:get('templateName'),stiffness:defaults.map((_,i)=>number('k'+i))};
        return hooks.review(A.attachment(input,state(),hooks.engine().getNextIds()),{owner:input.id});
      });
      if(old)removable(id);
    }
    function templateEditor(id){
      const all=objects(),t=all.find(o=>o.id===id),users=all.filter(o=>o.definition.generator===A.ATTACHMENT&&o.definition.template===id);
      show('Edit shared stiffness',`${field('name','Template name',t.name)}<p>PBUSH ${t.definition.cards[0].id}. Used by: ${esc(users.map(o=>o.name).join(', ')||'No attachments')}.</p>${stiffness(defaults.map((_,i)=>t.definition.cards[0].value['K'+(i+1)]))}<div class="wb-review-actions">${button('review','Review shared stiffness')}${button('remove','Review removal')}</div>`);
      action('review',()=>hooks.review({label:'Update shared stiffness',objects:[A.template({id,name:get('name'),stiffness:defaults.map((_,i)=>number('k'+i))},state(),hooks.engine().getNextIds())]},{owner:id}));removable(id);
    }
    function open(id){
      const s=state(),o=s?.project.objects.find(o=>o.id===id),root=A.rootFor(s,id);
      if(root){attachmentEditor(root.id);return true;}
      if(o?.definition.generator===A.REGION){regionEditor(id);return true;}
      if(o?.definition.generator===A.TEMPLATE){templateEditor(id);return true;}
      return false;
    }
    return {open,list,regionEditor,attachmentEditor};
  }};
})();
