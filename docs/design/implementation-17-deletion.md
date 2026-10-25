# Milestone 17 — reviewed deletion and independent dependents

## Plan

Expose **Delete…** on project-tree context menus and object inspectors. The docked deletion view lists the selected object and its dependents, offers **Keep dependents** / **Delete dependents**, and allows individual choices. Keep is the default. Preview the consequences before committing one undoable transaction.

Keeping means making an independently authored object, not abandoning its cards in the deck. Preserve names, object/card identities, mesh geometry, properties and current settings. Live instances become independent mesh parts; recipe connections can retain an independent recipe. CAD-derived selections become explicit mesh regions. Kept objects with missing geometry are suspended and remain repairable; they produce no dangling solver cards and block analysis until repaired or deleted.

The deletion workflow composes the public **Make independent** action. Shared materials, sections and coordinate frames survive while referenced. Hand-authored cards are never silently deleted or retargeted. Keep CAD drafts available to undo; reopening a saved project must reflect the committed deletion without resurrecting removed CAD.

## Acceptance

- Right-click and keyboard Delete open the same inspector; cancellation changes nothing.
- Keep/remove-all and mixed choices show their effects before Apply.
- Delete a meshed CAD part while retaining selected placements as independent mesh parts, with stable node/element IDs.
- Preserve or remove connections and regions according to explicit choices; missing references suspend generated objects and block solve.
- Delete a connection recipe while retaining independently editable connections.
- Undo/redo restores ownership and CAD drafts. Save/reopen preserves retained objects and suspension state.
- Regression checks cover hand references, shared resources, stale reviews, and source replacement followed by deletion.

## Implemented

- Tree context menu **Delete…**, keyboard Delete, and Shift+F10/context-menu key. Existing part, instance, recipe, attachment, payload and analysis removal buttons use the same inspector. Group headings and saved runs do not expose model-object deletion.
- Compact dependent list with keep/remove-all buttons, individual choices, optional orphan material/section cleanup and a live outcome summary. The existing card-difference review is the final Apply step. Stale reviews reject; Cancel/Discard has no model effect.
- `app/deletion-project.js` exposes dependency inspection, independent promotion, deletion planning and independent editing as pure actions. It reuses the existing instance-to-independent-mesh and private-recipe actions. **Make independent…** is also directly available for live instances and recipe connections in the tree.
- Generated meshes retain their owner IDs, card IDs, roles, allocations, layout identity, analysis participation and shared properties. A promoted live instance becomes a new independent part through the existing make-independent action; its mesh owner and all GRID/element IDs remain unchanged. Dependent scoped regions lose their live scope and retain explicit membership.
- Other kept generated objects become named independent definitions with their original recipe retained as provenance. CAD selectors become explicit node regions. The independent inspector edits one card at a time, with family/ID lookup and guarded value/connectivity changes. It does not flatten objects into unowned cards.
- Missing inputs suspend retained definitions and dependent cases to a fixed point. Suspended objects emit no cards; cases emit no stale case-control references. Existing graphical region repair remains available; independent connection/load/support card fields can be explicitly retargeted and reviewed. Kept frames retain their coordinate editor. No node is invented to replace deleted geometry.
- Unused materials/sections belonging to removed meshes are optionally reclaimed. Shared definitions and anything referenced by hand cards survive; hand cards that would dangle block the final transaction.
- Removed CAD drafts and replacement histories remain in the current workspace for model Undo. Saved live drafts prune retired mesh-owner records and omit removed CAD parts, preventing resurrection or restore errors. Runtime CAD sessions are retained while needed for Undo, consistent with milestone 15; deletion does not prematurely destroy their executable preparation history.

## Validation

Automated tests cover keep/remove/mixed decisions, missing-input suspension and explicit repair, private recipe detachment, source analysis exclusion, hand references, source replacement followed by deletion, saved ownership validation, shared resource preservation, and CAD draft undo/save pruning. A regression uses the complete saved rover: deleting the wheel source retains four independent wheels, all motor cards, supports, masses, case control and the imported LOAD combination.

Browser validation covers right-click, keyboard Delete, delete-all preview, cancellation, mixed source deletion/placement retention, undo/redo, save/reopen, and reviewed edits to the retained independent mesh. See [validation evidence](validation/deletion/README.md).

This milestone preserves the existing distinction between runtime model Undo and project persistence. Reopening a project restores its committed state; it does not introduce a persistent unified CAD/FE undo timeline. The broad topology/pattern matching and historical-run viewing items remain open.
