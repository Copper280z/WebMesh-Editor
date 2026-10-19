/* Bolt assemblies use explicit independent nodes, attachment spiders and shanks. */
(() => {
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const field=(key,label,value,type='number')=>`<label class="wb-field"><span>${label}</span><input data-bolt="${key}" aria-label="${label}" type="${type}" ${type==='number'?'step="any"':''} value="${esc(value)}"></label>`;
  const select=(key,label,options,value)=>`<label class="wb-field"><span>${label}</span><select data-bolt="${key}" aria-label="${label}">${options.map(([v,t])=>`<option value="${v}" ${v===value?'selected':''}>${t}</option>`).join('')}</select></label>`;
  const vector=(key,label,value)=>`<div class="wb-vector"><span>${label}</span><div>${value.map((n,i)=>`<label><em>${'XYZ'[i]}</em><input data-bolt="${key}${i}" aria-label="${label} ${'XYZ'[i]}" type="number" step="any" value="${esc(n)}"></label>`).join('')}</div></div>`;
  const section=(label,body)=>`<section class="wb-section"><div class="wb-section-title">${label}</div>${body}</section>`;
  const button=(key,label,cls='')=>`<button class="wb-btn ${cls}" data-bolt-action="${key}">${label}</button>`;
  window.WebMeshBoltWorkspace={create(hooks){
    const values={kind:'single',connection:'CBUSH',center0:0,center1:0,center2:10,axis0:0,axis1:0,axis2:1,grip:20,count:3,pitch0:25,pitch1:0,pitch2:0,patternAxis0:0,patternAxis1:0,patternAxis2:1,radius:30,angle:360,startAngle:0,radialDirection0:1,radialDirection1:0,radialDirection2:0,attachmentRadius:5,tolerance:0.1,components:'123',headNodes:'',nutNodes:'',k0:'',k1:'',k2:'',k3:'',k4:'',k5:'',area:20,E:210000,nu:0.3,rho:7.85e-9};
    const root=()=>document.getElementById('wb-panel-body');
    const remember=()=>root()?.querySelectorAll('[data-bolt]').forEach(el=>values[el.dataset.bolt]=el.value);
    const num=key=>{const n=Number(values[key]);if(String(values[key]).trim()===''||!Number.isFinite(n))throw Error(`Enter a finite ${key.startsWith('k')?'K'+(Number(key.slice(1))+1):key}.`);return n;};
    const vec=key=>[0,1,2].map(i=>num(key+i));
    const inputIds=key=>{if(!String(values[key]).trim())return undefined;const ids=String(values[key]).trim().split(/[\s,;]+/).filter(Boolean).map(Number);if(ids.some(n=>!Number.isSafeInteger(n)||n<1))throw Error('Attachment IDs must be positive node IDs, separated by commas.');return [...new Set(ids)];};
    function render(){
      let body=section('Bolt connection',select('connection','Shank',[['CBUSH','CBUSH + RBE2'],['CROD','Axial rod + RBE2']],values.connection)+select('kind','Pattern',[['single','Single bolt'],['linear','Linear array'],['circular','Circular array']],values.kind));
      body+=section('Location',vector('center','Center',[values.center0,values.center1,values.center2])+button('center','Use selected-node centroid')+vector('axis','Bolt axis',[values.axis0,values.axis1,values.axis2])+field('grip','Grip length',values.grip)+'<p class="wb-footnote">Center is halfway between the head and nut. The bolt axis defines local X.</p>');
      if(values.kind==='linear')body+=section('Array',field('count','Instances',values.count)+vector('pitch','Pitch',[values.pitch0,values.pitch1,values.pitch2]));
      if(values.kind==='circular')body+=section('Array',field('count','Instances',values.count)+field('radius','Pattern radius',values.radius)+field('angle','Sweep (°)',values.angle)+field('startAngle','Start angle (°)',values.startAngle)+vector('radialDirection','Radial direction',[values.radialDirection0,values.radialDirection1,values.radialDirection2])+vector('patternAxis','Pattern axis',[values.patternAxis0,values.patternAxis1,values.patternAxis2])+'<p class="wb-footnote">Center is the circle center. Bolt axes stay parallel.</p>');
      body+=section('Attachment spiders',field('attachmentRadius','Patch radius',values.attachmentRadius)+field('tolerance','Plane tolerance',values.tolerance)+field('components','Coupled DOFs',values.components,'text')+'<p class="wb-footnote">Finds mesh nodes in a disk at each end of the grip. RBE2 couples those nodes to the bolt. Use 123 for solid faces.</p>');
      body+=`<details class="wb-section"><summary class="wb-section-title">Explicit attachment nodes</summary>${field('headNodes','Head node IDs',values.headNodes,'text')}${button('head','Use selected nodes for head')}${field('nutNodes','Nut node IDs',values.nutNodes,'text')}${button('nut','Use selected nodes for nut')}<p class="wb-footnote">Leave blank for geometric attachment search. Explicit lists limit candidates for each end.</p></details>`;
      if(values.connection==='CBUSH')body+=section('Bush stiffness',`<div class="wb-bolt-stiffness"><span class="wb-bolt-stiffness-heading">Translation</span><span class="wb-bolt-stiffness-heading">Rotation</span>${[0,1,2].map(axis=>[axis,axis+3].map(i=>`<label><span>K${i+1}</span><input data-bolt="k${i}" aria-label="K${i+1}: ${i<3?'translation':'rotation'} ${'XYZ'[axis]}" title="${esc('K'+(i+1)+': '+values['k'+i])}" type="number" step="any" value="${esc(values['k'+i])}"></label>`).join('')).join('')}</div><p class="wb-footnote">PBUSH K1–K6 in the bolt frame. Translation uses force / length; rotation uses moment / radian. Supply stiffness appropriate to the bolt and model units.</p>`);
      else body+=section('Rod section',field('area','Area',values.area)+field('E','Young’s modulus',values.E)+field('nu','Poisson’s ratio',values.nu)+field('rho','Density',values.rho));
      body+='<div id="wb-report"></div>';
      return {body,foot:button('preview','Preview bolts')+button('create','Create bolts','primary')};
    }
    function build(){
      remember();const engine=hooks.engine(),ids=engine.getNextIds();
      const options={kind:values.kind,connection:values.connection,center:vec('center'),axis:vec('axis'),grip:num('grip'),attachmentRadius:num('attachmentRadius'),tolerance:num('tolerance'),components:values.components,headNodes:inputIds('headNodes'),nutNodes:inputIds('nutNodes'),pid:ids.property,startNode:ids.node,startElement:ids.element};
      if(values.kind!=='single')options.count=num('count');
      if(values.kind==='linear')options.pitch=vec('pitch');
      if(values.kind==='circular')Object.assign(options,{patternAxis:vec('patternAxis'),radius:num('radius'),angle:num('angle'),startAngle:num('startAngle'),radialDirection:vec('radialDirection')});
      if(values.connection==='CBUSH')options.stiffness=[0,1,2,3,4,5].map(i=>num('k'+i));else options.area=num('area');
      return window.WebMeshModeling.createBoltPattern(engine.getMesh(),options);
    }
    function bind(){
      root().querySelectorAll('[data-bolt]').forEach(el=>{
        el.addEventListener('input',()=>{remember();if(/^k[0-5]$/.test(el.dataset.bolt))el.title='K'+(Number(el.dataset.bolt.slice(1))+1)+': '+el.value;hooks.clearPreview();});
        el.addEventListener('change',()=>{remember();hooks.clearPreview();if(['connection','kind'].includes(el.dataset.bolt))hooks.render();});
      });
      document.querySelectorAll('[data-bolt-action]').forEach(el=>el.onclick=()=>{
        if(hooks.isBusy())return;
        const action=el.dataset.boltAction;
        if(['center','head','nut'].includes(action)){
          remember();const engine=hooks.engine(),ids=engine.getState().selection?.nodes||[];
          if(!ids.length){hooks.message('Select mesh nodes first.',true);return;}
          if(action==='center'){const selected=new Set(ids),nodes=engine.getMesh().nodes.filter(n=>selected.has(n.id));if(!nodes.length)return;['x','y','z'].forEach((key,i)=>values['center'+i]=nodes.reduce((sum,n)=>sum+n[key],0)/nodes.length);}
          else values[action==='head'?'headNodes':'nutNodes']=ids.join(', ');
          hooks.clearPreview();hooks.render();return;
        }
        return hooks.run(async()=>{
          const mesh=build(),engine=hooks.engine();
          if(action==='preview'){engine.previewMesh({...mesh,nodes:[...engine.getMesh().nodes,...mesh.nodes]});hooks.message('Bolt preview ready. Review both attachment patches before creating.');}
          else {await engine.appendMesh(mesh,values.connection==='CROD'?{area:num('area'),material:{id:engine.getNextIds().material,E:num('E'),nu:num('nu'),rho:num('rho')}}:{});hooks.clearPreview();hooks.log(`Created ${mesh.bolts.length} simulated bolts`);hooks.message(`Created ${mesh.bolts.length} bolts with ${values.connection} shanks and RBE2 attachments.`);}
          const report=document.getElementById('wb-report');report.className='wb-report good';report.textContent=mesh.bolts.map((bolt,i)=>`Bolt ${i+1}: ${bolt.headNodes.length} head nodes · ${bolt.nutNodes.length} nut nodes`).join('\n');
        });
      });
    }
    return {render,bind,remember};
  }};
})();
