"""Run with python3 -m unittest discover -s tests -p 'test_server.py' -v.

The integration cases use a real Gmsh executable when installed. They create CAD
files with Gmsh, send those files through the bridge, and verify mesh topology and
Nastran midside-edge ordering from coordinates rather than duplicating mappings.
"""

import base64
import http.client
import importlib.util
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("webmesh_server", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
GMSH = server.find_gmsh()


class RequestValidationTests(unittest.TestCase):
    def test_invalid_values_are_rejected(self):
        for changes in ({"size": float("nan")}, {"size": float("inf")}, {"size": 0}, {"size": "1; SystemCall"},
                        {"order": 3}, {"order": True}, {"dimension": 2}, {"topology": "pyramid"}, {"topology": []},
                        {"divisions": 0}, {"divisions": 81}, {"divisions": [1, 2]}, {"divisions": [1, True, 3]}):
            with self.subTest(changes=changes), self.assertRaises(server.MeshError):
                server.validate_request({"topology": "tet", **changes})

    def test_numeric_axis_divisions(self):
        self.assertEqual(server.validate_request({"topology": "hex", "divisions": [2, 3, 4]})[-1], [2, 3, 4])

    def test_request_limit_includes_cad_base64_overhead(self):
        self.assertGreater(server.MAX_REQUEST, ((server.MAX_CAD + 2) // 3) * 4 + 1024)

    def test_geo_programs_are_never_accepted(self):
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(server.MeshError) as caught:
            server.geometry_source({"format": "geo", "content": base64.b64encode(b'SystemCall "touch injected";').decode()}, Path(temporary))
        self.assertIn("not accepted", str(caught.exception))

    def test_uploaded_filename_is_ignored(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source, _ = server.geometry_source({"format": "step", "filename": '../../injected.geo"; SystemCall "echo bad',
                                               "content": base64.b64encode(b"ISO-10303-21;").decode()}, directory)
            self.assertEqual([path.name for path in directory.iterdir()], ["input.step"])
            self.assertNotIn("injected", source)

    def test_invalid_base64(self):
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(server.MeshError):
            server.geometry_source({"format": "step", "content": "not base64!!"}, Path(temporary))

    def test_missing_gmsh_has_useful_error(self):
        with self.assertRaises(server.MeshError) as caught:
            server.generate_mesh({"topology": "hex"}, None)
        self.assertEqual(caught.exception.status, 503)


class ShutdownTests(unittest.TestCase):
    def test_a_stopped_server_removes_its_cad_sessions_folder(self):
        for stop in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=stop.name):
                process = subprocess.Popen([sys.executable, "-u", str(ROOT / "server.py"), "--port", "0"], cwd=ROOT,
                                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                try:
                    folder = None
                    for _ in range(5):
                        line = process.stdout.readline()
                        if line.startswith("CAD sessions: "):
                            folder = Path(line.split(": ", 1)[1].strip())
                            break
                    self.assertTrue(folder and folder.is_dir(), "the server reports its sessions folder")
                    process.send_signal(stop)
                    process.wait(timeout=15)
                    self.assertFalse(folder.exists())
                finally:
                    if process.poll() is None:
                        process.kill()
                    process.stdout.close()

    def test_closing_the_warm_workers_removes_their_folder(self):
        warm = server.WarmWorkers(size=0)
        self.assertTrue(Path(warm.folder).is_dir())
        warm.close()
        self.assertFalse(Path(warm.folder).exists())


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.make_server(0, GMSH)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_health_and_no_cors(self):
        status, headers, body = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertIn("available", json.loads(body)["gmsh"])
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_dns_rebinding_host_rejected(self):
        self.assertEqual(self.request("GET", "/api/health", headers={"Host": "evil.example"})[0], 403)

    def test_cross_origin_rejected(self):
        self.assertEqual(self.request("POST", "/api/mesh", "{}", {"Content-Type": "application/json", "Origin": "https://evil.example"})[0], 403)

    def test_null_origin_rejected(self):
        self.assertEqual(self.request("POST", "/api/mesh", "{}", {"Content-Type": "application/json", "Origin": "null"})[0], 403)

    def test_cross_site_fetch_rejected(self):
        self.assertEqual(self.request("GET", "/api/health", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)

    def test_hidden_files_and_path_traversal_rejected(self):
        for path in ("/.git/config", "/%2egit/config", "/../server.py", "/%2e%2e/server.py"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 404)

    def test_json_content_type_required(self):
        self.assertEqual(self.request("POST", "/api/mesh", "{}")[0], 415)

    def test_malformed_json_rejected(self):
        self.assertEqual(self.request("POST", "/api/mesh", "{", {"Content-Type": "application/json"})[0], 400)

    def test_request_limit(self):
        self.assertEqual(self.request("POST", "/api/mesh", None, {"Content-Type": "application/json", "Content-Length": str(server.MAX_REQUEST + 1)})[0], 413)

    def test_concurrent_meshing_is_bounded(self):
        self.httpd.mesh_slot.acquire()
        try:
            self.assertEqual(self.request("POST", "/api/mesh", "{}", {"Content-Type": "application/json"})[0], 409)
        finally:
            self.httpd.mesh_slot.release()

    def test_previews_run_beside_a_mesh_and_queue_for_their_own_slots(self):
        preview = json.dumps({"cadId": "0" * 32, "revision": 0, "operation": {"kind": "slice"}})
        self.httpd.mesh_slot.acquire()
        try:
            self.assertEqual(self.request("POST", "/api/cad/preview", preview, {"Content-Type": "application/json"})[0], 404)
        finally:
            self.httpd.mesh_slot.release()
        for _ in range(server.PREVIEW_SLOTS):
            self.httpd.preview_slots.acquire()
        try:
            with patch.object(server, "PREVIEW_WAIT", 0.05):
                self.assertEqual(self.request("POST", "/api/cad/preview", preview, {"Content-Type": "application/json"})[0], 409)
        finally:
            for _ in range(server.PREVIEW_SLOTS):
                self.httpd.preview_slots.release()

    def test_sessions_can_be_listed_and_closed_while_a_mesh_runs(self):
        json_headers = {"Content-Type": "application/json"}
        self.httpd.mesh_slot.acquire()
        try:
            status, _, body = self.request("POST", "/api/cad/sessions", "{}", json_headers)
            self.assertEqual(status, 200)
            listed = json.loads(body)
            self.assertEqual(listed["budget"], 512 * 1024 * 1024)
            self.assertIsInstance(listed["sessions"], list)
            self.assertEqual(self.request("POST", "/api/cad/close", json.dumps({"cadId": "0" * 32}), json_headers)[0], 404)
            self.assertEqual(self.request("POST", "/api/cad/resume", json.dumps({"cadId": "0" * 32}), json_headers)[0], 404)
        finally:
            self.httpd.mesh_slot.release()
        # They take small requests only.
        self.assertEqual(self.request("POST", "/api/cad/sessions", "{" + " " * 5000 + "}", json_headers)[0], 413)

    def test_busy_service_rejects_before_reading_large_body(self):
        self.httpd.mesh_slot.acquire()
        try:
            # Deliberately send only headers. Reading the claimed body first
            # would block this connection instead of rejecting the busy request.
            self.assertEqual(self.request("POST", "/api/mesh", None,
                                           {"Content-Type": "application/json", "Content-Length": "1000000"})[0], 409)
        finally:
            self.httpd.mesh_slot.release()

    @unittest.skipUnless(GMSH, "Gmsh executable is not installed")
    def test_mesh_http_contract(self):
        payload = json.dumps({"geometry": {"kind": "block", "size": [2, 3, 4]},
                              "topology": "hex", "divisions": [2, 3, 4], "order": 2})
        status, _, body = self.request("POST", "/api/mesh", payload,
                                       {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}"})
        self.assertEqual(status, 200, body)
        result = json.loads(body)
        self.assertEqual(result["stats"]["elements"], 24)
        self.assertEqual(result["mesh"]["elements"][0]["type"], "CHEXA")
        self.assertEqual(len(result["mesh"]["elements"][0]["nodes"]), 20)


class WatchdogTests(unittest.TestCase):
    def run_guard(self, changes, file_name=None):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            if file_name:
                (directory / file_name).write_bytes(b"x" * 100)
            process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                with patch.multiple(server, **changes), self.assertRaises(server.MeshError) as caught:
                    server.watch_process(process, directory)
                self.assertIsNotNone(process.poll(), "Watchdog left the child process running")
                return caught.exception
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()

    def test_timeout_kills_and_reaps_child(self):
        error = self.run_guard({"MESH_TIMEOUT": 0.05})
        self.assertEqual(error.status, 504)

    def test_mesh_file_growth_kills_child(self):
        error = self.run_guard({"MAX_MESH": 50}, "mesh.msh")
        self.assertIn("output limit", str(error))

    def test_log_file_growth_kills_child(self):
        error = self.run_guard({"MAX_LOG": 50}, "gmsh.log")
        self.assertIn("output limit", str(error))

    def test_memory_limit_kills_child(self):
        with patch.object(server, "resident_bytes", return_value=server.MAX_RSS + 1):
            error = self.run_guard({"MESH_TIMEOUT": 1})
        self.assertIn("memory limit", str(error))

    def test_missing_rss_support_still_enforces_timeout(self):
        with patch.object(server, "resident_bytes", return_value=None):
            self.assertEqual(self.run_guard({"MESH_TIMEOUT": 0.05}).status, 504)


@unittest.skipUnless(GMSH, "Gmsh executable is not installed")
class GmshIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="webmesh-test-")
        cls.directory = Path(cls.temporary.name)
        (cls.directory / "block.geo").write_text('SetFactory("OpenCASCADE");\nBox(1) = {0,0,0,2,3,4};\nSave "block.step";\nSave "block.brep";\n')
        process = subprocess.run([GMSH, "block.geo", "-0", "-o", "block.brep", "-v", "2"], cwd=cls.directory,
                                 capture_output=True, text=True, timeout=20)
        if process.returncode:
            raise RuntimeError(process.stdout + process.stderr)
        cls.cad = {kind: base64.b64encode((cls.directory / ("block." + kind)).read_bytes()).decode() for kind in ("step", "brep")}
        subprocess.run([GMSH, "block.geo", "-2", "-o", "block.stl", "-v", "2"], cwd=cls.directory,
                       capture_output=True, text=True, timeout=20, check=True)
        cls.cad["stl"] = base64.b64encode((cls.directory / "block.stl").read_bytes()).decode()

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def mesh(self, topology, order=1, kind="step", **changes):
        return server.generate_mesh({"filename": "block." + kind, "format": kind, "content": self.cad[kind],
                                     "topology": topology, "order": order, "size": 1, "divisions": 2, **changes}, GMSH)

    def assert_edges(self, mesh, edges):
        coordinates = {node["id"]: (node["x"], node["y"], node["z"]) for node in mesh["nodes"]}
        for element in mesh["elements"]:
            ids = element["nodes"]
            for midpoint, (a, b) in edges.items():
                for component in range(3):
                    actual = coordinates[ids[midpoint]][component]
                    expected = (coordinates[ids[a]][component] + coordinates[ids[b]][component]) / 2
                    self.assertAlmostEqual(actual, expected, places=6,
                                           msg=f"Wrong Nastran midside slot {midpoint} on {element['type']} {element['id']}")

    def test_all_topologies_both_orders_from_step(self):
        for topology, types in (("tri", ("CTRIA3", "CTRIA6")), ("quad", ("CQUAD4", "CQUAD8")),
                                ("tet", ("CTETRA", "CTETRA")), ("hex", ("CHEXA", "CHEXA"))):
            for order in (1, 2):
                with self.subTest(topology=topology, order=order):
                    result = self.mesh(topology, order)
                    self.assertGreater(result["stats"]["elements"], 0)
                    self.assertEqual({element["type"] for element in result["mesh"]["elements"]}, {types[order - 1]})
                    count = server.ELEMENTS[server.EXPECTED[topology, order]][1]
                    self.assertTrue(all(len(element["nodes"]) == count for element in result["mesh"]["elements"]))

    def test_brep_import_structured_hex(self):
        result = self.mesh("hex", kind="brep", divisions=[2, 3, 4])
        self.assertEqual(result["stats"]["elements"], 24)
        self.assertEqual(result["stats"]["nodes"], 60)

    def test_closed_stl_surface_and_volume_meshing(self):
        for topology in ("tri", "tet"):
            for order in (1, 2):
                with self.subTest(topology=topology, order=order):
                    result = self.mesh(topology, order, kind="stl")
                    count = server.ELEMENTS[server.EXPECTED[topology, order]][1]
                    self.assertGreater(result["stats"]["elements"], 0)
                    self.assertTrue(all(len(element["nodes"]) == count for element in result["mesh"]["elements"]))

    def test_stl_hex_is_explicitly_unsupported(self):
        with self.assertRaises(server.MeshError) as caught:
            self.mesh("hex", kind="stl")
        self.assertIn("STL", str(caught.exception))

    def test_hex20_nastran_midside_order(self):
        result = self.mesh("hex", order=2, divisions=[2, 3, 4])
        self.assertEqual(result["stats"]["elements"], 24)
        self.assert_edges(result["mesh"], {8: (0, 1), 9: (1, 2), 10: (2, 3), 11: (3, 0),
                                          12: (4, 5), 13: (5, 6), 14: (6, 7), 15: (7, 4),
                                          16: (0, 4), 17: (1, 5), 18: (2, 6), 19: (3, 7)})

    def test_tet10_nastran_midside_order(self):
        self.assert_edges(self.mesh("tet", order=2)["mesh"], {4: (0, 1), 5: (1, 2), 6: (2, 0), 7: (0, 3), 8: (1, 3), 9: (2, 3)})

    def test_shell_second_order_midsides(self):
        self.assert_edges(self.mesh("tri", order=2)["mesh"], {3: (0, 1), 4: (1, 2), 5: (2, 0)})
        self.assert_edges(self.mesh("quad", order=2)["mesh"], {4: (0, 1), 5: (1, 2), 6: (2, 3), 7: (3, 0)})

    def test_incompatible_hex_explicitly_fails(self):
        with self.assertRaises(server.MeshError) as caught:
            server.generate_mesh({"geometry": {"kind": "cylinder", "size": [2, 3]}, "topology": "hex"}, GMSH)
        self.assertIn("six-sided", str(caught.exception))

    def test_malformed_cad_returns_log(self):
        with self.assertRaises(server.MeshError) as caught:
            server.generate_mesh({"format": "step", "content": base64.b64encode(b"not a CAD file").decode(), "topology": "tet"}, GMSH)
        self.assertTrue(caught.exception.log)

    def test_missing_volume_never_falls_back_to_surface(self):
        with self.assertRaises(server.MeshError):
            server.generate_mesh({"geometry": {"kind": "rectangle", "size": [2, 3]}, "topology": "tet"}, GMSH)

    def test_mixed_mesh_is_not_silently_filtered(self):
        # A 2D triangle mesh must never be accepted as a purported quad mesh.
        msh = self.directory / "wrong-topology.msh"
        msh.write_text("$MeshFormat\n2.2 0 8\n$EndMeshFormat\n$Nodes\n3\n1 0 0 0\n2 1 0 0\n3 0 1 0\n$EndNodes\n$Elements\n1\n1 2 2 0 1 1 2 3\n$EndElements\n")
        with self.assertRaises(server.MeshError) as caught:
            server.parse_msh(msh, "quad", 2, 1)
        self.assertIn("other element types", str(caught.exception))


@unittest.skipUnless(GMSH, "Gmsh executable is not installed")
class ExampleCADTests(unittest.TestCase):
    def mesh_example(self, name, topology, order):
        content = base64.b64encode((ROOT / "examples" / (name + ".step")).read_bytes()).decode()
        return server.generate_mesh({"filename": name + ".step", "format": "step", "content": content,
                                     "topology": topology, "order": order, "size": 10, "divisions": 6}, GMSH)

    def test_block_example_is_structured_hex_compatible(self):
        for order in (1, 2):
            with self.subTest(order=order):
                result = self.mesh_example("block", "hex", order)
                self.assertEqual(result["stats"]["elements"], 6 ** 3)
                self.assertEqual({element["type"] for element in result["mesh"]["elements"]}, {"CHEXA"})
                self.assertEqual(len(result["mesh"]["elements"][0]["nodes"]), 8 if order == 1 else 20)

    def test_plate_example_preserves_all_five_holes(self):
        holes = [(40, 25, 8), (10, 10, 3), (70, 10, 3), (70, 40, 3), (10, 40, 3)]
        for order in (1, 2):
            with self.subTest(order=order):
                result = self.mesh_example("plate-hole", "tet", order)
                self.assertGreater(result["stats"]["elements"], 0)
                for node in result["mesh"]["nodes"]:
                    for x, y, radius in holes:
                        self.assertGreaterEqual((node["x"] - x) ** 2 + (node["y"] - y) ** 2,
                                                radius ** 2 - 1e-4, "A generated node fills a CAD hole")

    def test_plate_example_rejects_incompatible_hex_meshing(self):
        with self.assertRaises(server.MeshError) as caught:
            self.mesh_example("plate-hole", "hex", 1)
        self.assertIn("six-sided", str(caught.exception))

    def test_plate_example_periodic_holes_support_pure_quads(self):
        for order in (1, 2):
            with self.subTest(order=order):
                result = self.mesh_example("plate-hole", "quad", order)
                expected = "CQUAD4" if order == 1 else "CQUAD8"
                self.assertGreater(result["stats"]["elements"], 0)
                self.assertEqual({element["type"] for element in result["mesh"]["elements"]}, {expected})
                self.assertEqual(result["stats"]["parts"], 11)


if __name__ == "__main__":
    unittest.main()
