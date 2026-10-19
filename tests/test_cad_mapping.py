"""Kernel classification data for native mapped meshing, slicing and staged previews."""

import base64
from pathlib import Path
import time
import unittest

import server
from cad_sessions import CadError, CadSessions


ROOT = Path(__file__).resolve().parents[1]
KERNEL = (Path("/opt/homebrew/opt/gmsh/lib/gmsh.py").exists()
          or Path("/usr/local/opt/gmsh/lib/gmsh.py").exists()
          or server.importlib.util.find_spec("gmsh") is not None)


@unittest.skipUnless(KERNEL, "Gmsh Python/OpenCASCADE kernel is not installed")
class MappingTopologyTests(unittest.TestCase):
    def setUp(self):
        self.sessions = CadSessions(server.run_cad_worker)

    def tearDown(self):
        self.sessions.temporary.cleanup()

    def import_file(self, path):
        return self.sessions.import_cad({"filename": path.name, "format": path.suffix[1:],
                                         "content": base64.b64encode(path.read_bytes()).decode()})

    def request(self, cad, **values):
        return {"cadId": cad["cadId"], "revision": cad["revision"], **values}

    def test_block_has_oriented_four_corner_loops_and_right_angle_edges(self):
        topology = self.import_file(ROOT / "examples/block.step")["topology"]
        self.assertEqual(len(topology["vertices"]), 8)
        edges = {e["id"]: e for e in topology["edges"]}
        for edge in edges.values():
            self.assertEqual(edge["curve"]["kind"], "line")
            self.assertEqual(len(edge["vertices"]), 2)
            self.assertNotEqual(edge["vertices"][0], edge["vertices"][1])
        for face in topology["faces"]:
            self.assertEqual(face["surface"]["kind"], "plane")
            (loop,) = face["orientedLoops"]
            self.assertEqual(len(loop), 4)
            # Consecutive oriented edges chain end-to-start around the face.
            for (a, sa), (b, sb) in zip(loop, loop[1:] + loop[:1]):
                end = edges[a]["vertices"][1 if sa > 0 else 0]
                start = edges[b]["vertices"][0 if sb > 0 else 1]
                self.assertEqual(end, start)
            self.assertEqual([round(angle) for _, angle in face["corners"][0]], [90, 90, 90, 90])
        (volume,) = topology["volumes"]
        self.assertEqual(sorted(round(a) for _, a in volume["edgeAngles"]), [90] * 12)

    def test_holes_are_concave_cylinders_with_seams_and_circle_edges(self):
        topology = self.import_file(ROOT / "examples/plate-hole.step")["topology"]
        cylinders = [f for f in topology["faces"] if f["surface"]["kind"] == "cylinder"]
        self.assertGreaterEqual(len(cylinders), 1)
        for face in cylinders:
            self.assertIs(face["concave"], True)
            edges = [e for e, _ in face["orientedLoops"][0]]
            self.assertTrue(any(edges.count(e) == 2 for e in edges), "periodic faces repeat their seam edge")
        circles = [e for e in topology["edges"] if e["curve"]["kind"] == "circle"]
        self.assertTrue(circles and all(e["closed"] for e in circles))

    def test_reentrant_edge_is_reported_at_270_degrees(self):
        cad = self.import_file(ROOT / "examples/l-bracket.step")
        prepared = self.sessions.prepare(self.request(cad, operation={"kind": "defeature", "faceIds": [3], "label": "Removed fillet"}))
        angles = [a for _, a in prepared["topology"]["volumes"][0]["edgeAngles"]]
        self.assertIn(270.0, [round(a) for a in angles if a is not None])
        self.assertEqual(prepared["history"][-1]["label"], "Removed fillet")

    def test_slice_with_oblique_plane_rays_and_cylinder_conserves_volume(self):
        cad = self.import_file(ROOT / "examples/block.step")
        bounds = cad["topology"]["bounds"]
        center = [(bounds[i] + bounds[i + 3]) / 2 for i in range(3)]
        oblique = self.sessions.prepare(self.request(cad, operation={"kind": "slice", "planes": [{"origin": center, "normal": [1, 1, 0.3]}]}))
        self.assertEqual(len(oblique["topology"]["volumes"]), 2)
        self.assertAlmostEqual(oblique["topology"]["volume"], cad["topology"]["volume"], places=6)
        cad = self.import_file(ROOT / "examples/block.step")
        ring = self.sessions.prepare(self.request(cad, operation={"kind": "slice", "cylinders": [{"origin": center, "axis": [0, 0, 1], "radius": 5}],
                                                                  "rays": [{"origin": center, "axis": [0, 0, 1], "direction": [0, 1, 0], "length": 200},
                                                                           {"origin": center, "axis": [0, 0, 1], "direction": [0, -1, 0], "length": 200}]}))
        self.assertEqual(len(ring["topology"]["volumes"]), 4)
        self.assertAlmostEqual(ring["topology"]["volume"], cad["topology"]["volume"], places=5)
        self.assertEqual(ring["history"][-1]["operation"]["kind"], "slice")
        # One radial cut alone would leave a slit inside the ring and is refused.
        with self.assertRaises(CadError):
            self.sessions.prepare(self.request(ring, operation={"kind": "slice", "rays": [{"origin": center, "axis": [0, 0, 1], "direction": [1, 0, 0], "length": 4}]}))

    def test_slice_rejects_bad_tools_and_planes_outside_the_material(self):
        cad = self.import_file(ROOT / "examples/block.step")
        for operation in ({"kind": "slice", "planes": []},
                          {"kind": "slice", "planes": [{"origin": [0, 0, 0], "normal": [0, 0, 0]}]},
                          {"kind": "slice", "planes": [{"origin": [0, 0, "x"], "normal": [1, 0, 0]}]},
                          {"kind": "slice", "planes": [{"origin": [0, 0, 0], "normal": [1, 0, 0]}] * 17},
                          {"kind": "slice", "cylinders": [{"origin": [0, 0, 0], "axis": [0, 0, 1], "radius": -1}]},
                          {"kind": "slice", "planes": [{"origin": [500, 0, 0], "normal": [1, 0, 0]}]}):
            with self.assertRaises(CadError):
                self.sessions.prepare(self.request(cad, operation=operation))
        self.assertEqual(self.sessions.records[cad["cadId"]]["revision"], 0)

    def test_slice_tools_can_carry_their_own_solids(self):
        cad = self.import_file(ROOT / "examples/block.step")
        halves = self.sessions.prepare(self.request(cad, operation={"kind": "slice", "planes": [{"origin": [50, 0, 0], "normal": [1, 0, 0]}]}))
        left, right = sorted(halves["topology"]["volumes"], key=lambda v: v["bounds"][0])
        # One operation: a plane through the left half only and another through the right half only.
        cut = self.sessions.prepare(self.request(halves, operation={"kind": "slice", "planes": [
            {"origin": [0, 20, 0], "normal": [0, 1, 0], "volumeIds": [left["id"]]},
            {"origin": [0, 40, 0], "normal": [0, 1, 0], "volumeIds": [right["id"]]}]}))
        volumes = cut["topology"]["volumes"]
        self.assertEqual(len(volumes), 4)
        self.assertAlmostEqual(sum(v["volume"] for v in volumes), cad["topology"]["volume"], places=5)
        cuts = sorted({round(v["bounds"][1 + 3], 3) for v in volumes if v["bounds"][1 + 3] < 59})
        self.assertEqual(cuts, [20.0, 40.0])
        with self.assertRaises(CadError):
            self.sessions.prepare(self.request(cut, operation={"kind": "slice", "planes": [{"origin": [0, 10, 0], "normal": [0, 1, 0], "volumeIds": [999]}]}))

    def test_outer_loop_comes_first_on_faces_with_holes(self):
        topology = self.import_file(ROOT / "examples/plate-hole.step")["topology"]
        edges = {e["id"]: e for e in topology["edges"]}
        holed = [f for f in topology["faces"] if len(f["orientedLoops"]) > 1]
        self.assertTrue(holed)
        for face in holed:
            outer, *inner = face["orientedLoops"]
            self.assertTrue(all(edges[e]["curve"]["kind"] == "line" for e, _ in outer), f"face {face['id']} lists its hole first")
            self.assertTrue(all(edges[e]["curve"]["kind"] == "circle" for loop in inner for e, _ in loop))

    def test_crossing_passages_are_cut_as_one_opening(self):
        cad = self.import_file(ROOT / "examples/block.step")
        b = cad["topology"]["bounds"]
        center = [(b[i] + b[i + 3]) / 2 for i in range(3)]
        cut = self.sessions.prepare(self.request(cad, operation={"kind": "passages", "passages": [
            {"axis": "x", "center": center, "width": 6, "height": 6, "range": [b[0] - 1, b[3] + 1]},
            {"axis": "y", "center": center, "width": 6, "height": 6, "range": [b[1] - 1, b[4] + 1]}]}))
        floors = [f for f in cut["topology"]["faces"] if f["surface"]["kind"] == "plane" and abs(abs(f["surface"]["normal"][2]) - 1) < 1e-9
                  and abs(f["surface"]["origin"][2] - (center[2] - 3)) < 1e-6]
        # One cross-shaped floor, not a center square plus arm pieces split along the other passage.
        self.assertEqual(len(floors), 1)
        self.assertEqual(len(floors[0]["corners"][0]), 12)

    def test_a_scoped_cut_that_ends_inside_its_solid_is_refused(self):
        cad = self.import_file(ROOT / "examples/block.step")
        halves = self.sessions.prepare(self.request(cad, operation={"kind": "slice", "planes": [{"origin": [50, 0, 0], "normal": [1, 0, 0]}]}))
        left = min(halves["topology"]["volumes"], key=lambda v: v["bounds"][0])
        lb = left["bounds"]
        middle = [(lb[i] + lb[i + 3]) / 2 for i in range(3)]
        # A cut that dangles inside one solid divides nothing.
        with self.assertRaisesRegex(CadError, "did not divide"):
            self.sessions.prepare(self.request(halves, operation={"kind": "slice", "volumeIds": [left["id"]],
                                                                   "rays": [{"origin": middle, "axis": [0, 0, 1], "direction": [0, 1, 0], "length": 5}]}))
        # One radial cut through a ring opens it without separating it, also when scoped.
        with self.assertRaises(CadError):
            self.sessions.prepare(self.request(halves, operation={"kind": "slice", "volumeIds": [left["id"]],
                                                                   "cylinders": [{"origin": middle, "axis": [0, 0, 1], "radius": 5}],
                                                                   "rays": [{"origin": middle, "axis": [0, 0, 1], "direction": [0, 1, 0], "length": 200}]}))

    def test_fitted_passage_ends_are_moved_into_free_space(self):
        cad = self.import_file(ROOT / "examples/block.step")
        bounds = cad["topology"]["bounds"]
        center = [(bounds[i] + bounds[i + 3]) / 2 for i in range(3)]
        exact = {"kind": "passage", "axis": "z", "center": center, "width": 6, "height": 6, "range": [bounds[2] + 1e-3, bounds[5] - 1e-3]}
        with self.assertRaises(CadError):
            self.sessions.prepare(self.request(cad, operation=exact))  # both ends inside material
        fitted = self.sessions.prepare(self.request(cad, operation={**exact, "fit": True}))
        self.assertAlmostEqual(cad["topology"]["volume"] - fitted["topology"]["volume"], 36 * (bounds[5] - bounds[2]), places=3)

    def test_preview_is_staged_and_an_identical_prepare_commits_it(self):
        cad = self.import_file(ROOT / "examples/block.step")
        operation = {"kind": "slice", "planes": [{"origin": [50, 0, 0], "normal": [1, 0, 0]}], "label": "Half"}
        preview = self.sessions.preview(self.request(cad, operation=operation))
        self.assertTrue(preview["staged"])
        self.assertEqual(preview["revision"], 0)
        self.assertEqual(len(preview["topology"]["volumes"]), 2)
        self.assertEqual(self.sessions.records[cad["cadId"]]["revision"], 0)
        started = time.perf_counter()
        committed = self.sessions.prepare(self.request(cad, operation=operation))
        self.assertLess(time.perf_counter() - started, 0.5, "the staged result is reused")
        self.assertEqual(committed["revision"], 1)
        self.assertEqual(committed["history"][-1]["label"], "Half")
        self.assertEqual(len(committed["topology"]["volumes"]), 2)
        self.assertNotIn("staged", self.sessions.records[cad["cadId"]])

    def test_a_different_operation_or_undo_discards_the_staged_result(self):
        cad = self.import_file(ROOT / "examples/block.step")
        first = {"kind": "slice", "planes": [{"origin": [50, 0, 0], "normal": [1, 0, 0]}]}
        self.sessions.preview(self.request(cad, operation=first))
        staged = self.sessions.records[cad["cadId"]]["staged"]["path"]
        second = {"kind": "slice", "planes": [{"origin": [25, 0, 0], "normal": [1, 0, 0]}]}
        prepared = self.sessions.prepare(self.request(cad, operation=second))
        self.assertFalse(staged.exists())
        self.assertEqual(len(prepared["topology"]["volumes"]), 2)
        self.sessions.preview(self.request(prepared, operation=first))
        staged = self.sessions.records[cad["cadId"]]["staged"]["path"]
        self.sessions.undo(self.request(prepared))
        self.assertFalse(staged.exists())
        with self.assertRaises(CadError):
            self.sessions.preview(self.request(prepared, operation=first))  # stale revision


if __name__ == "__main__":
    unittest.main()
