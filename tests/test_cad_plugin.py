"""The Gmsh plugin boundary: the core works without Gmsh, and says so plainly where it cannot help."""

import base64
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch

import cad_gmsh_plugin
import cad_kernel
import server

ROOT = Path(__file__).resolve().parents[1]
CORE = ["cad_geom", "cad_kernel", "cad_sheets", "cad_shell", "cad_mapping", "cad_sessions", "quadmesh_bridge", "server"]
KERNEL = cad_kernel.available()
BODY = base64.b64encode((ROOT / "examples/block.step").read_bytes()).decode()


class PluginBoundaryTests(unittest.TestCase):
    def test_only_the_plugin_module_imports_gmsh(self):
        pattern = re.compile(r"^\s*(import gmsh\b|from gmsh\b)", re.MULTILINE)
        for module in sorted(path.stem for path in ROOT.glob("*.py")):
            source = (ROOT / f"{module}.py").read_text()
            self.assertEqual(bool(pattern.search(source)), module == "cad_gmsh_plugin", f"{module}.py")

    def test_blocking_the_plugin_makes_it_unavailable_and_load_says_how_to_fix_it(self):
        with patch.dict(os.environ, {cad_gmsh_plugin.BLOCK_ENV: "1"}):
            self.assertFalse(cad_gmsh_plugin.module_available())
            self.assertIsNone(cad_gmsh_plugin.find_executable())
            with self.assertRaisesRegex(ImportError, "pip install gmsh"):
                cad_gmsh_plugin.load()
            status = cad_gmsh_plugin.status()
        self.assertEqual((status["available"], status["blocked"], status["operations"]), (False, True, []))
        self.assertIn("not installed", status["note"])

    def test_the_plugin_takes_only_what_the_core_cannot_do(self):
        handles = cad_gmsh_plugin.handles
        self.assertFalse(handles({"input": "a.brep", "action": "import"}))
        self.assertFalse(handles({"input": "a.brep", "action": "prepare"}))
        self.assertFalse(handles({"input": "a.brep", "action": "shell", "element": "quad"}))
        self.assertTrue(handles({"input": "a.brep", "action": "shell", "element": "tri"}))
        self.assertTrue(handles({"input": "a.brep", "action": "mesh"}))
        self.assertTrue(handles({"input": "a.stl", "action": "import"}))
        self.assertTrue(handles({"input": "a.MSH", "action": "mesh"}))

    def test_health_reports_what_the_plugin_adds_and_what_is_off_without_it(self):
        with patch.dict(os.environ, {cad_gmsh_plugin.BLOCK_ENV: "1"}):
            report = server.health(server.find_gmsh())
        self.assertFalse(report["plugins"]["gmsh"]["available"])
        self.assertFalse(report["gmsh"]["available"])
        self.assertNotIn("stl", report["formats"])
        self.assertEqual(report["topologies"], ["hex"])
        self.assertTrue(any("Gmsh plugin" in note for note in report["notes"]))
        self.assertTrue({"slice", "defeature", "shell", "mapped", "join"} <= set(report["cad"]["operations"]))
        self.assertTrue(report["cad"]["available"])
        self.assertIn("OpenCASCADE", report["cad"]["kernel"])
        if cad_gmsh_plugin.module_available():
            self.assertTrue(server.health(server.find_gmsh())["plugins"]["gmsh"]["available"])


