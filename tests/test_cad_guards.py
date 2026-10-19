"""Guard oversized allocations and misleading CAD preparation results."""
import base64
from pathlib import Path
import unittest
from unittest.mock import patch

import server
from cad_kernel import gmsh_module, mesh_quality, prepare, topology
from cad_sessions import CadError, CadSessions
from cad_sweep import generate

ROOT = Path(__file__).resolve().parents[1]
KERNEL = (Path('/opt/homebrew/opt/gmsh/lib/gmsh.py').exists()
          or Path('/usr/local/opt/gmsh/lib/gmsh.py').exists()
          or server.importlib.util.find_spec('gmsh') is not None)


@unittest.skipUnless(KERNEL, 'Gmsh/OpenCASCADE is unavailable')
class CadGuardTests(unittest.TestCase):
    def setUp(self):
        self.gmsh = gmsh_module()
        self.gmsh.initialize(readConfigFiles=False, interruptible=False)
        self.gmsh.option.setNumber('General.Terminal', 0)
        self.gmsh.model.occ.importShapes(str(ROOT / 'examples/block.step'))
        self.gmsh.model.occ.synchronize()

    def tearDown(self):
        self.gmsh.finalize()

    def test_oversized_mapped_grids_reject_before_mesher_allocation(self):
        for order, divisions in ((1, 80), (2, 50)):
            with self.subTest(order=order), patch.object(self.gmsh.model.mesh, 'generate', side_effect=AssertionError('Mesher must not allocate this grid')):
                with self.assertRaisesRegex(ValueError, 'exceeding the 500,000 limit before generation'):
                    generate(self.gmsh, {'topology':'hex', 'method':'mapped', 'divisions':divisions,
                                         'order':order, 'size':1}, topology, mesh_quality)

    def test_clean_solid_healing_rejects_a_representation_reorder_as_noop(self):
        with self.assertRaisesRegex(ValueError, 'no geometry, topology, or tolerance repairs'):
            prepare(self.gmsh, {'kind':'heal'})

    def test_healing_cannot_silently_change_solid_material_volume(self):
        def faulty_heal(volumes, **_):
            self.gmsh.model.occ.dilate(volumes, 0, 0, 0, 2, 1, 1)
        with patch.object(self.gmsh.model.occ, 'healShapes', side_effect=faulty_heal):
            with self.assertRaisesRegex(ValueError, 'change solid material volume'):
                prepare(self.gmsh, {'kind':'heal'})


@unittest.skipUnless(KERNEL, 'Gmsh/OpenCASCADE is unavailable')
class CadHealingTransactionTests(unittest.TestCase):
    def test_noop_heal_keeps_revision_and_prior_snapshot(self):
        sessions=CadSessions(server.run_cad_worker)
        try:
            path=ROOT/'examples/block.step'
            cad=sessions.import_cad({'filename':path.name,'format':'step','content':base64.b64encode(path.read_bytes()).decode()})
            request={'cadId':cad['cadId'],'revision':cad['revision']}
            with self.assertRaisesRegex(CadError, 'previous CAD was retained'):
                sessions.prepare({**request,'operation':{'kind':'heal'}})
            _, record=sessions.lookup(request)
            self.assertEqual(record['revision'],0)
            self.assertEqual(len(record['states']),1)
            self.assertTrue(record['states'][0]['path'].is_file())
        finally:
            sessions.temporary.cleanup()


if __name__=='__main__':
    unittest.main()
