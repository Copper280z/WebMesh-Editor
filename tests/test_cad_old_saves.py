"""A project saved with the earlier Gmsh-based kernel reloads with the same entity numbers.

A saved project carries the prepared BREP snapshot of its CAD session, and the
IDs of the sizing edges, pads, sheets and meshed bodies refer to that snapshot's
numbering. These snapshots were written by the original kernel; the tables in
numbering.json are what that kernel reported for them (centre, size and
neighbours of every entity). The OpenCASCADE kernel must number them the same
way, so nothing needs remapping when an old project is restored.
"""

import json
import math
from pathlib import Path
import shutil
import tempfile
import unittest

import cad_kernel
import quadmesh_bridge

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "old_saves"
KERNEL = cad_kernel.available()


@unittest.skipUnless(KERNEL, "the CAD geometry kernel is not available")
class OldSavedProjectTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.folder, True)

    def restore(self, name, sheets=None):
        request = {"action": "import", "input": str(FIXTURES / name), "output": str(self.folder / "state.brep")}
        if sheets is not None:
            request["sheets"] = sheets
        return cad_kernel.execute(request)["topology"]

    def test_every_entity_keeps_its_number_centre_size_and_neighbours(self):
        recorded = json.loads((FIXTURES / "numbering.json").read_text())
        for name, table in recorded.items():
            geom = cad_kernel.geometry_module()
            geom.initialize()
            geom.model.occ.importShapes(str(FIXTURES / name), highestDimOnly=False)
            geom.model.occ.synchronize()
            m, o = geom.model, geom.model.occ
            for dim in range(4):
                with self.subTest(name=name, dim=dim):
                    self.assertEqual(sorted(int(t) for t in table[str(dim)]), [t for _, t in m.getEntities(dim)])
                    for tag, expected in table[str(dim)].items():
                        tag = int(tag)
                        centre = list(m.getValue(0, tag, [])) if dim == 0 else list(o.getCenterOfMass(dim, tag))
                        self.assertLess(math.dist(centre, expected["c"]), 1e-4, f"entity {dim}/{tag}")
                        if dim:
                            self.assertAlmostEqual(o.getMass(dim, tag), expected["m"], delta=1e-4 * max(1.0, abs(expected["m"])))
                            up, down = m.getAdjacencies(dim, tag)
                            self.assertEqual(sorted(int(x) for x in up), expected["up"], f"entity {dim}/{tag}")
                            self.assertEqual(sorted({int(x) for x in down}), expected["down"], f"entity {dim}/{tag}")

    def test_saved_sheets_still_name_their_faces(self):
        sheets = json.loads((FIXTURES / "tube_sheets_joined.sheets.json").read_text())
        topology = self.restore("tube_sheets_joined.brep", sheets)
        self.assertEqual(topology["sheets"], sheets)
        faces = {face["id"]: face for face in topology["faces"]}
        for record in sheets:
            self.assertEqual(faces[record["face"]]["volumes"], [], "a sheet is a face of no solid")
            recorded = json.loads((FIXTURES / "numbering.json").read_text())["tube_sheets_joined.brep"]["2"][str(record["face"])]["m"]
            self.assertAlmostEqual(faces[record["face"]]["area"], recorded, delta=1e-4 * recorded)

    @unittest.skipUnless(quadmesh_bridge.available("paved"), "the paved mesher library is not built")
    def test_a_saved_sheet_model_meshes_with_its_saved_thickness(self):
        sheets = json.loads((FIXTURES / "tube_sheets_joined.sheets.json").read_text())
        result = cad_kernel.execute({"action": "shell", "input": str(FIXTURES / "tube_sheets_joined.brep"), "output": None, "size": 6,
                                     "mesher": "paved", "faceIds": [r["face"] for r in sheets], "sheets": sheets})
        self.assertFalse(result["quality"]["failedFaces"])
        self.assertEqual(result["thicknessByProperty"], {"1": 4.0})

    def test_a_ring_cut_once_is_still_an_open_cut_of_its_solid(self):
        topology = self.restore("frame_opened.brep")
        (solid,) = topology["volumes"]
        free = [face for face in topology["faces"] if not face["volumes"]]
        self.assertEqual([(face["id"], face["openIn"]) for face in free], [(13, solid["id"])])


if __name__ == "__main__":
    unittest.main()
