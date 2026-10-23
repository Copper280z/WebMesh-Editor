"""Configured local solvers; detached, bounded jobs with immutable input hashes."""
from __future__ import annotations
import hashlib
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import uuid

MAX_DECK = 32 * 1024 * 1024
MAX_OUTPUT = 64 * 1024 * 1024
TIMEOUT = 300

class SolverError(Exception):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status
        self.log = ''

class SolverJobs:
    def __init__(self, configured=None):
        self.executables = {}
        for name in ('mystran', 'vibestran'):
            path = (configured or {}).get(name) or os.environ.get('WEBMESH_'+name.upper()) or shutil.which(name)
            if path:
                p = Path(path).expanduser().resolve()
                if p.is_file() and os.access(p, os.X_OK):
                    self.executables[name] = {'id': name, 'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
        self.temporary = tempfile.TemporaryDirectory(prefix='webmesh-solvers-')
        self.root = Path(self.temporary.name)
        self.jobs = {}
        self.threads = []
        self.lock = threading.RLock()
        self.closed = False

    def plugins(self):
        return [{'id': name, 'kind': 'solver', 'available': name in self.executables,
                 'features': ['SOL101'], **self.executables.get(name, {})} for name in ('mystran', 'vibestran')]

    def start(self, data):
        solver = data.get('solver')
        if solver not in self.executables:
            raise SolverError('Configure this solver with --solver '+str(solver)+'=PATH or WEBMESH_'+str(solver).upper()+'.', 503)
        deck = data.get('deck')
        if not isinstance(deck, str) or not 0 < len(deck.encode()) <= MAX_DECK:
            raise SolverError('The run requires a deck of at most 32 MiB.', 400)
        if not re.search(r'^SOL\s+101\b', deck, re.M|re.I) or not re.search(r'^ENDDATA\s*$', deck, re.M|re.I):
            raise SolverError('Only complete SOL 101 decks are supported.', 400)
        # Never permit the uploaded input to access arbitrary local paths or execute directives.
        if re.search(r'^\s*(INCLUDE|ASSIGN|ALTER|DMAP|SYSTEM)\b', deck, re.M|re.I):
            raise SolverError('Provide a self-contained deck without external-file or executable directives.', 400)
        with self.lock:
            if self.closed:
                raise SolverError('Solver service is stopping.', 503)
            if sum(j['status'] in ('queued','running') for j in self.jobs.values()) >= 2:
                raise SolverError('Two solver jobs are already running.', 409)
            if len(self.jobs) >= 20:
                raise SolverError('The session has 20 retained runs. Save results and restart the server.', 409)
            identity = dict(self.executables[solver])
            identity['sha256'] = hashlib.sha256(Path(identity['path']).read_bytes()).hexdigest()
            job_id = uuid.uuid4().hex
            folder = self.root / job_id
            folder.mkdir()
            (folder/'model.bdf').write_text(deck)
            job = {'id':job_id, 'solver':identity, 'deckDigest':hashlib.sha256(deck.encode()).hexdigest(),
                   'status':'queued', 'created':time.time(), 'exitCode':None, 'cancel':False, 'process':None, 'error':None}
            self.jobs[job_id] = job
            thread = threading.Thread(target=self._run, args=(job,folder),daemon=True)
            self.threads.append(thread)
            thread.start()
            return self.status({'id':job_id})

    def _run(self, job, folder):
        try:
            with (folder/'solver.log').open('w') as log:
                with self.lock:
                    if job['cancel']:
                        job['status']='cancelled'
                        return
                    if hashlib.sha256(Path(job['solver']['path']).read_bytes()).hexdigest() != job['solver']['sha256']:
                        raise SolverError('Solver executable changed before launch. Submit a new run.')
                    process = subprocess.Popen([job['solver']['path'],'model.bdf'],cwd=folder,stdout=log,stderr=subprocess.STDOUT,
                                               stdin=subprocess.DEVNULL,start_new_session=True)
                    job.update(process=process,status='running')
                deadline = time.monotonic()+TIMEOUT
                while process.poll() is None:
                    exceeded = any(p.stat().st_size > MAX_OUTPUT for p in folder.iterdir() if p.is_file())
                    if job['cancel'] or exceeded or time.monotonic()>deadline:
                        self._kill(process)
                        job['status']='cancelled' if job['cancel'] else 'failed'
                        job['error']=None if job['cancel'] else 'Solver time/output limit exceeded.'
                        break
                    time.sleep(.05)
                job['exitCode']=process.wait()
                if job['status']=='running':
                    if any(p.stat().st_size > MAX_OUTPUT for p in folder.iterdir() if p.is_file()):
                        job.update(status='failed',error='Solver time/output limit exceeded.')
                    elif job['exitCode']==0 and not (folder/'model.F06').is_file():
                        job.update(status='failed',error='Solver produced no model.F06 result.')
                    else:
                        job['status']='completed' if job['exitCode']==0 else 'failed'
        except Exception as exc:
            job.update(status='failed',error='Solver could not complete: '+str(exc))
        finally:
            job['process']=None
            job['finished']=time.time()

    @staticmethod
    def _kill(process):
        try:
            os.killpg(process.pid,signal.SIGKILL)
        except ProcessLookupError:
            pass

    def _job(self,data):
        job=self.jobs.get(data.get('id'))
        if not job:
            raise SolverError('Unknown solver job.',404)
        return job

    def status(self,data):
        with self.lock:
            job=self._job(data)
            result={k:v for k,v in job.items() if k not in ('process','cancel')}
        p=self.root/job['id']/'solver.log'
        if p.exists():
            with p.open('rb') as f:
                f.seek(max(0,p.stat().st_size-16000));result['logTail']=f.read(16000).decode(errors='replace')
        return result

    def cancel(self,data):
        with self.lock:
            job=self._job(data)
            if job['status'] in ('queued','running'):
                job['cancel']=True
        return self.status(data)

    def result(self,data):
        result=self.status(data)
        if result['status'] in ('queued','running'):
            raise SolverError('The solver is still running.',409)
        folder=self.root/result['id']
        for key,name in [('f06','model.F06'),('log','solver.log')]:
            p=folder/name
            if p.exists():
                if p.stat().st_size>MAX_OUTPUT:
                    result[key] = result.get('logTail', '') if key=='log' else ''
                    continue
                result[key]=p.read_text(errors='replace')
            else:
                result[key]=''
        return result

    def close(self):
        with self.lock:
            self.closed=True
            for job in self.jobs.values():
                job['cancel']=True
                if job['process']:
                    self._kill(job['process'])
        for thread in self.threads:
            thread.join(timeout=5)
        self.temporary.cleanup()
