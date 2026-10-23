"""Independently check browser-run input identity and six-component reaction balance.

Run with: python3 docs/design/validation/analysis-runs/verify.py
No solver invocation or deck modification is needed; evidence comes from the
saved browser-authored run. Mass integration is shared with the preceding fixture.
"""
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('payload_check', ROOT.parent/'payload-masses'/'verify.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
p = json.loads((ROOT/'analysis.webmesh').read_text())
r = p['analysisRuns'][0]
assert hashlib.sha256(r['deck'].encode()).hexdigest() == r['deckDigest']
assert r['deck'] == (ROOT/'model.bdf').read_text()
assert r['result']['f06'] == (ROOT/'model.F06').read_text()
assert r['result']['log'] == (ROOT/'solver.log').read_text()
assert r['status'] == 'completed'
cards = [o['card'] for o in r['snapshot']['ownership']['owners']]
grids = {c['id']: [c['value'][k] for k in ('x','y','z')] for c in cards if c['family']=='nodes'}
samples = v.mass_samples(cards, grids)
checks = []
for i, block in enumerate(r['result']['f06'].split('S P C   F O R C E S')[1:]):
    actual, expected = [0.]*6, [0.]*6
    for nid, val in v.table(block):
        moment = v.cross(grids[nid], val[:3])
        for j, x in enumerate(val[:3]+[moment[k]+val[3+k] for k in range(3)]):
            actual[j] += x
    for mass, pos in samples:
        force = [mass*a for a in [[0,0,-9806.65],[0,4903.325,0]][i]]
        for j, x in enumerate(force+v.cross(pos,force)):
            expected[j] -= x
    assert all(abs(a-b)<.02 for a,b in zip(actual,expected))
    checks.append({'subcase':i+1,'expected':expected,'actual':actual})
assert len(checks) == 2
result = {'total_mass_t':sum(m for m,_ in samples),'cases':checks,'passed':True,
          'scope':'Independent mass integration vs solver SPC reactions, all six components within 0.02 N or N mm.'}
assert result == json.loads((ROOT/'equilibrium.json').read_text())
print(json.dumps(result, indent=2))
