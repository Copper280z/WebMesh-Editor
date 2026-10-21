"""Kernel classification data for native mapped meshing, slicing and staged previews."""

import base64
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import time
import unittest

import cad_kernel
import server
from cad_sessions import MAX_STAGED, CadError, CadSessions


ROOT = Path(__file__).resolve().parents[1]
KERNEL = cad_kernel.available()


@unittest.skipUnless(KERNEL, "the CAD geometry kernel is not available")
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

    def test_cached_results_match_a_fresh_computation_where_solids_share_a_corner(self):
        import json
        import tempfile
        import cad_kernel
        gmsh = cad_kernel.geometry_module()
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            # An L with a block in its notch: both faces at the re-entrant edge are
            # shared, so the same edge is 270° in the L and 90° in the block.
            gmsh.initialize(["cache-test", "-nopopup"], readConfigFiles=False)
            gmsh.option.setNumber("General.Terminal", 0)
            occ = gmsh.model.occ
            plate, notch = occ.addBox(0, 0, 0, 10, 10, 2), occ.addBox(5, 5, -1, 6, 6, 4)
            occ.cut([(3, plate)], [(3, notch)])
            block = occ.addBox(5, 5, 0, 5, 5, 2)
            occ.fragment(occ.getEntities(3), [(3, block)])
            occ.synchronize()
            gmsh.write(str(folder / "pair.brep"))
            gmsh.finalize()
            first = cad_kernel.execute({"action": "import", "input": str(folder / "pair.brep"), "output": str(folder / "a.brep"),
                                        "cacheOut": str(folder / "a.cache.json")})
            second = cad_kernel.execute({"action": "import", "input": str(folder / "a.brep"), "output": str(folder / "b.brep"),
                                         "cache": str(folder / "a.cache.json")})
            third = cad_kernel.execute({"action": "import", "input": str(folder / "a.brep"), "output": str(folder / "c.brep")})
        self.assertEqual(json.dumps(second["topology"], sort_keys=True), json.dumps(third["topology"], sort_keys=True))
        angles = sorted(round(a) for v in second["topology"]["volumes"] for _, a in v["edgeAngles"] if a is not None)
        self.assertIn(270, angles)
        self.assertEqual(len(first["topology"]["volumes"]), 2)

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
        # A cut that dangles inside one solid divides nothing and leaves a slit.
        with self.assertRaisesRegex(CadError, "slit"):
            self.sessions.prepare(self.request(halves, operation={"kind": "slice", "volumeIds": [left["id"]],
                                                                   "rays": [{"origin": middle, "axis": [0, 0, 1], "direction": [0, 1, 0], "length": 5}]}))
        # One radial cut through a ring opens it without separating it, also when scoped.
        with self.assertRaises(CadError):
            self.sessions.prepare(self.request(halves, operation={"kind": "slice", "volumeIds": [left["id"]],
                                                                   "cylinders": [{"origin": middle, "axis": [0, 0, 1], "radius": 5}],
                                                                   "rays": [{"origin": middle, "axis": [0, 0, 1], "direction": [0, 1, 0], "length": 200}]}))

    def test_a_cut_through_an_acute_corner_runs_into_its_face_material_only(self):
        import tempfile
        import cad_kernel
        gmsh = cad_kernel.geometry_module()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ring.brep"
            # A wall ring around a triangular pocket whose corner at (35, 5) is acute.
            gmsh.initialize(["ring-test", "-nopopup"], readConfigFiles=False)
            gmsh.option.setNumber("General.Terminal", 0)
            occ = gmsh.model.occ
            points = [occ.addPoint(x, y, 0) for x, y in ((5, 5), (35, 5), (5, 30))]
            loop = occ.addCurveLoop([occ.addLine(points[i], points[(i + 1) % 3]) for i in range(3)])
            pocket = occ.extrude([(2, occ.addPlaneSurface([loop]))], 0, 0, 10)
            occ.cut([(3, occ.addBox(0, 0, 0, 40, 40, 10))], [e for e in pocket if e[0] == 3])
            occ.synchronize()
            gmsh.write(str(path))
            gmsh.finalize()
            cad = self.import_file(path)
        normal = [-25 / 1525 ** 0.5, -30 / 1525 ** 0.5, 0]
        hypotenuse = next(f for f in cad["topology"]["faces"] if f["surface"]["kind"] == "plane"
                          and abs(abs(sum(a * b for a, b in zip(f["surface"]["normal"], normal))) - 1) < 1e-6)
        ray = {"origin": [35, 5, -0.01], "axis": normal, "direction": [0, 0, 1], "length": 10.02}
        plane = {"origin": [20, 0, 0], "normal": [1, 0, 0]}
        # Swept both ways, the cut cuts the corner off and leaves the ring joined
        # to itself only along the corner edge, which is refused.
        with self.assertRaisesRegex(CadError, "touching itself"):
            self.sessions.prepare(self.request(cad, operation={"kind": "slice", "rays": [ray]}))
        # Drawn on the pocket face, it runs into that wall only: alone it opens
        # the ring, and a plane across the ring then separates three wall pieces.
        opened = self.sessions.prepare(self.request(cad, operation={"kind": "slice", "rays": [{**ray, "face": hypotenuse["id"]}]}))
        self.assertEqual(len(opened["topology"]["volumes"]), 1)
        self.assertEqual([f.get("openIn") for f in opened["topology"]["faces"] if not f["volumes"]], [opened["topology"]["volumes"][0]["id"]])
        cut = self.sessions.prepare(self.request(opened, operation={"kind": "slice", "planes": [plane]}))
        self.assertEqual(len(cut["topology"]["volumes"]), 3)
        self.assertAlmostEqual(cut["topology"]["volume"], cad["topology"]["volume"], places=5)

    def test_a_ring_cut_once_stays_open_until_a_second_cut_separates_it(self):
        import tempfile
        import cad_kernel
        gmsh = cad_kernel.geometry_module()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "frame.brep"
            gmsh.initialize(["frame-test", "-nopopup"], readConfigFiles=False)
            gmsh.option.setNumber("General.Terminal", 0)
            occ = gmsh.model.occ
            occ.cut([(3, occ.addBox(0, 0, 0, 40, 40, 10))], [(3, occ.addBox(10, 10, -1, 20, 20, 12))])
            occ.synchronize()
            gmsh.write(str(path))
            gmsh.finalize()
            cad = self.import_file(path)
        across = lambda y: {"origin": [20, y, -1], "axis": [0, 0, 1], "direction": [0, 1, 0], "length": 12}
        # One cut across a wall opens the frame: still one solid, the cut kept as a free face.
        opened = self.sessions.prepare(self.request(cad, operation={"kind": "slice", "rays": [across(-1)], "label": "Opened the frame"}))
        solids = opened["topology"]["volumes"]
        self.assertEqual(len(solids), 1)
        self.assertEqual([f.get("openIn") for f in opened["topology"]["faces"] if not f["volumes"]], [solids[0]["id"]])
        # A cut that stops inside the wall, or misses every solid, is still refused.
        with self.assertRaisesRegex(CadError, "slit"):
            self.sessions.prepare(self.request(opened, operation={"kind": "slice", "rays": [{**across(29), "length": 6}]}))
        with self.assertRaisesRegex(CadError, "did not divide"):
            self.sessions.prepare(self.request(opened, operation={"kind": "slice", "rays": [{**across(29), "origin": [60, 29, -1]}]}))
        # The second cut takes the first along: two pieces, no free face left.
        halves = self.sessions.prepare(self.request(opened, operation={"kind": "slice", "rays": [across(29)]}))
        self.assertEqual(len(halves["topology"]["volumes"]), 2)
        self.assertFalse([f for f in halves["topology"]["faces"] if not f["volumes"]])
        self.assertAlmostEqual(halves["topology"]["volume"], cad["topology"]["volume"], places=5)

    def test_fuse_merges_neighbors_and_keeps_the_rest_conforming(self):
        cad = self.import_file(ROOT / "examples/block.step")
        b = cad["topology"]["bounds"]
        thirds = [b[0] + (b[3] - b[0]) * k / 3 for k in (1, 2)]
        slabs = self.sessions.prepare(self.request(cad, operation={"kind": "slice", "planes": [{"origin": [x, 0, 0], "normal": [1, 0, 0]} for x in thirds]}))
        first, middle, last = sorted(slabs["topology"]["volumes"], key=lambda v: v["bounds"][0])
        with self.assertRaisesRegex(CadError, "share faces"):
            self.sessions.prepare(self.request(slabs, operation={"kind": "fuse", "volumeIds": [first["id"], last["id"]]}))
        with self.assertRaises(CadError):
            self.sessions.prepare(self.request(slabs, operation={"kind": "fuse", "volumeIds": [first["id"]]}))
        fused = self.sessions.prepare(self.request(slabs, operation={"kind": "fuse", "volumeIds": [first["id"], middle["id"]], "label": "Fused two slabs"}))
        topology = fused["topology"]
        self.assertEqual(len(topology["volumes"]), 2)
        self.assertAlmostEqual(topology["volume"], cad["topology"]["volume"], places=5)
        self.assertEqual(fused["history"][-1]["label"], "Fused two slabs")
        merged = max(topology["volumes"], key=lambda v: v["volume"])
        self.assertEqual(len(merged["faces"]), 6, "faces split by the removed interface are unified")
        shared = [f for f in topology["faces"] if len(f.get("volumes", [])) == 2]
        self.assertEqual(len(shared), 1, "the remaining slab still shares one conforming face")

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
        (staged,) = [entry["path"] for entry in self.sessions.records[cad["cadId"]]["staged"].values()]
        second = {"kind": "slice", "planes": [{"origin": [25, 0, 0], "normal": [1, 0, 0]}]}
        prepared = self.sessions.prepare(self.request(cad, operation=second))
        self.assertFalse(staged.exists())
        self.assertEqual(len(prepared["topology"]["volumes"]), 2)
        self.sessions.preview(self.request(prepared, operation=first))
        (staged,) = [entry["path"] for entry in self.sessions.records[cad["cadId"]]["staged"].values()]
        self.sessions.undo(self.request(prepared))
        self.assertFalse(staged.exists())
        with self.assertRaises(CadError):
            self.sessions.preview(self.request(prepared, operation=first))  # stale revision

    def test_each_previewed_operation_stays_staged_up_to_a_bound(self):
        cad = self.import_file(ROOT / "examples/block.step")
        cuts = [{"kind": "slice", "planes": [{"origin": [x, 0, 0], "normal": [1, 0, 0]}]} for x in (10, 20, 30)]
        for operation in cuts:
            self.sessions.preview(self.request(cad, operation=operation))
        record = self.sessions.records[cad["cadId"]]
        self.assertEqual(len(record["staged"]), 3)
        started = time.perf_counter()
        committed = self.sessions.prepare(self.request(cad, operation=cuts[0]))
        self.assertLess(time.perf_counter() - started, 0.5, "an earlier preview is still staged")
        self.assertEqual(committed["revision"], 1)
        self.assertNotIn("staged", record)
        self.assertEqual(sorted(p.name for p in (self.sessions.root / cad["cadId"]).glob("staged-*")), [])
        many = [{"kind": "slice", "planes": [{"origin": [5 + 4 * i, 0, 0], "normal": [1, 0, 0]}]} for i in range(MAX_STAGED + 2)]
        for operation in many:
            self.sessions.preview(self.request(committed, operation=operation))
        self.assertEqual(list(record["staged"]), [self.sessions.operation_key(op) for op in many[-MAX_STAGED:]])
        self.assertEqual(len(list((self.sessions.root / cad["cadId"]).glob("staged-*.brep"))), MAX_STAGED)

    def test_lite_preview_skips_the_display_tessellation_but_commits_the_full_result(self):
        path = ROOT / "examples/plate-hole.step"
        operation = {"kind": "slice", "planes": [{"origin": [0, 0, 0], "normal": [1, 0, 0]}], "label": "Through the hole"}
        reference = self.import_file(path)
        bounds = reference["topology"]["bounds"]
        operation["planes"][0]["origin"] = [(bounds[i] + bounds[i + 3]) / 2 for i in range(3)]
        expected = self.sessions.prepare(self.request(reference, operation=operation))
        cad = self.import_file(path)
        with self.assertRaises(CadError) as error:
            self.sessions.preview(self.request(cad, operation=operation, lite=1))
        self.assertEqual(error.exception.status, 400)
        lite = self.sessions.preview(self.request(cad, operation=operation, lite=True))
        self.assertEqual(lite["topology"], expected["topology"])
        self.assertEqual(lite["preview"], {"lite": True, "edges": expected["preview"]["edges"]})
        self.assertTrue(lite["staged"])
        full = self.sessions.preview(self.request(cad, operation=operation))
        self.assertEqual(full["preview"], expected["preview"])
        started = time.perf_counter()
        committed = self.sessions.prepare(self.request(cad, operation=operation))
        self.assertLess(time.perf_counter() - started, 0.5, "the lite preview is reused")
        self.assertEqual(committed["topology"], expected["topology"])
        self.assertEqual(committed["preview"], expected["preview"])
        # A lite preview that is committed straight away waits for its tessellation.
        again = self.sessions.preview(self.request(committed, operation={**operation, "label": "Again", "planes": [{**operation["planes"][0], "normal": [0, 1, 0]}]}, lite=True))
        self.assertNotIn("positions", again["preview"])
        final = self.sessions.prepare(self.request(committed, operation={**operation, "label": "Again", "planes": [{**operation["planes"][0], "normal": [0, 1, 0]}]}))
        self.assertGreater(len(final["preview"]["positions"]), 0)
        self.assertEqual(len(final["preview"]["positions"]), 9 * len(final["preview"]["triangleFaceIds"]))
        self.assertEqual({f["id"] for f in final["preview"]["faces"]}, {f["id"] for f in final["topology"]["faces"]})

    def test_concurrent_previews_of_one_session_are_each_staged(self):
        cad = self.import_file(ROOT / "examples/block.step")
        cuts = [{"kind": "slice", "planes": [{"origin": [x, 0, 0], "normal": [1, 0, 0]}]} for x in (10, 20, 30, 40)]
        with ThreadPoolExecutor(4) as pool:
            results = list(pool.map(lambda op: self.sessions.preview(self.request(cad, operation=op, lite=op is not cuts[0])), cuts))
        self.assertTrue(all(len(r["topology"]["volumes"]) == 2 for r in results))
        record = self.sessions.records[cad["cadId"]]
        self.assertEqual(set(record["staged"]), {self.sessions.operation_key(op) for op in cuts})
        committed = self.sessions.prepare(self.request(cad, operation=cuts[2]))
        self.assertEqual(committed["revision"], 1)
        self.assertGreater(len(committed["preview"]["positions"]), 0)
        self.assertEqual(list((self.sessions.root / cad["cadId"]).glob("staged-*")), [])


if __name__ == "__main__":
    unittest.main()
