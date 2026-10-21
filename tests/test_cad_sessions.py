"""CAD session storage: compressed results, the shared budget, and listing,
resuming and closing sessions. A fake runner stands in for the CAD kernel."""

import base64
import gzip
import os
import unittest
from unittest.mock import patch

import cad_sessions
from cad_sessions import CadError, CadSessions

KB = 1024


def runner(request, source, output, early=None, started=None):
    """Writes a 100 KiB snapshot (incompressible) and a cache beside it, like the kernel."""
    if started:
        started(lambda: None)
    output.write_bytes(os.urandom(100 * KB))
    output.with_suffix(".cache.json").write_bytes(gzip.compress(b"{}"))
    result = {"topology": {"faces": [], "label": request.get("operation", {}).get("label", "import")}, "preview": {"positions": [0.5] * 2000}}
    if early:
        early({"topology": result["topology"], "preview": {}})
    return result


def imported(sessions, name="part.step"):
    return sessions.import_cad({"filename": name, "format": "step", "content": base64.b64encode(b"ISO-10303-21;").decode()})


def step(sessions, cad, label):
    return sessions.prepare({"cadId": cad["cadId"], "revision": cad["revision"], "operation": {"kind": "slice", "label": label, "planes": []}})


def preview(sessions, cad, label):
    return sessions.preview({"cadId": cad["cadId"], "revision": cad["revision"], "operation": {"kind": "slice", "label": label, "planes": []}})


class SessionStorageTests(unittest.TestCase):
    def setUp(self):
        self.sessions = CadSessions(runner)
        self.addCleanup(self.sessions.temporary.cleanup)

    def test_results_are_stored_gzipped_and_read_back(self):
        cad = imported(self.sessions)
        state = self.sessions.records[cad["cadId"]]["states"][0]
        self.assertTrue(state["json"].name.endswith(".json.gz"))
        self.assertEqual(state["json"].read_bytes()[:2], b"\x1f\x8b")
        self.assertEqual(cad["preview"]["positions"][:2], [0.5, 0.5])
        cad = step(self.sessions, cad, "first")
        self.assertEqual(cad["topology"]["label"], "first")

    def test_a_step_counts_the_previews_it_ends_before_refusing(self):
        with patch.object(cad_sessions, "BUDGET", 380 * KB):
            cad = imported(self.sessions)
            preview(self.sessions, cad, "a")
            preview(self.sessions, cad, "b")
            # Import and two previews (~300 KiB), plus this step's own snapshot: over the
            # budget until the previews it makes stale are gone.
            cad = step(self.sessions, cad, "c")
            self.assertEqual(cad["revision"], 1)
            self.assertNotIn("staged", self.sessions.records[cad["cadId"]])

    def test_full_storage_refuses_the_step_points_to_sessions_and_keeps_every_session(self):
        with patch.object(cad_sessions, "BUDGET", 380 * KB):
            old = step(self.sessions, imported(self.sessions, "old.step"), "kept")
            cad = imported(self.sessions, "new.step")
            with self.assertRaises(CadError) as caught:
                step(self.sessions, cad, "too much")
            self.assertEqual(caught.exception.status, 507)
            self.assertIn("under Sessions", str(caught.exception))
            self.assertEqual(self.sessions.records[cad["cadId"]]["revision"], 0, "the refused step left the session as it was")
            self.assertEqual(len(self.sessions.records), 2, "no session was closed to make room")
            # The user closes the session they no longer need, and the step goes through.
            listed = self.sessions.close_session({"cadId": old["cadId"]})
            self.assertEqual([s["filename"] for s in listed["sessions"]], ["new.step"])
            self.assertEqual(step(self.sessions, cad, "fits now")["revision"], 1)

    def test_other_sessions_previews_go_before_a_step_is_refused(self):
        with patch.object(cad_sessions, "BUDGET", 380 * KB):
            other = imported(self.sessions, "other.step")
            preview(self.sessions, other, "x")
            cad = imported(self.sessions, "work.step")
            self.assertEqual(step(self.sessions, cad, "fits")["revision"], 1)
            self.assertNotIn("x", [entry["key"] for entry in (self.sessions.records[other["cadId"]].get("staged") or {}).values()])

    def test_imports_are_refused_rather_than_closing_sessions(self):
        with patch.object(cad_sessions, "BUDGET", 250 * KB):
            first = step(self.sessions, imported(self.sessions, "first.step"), "one")
            with self.assertRaises(CadError) as caught:
                imported(self.sessions, "second.step")
            self.assertIn("storage is full", str(caught.exception))
            self.assertEqual(list(self.sessions.records), [first["cadId"]])
        with patch.object(cad_sessions, "MAX_SESSIONS", 2):
            imported(self.sessions, "second.step")
            with self.assertRaisesRegex(CadError, "2 CAD sessions are open"):
                imported(self.sessions, "third.step")

    def test_sessions_are_listed_resumed_and_closed(self):
        first = step(self.sessions, imported(self.sessions, "first.step"), "Sliced the web")
        second = imported(self.sessions, "second.step")
        listed = self.sessions.sessions({})
        self.assertEqual([s["filename"] for s in listed["sessions"]], ["second.step", "first.step"], "most recently used first")
        entry = listed["sessions"][1]
        self.assertEqual((entry["steps"], entry["label"]), (1, "Sliced the web"), entry)
        self.assertGreater(entry["bytes"], 200 * KB)
        self.assertEqual(listed["budget"], cad_sessions.BUDGET)
        resumed = self.sessions.resume({"cadId": first["cadId"]})
        self.assertEqual((resumed["revision"], resumed["cursor"]), (first["revision"], 1))
        self.assertEqual(base64.b64decode(resumed["original"]["content"]), b"ISO-10303-21;")
        self.assertEqual(resumed["original"]["filename"], "first.step")
        self.assertEqual(self.sessions.sessions({})["sessions"][0]["filename"], "first.step", "resuming counts as use")
        # Work continues on the resumed session with its revision token.
        self.assertEqual(step(self.sessions, resumed, "more")["revision"], first["revision"] + 1)
        self.sessions.close_session({"cadId": second["cadId"]})
        self.assertFalse((self.sessions.root / second["cadId"]).exists())
        for bad in ({"cadId": second["cadId"]}, {"cadId": "nope"}, {}):
            with self.assertRaisesRegex(CadError, "no longer open"):
                self.sessions.resume(bad)