@unittest.skipUnless(KERNEL, "the OpenCASCADE kernel is not available")
class WithoutGmshTests(unittest.TestCase):
    """A server whose Gmsh plugin is blocked: the core answers, Gmsh-only requests are refused with the reason."""

    @classmethod
    def setUpClass(cls):
        cls.patch = patch.dict(os.environ, {cad_gmsh_plugin.BLOCK_ENV: "1"})
        cls.patch.start()
        cls.httpd = server.make_server(0, None)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.httpd.cad_sessions.temporary.cleanup()
        cls.patch.stop()

    def post(self, path, payload):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=120)
        try:
            connection.request("POST", path, json.dumps(payload), {"Content-Type": "application/json", "Host": f"127.0.0.1:{self.port}"})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def imported(self):
        status, body = self.post("/api/cad/import", {"filename": "block.step", "format": "step", "content": BODY})
        self.assertEqual(status, 200, body)
        return {"cadId": body["cadId"], "revision": body["revision"]}, body

    def test_import_preparation_and_quad_shells_work(self):
        token, cad = self.imported()
        self.assertEqual(len(cad["topology"]["faces"]), 6)
        status, prepared = self.post("/api/cad/prepare", {**token, "operation": {"kind": "split", "axis": "x", "position": 50}})
        self.assertEqual((status, len(prepared["topology"]["volumes"])), (200, 2))
        status, shell = self.post("/api/cad/shell", {"cadId": prepared["cadId"], "revision": prepared["revision"], "size": 20, "mesher": "recombined"})
        if status == 200:
            self.assertTrue(all(e["type"] == "CQUAD4" for e in shell["mesh"]["elements"]))
        else:
            self.assertEqual(status, 503, shell)  # the quad mesher libraries may not be built here

    def test_gmsh_only_requests_are_refused_with_the_reason(self):
        token, _ = self.imported()
        for path, payload, what in (
                ("/api/cad/mesh", {**token, "topology": "tet", "order": 1, "size": 10}, "Gmsh meshing"),
                ("/api/cad/shell", {**token, "size": 10, "element": "tri"}, "Triangle shell meshing"),
                ("/api/cad/import", {"filename": "part.stl", "format": "stl", "content": base64.b64encode(b"solid x\nendsolid x\n").decode()}, "STL import")):
            with self.subTest(path=path):
                status, body = self.post(path, payload)
                self.assertEqual(status, 503, body)
                self.assertIn(what, body["error"])
                self.assertIn("Gmsh plugin", body["error"])
                self.assertIn("pip install gmsh", body["error"])

    def test_the_worker_refuses_a_plugin_task_cleanly_when_called_directly(self):
        folder = ROOT / "examples"
        with patch.dict(os.environ, {cad_gmsh_plugin.BLOCK_ENV: "1"}), self.assertRaisesRegex((ImportError, ValueError), "Gmsh plugin is not installed"):
            cad_kernel.execute({"action": "mesh", "input": str(folder / "block.step"), "output": None, "topology": "tet", "size": 10})


@unittest.skipUnless(KERNEL, "the OpenCASCADE kernel is not available")
class CoreWorksWhenGmshCannotBeImportedTests(unittest.TestCase):
    def test_import_prepare_shell_and_preview_with_the_gmsh_import_made_to_fail(self):
        script = """
import os, sys, tempfile
sys.modules['gmsh'] = None  # any 'import gmsh' now raises ImportError
sys.path.insert(0, sys.argv[1])
import cad_kernel
work = tempfile.mkdtemp()
t = cad_kernel.execute({'action': 'import', 'input': sys.argv[1] + '/examples/plate-hole.step', 'output': work + '/a.brep'})
assert len(t['topology']['faces']) == 11 and t['preview']['positions'], 'import'
feature = t['topology']['features'][0]['faceId']
p = cad_kernel.execute({'action': 'prepare', 'input': work + '/a.brep', 'output': work + '/b.brep', 'sheets': [], 'operation': {'kind': 'defeature', 'faceIds': [feature]}})
assert p['topology']['volume'] > t['topology']['volume'], 'defeature'
s = cad_kernel.execute({'action': 'shell', 'input': work + '/b.brep', 'output': None, 'size': 6, 'mesher': 'recombined', 'sheets': []})
assert s['quality']['elements'] > 100 and not s['quality']['failedFaces'], 'shell'
assert 'gmsh' not in sys.modules or sys.modules['gmsh'] is None
print('core ok')
"""
        done = subprocess.run([sys.executable, "-c", script, str(ROOT)], capture_output=True, text=True, timeout=300)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("core ok", done.stdout)


if __name__ == "__main__":
    unittest.main()
