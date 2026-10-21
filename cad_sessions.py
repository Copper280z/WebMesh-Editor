"""Bounded, immutable CAD snapshots for the local WebMesh bridge.

Requests can arrive on several threads at once: previews run side by side.
Session records are read and changed only under one lock, CAD workers run
outside it, and a worker's result is kept only if its session has not moved
on to another revision in the meantime.
"""

import base64
import binascii
from collections import OrderedDict
import gzip
import json
from pathlib import Path
import queue
import re
import shutil
import tempfile
import threading
import time
import uuid


# Undoable preparation steps per session; total snapshot storage is bounded separately.
MAX_SNAPSHOTS = 96
# Previewed results kept per session for its current revision, least recently used first out.
MAX_STAGED = 8
# Stored snapshots of all sessions together. When it fills, previews go first;
# sessions are never closed to make room: the user closes them (Sessions).
BUDGET = 512 * 1024 * 1024
MAX_SESSIONS = 24
IDLE = 24 * 3600  # a session unused this long is closed
CHANGED = "The CAD geometry changed. Refresh it before applying this operation."


def full(used):
    return CadError(f"CAD storage is full ({used / 1048576:.0f} of {BUDGET // 1048576} MiB). Close sessions you no longer need under "
                    "Sessions, below the file name in CAD & mesh.", 507)


class CadError(Exception):
    def __init__(self, message, status=422, log=""):
        super().__init__(message)
        self.status, self.log = status, log


def dumps(value):
    return json.dumps(value, allow_nan=False, separators=(",", ":"))


def pack(value):
    """A result as stored: compact JSON, gzipped (display data shrinks about 3.5 times)."""
    return gzip.compress(dumps(value).encode(), compresslevel=3)


def unpack(path):
    raw = path.read_bytes()
    return json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)


def size_of(paths):
    total = 0
    for path in paths:
        try:
            total += path.stat().st_size
        except FileNotFoundError:
            pass
    return total


def files_of(item):
    """The files of a kept state or a staged preview."""
    return [item["path"], item["path"].with_suffix(".cache.json"), item["json"]]


def lite_view(result):
    """A lite preview response: the topology and edge polylines, without the display tessellation."""
    preview = result.get("preview") or {}
    return {**result, "preview": {"lite": True, "edges": preview.get("edges", [])}}


def drop_snapshot(path):
    """Remove a snapshot together with the kernel's per-entity cache beside it."""
    path.unlink(missing_ok=True)
    path.with_suffix(".cache.json").unlink(missing_ok=True)


