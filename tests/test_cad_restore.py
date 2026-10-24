"""Transactions, portable undo/redo and exact reuse, without the CAD kernel."""
import base64
import gzip
import hashlib
import json
import threading
import time
import unittest
from unittest.mock import patch

import cad_sessions
import cad_persistence
from cad_sessions import CadSessions, CadError
from test_cad_sessions import runner, step, imported


def request(transaction='transaction-0001', scope='part-wheel', client='browser-0001', **extra):
    return dict(transaction=transaction, client=client, scope=scope, filename='wheel.step', format='step', content=base64.b64encode(b'CAD').decode(), **extra)


def finish(s, r, commit=True):
    return s.restore_finish(dict(transaction=r['transaction'], client=r['client'], commit=commit))


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.calls = 0
        def run(*args, **kwargs):
            self.calls += 1
            return runner(*args, **kwargs)
        self.s = CadSessions(run)
        self.addCleanup(self.s.temporary.cleanup)

    def test_repeated_legacy_reopen_reuses_at_full_capacity_and_different_scopes_do_not_alias(self):
        first = None
        with patch.object(cad_sessions, 'MAX_SESSIONS', 1):
            for i in range(30):
                r = request(transaction=f'transaction-{i:04}')
                cad = self.s.restore(r)
                finish(self.s, r)
                first = first or cad['cadId']
                self.assertEqual(cad['cadId'], first)
            self.assertEqual(self.calls, 1)
            self.assertEqual(len(self.s.records), 1)
            with self.assertRaises(CadError):
                self.s.restore(request('transaction-other', scope='another-part'))
        other = self.s.restore(request('transaction-third', client='browser-0002'))
        self.assertNotEqual(first, other['cadId'])

    def test_checkpoint_preserves_every_state_cursor_redo_and_metadata_on_another_server(self):
        r = request()
        cad = self.s.restore(r); finish(self.s, r)
        cad = step(self.s, cad, 'first'); cad = step(self.s, cad, 'second')
        cad = self.s.undo(cad)
        backup = self.s.export({**cad, 'checkpoint': True, 'draft': {'filename':'original.step','content':r['content'],'settings':{'size':2}}})
        self.assertEqual(self.s.resume(cad)['draft']['settings']['size'], 2)
        other = CadSessions(lambda *args: self.fail('Checkpoint restore must not reimport/renumber CAD'))
        self.addCleanup(other.temporary.cleanup)
        rr = request('restart-0001', checkpoint=backup['checkpoint'])
        restored = other.restore(rr); finish(other, rr)
        self.assertEqual(restored['history'], cad['history']);self.assertEqual(restored['cursor'], 1)
        oldstates = self.s.records[cad['cadId']]['states']; newstates = other.records[restored['cadId']]['states']
        self.assertEqual([x['path'].read_bytes() for x in oldstates], [x['path'].read_bytes() for x in newstates])
        self.assertEqual(restored['preview'], cad['preview'])
        redone = other.redo(restored);self.assertEqual(redone['topology']['label'], 'second')
        undone = other.undo(redone);self.assertEqual(undone['topology']['label'], 'first')
        again = other.restore(request('restart-0002', checkpoint=backup['checkpoint']))
        self.assertNotEqual(again['cadId'], restored['cadId'], 'a changed revision is a separate live draft even after undo')

    def test_saved_checkpoint_reuses_exact_live_revision_but_never_rewinds_new_edits(self):
        r=request();cad=self.s.restore(r);finish(self.s,r)
        cad=step(self.s,cad,'first')
        saved=self.s.export({**cad,'checkpoint':True})
        rr=request('transaction-0002',checkpoint=saved['checkpoint'])
        reused=self.s.restore(rr);finish(self.s,rr);self.assertEqual(reused['cadId'],cad['cadId'])
        edited=step(self.s,cad,'unsaved change')
        rr=request('transaction-0003',checkpoint=saved['checkpoint'])
        reopened=self.s.restore(rr);finish(self.s,rr)
        self.assertNotEqual(reopened['cadId'],edited['cadId'])
        self.assertEqual(self.s.resume(edited)['topology']['label'],'unsaved change')
        self.assertEqual(reopened['topology']['label'],'first')

    def test_abort_removes_only_created_candidates_not_reused_sessions(self):
        r=request();cad=self.s.restore(r);finish(self.s,r)
        rr=request('transaction-0002');self.s.restore(rr)
        new=self.s.restore({**rr,'scope':'chassis'})
        finish(self.s,rr,False);finish(self.s,rr,False)
        self.assertIn(cad['cadId'],self.s.records);self.assertNotIn(new['cadId'],self.s.records)
        self.assertFalse((self.s.root/new['cadId']).exists())

    def test_failed_second_import_aborts_first_and_leaves_previous_history(self):
        old=step(self.s,imported(self.s),'keep me')
        r=request();candidate=self.s.restore(r)
        with patch.object(self.s,'runner',side_effect=ValueError('kernel failure')):
            with self.assertRaisesRegex(ValueError,'kernel failure'):
                self.s.restore({**r,'scope':'second'})
        self.assertEqual(list(self.s.records),[old['cadId']]);self.assertFalse((self.s.root/candidate['cadId']).exists())
        self.assertEqual(self.s.resume(old)['cursor'],1)

    def test_late_kernel_completion_after_abort_leaves_no_session_or_folder(self):
        started,release=threading.Event(),threading.Event();errors=[]
        def slow(*args,**kwargs):
            started.set();release.wait(5);return runner(*args,**kwargs)
        r=request()
        with patch.object(self.s,'runner',slow):
            def restore():
                try:self.s.restore(r)
                except CadError as error:errors.append(error)
            worker=threading.Thread(target=restore);worker.start();self.assertTrue(started.wait(2))
            finish(self.s,r,False);release.set();worker.join(5)
        self.assertFalse(worker.is_alive());self.assertEqual(len(errors),1)
        self.assertEqual(self.s.records,{});self.assertEqual(list(self.s.root.iterdir()),[])

    def test_abandoned_candidates_expire_but_committed_and_edited_histories_do_not(self):
        r=request();kept=self.s.restore(r);finish(self.s,r)
        abandoned=self.s.restore(request('transaction-0002',scope='other'))
        edited=self.s.restore(request('transaction-0003',scope='edited'));edited=step(self.s,edited,'preserve')
        for record in self.s.records.values():record['lastUsed']=0
        for tx in self.s.persistence.transactions.values():tx['time']=0
        self.s.sessions({})
        self.assertIn(kept['cadId'],self.s.records);self.assertIn(edited['cadId'],self.s.records)
        self.assertNotIn(abandoned['cadId'],self.s.records);self.assertNotIn('provisional',self.s.records[edited['cadId']])

    def test_retries_are_idempotent_and_cross_workspace_abort_cannot_delete_a_candidate(self):
        r=request();first=self.s.restore(r);second=self.s.restore(r)
        self.assertEqual(first['cadId'],second['cadId']);self.assertEqual(self.calls,1)
        with self.assertRaises(CadError):finish(self.s,{**r,'client':'browser-other'},False)
        self.assertIn(first['cadId'],self.s.records)
        finish(self.s,r);finish(self.s,r);finish(self.s,r,False)
        self.assertIn(first['cadId'],self.s.records)

    def test_bad_archive_and_expansion_limits_do_not_create_sessions(self):
        cad=imported(self.s);saved=self.s.export({**cad,'checkpoint':True})['checkpoint']
        for i,cp in enumerate([{**saved,'sha256':'bad'},{**saved,'version':2},{**saved,'content':'bad'}]):
            with self.assertRaises(CadError):self.s.restore(request(transaction=f'bad-archive-{i}',checkpoint=cp))
        with patch.object(cad_persistence,'MAX_EXPANDED',100):
            with self.assertRaises(CadError):self.s.restore(request(transaction="expanded-limit",checkpoint=saved))
        self.assertEqual(list(self.s.records),[cad['cadId']])
        self.assertEqual(len(list(self.s.root.iterdir())),1)

    def test_failed_commit_does_not_remove_a_candidate_that_acquired_edits(self):
        r=request();cad=self.s.restore(r);cad=step(self.s,cad,'retain me')
        with self.assertRaisesRegex(CadError,'changed during restore'):finish(self.s,r)
        self.assertEqual(self.s.resume(cad)['topology']['label'],'retain me')

    def test_checkpoint_size_failure_never_shortens_history(self):
        cad=step(self.s,imported(self.s),'first');cad=step(self.s,cad,'second')
        with patch.object(cad_persistence,'MAX_ARCHIVE',50):
            with self.assertRaises(CadError):self.s.export({**cad,'checkpoint':True})
        self.assertEqual(self.s.resume(cad)['cursor'],2)
        self.assertEqual(len(self.s.records[cad['cadId']]['states']),3)

    def test_corrupt_second_checkpoint_also_aborts_prior_staging(self):
        r=request();candidate=self.s.restore(r)
        with self.assertRaises(CadError):self.s.restore({**r,'scope':'second','checkpoint':{'version':99}})
        self.assertNotIn(candidate['cadId'],self.s.records)
        self.assertEqual(list(self.s.root.iterdir()),[])

    def test_explicitly_resumed_candidate_survives_abort(self):
        r=request();candidate=self.s.restore(r)
        self.s.resume(candidate);finish(self.s,r,False)
        self.assertIn(candidate['cadId'],self.s.records)
