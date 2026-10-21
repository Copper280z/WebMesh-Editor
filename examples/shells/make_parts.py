"""Generate the shell-meshing test parts in this folder as STEP files.

Round and square tubes (35 mm with 4 mm walls, 75 mm with 10 mm walls) and a
Z-bent sheet-metal bracket (3 mm sheet, 3 mm inner bend radius), each with and
without holes. Run: python3 examples/shells/make_parts.py
"""
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
import cad_kernel  # noqa: E402

gmsh = cad_kernel.geometry_module()


def write(name, build):
    gmsh.initialize(["shell-parts", "-nopopup"], readConfigFiles=False)
    gmsh.option.setNumber("General.Terminal", 0)
    gmsh.model.add(name)
    build(gmsh.model.occ)
    gmsh.model.occ.synchronize()
    if len(gmsh.model.getEntities(3)) != 1:
        raise SystemExit(f"{name}: expected one solid, got {len(gmsh.model.getEntities(3))}")
    gmsh.write(str(HERE / f"{name}.step"))
    gmsh.finalize()
    print("wrote", name)


def round_tube(diameter, wall, length, holes):
    def build(occ):
        outer = occ.addCylinder(0, 0, 0, length, 0, 0, diameter / 2)
        inner = occ.addCylinder(-1, 0, 0, length + 2, 0, 0, diameter / 2 - wall)
        body, _ = occ.cut([(3, outer)], [(3, inner)])
        if holes:
            # Two radial holes through the +y wall and one cross hole through both walls.
            d = diameter
            tools = [occ.addCylinder(x, 0, 0, 0, d, 0, h / 2) for x, h in ((0.3 * length, 0.25 * d), (0.6 * length, 0.25 * d))]
            tools.append(occ.addCylinder(0.85 * length, 0, -d, 0, 0, 2 * d, 0.18 * d))
            occ.cut(body, [(3, t) for t in tools])
    return build


def square_tube(width, wall, length, holes):
    def build(occ):
        # Rounded corners as in formed tube: outer radius 2t, inner radius t.
        outer = occ.addRectangle(-width / 2, -width / 2, 0, width, width, roundedRadius=2 * wall)
        inner = occ.addRectangle(-width / 2 + wall, -width / 2 + wall, 0, width - 2 * wall, width - 2 * wall, roundedRadius=wall)
        section, _ = occ.cut([(2, outer)], [(2, inner)])
        body = [e for e in occ.extrude(section, 0, 0, length) if e[0] == 3]
        if holes:
            d = width
            tools = [occ.addCylinder(0, 0, z, d, 0, 0, h / 2) for z, h in ((0.3 * length, 0.25 * d), (0.6 * length, 0.25 * d))]
            tools.append(occ.addCylinder(0, -d, 0.85 * length, 0, 2 * d, 0, 0.18 * d))
            occ.cut(body, [(3, t) for t in tools])
    return build


def bracket(holes, t=3.0, r=3.0, width=50.0, base=60.0, rise=40.0, top=25.0):
    """A Z-bent bracket: base flange, bend up, vertical flange, bend out, top flange."""
    def build(occ):
        R = r + t
        parts = [occ.addBox(0, 0, 0, base, width, t)]
        # Bend 1 about (base, R): inner radius r, outer R, the quadrant x >= base, z <= R.
        ring = occ.cut([(3, occ.addCylinder(base, 0, R, 0, width, 0, R))], [(3, occ.addCylinder(base, -1, R, 0, width + 2, 0, r))])[0]
        bend1 = occ.intersect(ring, [(3, occ.addBox(base, -1, 0, R, width + 2, R))])[0]
        x1 = base + r  # the vertical flange spans x in [x1, x1 + t]
        parts.append(occ.addBox(x1, 0, R, t, width, rise))
        z2 = R + rise
        # Bend 2 about (x1 + t + r, z2): outward, the quadrant x <= center, z >= z2.
        cx = x1 + t + r
        ring = occ.cut([(3, occ.addCylinder(cx, 0, z2, 0, width, 0, R))], [(3, occ.addCylinder(cx, -1, z2, 0, width + 2, 0, r))])[0]
        bend2 = occ.intersect(ring, [(3, occ.addBox(cx - R, -1, z2, R, width + 2, R))])[0]
        parts.append(occ.addBox(cx, 0, z2 + r, top, width, t))
        body, _ = occ.fuse([(3, parts[0])], [(3, p) for p in parts[1:]] + bend1 + bend2)
        if holes:
            tools = [occ.addCylinder(0.35 * base, y, -1, 0, 0, t + 2, 3) for y in (0.3 * width, 0.7 * width)]
            tools.append(occ.addCylinder(x1 - 1, 0.5 * width, R + 0.55 * rise, t + 2, 0, 0, 4))
            tools.append(occ.addCylinder(cx + 0.6 * top, 0.5 * width, z2 + r - 1, 0, 0, t + 2, 3))
            occ.cut(body, [(3, tool) for tool in tools])
    return build


if __name__ == "__main__":
    for holes in (False, True):
        suffix = "_holes" if holes else ""
        write(f"round_tube_35x4{suffix}", round_tube(35, 4, 150, holes))
        write(f"round_tube_75x10{suffix}", round_tube(75, 10, 200, holes))
        write(f"square_tube_35x4{suffix}", square_tube(35, 4, 150, holes))
        write(f"square_tube_75x10{suffix}", square_tube(75, 10, 200, holes))
        write(f"bent_bracket{suffix}", bracket(holes))
