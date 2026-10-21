"""Guard oversized allocations and misleading CAD preparation results."""
import base64
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import cad_gmsh_plugin
import server
from cad_kernel import available, geometry_module, prepare
from cad_sessions import CadError, CadSessions

ROOT = Path(__file__).resolve().parents[1]
KERNEL = available()
PLUGIN = cad_gmsh_plugin.module_available()

# Gmsh and OpenCASCADE's Python binding must not share a process, so the plugin's guard
# runs where only Gmsh is loaded.
GRID_GUARD = """
import sys
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import cad_gmsh_plugin, cad_kernel
from cad_sweep import generate
gmsh = cad_gmsh_plugin.load()
gmsh.initialize(readConfigFiles=False, interruptible=False)
gmsh.option.setNumber('General.Terminal', 0)
gmsh.model.occ.importShapes(sys.argv[2])
gmsh.model.occ.synchronize()
for order, divisions in ((1, 80), (2, 50)):
    with patch.object(gmsh.model.mesh, 'generate', side_effect=AssertionError('Mesher must not allocate this grid')):
        try:
            generate(gmsh, {'topology': 'hex', 'method': 'mapped', 'divisions': divisions, 'order': order, 'size': 1}, cad_kernel.topology, cad_gmsh_plugin.mesh_quality)
        except ValueError as error:
            assert 'exceeding the 500,000 limit before generation' in str(error), str(error)
        else:
            raise SystemExit('the oversized grid was accepted')
print('guarded')
"""


@unittest.skipUnless(KERNEL, 'The CAD geometry kernel is unavailable')
class CadGuardTests(unittest.TestCase):
    def setUp(self):
        self.gmsh = geometry_module()
        self.gmsh.initialize(readConfigFiles=False, interruptible=False)
        self.gmsh.option.setNumber('General.Terminal', 0)
        self.gmsh.model.occ.importShapes(str(ROOT / 'examples/block.step'))
        self.gmsh.model.occ.synchronize()

    def tearDown(self):
        self.gmsh.finalize()

    def test_clean_solid_healing_rejects_a_representation_reorder_as_noop(self):
        with self.assertRaisesRegex(ValueError, 'no geometry, topology, or tolerance repairs'):
            prepare(self.gmsh, {'kind':'heal'})

    def test_healing_cannot_silently_change_solid_material_volume(self):
        def faulty_heal(volumes, **_):
            self.gmsh.model.occ.dilate(volumes, 0, 0, 0, 2, 1, 1)
        with patch.object(self.gmsh.model.occ, 'healShapes', side_effect=faulty_heal):
            with self.assertRaisesRegex(ValueError, 'change solid material volume'):
                prepare(self.gmsh, {'kind':'heal'})


@unittest.skipUnless(KERNEL and PLUGIN, 'The Gmsh plugin is unavailable')
class GmshGuardTests(unittest.TestCase):
    def test_oversized_mapped_grids_reject_before_mesher_allocation(self):
        done = subprocess.run([sys.executable, '-c', GRID_GUARD, str(ROOT), str(ROOT / 'examples/block.step')],
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn('guarded', done.stdout)


@unittest.skipUnless(KERNEL, 'The CAD geometry kernel is unavailable')
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
