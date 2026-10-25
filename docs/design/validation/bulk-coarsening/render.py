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

before = load('flexure-ogrid.webmesh')
after = load('flexure-bulk-coarsened.webmesh')

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

handles=[Patch(facecolor=COLORS['blade'],label='Blade mesh retained'),Patch(facecolor=COLORS['neighbor'],label='Bulk / dependent solids remeshed'),Patch(facecolor=COLORS['retained'],label='Other mesh retained'),Line2D([0],[0],color='#3453ad',marker='o',markerfacecolor='white',label='Shared boundary / shared node ID')]

fig=plt.figure(figsize=(18,12),facecolor='white')
gs=fig.add_gridspec(2,4,left=.055,right=.985,bottom=.105,top=.84,hspace=.4,wspace=.35,height_ratios=[1.45,1])
for col,data,title in [(0,before,'BEFORE  ·  15,508 HEX8'),(2,after,'AFTER  ·  6,184 HEX8')]:
    ax=fig.add_subplot(gs[0,col:col+2]);draw(ax,data,(3.4,16.7),(-15.5,-6.6))
    ax.set_title(title,loc='left',fontsize=18,fontweight='bold',pad=14)
    for x,z,s in [(8.9,-8.1,'Blade 15 · unchanged'),(8.8,-13.5,'Bulk 18'),(3.9,-11.5,'12'),(13.8,-8,'23'),(15.65,-11,'72')]:
        ax.text(x,z,s,ha='center',va='center',fontsize=11,color='#183544',bbox=dict(facecolor='white',edgecolor='none',alpha=.85,pad=2),zorder=6)
    for i,(xlim,ylim,label) in enumerate([((4.3,6.4),(-9.8,-8.1),'Left junction · solids 13 / 14 / 15'),((11.6,14.1),(-9.4,-7.5),'Right junction · solids 15 / 16 / 23')]):
        ax=fig.add_subplot(gs[1,col+i]);draw(ax,data,xlim,ylim,detail=True)
        ax.set_title(label,fontsize=11,loc='left',pad=10)
fig.suptitle('Bulk coarsening — refined blade and surrounding solids',x=.055,y=.965,ha='left',fontsize=23,fontweight='bold')
fig.text(.055,.926,'Actual saved meshes · Front surface at Y = 0 · Identical scales · No deformation',fontsize=13,color='#526173')
fig.legend(handles=handles,loc='upper left',bbox_to_anchor=(.049,.904),frameon=False,ncol=4,fontsize=10.5)
fig.text(.055,.047,'297 / 297 shared CAD faces conform in both meshes. All 43 patch-to-retained interfaces share identical quadrilateral connectivity.',fontsize=12,fontweight='bold')
fig.text(.055,.021,'Blade 15 keeps 3 thickness × 7 length × 6 depth divisions. Blue circles are shared node IDs, not coincident duplicates.',fontsize=11,color='#526173')
fig.savefig(OUT/'detail.png',dpi=150);fig.savefig(OUT/'detail.svg')
plt.close(fig)

fig,axs=plt.subplots(1,2,figsize=(18,7.5),facecolor='white')
fig.subplots_adjust(left=.05,right=.985,bottom=.15,top=.78,wspace=.15)
for ax,data,title in zip(axs,[before,after],['BEFORE · 15,508 elements','AFTER · 6,184 elements (60% fewer)']):
    draw(ax,data,(-27.4,27.4),(-16,16),shared=False)
    ax.set_title(title,loc='left',fontsize=17,fontweight='bold',pad=14)
    from matplotlib.patches import Rectangle
    ax.add_patch(Rectangle((3.4,-15.5),13.3,8.9,facecolor='none',edgecolor='#3453ad',linewidth=2,zorder=7))
fig.suptitle('Local remesh of the flexure bulk',x=.05,y=.96,ha='left',fontsize=25,fontweight='bold')
fig.text(.05,.903,'Bulk targets + two radial layers around endcaps · 89 solids remeshed across two patches · 80 solids retained',fontsize=12,color='#526173')
fig.legend(handles=handles[:3],loc='upper left',bbox_to_anchor=(.043,.87),frameon=False,ncol=3,fontsize=11)
fig.text(.05,.07,'All eight blade meshes are unchanged. Blade 15 retains three elements through thickness; the other seven retain their previous one layer.',fontsize=11)
fig.text(.05,.035,'Blue boxes locate the detail view. Minimum scaled Jacobian remains 0.270; no inverted elements. This comparison does not establish convergence.',fontsize=11,color='#526173')
fig.savefig(OUT/'overview.png',dpi=150);fig.savefig(OUT/'overview.svg')
print('Rendered overview and detailed shared-node views.')

