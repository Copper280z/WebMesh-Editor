# 20 — O-grid cores and per-solid method switching

## Analyst workflow

Pick a prepared solid in **Size** or **Mesh**. Its **method** card offers **Mapped block** and, for a complete circular core, **O-grid**. The O-grid consists of one central quadrilateral block and four annular blocks swept along the cylinder. **Core radius ratio** controls the inner corner positions relative to the circular radius; **Radial layers** controls the annular thickness divisions. Circumferential and axial counts continue to use the existing edge controls.

The method belongs to the selected CAD solid. The rest of the region keeps its existing method. A shared circular cap requires the same cross-section mesh on both sides, so the action includes the connected circular core stack and names those dependent solids before generation. Switching back to Mapped block applies to that same stack. Unsupported geometry explains why O-grid is unavailable; the original mapped method remains usable.

The pending method change uses the existing remesh-impact highlights, local preview, quality review, Apply, dependency repair and model undo/redo. Old elements remain committed until Apply. Local remeshing preserves surrounding elements and their node identities. Saving retains both the committed method settings and the current CAD draft.

## Implementation

- Public pure actions in `hex-mapping.js` recognize circular cores, compute the shared-cap closure, validate method records, and assign a method. The inspector composes those actions with the existing mesh generation and reviewed patch actions. No separate automatic meshing pipeline is introduced.
- The internal five-block partition is a mesh definition on existing CAD, not a destructive BREP operation. Its parameters and method assignment are explicit and editable. Preparation history and CAD entity identities remain intact.
- Existing cylindrical wall grids are reused exactly. The central grid uses bilinear interpolation of scaled cap corners; annular grids interpolate from that core to the existing circular boundary. The same construction supports HEX8 and HEX20, including projected wall midsides.
- Internal cap nodes use topology-derived corner weights and shared boundary-node identities. Adjacent cores can have different local block orientations without duplicating their common nodes. Shared-face membership contains only nodes actually referenced by elements.
- Method and parameter changes invalidate their exact cap closure even when no edge count changes. The patch verifier checks actual shared quadrilateral connectivity, including quadratic midsides, against the retained mesh.
- A connected O-grid cap stack must belong to one mesh owner. Cross-owner method conversion is explicitly rejected. Exact CAD replacement remaps method targets; changed CAD preparation drops unprovable assignments with a review message instead of attaching them to renumbered solids.

## Acceptance

Validate the prepared 169-solid flexure and its locally refined blade. Switch solid 145 and its cap neighbors 150, 155 and 161 to O-grid; preserve the other 165 solids. Compare HEX8 and HEX20 quality, verify all 297 shared CAD faces, switch back, change parameters, and reopen the saved project. Check browser previews, Apply and undo/redo. Record measured results under `validation/solid-methods/`.

The follow-on [bulk-coarsening case](validation/bulk-coarsening/README.md) exercises the same local remesh workflow with size controls while retaining all eight blade meshes and the O-grid assignments: 15,508 → 7,900 → 6,184 HEX8. The second patch reduces the cylindrical surrounds from five radial layers to two. Across both patches, 89 solids are remeshed and 80 retained, all 297 shared CAD interfaces conform, and minimum scaled Jacobian is unchanged. Matched views include surrounding bulk solids, blade-root junctions and endcap surrounds.

## Scope

This method applies to already prepared straight, constant-radius circular cores with two complete circular caps, four logical circumferential sides and compatible opposite counts. It does not yet partition an unsplit cylinder, create O-grids around holes, or handle conical, branched or curved sweeps. Per-solid method switching currently covers native mapped blocks and these O-grids; independent shell regions and legacy Gmsh methods retain their existing workflows. Mesh quality is evaluated, not assumed to improve for every parameter choice.
