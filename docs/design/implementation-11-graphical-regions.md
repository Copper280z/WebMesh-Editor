# Implementation 11: graphical proposal selection and reusable mesh regions

23 October 2026 · branch `codex/project-core-foundation`

## Outcome and actionable plan

Select nodes and structural elements directly on a detached proposed mesh. Store selections as named, reusable project regions and repair them before applying an incompatible remesh. Picking, region creation and repair use the same public actions as direct ID input.

1. Add explicit node/element region definitions with owner/role and geometry bindings. Validate them during transactions and restore; never accept recycled numeric IDs as identity. Share node regions with supports and existing connection tools, and element regions with analysis participation.
2. Add an isolated viewport selection session for proposed/current mesh snapshots: node, element and face-node picking, additive/subtractive selection, box selection, visible-only filtering and owner scope. Show counts and selected IDs before use. Keep live cards, live selection and visibility unchanged on close/discard.
3. Extend Selections & repair with named-region authoring, editing, removal and graphical replacement. Keep pending CAD callbacks, stale-candidate guards and one reviewed transaction for downstream regeneration. Allow reusing a region in more than one consumer.
4. Test entity loss/reuse, protected plain-card selections, dependent updates, removal, history, source/export round trips and save/reopen. Manually exercise graphical authoring and proposed-mesh repair in the browser. Record validation and remaining limits here.

## Scope

Regions bind explicit mesh entities; they are not proximity rules or automatic geometry reattachment. CAD regions remain available. Face-node picking expands a visible element facet to its nodes; a named element region denotes whole elements. General topology matching, connectivity-edit replay, frame construction from picked geometry and live part instances remain separate milestones.

## Validation

Implemented. **Selections & repair** creates, renames, edits and removes explicit node/element regions. They carry no solver cards or numeric reservations. Owner/role, mesh-layout and geometric bindings are validated at the ownership boundary, including restore and hand-card edits. Frame changes do not invalidate geometric membership; replacement identities and changed positions/connectivity do. The final review regenerates known dependents atomically.

The detached picker isolates proposed geometry and offers node clicks, facet-to-node expansion, element clicks and boxes, additive/subtractive input, surface visibility filtering and owner scope. It uses its own selection state and restores scene visibility/listeners on exit. The viewport labels the proposal and hides unrelated result legends. Node regions are reusable in supports, RBE2/CBUSH attachments and distributed payloads; element regions drive analysis participation. Highlight current transfers a region to the ordinary selection for other existing tools.

Browser acceptance covered a 48 → 72 HEX8 remesh, graphical replacement of six lost mounting nodes, shared support/frame regeneration, a seven-element shell region, analysis exclusion/removal, discard, Undo/Redo and save/reopen. Both named regions and the final solver run survive reopening. See [retained evidence](validation/graphical-regions/README.md).

The MYSTRAN run completed with small epsilon estimates. The existing strict printed-result balance diagnostic flags near-zero residuals; the independently integrated six-component checks pass at explicit tolerances of 0.0001 N and 0.001 N mm. Both outcomes are retained in the evidence. No external solver-bug investigation is included in this commit.

Automated checks cover front/back occlusion, quadratic facet nodes, shared internal faces, scope isolation, selection cleanup, reused numeric IDs, geometry changes, multiple region consumers, region-backed exclusion repair, plain-node protection, tampered saves and real writer/history round trips. The isolated JavaScript suite passes **463/463 tests**, with no failures or skips. The retained solver-evidence verifier also passes its independent checks.

## Remaining limits and next step

- Explicit mesh regions are snapshots of entity intent, not automatic CAD/coordinate rules. Changed membership requires explicit repair. A region cannot change from nodes to elements in place.
- Picking uses basic GRID positions and piecewise facets through available corner/midside nodes. Shell offsets and deformed shapes are not used for picking. Beam/rigid glyph selection, persistent facet regions, polygon/brush tools and geometric matching remain separate work. Box selection uses facet centers for elements; disabling surface-only enables selection through the mesh.
- Direct consumer links currently cover supports, mounting attachments, payload guides and analysis exclusion. Other tools can use **Highlight current**; not every older mesh recipe subscribes to a named region yet. Ordered connectivity must still be authored explicitly.
- Connectivity-edit replay and constructing frames from picked geometry remain open from milestone 10. Independent parts, per-part CAD state, transforms/reflections and instance-scoped regions are now implemented in [milestone 12](implementation-12-parts-instances.md). Complete the broader rover/wheel connection and solve acceptance next. Grow the project tree/inspector with that work. Improve printed-result balance diagnostics separately with a precision-aware check.
