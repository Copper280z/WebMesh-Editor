"""Results recorded from the original Gmsh-based kernel, which the OpenCASCADE kernel must reproduce.

Import counts and areas for every example file, a set of preparation operations
(split, slice, defeature, passages, project, fuse, midsurface, join) and shell
meshes where the face mesher is stable. Entities are chosen by geometry, so the
numbers do not depend on how a kernel numbers its entities.
"""

import os
from pathlib import Path
import shutil
import tempfile
import unittest

import cad_kernel
import quadmesh_bridge

ROOT = Path(__file__).resolve().parents[1]

# faces, edges, vertices, volumes, total face area, volume
IMPORTS = {
    'examples/balancer_chassis.step': (148, 442, 288, 1, 35186.3780, 86384.9590),
    'examples/block.step': (6, 12, 8, 1, 18400.0000, 120000.0000),
    'examples/l-bracket.step': (10, 24, 16, 1, 14084.3053, 54537.8763),
    'examples/plate-hole.step': (11, 27, 18, 1, 10456.9911, 29486.7259),
    'examples/rover_chassis.step': (175, 498, 321, 1, 146374.8107, 343819.6073),
    'examples/shells/bent_bracket.step': (14, 36, 24, 1, 15048.5397, 20870.5750),
    'examples/shells/bent_bracket_holes.step': (18, 48, 32, 1, 15023.4070, 20465.3096),
    'examples/shells/round_tube_35x4.step': (4, 6, 4, 1, 29995.9267, 58433.6234),
    'examples/shells/round_tube_35x4_holes.step': (8, 22, 14, 1, 29798.2258, 56928.4425),
    'examples/shells/round_tube_75x10.step': (4, 6, 4, 1, 85765.4794, 408407.0450),
    'examples/shells/round_tube_75x10_holes.step': (8, 22, 14, 1, 85284.9522, 391097.3175),
    'examples/shells/square_tube_35x4.step': (18, 48, 32, 1, 35019.3264, 68219.4671),
    'examples/shells/square_tube_35x4_holes.step': (22, 60, 40, 1, 34816.6230, 66740.8922),
    'examples/shells/square_tube_75x10.step': (18, 48, 32, 1, 98384.0674, 468495.5592),
    'examples/shells/square_tube_75x10_holes.step': (22, 60, 40, 1, 97863.9375, 451522.1232),
    'examples/wheel.step': (49, 110, 64, 1, 8744.8114, 8638.7672),
    'flexure.step': (77, 228, 154, 1, 9364.8591, 13637.8575),
    'long corner bracket.step': (49, 144, 95, 1, 18183.4285, 45605.5102),
}

# faces, edges, vertices, volumes, volume, area, free faces, sheets, mapped solids
OPERATIONS = {
    'split': (36, 54, 27, 8, 120000.0, 27600.0, 0, 0, 8),
    'oblique': (11, 20, 12, 2, 120000.0, 20134.81988, 0, 0, 2),
    'ring': (21, 36, 20, 4, 120000.0, 20228.31853, 0, 0, 1),
    'passage': (24, 44, 24, 4, 116400.0, 23528.0, 0, 0, 2),
    'fuse': (11, 20, 12, 2, 120000.0, 19600.0, 0, 0, 2),
    'hole': (10, 24, 16, 1, 29712.92055, 10362.74334, 0, 0, 0),
    'through the hole': (19, 43, 26, 2, 29486.72588, 10728.99112, 0, 0, 0),
    'fillet': (18, 38, 22, 2, 54460.6196, 15391.94689, 0, 0, 0),
    'flexure': (128, 295, 174, 12, 13904.59678, 9876.67817, 0, 0, 0),
    'bracket': (100, 212, 126, 10, 46993.12169, 20263.95581, 0, 0, 0),
    'tube': (5, 9, 6, 1, 58433.62336, 44643.53453, 1, 1, 0),
    'bent': (20, 60, 44, 1, 20465.30959, 20910.30962, 2, 2, 0),
    'square': (20, 56, 40, 1, 68219.46711, 40719.32645, 2, 2, 0),
    'balancer': (166, 470, 300, 3, 86384.95896, 35503.37803, 0, 0, 0),
    'rover': (175, 483, 306, 1, 343819.61302, 146374.81067, 0, 0, 0),
}

