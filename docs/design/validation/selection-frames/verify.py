"""Independent mass/resultant checks, including printed local-coordinate reactions.
Run: python3 docs/design/validation/selection-frames/verify.py
"""
import importlib.util
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('mass_check', ROOT.parent/'payload-masses'/'verify.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

def unit(p):
    length = math.sqrt(sum(x*x for x in p))
    return [x/length for x in p]

def basis(c):
    z = unit([b-a for a,b in zip(c['origin'],c['zAxisPt'])])
    y = unit(v.cross(z,[b-a for a,b in zip(c['origin'],c['xzPlanePt'])]))
    return [v.cross(y,z),y,z]

def rotate(p, axes):
    return [sum(p[j]*axes[j][i] for j in range(3)) for i in range(3)]

reports = {}
for name in ['before','after']:
    model = json.loads((ROOT/(name+'.json')).read_text())
    cards = [o['card'] for o in model['ownership']['owners']]
    grids = {c['id']:[c['value'][k] for k in ['x','y','z']] for c in cards if c['family']=='nodes'}
    frames = {c['id']:basis(c['value']) for c in cards if c['family']=='coords'}
    structural = [c for c in cards if c['family']!='elems' or c['value']['type'] in ['CHEXA','CQUAD4','CTRIA3']]
    samples = v.mass_samples(structural,grids)
    f06 = (ROOT/(name+'.F06')).read_text()
    checks = []
    for case,block in enumerate(f06.split('S P C   F O R C E S')[1:]):
        actual = [0.]*6
        for line in block.split('MAX*')[0].splitlines():
            t=line.split()
            if len(t)!=8 or not t[0].isdigit():continue
            nid,cid=int(t[0]),int(t[1]); values=list(map(float,t[2:]))
            if cid:values=rotate(values[:3],frames[cid])+rotate(values[3:],frames[cid])
            m=v.cross(grids[nid],values[:3])
            for j,x in enumerate(values[:3]+[values[k+3]+m[k] for k in range(3)]):actual[j]+=x
        expected=[0.]*6
        if case==0:
            for mass,pos in samples:
                force=[0,0,-9806.65*mass]
                for j,x in enumerate(force+v.cross(pos,force)):expected[j]-=x
        else:
            force=[0,-10,0];pos=[4,0,0]
            expected=[-x for x in force+v.cross(pos,force)]
        assert all(abs(a-b)<.0001 for a,b in zip(actual,expected)), (name,case,actual,expected)
        checks.append({'subcase':case+1,'expected':expected,'actual':actual})
    assert len(checks)==2
    reports[name]={'mass_t':sum(m for m,_ in samples),'cases':checks}
print(json.dumps({'passed':True,'tolerance_N_or_Nmm':.0001,'models':reports},indent=2))
