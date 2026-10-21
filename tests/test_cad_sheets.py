"""Sheets: midsurfaces and offset surfaces made from solid faces, extended,
joined into T junctions, kept by solid operations, and shell meshed with their
own thickness and offset."""

from pathlib import Path
import shutil
import tempfile
import unittest

import numpy as np

import quadmesh_bridge
import server

ROOT = Path(__file__).resolve().parents[1]
KERNEL = server.importlib.util.find_spec("gmsh") is not None or any(
    (Path(folder) / "gmsh.py").is_file() for folder in ("/opt/homebrew/opt/gmsh/lib", "/usr/local/opt/gmsh/lib"))


@unittest.skipUnless(KERNEL, "Gmsh/OpenCASCADE kernel is not available")
class SheetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import cad_kernel
        cls.kernel = cad_kernel
        cls.folder = Path(tempfile.mkdtemp())
        gmsh = cad_kernel.gmsh_module()
        gmsh.initialize()
        gmsh.option.setNumber("General.Terminal", 0)
        # A 4 mm floor 100 x 60 with a 4 mm wall 40 high standing on it, as one solid.
        floor = gmsh.model.occ.addBox(0, 0, 0, 100, 60, 4)
        wall = gmsh.model.occ.addBox(48, 0, 4, 4, 60, 40)
        gmsh.model.occ.fuse([(3, floor)], [(3, wall)])
        gmsh.model.occ.synchronize()
        gmsh.write(str(cls.folder / "tee.step"))
        gmsh.clear()
        # A surface model: two free faces, no solid.
        gmsh.model.occ.addRectangle(0, 0, 0, 50, 30)
        gmsh.model.occ.addRectangle(0, 0, 10, 50, 30)
        gmsh.model.occ.synchronize()
        gmsh.write(str(cls.folder / "sheets.step"))
        gmsh.finalize()
        cls.count = 0

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.folder, ignore_errors=True)

    def run_kernel(self, request, source):
        type(self).count += 1
        output = self.folder / f"state-{self.count}.brep"
        result = self.kernel.execute({**request, "input": str(source), "output": str(output)})
        return result["topology"], output

    def plane_face(self, topology, axis, value):
        return [f["id"] for f in topology["faces"] if f.get("surface", {}).get("kind") == "plane"
                and abs(abs(f["surface"]["normal"][axis]) - 1) < 1e-9 and abs(f["center"][axis] - value) < 1e-6]

    def prepare(self, operation, topology, source):
        return self.run_kernel({"action": "prepare", "operation": operation, "sheets": topology["sheets"]}, source)

    def tee(self):
        """The tee with midsurfaces of the floor and the wall, the wall's extended down to the floor's, joined."""
        t, s = self.run_kernel({"action": "import"}, self.folder / "tee.step")
        self.assertEqual(t["sheets"], [], "a solid file has no sheets")
        t, s = self.prepare({"kind": "surface", "faces": [self.plane_face(t, 2, 0)[0], self.plane_face(t, 2, 4)[0]], "place": "mid"}, t, s)
        t, s = self.prepare({"kind": "surface", "faces": [self.plane_face(t, 0, 48)[0], self.plane_face(t, 0, 52)[0]]}, t, s)
        floor, wall = (next(r["face"] for r in t["sheets"] if r["sheet"] == n) for n in (1, 2))
        bottom = [e for e in next(f for f in t["faces"] if f["id"] == wall)["edges"]
                  if all(abs(next(x for x in t["edges"] if x["id"] == e)["bounds"][i] - 4) < 1e-6 for i in (2, 5))]
        t, s = self.prepare({"kind": "extend", "edges": bottom, "target": floor}, t, s)
        wall_faces = [r["face"] for r in t["sheets"] if r["sheet"] == 2]
        self.assertAlmostEqual(min(next(f for f in t["faces"] if f["id"] == w)["bounds"][2] for w in wall_faces), 2.0, places=6,
                               msg="the wall's midsurface reaches the floor's")
        t, s = self.prepare({"kind": "join"}, t, s)
        return t, s

    def test_midsurfaces_measure_the_wall_and_survive_reloads(self):
        t, s = self.run_kernel({"action": "import"}, self.folder / "tee.step")
        t, s = self.prepare({"kind": "surface", "faces": [self.plane_face(t, 2, 0)[0], self.plane_face(t, 2, 4)[0]], "place": "mid"}, t, s)
        (record,) = t["sheets"]
        self.assertEqual((record["sheet"], record["thickness"], record["offset"]), (1, 4.0, 0.0))
        face = next(f for f in t["faces"] if f["id"] == record["face"])
        self.assertEqual(face["volumes"], [])
        self.assertAlmostEqual(face["center"][2], 2.0, places=9)
        self.assertAlmostEqual(face["area"], 6000.0, places=6, msg="the whole floor footprint")
        # Loading the snapshot again keeps the sheet.
        t2, _ = self.run_kernel({"action": "import", "sheets": t["sheets"]}, s)
        self.assertEqual(len(t2["sheets"]), 1)

    def test_extended_and_joined_midsurfaces_share_the_junction_and_mesh_conforming(self):
        t, s = self.tee()
        sheet_faces = {r["face"] for r in t["sheets"]}
        junction = [e for e in t["edges"] if len([f for f in e["faces"] if f in sheet_faces]) == 3]
        self.assertEqual(len(junction), 1, "the wall meets the floor along one edge shared by three faces")
        self.assertTrue(all(r["thickness"] == 4.0 for r in t["sheets"]))
        # A solid cut afterwards leaves the sheets alone.
        cut, _ = self.prepare({"kind": "slice", "planes": [{"origin": [20, 0, 0], "normal": [1, 0, 0]}]}, t, s)
        self.assertEqual((len(cut["sheets"]), len(cut["volumes"])), (3, 2))
        if not quadmesh_bridge.available("paved"):
            return
        result = self.kernel.execute({"action": "shell", "input": str(s), "output": None, "size": 4, "mesher": "paved", "faceIds": sorted(sheet_faces), "sheets": t["sheets"]})
        q = result["quality"]
        self.assertTrue(all(e["type"] == "CQUAD4" for e in result["mesh"]["elements"]))
        self.assertEqual(q["nonManifoldEdges"], 15, "the 60 mm junction, at size 4, is shared by three faces' elements")
        self.assertGreater(q["minScaledJacobian"], 0.9)
        self.assertEqual(result["thicknessByProperty"], {"1": 4.0})

    def test_a_surface_on_one_wall_face_points_its_offset_to_the_wall_middle(self):
        t, s = self.run_kernel({"action": "import"}, self.folder / "tee.step")
        left, right = self.plane_face(t, 0, 48)[0], self.plane_face(t, 0, 52)[0]
        on, s1 = self.prepare({"kind": "surface", "faces": [left, right], "place": "first"}, t, s)
        (record,) = on["sheets"]
        face = next(f for f in on["faces"] if f["id"] == record["face"])
        self.assertAlmostEqual(face["center"][0], 48.0, places=9)
        self.assertEqual(record["thickness"], 4.0)
        # Grid points on x = 48; ZOFFS along the element normal reaches the wall's middle at x = 50.
        self.assertAlmostEqual(48 + record["offset"] * face["normal"][0], 50.0, places=9)
        # One face with a thickness: the wall runs 4 mm into the floor from its bottom face.
        one, _ = self.prepare({"kind": "surface", "faces": [self.plane_face(t, 2, 0)[0]], "thickness": 4, "offset": 0}, t, s)
        (record,) = one["sheets"]
        face = next(f for f in one["faces"] if f["id"] == record["face"])
        self.assertAlmostEqual(0 + record["offset"] * face["normal"][2], 2.0, places=9)
        # Its shell elements carry the offset.
        if quadmesh_bridge.available("paved"):
            result = self.kernel.execute({"action": "shell", "input": str(s1), "output": None, "size": 8, "mesher": "paved", "faceIds": [on["sheets"][0]["face"]], "sheets": on["sheets"]})
            self.assertEqual({e.get("zoffs") for e in result["mesh"]["elements"]}, {on["sheets"][0]["offset"]})

    def test_split_cuts_sheets_along_a_plane_into_pieces_that_share_the_cut(self):
        t, s = self.run_kernel({"action": "import"}, self.folder / "tee.step")
        t, s = self.prepare({"kind": "surface", "faces": [self.plane_face(t, 2, 0)[0], self.plane_face(t, 2, 4)[0]]}, t, s)
        t, s = self.prepare({"kind": "split-sheets", "plane": {"origin": [0, 30, 0], "normal": [0, 1, 0]}}, t, s)
        pieces = [next(f for f in t["faces"] if f["id"] == r["face"]) for r in t["sheets"]]
        self.assertEqual(len(pieces), 2)
        self.assertTrue(all(r["sheet"] == 1 and r["thickness"] == 4.0 for r in t["sheets"]))
        np.testing.assert_allclose(sorted(p["area"] for p in pieces), [3000, 3000], atol=1e-6)
        shared = [e for e in t["edges"] if len(set(e["faces"]) & {p["id"] for p in pieces}) == 2]
        self.assertEqual(len(shared), 1, "the two halves share the cut")
        self.assertEqual(len([f for f in t["faces"] if not f["volumes"]]), 2, "nothing of the cutting plane is left")
        with self.assertRaisesRegex(ValueError, "does not cross"):
            self.prepare({"kind": "split-sheets", "plane": {"origin": [0, 0, 100], "normal": [0, 0, 1]}}, t, s)

    def test_extend_finds_the_outside_of_an_edge_on_a_copied_face(self):
        # Gmsh's parametric inside test can call points outside a copied face inside;
        # extending a sheet's edge must still grow away from the sheet.
        t, s = self.run_kernel({"action": "import"}, self.folder / "tee.step")
        t, s = self.prepare({"kind": "surface", "faces": [self.plane_face(t, 2, 0)[0], self.plane_face(t, 2, 4)[0]]}, t, s)
        t, s = self.prepare({"kind": "surface", "faces": [self.plane_face(t, 0, 48)[0], self.plane_face(t, 0, 52)[0]]}, t, s)
        wall = next(r["face"] for r in t["sheets"] if r["sheet"] == 2)
        top = [e["id"] for e in t["edges"] if wall in e["faces"] and abs(e["bounds"][2] - 44) < 1e-6 and abs(e["bounds"][5] - 44) < 1e-6]
        with self.assertRaisesRegex(ValueError, "lies behind edge"):
            self.prepare({"kind": "extend", "edges": top, "target": next(r["face"] for r in t["sheets"] if r["sheet"] == 1)}, t, s)

    def test_a_tube_midsurface_is_the_cylinder_halfway_through_the_wall(self):
        t, s = self.run_kernel({"action": "import"}, ROOT / "examples/shells/round_tube_35x4.step")
        outer, inner = (next(f["id"] for f in t["faces"] if f.get("surface", {}).get("kind") == "cylinder" and abs(f["surface"]["radius"] - r) < 1e-6) for r in (17.5, 13.5))
        t, _ = self.prepare({"kind": "surface", "faces": [outer, inner]}, t, s)
        (record,) = t["sheets"]
        face = next(f for f in t["faces"] if f["id"] == record["face"])
        self.assertEqual(face["surface"]["kind"], "cylinder")
        self.assertAlmostEqual(face["surface"]["radius"], 15.5, places=6)
        self.assertEqual((record["thickness"], record["offset"]), (4.0, 0.0))

    def test_sheets_can_be_edited_and_removed(self):
        t, s = self.tee()
        t2, _ = self.prepare({"kind": "sheet", "sheet": 2, "thickness": 3, "offset": 0.5, "name": "Wall"}, t, s)
        wall = [r for r in t2["sheets"] if r["sheet"] == 2]
        self.assertTrue(wall and all((r["thickness"], r["offset"], r["label"]) == (3.0, 0.5, "Wall") for r in wall))
        t3, _ = self.prepare({"kind": "sheet", "sheet": 2, "remove": True}, t, s)
        self.assertEqual({r["sheet"] for r in t3["sheets"]}, {1})
        self.assertEqual(len(t3["faces"]) + len(wall), len(t["faces"]))
        # One face of a sheet: the floor midsurface, split in two by the join, loses one side.
        floor = [r["face"] for r in t["sheets"] if r["sheet"] == 1]
        self.assertEqual(len(floor), 2)
        t4, _ = self.prepare({"kind": "sheet", "sheet": 1, "remove": True, "faces": floor[:1]}, t, s)
        self.assertEqual(len([r for r in t4["sheets"] if r["sheet"] == 1]), 1)
        with self.assertRaisesRegex(ValueError, "Pick faces of sheet 1"):
            self.prepare({"kind": "sheet", "sheet": 1, "remove": True, "faces": [wall[0]["face"]]}, t, s)

    def test_a_surface_model_file_brings_its_faces_as_sheets(self):
        t, _ = self.run_kernel({"action": "import"}, self.folder / "sheets.step")
        self.assertEqual([(r["sheet"], r["thickness"]) for r in t["sheets"]], [(1, None), (2, None)])
        self.assertEqual(t["volumes"], [])

    def test_cones_and_tori_are_recognized_also_when_stored_as_b_splines(self):
        import cad_sheets
        gmsh = self.kernel.gmsh_module()
        gmsh.initialize()
        gmsh.option.setNumber("General.Terminal", 0)
        try:
            gmsh.model.occ.addCone(0, 0, 0, 0, 0, 10, 5, 2)
            gmsh.model.occ.addTorus(30, 0, 0, 8, 2)
            gmsh.model.occ.synchronize()
            for nurbs in (False, True):
                if nurbs:
                    gmsh.model.occ.convertToNURBS(gmsh.model.getEntities(3))
                    gmsh.model.occ.synchronize()
                kinds = {}
                for _, face in gmsh.model.getEntities(2):
                    surface = cad_sheets.surface(gmsh, face)
                    kinds.setdefault(surface["kind"], []).append(surface)
                (cone,), (torus,) = kinds["cone"], kinds["torus"]
                np.testing.assert_allclose(cone["apex"], [0, 0, 10 * 5 / 3], atol=1e-6)
                self.assertAlmostEqual(cone["angle"], np.arctan(0.3), places=6)
                np.testing.assert_allclose([torus["major"], torus["minor"]], [8, 2], atol=1e-6)
                np.testing.assert_allclose(torus["center"], [30, 0, 0], atol=1e-6)
        finally:
            gmsh.finalize()

    def test_impossible_requests_are_refused(self):
        t, s = self.run_kernel({"action": "import"}, self.folder / "tee.step")
        with self.assertRaisesRegex(ValueError, "not parallel"):
            self.prepare({"kind": "surface", "faces": [self.plane_face(t, 2, 0)[0], self.plane_face(t, 0, 48)[0]]}, t, s)
        with self.assertRaisesRegex(ValueError, "same plane"):
            top = self.plane_face(t, 2, 4)
            self.prepare({"kind": "surface", "faces": top[:2]}, t, s)
        tube, tube_state = self.run_kernel({"action": "import"}, ROOT / "examples/shells/round_tube_35x4.step")
        outer = next(f["id"] for f in tube["faces"] if f.get("surface", {}).get("kind") == "cylinder")
        flat = next(f["id"] for f in tube["faces"] if f.get("surface", {}).get("kind") == "plane")
        with self.assertRaisesRegex(ValueError, "a cylinder and a plane|a plane and a cylinder"):
            self.prepare({"kind": "surface", "faces": [outer, flat]}, tube, tube_state)
        t, s = self.tee()
        with self.assertRaisesRegex(ValueError, "not a free edge of one sheet|already"):
            self.prepare({"kind": "extend", "edges": [t["edges"][0]["id"]], "target": t["sheets"][0]["face"]}, t, s)
        with self.assertRaisesRegex(ValueError, "existing sheet"):
            self.prepare({"kind": "sheet", "sheet": 99, "thickness": 2}, t, s)


if __name__ == "__main__":
    unittest.main()