# size, elements, nodes, minimum scaled Jacobian, free edges, failed faces
SHELLS = {
    ('examples/block.step', 'recombined'): (4.5, 1024, 1026, 0.6767, 0, 0),
    ('examples/block.step', 'paved'): (4.5, 1014, 1016, 1.0, 0, 0),
    ('examples/l-bracket.step', 'recombined'): (3.6, 1444, 1444, 0.6659, 0, 0),
    ('examples/l-bracket.step', 'paved'): (3.6, 1218, 1218, 0.5727, 0, 0),
    ('examples/plate-hole.step', 'recombined'): (3.6, 1336, 1328, 0.6691, 0, 0),
    ('examples/shells/bent_bracket.step', 'recombined'): (4.3, 1076, 1078, 0.5786, 0, 0),
    ('examples/shells/bent_bracket.step', 'paved'): (4.3, 914, 916, 0.6139, 0, 0),
    ('examples/shells/bent_bracket_holes.step', 'recombined'): (4.3, 1500, 1494, 0.5786, 0, 0),
    ('examples/shells/round_tube_35x4.step', 'recombined'): (6.8, 664, 664, 0.4763, 0, 0),
    ('examples/shells/round_tube_35x4.step', 'paved'): (6.8, 744, 744, 0.3278, 0, 0),
    ('examples/shells/round_tube_35x4_holes.step', 'recombined'): (6.8, 1190, 1182, 0.4763, 0, 0),
    ('examples/shells/round_tube_35x4_holes.step', 'paved'): (6.8, 892, 884, 0.3278, 0, 0),
    ('examples/shells/round_tube_75x10.step', 'recombined'): (9.1, 1192, 1192, 0.6514, 0, 0),
    ('examples/shells/round_tube_75x10.step', 'paved'): (9.1, 1058, 1058, 0.2393, 0, 0),
    ('examples/shells/square_tube_35x4.step', 'recombined'): (6.8, 1312, 1312, 0.5145, 0, 0),
    ('examples/shells/square_tube_35x4.step', 'paved'): (6.8, 912, 912, 0.5827, 0, 0),
    ('examples/shells/square_tube_35x4_holes.step', 'recombined'): (6.8, 1640, 1632, 0.5145, 0, 0),
    ('examples/shells/square_tube_35x4_holes.step', 'paved'): (6.8, 1068, 1060, 0.4499, 0, 0),
    ('examples/shells/square_tube_75x10.step', 'recombined'): (9.1, 1360, 1360, 0.6656, 0, 0),
    ('examples/shells/square_tube_75x10.step', 'paved'): (9.1, 1369, 1369, 0.6514, 0, 0),
    ('examples/shells/square_tube_75x10_holes.step', 'recombined'): (9.1, 1604, 1596, 0.6302, 0, 0),
    ('examples/shells/square_tube_75x10_holes.step', 'paved'): (9.1, 1475, 1467, 0.1787, 0, 0),
    ('examples/wheel.step', 'recombined'): (2.9, 3538, 3526, 0.0317, 0, 0),
    ('flexure.step', 'recombined'): (2.4, 4872, 4846, 0.0624, 0, 0),
    ('long corner bracket.step', 'recombined'): (4.5, 2706, 2690, 0.119, 0, 0),
}


class Kernel:
    """Runs kernel requests in a scratch folder; every step reads the BREP the last one wrote."""

    def __init__(self, test):
        self.folder = Path(tempfile.mkdtemp())
        test.addCleanup(shutil.rmtree, self.folder, True)
        self.count = 0

    def run(self, request, source):
        self.count += 1
        output = self.folder / f"s{self.count}.brep"
        previous = os.getcwd()
        os.chdir(self.folder)
        try:
            return cad_kernel.execute({**request, "input": str(source), "output": str(output)})["topology"], output
        finally:
            os.chdir(previous)

    def step(self, topology, source, operation):
        return self.run({"action": "prepare", "operation": operation, "sheets": topology["sheets"]}, source)


def summary(t):
    return (len(t["faces"]), len(t["edges"]), len(t["vertices"]), len(t["volumes"]), t["volume"], sum(f["area"] for f in t["faces"]),
            sum(1 for f in t["faces"] if not f["volumes"]), len(t["sheets"]), sum(1 for v in t["volumes"] if v["mapped"]))


def centre(t):
    b = t["bounds"]
    return [(b[i] + b[i + 3]) / 2 for i in range(3)]


def planes(t, axis):
    return [f for f in t["faces"] if f.get("surface", {}).get("kind") == "plane" and abs(abs(f["surface"]["normal"][axis]) - 1) < 1e-9]