class CadSessions:
    def __init__(self, runner):
        # A preview still writing while the server stops must not stop the cleanup.
        self.temporary = tempfile.TemporaryDirectory(prefix="webmesh-cad-sessions-", ignore_cleanup_errors=True)
        self.root = Path(self.temporary.name)
        self.records = {}
        self.runner = runner
        self.lock = threading.RLock()

    def total_size(self):
        total = 0
        for path in self.root.rglob("*"):
            try:
                if path.is_file():
                    total += path.stat().st_size
            except FileNotFoundError:
                pass  # a preview worker removed it meanwhile
        return total

    def close(self, key):
        record = self.records.pop(key)
        self.discard_staged(record)
        shutil.rmtree(self.root / key, ignore_errors=True)

    def prune(self):
        expired = [key for key, record in self.records.items() if time.time() - record["lastUsed"] > IDLE]
        for key in expired:
            self.close(key)

    def relieve(self, limit=BUDGET, keep=()):
        """Drop finished previews, least recently used sessions first, until storage
        is within `limit`. Lock held. Returns the storage in use."""
        total = self.total_size()
        if total <= limit:
            return total
        finished = [(record["lastUsed"], key, operation_key, entry) for key, record in self.records.items()
                    for operation_key, entry in (record.get("staged") or {}).items() if entry["ready"].is_set() and entry not in keep]
        for _, key, operation_key, entry in sorted(finished, key=lambda item: item[0]):
            if total <= limit:
                break
            total -= size_of(files_of(entry))
            self.records[key]["staged"].pop(operation_key, None)
            self.drop(entry)
        return total

    def lookup(self, data):
        key = data.get("cadId")
        if not isinstance(key, str) or not re.fullmatch(r"[0-9a-f]{32}", key) or key not in self.records:
            raise CadError("CAD session expired or was not found. Import the geometry again, or resume it under Sessions.", 404)
        record = self.records[key]
        if type(data.get("revision")) is not int or data["revision"] != record["revision"]:
            raise CadError(CHANGED, 409)
        record["lastUsed"] = time.time()
        return key, record

    def moved_on(self, key, record, revision):
        """The error for a worker whose session was closed or changed revision while it ran."""
        if self.records.get(key) is not record or record["revision"] != revision:
            return CadError(CHANGED, 409)
        return None

    def payload(self, key, record):
        state = record["states"][record["cursor"]]
        result = unpack(state["json"])
        # History lists every kept state; those after `cursor` were undone and can be redone.
        result.update(cadId=key, revision=record["revision"], filename=record["filename"], cursor=record["cursor"],
                      history=[{"revision": item["revision"], "operation": item["operation"], "label": item["label"]}
                               for item in record["states"]])
        return result

    def import_cad(self, data):
        kind = data.get("format", "").lower() if isinstance(data.get("format"), str) else ""
        kind = {"stp": "step", "igs": "iges"}.get(kind, kind)
        if kind not in {"step", "iges", "brep", "stl"}:
            raise CadError("Import STEP, IGES, BREP, or STL geometry.", 400)
        content = data.get("content")
        if not isinstance(content, str) or len(content) > 32 * 1024 * 1024:
            raise CadError("CAD must be base64 data no larger than 24 MiB.", 400)
        try:
            raw = base64.b64decode(content, validate=True)
        except (ValueError, binascii.Error) as error:
            raise CadError("CAD content is not valid base64.", 400) from error
        if not raw or len(raw) > 24 * 1024 * 1024:
            raise CadError("CAD must contain between 1 byte and 24 MiB.", 400)
        key = uuid.uuid4().hex
        folder = self.root / key
        folder.mkdir()
        source = folder / ("original." + kind)
        source.write_bytes(raw)
        try:
            snapshot = folder / ("state-0.msh" if kind == "stl" else "state-0.brep")
            result = self.runner({"action": "import"}, source, snapshot)
            json_path = folder / "state-0.json.gz"
            json_path.write_bytes(pack(result))
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        filename = data.get("filename")
        filename = Path(filename).name[:200] if isinstance(filename, str) else "Geometry." + kind
        with self.lock:
            # A new import never closes another session: it waits for the user to.
            self.prune()
            if len(self.records) >= MAX_SESSIONS:
                shutil.rmtree(folder, ignore_errors=True)
                raise CadError(f"{len(self.records)} CAD sessions are open. Close sessions you no longer need under Sessions, below the file name in CAD & mesh.", 507)
            used = self.relieve()
            if used > BUDGET:
                shutil.rmtree(folder, ignore_errors=True)
                raise full(used)
            now = time.time()
            self.records[key] = {"filename": filename, "revision": 0, "cursor": 0, "lastUsed": now, "created": now,
                                 "discrete": kind == "stl", "source": source,
                                 "states": [{"path": snapshot, "json": json_path,
                                             "revision": 0, "operation": {"kind": "import"}, "label": "Imported geometry"}]}
            return self.payload(key, self.records[key])

    @staticmethod
    def operation_key(operation):
        return json.dumps(operation, sort_keys=True, allow_nan=False, separators=(",", ":"))

    # Staged previews. Each entry is one previewed operation on one revision:
    # its BREP, and its result JSON once "ready" is set. A lite preview's entry
    # holds the lite result in memory while its worker finishes tessellating.

    def drop(self, entry):
        entry["discarded"] = True
        if not entry["ready"].is_set() and entry["cancel"]:
            entry["cancel"]()
        drop_snapshot(entry["path"])
        entry["json"].unlink(missing_ok=True)

    def discard_staged(self, record):
        """Forget every previewed result and stop the previews still running: the revision moves on."""
        for entry in record.pop("staged", {}).values():
            self.drop(entry)
        for cancel in list(record.pop("workers", {}).values()):
            cancel()

    def staged_entry(self, record, operation_key):
        staged = record.get("staged")
        entry = staged.get(operation_key) if staged else None
        if entry is None or entry["base"] != record["revision"]:
            return None
        staged.move_to_end(operation_key)
        return entry

    def keep(self, key, record, entry):
        """Stage a previewed result unless its session moved on. Returns the entry now staged for its operation."""
        if self.moved_on(key, record, entry["base"]):
            self.drop(entry)
            return None
        staged = record.setdefault("staged", OrderedDict())
        current = staged.get(entry["key"])
        if current is not None:
            # The same preview ran twice at once: keep the first.
            self.drop(entry)
            staged.move_to_end(entry["key"])
            return current
        staged[entry["key"]] = entry
        while len(staged) > MAX_STAGED:
            self.drop(staged.pop(next(iter(staged))))
        self.relieve(keep=(entry,))
        return entry

    def staged_result(self, entry, full):
        """The staged result, or None if it was discarded. A full result waits for the tessellation."""
        if full:
            entry["ready"].wait()
        with self.lock:
            if entry["discarded"]:
                return None
            if not entry["ready"].is_set():
                return dict(entry["lite"])
            if entry["failed"]:
                raise entry["failed"]
            result = unpack(entry["json"])
        return result if full else lite_view(result)

    def run_preview(self, key, record, base, operation, operation_key, source, lite):
        output = self.root / key / f"staged-{uuid.uuid4().hex[:8]}.brep"
        entry = {"base": base, "key": operation_key, "path": output, "json": output.with_suffix(".json.gz"),
                 "ready": threading.Event(), "failed": None, "lite": None, "cancel": None, "discarded": False}
        token = object()

        def started(cancel):
            with self.lock:
                entry["cancel"] = cancel
                if self.moved_on(key, record, base):
                    cancel()
                else:
                    record.setdefault("workers", {})[token] = cancel

        def stopped():
            with self.lock:
                record.get("workers", {}).pop(token, None)

        request = {"action": "prepare", "operation": operation}
        if not lite:
            try:
                result = self.runner(request, source, output, started=started)
                entry["json"].write_bytes(pack(result))
            except Exception as error:
                drop_snapshot(output)
                entry["json"].unlink(missing_ok=True)
                with self.lock:
                    moved = self.moved_on(key, record, base)
                if moved:
                    raise moved from None
                raise
            finally:
                stopped()
            entry["ready"].set()
            with self.lock:
                kept = self.keep(key, record, entry)
            if kept is None:
                raise CadError(CHANGED, 409)
            return kept

        # Lite: reply with the worker's early result; it keeps running to finish
        # the display tessellation that committing this result needs.
        handoff = queue.Queue()

        def early(result):
            entry["lite"] = result
            handoff.put(("early", None))

        def work():
            try:
                result = self.runner(request, source, output, early=early, started=started)
                blob = pack(result)
                with self.lock:
                    if not entry["discarded"]:
                        entry["json"].write_bytes(blob)
            except Exception as error:
                with self.lock:
                    entry["failed"] = self.moved_on(key, record, base) or error
                    drop_snapshot(output)
                    entry["json"].unlink(missing_ok=True)
                handoff.put(("error", entry["failed"]))
            else:
                handoff.put(("done", None))
            finally:
                stopped()
                with self.lock:
                    entry["lite"] = None
                    entry["ready"].set()

        threading.Thread(target=work, name="cad-preview", daemon=True).start()
        kind, error = handoff.get()
        if kind == "error":
            raise error
        with self.lock:
            kept = self.keep(key, record, entry)
        if kept is None:
            raise CadError(CHANGED, 409)
        return kept

    def preview(self, data):
        """Run a preparation without committing it; an identical prepare reuses the result.

        The last MAX_STAGED previews of the current revision stay staged. With
        "lite": true the response omits the display tessellation (positions and
        triangleFaceIds); the result a prepare commits still includes it.
        """
        lite = data.get("lite", False)
        if type(lite) is not bool:
            raise CadError("lite must be true or false.", 400)
        for _ in range(3):
            with self.lock:
                key, record = self.lookup(data)
                if record.get("discrete"):
                    raise CadError("Split and defeature require editable STEP, IGES or BREP. STL is a discrete surface.")
                operation = data.get("operation")
                if not isinstance(operation, dict):
                    raise CadError("Provide a geometry preparation operation.", 400)
                operation_key = self.operation_key(operation)
                base = record["revision"]
                entry = self.staged_entry(record, operation_key)
                source = record["states"][record["cursor"]]["path"]
            if entry is None:
                entry = self.run_preview(key, record, base, operation, operation_key, source, lite)
            result = self.staged_result(entry, full=not lite)
            if result is not None:
                result.update(cadId=key, revision=base, staged=True)
                return result
            # Evicted while waiting for it: preview again if the revision is unchanged.
        raise CadError(CHANGED, 409)

    def prepare(self, data):
        with self.lock:
            key, record = self.lookup(data)
            if record.get("discrete"):
                raise CadError("Split and defeature require editable STEP, IGES or BREP. STL is a discrete surface.")
            operation = data.get("operation")
            if not isinstance(operation, dict):
                raise CadError("Provide a geometry preparation operation.", 400)
            if record["cursor"] + 1 >= MAX_SNAPSHOTS:
                raise CadError(f"This session has {MAX_SNAPSHOTS} preparation snapshots. Export and reimport the prepared BREP to continue.")
            operation_key = self.operation_key(operation)
            entry = self.staged_entry(record, operation_key)
        if entry is not None:
            entry["ready"].wait()  # a lite preview's worker may still be tessellating
        with self.lock:
            key, record = self.lookup(data)
            base = record["revision"]
            folder = self.root / key
            if entry is not None and not entry["discarded"] and not entry["failed"] and self.staged_entry(record, operation_key) is entry:
                record["staged"].pop(operation_key)
                return self.commit(key, record, operation, entry["path"], entry["json"])
            source = record["states"][record["cursor"]]["path"]
        output = folder / f"prepare-{uuid.uuid4().hex[:8]}.brep"
        json_path = output.with_suffix(".json.gz")
        try:
            result = self.runner({"action": "prepare", "operation": operation}, source, output)
            json_path.write_bytes(pack(result))
        except Exception:
            drop_snapshot(output)
            json_path.unlink(missing_ok=True)
            raise
        with self.lock:
            moved = self.moved_on(key, record, base)
            if moved:
                drop_snapshot(output)
                json_path.unlink(missing_ok=True)
                raise moved
            return self.commit(key, record, operation, output, json_path)

    def commit(self, key, record, operation, brep, result_json):
        """Make a prepared result (BREP and result JSON) the next revision. Lock held."""
        revision = record["revision"] + 1
        folder = self.root / key
        output = folder / f"state-{revision}.brep"
        json_path = folder / f"state-{revision}.json.gz"
        brep.replace(output)
        result_json.replace(json_path)
        cache = brep.with_suffix(".cache.json")
        if cache.is_file():
            cache.replace(output.with_suffix(".cache.json"))
        # This step ends the revision's other previews and drops the undone
        # states ahead of it: count the room they leave before refusing it.
        self.discard_staged(record)
        undone = size_of([path for state in record["states"][record["cursor"] + 1:] for path in files_of(state)])
        used = self.relieve(BUDGET + undone) - undone
        if used > BUDGET:
            drop_snapshot(output)
            json_path.unlink(missing_ok=True)
            raise full(used)
        for discarded in record["states"][record["cursor"] + 1:]:
            drop_snapshot(discarded["path"])
            discarded["json"].unlink(missing_ok=True)
        record["states"] = record["states"][:record["cursor"] + 1]
        kind = operation.get("kind", "prepare")
        passage_count = len(operation["passages"]) if isinstance(operation.get("passages"), list) else 0
        slice_count = sum(len(operation.get(key) or []) for key in ("planes", "cylinders", "rays"))
        labels = {"split": f"Split at {str(operation.get('axis', '')).upper()} = {operation.get('position')}",
                  "slice": operation.get("label")[:160] if isinstance(operation.get("label"), str) and operation.get("label").strip()
                  else f"Sliced with {slice_count} {'surface' if slice_count == 1 else 'surfaces'}",
                  "project": f"Partitioned by projected faces {operation.get('faceIds', [])} along {str(operation.get('axis', '')).upper()}",
                  "defeature": operation.get("label")[:160] if isinstance(operation.get("label"), str) and operation.get("label").strip()
                  else f"Removed faces {operation.get('faceIds', [])}", "heal": "Healed CAD topology",
                  "fuse": operation.get("label")[:160] if isinstance(operation.get("label"), str) and operation.get("label").strip()
                  else f"Fused solids {operation.get('volumeIds', [])}",
                  "passage": "Cut a reviewed rectangular through-passage",
                  "passages": f"Cut {passage_count} reviewed rectangular through-passages"}
        record["states"].append({"path": output, "json": json_path, "revision": revision,
                                 "operation": operation, "label": labels.get(kind, "Prepared geometry")})
        record["cursor"] += 1
        record["revision"] = revision
        return self.payload(key, record)

    def undo(self, data):
        with self.lock:
            key, record = self.lookup(data)
            if not record["cursor"]:
                raise CadError("There are no geometry preparation operations to undo.", 400)
            return self.move(key, record, record["cursor"] - 1)

    def redo(self, data):
        with self.lock:
            key, record = self.lookup(data)
            if record["cursor"] + 1 >= len(record["states"]):
                raise CadError("There is nothing to redo.", 400)
            return self.move(key, record, record["cursor"] + 1)

    def revert(self, data):
        """Go to any kept state (back, or forward over undone ones); a new operation drops those ahead."""
        with self.lock:
            key, record = self.lookup(data)
            target = data.get("to")
            if type(target) is not int or not 0 <= target < len(record["states"]):
                raise CadError("Choose a step from the history.", 400)
            return self.move(key, record, target)

    def move(self, key, record, cursor):
        """Make kept state `cursor` current. Lock held."""
        self.discard_staged(record)
        record["cursor"] = cursor
        record["revision"] += 1
        return self.payload(key, record)

    def export(self, data):
        with self.lock:
            key, record = self.lookup(data)
            state = record["states"][record["cursor"]]
            discrete = record.get("discrete")
            return {"filename": record["filename"] if discrete else Path(record["filename"]).stem + "-prepared.brep",
                    "format": "stl" if discrete else "brep",
                    "content": base64.b64encode((record["source"] if discrete else state["path"]).read_bytes()).decode(),
                    "history": self.payload(key, record)["history"][:record["cursor"] + 1]}

    def mesh(self, data):
        with self.lock:
            _, record = self.lookup(data)
            source = record["states"][record["cursor"]]["path"]
        return self.runner({**{k: v for k, v in data.items() if k not in {"cadId", "revision"}}, "action": "mesh"}, source, None)

    def sessions(self, data):
        """Every open session, most recently used first, with the storage each uses."""
        with self.lock:
            self.prune()
            items = []
            for key, record in self.records.items():
                items.append({"cadId": key, "filename": record["filename"], "steps": record["cursor"], "kept": len(record["states"]),
                              "label": record["states"][record["cursor"]]["label"], "revision": record["revision"],
                              "created": record.get("created", record["lastUsed"]), "lastUsed": record["lastUsed"],
                              "bytes": size_of(path for path in (self.root / key).rglob("*") if path.is_file()), "discrete": bool(record.get("discrete"))})
            items.sort(key=lambda item: -item["lastUsed"])
            return {"sessions": items, "bytes": self.total_size(), "budget": BUDGET}

    def pick(self, data):
        key = data.get("cadId")
        if not isinstance(key, str) or not re.fullmatch(r"[0-9a-f]{32}", key) or key not in self.records:
            raise CadError("That CAD session is no longer open.", 404)
        return key, self.records[key]

    def resume(self, data):
        """Pick up an open session where it stands, with its original file for project saves."""
        with self.lock:
            key, record = self.pick(data)
            record["lastUsed"] = time.time()
            result = self.payload(key, record)
            source = record["source"]
            result["original"] = {"filename": record["filename"], "format": source.suffix.lstrip("."), "content": base64.b64encode(source.read_bytes()).decode()}
            return result

    def close_session(self, data):
        """Close a session for good: its snapshots and undo steps are deleted."""
        with self.lock:
            key, _ = self.pick(data)
            self.close(key)
        return self.sessions({})

    def shell(self, data):
        """Shell mesh of the current revision's faces; the session does not change."""
        with self.lock:
            _, record = self.lookup(data)
            source = record["states"][record["cursor"]]["path"]
        return self.runner({**{k: v for k, v in data.items() if k not in {"cadId", "revision"}}, "action": "shell"}, source, None)
