"""Stand-in for the rover floor with brace junctions: rover_chassis_face1 plus open curves.

    python3 -I tests/stress_curves.py path/to/libquadmesh_paved.dylib [size]

Adds four curves (three from the outer edge into the plate, one with both ends free),
meshes with free and with fully fixed outer/hole loops, and checks the open-curve
contract: all nodes kept, each curve segment shared by two quads, quality floor.
"""
import json
import math
import os
import sys
import time

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "bindings", "python"))
from quadmesh_paved import Mesher  # noqa: E402
from compare_faces import read_face  # noqa: E402
from test_curves import check  # noqa: E402


def line(a, b, step):
    n = max(1, round(math.dist(a, b) / step))
    return [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(n + 1)]


def main(lib, size):
    m = Mesher(lib)
    loops = read_face(os.path.join(HERE, "..", "faces", "rover_chassis_face1.txt"))
    # Braces: from the bottom, left and top edges toward the middle, avoiding the holes,
    # plus one free wall in the lower right.
    curves = [line((-60.0, -93.0), (-60.0, -50.0), size),
              line((-93.0, 15.0), (-50.0, 15.0), size),
              line((60.0, 93.0), (60.0, 60.0), size),
              line((35.0, -70.0), (70.0, -55.0), size)]
    first = m.mesh(loops, target_size=size)
    assert first["valid"]
    # Snap the edge-touching ends onto the free discretization would not be exact, so put
    # the loops' nodes there by meshing once with free loops (the mesher inserts the nodes),
    # then fix everything as WebMesh does.
    face = {"loops": [dict(role=l["role"], points=l["points"]) for l in loops] +
            [{"role": "curve", "points": c} for c in curves]}
    def with_runs(fix_loops, mesh_out=None):
        out = []
        for li, l in enumerate(face["loops"]):
            pts = [tuple(p) for p in l["points"]]
            if l["role"] == "curve":
                out.append({"points": pts, "role": "curve",
                            "fixed_runs": [{"nodes": pts, "start": (0, 0), "end": (len(pts) - 2, 1), "closed": False}]})
            elif fix_loops:
                nodes = [mesh_out["nodes"][b["node"]] for b in mesh_out["boundary_nodes"] if b["loop"] == li]
                out.append({"points": pts, "role": l["role"], "fixed_runs": [{"nodes": nodes, "closed": True}]})
            else:
                out.append({"points": pts, "role": l["role"]})
        return out
    t0 = time.perf_counter()
    free = m.mesh(with_runs(False), target_size=size)
    t_free = 1000 * (time.perf_counter() - t0)
    n, sj, ang = check("rover+curves (free loops)", face, free, strict_provenance=False, loops_fixed=False)
    print(f"free loops: {n} quads, min SJ {sj:.3f}, min angle {ang:.1f}, irregular "
          f"{100 * free['report']['irregular_share']:.1f}%, {t_free:.0f} ms")
    # Fixed loops: the nodes from the first run (now including the curve ends).
    fixed_face = {"loops": [dict(role=l["role"], points=[free["nodes"][b["node"]] for b in free["boundary_nodes"] if b["loop"] == li])
                            if l["role"] != "curve" else l for li, l in enumerate(face["loops"])]}
    out = m.mesh(with_runs(True, free), target_size=size)
    n, sj, ang = check("rover+curves (fixed loops)", fixed_face, out, strict_provenance=False)
    print(f"fixed loops: {n} quads, min SJ {sj:.3f}, min angle {ang:.1f}, irregular "
          f"{100 * out['report']['irregular_share']:.1f}%")
    if len(sys.argv) > 3:
        # Save the fixed face in the curves JSON format (every loop fixed, points = nodes).
        doc = {"description": "rover_chassis_face1 with four brace-like curves (stand-in for rover_floor)",
               "target_size": size, "elements_per_circle": 12,
               "loops": [{"role": l["role"], "points": [list(p) for p in l["points"]]} for l in fixed_face["loops"]]}
        with open(sys.argv[3], "w") as f:
            json.dump(doc, f)
    again = m.mesh(with_runs(True, free), target_size=size)
    assert again["nodes"] == out["nodes"] and again["quads"] == out["quads"], "not deterministic"
    print("deterministic: yes")


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 5.0)  # [out.json]