class SessionSheetTests(unittest.TestCase):
    """Sheet records live with each step: the kernel gets the current step's and returns the next."""

    def setUp(self):
        self.requests = []

        def sheet_runner(request, source, output, early=None, started=None):
            self.requests.append(request)
            if request["action"] == "shell":
                return {"mesh": {}, "quality": {}}
            sheets = list(request.get("sheets") or [])
            if request.get("operation", {}).get("kind") == "surface":
                sheets.append({"face": 100 + len(sheets), "sheet": len(sheets) + 1, "thickness": 3.0, "offset": 0.0, "label": "mid"})
            result = runner(request, source, output, early, started)
            result["topology"]["sheets"] = sheets
            return result
        self.sessions = CadSessions(sheet_runner)
        self.addCleanup(self.sessions.temporary.cleanup)

    def test_each_step_hands_its_sheets_to_the_next_and_to_meshing_and_export(self):
        cad = imported(self.sessions)
        cad = self.sessions.prepare({"cadId": cad["cadId"], "revision": cad["revision"], "operation": {"kind": "surface"}})
        cad = self.sessions.prepare({"cadId": cad["cadId"], "revision": cad["revision"], "operation": {"kind": "surface"}})
        self.assertEqual(len(self.requests[-1]["sheets"]), 1, "the second step starts from the first's sheet")
        self.assertEqual(len(cad["topology"]["sheets"]), 2)
        # A preview that is then applied keeps its sheets too.
        preview(self.sessions, cad, "x")
        cad = self.sessions.prepare({"cadId": cad["cadId"], "revision": cad["revision"], "operation": {"kind": "slice", "label": "x", "planes": []}})
        self.assertEqual(len(self.sessions.records[cad["cadId"]]["states"][-1]["sheets"]), 2)
        # Undo: the next step starts from the earlier step's sheets.
        cad = self.sessions.undo({"cadId": cad["cadId"], "revision": cad["revision"]})
        cad = self.sessions.undo({"cadId": cad["cadId"], "revision": cad["revision"]})
        self.sessions.prepare({"cadId": cad["cadId"], "revision": cad["revision"], "operation": {"kind": "slice", "label": "y", "planes": []}})
        self.assertEqual(len(self.requests[-1]["sheets"]), 1)
        cad = self.sessions.resume({"cadId": cad["cadId"]})
        # Shell meshing uses the session's records, not any the page sends; export includes them.
        self.sessions.shell({"cadId": cad["cadId"], "revision": cad["revision"], "size": 3, "sheets": [{"face": 1}]})
        self.assertEqual(self.requests[-1]["sheets"], self.sessions.records[cad["cadId"]]["states"][-1]["sheets"])
        exported = self.sessions.export({"cadId": cad["cadId"], "revision": cad["revision"]})
        self.assertEqual(len(exported["sheets"]), 1)
        # A project's sheets go with its reimport.
        self.sessions.import_cad({"filename": "p.brep", "format": "brep", "content": base64.b64encode(b"x").decode(), "sheets": exported["sheets"]})
        self.assertEqual(self.requests[-1]["sheets"], exported["sheets"])


if __name__ == "__main__":
    unittest.main()
