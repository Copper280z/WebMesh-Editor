# Implementation 10: selection repair and reusable frames

23 October 2026 · branch `codex/project-core-foundation`

## Intended outcome

Keep a proposed remesh pending while the analyst inspects broken selections, supplies replacements and reviews the regenerated model as one transaction. Provide reusable rectangular frames for CBUSH stiffness, nodal forces, acceleration and support DOFs. Guided authoring composes the same public frame, assignment and selection actions available individually.

## Implementation plan

1. Add a selection inventory and pending-model projection. Report changed topology, missing identities and changed explicit inputs; show current and proposed selections. Repair named regions and explicit node/element selections without deleting downstream objects. Preserve generated IDs where output roles survive; keep unsupported connectivity edits blocked.
2. Add owned CORD2R frames with explicit basic origin, point on +Z and point in the XZ half-plane. Validate orthonormal right-handed axes; retain stable coordinate IDs through edits, undo and save/reopen.
3. Reference frames from attachments and load actions. Expose GRID displacement-frame assignment as an explicit action and compose it with support authoring. Review all affected GRID CD values, since this frame applies to every constraint/result on a node. Block conflicting support expectations.
4. Exercise remesh/repair, downstream attachments/masses/supports, export formats, history and stale results. Validate a rotated-frame static solve and inspect the browser workflow. Keep external solver investigations outside tracked project documents.

## Boundaries

Rectangular frames use RID=0 and explicit basic positions. Imported coordinates remain ordinary solver cards. Geometry tools continue to require CP=0; CD may be local. Frame assignment is available for project-owned GRIDs; ordinary GRIDs retain their card editor. Selection repair never guesses geometrically nearest replacements. Connectivity-changing manual sharing needs explicit restoration/re-authoring if its saved source cannot be safely reconstructed.

## Validation and remaining work

Implemented. Model setup now has **Selections & repair** and **Reusable coordinate frames**. The repair inventory shows downstream users, old selections, proposed source GRID coordinates and explicit invalidation reasons. Repair stages a replacement without changing the model; final Apply includes regeneration and the complete ownership/card diff. Closing/discarding and a changed-model guard protect the pending proposal.

Repair adapters cover named mounting regions, both interface formulations, explicit supports/forces, direct mass/RBE3 actions, node/element mesh recipes and analysis exclusion. A replacement support can contain a different number of nodes. Manual mesh recipes retain output slots when their output shape still matches; incompatible output topology receives fresh IDs. Public frame assignments are stored with GRID owners and reapplied after geometry generation. Region-backed support assignments follow the resolved region after remeshing. Conflicting support frame expectations and inconsistent saved GRID/frame metadata are rejected.

CORD2R, local FORCE/GRAV, CBUSH CID and GRID CD pass real source/free/small/large writer/parser tests. The F06 displacement parser now retains arbitrary coordinate IDs, including IDs above 99; nodal displacements and force vectors are transformed to basic XYZ before contours/deformation. Printed local reaction vectors are transformed for run balance checks. Unsupported/unresolved output frames fail explicitly.

The [acceptance evidence](validation/selection-frames/README.md) includes the browser-authored remesh/repair, rejected invalid ID, undo/redo, two-case solve and saved-run reopening. Both browser cases passed numerical and balance checks. A separate combined motor, battery and offset-payload assembly passed before/after remesh solves, direct force repair, and independent six-component reaction checks to 0.0001 N or N mm. No external solver bug changes are tracked in this milestone.

Final isolated branch checks passed all 453 JavaScript tests and all 183 Python tests, with no failures or skipped tests. JavaScript syntax checks and staged whitespace checks also passed; exact solver F06/log files retain their original formatting. The saved browser run's deck and solver output match the retained evidence, and the independent equilibrium verifier reproduces the recorded six-component checks.

## Next milestone

Implemented in [milestone 11](implementation-11-graphical-regions.md): picking/filtering proposed nodes and facets, editable named node/element regions, and graphical selection repair. Extend repair of reversible connectivity edits with explicit restoration/replay, and add frame construction from picked geometry using the same actions. Continue assembly acceptance on the rover and wheel once multi-body instance placement is available. Snapshot comparison should expose changed mass/overlap and quantities of interest alongside matched results.

Remaining limits: first-slice repair uses explicit IDs/CAD entity selectors rather than automatic proximity matching; plain card references still block deletion until edited. Nested/cylindrical frames and nonbasic GRID positions are not authored here. Support authoring can preserve existing GRID directions, including imported nodes; assigning a reusable frame currently requires owned GRIDs. A node has one CD shared by all cases and constraints. Removing a support does not reset that GRID frame. F06 vector conversion currently resolves rectangular RID=0 output frames.