@unittest.skipUnless(cad_kernel.available(), "the CAD geometry kernel is not available")
class ParityTests(unittest.TestCase):
    def check(self, got, expected, label):
        self.assertEqual(got[:4], expected[:4], label)
        for index in range(4, 6):
            self.assertAlmostEqual(got[index], expected[index], delta=1e-5 * max(1.0, abs(expected[index])), msg=label)
        self.assertEqual(got[6:], expected[6:], label)

    def test_every_example_imports_with_the_recorded_counts_areas_and_volumes(self):
        kernel = Kernel(self)
        for name, (faces, edges, vertices, volumes, area, volume) in IMPORTS.items():
            with self.subTest(name):
                t, _ = kernel.run({"action": "import"}, ROOT / name)
                self.assertEqual((len(t["faces"]), len(t["edges"]), len(t["vertices"]), len(t["volumes"])), (faces, edges, vertices, volumes))
                self.assertAlmostEqual(sum(f["area"] for f in t["faces"]), area, delta=1e-5 * area)
                self.assertAlmostEqual(t["volume"], volume, delta=1e-6 * volume)

    def test_block_operations(self):
        k = Kernel(self)
        t, s = k.run({"action": "import"}, ROOT / "examples/block.step")
        c = centre(t)
        for axis, index in (("x", 0), ("y", 1), ("z", 2)):
            t, s = k.step(t, s, {"kind": "split", "axis": axis, "position": c[index]})
        self.check(summary(t), OPERATIONS["split"], "split x, y, z")
        t, s = k.run({"action": "import"}, ROOT / "examples/block.step")
        t, s = k.step(t, s, {"kind": "slice", "planes": [{"origin": c, "normal": [1, 1, 0.3]}]})
        self.check(summary(t), OPERATIONS["oblique"], "oblique slice")
        t, s = k.run({"action": "import"}, ROOT / "examples/block.step")
        t, s = k.step(t, s, {"kind": "slice", "cylinders": [{"origin": c, "axis": [0, 0, 1], "radius": 5}],
                             "rays": [{"origin": c, "axis": [0, 0, 1], "direction": [0, 1, 0], "length": 200},
                                      {"origin": c, "axis": [0, 0, 1], "direction": [0, -1, 0], "length": 200}]})
        self.check(summary(t), OPERATIONS["ring"], "ring")
        t, s = k.run({"action": "import"}, ROOT / "examples/block.step")
        b = t["bounds"]
        t, s = k.step(t, s, {"kind": "passage", "axis": "x", "center": c, "width": 6, "height": 6, "range": [b[0] - 1, b[3] + 1]})
        floors = [f["id"] for f in planes(t, 2) if f["surface"]["normal"][2] > 0 and b[2] + 1e-5 < f["center"][2] < b[5] - 1e-5]
        t, s = k.step(t, s, {"kind": "project", "axis": "z", "faceIds": floors})
        self.check(summary(t), OPERATIONS["passage"], "passage and project")
        t, s = k.run({"action": "import"}, ROOT / "examples/block.step")
        thirds = [b[0] + (b[3] - b[0]) * n / 3 for n in (1, 2)]
        t, s = k.step(t, s, {"kind": "slice", "planes": [{"origin": [x, 0, 0], "normal": [1, 0, 0]} for x in thirds]})
        ordered = sorted(t["volumes"], key=lambda v: v["bounds"][0])
        t, s = k.step(t, s, {"kind": "fuse", "volumeIds": [ordered[0]["id"], ordered[1]["id"]]})
        self.check(summary(t), OPERATIONS["fuse"], "fuse")

    def test_defeaturing_and_slicing_the_small_parts(self):
        k = Kernel(self)
        t, s = k.run({"action": "import"}, ROOT / "examples/plate-hole.step")
        t2, _ = k.step(t, s, {"kind": "defeature", "faceIds": [t["features"][0]["faceId"]]})
        self.check(summary(t2), OPERATIONS["hole"], "defeatured hole")
        t2, _ = k.step(t, s, {"kind": "slice", "planes": [{"origin": centre(t), "normal": [1, 0, 0]}]})
        self.check(summary(t2), OPERATIONS["through the hole"], "slice through the hole")
        t, s = k.run({"action": "import"}, ROOT / "examples/l-bracket.step")
        faces = sorted((f for f in t["faces"] if f["type"] != "Plane"), key=lambda f: f["id"])
        t, s = k.step(t, s, {"kind": "defeature", "faceIds": [faces[0]["id"] if faces else 3]})
        t, s = k.step(t, s, {"kind": "slice", "planes": [{"origin": centre(t), "normal": [0, 1, 0]}]})
        self.check(summary(t), OPERATIONS["fillet"], "defeatured fillet and slice")

    def test_flexure_bracket_and_large_parts(self):
        k = Kernel(self)
        t, s = k.run({"action": "import"}, ROOT / "flexure.step")
        t, s = k.step(t, s, {"kind": "defeature", "faceIds": [3, 8, 13, 14, 19, 20, 71, 75, 76, 77]})
        for axis, position in (("x", -5.5), ("x", 5.5), ("z", 5.5)):
            t, s = k.step(t, s, {"kind": "split", "axis": axis, "position": position})
        self.check(summary(t), OPERATIONS["flexure"], "flexure")
        t, s = k.run({"action": "import"}, ROOT / "long corner bracket.step")
        curved = [f["id"] for f in t["faces"] if f["type"] != "Plane"]
        passages = ([{"axis": "x", "center": [0, y, 10], "width": 6, "height": 6, "range": [6, 76]} for y in (30, 55, 80)]
                    + [{"axis": "y", "center": [x, 0, 10], "width": 6, "height": 6, "range": [6, 101]} for x in (54, 35.5, 17)])
        t, s = k.step(t, s, {"kind": "passages", "faceIds": curved, "passages": passages})
        b = t["bounds"]
        ledges = [f["id"] for f in t["faces"] if f["type"] == "Plane" and f["bounds"][5] - f["bounds"][2] < 1e-5
                  and b[2] + 1e-5 < f["center"][2] < b[5] - 1e-5 and f.get("normal", [0, 0, 0])[2] > 0]
        t, s = k.step(t, s, {"kind": "project", "axis": "z", "faceIds": ledges})
        self.check(summary(t), OPERATIONS["bracket"], "corner bracket")
        t, s = k.run({"action": "import"}, ROOT / "examples/balancer_chassis.step")
        t, s = k.step(t, s, {"kind": "split", "axis": "x", "position": centre(t)[0]})
        self.check(summary(t), OPERATIONS["balancer"], "balancer chassis")
        t, s = k.run({"action": "import"}, ROOT / "examples/rover_chassis.step")
        t, s = k.step(t, s, {"kind": "slice", "planes": [{"origin": centre(t), "normal": [1, 0, 0]}]})
        t, s = k.step(t, s, {"kind": "fuse", "volumeIds": [v["id"] for v in t["volumes"]]})
        self.check(summary(t), OPERATIONS["rover"], "rover")

    def test_midsurfaces_joins_and_offsets_of_sheet_models(self):
        k = Kernel(self)
        t, s = k.run({"action": "import"}, ROOT / "examples/shells/round_tube_35x4.step")
        cylinders = sorted((f for f in t["faces"] if f.get("surface", {}).get("kind") == "cylinder"), key=lambda f: f["surface"]["radius"])
        t, s = k.step(t, s, {"kind": "surface", "faces": [cylinders[0]["id"], cylinders[-1]["id"]]})
        self.check(summary(t), OPERATIONS["tube"], "tube midsurface")
        t, s = k.run({"action": "import"}, ROOT / "examples/shells/bent_bracket_holes.step")
        flat = sorted(planes(t, 2), key=lambda f: -f["area"])
        a = flat[0]
        other = next(f for f in flat if f["id"] != a["id"] and abs(f["surface"]["normal"][2] - a["surface"]["normal"][2]) < 1e-9 and abs(f["center"][2] - a["center"][2]) > 1)
        t, s = k.step(t, s, {"kind": "surface", "faces": [a["id"], other["id"]]})
        t, s = k.step(t, s, {"kind": "surface", "faces": [flat[1]["id"]], "offset": 1.0, "thickness": 3})
        self.check(summary(t), OPERATIONS["bent"], "bent bracket")
        t, s = k.run({"action": "import"}, ROOT / "examples/shells/square_tube_35x4.step")
        walls = sorted((f for f in planes(t, 0) if f["center"][0] > 0), key=lambda f: f["center"][0])
        t, s = k.step(t, s, {"kind": "surface", "faces": [walls[0]["id"], walls[-1]["id"]]})
        floors = sorted((f for f in planes(t, 1) if f["center"][1] > 0), key=lambda f: f["center"][1])
        t, s = k.step(t, s, {"kind": "surface", "faces": [floors[0]["id"], floors[-1]["id"]]})
        t, s = k.step(t, s, {"kind": "join"})
        self.check(summary(t), OPERATIONS["square"], "square tube sheets")

    def test_shell_meshes_match_the_recorded_counts_and_quality(self):
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder, True)
        previous = os.getcwd()
        os.chdir(folder)
        self.addCleanup(os.chdir, previous)
        for (name, mesher), (size, elements, nodes, quality, free, failed) in SHELLS.items():
            if not quadmesh_bridge.available(mesher):
                continue
            with self.subTest(f"{name} {mesher}"):
                q = cad_kernel.execute({"action": "shell", "input": str(ROOT / name), "output": None, "size": size, "mesher": mesher})["quality"]
                self.assertEqual((q["elements"], q["nodes"], q["freeEdges"], len(q["failedFaces"])), (elements, nodes, free, failed))
                self.assertAlmostEqual(q["minScaledJacobian"], quality, delta=2e-3)


if __name__ == "__main__":
    unittest.main()
