"""Shell meshing of CAD faces: quads from quadmesh, triangles from Gmsh, midsurface and offset placement."""

from pathlib import Path
import unittest

import numpy as np

import quadmesh_bridge
import server

ROOT = Path(__file__).resolve().parents[1]
SHELLS = ROOT / "examples" / "shells"
KERNEL = server.importlib.util.find_spec("gmsh") is not None or any(
    (Path(folder) / "gmsh.py").is_file() for folder in ("/opt/homebrew/opt/gmsh/lib", "/usr/local/opt/gmsh/lib"))
QUADMESH = quadmesh_bridge.status()["available"]


def shell(path, **request):
    import cad_kernel
    return cad_kernel.execute({"action": "shell", "input": str(path), "output": None, "size": 3, **request})


def points(result):
    return np.array([[n["x"], n["y"], n["z"]] for n in result["mesh"]["nodes"]])


def mesh_area(result):
    xyz = {n["id"]: np.array([n["x"], n["y"], n["z"]]) for n in result["mesh"]["nodes"]}
    total = 0.0
    for element in result["mesh"]["elements"]:
        p = [xyz[n] for n in element["nodes"]]
        total += 0.5 * np.linalg.norm(np.cross(p[2] - p[0], p[3] - p[1]))
    return total


def cad_faces(path):
    import cad_kernel
    import tempfile
    with tempfile.TemporaryDirectory() as directory:
        return {f["id"]: f for f in cad_kernel.execute({"action": "import", "input": str(path), "output": str(Path(directory) / "a.brep")})["topology"]["faces"]}


def enclosed_volume(result):
    """Signed volume of a closed shell: positive when its normals point outward."""
    xyz = {n["id"]: np.array([n["x"], n["y"], n["z"]]) for n in result["mesh"]["nodes"]}
    total = 0.0
    for element in result["mesh"]["elements"]:
        p = [xyz[n] for n in element["nodes"]]
        for k in range(1, len(p) - 1):
            total += np.dot(p[0], np.cross(p[k], p[k + 1])) / 6
    return total


