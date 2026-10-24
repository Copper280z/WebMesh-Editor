"""Portable CAD checkpoints and transactional, revision-safe project restores.

Only unadopted restore candidates are collected. Committed CAD histories are
never evicted. No archive filenames are used as filesystem paths.
"""
import base64
import binascii
import gzip
import hashlib
import io
import json
import re
import shutil
import time
import uuid
from pathlib import Path

MAX_ARCHIVE = 24 * 1024 * 1024
MAX_EXPANDED = 384 * 1024 * 1024
RESTORE_TTL = 15 * 60


def encoded(raw):
    return base64.b64encode(raw).decode()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


class CadPersistence:
    def __init__(self, sessions, error, limits):
        self.s, self.error, self.limits = sessions, error, limits
        self.transactions = {}

    def decode(self, text, limit=MAX_ARCHIVE):
        if not isinstance(text, str) or len(text) > 4 * ((limit + 2) // 3):
            raise self.error("CAD checkpoint exceeds its storage limit.", 413)
        try:
            raw = base64.b64decode(text, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise self.error("Invalid CAD checkpoint encoding.", 400) from exc
        if not raw or len(raw) > limit:
            raise self.error("CAD checkpoint exceeds its storage limit.", 413)
        return raw

    def checkpoint(self, key, record):
        """Called under the session lock. Include redo states, not just the cursor."""
        states = []
        for item in record["states"]:
            states.append({"geometry": self.geometry(item["path"]),
                           "result": json.loads(gzip.decompress(item["json"].read_bytes())),
                           **{k: item[k] for k in ("sheets", "revision", "operation", "label")}})
        archive = {"version": 1, "filename": record["filename"], "format": record["source"].suffix[1:],
                   "original": self.geometry(record["source"]), "discrete": bool(record.get("discrete")),
                   "cursor": record["cursor"], "revision": record["revision"], "states": states}
        raw = canonical(archive)
        if len(raw) > MAX_EXPANDED:
            raise self.error("CAD history is too large for a portable checkpoint. No history was removed.", 413)
        compressed = gzip.compress(raw, mtime=0)
        if len(compressed) > MAX_ARCHIVE:
            raise self.error("Compressed CAD history exceeds 24 MiB. No history was removed.", 413)
        value = {"version": 1, "encoding": "gzip+base64", "sha256": hashlib.sha256(compressed).hexdigest(), "content": encoded(compressed)}
        record["checkpoint"] = (record["revision"], value["sha256"])
        return value

    def geometry(self, path):
        if path.stat().st_size > MAX_ARCHIVE:
            raise self.error("A CAD history state exceeds 24 MiB. No history was removed.", 413)
        return encoded(path.read_bytes())

    def unpack(self, checkpoint):
        if not isinstance(checkpoint, dict) or checkpoint.get("version") != 1 or checkpoint.get("encoding") != "gzip+base64":
            raise self.error("Unsupported CAD checkpoint.", 400)
        raw = self.decode(checkpoint.get("content"))
        if hashlib.sha256(raw).hexdigest() != checkpoint.get("sha256"):
            raise self.error("CAD checkpoint checksum does not match.", 400)
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
                expanded = stream.read(MAX_EXPANDED + 1)
            if len(expanded) > MAX_EXPANDED:
                raise ValueError("expanded size")
            archive = json.loads(expanded, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite")))
            states = archive["states"]
            if archive["version"] != 1 or archive["format"] not in ("step", "stp", "iges", "igs", "brep", "stl"):
                raise ValueError("format")
            if not isinstance(states, list) or not 1 <= len(states) <= self.limits()[2]:
                raise ValueError("states")
            if type(archive["cursor"]) is not int or not 0 <= archive["cursor"] < len(states):
                raise ValueError("cursor")
            if type(archive["revision"]) is not int or archive["revision"] < 0 or type(archive["discrete"]) is not bool:
                raise ValueError("revision")
            if not isinstance(archive["filename"], str):
                raise ValueError("filename")
            self.decode(archive["original"])
            for state in states:
                self.decode(state["geometry"])
                if (not isinstance(state["sheets"], list) or not isinstance(state["operation"], dict)
                    or not isinstance(state["label"], str) or type(state["revision"]) is not int
                    or not 0 <= state["revision"] <= archive["revision"]
                    or not isinstance(state["result"].get("topology"), dict)
                    or not isinstance(state["result"].get("preview"), dict)):
                    raise ValueError("state")
            return archive
        except (ValueError, KeyError, TypeError, AttributeError, OSError, EOFError, RecursionError) as exc:
            raise self.error("Invalid CAD checkpoint history; the current draft is unchanged.", 400) from exc

    def transaction(self, data):
        key, owner = data.get("transaction"), data.get("client")
        if not all(isinstance(x, str) and re.fullmatch(r"[\w-]{8,100}", x) for x in (key, owner)):
            raise self.error("Invalid CAD restore transaction.", 400)
        self.prune()
        tx = self.transactions.get(key)
        if tx is None:
            if len(self.transactions) >= 256:
                raise self.error("Too many recent CAD restores. Retry after abandoned restores expire.", 429)
            tx = self.transactions[key] = {"owner": owner, "status": "staging", "time": time.time(), "entries": {}}
        if tx["owner"] != owner:
            raise self.error("This CAD restore belongs to another workspace.", 409)
        tx["time"] = time.time()
        return key, tx

    def prune(self):
        for key, tx in list(self.transactions.items()):
            if time.time() - tx["time"] <= RESTORE_TTL:
                continue
            if tx["status"] == "staging":
                self.abort(tx)
                tx["time"] = time.time()  # keep a tombstone for late worker completions
            else:
                del self.transactions[key]

    def abort(self, tx):
        for entry in tx["entries"].values():
            key = entry["cadId"]
            record = self.s.records.get(key)
            if entry["created"] and record and record.get("provisional") and record["revision"] == entry["revision"]:
                self.s.close(key)
            elif entry["created"] and record:
                record.pop("provisional", None)  # it acquired edits: retain the draft
        tx["status"] = "aborted"

    def restore_finish(self, data):
        with self.s.lock:
            _, tx = self.transaction(data)
            commit = data.get("commit")
            if type(commit) is not bool:
                raise self.error("Choose commit or abort for the CAD restore.", 400)
            if not commit:
                if tx["status"] == "staging":
                    self.abort(tx)
                return {"status": tx["status"]}
            if tx["status"] == "aborted":
                raise self.error("This CAD restore was cancelled. Reopen the project to retry.", 409)
            if tx["status"] == "committed":
                return {"status": "committed"}
            for entry in tx["entries"].values():
                record = self.s.records.get(entry["cadId"])
                if not record or record["revision"] != entry["revision"]:
                    self.abort(tx)
                    raise self.error("A CAD session changed during restore. The previous draft was retained.", 409)
            for entry in tx["entries"].values():
                self.s.records[entry["cadId"]].pop("provisional", None)
            tx["status"] = "committed"
            return {"status": "committed"}

    def restore(self, data):
        with self.s.lock:
            transaction, tx = self.transaction(data)
            if tx["status"] != "staging":
                raise self.error("This CAD restore is already finished.", 409)
        key = None
        try:
            scope = data.get("scope")
            if not isinstance(scope, str) or not 1 <= len(scope) <= 256:
                raise self.error("A CAD restore needs a part identity.", 400)
            checkpoint = data.get("checkpoint")
            archive = self.unpack(checkpoint) if checkpoint is not None else None
            signature = checkpoint["sha256"] if archive else hashlib.sha256(canonical({k: data.get(k) for k in ("filename", "format", "content", "sheets")})).hexdigest()
            with self.s.lock:
                if tx["status"] != "staging":
                    raise self.error("This CAD restore was cancelled.", 409)
                previous = tx["entries"].get(scope)
                if previous:
                    if previous["signature"] != signature:
                        raise self.error("The part changed during a retried CAD restore.", 409)
                    record = self.s.records.get(previous["cadId"])
                    if not record or record["revision"] != previous["revision"]:
                        raise self.error("The staged CAD session changed.", 409)
                    return {**self.s.payload(previous["cadId"], record), "restoreReused": not previous["created"]}
                # Reuse only an unchanged session in this browser workspace and part.
                for key, record in self.s.records.items():
                    if record.get("restoreOwner") != (tx["owner"], scope) or record.get("provisional"):
                        continue
                    cached = record.get("checkpoint")
                    same = (cached and cached[0] == record["revision"] and cached[1] == signature) if archive else record.get("restoreSignature") == (signature, record["revision"])
                    if same:
                        record["lastUsed"] = time.time()
                        tx["entries"][scope] = {"cadId": key, "revision": record["revision"], "signature": signature, "created": False}
                        return {**self.s.payload(key, record), "restoreReused": True}
            if archive:
                key = self.install(archive, checkpoint, transaction)
                with self.s.lock:
                    result = self.s.payload(key, self.s.records[key])
            else:
                result = self.s.import_cad(data, provisional=transaction)
                key = result["cadId"]
            with self.s.lock:
                # An abort may arrive while the kernel is importing the CAD.
                record = self.s.records[key]
                if tx["status"] != "staging" or self.transactions.get(transaction) is not tx:
                    if record.get("provisional") == transaction:
                        self.s.close(key)
                    raise self.error("CAD restore was cancelled; its unadopted candidate was removed.", 409)
                record.update(restoreOwner=(tx["owner"], scope), restoreSignature=(signature, record["revision"]))
                tx["entries"][scope] = {"cadId": key, "revision": record["revision"], "signature": signature, "created": True}
                return {**result, "restoreReused": False}
        except Exception:
            with self.s.lock:
                if tx["status"] == "staging":
                    self.abort(tx)
            raise

    def install(self, archive, checkpoint, transaction):
        key = uuid.uuid4().hex
        folder = self.s.root / key
        folder.mkdir()
        try:
            source = folder / ("original." + archive["format"])
            source.write_bytes(self.decode(archive["original"]))
            states = []
            for i, state in enumerate(archive["states"]):
                path = folder / (f"state-{i}.msh" if archive["discrete"] else f"state-{i}.brep")
                path.write_bytes(self.decode(state["geometry"]))
                result = path.with_suffix(".json.gz")
                result.write_bytes(gzip.compress(canonical(state["result"]), mtime=0))
                states.append({**{k: state[k] for k in ("sheets", "revision", "operation", "label")}, "path": path, "json": result})
            with self.s.lock:
                budget, capacity, _ = self.limits()
                self.prune()
                if len(self.s.records) >= capacity or self.s.relieve() > budget:
                    raise self.error("CAD capacity is full. Save and close retained drafts under Sessions, then retry.", 507)
                now = time.time()
                self.s.records[key] = {"filename": Path(archive["filename"]).name[:200], "source": source, "discrete": archive["discrete"],
                                       "states": states, "cursor": archive["cursor"], "revision": archive["revision"], "created": now, "lastUsed": now,
                                       "checkpoint": (archive["revision"], checkpoint["sha256"]), "provisional": transaction}
                return key
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
