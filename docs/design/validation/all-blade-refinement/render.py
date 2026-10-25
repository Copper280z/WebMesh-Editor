"""Actual HEX8 connectivity views from the two saved flexure projects."""
import json
from collections import defaultdict
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection, LineCollection
from matplotlib.patches import Patch
from matplotlib.lines import Line2D

ROOT = Path(__file__).resolve().parents[4] / 'test-results/flexure-hex'
OUT = Path(__file__).resolve().parent
METRICS = json.load(open(OUT / 'verification.json'))
BLADES = {15,21,43,44,53,55,57,59}
Q = ((0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7))
AFFECTED = set(METRICS['direct'] + METRICS['dependent'])
COLORS = {'blade':'#70d2c2', 'neighbor':'#efcd8e', 'retained':'#d6dfe7'}

def load(name):
    p = json.load(open(ROOT / name))
    objects = p['ownership']['project']['objects']
    d = next(o['definition'] for o in objects if o['definition'].get('generator') == 'cad-mapped-v1')
    topo = next(o['definition']['topology'] for o in objects if 'topology' in o['definition'])
    nodes = {c['id']: tuple(c['value'][k] for k in ('x','y','z')) for c in d['cards'] if c['family']=='nodes'}
    elems = {c['id']: c['value']['n'] for c in d['cards'] if c['family']=='elems'}
    membership = {eid: v['id'] for v in d['volumeElements'] for eid in v['elements']}
    by_volume = defaultdict(list)
    front = []
    for eid,ns in elems.items():
        v = membership[eid]
        for q in Q:
            ids = tuple(ns[i] for i in q)
            by_volume[v].append(ids)
            if all(abs(nodes[n][1]) < 1e-8 for n in ids):
                front.append((v,ids))
    faces = {f['id']:set(f['nodes']) for f in d['faces']}
    checks = []
    for f in topo['faces']:
        if len(f['volumes']) != 2: continue
        member = faces[f['id']]
        a,b = f['volumes']
        sides = [sorted(tuple(sorted(q)) for q in by_volume[v] if set(q) <= member) for v in (a,b)]
        assert sides[0] and sides[0] == sides[1], ('Nonconforming interface',f['id'],a,b)
        checks.append({'face':f['id'],'volumes':[a,b],'quads':len(sides[0]),'nodes':len(set(n for q in sides[0] for n in q))})
    edge_volumes = defaultdict(set)
    for v,ids in front:
        for a,b in zip(ids,ids[1:]+ids[:1]): edge_volumes[tuple(sorted((a,b)))].add(v)
    interfaces = [ids for ids,vs in edge_volumes.items() if len(vs)>1]
    return dict(nodes=nodes,front=front,interfaces=interfaces,checks=checks,elems=elems,membership=membership)

before = load('flexure-bulk-coarsened.webmesh')
after = load('flexure-all-blades.webmesh')

plt.rcParams.update({'font.family':'DejaVu Sans','font.size':11,'axes.spines.top':False,'axes.spines.right':False,'axes.edgecolor':'#a6b0bb','xtick.color':'#526173','ytick.color':'#526173','text.color':'#162c3d','axes.labelcolor':'#526173','svg.fonttype':'path'})

def draw(ax,data,xlim,ylim,detail=False,shared=True):
    nodes=data['nodes']; polys=[]; colors=[]
    for v,ids in data['front']:
        pts=[(nodes[n][0],nodes[n][2]) for n in ids]
        if max(x for x,z in pts)<xlim[0] or min(x for x,z in pts)>xlim[1] or max(z for x,z in pts)<ylim[0] or min(z for x,z in pts)>ylim[1]: continue
        polys.append(pts)
        colors.append(COLORS['blade' if v in BLADES else 'neighbor' if v in AFFECTED else 'retained'])
    ax.add_collection(PolyCollection(polys,facecolors=colors,edgecolors='#425262',linewidths=.55 if not detail else .8,zorder=2))
    lines=[];marked=set()
    if shared:
        for ids in data['interfaces']:
            pts=[(nodes[n][0],nodes[n][2]) for n in ids]
            if not all(xlim[0]-.1<=x<=xlim[1]+.1 and ylim[0]-.1<=z<=ylim[1]+.1 for x,z in pts):continue
            lines.append(pts);marked.update(ids)
        ax.add_collection(LineCollection(lines,colors='#3453ad',linewidths=1.6,zorder=3))
        if marked:
            ax.scatter([nodes[n][0] for n in marked],[nodes[n][2] for n in marked],s=13 if not detail else 23,facecolors='white',edgecolors='#3453ad',linewidths=1,zorder=4)
    ax.set(xlim=xlim,ylim=ylim,aspect='equal',xlabel='X (mm)',ylabel='Z (mm)')
    ax.set_facecolor('#fafbfc');ax.tick_params(labelsize=9)

handles=[Patch(facecolor=COLORS['blade'],label='Flexure blades'),Patch(facecolor=COLORS['neighbor'],label='Dependent junctions / neighbors'),Patch(facecolor=COLORS['retained'],label='Other mesh retained'),Line2D([0],[0],color='#3453ad',marker='o',markerfacecolor='white',label='Shared boundary / shared node ID')]

