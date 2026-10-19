/* Compact schema forms without replacing the engine's inputs or pick handlers. */
(() => {
  'use strict';
  const panels = ['schemaCreateCardPanel', 'schemaEditCardPanel'].map(id => document.getElementById(id)).filter(Boolean);
  const lastCard = new WeakMap();
  let nextId = 0, pending = false, submittedPanel = null;
  function clearFeedback(panel) {
    const feedback=panel.querySelector('.wm-submit-feedback');
    if(feedback){feedback.hidden=true;feedback.textContent='';feedback.classList.remove('error');}
    if(submittedPanel===panel)submittedPanel=null;
  }
  const fieldInfo = input => {
    const parts = String(input?.dataset.schemaFieldKey || '').split(':');
    return { card: parts[0] || '', name: parts[2] || '' };
  };
  const vectors = [
    { names: ['x1','x2','x3'], label: card => card === 'GRID' ? 'Position' : card === 'CONM2' ? 'Offset' : 'Orientation' },
    { names: ['n1','n2','n3'], cards: ['FORCE','MOMENT','PLOAD4'], label: () => 'Direction' },
    { names: ['e1x','e1y','e1z'], cards: ['CORD2R','CORD2C','CORD2S'], label: () => 'Origin A' },
    { names: ['e2x','e2y','e2z'], cards: ['CORD2R','CORD2C','CORD2S'], label: () => 'Z axis B' },
    { names: ['e3x','e3y','e3z'], cards: ['CORD2R','CORD2C','CORD2S'], label: () => 'XZ plane C' },
    { names: ['w1a','w2a','w3a'], label: () => 'Offset A' },
    { names: ['w1b','w2b','w3b'], label: () => 'Offset B' }
  ];
  function errorFor(input, includeRequired) {
    if (input.disabled) return '';
    if (input.validity?.badInput || input.validity?.typeMismatch) return 'Enter a valid number.';
    if (input.validity?.rangeUnderflow) return `Minimum ${input.min}.`;
    if (input.validity?.rangeOverflow) return `Maximum ${input.max}.`;
    const value = input.value.trim();
    if (!value) return includeRequired && input.getAttribute('aria-required') === 'true' ? 'Required.' : '';
    if (input.dataset.wmDof && !/^(0|[1-6]+)$/.test(value)) return 'Use DOFs 1–6, or 0 for a scalar point.';
    if (input.dataset.wmDof && value !== '0' && new Set(value).size !== value.length) return 'Each DOF can appear once.';
    return '';
  }
  function validateInput(input, includeRequired = false) {
    const message = errorFor(input, includeRequired), row = input.closest('.schema-field-row,.schema-row');
    if (!row) return;
    let note = row.querySelector('.wm-field-error');
    if (message && !note) {
      note = document.createElement('span'); note.className = 'wm-field-error'; note.id = 'wm-field-error-' + (++nextId); note.setAttribute('role','status'); row.appendChild(note);
      input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'),note.id].filter(Boolean).join(' '));
    }
    if (note) { note.textContent = message; note.hidden = !message; }
    if (message) input.setAttribute('aria-invalid','true'); else input.removeAttribute('aria-invalid');
  }
  function addDofButtons(input, row, label) {
    const { card, name } = fieldInfo(input);
    const isDof = (['SPC','SPC1'].includes(card) && (name === 'components' || /^c\d+$/.test(name))) || (card === 'RBE2' && name === 'cm') || (card === 'RBE3' && ['refc','c1'].includes(name));
    if (!isDof || input.dataset.wmDof) return;
    input.dataset.wmDof = 'true'; input.inputMode = 'numeric'; row.classList.add('wm-dof-row');
    const control = input.closest('.schema-combo-field') || input;
    const editor = document.createElement('div'); editor.className = 'wm-dof-editor';
    control.before(editor); editor.appendChild(control);
    const buttons = document.createElement('div'); buttons.className = 'wm-dof-buttons'; buttons.setAttribute('role','group'); buttons.setAttribute('aria-label', `${label} degrees of freedom`);
    const sync = () => buttons.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed',String(input.value.includes(button.textContent))));
    for (let i=1;i<=6;i++) {
      const button = document.createElement('button'); button.type='button'; button.textContent=String(i); button.title = (i<=3 ? 'Translation ' : 'Rotation ') + ['X','Y','Z'][(i-1)%3]; button.setAttribute('aria-label',`DOF ${i}: ${button.title}`);
      button.addEventListener('click', () => {
        const selected=new Set(input.value.match(/[1-6]/g)||[]), value=String(i);
        if (selected.has(value)) selected.delete(value); else selected.add(value);
        input.value=[...selected].sort().join('');
        input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); sync(); validateInput(input);
      });
      buttons.appendChild(button);
    }
    editor.appendChild(buttons); input.addEventListener('input',sync); input.addEventListener('change',sync); sync();
  }
  function normalizePanel(panel) {
    panel.classList.add('wm-compact-form');
    const card=panel.querySelector('#schemaCreateCard,#schemaEditCard')?.value;
    if(lastCard.has(panel)&&lastCard.get(panel)!==card)clearFeedback(panel);
    lastCard.set(panel,card);
    const host = panel.querySelector('.schema-fields'); if (!host) return;
    const rows = [...host.querySelectorAll(':scope > .schema-field-row,:scope > .schema-row')], byName=new Map();
    for (const row of rows) {
      const input=row.querySelector('[data-schema-field-key]'), label=row.querySelector('.schema-label-wrap label');
      if (!input || !label) continue;
      const info=fieldInfo(input), fullLabel=`${info.card} ${label.textContent.trim()}`;
      byName.set(info.name,{row,input,info});
      if (!input.id) input.id='wm-schema-input-'+(++nextId);
      label.htmlFor=input.id; input.setAttribute('aria-label',fullLabel);
      if (row.querySelector('.schema-badge.required')) input.setAttribute('aria-required','true');
      addDofButtons(input,row,label.textContent.trim());
    }
    for (const spec of vectors) {
      const members=spec.names.map(name=>byName.get(name));
      if (members.some(member=>!member)) continue;
      const card=members[0].info.card;
      if (spec.cards && !spec.cards.includes(card)) continue;
      if (members.some(member=>member.row.parentNode!==host || member.row.classList.contains('advanced-hidden')!==members[0].row.classList.contains('advanced-hidden'))) continue;
      const group=document.createElement('div'); group.className='wm-vector-row'; if(members[0].row.classList.contains('advanced-hidden'))group.classList.add('advanced-hidden');
      const title=document.createElement('span'); title.className='wm-vector-title'; title.textContent=spec.label(card);group.appendChild(title);
      const cells=document.createElement('div');cells.className='wm-vector-cells';group.appendChild(cells);group.setAttribute('role','group');group.setAttribute('aria-label',title.textContent);
      host.insertBefore(group,members[0].row);
      members.forEach(({row,input},i)=>{row.classList.add('wm-vector-cell');row.querySelector('.schema-label-wrap label').textContent=['X','Y','Z'][i];input.placeholder='';cells.appendChild(row);});
    }
    host.querySelectorAll('.schema-pcomp-table tbody tr').forEach((row,index)=>{
      row.querySelectorAll('input,select').forEach((input,column)=>input.setAttribute('aria-label',`Ply ${index+1} ${['material ID','thickness','angle','output'][column]}`));
      const remove=row.querySelector('button');if(remove){remove.setAttribute('aria-label',`Remove ply ${index+1}`);remove.title=`Remove ply ${index+1}`;}
    });
    if (!panel.querySelector('.wm-submit-feedback')) {
      const feedback=document.createElement('div');feedback.className='wm-submit-feedback';feedback.hidden=true;feedback.setAttribute('role','status');panel.querySelector('.card-content').appendChild(feedback);
    }
  }
  const observer=new MutationObserver(() => {
    if(pending)return;pending=true;
    queueMicrotask(()=>{pending=false;observer.disconnect();panels.forEach(normalizePanel);observe();});
  });
  const observe=()=>panels.forEach(panel=>observer.observe(panel,{childList:true,subtree:true}));
  panels.forEach(panel=>{
    panel.addEventListener('change',event=>{if(event.target.matches('#schemaCreateCard,#schemaEditCard'))clearFeedback(panel);});
    panel.addEventListener('focusout',event=>{if(event.target.matches('input[data-schema-field-key]'))validateInput(event.target,true);});
    panel.addEventListener('input',event=>{if(event.target.matches('input[data-schema-field-key]'))validateInput(event.target);});
    panel.addEventListener('click',event=>{
      if(event.target.closest('#btnSchemaClearCard,#btnSchemaClearEdit'))clearFeedback(panel);
      if(event.target.closest('#btnSchemaCreateCard,#btnSchemaApplyEdit')) {
        submittedPanel=panel;panel.querySelectorAll('input[data-schema-field-key]').forEach(input=>{if(!input.closest('.advanced-hidden'))validateInput(input,true);});
      }
    },true);
    normalizePanel(panel);
  });
  observe();
  const status=document.getElementById('status');
  if(status)new MutationObserver(()=>{
    if(!submittedPanel)return;
    const feedback=submittedPanel.querySelector('.wm-submit-feedback');
    if(feedback){feedback.textContent=status.textContent;feedback.hidden=false;feedback.classList.toggle('error',status.classList.contains('danger'));}
    submittedPanel=null;
  }).observe(status,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['class']});
  // Static transform editors use the same label/value rhythm as schema cards.
  // Keep their original IDs and node objects so viewport picking still works.
  for(const card of document.querySelectorAll('#transformToolsCard,#createTab .card,#modifyTab .card')) {
    if(panels.includes(card))continue;
    card.classList.add('wm-compact-legacy');
    for(const row of card.querySelectorAll('.row')) {
      const label=row.querySelector(':scope > label'), controls=[...row.querySelectorAll(':scope > input,:scope > select,:scope > button')];
      if(!label || !controls.length)continue;
      row.classList.add('wm-property-row');
      if(controls[0].id)label.htmlFor=controls[0].id;
      controls.forEach(input=>{if(!input.getAttribute('aria-label'))input.setAttribute('aria-label',`${label.textContent.trim()} ${input.placeholder||''}`.trim());});
      if(controls.length===3 && controls.every(input=>input.matches('input[type=number]'))) {
        row.classList.add('wm-legacy-vector');
        controls.forEach((input,i)=>{
          const cell=document.createElement('label'),axis=document.createElement('span');cell.className='wm-legacy-axis';axis.textContent=['X','Y','Z'][i];
          input.before(cell);cell.append(axis,input);
        });
      } else if(controls.length>1) {
        const group=document.createElement('div');group.className='wm-legacy-controls';controls[0].before(group);controls.forEach(control=>group.appendChild(control));
      }
    }
  }
})();
