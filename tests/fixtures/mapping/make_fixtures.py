#!/usr/bin/env python3
"""Regenerate the mapped-meshing topology fixtures from real OpenCASCADE geometry.

Run from the repository root:  python3 tests/fixtures/mapping/make_fixtures.py
Display tessellation is dropped except for faces without an analytic surface.
"""

import json
import math
from pathlib import Path
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(ROOT))
import cad_kernel  # noqa: E402

gmsh = cad_kernel.gmsh_module()


def remove_loose(occ):
    occ.synchronize()
    for dimension in (2, 1, 0):
        loose = [e for e in gmsh.model.getEntities(dimension) if not len(gmsh.model.getAdjacencies(*e)[0])]
        if loose:
            occ.remove(loose, recursive=True)
            occ.synchronize()


def plane(occ, points):
    tags = [occ.addPoint(*p) for p in points]
    return occ.addPlaneSurface([occ.addCurveLoop([occ.addLine(tags[i], tags[(i + 1) % 4]) for i in range(4)])])


def box(occ):
    occ.addBox(0, 0, 0, 10, 6, 4)


def split_box(occ):
    a, c = occ.addBox(0, 0, 0, 4, 6, 4), occ.addBox(4, 0, 0, 6, 6, 4)
    occ.fragment([(3, a)], [(3, c)])


def t_junction(occ):
    # A long block under two short ones: the shared top face carries T vertices.
    a, b, c = occ.addBox(0, 0, 0, 10, 6, 2), occ.addBox(0, 0, 2, 4, 6, 3), occ.addBox(4, 0, 2, 6, 6, 3)
    occ.fragment([(3, a)], [(3, b), (3, c)])


def l_shape(occ):
    a, b = occ.addBox(0, 0, 0, 10, 10, 4), occ.addBox(5, 5, -1, 10, 10, 6)
    occ.cut([(3, a)], [(3, b)])


def l_split(occ):
    l_shape(occ)
    occ.synchronize()
    occ.fragment(occ.getEntities(3), [(2, plane(occ, [(5, -5, -5), (5, 15, -5), (5, 15, 10), (5, -5, 10)]))])
    remove_loose(occ)


def plate_hole(occ):
    a, h = occ.addBox(0, 0, 0, 20, 20, 4), occ.addCylinder(10, 10, -1, 0, 0, 6, 3)
    occ.cut([(3, a)], [(3, h)])


def plate_hole_radial(occ):
    plate_hole(occ)
    occ.synchronize()
    tools = []
    for angle in (0, 45, 90, 135):
        t = math.radians(angle)
        u = (math.cos(t), math.sin(t))
        tools.append((2, plane(occ, [(10 + s * 30 * u[0], 10 + s * 30 * u[1], z) for s, z in ((-1, -5), (1, -5), (1, 9), (-1, 9))])))
    occ.fragment(occ.getEntities(3), tools)
    remove_loose(occ)


def quarter_annulus(occ):
    o, i = occ.addCylinder(0, 0, 0, 0, 0, 5, 10), occ.addCylinder(0, 0, -1, 0, 0, 7, 6)
    occ.cut([(3, o)], [(3, i)])
    occ.intersect(occ.getEntities(3), [(3, occ.addBox(0, 0, -1, 20, 20, 7))])


def filleted_block(occ):
    b = occ.addBox(0, 0, 0, 10, 6, 4)
    occ.synchronize()
    occ.fillet([b], [gmsh.model.getEntities(1)[0][1]], [1.0])


def prism(occ, outline, height):
    points = [occ.addPoint(x, y, 0) for x, y in outline]
    lines = [occ.addLine(points[i], points[(i + 1) % len(points)]) for i in range(len(points))]
    face = occ.addPlaneSurface([occ.addCurveLoop(lines)])
    occ.extrude([(2, face)], 0, 0, height)


