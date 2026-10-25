# Milestone 16 — CAD source replacement and explicit repair

## Scope

Replace a part's CAD file without creating a second part or discarding its modeling intent. Preserve independent shell/solid mesh owners, live placements, regions, connection recipes and overrides. Make geometry correspondence reviewable, and keep incomplete revisions saveable while blocking analysis.

This is the first executable source-replacement milestone. It does not claim complete acceptance of model-rules S3: replacement currently suspends all meshes of the replaced source, even where individual geometry anchors match. Pattern-level recognition, confidence-ranked automatic acceptance, split/merge correspondence and selective preservation of unaffected meshes remain future work.

## Implemented actions

1. **Replace CAD source** from the part/source inspector. Import into a provisional session; export a portable checkpoint; preserve the current CAD draft and its executable preparation history before changing the project.
2. **Match topology** through a pure correspondence module (`app/cad-replacement.js`). Match only unique geometry plus adjacency within a small numeric tolerance. Never use equal entity numbers or counts as evidence. Persist the old anchor, match status, accepted replacement and candidate list.
3. **Inspect old/new geometry** in the viewport. Display the proposed CAD and draw the old selection's boundary in amber; highlight the selected replacement entity. The review restores the prior draft/display when closed or handed to the card review.
4. **Choose a replacement or leave it unresolved.** Face, edge and volume choices are explicit. Reject nonexistent targets and many-to-one assignments. Unmatched prepared sheets/cuts are left for analyst repair instead of guessed onto raw replacement faces.
5. **Review and commit suspension.** Retain definitions and reservations, remove the suspended objects' generated cards, and keep the part/source identity. Include live instances and all dependent regions/connections/supports/cases in the affected graph. Hand cards that would dangle block the transaction.
6. **Remesh independently.** Select each old mesh owner, load its region settings into the current CAD draft, and generate a normal proposed mesh. Carry accepted target matches into that selection. Retain scalar sizing/order and shell thickness/placement, but reset topology-dependent local controls for review. Sibling meshes and their retained definitions can remain suspended.
7. **Repair / reactivate** named regions and dependent objects in dependency order. Reuse the existing proposed-selection repair UI and generator pipeline. Instance and connection materializations are rebuilt with their owner. A CAD mesh cannot be reactivated simply by clearing its suspension flag; it must belong to the current source geometry.
8. **Undo/redo and save/reopen.** Model history swaps the active source and corresponding retained CAD draft. Part saves include historical replacement drafts/checkpoints, and restoration validates the complete envelope before importing any sessions. Candidate discard/failed import leaves the current project untouched.

The guided source-replacement flow composes these public actions; the existing mesh, selection and connection editors remain available. Suspended objects produce no cards, count as zero active elements in the tree and block Solve/runnable export. Their definitions and old cards are retained as repair evidence, not silently accepted as current geometry.

## Ownership and lifecycle rules

- Keep the part and source IDs. Give each replacement a revision token for CAD draft/history selection.
- Store a topology snapshot with the source and the source geometry key with each generated CAD mesh. Existing project files without stored topology can restore the committed source to obtain it before matching.
- Use a filtered active graph for normal regeneration; merge suspended definitions back into the final guarded ownership transaction. Validation refuses active definitions that still depend on suspended definitions.
- Preserve reserved identities. Regenerated meshes allocate fresh identities when layout changes; motor point/connection identities can remain stable after region repair.
- Retain an old section while a suspended materialization still depends on it. It may remain as an unused material/section definition after repair; automatic orphan-section cleanup is not part of this milestone.
- Reuse the current CAD runtime when editing another mesh region. Selecting a region must not reopen an older committed BREP and erase later preparation work.
- Restore source revisions on model undo/redo, while leaving ordinary CAD preparation history separate. A single unified CAD/FE timeline remains a later milestone.

## Validation

- Pure matching tests: renumbered entities, duplicate candidates, moved geometry, incomplete anchors and invalid explicit choices.
- Engine integration: replacement of a meshed part with a named mount, RBE2/CBUSH motor, live instance and support/case; suspended card removal, readiness blocking, hand-reference protection, remesh and explicit reactivation with stable authored identities.
- CAD draft tests: source revision undo/redo, distinct preparation histories, retained history serialization/restoration, envelope validation and cleanup on failed restore.
- Browser: import and manually mesh an original STEP block, create a live placement, replace it with a longer STEP block, inspect the old boundary/proposed solid, accept a changed-volume correspondence, commit suspension, undo/redo, save/reopen, remesh the original owner and reactivate the placement.
- Build/setup: root native library build, documented JavaScript/Python/native test commands; detailed root [setup.md](../../setup.md).

Validation evidence and final test results are recorded in [validation/cad-replacement](validation/cad-replacement/README.md).

## Remaining work and next recommendation

For a large assembly, the next source-replacement increment should group CAD entities into analyst-named feature/pattern rules, identify unchanged mesh regions, and stage their remeshing/connection regeneration in one review. It should then run the original S3 moved-motor-pattern rover case, preserving FL/FR/RL while repairing only RR. Split/merge choices need a dedicated graphical selection workflow rather than many-to-one dropdown substitutions.

Other original workspace gaps remain: unified CAD/FE history; viewing an old run on its immutable solved model; field-level recipe inheritance; owned load combinations; richer result fields/probes; and a consistent units/material editor. Read-only historical-run viewing is a useful independent milestone once the next source-replacement acceptance scope is agreed.
