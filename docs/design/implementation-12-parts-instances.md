# Implementation 12: independent parts and live instances

23 October 2026 · branch `codex/project-core-foundation`

## Actionable plan

1. Add explicit part definitions and a Parts workspace. Add CAD as a new part without replacing another part's draft. Preserve separate source snapshots, CAD sessions, sizing, mesh regions and preparation history. Restore old single-CAD projects without losing their existing ownership.
2. Add reviewed live placements with translation, rotation and reflection. Materialize separate GRID/element IDs with shared sections/materials; regenerate all instances when the source mesh changes. Validate generated instances against their definitions at the engine boundary. Preserve shared nodes inside a mixed mesh and reject incomplete/external connectivity.
3. Resolve named regions on selected instances through the source-to-instance mapping. Keep connection/support identities while rebuilding downstream cards; explicit source selections still require repair after incompatible remeshing. Offer removal and independent mesh copies through the same reviewed actions.
4. Save/reopen every CAD draft and live definition. Exercise failure/discard, undo/redo, independent remeshing, reflection orientation/offsets, card ownership and instance-region consumers in tests.
5. In the browser, load `rover_chassis.step` and `wheel.step` as independent parts in one project, create wheel instances, edit/remesh the wheel, and save/reopen the assembly. Retain evidence and describe boundaries honestly.

## Architecture

A part retains its own CAD source and committed mesh regions. The source placement remains at its modeling coordinates; additional live instances have only placement/name as authored inputs. Each instance's mesh materialization is a derived ownership object with explicit node/element mappings, not an independently editable recipe. Shared sections/materials remain owned by their original definitions. Instance-region definitions scope a source region to a placement. Regeneration composes the same public part, placement, region and transform actions used by the UI.

CAD preparation is a per-part draft until a mesh review commits it. Switching parts must retain the in-session CAD undo history. Saved projects retain each prepared BREP and settings; older preparation history reopens as an audit record, as before.

## Validation and remaining work

Implemented and validated; details and remaining boundaries follow.

## Implemented outcome

The Parts workspace adds CAD files as independent sources and retains each part's live session, preparation, sizing and mesh-region draft while switching. Save/reopen embeds the original files and prepared BREP snapshots for all parts. Adding a part to an older single-CAD project adopts the existing owned mesh and draft in the same reviewed transaction. Failed imports and discarded reviews leave the active model unchanged.

Live instances have editable translation, XYZ rotation and reflection. Their generated nodes and elements have separate IDs; materials and sections stay shared. Source remeshing regenerates every copy in one review, including internal mixed shell/solid interfaces and shared connectivity. Reflections reorder corner/midside connectivity so solid orientation and offset-shell material sides remain correct. Instance-scoped node/element regions resolve through the source mapping and feed existing assembly consumers. Direct frame selections still require explicit repair when their mesh identities are replaced.

The source placement stays in modeling coordinates. **Use source as reference only** excludes its elements and unused source GRIDs from analysis export; nodes still referenced by assembly cards remain. Project saving retains the complete editable source mesh. **Make independent mesh** keeps placement IDs and existing assembly references but freezes a mesh snapshot; it stops following source CAD remeshing. Both actions are reviewed and undoable.

Two scaling problems surfaced during browser acceptance and were fixed: dependency validation cloned the entire mesh for each cross-owner reference (a measured placement preview fell from ~19.1 s to ~0.85 s), and instance regions repeated a full connectivity key for each selected node. Regions now use compact generation identities while each instance retains the complete source comparison once. Large reviews load owner/card details when expanded.

## Validation results

- Automated coverage includes independent parts and drafts, legacy adoption, failed/discarded imports, saved draft ownership, source remesh propagation, transform ID stability, reflected HEX20/CQUAD8 connectivity, shell offsets, mixed RBE3/shared-node interfaces, scoped regions and support regeneration, direct frame repair, independent copies, source participation, tampered metadata, real writers and atomic history.
- Browser acceptance loaded both repository STEP files; manually extracted and joined wheel web/rim sheets; meshed 1,214 quads / 1,348 nodes; created four translated/rotated instances, two reflected; changed source participation; switched CAD drafts; discarded then applied a 2 → 2.5 mm source remesh to 892 quads / 1,008 nodes per wheel; edited shared PLA material; created a 722-node instance region; saved and reopened the assembly. Card-level review was expanded and inspected.
- The [saved assembly and verifier](validation/parts-instances/README.md) retain original CAD, prepared sheets, live mappings, source participation and the scoped region. The verifier compares the pre-remesh checkpoint, confirms the chassis source is unchanged, checks transforms and mesh quality, and validates saved ownership/deck counts.
- The final isolated JavaScript suite passes **479/479**, with no failures or skips. Browser analysis export contains 3,568 wheel elements and 4,032 GRIDs; the editable save retains the source mesh. Detailed results are recorded in the evidence README.

## Boundaries and next milestone

This completes independent CAD parts and live mesh placements, not the entire original assembly vision. The saved chassis is an unmeshed CAD reference; the wheel meshes are placed but not connected by motor attachments. No new solver run is claimed by this fixture.

Repeated browser reopen tests reached the existing 24-session quota. A fresh server reopened the fixture successfully without deleting old sessions; quota preflight and session lifecycle management remain follow-up work.

Remaining assembly work: independently editable copies of the CAD/meshing recipe (beyond frozen mesh copies); source replacement with topology matching/repair; per-part isolate/visibility controls and CAD placements before meshing; graphical placement/mating; reusable connection repeats and overrides; and full rover connection/load/solve acceptance on this part architecture. Original/global source placements are fixed; additional placements carry transforms. Assembly supports, masses, CBUSHs and their frames are deliberately authored separately from source-mesh instancing. Non-basic GRID coordinates, non-basic element material directions and partial internal-rigid DOF sets fail explicitly rather than being transformed incorrectly.

The next actionable milestone should compose reusable assembly connections from instance regions and points, preserve their references through remeshing, and complete the rover motor/wheel/battery/payload solve workflow. Connectivity-edit replay and geometry-derived frames remain open from milestone 10; precision-aware printed-result diagnostics remain separate.
