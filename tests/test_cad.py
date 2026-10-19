"""Real CAD acceptance tests: preview, preparation, sweep fidelity and topology."""

import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import server
from cad_sessions import CadError, CadSessions
from cad_sweep import connected_components


ROOT = Path(__file__).resolve().parents[1]
KERNEL = (Path("/opt/homebrew/opt/gmsh/lib/gmsh.py").exists()
          or Path("/usr/local/opt/gmsh/lib/gmsh.py").exists()
          or server.importlib.util.find_spec("gmsh") is not None)


@unittest.skipUnless(KERNEL, "Gmsh Python/OpenCASCADE kernel is not installed")
class CadAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.sessions = CadSessions(server.run_cad_worker)

    def tearDown(self):
        self.sessions.temporary.cleanup()

    def import_file(self, path):
        return self.sessions.import_cad({"filename": path.name, "format": path.suffix[1:],
                                         "content": base64.b64encode(path.read_bytes()).decode()})

    def request(self, cad, **values):
        return {"cadId": cad["cadId"], "revision": cad["revision"], **values}

    def test_step_preview_has_real_geometry_and_selectable_topology(self):
        cad = self.import_file(ROOT / "examples/block.step")
        self.assertEqual(len(cad["topology"]["faces"]), 6)
        self.assertEqual(len(cad["topology"]["edges"]), 12)
        self.assertEqual(len(cad["topology"]["volumes"]), 1)
        self.assertTrue(cad["topology"]["volumes"][0]["mapped"])
        self.assertEqual(len(cad["preview"]["positions"]), 9 * len(cad["preview"]["triangleFaceIds"]))
        self.assertEqual(set(cad["preview"]["triangleFaceIds"]), {face["id"] for face in cad["topology"]["faces"]})
        self.assertGreater(len(cad["preview"]["edges"]), 0)

    def test_snapshots_are_bounded_by_the_reimport_limit(self):
        with patch.object(server, "MAX_CAD", 1), self.assertRaises(CadError) as error:
            self.import_file(ROOT / "examples/block.step")
        self.assertIn("remain importable", str(error.exception))
        self.assertEqual(self.sessions.records, {})

    def test_split_conserves_volume_and_yields_connected_mapped_hexes(self):
        cad = self.import_file(ROOT / "examples/block.step")
        prepared = self.sessions.prepare(self.request(cad, operation={"kind": "split", "axis": "x", "position": 50}))
        self.assertEqual(len(prepared["topology"]["volumes"]), 2)
        self.assertAlmostEqual(prepared["topology"]["volume"], cad["topology"]["volume"], places=6)
        mesh = self.sessions.mesh(self.request(prepared, topology="hex", method="mapped", divisions=3, order=1, size=10))
        self.assertEqual(mesh["stats"]["elements"], 54)
        self.assertEqual(mesh["quality"]["components"], 1)
        self.assertGreater(mesh["quality"]["minDetJac"], 0)

    def test_split_selected_volume_only(self):
        cad = self.import_file(ROOT / "examples/block.step")
        first = self.sessions.prepare(self.request(cad, operation={"kind": "split", "axis": "x", "position": 50}))
        ids = [volume["id"] for volume in first["topology"]["volumes"]]
        second = self.sessions.prepare(self.request(first, operation={"kind": "split", "axis": "y", "position": 30, "volumeIds": ids[:1]}))
        self.assertEqual(len(second["topology"]["volumes"]), 3)
        self.assertAlmostEqual(second["topology"]["volume"], cad["topology"]["volume"], places=6)

    def test_exact_three_thin_patch_divisions_share_a_coarse_bulk_mesh(self):
        cad = self.import_file(ROOT / "examples/block.step")
        cad = self.sessions.prepare(self.request(cad, operation={"kind": "split", "axis": "y", "position": 0.5}))
        edges = [edge["id"] for edge in cad["topology"]["edges"] if abs(edge["length"] - 0.5) < 1e-6
                 and abs(edge["bounds"][2]) < 1e-5 and abs(edge["bounds"][5]) < 1e-5]
        self.assertEqual(len(edges), 2)
        for order in (1, 2):
            with self.subTest(order=order):
                result = self.sessions.mesh(self.request(cad, topology="hex", method="layered", axis="z",
                                   layerCounts=[2], size=20, order=order, edgeDivisions=[{"id": edge, "divisions": 3} for edge in edges]))
                q = result["quality"]
                self.assertEqual(q["components"], 1)
                self.assertGreater(q["minDetJac"], 0)
                self.assertEqual(q["midsideConformityChecked"], order == 2)
                self.assertEqual(q["cadEquivalence"]["missingVolume"], 0)
                self.assertEqual(q["cadEquivalence"]["addedVolume"], 0)
                self.assertEqual(q["achievedEdgeDivisions"], [{"id": edge, "requested": 3, "achieved": 3} for edge in edges])
                corner_ids = {nid for element in result["mesh"]["elements"] for nid in element["nodes"][:8]}
                levels = {round(node["y"], 8) for node in result["mesh"]["nodes"] if node["id"] in corner_ids and node["y"] <= 0.5 + 1e-6}
                self.assertEqual(levels, {0, round(1 / 6, 8), round(1 / 3, 8), 0.5})
                self.assertLess(result["stats"]["elements"], 1000)

    def test_even_mapped_edge_controls_propagate_and_are_bounded_before_meshing(self):
        cad = self.import_file(ROOT / "examples/block.step")
        edge = cad["topology"]["edges"][0]["id"]
        result = self.sessions.mesh(self.request(cad, topology="hex", method="mapped", divisions=6, size=10,
                                   order=2, edgeDivisions=[{"id": edge, "divisions": 4}]))
        self.assertEqual(result["stats"]["elements"], 4 * 6 * 6)
        self.assertEqual(result["quality"]["achievedEdgeDivisions"], [{"id": edge, "requested": 4, "achieved": 4}])
        with self.assertRaisesRegex(CadError, "before generation"):
            self.sessions.mesh(self.request(cad, topology="hex", method="mapped", divisions=70, size=10,
                               order=1, edgeDivisions=[{"id": edge, "divisions": 200}]))

    def test_conflicting_opposite_mapped_counts_are_rejected(self):
        cad = self.import_file(ROOT / "examples/block.step")
        by_edge = {edge["id"]: edge for edge in cad["topology"]["edges"]}
        groups = {}
        for edge in cad["topology"]["faces"][0]["edges"]:
            bounds = by_edge[edge]["bounds"]
            direction = max(range(3), key=lambda i: bounds[i + 3] - bounds[i])
            groups.setdefault(direction, []).append(edge)
        opposite = next(group for group in groups.values() if len(group) == 2)
        with self.assertRaisesRegex(CadError, "Opposite edges.*equal"):
            self.sessions.mesh(self.request(cad, topology="hex", method="mapped", divisions=6, size=10, order=1,
                 edgeDivisions=[{"id": opposite[0], "divisions": 3}, {"id": opposite[1], "divisions": 4}]))

    def test_explicit_curved_mapped_block_propagates_local_counts(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            script = """import sys
sys.path.insert(0, sys.argv[1])
from cad_kernel import gmsh_module
g=gmsh_module();g.initialize(['test','-nopopup'],readConfigFiles=False);g.option.setNumber('General.Terminal',0)
o=g.model.occ
p=[o.addPoint(*xyz) for xyz in [(1,0,0),(2,0,0),(0,2,0),(0,1,0),(0,0,0)]]
edges=[o.addLine(p[0],p[1]),o.addCircleArc(p[1],p[4],p[2]),o.addLine(p[2],p[3]),o.addCircleArc(p[3],p[4],p[0])]
face=o.addPlaneSurface([o.addCurveLoop(edges)]);o.extrude([(2,face)],0,0,3);o.synchronize()
g.write('sector.brep');g.finalize()
"""
            subprocess.run([sys.executable, "-c", script, str(ROOT)],
                           cwd=folder, timeout=15, check=True)
            cad = self.import_file(folder / "sector.brep")
            self.assertTrue(cad["topology"]["volumes"][0]["mapped"])
            arc = next(edge["id"] for edge in cad["topology"]["edges"] if edge["type"] == "Circle")
            mesh = self.sessions.mesh(self.request(cad, topology="hex", method="mapped", divisions=4, size=1,
                     order=2, edgeDivisions=[{"id": arc, "divisions": 6}]))
            self.assertEqual(mesh["stats"]["elements"], 6 * 4 * 4)
            self.assertGreater(mesh["quality"]["minDetJac"], 0)
            self.assertEqual(mesh["quality"]["achievedEdgeDivisions"], [{"id": arc, "requested": 6, "achieved": 6}])

    def test_failed_preparation_is_transactional(self):
        cad = self.import_file(ROOT / "examples/block.step")
        with self.assertRaises(CadError):
            self.sessions.prepare(self.request(cad, operation={"kind": "split", "axis": "x", "position": 500}))
        _, record = self.sessions.lookup(self.request(cad))
        self.assertEqual(record["revision"], 0)
        self.assertEqual(len(record["states"]), 1)

    def test_projection_rejects_a_face_parallel_to_its_axis(self):
        cad = self.import_file(ROOT / "examples/block.step")
        face = next(face for face in cad["topology"]["faces"] if face["bounds"][3] - face["bounds"][0] < 1e-5)
        with self.assertRaisesRegex(CadError, "perpendicular"):
            self.sessions.prepare(self.request(cad, operation={"kind": "project", "axis": "z", "faceIds": [face["id"]]}))

    def test_rectangular_passage_is_explicit_through_cut_and_rejects_blind_endpoints(self):
        cad = self.import_file(ROOT / "examples/block.step")
        bounds = cad["topology"]["bounds"]
        center = [(bounds[i] + bounds[i + 3]) / 2 for i in range(3)]
        passage = {"kind": "passage", "axis": "x", "center": center, "width": 6, "height": 6,
                   "range": [bounds[0] - 1, bounds[3] + 1]}
        with self.assertRaisesRegex(CadError, "free space"):
            self.sessions.prepare(self.request(cad, operation={**passage, "range": [center[0], bounds[3] + 1]}))
        prepared = self.sessions.prepare(self.request(cad, operation=passage))
        self.assertAlmostEqual(cad["topology"]["volume"] - prepared["topology"]["volume"],
                               36 * (bounds[3] - bounds[0] - 2e-7), places=4)
        self.assertEqual(len(prepared["topology"]["volumes"]), 1)
        self.assertEqual(sum(len(face.get("loops", [])) == 2 for face in prepared["topology"]["faces"]), 2)

    def test_rectangular_passage_rejects_invalid_dimensions_and_severed_solid(self):
        cad = self.import_file(ROOT / "examples/block.step")
        bounds = cad["topology"]["bounds"]
        center = [(bounds[i] + bounds[i + 3]) / 2 for i in range(3)]
        passage = {"kind": "passage", "axis": "x", "center": center, "width": 6, "height": 6,
                   "range": [bounds[0] - 1, bounds[3] + 1]}
        for invalid in ({"width": -1}, {"center": ["bad", 2, 3]}, {"range": [1, 1]}, {"axis": "bad"}):
            with self.subTest(invalid=invalid), self.assertRaises(CadError):
                self.sessions.prepare(self.request(cad, operation={**passage, **invalid}))
        with self.assertRaisesRegex(CadError, "sever"):
            self.sessions.prepare(self.request(cad, operation={**passage, "height": bounds[5] - bounds[2] + 10}))

    def test_generic_quadratic_layered_sweep_preserves_a_closed_port_and_upper_bridge(self):
        cad = self.import_file(ROOT / "examples/block.step")
        bounds = cad["topology"]["bounds"]
        center = [(bounds[i] + bounds[i + 3]) / 2 for i in range(3)]
        cut = self.sessions.prepare(self.request(cad, operation={"kind": "passage", "axis": "x", "center": center,
                                   "width": 6, "height": 6, "range": [bounds[0] - 1, bounds[3] + 1]}))
        floors = [face["id"] for face in cut["topology"]["faces"] if face["type"] == "Plane"
                  and face["bounds"][5] - face["bounds"][2] < 1e-5 and face.get("normal", [0, 0, 0])[2] > 0
                  and bounds[2] + 1e-5 < face["center"][2] < bounds[5] - 1e-5]
        prepared = self.sessions.prepare(self.request(cut, operation={"kind": "project", "axis": "z", "faceIds": floors}))
        plan = next(plan for plan in prepared["topology"]["layeredSweeps"] if plan["axis"] == "z")
        self.assertTrue(any(column["min"] > 1 for column in plan["columns"]))
        result = self.sessions.mesh(self.request(prepared, topology="hex", method="layered", axis="z",
                                                layerCounts=[2] * len(plan["intervals"]), size=10, order=2))
        self.assertTrue(all(len(element["nodes"]) == 20 for element in result["mesh"]["elements"]))
        self.assertEqual(result["quality"]["components"], 1)
        self.assertTrue(result["quality"]["midsideConformityChecked"])
        self.assertGreater(result["quality"]["minDetJac"], 0)
        self.assertEqual(result["quality"]["cadEquivalence"]["missingVolume"], 0)
        self.assertEqual(result["quality"]["cadEquivalence"]["addedVolume"], 0)
        self.assertEqual({nid for element in result["mesh"]["elements"] for nid in element["nodes"]},
                         {node["id"] for node in result["mesh"]["nodes"]})

    def test_stale_revision_cannot_modify_geometry(self):
        cad = self.import_file(ROOT / "examples/block.step")
        self.sessions.prepare(self.request(cad, operation={"kind": "split", "axis": "x", "position": 50}))
        with self.assertRaises(CadError) as error:
            self.sessions.prepare(self.request(cad, operation={"kind": "split", "axis": "z", "position": 10}))
        self.assertEqual(error.exception.status, 409)

    def test_undo_and_export_restore_geometry(self):
        cad = self.import_file(ROOT / "examples/block.step")
        prepared = self.sessions.prepare(self.request(cad, operation={"kind": "split", "axis": "x", "position": 50}))
        undone = self.sessions.undo(self.request(prepared))
        self.assertEqual(len(undone["topology"]["volumes"]), 1)
        self.assertGreater(undone["revision"], prepared["revision"])
        exported = self.sessions.export(self.request(undone))
        restored = self.sessions.import_cad(exported)
        self.assertEqual(len(restored["topology"]["faces"]), 6)
        self.assertAlmostEqual(restored["topology"]["volume"], cad["topology"]["volume"], places=6)

    def test_plate_hole_defeature_changes_solid_deliberately(self):
        cad = self.import_file(ROOT / "examples/plate-hole.step")
        features = cad["topology"]["features"]
        self.assertTrue(features)
        prepared = self.sessions.prepare(self.request(cad, operation={"kind": "defeature", "faceIds": [features[0]["faceId"]]}))
        self.assertGreater(prepared["topology"]["volume"], cad["topology"]["volume"])
        self.assertEqual(prepared["history"][-1]["operation"]["kind"], "defeature")

    def test_stl_preview_and_triangle_tet_mesh_are_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            (folder / "block.geo").write_text('SetFactory("OpenCASCADE"); Box(1)={0,0,0,2,3,4};')
            subprocess.run([server.find_gmsh(), "block.geo", "-2", "-o", "block.stl", "-v", "1"],
                           cwd=folder, timeout=15, check=True)
            cad = self.import_file(folder / "block.stl")
            self.assertTrue(cad["topology"]["discrete"])
            self.assertGreater(len(cad["preview"]["triangleFaceIds"]), 0)
            for kind in ("tri", "tet"):
                mesh = self.sessions.mesh(self.request(cad, topology=kind, size=1, order=2))
                self.assertEqual(mesh["quality"]["components"], 1)
                self.assertGreater(mesh["quality"]["minDetJac"], 0)
            with self.assertRaises(CadError):
                self.sessions.prepare(self.request(cad, operation={"kind": "heal"}))


@unittest.skipUnless(KERNEL and (ROOT / "flexure.step").exists(), "User's flexure CAD is unavailable")
class FlexureHexAcceptanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sessions = CadSessions(server.run_cad_worker)
        cls.original = cls.sessions.import_cad({"filename": "flexure.step", "format": "step",
                                               "content": base64.b64encode((ROOT / "flexure.step").read_bytes()).decode()})
        # Test fixture choices are deliberate user-facing preparation, not kernel
        # shape special cases: remove transverse holes/caps and the rear boss.
        cls.prepared = cls.sessions.prepare({"cadId": cls.original["cadId"], "revision": cls.original["revision"],
                                            "operation": {"kind": "defeature", "faceIds": [3, 8, 13, 14, 19, 20, 71, 75, 76, 77]}})

    @classmethod
    def tearDownClass(cls):
        cls.sessions.temporary.cleanup()

    def test_original_boss_and_transverse_holes_cannot_be_silently_swept_away(self):
        state = self.sessions.records[self.original["cadId"]]["states"][0]
        with self.assertRaises(CadError) as error:
            server.run_cad_worker({"action": "mesh", "topology": "hex", "method": "sweep", "sourceFace": 2,
                                   "size": 1.5, "layers": 8, "order": 1}, state["path"], None)
        self.assertTrue("No matching" in str(error.exception) or "change prepared CAD" in str(error.exception))

    def test_prepared_flexure_hex8_and_hex20_are_connected_positive_and_exact(self):
        cad = self.prepared
        for order in (1, 2):
            with self.subTest(order=order):
                result = self.sessions.mesh({"cadId": cad["cadId"], "revision": cad["revision"], "topology": "hex",
                                             "method": "sweep", "sourceFace": 1, "targetFace": 3,
                                             "layers": 8, "size": 1.5, "order": order})
                self.assertEqual({element["type"] for element in result["mesh"]["elements"]}, {"CHEXA"})
                self.assertTrue(all(len(e["nodes"]) == (8 if order == 1 else 20) for e in result["mesh"]["elements"]))
                self.assertEqual(result["quality"]["components"], 1)
                self.assertEqual(result["quality"]["nonManifoldFaces"], 0)
                self.assertEqual(result["quality"]["nonConformingFaces"], 0)
                self.assertEqual(result["quality"]["midsideConformityChecked"], order == 2)
                self.assertGreater(result["quality"]["conformingInterfaces"], 0)
                self.assertGreater(result["quality"]["minDetJac"], 0)
                self.assertGreater(result["quality"]["minScaledJacobian"], 0.2)
                fidelity = result["quality"]["cadEquivalence"]
                self.assertEqual(fidelity["missingVolume"], 0)
                self.assertEqual(fidelity["addedVolume"], 0)
                self.assertAlmostEqual(fidelity["originalVolume"], 13904.59678449, places=6)

    def test_coarse_quadratic_mesh_is_optimized_without_global_refinement(self):
        cad = self.prepared
        result = self.sessions.mesh({"cadId": cad["cadId"], "revision": cad["revision"], "topology": "hex",
                                   "method": "sweep", "sourceFace": 1, "targetFace": 3, "layers": 4, "size": 3, "order": 2})
        self.assertEqual(result["stats"]["elements"], 4880)
        self.assertGreater(result["quality"]["minScaledJacobian"], 0.1)
        self.assertGreater(result["quality"]["minDetJac"], 0)
        self.assertEqual(result["quality"]["components"], 1)
        self.assertTrue(result["quality"]["midsideConformityChecked"])
        self.assertEqual(result["quality"]["optimization"]["method"], "HighOrder")

    def test_local_three_elements_across_every_flexure_preserves_curves_and_coarse_bulk(self):
        sessions = CadSessions(server.run_cad_worker)
        try:
            cad = sessions.import_cad(self.sessions.export({"cadId": self.prepared["cadId"], "revision": self.prepared["revision"]}))
            for axis, positions in (("x", [-12.5, -5.5, 5.5, 12.5]), ("z", [-4.5, 5.5])):
                for position in positions:
                    cad = sessions.prepare({"cadId": cad["cadId"], "revision": cad["revision"],
                                            "operation": {"kind": "split", "axis": axis, "position": position}})
            self.assertEqual(len(cad["topology"]["volumes"]), 29)
            self.assertAlmostEqual(cad["topology"]["volume"], self.prepared["topology"]["volume"], places=6)
            edges = {edge["id"]: edge for edge in cad["topology"]["edges"]}
            strips, short = [], set()
            for face in cad["topology"]["faces"]:
                b = face["bounds"]
                width, length = sorted((b[3] - b[0], b[5] - b[2]))
                if (abs(b[1] + 12) < 1e-5 and abs(b[4] + 12) < 1e-5 and len(face["edges"]) == 4
                        and min(abs(width - 0.5), abs(width - 1.5)) < 1e-5 and length > 6.9):
                    strips.append(face)
                    short.update(edge for edge in face["edges"] if abs(edges[edge]["length"] - width) < 1e-5)
            self.assertEqual(len(strips), 10)
            self.assertEqual(len(short), 20)
            for order in (1, 2):
                result = sessions.mesh({"cadId": cad["cadId"], "revision": cad["revision"], "topology": "hex",
                           "method": "layered", "axis": "y", "layerCounts": [4], "size": 3, "order": order,
                           "edgeDivisions": [{"id": edge, "divisions": 3} for edge in sorted(short)]})
                q = result["quality"]
                self.assertEqual(q["components"], 1)
                self.assertEqual(q["nonConformingFaces"], 0)
                self.assertEqual(q["midsideConformityChecked"], order == 2)
                self.assertGreater(q["minScaledJacobian"], 0.15)
                self.assertGreater(q["minDetJac"], 0)
                self.assertEqual(q["cadEquivalence"]["missingVolume"], 0)
                self.assertEqual(q["cadEquivalence"]["addedVolume"], 0)
                self.assertEqual(len(q["achievedEdgeDivisions"]), 20)
                self.assertTrue(all(row["requested"] == row["achieved"] == 3 for row in q["achievedEdgeDivisions"]))
                self.assertLess(result["stats"]["elements"], 24_720)
                corners = {nid for element in result["mesh"]["elements"] for nid in element["nodes"][:8]}
                for strip in strips:
                    b = strip["bounds"]
                    coordinate = 0 if b[3] - b[0] < b[5] - b[2] else 2
                    levels = {round(node["xyz"[coordinate]], 7) for node in result["mesh"]["nodes"]
                              if node["id"] in corners and abs(node["y"] + 12) < 1e-6
                              and b[0] - 1e-6 <= node["x"] <= b[3] + 1e-6 and b[2] - 1e-6 <= node["z"] <= b[5] + 1e-6}
                    self.assertEqual(len(levels), 4)  # three actual corner-cell rows, not just a requested count
        finally:
            sessions.temporary.cleanup()


@unittest.skipUnless(KERNEL and (ROOT / "long corner bracket.step").exists(), "User's bracket CAD is unavailable")
class BracketLayeredHexAcceptanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sessions = CadSessions(server.run_cad_worker)
        path = ROOT / "long corner bracket.step"
        original = cls.sessions.import_cad({"filename": path.name, "format": "step",
                                            "content": base64.b64encode(path.read_bytes()).decode()})
        cls.original_volume = original["topology"]["volume"]
        curved = [face["id"] for face in original["topology"]["faces"] if face["type"] != "Plane"]
        # Explicitly simplify the six intersecting round branches to inscribed
        # 6x6 rectangular branches. Their three closed web ports and the upper,
        # lower and side ligaments remain. Small bolt bores are deliberately
        # filled for attachment idealization; the kernel never makes this choice.
        cls.passages = ([{"axis": "x", "center": [0, y, 10], "width": 6, "height": 6, "range": [6, 76]}
                         for y in (30, 55, 80)]
                        + [{"axis": "y", "center": [x, 0, 10], "width": 6, "height": 6, "range": [6, 101]}
                           for x in (54, 35.5, 17)])
        cls.simplified = cls.sessions.prepare({"cadId": original["cadId"], "revision": original["revision"],
                                              "operation": {"kind": "passages", "faceIds": curved, "passages": cls.passages}})
        bounds = cls.simplified["topology"]["bounds"]
        ledges = [face for face in cls.simplified["topology"]["faces"]
                  if face["type"] == "Plane" and face["bounds"][5] - face["bounds"][2] < 1e-5
                  and bounds[2] + 1e-5 < face["center"][2] < bounds[5] - 1e-5
                  and face.get("normal", [0, 0, 0])[2] > 0]
        cls.prepared = cls.sessions.prepare({"cadId": cls.simplified["cadId"], "revision": cls.simplified["revision"],
                                             "operation": {"kind": "project", "axis": "z", "faceIds": [face["id"] for face in ledges]}})

    @classmethod
    def tearDownClass(cls):
        cls.sessions.temporary.cleanup()

    def test_reviewable_projection_partition_preserves_prepared_bracket(self):
        cad = self.prepared
        self.assertGreater(self.simplified["topology"]["volume"], self.original_volume)
        self.assertAlmostEqual(cad["topology"]["volume"], self.simplified["topology"]["volume"], places=6)
        self.assertEqual(len(cad["topology"]["volumes"]), 34)
        plan = next(plan for plan in cad["topology"]["layeredSweeps"] if plan["axis"] == "z")
        for actual, expected in zip(plan["levels"], [0, 6, 7, 13, 20]):
            self.assertAlmostEqual(actual, expected, places=6)
        self.assertEqual([len(interval["volumeIds"]) for interval in plan["intervals"]], [19, 18, 3, 18])
        self.assertEqual(sum(column["min"] > 12 for column in plan["columns"]), 15)
        self.assertEqual(cad["history"][-1]["operation"]["kind"], "project")

    def test_all_three_large_closed_ports_and_their_ligaments_remain(self):
        faces = self.simplified["topology"]["faces"]
        web = next(face for face in faces if len(face.get("loops", [])) == 4)
        edges = {edge["id"]: edge for edge in self.simplified["topology"]["edges"]}
        openings = []
        for loop in web["loops"]:
            lower = [min(edges[abs(tag)]["bounds"][i] for tag in loop) for i in range(3)]
            upper = [max(edges[abs(tag)]["bounds"][i + 3] for tag in loop) for i in range(3)]
            if lower[2] > 1:
                openings.append((lower, upper))
        self.assertEqual(len(openings), 3)
        for lower, upper in openings:
            self.assertAlmostEqual(lower[2], 7, places=5)
            self.assertAlmostEqual(upper[2], 13, places=5)
            self.assertGreater(lower[0], 6)
            self.assertGreater(lower[1], 6)
            self.assertGreater(20 - upper[2], 6.9)
            self.assertGreater(lower[2] - 6, 0.9)
        self.assertAlmostEqual(self.simplified["topology"]["volume"], 46993.121692283, places=6)
        self.assertLess(3 * 2 ** 0.5, 4.25)  # square corners lie inside the original bores

    def test_layered_sweep_requires_an_explicit_count_for_each_interval(self):
        cad = self.prepared
        with self.assertRaisesRegex(CadError, "each of the 4 detected intervals"):
            self.sessions.mesh({"cadId": cad["cadId"], "revision": cad["revision"], "topology": "hex",
                                "method": "layered", "axis": "z", "layerCounts": [10], "size": 4, "order": 1})

    def test_layered_hex8_and_hex20_share_every_interface_and_preserve_exact_cad(self):
        cad = self.prepared
        for order in (1, 2):
            with self.subTest(order=order):
                result = self.sessions.mesh({"cadId": cad["cadId"], "revision": cad["revision"], "topology": "hex",
                                             "method": "layered", "axis": "z", "layerCounts": [3, 1, 3, 4], "size": 4, "order": order})
                self.assertEqual({element["type"] for element in result["mesh"]["elements"]}, {"CHEXA"})
                self.assertTrue(all(len(element["nodes"]) == (8 if order == 1 else 20) for element in result["mesh"]["elements"]))
                checks = result["quality"]
                self.assertEqual(checks["components"], 1)
                self.assertEqual(checks["cadComponents"], 1)
                self.assertEqual(checks["nonConformingFaces"], 0)
                self.assertEqual(checks["midsideConformityChecked"], order == 2)
                self.assertGreater(checks["conformingInterfaces"], 0)
                self.assertGreater(checks["minDetJac"], 0)
                self.assertGreater(checks["minScaledJacobian"], 0.45)
                self.assertEqual(checks["cadEquivalence"]["missingVolume"], 0)
                self.assertEqual(checks["cadEquivalence"]["addedVolume"], 0)
                self.assertEqual(checks["cadEquivalence"]["layerCounts"], [3, 1, 3, 4])
                referenced = {nid for element in result["mesh"]["elements"] for nid in element["nodes"]}
                self.assertEqual(referenced, {node["id"] for node in result["mesh"]["nodes"]})


class QuadraticConformityTests(unittest.TestCase):
    def pair(self):
        corners = [[1, 2, 3, 4, 5, 6, 7, 8], [2, 9, 10, 3, 6, 11, 12, 7]]
        edges = [(0, 1), (0, 3), (0, 4), (1, 2), (1, 5), (2, 3), (2, 6), (3, 7), (4, 5), (4, 7), (5, 6), (6, 7)]
        midsides, elements = {}, []
        for nodes in corners:
            for a, b in edges:
                key = tuple(sorted((nodes[a], nodes[b])))
                if key not in midsides:
                    midsides[key] = 100 + len(midsides)
            elements.append(nodes + [midsides[tuple(sorted((nodes[a], nodes[b])))] for a, b in edges])
        return elements

    def check(self, elements):
        model = SimpleNamespace(mesh=SimpleNamespace(getElements=lambda dimension: ([17], [[1, 2]], [sum(elements, [])])))
        return connected_components(SimpleNamespace(model=model), 3)

    def test_shared_hex20_face_requires_all_shared_midside_nodes(self):
        result = self.check(self.pair())
        self.assertEqual(result["components"], 1)
        self.assertEqual(result["conformingInterfaces"], 1)
        self.assertTrue(result["midsideConformityChecked"])

    def test_same_corners_with_different_midside_id_is_rejected(self):
        elements = self.pair()
        elements[1][9] = 9999
        with self.assertRaisesRegex(ValueError, "midside node IDs"):
            self.check(elements)

    def test_swapped_midsides_on_shared_face_are_rejected_even_if_node_set_matches(self):
        elements = self.pair()
        elements[1][9], elements[1][10] = elements[1][10], elements[1][9]
        with self.assertRaisesRegex(ValueError, "midside node IDs"):
            self.check(elements)

    @unittest.skipUnless(KERNEL, "Gmsh kernel is unavailable")
    def test_curved_quadratic_jacobian_check_catches_inverted_midside(self):
        from cad_kernel import gmsh_module, mesh_quality
        gmsh = gmsh_module()
        gmsh.initialize(readConfigFiles=False, interruptible=False)
        gmsh.option.setNumber("General.Terminal", 0)
        try:
            gmsh.model.addDiscreteEntity(3, 1)
            points = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
                      [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
            edges = [(0, 1), (0, 3), (0, 4), (1, 2), (1, 5), (2, 3), (2, 6), (3, 7), (4, 5), (4, 7), (5, 6), (6, 7)]
            points += [[(points[a][i] + points[b][i]) / 2 for i in range(3)] for a, b in edges]
            points[8] = [0.5, 0, 2.5]  # Corners remain a valid unit cube.
            gmsh.model.mesh.addNodes(3, 1, list(range(1, 21)), [v for point in points for v in point])
            gmsh.model.mesh.addElementsByType(1, 17, [1], list(range(1, 21)))
            with self.assertRaisesRegex(ValueError, "nonpositive Jacobians"):
                mesh_quality(gmsh, 3)
        finally:
            gmsh.finalize()


if __name__ == "__main__":
    unittest.main()
