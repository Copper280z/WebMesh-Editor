"""Deterministic process isolation, cancellation, bounds, and identity tests."""
import hashlib
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from solver_service import SolverJobs, SolverError

DECK = 'SOL 101\nCEND\nBEGIN BULK\nENDDATA\n'
class SolverServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.binary = Path(self.temp.name) / 'solver'
        self.script("from pathlib import Path\nPath('model.F06').write_text('RESULTS')\nprint('completed')")
        self.jobs = SolverJobs({'mystran': str(self.binary)})
    def tearDown(self):
        self.jobs.close()
        self.temp.cleanup()
    def script(self, source):
        self.binary.write_text('#!'+sys.executable+'\n'+source+'\n')
        self.binary.chmod(0o700)
    def start(self):
        return self.jobs.start({'solver':'mystran','deck':DECK})
    def finish(self, job):
        end=time.monotonic()+5
        while time.monotonic()<end:
            state=self.jobs.status(job)
            if state['status'] not in ('queued','running'):
                return self.jobs.result(job)
            time.sleep(.02)
        self.fail('job did not terminate')
    def test_isolation_exact_input_output_and_current_binary_identity(self):
        self.script("from pathlib import Path\nassert Path.cwd().name != 'WebMesh-Editor'\nassert Path('model.bdf').read_text() == "+repr(DECK)+"\nPath('model.F06').write_text('RESULTS')")
        job=self.start();result=self.finish(job)
        self.assertEqual(result['status'],'completed')
        self.assertEqual(result['f06'],'RESULTS')
        self.assertEqual(result['deckDigest'],hashlib.sha256(DECK.encode()).hexdigest())
        self.assertEqual(result['solver']['sha256'],hashlib.sha256(self.binary.read_bytes()).hexdigest())
    def test_failed_exit_and_missing_output(self):
        for source in ["raise SystemExit(2)","print('no result')"]:
            self.script(source)
            self.assertEqual(self.finish(self.start())['status'],'failed')
    def test_cancellation_capacity_and_shutdown_reap_jobs(self):
        self.script('import time\ntime.sleep(60)')
        first,second=self.start(),self.start()
        with self.assertRaises(SolverError): self.start()
        self.jobs.cancel(first)
        self.assertEqual(self.finish(first)['status'],'cancelled')
        root=self.jobs.root
        self.jobs.close()
        self.assertFalse(root.exists())
        self.assertTrue(all(not t.is_alive() for t in self.jobs.threads))
    def test_timeout_and_output_limits(self):
        with patch('solver_service.TIMEOUT',.05):
            self.script('import time\ntime.sleep(10)')
            self.assertEqual(self.finish(self.start())['status'],'failed')
        with patch('solver_service.MAX_OUTPUT',64):
            self.script("from pathlib import Path\nimport time\nPath('big').write_text('x'*100)\ntime.sleep(10)")
            self.assertEqual(self.finish(self.start())['status'],'failed')
            self.script("from pathlib import Path\nPath('model.F06').write_text('x'*100)")
            result=self.finish(self.start())
            self.assertEqual(result['status'],'failed')
            self.assertEqual(result['f06'],'')
    def test_rejects_external_deck_directives_and_unconfigured_solvers(self):
        for token in ('INCLUDE','ASSIGN','SYSTEM','ALTER','DMAP'):
            with self.assertRaises(SolverError): self.jobs.start({'solver':'mystran','deck':DECK+token+' other\n'})
        with self.assertRaises(SolverError): self.jobs.start({'solver':'unconfigured','deck':DECK})
        with self.assertRaises(SolverError): self.jobs.status({'id':'missing'})
