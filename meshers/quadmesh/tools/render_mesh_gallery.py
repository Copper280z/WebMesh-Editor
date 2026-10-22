"""Render actual mesher results. Requires matplotlib only for plotting.

Usage: python3 tools/render_mesh_gallery.py path/to/shared-library [output-dir]
"""
from pathlib import Path
import argparse
import importlib.util
import json
import math
import os
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("library", type=Path)
parser.add_argument("output", nargs="?", type=Path, default=Path("build/mesh-previews"))
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(args.output.resolve() / ".matplotlib"))

import matplotlib
matplotlib.use("Agg")
from matplotlib import pyplot as plt
from matplotlib.collections import PolyCollection, LineCollection

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("quadmesh", root / "bindings/python/quadmesh.py")
binding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(binding)
mesher = binding.Mesher(args.library.resolve())


def read_loops(path):
    tokens = iter(path.read_text().split())
    loops = []
    for i in range(int(next(tokens))):
        points = [(float(next(tokens)), float(next(tokens))) for _ in range(int(next(tokens)))]
        loops.append({"points": points, "role": "outer" if i == 0 else "hole"})
    return loops


def circle(cx, cy, radius, count):
    return [(cx + radius * math.cos(2 * math.pi * k / count),
             cy + radius * math.sin(2 * math.pi * k / count)) for k in range(count)]


def rectangle(width, height, spacing):
    return ([(k, 0) for k in range(0, width, spacing)]
            + [(width, k) for k in range(0, height, spacing)]
            + [(k, height) for k in range(width, 0, -spacing)]
            + [(0, k) for k in range(height, 0, -spacing)])


cases = []
for name in ("rover_chassis_face1", "rover_chassis_face2", "rover_chassis_face61",
             "wheel_top", "balancer_chassis_face17", "balancer_chassis_face19",
             "balancer_chassis_face21"):
    cases.append((name, read_loops(root / "tests/fixtures/cad_faces" / f"{name}.txt"),
                  dict(target_size=4, finite_element_sizing=True, enable_smoothing=True), None))

outer, hole = rectangle(40, 20, 2), circle(20, 10, 5, 16)
fixed = [{"points": points, "role": role, "fixed_runs": [{"nodes": points, "closed": True}]}
         for points, role in ((outer, "outer"), (hole, "hole"))]
cases.append(("fixed_boundary_plate", fixed, dict(target_size=2, enable_smoothing=True),
              "76 prescribed boundary nodes"))
cases.append(("small_hole_plate",
              [{"points": rectangle(60, 40, 20)},
               {"points": circle(30, 20, 1.5, 256), "role": "hole"}],
              dict(target_size=4, finite_element_sizing=True, enable_smoothing=True),
              "12 nodes around the Ø3 hole"))

results = []
for name, loops, options, note in cases:
    start = time.perf_counter()
    result = mesher.mesh(loops, **options)
    elapsed = (time.perf_counter() - start) * 1000
    assert result["valid"], (name, result["issues"])
    assert result["summary"]["min_angle"] >= 20, name
    assert result["summary"]["min_scaled_jacobian"] >= .3, name
    if name == "fixed_boundary_plate":
        assert len(result["boundary_nodes"]) == 76
    if name == "small_hole_plate":
        assert sum(n["loop"] == 1 for n in result["boundary_nodes"]) == 12
    results.append((name, result, note))
    (args.output / f"{name}.json").write_text(json.dumps(result))
    print(f"{name}: {len(result['quads'])} quads; "
          f"angle {result['summary']['min_angle']:.2f}°; "
          f"SJ {result['summary']['min_scaled_jacobian']:.3f}; {elapsed:.1f} ms", flush=True)


def draw(ax, case, rotate=False):
    name, result, note = case
    nodes, quads = result["nodes"], result["quads"]
    if rotate:
        nodes = [(-y, x) for x, y in nodes]
    ax.add_collection(PolyCollection(
        [[nodes[n] for n in q] for q in quads],
        facecolors="#e0edf4", edgecolors="#34566e", linewidths=.35,
        antialiaseds=True))
    boundary_edges = {tuple(sorted((e["node_a"], e["node_b"]))) for e in result["boundary_edges"]}
    ax.add_collection(LineCollection(
        [[nodes[a], nodes[b]] for a, b in sorted(boundary_edges)],
        colors="#123d58", linewidths=.8))
    if note:
        highlighted = {s["node"] for s in result["boundary_nodes"]
                       if name == "fixed_boundary_plate" or s["loop"] == 1}
        ax.scatter([nodes[i][0] for i in sorted(highlighted)],
                   [nodes[i][1] for i in sorted(highlighted)],
                   s=9, c="#d45226", edgecolors="white", linewidths=.2, zorder=4)
    ax.autoscale()
    ax.margins(.035)
    ax.set_aspect("equal")
    ax.axis("off")
    title = name.replace("_", " ").replace("face", "face ")
    if rotate:
        title += " (rotated view)"
    if note:
        title = f"{title}\n{note}"
    ax.set_title(title, fontsize=12, fontweight="bold", color="#17364a", pad=13)
    quality = result["summary"]
    ax.text(.5, -.045,
            f"{len(quads):,} quads  ·  min angle {quality['min_angle']:.1f}°"
            f"  ·  min scaled Jacobian {quality['min_scaled_jacobian']:.3f}",
            transform=ax.transAxes, ha="center", va="top", fontsize=9, color="#365568")


for case in results:
    fig, ax = plt.subplots(figsize=(10, 7), layout="constrained")
    draw(ax, case)
    fig.savefig(args.output / f"{case[0]}.png", dpi=190, facecolor="white")
    plt.close(fig)

for filename, selected, rows, columns, size in (
        ("cad-components.png", results[3:7], 2, 2, (13, 10)),
        ("boundary-examples.png", results[7:], 1, 2, (14, 6))):
    fig, axes = plt.subplots(rows, columns, figsize=size, squeeze=False)
    for ax, case in zip(axes.flat, selected):
        draw(ax, case)
    fig.subplots_adjust(left=.04, right=.96, top=.93, bottom=.09, hspace=.35, wspace=.15)
    fig.savefig(args.output / filename, dpi=180, facecolor="white")
    plt.close(fig)

fig = plt.figure(figsize=(13, 10))
grid = fig.add_gridspec(2, 2, height_ratios=[1, .7])
draw(fig.add_subplot(grid[0, 0]), results[0])
draw(fig.add_subplot(grid[0, 1]), results[1])
draw(fig.add_subplot(grid[1, :]), results[2], rotate=True)
fig.subplots_adjust(left=.05, right=.95, top=.93, bottom=.08, hspace=.5, wspace=.2)
fig.savefig(args.output / "cad-chassis.png", dpi=180, facecolor="white")
plt.close(fig)

(args.output / "metrics.json").write_text(json.dumps([
    dict(name=name, quads=len(result["quads"]), nodes=len(result["nodes"]),
         boundary_nodes=len(result["boundary_nodes"]), **result["summary"])
    for name, result, _ in results], indent=2))
