"""Check saved browser region bindings and independently integrate reaction balance.
Run: python3 docs/design/validation/graphical-regions/verify.py
Uses retained MYSTRAN output; does not modify/re-run the model.
"""
import hashlib
import importlib.util
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('mass_check', ROOT.parent/'payload-masses'/'verify.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
p = json.loads((ROOT/'repaired.webmesh').read_text())
r = p['analysisRuns'][-1]
assert r['status'] == 'completed'
assert hashlib.sha256(r['deck'].encode()).hexdigest() == r['deckDigest']
assert hashlib.sha256(r['result']['f06'].encode()).hexdigest() == r['result']['digest']
objects = p['ownership']['project']['objects']
regions = [o for o in objects if o['definition'].get('generator') == 'mesh-region-v1']
assert len(regions) == 2
nodes = next(o for o in regions if o['definition']['entity'] == 'node')
elements = next(o for o in regions if o['definition']['entity'] == 'element')
assert nodes['definition']['ids'] == [1084,1085,1091,1092,1098,1099]
assert len(elements['definition']['ids']) == 7
support = next(o for o in objects if o['definition'].get('region') == nodes['id'])
assert support['definition']['action']['nodes'] == nodes['definition']['ids']
assert not any(o['definition'].get('analysisExcluded') for o in objects)
cards = [entry['card'] for entry in p['ownership']['owners']]
grids = {c['id']:[c['value'][k] for k in ('x','y','z')] for c in cards if c['family'] == 'nodes'}
structural = [c for c in cards if c['family'] != 'elems' or c['value']['type'] in ('CHEXA','CQUAD4','CTRIA3')]
samples = v.mass_samples(structural,grids)
def unit(p):
    length = math.sqrt(sum(x*x for x in p))
    return [x/length for x in p]
def axes(c):
    z=unit([b-a for a,b in zip(c['origin'],c['zAxisPt'])])
    y=unit(v.cross(z,[b-a for a,b in zip(c['origin'],c['xzPlanePt'])]))
    return [v.cross(y,z),y,z]
frames={c['id']:axes(c['value']) for c in cards if c['family']=='coords'}
def rotate(p,frame):
    return [sum(p[j]*frame[j][i] for j in range(3)) for i in range(3)]
checks=[]
for case,block in enumerate(r['result']['f06'].split('S P C   F O R C E S')[1:]):
    actual=[0.]*6
    for line in block.split('MAX*')[0].splitlines():
        t=line.split()
        if len(t)!=8 or not t[0].isdigit():continue
        nid,cid=int(t[0]),int(t[1]);values=list(map(float,t[2:]))
        if cid:values=rotate(values[:3],frames[cid])+rotate(values[3:],frames[cid])
        moment=v.cross(grids[nid],values[:3])
        for j,x in enumerate(values[:3]+[values[k+3]+moment[k] for k in range(3)]):actual[j]+=x
    acceleration=[[0,0,-9806.65],[0,4903.325,0]][case]
    expected=[0.]*6
    for mass,position in samples:
        force=[mass*a for a in acceleration]
        for j,x in enumerate(force+v.cross(position,force)):expected[j]-=x
    residual=[a-b for a,b in zip(actual,expected)]
    # Explicit absolute tolerances for independently integrated quantities and
    # rounded F06 reaction tables. Keep the stricter product result unchanged.
    assert all(abs(x)<(1e-4 if j<3 else 1e-3) for j,x in enumerate(residual)),residual
    checks.append({'subcase':case+1,'expected':expected,'actual':actual,'residual':residual})
assert len(checks)==2
print(json.dumps({'independent_check_passed':True,'force_tolerance_N':1e-4,'moment_tolerance_Nmm':1e-3,'mass_kg':sum(m for m,_ in samples)*1000,'cases':checks,'product_diagnostic':r['result']['diagnostics']['equilibrium']},indent=2))
