"""Reproduce the browser-generated mixed-model equilibrium checks with Vibestran.

python3 verify.py --solver ~/Documents/vibe-tran/build/vibestran --output /tmp/mixed-check
The saved project is the UI mesh; the two static load cases are a test harness.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--solver', required=True, type=Path)
    parser.add_argument('--project', type=Path, default=ROOT / 'mixed-refined.webmesh')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    project = json.loads(args.project.read_text())
    cards = [c for o in project['ownership']['project']['objects'] for c in o['definition'].get('cards', [])]
    grids = {c['id']: c['value'] for c in cards if c['family'] == 'nodes'}
    root = [i for i, n in grids.items() if abs(n['x']) < 1e-6]
    tip = [i for i, n in grids.items() if abs(n['x']-100) < 1e-6]
    assert root and tip
    header = ('SOL 101\nCEND\nTITLE = WEBMESH MIXED INTERFACE VERIFICATION\nSPC = 1\n'
              'DISPLACEMENT(PRINT,PLOT) = ALL\nSPCFORCES(PRINT,PLOT) = ALL\nSTRESS(PRINT,PLOT) = ALL\n'
              'SUBCASE 1\n LOAD = 2\nSUBCASE 2\n LOAD = 3\nBEGIN BULK\nPARAM,AUTOSPC,YES\nPARAM,POST,-1\n')
    bulk = project['deck'].split('BEGIN BULK', 1)[1].replace('ENDDATA', '').strip()
    conditions = [f'SPC1,1,123,{i}' for i in root]
    conditions += [f'FORCE,2,{i},0,{100/len(tip):.12g},0.,0.,-1.' for i in tip]
    conditions += [f'MOMENT,3,{i},0,{1000/len(tip):.12g},0.,1.,0.' for i in tip]
    args.output.mkdir(parents=True, exist_ok=True)
    deck = args.output / 'mixed.bdf'
    deck.write_text(header + bulk + '\n' + '\n'.join(conditions) + '\nENDDATA\n')
    result = subprocess.run([str(args.solver.expanduser().resolve()), deck.name], cwd=args.output, text=True, capture_output=True)
    log = result.stdout + result.stderr
    (args.output / 'solver.log').write_text(log)
    assert result.returncode == 0 and 'Solution complete' in log, log
    f06 = (args.output / 'mixed.F06').read_text()
    balances = []
    for case, block in enumerate(f06.split('S P C   F O R C E S')[1:], 1):
        rows = []
        for line in block.split('MAX*')[0].splitlines():
            values = line.split()
            if len(values) == 8 and values[0].isdigit():
                rows.append((int(values[0]), list(map(float, values[2:]))))
        force = [sum(v[j] for _, v in rows) for j in range(3)]
        moment = [0., 0., 0.]
        for nid, v in rows:
            x, y, z = [grids[nid][a] for a in 'xyz']
            fx, fy, fz = v[:3]
            for j, value in enumerate([y*fz-z*fy, z*fx-x*fz, x*fy-y*fx]):
                moment[j] += value + v[j+3]
        expected_force = [0, 0, 100] if case == 1 else [0, 0, 0]
        expected_moment = [3000, -10000, 0] if case == 1 else [0, -1000, 0]
        assert all(abs(a-b) < .01 for a, b in zip(force, expected_force)), force
        assert all(abs(a-b) < .01 for a, b in zip(moment, expected_moment)), moment
        balances.append({'subcase': case, 'reaction_force': force, 'reaction_moment_at_origin': moment})
    assert len(balances) == 2
    residuals = [float(x) for x in re.findall(r'relative residual.*?= ([\d.eE+-]+)', log)]
    assert len(residuals) == 2 and max(residuals) < 1e-8
    counts = {t: sum(c['family']=='elems' and c['value']['type']==t for c in cards) for t in ['CHEXA', 'CQUAD4', 'RBE3']}
    summary = {'nodes': len(grids), 'elements': counts, 'relative_residuals': residuals, 'balances': balances,
               'scope': 'Force/moment transfer and solvability check; not a convergence study or general interface accuracy certification.'}
    (args.output / 'results.json').write_text(json.dumps(summary, indent=2)+'\n')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
