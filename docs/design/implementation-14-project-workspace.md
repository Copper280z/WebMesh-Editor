# Implementation 14: project tree, visibility and docked editing

Status: implemented and validated · `codex/project-core-foundation`

## Goal

Make the analysis model the center of the interface. Keep the tree, viewport and active editor together; spend space on objects and editable values rather than instructions. Guided workflows continue to compose public analyst actions.

## Actionable plan

1. Replace the flat object/card browser with a persistent, searchable hierarchy: parts, source meshes, live instances, regions, definitions, connections, loads/supports, analyses and saved runs. Keep plain solver cards accessible. Show compact status/count indicators and context actions. Preserve expansion and selection during model updates.
2. Add per-object show/hide and reversible isolation. Visibility must remain separate from analysis participation, generated cards and run identity. Resolve objects to current mesh identities after remeshing; keep shared nodes visible when a visible element uses them. Persist view preferences in the project, without invalidating results.
3. Put object editors and transaction reviews in a resizable right dock. Use compact field layouts, progressive disclosure and sticky actions. Keep viewport picking accessible. Stage navigation changes a compact tool palette without discarding the current editor or selection. Provide usable narrow-window overlays and keyboard navigation.
4. Add a compact selection toolbar and linked project checks/activity dock. Remove duplicate statistics, decorative labels and static help paragraphs from the primary workflow; retain help on demand. Integrate parts, regions, connections, cases and result controls with the new shell.
5. Test hierarchy, visibility resolution, shared-node behavior, persistence, result independence, editor/stage behavior and stale transaction protection. Run the JavaScript regression suite and targeted CAD checks when affected.
6. In the browser, load the complete rover, exercise tree/visibility/editing, remesh the source wheel, repair contact regions against the proposal, apply all four instance/connection changes, run both MYSTRAN cases, inspect contours/deformation, and save/reopen. Retain the exact deck, results, verifier and screenshots under `docs/design/validation/project-workspace/`. Record any external solver defect separately under ignored `solver-bug-reports/`.

## Acceptance

- The analyst can locate and edit each rover part, instance, named region, motor connection and analysis from the tree without navigating a long tool catalog.
- Showing or hiding the source wheel or an individual instance does not change the solver deck, analysis participation or matching-run identity. Isolation restores the prior visibility. Choices survive save/reopen and compatible remeshing.
- The tree and editor remain usable while picking the model; stage switches retain the active editor and inputs. Reviews retain exact changes and reject stale candidates.
- A changed source wheel mesh updates four placements and their CAD-bound connections; explicit contact selections are repaired before commit. MYSTRAN completes both cases with connected topology and checked output coverage/equilibrium.
- No claim of complete CAD topology replacement, unified CAD/FE history, read-only old-run views or full result-family redesign is made by this milestone.

## Outcome

Implemented on the existing branch. `project-view.js` resolves hierarchy, inherited visibility and isolation independently of the solver model. `workspace-shell.js` supplies the tree, stage palettes, dock sizing, selection controls, checks and saved view preferences. Existing object editors and exact transaction reviews now use the right dock. Source CAD, source FE meshes and placed instances have distinct visibility. Fit/view direction account for narrow-window overlays; legends and viewport controls stay outside them.

The browser acceptance changed the wheel size from 2.5 to 3 mm and per-circle count from 16 to 12. All four instances and their driven RBE2s regenerated. The analyst box-picked 80 replacement contact nodes on the proposed mesh before applying 16,755 card changes. The chassis, battery and payload definitions remained unchanged. MYSTRAN completed both cases; the saved project reopens with two intact runs, the reference wheel hidden, and the new run matching the editable model. Displacement/stress contours and deformation were inspected.

The JavaScript suite passes all 506 tests in the working tree, including the existing unrelated changes. New coverage exercises hierarchy, shared-node visibility, inheritance after remeshing, isolation restoration, preference sanitation, run independence and orthographic/perspective fitting beside overlays. See [validation evidence](validation/project-workspace/README.md) for exact numerical checks and reproduction.

A retained limitation surfaced: repeated test project opens filled the existing server’s 24 CAD sessions. No sessions were discarded. Reopen acceptance continued on a fresh loopback server at port 8796. Session reuse, failed-restore cleanup and clearer capacity recovery belong in the next reliability follow-up. No new external solver defect was identified.

This milestone does not implement every original redesign detail: context actions cover Edit, Show/Hide, Isolate and Highlight; rename/repeat/removal remain in the relevant inspectors with review. Legacy editors are docked and compacted, with deeper editor-specific redesign still incremental. Old-run read-only viewing and the broader result-family design remain open.