DETAILS = [
 ('upper-right','Upper right blades and surrounding solids',(3.4,16.7),(4.8,15.5),[(9,11.8,'Bulk 40 · retained'),(9,8.05,'Blade 43'),(9,5.7,'Blade 44')],[((4.3,6.4),(5.2,8.6),'Inner junctions'),((11.6,14.1),(5.2,8.6),'Outer junctions')]),
 ('upper-left','Upper left blades and surrounding solids',(-16.7,-3.4),(4.8,15.5),[(-9,11.8,'Bulk 33 · retained'),(-9,8.05,'Blade 55'),(-9,5.7,'Blade 57')],[((-6.4,-4.3),(5.2,8.6),'Inner junctions'),((-14.1,-11.6),(5.2,8.6),'Outer junctions')]),
 ('lower-left','Lower left blades and surrounding solids',(-16.7,-3.4),(-15.5,-4),[(-9,-13.4,'Bulk 3 · retained'),(-9,-4.65,'Blade 59'),(-9,-8.1,'Blade 21')],[((-6.4,-4.3),(-6.1,-4.3),'Middle blade root'),((-6.4,-4.3),(-9.8,-8.1),'Lower blade root')]),
 ('lower-right','Lower right blades and surrounding solids',(3.4,16.7),(-15.5,-4),[(9,-13.4,'Bulk 18 · retained'),(9,-4.65,'Blade 53'),(9,-8.1,'Blade 15 · already refined')],[((4.3,6.4),(-6.1,-4.3),'Middle blade root'),((4.3,6.4),(-9.8,-8.1),'Existing lower blade root')]),
]
for key,title,xlim,ylim,labels,insets in DETAILS:
    fig=plt.figure(figsize=(18,12.2),facecolor='white')
    gs=fig.add_gridspec(2,4,left=.055,right=.985,bottom=.105,top=.84,hspace=.4,wspace=.35,height_ratios=[1.45,1])
    for col,data,panel in [(0,before,'BEFORE · 6,184 HEX8'),(2,after,'AFTER · 7,700 HEX8')]:
        ax=fig.add_subplot(gs[0,col:col+2]);draw(ax,data,xlim,ylim)
        ax.set_title(panel,loc='left',fontsize=18,fontweight='bold',pad=14)
        for x,z,text in labels:
            ax.text(x,z,text,ha='center',va='center',fontsize=11,color='#183544',bbox=dict(facecolor='white',edgecolor='none',alpha=.85,pad=2),zorder=6)
        for j,(xx,yy,label) in enumerate(insets):
            ax=fig.add_subplot(gs[1,col+j]);draw(ax,data,xx,yy,detail=True)
            ax.set_title(label,fontsize=11,loc='left',pad=10)
    fig.suptitle(title,x=.055,y=.966,ha='left',fontsize=24,fontweight='bold')
    fig.text(.055,.929,'Actual saved HEX8 faces at Y = 0 · Identical scales · Seven blades refined; blade 15 retained',fontsize=13,color='#526173')
    fig.legend(handles=handles,loc='upper left',bbox_to_anchor=(.049,.903),frameon=False,ncol=4,fontsize=10.5)
    fig.text(.055,.047,'Each blade: 3 thickness × 7 length × 6 depth. All 11 coarsened bulk blocks and 56 endcap blocks retained exactly.',fontsize=12,fontweight='bold')
    fig.text(.055,.021,'297 / 297 shared CAD faces conform, including all 27 patch boundaries. Blue circles identify shared node IDs, not coincident duplicates.',fontsize=11,color='#526173')
    fig.savefig(OUT/(key+'.png'),dpi=150);fig.savefig(OUT/(key+'.svg'));plt.close(fig)

fig,axs=plt.subplots(1,2,figsize=(18,7.6),facecolor='white')
fig.subplots_adjust(left=.05,right=.985,bottom=.15,top=.78,wspace=.15)
for ax,data,title in zip(axs,[before,after],['BEFORE · 6,184 elements','AFTER · 7,700 elements']):
    draw(ax,data,(-27.4,27.4),(-16,16),shared=False)
    ax.set_title(title,loc='left',fontsize=17,fontweight='bold',pad=14)
fig.suptitle('Three thickness layers on every flexure blade',x=.05,y=.96,ha='left',fontsize=25,fontweight='bold')
fig.text(.05,.903,'45 solids remeshed · 124 retained · All 11 coarse bulk blocks and 56 endcap blocks unchanged',fontsize=12,color='#526173')
fig.legend(handles=handles[:3],loc='upper left',bbox_to_anchor=(.043,.87),frameon=False,ncol=3,fontsize=11)
fig.text(.05,.07,'Each blade has 126 HEX8 elements. The seven newly refined blades previously had 42 each. All 297 shared CAD faces conform.',fontsize=11)
fig.text(.05,.035,'Minimum scaled Jacobian remains 0.270; no inverted elements. Coarse bulk targets, two-layer endcap surrounds and O-grid methods are preserved.',fontsize=11,color='#526173')
fig.savefig(OUT/'overview.png',dpi=150);fig.savefig(OUT/'overview.svg');plt.close(fig)
print('Rendered four matched detail views and the whole-part comparison.')
