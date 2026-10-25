# 19 — Analyst-directed local mesh revision

## Case study and intended workflow

Start from the prepared flexure with 169 mapped solids. Its initial mesh is acceptable, but resolution is poorly distributed: a representative 0.5 mm blade has one thickness interval while the 12 mm depth has six. The analyst should be able to revise that distribution without repeating preparation or discarding unrelated mesh.

| Analyst action | Expected behavior | Delivery |
| --- | --- | --- |
| Change global size | Re-solve compatibility, identify blocks whose actual counts change, preview their replacement | Implemented |
| Set an edge count or local size | Show directly changed blocks and dependent blocks, with the changed edge counts explaining each | Implemented |
| Set a solid size | Apply a regional target; keep explicit edge controls; propagate compatible counts | Implemented |
| Refine a blade without replacing the bulk mesh | Remesh the affected closure within its mesh region, retaining unrelated element/node identities | Implemented |
| Remesh selected cylinders | Selected solids plus any pending count dependencies; retain the rest of the region | Implemented for the existing mapped topology |
| Switch a cylinder to an internal O-grid | Preview a central quad block and four annular blocks, matching the surrounding interface and projected cap layers | Delivered in [milestone 20](implementation-20-solid-methods.md) |

An O-grid is a topology/method choice, not an instruction to increase all counts. It should be an explicit, optional action on chosen circular cores. It must expose the same partition and meshing operations available to the analyst. Existing mapped blocks remain a valid choice. The action must show any axial cap layers and neighboring partitions it changes, preserve the old mesh until review, and reject a boundary mismatch rather than quietly opening a seam.

## Delivered interaction

In **Size**, picking a solid exposes its local size and its three directional edge controls, including physical length and solved interval count. For the representative blade, the 0.5 mm direction is directly identifiable without hunting for a tiny viewport edge. Edge count controls remain hard constraints. Edge sizes take priority over solid sizes; the finer of overlapping solid targets wins. Local targets are not diluted by averaging them with untouched global targets in the same equality group. Sum equations can still require a different count, and existing conflicts/stretched-target diagnostics remain available.

**Remesh impact** compares committed counts with proposed counts. Orange means directly changed, amber means dependent, and unchanged geometry is muted. Solid rows identify required remeshing. Expand **Why these solids?** for the actual edge-count changes. A control edit that rounds to the same solved counts does not flag a remesh. Draft impact is separate from committed project status: dependent analysis objects are listed for rechecking on Apply, while the committed deck remains usable until the edit is accepted.

**Preview affected solids** changes the mesh scope to the affected closure. **Selected + dependents** also permits an explicit local remesh without changing a control. **All mappable** remains available for complete regeneration. Changing element order or section grouping requires complete regeneration. The preview is followed by the existing reviewed transaction, dependency repair, Apply and model undo/redo workflow.

## Implementation and invariants

- `cad-local-mesh.js` exposes pure sizing, impact, provenance and patch actions. Guided UI calls those same operations.
- The interval solver still solves the complete prepared CAD compatibility graph. Impact is based on changes to every constituent boundary edge, including compound logical sides; a generic flood-fill through touching volumes would overinvalidate the model.
- New solid meshes save exact solid-to-element membership. Older meshes can acquire it only after reproducing all their committed coordinates and connectivity exactly. This one-time verification generates a baseline but does not replace its cards. If it fails, local remeshing stops with a complete-regeneration instruction.
- Patch generation uses only selected/affected solids. The builder rejects omitted count dependencies, changed CAD geometry, incompatible element order/section grouping, incomplete coverage and unprovable boundary membership.
- Retained elements, their GRIDs, sections and material cards remain unchanged. Patch nodes join retained nodes only on the same recorded CAD face. Actual quadrilateral interfaces, including HEX20 midside nodes, must match; matching counts or a connected-component result is insufficient.
- Controls and solid membership persist with the project. Geometry preparation retains solid controls only on uniquely matched unchanged geometry. New local patches enter the existing ownership transaction and reference checks; hand references to removed interior nodes still require repair.
- Reopened mesh previews explicitly request CAD visibility, correcting the previous blank-preview behavior when the committed mesh had hidden the CAD overlay.

## Acceptance

See [the flexure case evidence](validation/local-remeshing/README.md). Automated coverage includes HEX8/HEX20 retained interfaces, repeated patches, serialized ownership validation, conservative legacy recovery, local-target priority, dependent-scope enforcement, falsified quadratic boundary rejection and the real flexure blade propagation.

## Remaining scope

The present patch operation is for unchanged CAD topology inside one mapped solid mesh owner. It does not silently replace CAD preparation, switch a subset to Gmsh, or convert blocks to an O-grid. Regions with authored connectivity edits or embedded-interface ownership require complete regeneration and dependent review; analysis exclusions on replaced elements must be resolved first. Independent mesh owners keep their existing interface/dependency review. A unified cross-owner sizing edit and assembly-wide draft highlights remain future work. CAD preparation undo and FE transaction undo are still separate histories.

[Milestone 20](implementation-20-solid-methods.md) implements the internal O-grid action, its cap-stack propagation, and method switching through this impact/review workflow. Its acceptance compares HEX8 and HEX20 quality, retained IDs and every shared face, plus browser switching and undo/reopen. Deliberate bulk coarsening and a blade convergence study remain follow-up case work; a visually better distribution alone does not establish analysis convergence.
