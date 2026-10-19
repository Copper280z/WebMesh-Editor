# WebMesh Studio 3.0

WebMesh Studio is a modular, browser-based finite element pre/post processor for Nastran `.bdf` and `.dat` decks. Build connected meshes from primitives, assemble them with patterns, mesh CAD through a local Gmsh service, define model cards, and review MYSTRAN F06 results.

## Start the editor

**Browser only:** open `WebMeshEditor.html` in a current desktop browser with WebGL enabled. Keep the `app/`, `styles/`, and `vendor/` folders beside it. Scratch modeling, patterns, deck editing, export, and results review run locally without an installation, build step, CDN, or server.

**With CAD meshing:** install the Gmsh command-line executable and check that `gmsh -version` works. Start the included Python server from the repository directory:

```sh
python3 server.py
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765). The CAD & mesh workspace reports when Gmsh is connected. Python uses only its standard library; no pip dependencies are required. If Gmsh is outside `PATH`, provide its executable explicitly:

```sh
python3 server.py --gmsh /absolute/path/to/gmsh --port 8765
```

The service binds to `127.0.0.1`. CAD is processed on your machine in a temporary working directory. A static web host can serve the browser editor, but CAD meshing requires opening the editor from this local service.

## Modeling workflow

| Workspace | Tools |
| --- | --- |
| Geometry | Blocks, rectangular plates, solid or hollow cylinders, and annuli; dimensions, origin, divisions, mesh topology, element order, material and thickness |
| CAD & mesh | STEP/STP, IGES/IGS, BREP and STL import; triangle/quad surface or tetrahedral/structured hex volume meshes; first and second order |
| Pattern | Linear arrays in one, two or three vector directions; circular arrays about any axis and center; selected elements or the whole model; optional coincident-node welding |
| Model setup | Materials, properties, loads, constraints, coordinate systems, individual entities, schema-based card modification, transforms, selection and connectivity checks |
| Post-process | MYSTRAN F06 result sets, deformed shapes and animation, stress/strain/force contours, temperature load contours, legends and criteria |

Use **Preview mesh** to inspect the generated wireframe before choosing **Add to model**. Each addition allocates unused node, element, property and material IDs and enters the model's undo history. Existing model definitions remain in place. **Explore an example** creates an annular flange and a circular array of solid parts in an empty workspace.

Scratch meshes use shared nodes within each primitive. Adjacent tetrahedral cells share consistent face diagonals, and quadratic elements share their midside nodes. Solid cylinders use mapped blocks around the center to avoid collapsed elements on the axis. An annulus can be a ring shell or an extruded hollow volume.

### Element families

| Topology | First order | Second order |
| --- | --- | --- |
| Triangle | CTRIA3, 3 nodes | CTRIA6, 6 nodes |
| Quadrilateral | CQUAD4, 4 nodes | CQUAD8, 8 nodes |
| Tetrahedron | CTETRA, 4 nodes | CTETRA, 10 nodes |
| Hexahedron | CHEXA, 8 nodes | CHEXA, 20 nodes |

Nastran uses the same `CTETRA` and `CHEXA` card names for both orders. The meshing layer preserves all midside connectivity and converts Gmsh's node ordering to Nastran ordering. Generated shell properties are `PSHELL`; generated solid properties are `PSOLID`. Default material values are `E = 210000`, `nu = 0.3`, and `rho = 7.85e-9`, consistent with mm, N, s and tonne. The editor does not convert units: all imported geometry, material values, loads and results must use one consistent system.

### Patterns and joining

Linear instance counts include the original. Use counts such as `[5,1,1]`, `[5,3,1]`, or `[5,3,2]` for one-, two-, or three-direction arrays, with a spacing vector for each active direction. Circular patterns use a center, axis, instance count and sweep angle. A full 360-degree sweep omits the duplicate final instance; partial sweeps include both endpoints.

A merge tolerance of zero keeps instances disconnected. A positive tolerance welds matching nodes to the existing model and to other instances. Check dimensions and tolerance before joining parts. Pattern operations preserve property assignments. Loads, constraints and coordinate definitions remain attached to the original entities; the legacy transform tools provide separate metadata-copy controls.

The pattern and connectivity tools support triangle, quad, tetrahedral, hexahedral and `CROD` elements. Other structural cards remain available through the deck/card tools, but cannot currently be patterned by the new workspace.

## CAD meshing

Choose a CAD file, select surface or volume meshing, then choose topology, order and target size. **Generate CAD mesh** runs Gmsh and appends the resulting mesh. The local bridge also provides sample CAD geometry for exercising the workflow.

- Triangles and tetrahedra use unstructured meshing.
- Quads use surface recombination. Geometry that cannot produce the requested all-quad mesh is rejected instead of silently returning mixed elements.
- Structured hex meshing uses transfinite curves, surfaces and volumes. CAD must already have compatible block topology, normally six four-sided faces per volume. Arbitrary CAD is not automatically decomposed into hex blocks. Structured divisions control the number of intervals along each curve.
- STL surface remeshing requires a suitable manifold surface. Volume meshing additionally requires a closed shell. The bridge rejects structured hex meshing of STL.
- CAD geometry must be cleaned or partitioned in an external CAD tool when necessary. The editor does not yet provide interactive CAD booleans, defeaturing, face partitioning, or a full sketch/constraint system.

Requests accept CAD data files, not executable `.geo` programs. The service limits CAD uploads to 24 MiB and meshing time to 90 seconds, runs one mesh job at a time, and validates the resulting element type and connectivity. Meshing failures retain Gmsh's diagnostic output in the workspace. Surface/volume dimension and requested element topology must match the result.

## Open, save and export

**Open** accepts Nastran decks or saved `.webmesh` projects. For decks containing `INCLUDE` statements, use the model file/folder controls or drop the entry deck together with its included files. Imported source is retained worker-side so editing and export can preserve other solver cards and case-control content.

**Save project** downloads a `.webmesh` JSON snapshot containing the current deck, selected source CAD and recent operation descriptions. The project file does not include imported F06 results, the full undo stack, or every viewport setting; reopen results files after restoring a project. Projects are downloaded files, not an automatic cloud save.

**Export deck** downloads a Nastran `.bdf` file for an external solver. The underlying writer supports free, small and large field formats. WebMesh prepares and reviews models; it does not execute a structural solver or generate a complete analysis setup automatically.

## Viewport and selection

| Action | Control |
| --- | --- |
| Orbit | Left mouse drag |
| Pan | Ctrl + left mouse drag |
| Zoom | Mouse wheel |
| Pick an entity | Left click |
| Box select | Alt + left mouse drag |
| Polygon select | Ctrl + Shift + left click |
| Set pivot | Double-click on the model |
| Context menu | Right click on an entity |
| Fit model | **F** or viewport fit button |
| Undo | Ctrl/Cmd + Z |
| Redo | Ctrl/Cmd + Shift + Z or Ctrl/Cmd + Y |

Use the model browser and selection controls to choose nodes, elements, loads, constraints or properties. Display tools retain shading, edges, opacity, entity visibility, load-case filtering, labels and clipping controls. Selection tools retain ID lists, selection-derived editing and CSV exchange.

## Temperature load contours

A deck containing `TEMP` or `TEMPD` cards can display temperature contours without an F06 file. Open the result controls in **Post-process**, select **Temperature Load**, choose the temperature set, and enable **Show Contour**.

Linear, nearest-neighbor and cubic interpolation act on temperatures before the palette is applied. Continuous/banded colors, manual legend ranges, reverse colors and criteria labels remain available. `TEMP` values override the set's `TEMPD` default; unassigned regions appear gray. Cubic interpolation may exceed the nodal range. The default set follows `TEMPERATURE(LOAD)` in case control when available.

## Scope and validation

The mesh checker detects missing references, duplicate IDs/connectivity, degenerate or inverted linear cells, damaged midside connectivity and boundary topology issues. It is not a substitute for solver-specific quality checks. Curved second-order Jacobians, complete material/unit validity, all element formulations and full solver-deck completeness need separate verification. Rendered curved elements use faceted tessellation.

Interactive scratch generation and pattern operations are capped at 500,000 nodes and 250,000 elements per generated operation. Large imported decks use the existing compact worker/typed-array rendering path. Browser memory and GPU capacity still determine practical limits.

## Development

The repository is source-ready and has no JavaScript build requirement:

| File | Responsibility |
| --- | --- |
| `WebMeshEditor.html` | HTML shell and retained editing controls |
| `styles/workbench.css` | Modern workspace layout and styles |
| `styles/editor.css` | Existing editor/card styles |
| `app/workbench.js` | Workspace UI, dialogs, projects and CAD requests |
| `app/modeling.js` | Pure mesh generation, patterning, validation and BDF helpers; browser/Node UMD module |
| `app/editor-engine.js` | Nastran editor state, rendering, selection, card editing, results and undo/redo |
| `app/card-worker.js` | Readable parser/writer worker, wrapped as an uncalled factory for offline Blob-worker startup |
| `app/nastran-schema.js` | Readable schema for card forms |
| `vendor/three-runtime.js` | Bundled Three.js, controls, label renderer and environment loaders; preserved MIT notices |
| `server.py` | Optional loopback HTTP server and Gmsh CAD bridge |

`window.WebMeshAPI` is the boundary between the new workbench and the existing engine: state/ID queries, global-coordinate mesh reads, validated append, preview, import/export, selection, card editors and history controls. Changes emit `webmesh:change`; engine availability emits `webmesh:ready`. Keep solver data in the engine and geometry algorithms in the modeling module rather than duplicating them in UI code.

Run the JavaScript and Python suites:

```sh
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p 'test_server.py' -v
```

Or use `npm test` and `npm run test:cad`. JavaScript tests cover analytic mesh topology, volume/orientation, conforming quadratic midsides, patterns/welding, append validation, parser continuations, scalar interpolation and solver-card roundtrips. Python tests cover request validation, HTTP behavior and actual CAD-to-mesh integration. Gmsh integration cases are skipped when the executable is unavailable. No browser automation package is required by these suites.

## Historical release notes

The following notes describe the previous editor releases and are retained for context; current usage and architecture are documented above.

## New in v2.3 - Changes Since v2.2

### 1) Large-model runtime recovery
- Restored real large-model open after the post-`v2.2` regression period where some decks stalled around `99%` after parse.
- Removed the first-interaction freeze path that could hang the editor immediately after opening a large model.
- Large explicit box selection is now responsive again on real validated user decks because the editor no longer rebuilds a giant duplicate selected-face fill mesh for huge selections.
- Large-model interaction stays on the same runtime path as smaller models instead of relying on special-case deck-size behavior.

### 2) Copy / reflect / export / reimport stability
- Copy and reflect workflows were repaired so they work again on the restored large-model runtime.
- Reflected loads, moments, and coordinate systems now mirror with the correct direction/reference behavior instead of reversing or drifting.
- Export after copy/reflect no longer drops `CBAR` orientation or corrupts reflected metadata.
- Export + reimport now preserves the repaired reflect/copy results instead of reintroducing the earlier regressions.

### 3) Selection and viewport behavior
- Large box selection is much faster and stable enough for real large-model interrogation.
- Box select now latches from the initial `Alt` press, so releasing `Alt` during the drag does not collapse the gesture into a last-hover single pick.
- Releasing the mouse after rotate/pan/drag no longer accidentally selects the entity under the cursor.
- Shell hover highlighting uses a proper filled face tint without diagonal triangulation artifacts.
- `By face` shell picking was restored and behaves correctly again in the normal toolbar workflow.
- Element ID labels were restored when the label toggle is enabled.

### 4) Create / modify workflow recovery
- Direct modify-target selection was restored for properties, materials, loads, constraints, and coordinate systems.
- Grid and element modify workflows again use the existing `NID` / `EID` field instead of duplicate target-entry widgets.
- Create and modify reference fields now use inline combo inputs: you can type an ID directly or open a dropdown button inside the same field.
- Create defaults now seed from the next available live ID instead of reusing `1`, including new grids, loads, constraints, properties, materials, and coordinates.
- Create-element `Use Selection` now keeps connectivity inputs visible and fills them correctly instead of clearing the form.
- Property pickers are now type-aware:
  - shell elements only show shell-compatible properties
  - solid elements only show solid-compatible properties
  - `CBAR` only shows `PBAR`
  - `CBEAM` only shows `PBEAM`
  - `CBUSH` only shows `PBUSH`

### 5) Grouped load / constraint editing
- Load and constraint modify workflows now support grouped editing instead of forcing everything into one-record-at-a-time edits.
- Supported grouped workflows include:
  - `FORCE`
  - `MOMENT`
  - `PLOAD2`
  - `PLOAD4`
  - `SPC`
  - `SPC1`
- Mixed-definition records that share the same `SID` are no longer flattened together incorrectly; they stay as separate editable subgroups when their actual definitions differ.
- Grouped membership workflows now support add, append, replace, and remove actions from selection.
- `Remove Selected` is available for grouped node/element membership editing.
- Constraint component-only edits preserve the existing node set unless the user actually changes the membership list.

### 6) Schema, editor, and spreadsheet-style UX polish
- Long flyout panels now scroll instead of clipping off controls in the inspect tree or large modify forms.
- The `PCOMP` layup editor behaves more like a spreadsheet:
  - visible multi-cell selection
  - copy/paste workflows
  - single-value fill down a selected range
  - paste now replaces cell contents instead of appending text
- `PBUSH` now treats `K2..K6` as required instead of hiding them as advanced.
- `PSHELL` now requires `MID2`, `MID3`, and `MID4`, and seeds them from `MID1` by default to avoid unsafe solver behavior.

### 7) Display defaults and viewport polish
- Shading now defaults `ON`.
- Free-edge color now defaults to yellow.
- Free-edge line weight is thicker and easier to see.
- The status dock is stable on startup and user-resizable by dragging its edge.

### 8) Deletion and entity-management parity
- Modify mode now has explicit delete support for more entity types.
- Right-click delete parity was expanded so loads and constraints can be removed more like nodes and elements.
- Load/constraint delete behavior is now aligned with their dedicated selection modes.

### 9) MYSTRAN / F06 results upgrades
- One `.F06` file can now expose multiple result sets instead of collapsing everything into one overwritten flat result object.
- The results panel now lets you switch between:
  - subcases from a single run
  - modal eigenvector sets
  - buckling/eigenvalue result sets
- The results selector shows output-set metadata such as subcase, mode, eigenvalue, frequency/cycles, and load factor when available.
- `Output Vector` now only lists vectors that actually exist in the active result set instead of showing every possible result type all the time.
- Line elements now display contour colors instead of staying visually uncolored in result review.
- Full-wave contour playback now preserves opposite-direction contour colors correctly.
- Element criteria values now render again on element faces, including averaging nodal-result values onto the element face when `Criteria Mode = Element`.
- Results animation now supports both:
  - `Absolute`
  - `Full Wave`
- Results animation controls are more usable:
  - typed `FPS` entry
  - typed `Speed` entry
  - longer sliders for finer control
  - `FPS` range `1..120`
  - `Speed` range `0.01x..10x`
  - defaults of `30 FPS` and `1.00x`

### 10) Load-case / constraint / results visibility improvements
- In `.dat` model review, loads and constraints can now be filtered by subcase/load case from `Inspect > Visibility` instead of always showing every case at once.
- `SPC DOF` labels now render correctly on decks that use explicit scalar `SPC` cards, not just `SPC1`.
- Modify > Constraint for explicit `SPC` now shows the effective per-node DOF grouping instead of misleading single-row subsets when multiple scalar SPC rows stack on the same node.

### 11) Mass element fixes
- `CONM2` export no longer falls into the unwritable `ENDDATA` placeholder path.
- `CONM2` now has a dedicated ringed-disk glyph that is more visually distinct from a node at smaller sizes.

### 12) Release summary
- `v2.3` is primarily the recovery and workflow-hardening release after `v2.2`.
- The biggest end-user changes since `v2.2` are:
  - large models open and can be interrogated again
  - large selection is fast enough for real work
  - copy/reflect/export/reimport are materially more reliable
  - create/modify targeting is much easier and safer
  - grouped load/constraint editing is now viable
  - MYSTRAN/F06 results review is materially stronger, including multi-set output selection and better animation/contour controls
  - display, hover, picking, labels, and dock behavior are more consistent
  - `CONM2` mass support is safer in both export and visualization

## New in v2.2

### Large model improvements
- Large models now render as full shaded geometry again instead of falling back to widespread wireframe-only display.
- Large-model navigation and interaction are much smoother than in the late `v2.1` builds.
- Selection tools now behave much better on large models, including box select, polygon select, and `Show only`.

### Clipping and picking
- Clipping-plane selection now follows what is actually visible to the user.
- `Pick front` behavior is improved so visible faces and nodes win instead of hidden geometry behind them.
- Clipping controls are more reliable and easier to use, including manual offset entry.

### Display and viewport fixes
- Models frame correctly on load and reset instead of opening off-screen or at unusable positions.
- Glyphs now respect front geometry instead of drawing through the model.
- Labels, clipping, and viewport behavior are more consistent than in `v2.1`.
- Skybox support has been added.

### Coordinate and geometry fixes
- Nested and local coordinate-system rendering regressions from the `v2.1` upgrade work were corrected.
- Geometry placement is now more consistent between small and large models.

### Post-processing
- Enabled support for STRESS, FORCE, GPFORCES, MPCFORCES, OLOAD, STRAIN
- Improved F06/MYSTRAN post-processing support beyond the original `v2.1` release.
- Export behavior is more reliable than in the later `v2.1` builds.

### Summary
- `v2.2` is mainly a stability, usability, and large-model recovery release.
- The biggest end-user changes are:
  - better large-model rendering
  - better clipping and pick behavior
  - corrected coordinate-system behavior
  - better framing/reset behavior
  - improved post-processing support

## v2.1 Baseline - MYSTRAN Post-Processing (F06)

- Added **Analysis Results (MYSTRAN only)** workflow in Inspect mode.
- Added F06 parsing for:
  - nodal displacements (`T1/T2/T3`, total magnitude)
  - shell/solid/beam stress extraction with contour support
  - local element stress table components (Normal-X/Normal-Y/Shear-XY/Principal Major/Principal Minor/Shear-XZ/Shear-YZ/Von Mises where present)
- Added deformed-shape visualization with animation controls (`Play/Pause/Stop`, FPS, Speed).
- Added contour controls:
  - continuous/discrete coloring
  - color bin count
  - auto/manual min-max range
  - reverse palette option
- Added criteria overlays:
  - element criteria labels
  - node mode for displacement with direction arrows
  - configurable number formatting (scientific/real and sig figs)
- Added advanced legend controls:
  - viewport-anchored legend
  - manual text-size control
  - per-level tick labels matching contour formatting
