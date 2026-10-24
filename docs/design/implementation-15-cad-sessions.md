# Implementation 15: reliable CAD session restoration

Status: implemented and validated · `codex/project-core-foundation`

## Goal

Reopening a project must not accumulate duplicate CAD sessions, leave half-imported parts behind, or destroy the current draft or CAD undo/redo history. Guided project restore uses the same explicit session actions as the analyst's CAD workspace.

## Plan

1. Add transactional CAD restore sessions. Validate project metadata before importing, stage each part without changing the current workspace, and commit or abort the group. Failed/abandoned restores remove only their unadopted candidates; reused and edited sessions are retained. Make abort/retry safe after uncertain network outcomes.
2. Reuse an exact unchanged CAD session within the same browser workspace and part. Compare actual checkpoint identity and revision, not filenames. Different parts/workspaces and changed live drafts remain independent.
3. Save portable bounded checkpoints containing all retained CAD states, the undo cursor and redo branch, sheets and topology/display metadata. Restore the same identities on a fresh server. Older projects remain readable and retain their historical audit labels; unavailable historical geometry cannot be reconstructed from labels alone.
4. Preserve outgoing draft settings and source data for explicit session recovery. Stop expiring committed histories automatically. Make session state/capacity and safe cleanup visible without adding a large permanent UI panel.
5. Exercise repeated reopen, second-part failure, invalid ownership/model, timeout/abort races, full capacity, edited-session isolation, restart restoration, undo/redo and malformed checkpoints. Validate with unit/integration tests and manual browser reopening of the saved rover. Retain evidence and update the main design status.

## Acceptance

- Reopening the same unchanged two-part project repeatedly uses two CAD sessions.
- A failure at any staged part or later model validation removes only new candidates and preserves the previous model, draft settings, geometry and undo/redo.
- Reopening an older saved state never rewinds or deletes a more recently edited live session.
- New saves reopen with executable undo/redo, including after a server restart; changing one independent part never changes another.
- Capacity failures are actionable and do not silently prune committed sessions.

## Outcome

Implemented on the existing branch. `cad_persistence.py` provides exact revision reuse, bounded portable checkpoints and idempotent restore transactions. The server scopes reuse to a browser workspace and part; a changed live session is retained when an older saved state opens. A browser lock prevents duplicated tabs from sharing a copied session identity, while allowing page reloads to reclaim that identity.

Project opening validates the part envelope, retains outgoing draft settings, stages CAD, and backs up the engine before loading the FE model. Commit adopts the complete group. Failure rolls back model cards, ownership, the FE undo/redo stack, CAD drafts, saved-run bindings and result state, then aborts new candidates. Cleanup still runs if a UI rollback reports an error. Discarded part-import reviews also release candidates. A cancelled in-flight import cannot leave a late session behind.

New saves include every retained CAD state, its BREP/discrete geometry, sheet metadata, topology/display data, revision, cursor and redo branch. Checkpoints are checksum-verified and bounded (24 MiB compressed, 384 MiB expanded, 96 states); oversize saves fail without truncating history. Their identities remain stable on a fresh server. Only checkpoint digests are cached in server memory. The old prepared-BREP field remains for compatibility.

Committed sessions no longer expire because they are idle. Only unadopted, unchanged restore candidates are collected after 15 minutes, on subsequent server activity. Edited or explicitly resumed candidates are retained. Sessions shows capacity, retained drafts and redo counts. When the server is full it explains explicit recovery; it never evicts committed history. Servers started before this milestone report an upgrade path that keeps their existing histories alive on the old port.

Browser validation reopened the complete rover three times with only two sessions; corrupt second-part geometry and a later model-digest failure left those two sessions and the wheel redo branch intact. A wheel sheet edit (T 2 → 2.2; ZOFFS −1 → −1.1) was undone, saved and reopened on an empty server. Redo and Undo restored the expected metadata. Existing model/run digests still match. A real-kernel regression also restores a sliced solid and continues slicing it after restoration. The CAD layout no longer invokes the legacy sidebar widths over the new workspace docks.

`npm test` passes **517 tests** and `npm run test:cad` passes **198 tests**, including real-kernel and local HTTP integration checks.

See [reproducible validation evidence](validation/cad-sessions/README.md), including the portable CAD checkpoint, verifier and screenshots. No solver change or new external solver defect was involved.

## Remaining boundaries

- Legacy projects with audit labels only cannot recover missing historical geometry. Their current prepared geometry and labels still open; subsequent saves preserve executable history from that point forward.
- Server sessions remain process-local. Save the project before stopping its server; the new checkpoint carries retained history to a fresh process. There is no claim of crash recovery for an unsaved process-local draft.
- CAD preparation and FE transactions remain separate histories. Replacing a project intentionally starts its FE model history anew; a failed replacement preserves the existing FE stack. Unified CAD/FE history and topology replacement/matching remain future work.