@unittest.skipUnless(KERNEL and QUADMESH, "Gmsh/OpenCASCADE kernel or the quadmesh library is not available")
class ShellMeshTests(unittest.TestCase):
    def test_every_face_of_a_solid_gives_a_closed_conforming_quad_shell_facing_out(self):
        result = shell(ROOT / "examples/block.step", size=10)
        quality = result["quality"]
        self.assertEqual(quality["freeEdges"], 0, "faces share every edge's nodes")
        self.assertEqual(quality["nonManifoldEdges"], 0)
        self.assertTrue(all(e["type"] == "CQUAD4" for e in result["mesh"]["elements"]))
        self.assertGreater(quality["minScaledJacobian"], 0.6)
        import cad_kernel
        volume = cad_kernel.execute({"action": "import", "input": str(ROOT / "examples/block.step"), "output": str(Path(self._tmp()) / "b.brep")})["topology"]["volume"]
        self.assertAlmostEqual(enclosed_volume(result), volume, delta=volume * 1e-6)
        # Every element faces out, also on the faces through the origin, which add nothing to the volume.
        xyz = {n["id"]: np.array([n["x"], n["y"], n["z"]]) for n in result["mesh"]["nodes"]}
        center = points(result).mean(axis=0)
        for element in result["mesh"]["elements"]:
            p = [xyz[n] for n in element["nodes"]]
            self.assertGreater(float(np.dot(np.cross(p[2] - p[0], p[3] - p[1]), np.mean(p, axis=0) - center)), 0, element)

    def _tmp(self):
        import tempfile
        directory = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(directory, ignore_errors=True))
        return directory

    def test_holes_in_curved_and_bent_walls_stay_closed(self):
        for name in ("round_tube_35x4_holes", "square_tube_35x4_holes", "bent_bracket_holes"):
            result = shell(SHELLS / f"{name}.step")
            quality = result["quality"]
            self.assertEqual((quality["freeEdges"], quality["nonManifoldEdges"]), (0, 0), name)
            self.assertFalse(quality["failedFaces"], name)
            self.assertGreater(quality["minScaledJacobian"], 0.5, name)
            # Holes stay open: on a cylinder an inner loop unwrapped a period away was once meshed over.
            cad = sum(f["area"] for f in cad_faces(SHELLS / f"{name}.step").values())
            self.assertAlmostEqual(mesh_area(result) / cad, 1, delta=0.01, msg=name)

    def test_a_tube_midsurface_lies_halfway_and_measures_the_wall(self):
        # Faces 1 and 4 are the tube's outer and inner cylinders (35 mm, 4 mm wall).
        result = shell(SHELLS / "round_tube_35x4.step", faceIds=[1], placement="midsurface", facesB=[4])
        radius = np.hypot(points(result)[:, 1], points(result)[:, 2])
        self.assertAlmostEqual(radius.min(), 15.5, places=6)
        self.assertAlmostEqual(radius.max(), 15.5, places=6)
        placed = result["quality"]["placement"]
        self.assertAlmostEqual(placed["thickness"], 4.0, places=6)
        self.assertAlmostEqual(placed["maxThickness"] - placed["minThickness"], 0.0, places=6)

    def test_an_offset_moves_along_the_surface_normal(self):
        result = shell(SHELLS / "round_tube_35x4.step", faceIds=[1], placement="offset", offset=-2)
        radius = np.hypot(points(result)[:, 1], points(result)[:, 2])
        self.assertAlmostEqual(radius.min(), 15.5, places=6)
        self.assertAlmostEqual(radius.max(), 15.5, places=6)

    def test_a_bent_sheet_midsurface_follows_the_bends(self):
        # Side A: base bottom, outer bend, vertical flange outside, inner bend, top flange bottom.
        result = shell(SHELLS / "bent_bracket.step", faceIds=[5, 7, 9, 11, 13], placement="midsurface", facesB=[3, 6, 8, 10, 12])
        xyz = points(result)
        base, top = xyz[xyz[:, 0] < 59], xyz[xyz[:, 0] > 70]
        np.testing.assert_allclose(base[:, 2], 1.5, atol=1e-9)
        np.testing.assert_allclose(top[:, 2], 50.5, atol=1e-9)
        self.assertAlmostEqual(result["quality"]["placement"]["thickness"], 3.0, places=6)
        self.assertGreater(result["quality"]["minScaledJacobian"], 0.5)

    def test_triangles_come_from_gmsh_on_the_chosen_faces_only(self):
        result = shell(ROOT / "examples/plate-hole.step", element="tri", size=5, faceIds=[3])
        elements = result["mesh"]["elements"]
        self.assertTrue(elements and all(e["type"] == "CTRIA3" for e in elements))
        self.assertEqual(result["stats"]["faces"], 1)
        self.assertEqual(result["quality"]["nonManifoldEdges"], 0)

    def test_the_quadtree_meshes_a_face_on_its_own(self):
        result = shell(ROOT / "examples/plate-hole.step", mesher="quadtree", size=5, faceIds=[3])
        self.assertTrue(all(e["type"] == "CQUAD4" for e in result["mesh"]["elements"]))
        self.assertGreater(result["quality"]["minScaledJacobian"], 0.2)

    @unittest.skipUnless(quadmesh_bridge.available("paved"), "the paved mesher library is not built")
    def test_the_paved_mesher_gives_a_conforming_closed_shell_and_midsurface(self):
        quality = shell(SHELLS / "bent_bracket_holes.step", mesher="paved")["quality"]
        self.assertEqual((quality["freeEdges"], quality["nonManifoldEdges"]), (0, 0))
        self.assertFalse(quality["failedFaces"])
        self.assertGreater(quality["minScaledJacobian"], 0.5)
        result = shell(SHELLS / "round_tube_35x4.step", mesher="paved", faceIds=[1], placement="midsurface", facesB=[4])
        radius = np.hypot(points(result)[:, 1], points(result)[:, 2])
        self.assertAlmostEqual(radius.min(), 15.5, places=6)
        self.assertAlmostEqual(radius.max(), 15.5, places=6)

    def test_pads_put_one_ring_around_each_hole_with_a_square_outside(self):
        # plate-hole.step: 80 × 50 plate, top face 3, Ø16 bore 10 at the middle, Ø6 bores 7, 8, 9, 11 10 mm from two edges.
        path = ROOT / "examples/plate-hole.step"
        for mesher in ("paved", "recombined"):
            if not quadmesh_bridge.available(mesher):
                continue
            result = shell(path, size=5, mesher=mesher, faceIds=[3], pads=[{"faces": [b]} for b in (7, 8, 9, 10, 11)])
            pads = {round(p["diameter"]): p for p in result["quality"]["pads"]}
            self.assertEqual(len(result["quality"]["pads"]), 5, mesher)
            # The Ø6 guess (15 mm) shrinks to keep an element clear of the plate's edges, with 5 mm spacing kept.
            small = [p for p in result["quality"]["pads"] if round(p["diameter"]) == 6]
            self.assertTrue(all(p["shrunk"] and abs(p["size"] - 10) < 1e-6 and p["perSide"] == 2 for p in small), small)
            self.assertAlmostEqual(pads[16]["size"], 25, delta=1e-6)
            self.assertTrue(all(p["minScaledJacobian"] > 0.69 for p in result["quality"]["pads"]), mesher)
            xyz = points(result)
            on_hole = lambda c, r: np.abs(np.hypot(xyz[:, 0] - c[0], xyz[:, 1] - c[1]) - r) < 1e-6
            # One ring: each hole node belongs to exactly two quads, and the square's corners are nodes.
            ids = np.array([n["id"] for n in result["mesh"]["nodes"]])
            uses = {}
            for element in result["mesh"]["elements"]:
                for n in element["nodes"]:
                    uses[n] = uses.get(n, 0) + 1
            for center, radius, half, count in (((40, 25), 8, 12.5, 4 * pads[16]["perSide"]), ((10, 10), 3, 5, 8)):
                hole = ids[on_hole(center, radius)]
                self.assertEqual(len(hole), count, mesher)
                self.assertTrue(all(uses[n] == 2 for n in hole), mesher)
                for sx in (-1, 1):
                    for sy in (-1, 1):
                        corner = np.hypot(xyz[:, 0] - center[0] - sx * half, xyz[:, 1] - center[1] - sy * half) < 1e-6
                        self.assertEqual(int(corner.sum()), 1, f"{mesher}: corner of the pad around {center}")
            self.assertAlmostEqual(mesh_area(result) / cad_faces(path)[3]["area"], 1, delta=0.01)
        paved = shell(path, size=5, mesher="paved", faceIds=[3], pads=[{"faces": [b]} for b in (7, 8, 9, 10, 11)])
        self.assertGreater(paved["quality"]["minScaledJacobian"], 0.65, "the rest of the plate meshes to the pads' nodes")

    def test_a_pad_size_or_count_set_by_the_user_is_kept_or_refused(self):
        path = ROOT / "examples/plate-hole.step"
        result = shell(path, size=5, mesher="paved", faceIds=[3], pads=[{"faces": [10], "size": 20, "perSide": 5}])
        (pad,) = result["quality"]["pads"]
        self.assertEqual((pad["size"], pad["perSide"], pad["shrunk"]), (20, 5, False))
        for pads, message in (([{"faces": [10], "size": 60}], "runs off its face"), ([{"faces": [10], "size": 12}], "not larger than its hole"),
                              ([{"faces": [10], "perSide": 3}], "even number"), ([{"faces": [10]}, {"faces": [10]}], "same hole"),
                              ([{"faces": [3]}], "not in any face")):
            with self.assertRaisesRegex(ValueError, message):
                shell(path, size=5, mesher="recombined", faceIds=[3], pads=pads)
        with self.assertRaisesRegex(ValueError, "Recombined or Paved"):
            shell(path, size=5, mesher="quadtree", faceIds=[3], pads=[{"faces": [10]}])
        with self.assertRaisesRegex(ValueError, "quad elements"):
            shell(path, size=5, element="tri", faceIds=[3], pads=[{"faces": [10]}])

    def test_pads_work_on_a_curved_wall_at_the_midsurface(self):
        # round_tube_35x4_holes.step: outer face 1, inner face 8; radial Ø8.75 bores 5 and 7; the Ø12.6 bore 2 meets face 1's seam.
        path = SHELLS / "round_tube_35x4_holes.step"
        result = shell(path, faceIds=[1], placement="midsurface", facesB=[8], pads=[{"faces": [5]}, {"faces": [7]}])
        self.assertEqual(len(result["quality"]["pads"]), 2)
        self.assertTrue(all(p["minScaledJacobian"] > 0.6 for p in result["quality"]["pads"]))
        radius = np.hypot(points(result)[:, 1], points(result)[:, 2])
        np.testing.assert_allclose(radius, 15.5, atol=1e-6)
        with self.assertRaisesRegex(ValueError, "not a loop of its own"):
            shell(path, faceIds=[1], pads=[{"faces": [2]}])

    def test_bad_requests_are_refused(self):
        for request in ({"size": 3, "element": "hex"}, {"size": 3, "placement": "middle"}, {"size": 3, "elementsPerCircle": 2},
                        {"size": 0}, {"size": 3, "mesher": "magic"}, {"size": 3, "faceIds": ["1"]},
                        {"size": 3, "pads": [{"faces": []}]}, {"size": 3, "pads": [{"faces": [1], "perSide": 1}]}, {"size": 3, "pads": [{"faces": [1], "size": -2}]},
                        {"size": 3, "pads": [{"faces": [1]}], "mesher": "quadtree"}, {"size": 3, "pads": [{"faces": [1]}], "element": "tri"}, {"size": 3, "pads": {"faces": [1]}}):
            with self.assertRaises(server.MeshError):
                server.validate_shell_request(request)
        with self.assertRaisesRegex(ValueError, "opposite side"):
            shell(SHELLS / "round_tube_35x4.step", faceIds=[1], placement="midsurface")
        with self.assertRaisesRegex(ValueError, "both sides"):
            shell(SHELLS / "round_tube_35x4.step", faceIds=[1], placement="midsurface", facesB=[1])


if __name__ == "__main__":
    unittest.main()
