"""Bounded, immutable CAD snapshots for the local WebMesh bridge."""

import base64
import binascii
import json
from pathlib import Path
import re
import shutil
import tempfile
import time
import uuid


# Undoable preparation steps per session; total snapshot storage is bounded separately.
MAX_SNAPSHOTS = 96


class CadError(Exception):
    def __init__(self, message, status=422, log=""):
        super().__init__(message)
        self.status, self.log = status, log


class CadSessions:
    def __init__(self, runner):
        self.temporary = tempfile.TemporaryDirectory(prefix="webmesh-cad-sessions-")
        self.root = Path(self.temporary.name)
        self.records = {}
        self.runner = runner

    def prune(self):
        expired = [key for key, record in self.records.items() if time.time() - record["lastUsed"] > 7200]
        for key in expired:
            shutil.rmtree(self.root / key, ignore_errors=True)
            del self.records[key]
        def total_size():
            return sum(path.stat().st_size for path in self.root.rglob("*") if path.is_file())
        while self.records and (len(self.records) >= 8 or total_size() > 512 * 1024 * 1024):
            key = min(self.records, key=lambda item: self.records[item]["lastUsed"])
            shutil.rmtree(self.root / key, ignore_errors=True)
            del self.records[key]

    def lookup(self, data):
        key = data.get("cadId")
        if not isinstance(key, str) or not re.fullmatch(r"[0-9a-f]{32}", key) or key not in self.records:
            raise CadError("CAD session expired or was not found. Import the geometry again.", 404)
        record = self.records[key]
        if type(data.get("revision")) is not int or data["revision"] != record["revision"]:
            raise CadError("The CAD geometry changed. Refresh it before applying this operation.", 409)
        record["lastUsed"] = time.time()
        return key, record

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
            json_path.write_text(json.dumps(result, allow_nan=False, separators=(",", ":")))
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        # Invalid new imports never evict existing working CAD sessions.
        self.prune()
        filename = data.get("filename")
        filename = Path(filename).name[:200] if isinstance(filename, str) else "Geometry." + kind
        self.records[key] = {"filename": filename, "revision": 0, "cursor": 0, "lastUsed": time.time(),
                             "discrete": kind == "stl", "source": source,
                             "states": [{"path": snapshot, "json": json_path,
                                         "revision": 0, "operation": {"kind": "import"}, "label": "Imported geometry"}]}
        return self.payload(key, self.records[key])

    @staticmethod
    def operation_key(operation):
        return json.dumps(operation, sort_keys=True, allow_nan=False, separators=(",", ":"))

    def discard_staged(self, record):
        staged = record.pop("staged", None)
        if staged:
            staged["path"].unlink(missing_ok=True)
            staged["json"].unlink(missing_ok=True)

    def preview(self, data):
        """Run a preparation without committing it; an identical prepare reuses the result."""
        key, record = self.lookup(data)
        if record.get("discrete"):
            raise CadError("Split and defeature require editable STEP, IGES or BREP. STL is a discrete surface.")
        operation = data.get("operation")
        if not isinstance(operation, dict):
            raise CadError("Provide a geometry preparation operation.", 400)
        operation_key = self.operation_key(operation)
        staged = record.get("staged")
        if not (staged and staged["base"] == record["revision"] and staged["key"] == operation_key):
            self.discard_staged(record)
            state = record["states"][record["cursor"]]
            folder = self.root / key
            output = folder / f"staged-{uuid.uuid4().hex[:8]}.brep"
            try:
                result = self.runner({"action": "prepare", "operation": operation}, state["path"], output)
            except Exception:
                output.unlink(missing_ok=True)
                raise
            json_path = output.with_suffix(".json")
            json_path.write_text(json.dumps(result, allow_nan=False, separators=(",", ":")))
            record["staged"] = {"base": record["revision"], "key": operation_key, "path": output, "json": json_path}
        staged = record["staged"]
        result = json.loads(staged["json"].read_text())
        result.update(cadId=key, revision=record["revision"], staged=True)
        return result

    def prepare(self, data):
        key, record = self.lookup(data)
        if record.get("discrete"):
            raise CadError("Split and defeature require editable STEP, IGES or BREP. STL is a discrete surface.")
        operation = data.get("operation")
        if not isinstance(operation, dict):
            raise CadError("Provide a geometry preparation operation.", 400)
        if record["cursor"] + 1 >= MAX_SNAPSHOTS:
            raise CadError(f"This session has {MAX_SNAPSHOTS} preparation snapshots. Export and reimport the prepared BREP to continue.")
        state = record["states"][record["cursor"]]
        revision = record["revision"] + 1
        folder = self.root / key
        output = folder / f"state-{revision}.brep"
        json_path = folder / f"state-{revision}.json"
        staged = record.get("staged")
        if staged and staged["base"] == record["revision"] and staged["key"] == self.operation_key(operation):
            record.pop("staged")
            staged["path"].replace(output)
            staged["json"].replace(json_path)
        else:
            self.discard_staged(record)
            try:
                result = self.runner({"action": "prepare", "operation": operation}, state["path"], output)
            except Exception:
                output.unlink(missing_ok=True)
                raise
            json_path.write_text(json.dumps(result, allow_nan=False, separators=(",", ":")))
        if sum(path.stat().st_size for path in self.root.rglob("*") if path.is_file()) > 512 * 1024 * 1024:
            output.unlink(missing_ok=True)
            json_path.unlink(missing_ok=True)
            raise CadError("CAD snapshot storage reached 512 MiB. Export prepared geometry and reimport it to continue.")
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
        key, record = self.lookup(data)
        self.discard_staged(record)
        if not record["cursor"]:
            raise CadError("There are no geometry preparation operations to undo.", 400)
        record["cursor"] -= 1
        record["revision"] += 1
        return self.payload(key, record)

    def export(self, data):
        key, record = self.lookup(data)
        state = record["states"][record["cursor"]]
        discrete = record.get("discrete")
        return {"filename": record["filename"] if discrete else Path(record["filename"]).stem + "-prepared.brep",
                "format": "stl" if discrete else "brep",
                "content": base64.b64encode((record["source"] if discrete else state["path"]).read_bytes()).decode(),
                "history": self.payload(key, record)["history"]}

    def mesh(self, data):
        _, record = self.lookup(data)
        state = record["states"][record["cursor"]]
        return self.runner({**{k: v for k, v in data.items() if k not in {"cadId", "revision"}}, "action": "mesh"}, state["path"], None)
