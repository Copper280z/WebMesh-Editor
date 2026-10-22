"""ctypes tests for libquadmesh_paved: python3 -I tests/test_ctypes.py path/to/libquadmesh_paved.dylib"""
import importlib.util
import math
import os
import sys

sys.dont_write_bytecode = True  # never write caches next to other projects' sources
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bindings", "python"))
from quadmesh_paved import Mesher, MeshError  # noqa: E402


def circle(cx, cy, r, n, ccw=True):
    s = 1 if ccw else -1
    return [(cx + r * math.cos(s * 2 * math.pi * i / n), cy + r * math.sin(s * 2 * math.pi * i / n)) for i in range(n)]


def rect_nodes(w, h, step):
    nx, ny = round(w / step), round(h / step)
    pts = [(w * i / nx, 0.0) for i in range(nx)] + [(w, h * i / ny) for i in range(ny)]
    pts += [(w - w * i / nx, h) for i in range(nx)] + [(0.0, h - h * i / ny) for i in range(ny)]
    return pts


def plate_with_hole():
    outer = [(0.0, 0.0), (40.0, 0.0), (40.0, 20.0), (0.0, 20.0)]
    outer_nodes = rect_nodes(40, 20, 2)
    hole = circle(20, 10, 5, 128, ccw=False)
    hole_nodes = circle(20, 10, 5, 16, ccw=False)
    return [
        {"points": outer, "fixed_runs": [{"nodes": outer_nodes, "closed": True}]},
        {"points": hole, "role": "hole", "fixed_runs": [{"nodes": hole_nodes, "closed": True}]},
    ], outer_nodes + hole_nodes


def check_plate(out, fixed):
    assert out["valid"], out["issues"]
    assert out["summary"]["min_scaled_jacobian"] >= 0.3, out["summary"]
    assert out["nodes"][:76] == fixed, "fixed nodes changed"
    assert len(out["boundary_nodes"]) == 76
    assert all(b["fixed_run"] == 0 for b in out["boundary_nodes"])


def main(lib):
    m = Mesher(lib)
    loops, fixed = plate_with_hole()
    out = m.mesh(loops, target_size=2)
    check_plate(out, fixed)
    rep = out["report"]
    assert rep["all_quads"] and rep["conforming"] and rep["fixed_kept"] and rep["inverted"] == 0, rep
    print(f"plate with hole: {len(out['quads'])} quads, min SJ {out['summary']['min_scaled_jacobian']:.3f}, "
          f"irregular {100 * rep['irregular_share']:.1f}%")

    # A diameter-3 hole gets 12 elements at size 4.
    out = m.mesh([{"points": [(0, 0), (60, 0), (60, 40), (0, 40)]},
                  {"points": circle(30, 20, 1.5, 128, ccw=False), "role": "hole"}], target_size=4)
    assert out["valid"], out["issues"]
    assert sum(1 for b in out["boundary_nodes"] if b["loop"] == 1) == 12

    # Odd fixed edge count: unsupported input, clear message.
    try:
        m.mesh([{"points": [(0, 0), (10, 0), (10, 10), (0, 10)],
                 "fixed_runs": [{"nodes": [(0, 0), (10, 0), (10, 10), (5, 10), (0, 10)], "closed": True}]}],
               target_size=2)
        raise AssertionError("odd boundary accepted")
    except MeshError as e:
        assert e.status == 2 and "odd number of fixed boundary edges" in str(e), e

    # Unknown option and bad values are rejected.
    try:
        m.mesh(loops, elements_per_circle=3)
        raise AssertionError("bad option accepted")
    except MeshError as e:
        assert e.status == 1

    # The quadtree mesher's own binding works unchanged with this library.
    other = os.path.expanduser("~/Documents/quadmesh/cpp2/bindings/python/quadmesh.py")
    if os.path.exists(other):
        spec = importlib.util.spec_from_file_location("quadmesh_quadtree_binding", other)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        out = mod.Mesher(lib).mesh(loops, target_size=2)
        check_plate(out, fixed)
        print("quadtree mesher's Python binding: OK with libquadmesh_paved")
    print("ctypes tests passed")


if __name__ == "__main__":
    main(sys.argv[1])
