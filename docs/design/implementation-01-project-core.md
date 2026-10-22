# Implementation 01: project core

22 October 2026 · branch `codex/project-core-foundation`

## Outcome and boundary

Implement piece 1 of [model-rules.md](model-rules.md): a pure project-state module that can preview a change, identify its dependents, commit atomically, reject outdated candidates, and reconstruct its checks after saving. This is the first implementation milestone, not the complete S1–S2 rover workflow.

The module is `app/project.js`, available through CommonJS and the browser global `WebMeshProject`. It is intentionally not loaded by the editor yet: attaching an incomplete ownership system to existing card mutations would break R6. Existing projects and authoring behavior remain unchanged. Engine card ownership is the next milestone; the outstanding integrity fixes must land before activating the redesigned workflow.

## Contract

- `create({ name, units })` and `restore(snapshot)` return an isolated project store. `snapshot()` returns frozen JSON data. The core snapshot has its own `webmesh-project-core` format and version; it is **not** the version 2 editor project file.
- Objects have an ID, kind, name, dependencies, definition, overrides and validation facts. IDs are independent of Nastran numeric IDs. Kinds cannot change in place, and deleted object identities are retired rather than reused. Dependencies must exist and form a DAG.
- `begin(label)` captures the current revision. Its draft supports `putObject`, `removeObject`, `revalidate`, `acknowledge`, and `reserveIds`. No draft mutation changes the committed project.
- `preview()` reports direct changes, the complete downstream set, derived statuses, and ID reservations. `commit()` checks the captured revision again, validates everything, and swaps state once. `discard()` releases the draft without consuming a revision or IDs. Empty transactions do not increment the revision. Changing an upstream input later within the same draft also invalidates earlier downstream evaluations.
- Downstream objects require explicit re-evaluation by their eventual adapter. Until `revalidate` supplies current evidence, they are Invalid. Re-evaluated objects are Changed since verified until acknowledged. Acknowledgement cannot clear suspension, errors, unknown provenance or pending evaluation. This foundation does not pretend to regenerate a mesh or cards.
- Validation facts are `defined`, `issues`, `suspendedReason`, and `unverifiedReason`. Persist evaluation/verification revisions, not derived status flags. Dependency failures propagate. Required-input checks belong to the future analysis adapter.
- `checks()` derives every object's status. `readiness({ action, roots, acknowledgeOmissions })` supplies the shared solve/runnable-export gate and the explicitly acknowledged incomplete-export gate. Roots select an analysis and its transitive dependencies; omitted roots check the entire project. The function reports blockers and omissions; actual deck comments/manifests belong to the exporter milestone.
- Nastran ID reservations are separate by namespace. Each owner/role reserves an explicit block size; there is no arbitrary 100,000-ID default. The same role keeps its block. A larger request fails explicitly rather than renumbering. Additional blocks use additional roles. Imported ranges can be reserved with an explicit start and no owner. Blocks remain reserved after deletion, preventing silent reuse. Allocation cannot overlap or exceed the engine's 2,147,483,647 limit.
- Definition data and returned snapshots are copied and frozen. Failed validation, discarded drafts, stale commits and caller mutation cannot affect committed state.
- Units are stored and locked. This milestone supports declaring consistent units, not conversion or correcting an imported deck's interpretation. Run snapshots, including their units, follow in the solver milestone.

## Work and acceptance

1. **Update the design.** Resolve explicit-ID identity loss; splits, merges and signature ambiguity; suspension/export rules; stale candidates; units in runs; the review's small corrections. Align mockup D's action labels and regenerate its image.
2. **Implement project objects and validation.** Reject missing dependencies, cycles, duplicate IDs, malformed JSON, invalid evidence revisions and overlapping ID reservations on restore as well as commit.
3. **Implement the transaction boundary.** Exercise a wheel → region → attachment → analysis graph. Changing the wheel previews all dependents without changing live state. A downstream revalidation produces a review check; unrelated objects remain unchanged. A material edit committed while a wheel candidate is pending makes the candidate uncommittable.
4. **Implement checks and allocation.** Solve and runnable export return identical blockers. Incomplete export requires acknowledgement and returns every affected omission. Invalid objects cannot be cleared by acknowledgement. Existing roles remain stable and discarded allocations leave no trace.
5. **Implement core snapshot round trips.** Reopening reconstructs exactly the same statuses and reservations. Restored stores are isolated from their input data and each other. Browser-global and CommonJS entry points both work.
6. **Validate.** Run `node --test tests/project.test.cjs`, the full `npm test` suite, `git diff --check`, and inspect the updated recovery mockup. Record the results below.

## Follow-on milestone

Add an engine adapter with owner/role metadata, a complete reference index and an atomic card-diff boundary. Route all mutation paths through it before enabling project objects in the UI. Preserve imported hand cards; do not automatically adopt them. Tests must use the real parser/writer to show that generated cards agree with definitions, hand cards survive unchanged, and invalid references prevent commit. General pattern recognition, broad CAD reattachment, live instances, solver execution and unified CAD/FE undo remain later milestones.

## Validation record

The implementation is complete in `app/project.js`, with 24 focused tests in `tests/project.test.cjs`. The module is not connected to the editor yet.

- Focused tests: 24 passed.
- Full suite: 313 passed, 0 failed, 0 skipped (`npm test`).
- JavaScript syntax and `git diff --check`: passed.
- Recovery mockup D: rendered in the browser at its native 1440 × 900 size, visually checked, and saved to `mockups/D.png`.
- Existing review fixes and STEP/review artifacts were preserved outside this milestone's commits.
