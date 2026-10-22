import importlib.util
import math
from pathlib import Path
import sys
import unittest

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("quadmesh", root / "bindings/python/quadmesh.py")
quadmesh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quadmesh)
mesher = quadmesh.Mesher(sys.argv.pop(1))


class BindingTests(unittest.TestCase):
    def test_fixed_boundary_and_owned_results(self):
        points = [(0, 0), (10, 0), (10, 10), (0, 10)]
        loops = [{"points": points, "fixed_runs": [{"nodes": points, "closed": True}]}]
        first = mesher.mesh(loops, target_size=3, enable_smoothing=True)
        second = mesher.mesh(loops, target_size=3, enable_smoothing=True)
        self.assertTrue(first["valid"], first["issues"])
        self.assertEqual(first, second)
        self.assertEqual(len(first["boundary_nodes"]), 4)
        self.assertEqual(len(first["quality"]), len(first["quads"]))
        for source in first["boundary_nodes"]:
            self.assertEqual(first["nodes"][source["node"]], points[source["fixed_node"]])

    def test_failure_then_success(self):
        points = [(math.cos(k * 2 * math.pi / 9), math.sin(k * 2 * math.pi / 9)) for k in range(9)]
        with self.assertRaisesRegex(ValueError, "odd boundary"):
            mesher.mesh([{"points": points, "fixed_runs": [{"nodes": points, "closed": True}]}])
        result = mesher.mesh([{"points": [(0, 0), (10, 0), (10, 10), (0, 10)]}], target_size=2)
        self.assertTrue(result["valid"])


unittest.main()
