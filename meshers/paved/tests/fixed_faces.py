"""Re-mesh each test face with every loop given as a closed fixed run (WebMesh's edge-first
use) and check that the boundary nodes are kept exactly and the mesh validates.

    python3 -I tests/fixed_faces.py zig-out/lib/libquadmesh_paved.dylib [size ...]
"""
import os
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "bindings", "python"))
from quadmesh_paved import Mesher  # noqa: E402
from compare_faces import FACES, read_face, metrics  # noqa: E402


def main():
    m = Mesher(sys.argv[1])
    sizes = [float(s) for s in sys.argv[2:]] or [4.0]
    failures = 0
    for size in sizes:
        for name in FACES:
            loops = read_face(os.path.join(HERE, "..", "faces", name + ".txt"))
            first = m.mesh(loops, target_size=size)
            per_loop = {}
            for b in first["boundary_nodes"]:
                per_loop.setdefault(b["loop"], []).append(first["nodes"][b["node"]])
            fixed_loops = []
            for li, loop in enumerate(loops):
                fixed_loops.append(dict(loop, fixed_runs=[{"nodes": per_loop[li], "closed": True}]))
            out = m.mesh(fixed_loops, target_size=size)
            r = metrics(out)
            expected = [p for li in range(len(loops)) for p in per_loop[li]]
            kept = out["nodes"][:len(expected)] == expected
            ok = out["valid"] and kept and out["report"]["fixed_kept"]
            failures += not ok
            print(f"size {size} {name}: {'ok' if ok else 'FAIL'} {r['quads']} quads, min SJ {r['min_sj']:.3f}, "
                  f"irregular {100 * r['irregular_share']:.1f}%, boundary nodes kept {kept}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
