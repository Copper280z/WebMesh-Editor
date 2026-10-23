// Rebuild comparison recipes from the exact browser-authored mesh regions.
// Usage: node comparison.cjs /tmp/mesh-action-check
const fs=require('node:fs'),path=require('node:path');
const O=require('../../../../app/engine-ownership.js'),E=require('../../../../app/embedded-interface.js'),I=require('../../../../app/interface-project.js');
const destination=process.argv[2];if(!destination)throw Error('Supply an output directory.');fs.mkdirSync(destination,{recursive:true});
const base=JSON.parse(fs.readFileSync(path.join(__dirname,'embedded-base.webmesh'),'utf8'));
const embedded=JSON.parse(fs.readFileSync(path.join(__dirname,'embedded.webmesh'),'utf8'));
function semantic(project){const s={nodes:[],elems:{},properties:[],materials:[],coords:[],masses:[],loads:{},spc:[],spc1:[],temperatures:[]};for(const o of project.ownership.project.objects)for(const c of o.definition.cards||[])O.put(s,c);return s;}
function card(name,fields){const lines=[];for(let i=0;i<fields.length;i+=8)lines.push((i?'+':name)+','+fields.slice(i,i+8).join(','));return lines.join('\n');}
function deck(s){const lines=['CEND','BEGIN BULK'];for(const [id,n] of s.nodes)lines.push(card('GRID',[id,0,n.x,n.y,n.z,0]));for(const [id,m] of s.materials)lines.push(card('MAT1',[id,m.E,'',m.nu,m.rho]));for(const [id,p] of s.properties)lines.push(p.type==='PSHELL'?card('PSHELL',[id,p.mid1,p.t,p.mid2,'',p.mid3]):card('PSOLID',[id,p.mid]));for(const e of Object.values(s.elems).flat())lines.push(e.type==='RBE3'?card('RBE3',[e.eid,'',e.gn,e.cm,1,'123',...e.inds]):card(e.type,[e.eid,e.pid,...e.n]));return lines.join('\n')+'\nENDDATA\n';}
const shell=base.ownership.project.objects.find(o=>o.definition.generator==='cad-shell-v1'),solid=base.ownership.project.objects.find(o=>o.definition.generator==='cad-mapped-v1');
const maxElement=Math.max(...base.ownership.project.reservations.filter(r=>r.namespace==='element').map(r=>r.end))+1;
const common={shell:shell.id,solid:solid.id,edges:[12],faces:[6]};
for(const [name,project,request] of [
  ['rbe3',base,I.build({...common,id:'comparison-rbe3',name:'Comparison RBE3',radius:15,gap:1e-6},base.ownership,{element:maxElement})],
  ['embedded-one-row',embedded,E.build({...embedded.ownership.project.objects.find(o=>o.definition.generator===E.GENERATOR).definition,id:embedded.ownership.project.objects.find(o=>o.definition.generator===E.GENERATOR).id,name:'One-row comparison',rows:1},embedded.ownership,{element:maxElement})]
]){const a=O.preview(semantic(project),project.ownership,request);fs.writeFileSync(path.join(destination,name+'.bdf'),deck(a.semantic));}
fs.writeFileSync(path.join(destination,'embedded-two-rows.bdf'),embedded.deck);
fs.copyFileSync(path.join(__dirname,'extruded-export.bdf'),path.join(destination,'extruded.bdf'));
