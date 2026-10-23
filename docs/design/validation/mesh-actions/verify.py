"""Reproduce browser-mesh and recipe-comparison equilibrium checks.

python3 verify.py --solver ~/Documents/vibe-tran/build/vibestran --output /tmp/action-check
CAD recipes were authored in the browser. Loads/supports below are a test harness.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parent

def table(block):
    rows = []
    for line in block.split('MAX*')[0].splitlines():
        fields = line.split()
        if len(fields) == 8 and fields[0].isdigit():
            rows.append((int(fields[0]), list(map(float, fields[2:]))))
    return rows

def check(solver, folder, name):
    mesh = (folder / (name + '.bdf')).read_text()
    grids = {int(t[1]): list(map(float, t[3:6])) for t in (line.split(',') for line in mesh.splitlines()) if t[0] == 'GRID'}
    is_extruded = name == 'extruded'
    length, force, moment = (30, 1, 0) if is_extruded else (100, 100, 1000)
    root = [n for n,p in grids.items() if abs(p[0]) < 1e-7]
    tip = [n for n,p in grids.items() if abs(p[0] - length) < 1e-7]
    assert root and tip
    controls = ('SOL 101\nCEND\nSPC=1\nDISPLACEMENT(PRINT,PLOT)=ALL\n'
                'SPCFORCES(PRINT,PLOT)=ALL\nSTRESS(PRINT,PLOT)=ALL\nSUBCASE 1\nLOAD=2\n')
    if not is_extruded:
        controls += 'SUBCASE 2\nLOAD=3\n'
    conditions = [f'SPC1,1,123,{n}' for n in root]
    conditions += [f'FORCE,2,{n},0,{force/len(tip):.12g},0.,0.,-1.' for n in tip]
    if not is_extruded:
        conditions += [f'MOMENT,3,{n},0,{moment/len(tip):.12g},0.,1.,0.' for n in tip]
    bulk = mesh.split('BEGIN BULK',1)[1].replace('ENDDATA','').strip()
    if is_extruded:
        assert not re.search(r'^(CQUAD4|CTRIA3),',bulk,re.M), 'Parent shells leaked into analysis'
    run = folder / name
    run.mkdir(exist_ok=True)
    (run/'case.bdf').write_text(controls+'BEGIN BULK\nPARAM,AUTOSPC,YES\n'+bulk+'\n'+'\n'.join(conditions)+'\nENDDATA\n')
    completed = subprocess.run([str(solver),'case.bdf'],cwd=run,capture_output=True,text=True)
    log = completed.stdout + completed.stderr
    (run/'solver.log').write_text(log)
    assert completed.returncode == 0 and 'Solution complete' in log, log
    residuals = [float(x) for x in re.findall(r'relative residual.*?= ([\d.eE+-]+)',log)]
    assert len(residuals) == (1 if is_extruded else 2) and max(residuals) < 1e-8
    f06=(run/'case.F06').read_text()
    balances=[]
    for i,block in enumerate(f06.split('S P C   F O R C E S')[1:]):
        reaction=[0.]*6
        for nid,v in table(block):
            x,y,z=grids[nid];fx,fy,fz=v[:3]
            for j,component in enumerate([fx,fy,fz,y*fz-z*fy+v[3],z*fx-x*fz+v[4],x*fy-y*fx+v[5]]):
                reaction[j]+=component
        expected=[0,0,force,force*sum(grids[n][1] for n in tip)/len(tip),-force*length,0] if i==0 else [0,0,0,0,-moment,0]
        assert all(abs(a-b)<.01 for a,b in zip(reaction,expected)), (name,reaction,expected)
        balances.append(reaction)
    assert len(balances)==len(residuals)
    displacement=[]
    for block in f06.split('D I S P L A C E M E N T S')[1:]:
        rows=dict(table(block));displacement.append(sum(rows[n][2] for n in tip)/len(tip))
    counts={t:len(re.findall('^'+t+',',mesh,re.M)) for t in ['CHEXA','CPENTA','CQUAD4','CTRIA3','RBE3']}
    return {'nodes':len(grids),'elements':counts,'relative_residuals':residuals,'reaction_resultants':balances,'mean_tip_z_displacement':displacement}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--solver',required=True,type=Path)
    parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args();folder=args.output.resolve();folder.mkdir(parents=True,exist_ok=True)
    subprocess.run(['node',str(ROOT/'comparison.cjs'),str(folder)],check=True)
    result={name:check(args.solver.expanduser().resolve(),folder,name) for name in ['extruded','embedded-one-row','embedded-two-rows','rbe3']}
    result['scope']='Equilibrium and workflow checks on coarse meshes. Different idealizations are intentionally allowed different compliance; this is not a convergence or accuracy study.'
    (folder/'results.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))
if __name__=='__main__':main()
