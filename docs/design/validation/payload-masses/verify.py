"""Solve the browser-authored battery/payload fixture and check six-component balance.

python3 verify.py --solver ~/Documents/vibe-tran/MYSTRAN/Binaries/mystran --output /tmp/payload-check
The project is browser-authored. Only supports, acceleration cases and output
requests are supplied by this harness. Existing structural mass is retained.
"""
import argparse
import itertools
import json
import math
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]

def table(block):
    rows = []
    for line in block.split('MAX*')[0].splitlines():
        fields = line.split()
        if len(fields) == 8 and fields[0].isdigit():
            rows.append((int(fields[0]), list(map(float, fields[2:]))))
    return rows

def mass_samples(cards, grids):
    materials = {c['id']: c['value'] for c in cards if c['family'] == 'materials'}
    props = {c['id']: c['value'] for c in cards if c['family'] == 'properties'}
    samples = []
    signs = [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]
    for card in cards:
        v = card['value']
        if card['family'] == 'masses':
            assert v['type'] == 'CONM2' and v['cid'] == 0
            samples.append((v['m'], [a+b for a,b in zip(grids[v['g']],v['x'])]))
        if card['family'] != 'elems' or v['type'] == 'RBE3':
            continue
        p = props[v['pid']]
        rho = materials[p.get('mid', p.get('mid1'))]['rho']
        xyz = [grids[n] for n in v['n']]
        if v['type'] == 'CHEXA':
            assert len(xyz) == 8
            for q in itertools.product([-1/math.sqrt(3),1/math.sqrt(3)], repeat=3):
                shape = [math.prod(1+s[j]*q[j] for j in range(3))/8 for s in signs]
                pos = [sum(shape[i]*xyz[i][j] for i in range(8)) for j in range(3)]
                jac = [[sum(xyz[i][a]*signs[i][b]*math.prod(1+signs[i][j]*q[j] for j in range(3) if j != b)/8 for i in range(8)) for b in range(3)] for a in range(3)]
                determinant = sum(a*b for a,b in zip(jac[0],cross(jac[1],jac[2])))
                assert determinant > 0
                samples.append((rho*determinant, pos))
        elif v['type'] in ('CQUAD4','CTRIA3'):
            for tri in ([(0,1,2),(0,2,3)] if len(xyz)==4 else [(0,1,2)]):
                a,b,c = [xyz[i] for i in tri]
                area = math.sqrt(sum(x*x for x in cross([b[i]-a[i] for i in range(3)],[c[i]-a[i] for i in range(3)])))/2
                # MYSTRAN's lumped shell mass is shared equally over the corners.
                # Each triangle contributes its area to the element's nodal-average COM.
                samples.append((rho*p['t']*area, [sum(q[i] for q in xyz)/len(xyz) for i in range(3)]))
        else:
            raise AssertionError('Unsupported fixture element '+v['type'])
    return samples

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--solver', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--project', type=Path, default=ROOT/'payloads.webmesh')
    args = parser.parse_args()
    project = json.loads(args.project.read_text())
    cards = [e['card'] for e in project['ownership']['owners']]
    grids = {c['id']: [c['value'][k] for k in ('x','y','z')] for c in cards if c['family']=='nodes'}
    samples = mass_samples(cards, grids)
    payloads = [o for o in project['ownership']['project']['objects'] if o['definition'].get('generator')=='distributed-payload-v1']
    assert sorted(o['definition']['parameters']['mass'] for o in payloads)==[.0005,.001]
    fixed = [n for n,p in grids.items() if abs(p[0])<1e-8]
    assert fixed
    deck = project['deck'].split('BEGIN BULK',1)[1].replace('ENDDATA','').strip()
    acceleration = [[0,0,-9806.65],[0,4903.325,0]]
    mystran = args.solver.name.lower() == 'mystran'
    controls = 'SOL 101\nCEND\nSPC=1\nDISPLACEMENT=ALL\nSPCFORCES=ALL\nSTRESS=ALL\nOLOAD=ALL\nSUBCASE 1\nLABEL=Gravity\nLOAD=2\nSUBCASE 2\nLABEL=Lateral 0.5g\nLOAD=3\nBEGIN BULK\n'
    extra = ['PARAM,AUTOSPC,YES']+[f'SPC1,1,123,{n}' for n in fixed]+['GRAV,2,0,9806.65,0.,0.,-1.','GRAV,3,0,4903.325,0.,1.,0.']
    folder = args.output.resolve();folder.mkdir(parents=True,exist_ok=True)
    text = controls+deck+'\n'+'\n'.join(extra)+'\nENDDATA\n'
    if mystran:
        # Explicit compatibility projection for the installed MYSTRAN binary:
        # <=16-character free fields, no empty continuations, HEX8 IN=2.
        lines=[]
        for line in text.splitlines():
            if line.strip() in ('+','+,'):continue
            tokens=line.split(',')
            for i,t in enumerate(tokens):
                if re.fullmatch(r'[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?',t) and any(c in t for c in '.eE'):
                    value=format(float(t),'.11g')
                    tokens[i]=value if any(c in value for c in '.eE') else value+'.'
            if tokens[0]=='PSOLID':tokens=(tokens+['']*5)[:4]+['2']
            lines.append(','.join(tokens))
        text='\n'.join(lines)+'\n'
    (folder/'payloads.bdf').write_text(text)
    run = subprocess.run([str(args.solver.expanduser().resolve()),'payloads.bdf'],cwd=folder,capture_output=True,text=True)
    log = run.stdout+run.stderr;(folder/'solver.log').write_text(log)
    assert run.returncode==0 and ('MYSTRAN terminated normally' if mystran else 'Solution complete') in log, log
    residuals=[float(x) for x in re.findall(r'relative residual.*?= ([\d.eE+-]+)',log)]
    f06=(folder/'payloads.F06').read_text();checks=[];errors=[]
    epsilons=[float(x) for x in re.findall(r'EPSILON ERROR ESTIMATE\s*=\s*([\d.Ee+-]+)',f06)]
    if mystran:
        if len(epsilons)!=2 or max(map(abs,epsilons))>=1e-8:errors.append('Solver epsilon exceeds 1e-8')
    elif len(residuals)!=2 or max(residuals)>=1e-8:errors.append('Solver relative residual exceeds 1e-8')
    for case,block in enumerate(f06.split('S P C   F O R C E S')[1:]):
        actual=[0.]*6;expected=[0.]*6
        for nid,v in table(block):
            moment=cross(grids[nid],v[:3])
            for i,x in enumerate(v[:3]+[moment[j]+v[3+j] for j in range(3)]):actual[i]+=x
        for m,position in samples:
            force=[m*a for a in acceleration[case]]
            for i,x in enumerate(force+cross(position,force)):expected[i]-=x
        if not all(abs(a-b)<.02 for a,b in zip(actual,expected)):errors.append('Case '+str(case+1)+': force/moment equilibrium differs by more than 0.02 N or N mm')
        checks.append({'expected_reaction':expected,'actual_reaction':actual})
    assert len(checks)==2
    displacements=[]
    for block in f06.split('D I S P L A C E M E N T S')[1:]:
        rows=dict(table(block));displacements.append({o['name']:rows[o['definition']['identities']['node']] for o in payloads})
    result={'solver':str(args.solver),'passed':not errors,'errors':errors,'epsilon_estimates':epsilons,'total_mass_t':sum(m for m,_ in samples),'payload_mass_t':.0015,'relative_residuals':residuals,'cases':checks,'payload_displacements':displacements,'scope':'Workflow and equilibrium validation of the browser-authored fixture; not a converged engineering prediction.'}
    (folder/'results.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
    if errors:raise SystemExit(1)

if __name__=='__main__':
    main()