# Isolate the additional ring-coarsening pass, with adjacent retained solids.
fig, axes = plt.subplots(1, 2, figsize=(16, 10.5), facecolor='white')
fig.subplots_adjust(left=.065, right=.975, bottom=.13, top=.81, wspace=.2)
for ax, filename, title in zip(axes,
        ['flexure-bulk-only.webmesh', 'flexure-bulk-coarsened.webmesh'],
        ['BEFORE · 5 radial layers', 'AFTER · 2 radial layers']):
    project = json.load(open(ROOT / filename))
    owner = next(o['definition'] for o in project['ownership']['project']['objects']
                 if o['definition'].get('generator') == 'cad-mapped-v1')
    nodes = {c['id']: [c['value'][k] for k in ('x','y','z')] for c in owner['cards'] if c['family']=='nodes'}
    volumes = {eid: v['id'] for v in owner['volumeElements'] for eid in v['elements']}
    polygons, colors, edge_volumes = [], [], defaultdict(set)
    for card in owner['cards']:
        if card['family'] != 'elems': continue
        volume = volumes[card['id']]
        for q in Q:
            ids = tuple(card['value']['n'][i] for i in q)
            pts = [nodes[n] for n in ids]
            if not all(abs(p[2]-15)<1e-8 for p in pts): continue
            if max(p[0] for p in pts)<14.5 or min(p[0] for p in pts)>24.5: continue
            polygons.append([p[:2] for p in pts])
            colors.append('#70d2c2' if volume==145 else '#efcd8e' if volume in (142,143,144,146) else '#d6dfe7')
            for a,b in zip(ids,ids[1:]+ids[:1]): edge_volumes[tuple(sorted((a,b)))].add(volume)
    ax.add_collection(PolyCollection(polygons,facecolors=colors,edgecolors='#425262',linewidths=.8))
    edges = [ids for ids,vs in edge_volumes.items() if len(vs)>1]
    ax.add_collection(LineCollection([[nodes[n][:2] for n in ids] for ids in edges],colors='#3453ad',linewidths=1.4))
    ids = set(n for e in edges for n in e)
    ax.scatter([nodes[n][0] for n in ids],[nodes[n][1] for n in ids],s=15,facecolors='white',edgecolors='#3453ad',linewidths=.9,zorder=4)
    ax.set(xlim=(14.5,24.5),ylim=(-12.5,.5),aspect='equal',xlabel='X (mm)',ylabel='Y (mm)')
    ax.set_facecolor('#fafbfc'); ax.set_title(title,fontsize=19,fontweight='bold',loc='left',pad=15)
fig.suptitle('Endcap surround — fewer rings, same circular boundary',x=.065,y=.965,ha='left',fontsize=24,fontweight='bold')
fig.text(.065,.918,'Right upper endcap at Z = 15 mm · Matching scales · Actual saved meshes · Adjacent solids included',fontsize=12,color='#526173')
fig.legend(handles=[Patch(facecolor='#70d2c2',label='Core retained exactly'),Patch(facecolor='#efcd8e',label='Surround coarsened'),Patch(facecolor='#d6dfe7',label='Adjacent solids retained'),handles[3]],loc='upper left',bbox_to_anchor=(.058,.888),frameon=False,ncol=4,fontsize=10.5)
fig.text(.065,.063,'Endcap-only local patch: 48 solids remeshed; 121 retained. 7,900 → 6,184 elements. All 64 patch interfaces conform.',fontsize=12,fontweight='bold')
fig.text(.065,.03,'Both left and right surrounds, including the separate lower hole surrounds, use two radial layers. Core and circumferential divisions are unchanged.',fontsize=11,color='#526173')
fig.savefig(OUT/'endcaps.png',dpi=150);fig.savefig(OUT/'endcaps.svg')
