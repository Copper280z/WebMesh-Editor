"""Bounded, immutable CAD snapshots for the local WebMesh bridge.

Requests can arrive on several threads at once: previews run side by side.
Session records are read and changed only under one lock, CAD workers run
outside it, and a worker's result is kept only if its session has not moved
on to another revision in the meantime.
"""

import base64
import binascii
from collections import OrderedDict
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
CHANGED = "The CAD geometry changed. Refresh it before applying this operation."


class CadError(Exception):
    def __init__(self, message, status=422, log=""):
        super().__init__(message)
        self.status, self.log = status, log


def dumps(value):
    return json.dumps(value, allow_nan=False, separators=(",", ":"))


def lite_view(result):
    """A lite preview response: the topology and edge polylines, without the display tessellation."""
    preview = result.get("preview") or {}
    return {**result, "preview": {"lite": True, "edges": preview.get("edges", [])}}


class CadSessions:
    def __init__(self, runner):
        self.temporary = tempfile.TemporaryDirectory(prefix="webmesh-cad-sessions-")
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
        expired = [key for key, record in self.records.items() if time.time() - record["lastUsed"] > 7200]
        for key in expired:
            self.close(key)
        while self.records and (len(self.records) >= 8 or self.total_size() > 512 * 1024 * 1024):
            self.close(min(self.records, key=lambda item: self.records[item]["lastUsed"]))

    def lookup(self, data):
        key = data.get("cadId")
        if not isinstance(key, str) or not re.fullmatch(r"[0-9a-f]{32}", key) or key not in self.records:
            raise CadError("CAD session expired or was not found. Import the geometry again.", 404)
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
        result = json.loads(state["json"].read_text())
        result.update(cadId=key, revision=record["revision"], filename=record["filename"],
                      history=[{"revision": item["revision"], "operation": item["operation"], "label": item["label"]}
                               for item in record["states"][:record["cursor"] + 1]])
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
            json_path = folder / "state-0.json"
            json_path.write_text(dumps(result))
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        filename = data.get("filename")
        filename = Path(filename).name[:200] if isinstance(filename, str) else "Geometry." + kind
        with self.lock:
            # Invalid new imports never evict existing working CAD sessions.
            self.prune()
            self.records[key] = {"filename": filename, "revision": 0, "cursor": 0, "lastUsed": time.time(),
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
        entry["path"].unlink(missing_ok=True)
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
            result = json.loads(entry["json"].read_text())
        return result if full else lite_view(result)

    def run_preview(self, key, record, base, operation, operation_key, source, lite):
        output = self.root / key / f"staged-{uuid.uuid4().hex[:8]}.brep"
        entry = {"base": base, "key": operation_key, "path": output, "json": output.with_suffix(".json"),
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
                entry["json"].write_text(dumps(result))
            except Exception as error:
                output.unlink(missing_ok=True)
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
                text = dumps(result)
                with self.lock:
                    if not entry["discarded"]:
                        entry["json"].write_text(text)
            except Exception as error:
                with self.lock:
                    entry["failed"] = self.moved_on(key, record, base) or error
                    output.unlink(missing_ok=True)
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
        json_path = output.with_suffix(".json")
        try:
            result = self.runner({"action": "prepare", "operation": operation}, source, output)
            json_path.write_text(dumps(result))
        except Exception:
            output.unlink(missing_ok=True)
            json_path.unlink(missing_ok=True)
            raise
        with self.lock:
            moved = self.moved_on(key, record, base)
            if moved:
                output.unlink(missing_ok=True)
                json_path.unlink(missing_ok=True)
                raise moved
            return self.commit(key, record, operation, output, json_path)

    def commit(self, key, record, operation, brep, result_json):
        """Make a prepared result (BREP and result JSON) the next revision. Lock held."""
        revision = record["revision"] + 1
        folder = self.root / key
        output = folder / f"state-{revision}.brep"
        json_path = folder / f"state-{revision}.json"
        brep.replace(output)
        result_json.replace(json_path)
        if self.total_size() > 512 * 1024 * 1024:
            output.unlink(missing_ok=True)
            json_path.unlink(missing_ok=True)
            raise CadError("CAD snapshot storage reached 512 MiB. Export prepared geometry and reimport it to continue.")
        self.discard_staged(record)
        for discarded in record["states"][record["cursor"] + 1:]:
            discarded["path"].unlink(missing_ok=True)
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
            self.discard_staged(record)
            if not record["cursor"]:
                raise CadError("There are no geometry preparation operations to undo.", 400)
            record["cursor"] -= 1
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
                    "history": self.payload(key, record)["history"]}

    def mesh(self, data):
        with self.lock:
            _, record = self.lookup(data)
            source = record["states"][record["cursor"]]["path"]
        return self.runner({**{k: v for k, v in data.items() if k not in {"cadId", "revision"}}, "action": "mesh"}, source, None)
