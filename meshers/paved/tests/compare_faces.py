"""Mesh the seven test faces with a quadmesh-ABI library and report the README metrics.

    python3 -I tests/compare_faces.py LIB [size] [key=value ...]

Works with libquadmesh_paved and with the quadtree mesher's C API library, so both are
measured with the same metric definitions: quads, minimum angle, minimum and
5th-percentile scaled Jacobian, share of interior nodes not shared by exactly four
quads, validity, and wall time per face (best of three).
"""
import math
import os
import sys
import time

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bindings", "python"))
from quadmesh_paved import Mesher, MeshError  # noqa: E402

FACES = ["wheel_top", "rover_chassis_face1", "rover_chassis_face2", "rover_chassis_face61",
         "balancer_chassis_face17", "balancer_chassis_face19", "balancer_chassis_face21"]


def read_face(path):
    tok = open(path).read().split()
    i = 1
    loops = []
    for li in range(int(tok[0])):
        n = int(tok[i]); i += 1
        pts = [(float(tok[i + 2 * k]), float(tok[i + 2 * k + 1])) for k in range(n)]
        i += 2 * n
        loops.append({"points": pts, "role": "outer" if li == 0 else "hole"})
    return loops


def metrics(out):
    nodes, quads = out["nodes"], out["quads"]
    use = {}
    val = [0] * len(nodes)
    amin, amax, sjs = 360.0, 0.0, []
    for q in quads:
        p = [nodes[v] for v in q]
        sj = 1.0
        for k in range(4):
            val[q[k]] += 1
            a, b = q[k], q[(k + 1) % 4]
            e = (min(a, b), max(a, b))
            use[e] = use.get(e, 0) + 1
            o, n1, n2 = p[k], p[(k + 1) % 4], p[(k + 3) % 4]
            u = (n1[0] - o[0], n1[1] - o[1]); w = (n2[0] - o[0], n2[1] - o[1])
            cr = u[0] * w[1] - u[1] * w[0]; dt = u[0] * w[0] + u[1] * w[1]
            ang = math.degrees(math.atan2(cr, dt)) % 360.0
            amin, amax = min(amin, ang), max(amax, ang)
            lu, lw = math.hypot(*u), math.hypot(*w)
            sj = min(sj, cr / (lu * lw) if lu * lw > 0 else -1)
        sjs.append(sj)
    on_b = set()
    for (a, b), c in use.items():
        if c == 1:
            on_b.add(a); on_b.add(b)
    interior = [v for v in range(len(nodes)) if v not in on_b and val[v] > 0]
    irregular = sum(1 for v in interior if val[v] != 4)
    sjs.sort()
    return {
        "quads": len(quads), "min_angle": amin, "max_angle": amax,
        "min_sj": sjs[0] if sjs else 0, "p5_sj": sjs[int(0.05 * len(sjs))] if sjs else 0,
        "irregular": irregular, "interior": len(interior),
        "irregular_share": irregular / len(interior) if interior else 0,
        "valid": out["valid"], "issues": out["issues"],
    }


def main():
    lib = sys.argv[1]
    size = float(sys.argv[2]) if len(sys.argv) > 2 else 4.0
    opts = {"target_size": size}
    for kv in sys.argv[3:]:
        k, v = kv.split("=")
        opts[k] = float(v)
    m = Mesher(lib)
    faces_dir = os.path.join(HERE, "..", "faces")
    print(f"library {os.path.basename(lib)}, options {opts}")
    print("| Face | Quads | Min angle | Min SJ | p5 SJ | Irregular | Valid | Time (ms) |")
    print("|---|---|---|---|---|---|---|---|")
    for name in FACES:
        loops = read_face(os.path.join(faces_dir, name + ".txt"))
        best = None
        out = None
        try:
            for _ in range(3):
                t0 = time.perf_counter()
                out = m.mesh(loops, **opts)
                dt = 1000 * (time.perf_counter() - t0)
                best = dt if best is None else min(best, dt)
        except MeshError as e:
            print(f"| {name} | error: {e} |")
            continue
        r = metrics(out)
        print(f"| {name} | {r['quads']:,} | {r['min_angle']:.1f} | {r['min_sj']:.3f} | {r['p5_sj']:.3f} | "
              f"{100 * r['irregular_share']:.1f}% ({r['irregular']}/{r['interior']}) | "
              f"{'yes' if r['valid'] else 'no: ' + '; '.join(r['issues'][:2])} | {best:.0f} |")


if __name__ == "__main__":
    main()
