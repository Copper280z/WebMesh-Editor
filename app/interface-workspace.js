/* Explicit shell edge to solid face interpolation; all edits use project review. */
(()=>{
  'use strict';
  const I=window.WebMeshInterfaceProject,esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const field=(key,label,value)=>`<label class="wb-field"><span>${label}</span><input data-interface="${key}" aria-label="${label}" value="${esc(value)}"></label>`;
  const select=(key,label,objects,id)=>`<label class="wb-field"><span>${label}</span><select data-interface="${key}" aria-label="${label}">${objects.map(o=>`<option value="${esc(o.id)}" ${o.id===id?'selected':''}>${esc(o.name)}</option>`).join('')}</select></label>`;
  window.WebMeshInterfaceWorkspace={create(hooks){
    const body=()=>document.getElementById('wb-dialog-body'),state=()=>hooks.engine().getProjectOwnership(),objects=()=>state()?.project.objects||[];
    const show=(name,html)=>hooks.dialog(name,`<div data-mount-editor>${html}<p data-interface-error role="alert"></p></div>`);
    const get=key=>body().querySelector(`[data-interface="${key}"]`).value;
    const action=(key,fn)=>body().querySelector(`[data-interface-action="${key}"]`)?.addEventListener('click',()=>hooks.run(async()=>{try{await fn();}catch(e){const el=body().querySelector('[data-interface-error]');if(el)el.textContent=e.message;else throw e;}}));
    const button=(key,label)=>`<button class="wb-btn" data-interface-action="${key}">${label}</button>`;
    function list(){
      show('Shell–solid interfaces',`<p>Connect a shell boundary to solid faces from the same CAD source. Each shell GRID uses an RBE3 with reference DOFs 123456 and independent solid translations 123. Radius controls the local averaging patch; review its size as an engineering idealization.</p>${button('new','New shell–solid interface')}${objects().filter(o=>o.definition.generator===I.GENERATOR).map(o=>`<p><button class="wb-owner-link" data-interface-owner="${esc(o.id)}">${esc(o.name)}</button></p>`).join('')}`);
      action('new',()=>editor());body().querySelectorAll('[data-interface-owner]').forEach(b=>b.onclick=()=>editor(b.dataset.interfaceOwner));
    }
    function editor(id,draft={}){
      const all=objects(),old=all.find(o=>o.id===id),d={...old?.definition,...draft},shells=all.filter(o=>o.definition.generator==='cad-shell-v1'),solids=all.filter(o=>o.definition.generator==='cad-mapped-v1');
      if(!shells.length||!solids.length){show('Shell–solid interface','<p>Create and apply separate shell and mapped-solid mesh regions from one CAD source first. Use CAD & mesh → New mesh region; partition a continuous solid before assigning its thin and thick portions.</p>');return;}
      const shell=shells.find(o=>o.id===d.shell)||shells[0],compatible=solids.filter(o=>o.definition.source===shell.definition.source),solid=compatible.find(o=>o.id===d.solid)||compatible[0];
      if(!solid){show('Shell–solid interface','<p>The shell has no solid mesh region sharing its saved CAD source.</p>');return;}
      const checks=(key,label,items,selected)=>items.map(f=>`<label><input type="checkbox" data-interface-${key}="${f.id}" ${(selected||[]).includes(f.id)?'checked':''}>${label} ${f.id} · ${f.nodes.length} nodes${f.center?' · center ('+f.center.map(v=>Number(v.toPrecision(5))).join(', ')+')':''}</label>`).join('');
      show(old?'Edit shell–solid interface':'New shell–solid interface',`${field('name','Interface name',draft.name||old?.name||'Shell to solid')}${select('shell','Shell mesh region',shells,shell.id)}${select('solid','Solid mesh region',compatible,solid.id)}<p>Choose complete shell boundary edges and the receiving solid faces. Nonmatching meshes retain independent node IDs. All selected edge nodes must lie within the gap tolerance of a selected solid facet.</p><h3>Shell boundary edges</h3><div class="wb-mount-faces">${checks('edge','Edge',shell.definition.edges||[],d.edges)||'No boundary provenance. Regenerate with Recombined, Paved or Tri; Quadtree samples independent boundaries and cannot author this interface.'}</div><h3>Solid faces</h3><div class="wb-mount-faces">${checks('face','Face',solid.definition.faces||[],d.faces)}</div>${field('radius','Support radius',d.radius??10)}${field('gap','Gap tolerance',d.gap??0.01)}<p>Model length units. Each shell node couples all six reference DOFs to unit-weight solid translations within the radius. At least three well-spaced, noncollinear support nodes are required. This is a distributed tie, not contact; radius affects local compliance. Shell offsets retain their normal PSHELL/element interpretation.</p>${old?'<p>'+old.definition.resolved.patches.length+' RBE3 patches · '+Math.min(...old.definition.resolved.patches.map(p=>p.nodes.length))+'–'+Math.max(...old.definition.resolved.patches.map(p=>p.nodes.length))+' solid nodes per patch</p>':''}<div class="wb-owner-actions">${button('highlight','Highlight selected nodes')}${button('review','Review interface')}${old?button('remove','Review removal'):''}</div>`);
      const ids=key=>[...body().querySelectorAll(`[data-interface-${key}]:checked`)].map(b=>Number(b.getAttribute('data-interface-'+key)));
      const input=()=>({id:id||'interface-'+crypto.randomUUID(),name:get('name'),shell:get('shell'),solid:get('solid'),edges:ids('edge'),faces:ids('face'),radius:get('radius').trim()?Number(get('radius')):NaN,gap:get('gap').trim()?Number(get('gap')):NaN});
      for(const key of ['shell','solid'])body().querySelector(`[data-interface="${key}"]`).onchange=()=>{const values=input();editor(id,{...values,edges:key==='shell'?[]:values.edges,faces:[]});};
      action('highlight',()=>{const nodes=[...shell.definition.edges.filter(e=>ids('edge').includes(e.id)).flatMap(e=>e.nodes),...solid.definition.faces.filter(f=>ids('face').includes(f.id)).flatMap(f=>f.nodes)];hooks.engine().select({nodes:[...new Set(nodes)],mode:'node'});});
      action('review',()=>{const request=I.build(input(),state(),hooks.engine().getNextIds());return hooks.review(request,{owner:request.objects[0].id,note:'RBE3 couples shell reference DOFs 123456 to solid translations 123. Every patch has geometric support for force and moment transfer.'});});
      action('remove',()=>hooks.review(I.removal(state(),id)));
    }
    return {list,open(id){if(!objects().some(o=>o.id===id&&o.definition.generator===I.GENERATOR))return false;editor(id);return true;}};
  }};
})();
