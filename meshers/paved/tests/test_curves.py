"""Open control curves (ABI 0.3) through the Python bindings.

    python3 -I tests/test_curves.py path/to/libquadmesh_paved.dylib

Meshes faces/curves/*.json as WebMesh sends them (every loop and curve fixed, curves as open
runs) with this repo's binding and, when present, the quadtree mesher's binding that WebMesh
uses, and checks the contract in cpp2/webmesh_faces/OPEN_CURVES.md.
"""
import importlib.util
import json
import math
import os
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bindings", "python"))
from quadmesh_paved import Mesher, MeshError  # noqa: E402

CURVES = os.path.join(HERE, "..", "faces", "curves")
VALID = ["tee", "floating", "hole_and_boundary", "plus"]


def webmesh_loops(face):
    loops = []
    for l in face["loops"]:
        pts = [tuple(p) for p in l["points"]]
        if l["role"] == "curve":
            run = {"nodes": pts, "start": (0, 0), "end": (len(pts) - 2, 1), "closed": False}
        else:
            run = {"nodes": pts, "closed": True}
        loops.append({"points": pts, "role": l["role"], "fixed_runs": [run]})
    return loops


def corner_angles(nodes, q):
    out = []
    for k in range(4):
        o, a, b = nodes[q[k]], nodes[q[(k + 1) % 4]], nodes[q[(k + 3) % 4]]
        u = (a[0] - o[0], a[1] - o[1]); w = (b[0] - o[0], b[1] - o[1])
        out.append((q[k], math.degrees(math.atan2(u[0] * w[1] - u[1] * w[0], u[0] * w[0] + u[1] * w[1])) % 360))
    return out


def check(name, face, out, strict_provenance=True, loops_fixed=True):
    assert out["valid"], f"{name}: {out['issues']}"
    nodes, quads = out["nodes"], out["quads"]
    index = {p: i for i, p in enumerate(nodes)}
    use = {}
    for q in quads:
        for k in range(4):
            e = tuple(sorted((q[k], q[(k + 1) % 4])))
            use[e] = use.get(e, 0) + 1
    free_ends = set()
    for li, l in enumerate(face["loops"]):
        pts = [tuple(p) for p in l["points"]]
        if l["role"] != "curve" and not loops_fixed:
            continue
        for p in pts:
            assert p in index, f"{name}: node {p} of loop {li} not kept exactly"
        if l["role"] != "curve":
            continue
        for a, b in zip(pts, pts[1:]):
            e = tuple(sorted((index[a], index[b])))
            assert use.get(e) == 2, f"{name}: curve {li} segment {a}-{b} used by {use.get(e)} quads"
        for end in (pts[0], pts[-1]):
            shared = any(end in [tuple(p) for p in o["points"]] for oj, o in enumerate(face["loops"]) if oj != li)
            if not shared:
                free_ends.add(index[end])
    min_sj = min(q["min_scaled_jacobian"] for q in out["quality"])
    assert min_sj >= 0.3, f"{name}: min SJ {min_sj}"
    worst, worst_free = 180.0, 180.0
    for q in quads:
        angs = corner_angles(nodes, q)
        near_free = any(v in free_ends for v in q)
        for _, a in angs:
            if near_free:
                worst_free = min(worst_free, a)
            else:
                worst = min(worst, a)
    assert worst >= 20 and worst_free >= 15, f"{name}: min angle {worst}, next to a free end {worst_free}"
    if strict_provenance:
        # One record per loop or curve a node belongs to; each curve segment once.
        for li, l in enumerate(face["loops"]):
            recs = [b for b in out["boundary_nodes"] if b["loop"] == li]
            assert len(recs) == len(l["points"]), f"{name}: loop {li} has {len(recs)} node records"
            for k, (r, p) in enumerate(zip(recs, l["points"])):
                assert r["node"] == index[tuple(p)] and r["fixed_run"] == 0 and r["fixed_node"] == k, (name, li, k, r)
            if l["role"] == "curve":
                segs = [e for e in out["boundary_edges"] if e["loop"] == li]
                assert len(segs) == len(l["points"]) - 1, f"{name}: curve {li} has {len(segs)} edge records"
    return len(quads), min_sj, min(worst, worst_free)


def main(lib):
    m = Mesher(lib)
    for name in VALID:
        face = json.load(open(os.path.join(CURVES, name + ".json")))
        out = m.mesh(webmesh_loops(face), target_size=face["target_size"],
                     elements_per_circle=face["elements_per_circle"])
        n, sj, ang = check(name, face, out)
        print(f"{name}: {n} quads, min SJ {sj:.3f}, min angle {ang:.1f}, provenance OK")
    face = json.load(open(os.path.join(CURVES, "invalid_crossing.json")))
    try:
        m.mesh(webmesh_loops(face), target_size=face["target_size"])
        raise AssertionError("invalid_crossing accepted")
    except MeshError as e:
        assert e.status == 2 and "curve 1" in str(e) and "curve 2" in str(e), e
        print(f"invalid_crossing: refused ({e})")

    # The quadtree mesher's binding (what WebMesh loads) maps role "curve" to 3.
    other = os.path.expanduser("~/Documents/quadmesh/cpp2/bindings/python/quadmesh.py")
    if os.path.exists(other):
        spec = importlib.util.spec_from_file_location("quadmesh_quadtree_binding", other)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        qm = mod.Mesher(lib)
        for name in VALID:
            face = json.load(open(os.path.join(CURVES, name + ".json")))
            out = qm.mesh(webmesh_loops(face), target_size=face["target_size"],
                          elements_per_circle=face["elements_per_circle"])
            check(name, face, out)
        print("quadtree mesher's Python binding: curve faces OK with libquadmesh_paved")
    print("curve tests passed")


if __name__ == "__main__":
    main(sys.argv[1])