def obtuse_strip(occ):
    # A quadrilateral wall strip with a 143.5 degree corner (from the corner bracket).
    prism(occ, [(0, 10), (6, 10), (6, 89.9), (0, 98)], 14)


def chamfer_strip(occ):
    # The same strip ending in a chamfer: it maps, but its block is strongly tapered.
    prism(occ, [(0, 10), (4, 6), (6, 6), (6, 89.9), (0, 98)], 14)


def triangle_prism(occ):
    prism(occ, [(6, 6), (67.6, 6), (6, 89.9)], 6)


def holed_wall(occ):
    wall = occ.addBox(0, 0, 0, 6, 90, 20)
    holes = [(3, occ.addCylinder(-1, y, 10, 8, 0, 0, 2.3)) for y in (20, 45, 70)]
    occ.cut([(3, wall)], holes)


def l_footprint(occ):
    # A slab under an L-shaped block: the slab's top carries an L imprint.
    slab = occ.addBox(0, 0, 0, 10, 10, 2)
    leg, foot = occ.addBox(0, 0, 2, 10, 4, 3), occ.addBox(0, 4, 2, 4, 6, 3)
    block, _ = occ.fuse([(3, leg)], [(3, foot)])
    occ.fragment([(3, slab)], block)


def s_prism(occ):
    # Two re-entrant corners that see each other across the cap.
    prism(occ, [(0, 0), (3, 0), (3, 1), (4, 1), (4, 3), (1, 3), (1, 2), (0, 2)], 2)


def twin_obtuse(occ):
    # A wall-end pentagon whose two obtuse corners are exactly equal (parallel long sides).
    prism(occ, [(0, 0), (0, 10), (8, 10 - 32 / 3), (8, -6), (4.5, -6)], 6)


def build(name, make):
    gmsh.initialize(["fixtures", "-nopopup"], readConfigFiles=False)
    gmsh.option.setNumber("General.Terminal", 0)
    make(gmsh.model.occ)
    gmsh.model.occ.synchronize()
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "in.brep"
        gmsh.write(str(source))
        gmsh.finalize()
        result = cad_kernel.execute({"action": "import", "input": str(source), "output": str(Path(directory) / "out.brep")})
    result.pop("log", None)
    kinds = {face["id"]: face["surface"]["kind"] for face in result["topology"]["faces"]}
    preview = result["preview"]
    keep = [i for i, tag in enumerate(preview["triangleFaceIds"]) if kinds.get(tag) == "mesh"]
    preview["positions"] = [preview["positions"][9 * i + k] for i in keep for k in range(9)]
    preview["triangleFaceIds"] = [preview["triangleFaceIds"][i] for i in keep]
    preview.pop("faces", None)

    def trim(value):
        if isinstance(value, float):
            return round(value, 9)
        if isinstance(value, list):
            return [trim(v) for v in value]
        if isinstance(value, dict):
            return {k: trim(v) for k, v in value.items()}
        return value

    (HERE / f"{name}.json").write_text(json.dumps(trim(result), separators=(",", ":")))
    topology = result["topology"]
    print(f"{name}: {len(topology['volumes'])} solids, {len(topology['faces'])} faces")


if __name__ == "__main__":
    # Pass fixture names to rebuild only those.
    wanted = set(sys.argv[1:])
    for name, make in [("box", box), ("split-box", split_box), ("t-junction", t_junction), ("l-shape", l_shape), ("l-split", l_split),
                       ("plate-hole", plate_hole), ("plate-hole-radial", plate_hole_radial), ("quarter-annulus", quarter_annulus),
                       ("filleted-block", filleted_block), ("obtuse-strip", obtuse_strip), ("chamfer-strip", chamfer_strip),
                       ("triangle-prism", triangle_prism), ("holed-wall", holed_wall), ("l-footprint", l_footprint),
                       ("s-prism", s_prism), ("twin-obtuse", twin_obtuse)]:
        if not wanted or name in wanted:
            build(name, make)
