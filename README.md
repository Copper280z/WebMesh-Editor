# WebMesh Studio 3.0

WebMesh Studio is a modular, browser-based finite element pre/post processor for Nastran `.bdf` and `.dat` decks. Build connected meshes from primitives, assemble them with patterns, mesh CAD through a local Gmsh service, define model cards, and review MYSTRAN F06 results.

## Start the editor

**Browser only:** open `WebMeshEditor.html` in a current desktop browser with WebGL enabled. Keep the `app/`, `styles/`, and `vendor/` folders beside it. Scratch modeling, patterns, deck editing, export, and results review run locally without an installation, build step, CDN, or server.

**With CAD meshing:** install the Gmsh command-line executable and check that `gmsh -version` works. Start the included Python server from the repository directory:

```sh
python3 server.py
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765). The CAD & mesh workspace reports when Gmsh is connected. The HTTP server uses the Python standard library. Interactive CAD tools also need Gmsh’s Python bindings and NumPy. Homebrew Gmsh includes the bindings; other installations can use `python3 -m pip install gmsh numpy`. If Gmsh is outside `PATH`, provide its executable explicitly:

```sh
python3 server.py --gmsh /absolute/path/to/gmsh --port 8765
```

The service binds to `127.0.0.1`. CAD is processed on your machine in a temporary working directory. A static web host can serve the browser editor, but CAD meshing requires opening the editor from this local service.

## Modeling workflow

| Workspace | Tools |
| --- | --- |
| Geometry | Blocks, rectangular plates, solid or hollow cylinders, and annuli; dimensions, origin, divisions, mesh topology, element order, material and thickness |
| CAD & mesh | STEP/STP, IGES/IGS, BREP and STL import; a guided **Prepare → Size → Mesh** hex workflow: selection-driven slicing and defeaturing with result previews, live mapped-block status, solved edge-count equations, and native mapped HEX8/HEX20; Gmsh tet/tri/quad and sweep methods remain available |
| Pattern | Linear arrays in one, two or three vector directions; circular arrays about any axis and center; selected elements or the whole model; optional coincident-node welding |
| Model setup | Materials, properties, loads, constraints, coordinate systems, individual entities, schema-based card modification, transforms, selection and connectivity checks |
| Post-process | MYSTRAN F06 result sets, deformed shapes and animation, stress/strain/force contours, temperature load contours, legends and criteria |

Use **Preview mesh** to inspect the generated wireframe before choosing **Add to model**. Each addition allocates unused node, element, property and material IDs and enters the model's undo history. Existing model definitions remain in place. **Load example** creates an annular flange and a circular array of solid parts in an empty workspace.

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

The pattern and connectivity tools support triangle, quad, tetrahedral, hexahedral, `CROD`, `CBUSH` and `RBE2` elements. Other structural cards remain available through the deck/card tools, but cannot currently be patterned by the new workspace.

## Native mapped hex meshing

The **CAD & mesh** workspace is a hex-meshing toolbox in three steps. Every solid is checked continuously and colored in the viewport: green solids are mapped blocks, red solids need preparation, amber solids are blocks whose edge counts conflict.

**1 · Prepare.** Pick in **Auto** mode (`0`: the smallest entity near the pointer wins, a point before an edge before a face) or a fixed type (`1`–`4`: solid, face, edge, vertex); Shift/Ctrl adds. The context card describes the pick and proposes what to do with it:

| Pick | Inferred actions |
| --- | --- |
| Hole face | Remove the hole; box it in a square cell as wide as the surrounding face is narrow; split around it with radial cuts to the surrounding corners (optionally with an O-grid ring); replace it with an inscribed square passage |
| Fillet, round or chamfer | Remove it and heal the neighbors |
| Planar face | Slice along its plane when that plane crosses material, otherwise open the Slice tool parallel to it |
| Re-entrant edge | Slice the solid along either adjacent face |
| Straight edges | Cut along them (see **Cut** below) |
| Vertex | Slice through it normal to X, Y or Z; Shift-pick a second vertex to cut between them |
| Two or more solids | Fuse them back into one, to redo a cut differently (they must share faces); slice them together |
| Red solid | Its reasons (with the offending faces, edges and corners marked in yellow) and concrete fixes in a sensible order: remove blends, join two re-entrant corners, slice re-entrant edges, cut along imprint lines, box and split around holes |

Every geometry change is previewed before it is applied: cutting planes and section outlines appear immediately, faces to be removed turn red, and the server computes the actual result in the background. The result preview shows the new solids colored by whether they will be mapped blocks (“1 → 4 solids · 4/4 mappable”). **Apply** (or Enter) commits the previewed result instantly and ends the action: the tool closes and nothing from it stays armed for the next pick. Esc cancels and closes the tool. The Slice tool takes any normal, an offset slider that snaps to vertices, a point on a picked edge, and a scope of all or selected solids.

**Cut** makes bounded cuts where a plane would go too far. Pick straight edges (or Shift-pick two vertices of a face) and choose **Cut along edges** / **Cut between vertices**: each segment is swept through the solid along the normal of the face it lies in, and stops where the segment stops, so an L-shaped imprint or a cut across one corner of a wall ring leaves everything past it alone. While the tool is open, further picks offer **Add to cut**, and all segments are applied as one operation; segment ends that meet are joined exactly, free ends reach just past the boundary. A cut drawn on a face runs only into that face's own material, so a cut from an acute pocket corner does not continue through the wall beyond the corner. A cut that crosses a ring's wall completely opens the ring: the solid stays one piece, shown red as an open ring, with the cut kept inside it, and the next cut through it takes that cut along so the two separate the pieces. The preview reports a cut that stops inside the material (a slit) or divides nothing, and the kernel refuses any slice, cut or fuse that would leave a solid touching itself along an edge (two regions joined only at an edge), which cannot be meshed. Three fixes use the same cuts: **Cut along N imprint edges** (every imprint on a blocked face’s plane, in one step), **Cut between re-entrant edges** (two re-entrant corners that see each other across a cap), and **Box N holes in square cells** before splitting around them.

**Model tree and history.** The panel is a model tree above an inspector, each scrolling on its own (drag the divider between them to resize), so the tree stays in view while you work in the inspector. Panel updates patch the page in place: a field you are typing in keeps its focus and lists keep their scroll position when a preview or result arrives. The tree lists:

- every solid with its status (green: mapped block, with its element counts; red: why it is not; amber: count conflict) and an eye toggle. **H** hides the picked solids (or the solids of picked faces), **Shift+H** shows all, and the context card has Isolate and Hide;
- the recognized features (click one to select its faces);
- the history. Every step has **Back here**; the steps after it stay available as **Redo to here** until a new change replaces them.

Undo and redo (the buttons next to the file name, **Ctrl+Z** / **Ctrl+Shift+Z**, and the view toolbar arrows) walk the geometry history in Prepare and Size; in Mesh they undo model changes such as an added mesh.

**Auto-fix** prepares solids for mapped meshing in passes, keeping a step only when its previewed result is better, and records each step in the undoable history. It only cuts: every feature stays unless **Remove small fillets & chamfers** is turned on, so remove the holes and blends the analysis does not need yourself (**Features**) before running it.

1. Remove small fillets and chamfers (off by default, one batched defeature). Only blends no wider than 1.5 elements are removed; larger ones, such as the corner bracket's chamfered corner, are design geometry and stay.
2. Make every solid a mapped block: separate walls from a pocket floor (one bounded cut along the floor outline and across each wall corner), slice through square openings at their floor and ceiling (continued around the walls), join re-entrant corners that see each other, slice re-entrant edges (preferring the smaller cut of the two face planes), cut along imprints that stop short, separate several holes that share a face, box holes in square cells and split around them (optional), split pieces of a hole (for example sectors fused back together) by radial cuts to their corners, and split triangular or five-or-more-sided prisms into blocks from their center, continuing each cut into the adjacent solid so it leaves no T-junction.
3. Remove T-junction cycles that would make the edge-count equations contradictory. No step may introduce such a conflict or a knife edge.
4. Square up badly shaped blocks (strongly tapered, or bent sides) when the trial mesh at the current size improves.

Candidate steps are previewed up to four at a time (once the first candidate from a state is rejected, the next ones are previewed ahead), but judged in the same order as one at a time, so the outcome does not depend on timing. Candidate previews omit the display tessellation; the server keeps the last eight previews of each session staged, and applying one commits its full result.

**Stop** ends a run at any time: a preview being judged is dropped, a step being applied finishes, and every step so far is kept. When a run ends, its changes are applied in the view and the readiness card asks to **Keep changes** or **Discard** them (Discard returns to the geometry before the run; its steps can still be redone from the history until the next change, and any other change keeps them). When Auto-fix stops short (stopped, no step helps, its 40-step limit, or the kernel refuses a step), the card says which and lists the solids still red. Continue from its cuts by hand: select a red solid for its fixes, Shift-pick neighboring solids and **Fuse** them to redo a cut differently (running Auto-fix again re-cuts them its own way), or undo its steps one at a time. A fuse unifies the faces the removed interfaces leave behind and keeps the surrounding solids conforming.

Results on the included parts (target size 4 unless noted):

| Part | Preparation | Blocks | HEX8 | Min scaled Jacobian |
| --- | --- | ---: | ---: | ---: |
| `examples/l-bracket.step`, bore kept | Auto-fix: remove the R3 fillet, slice off the web, box the bore, split around it | 7 | 696 | 0.71 |
| `examples/l-bracket.step`, bore removed | Remove the bore, then Auto-fix | 2 | 790 | 0.99 |
| `long corner bracket.step`, all holes removed | Remove the 12 holes (one defeature), then Auto-fix: one cut separates the floor and splits the wall ring; both chamfers kept | 5 | 1,190 | 0.58 (0.59 at size 2) |
| `long corner bracket.step`, holes kept | Square passages for the Ø8.5 bores, then Auto-fix (18 steps, about 8 s; size 2.5) | 64 | 2,064 | 0.27 |
| `flexure.step` | Auto-fix with fillet removal and hole splits (size 1.5); stops with 4 solids left | 64 of 68 | 3,258 | 0.11 |

HEX20 versions of each have the same blocks and quality. Every equation of the corner bracket with its holes kept (80 equality groups, 56 sums, 656 face equations) is solved without conflicts.

**Corner bracket with its holes kept.** Its Ø8.5 access bores graze the floor (0.25 mm-deep grooves meeting the walls at 12°) and cross each other inside the angled wall, which no mapped decomposition can follow, so they are simplified to square passages; the six Ø4.6 holes in the outer walls stay round. Each step is a pick and a click in **Prepare**:

1. **Features**: check the six Ø8.5 holes → **Replace 6 holes with square passages** (crossing passages become one opening per crossing).
2. **Cut**: Edge-pick the four edges of the pocket floor → **Cut along 4 edges**; then for each wall corner Shift-pick its inner and outer vertex on the top face → **Add to cut** (the two 45° chamfer miters, and the inner faces of the walls continued at the two acute corners). Apply: the floor core, the chamfer corner and three walls, 2/5 mappable.
3. Face-pick the floor of a passage → **Slice with this plane**, and the same for its ceiling: 12/16.
4. Select each outer wall’s middle layer → **Box 3 holes in square cells** (6.01 mm cells, the passage height), then pick each Ø4.6 hole → **Split around hole**: 44/46.
5. Select the angled wall’s layer under the passages → **Cut along 12 imprint edges**, the same over them, then each crossing column → **Cut between re-entrant edges**: 64/64.

After step 1, **Auto-fix** (with fillet and chamfer removal off) finds the same decomposition by itself in 18 steps and about 13 seconds. The Gmsh column sweep (**Mesh → Other (Gmsh)**) remains an alternative.

A solid is a mapped block when every face has exactly four corners, no edge is re-entrant (dihedral above 220°) or a knife edge (below 20°), and its faces group across flat edges into six logical sides meeting at eight corners. Corners and dihedrals below 140° are block corners and edges, 140–220° are flat; angles between 115° and 165° are resolved per face so it gets four corners (a 144° corner of an otherwise three-cornered face is promoted, the bluntest of five is demoted), and the matching edges follow that choice. Composite sides are allowed: imprinted faces from neighboring splits (T-junctions) are meshed as one structured grid. Blocks whose parallel edges differ by more than 10× are reported as strongly tapered.

**2 · Size.** Each mapped face requires equal element counts on opposite sides, so the model is a system of equations over CAD edge counts. Single-edge sides give equality groups (shown as colored groups and edge colors, e.g. `B: E2 = E4 = E8 = E13 → 4`); imprinted sides give sum equations (`F3: E5 = E9 + E10`). The solver finds integer counts close to the target size. Pick edges (or click their 3D count labels) and use −/+ or the `+`/`−` keys to change them; changed counts become fixed (`L` toggles). Anything that prevents a solution is reported with the edges and faces involved, for example “Edges 2 (fixed 4) and 13 (fixed 5) must match: E2 = E4 via face 1 = E13 via face 5.” Fixed counts survive geometry changes when the edge survives unchanged.

**3 · Mesh.** Mapped hex meshing runs in the browser without Gmsh. Each CAD edge is divided by arc length (exactly on lines and circles), each face is filled by transfinite interpolation and projected onto its plane, cylinder or sphere (other surfaces use the CAD tessellation), and each block interior by 3D transfinite interpolation. Shared CAD edges and faces give the same nodes to neighboring blocks, so interfaces conform. HEX20 midside nodes lie on the CAD curves and surfaces. The live preview colors faces by scaled Jacobian and lists the worst blocks; inverted meshes cannot be added. **Add to model** creates CHEXA elements with one PSOLID (or one per solid) and replaces the previous CAD mesh in one undo step. Mappable solids can be meshed alone or all together; unmappable solids are skipped.

Geometry operations still use OpenCASCADE through Gmsh’s Python API (the only B-rep kernel available locally). Each request runs in its own kernel process, started ahead of time so Python, Gmsh and NumPy are already loaded when the request arrives. Results for faces and edges an operation leaves unchanged (corner and edge angles, cylinder sidedness, display triangles) are reused from the previous revision; they are keyed by geometry, since entity IDs renumber on every revision, and checked in the tests against a fresh computation. On the corner bracket a slice preview takes about 0.45 s (0.9 s without the cache), and a hole removal about 0.6 s. Classification uses kernel geometry queries — evaluation, projection and point containment — not the Gmsh mesher. The Gmsh tet/tri/quad, sweep and column-sweep methods remain under **Mesh → Other (Gmsh)** and reuse fixed edge counts as exact divisions.

## CAD meshing with Gmsh

Imported CAD is displayed immediately as selectable surfaces and edges, before any finite-element mesh exists. **Prepare geometry** and **Mesh** are separate steps. CAD has its own visibility switch and preparation undo, while the finite-element model retains its own undo history.

- **Remove faces & heal:** select the complete faces of a hole, fillet or protrusion in the viewport or ID list. OpenCASCADE removes those faces and extends neighboring surfaces. Blind holes also require their cap faces. Failed operations leave the geometry unchanged.
- **Split solid by plane:** choose X, Y or Z, a coordinate and optional solid IDs. A visible cutting plane previews the location. Splitting produces shared CAD interfaces for conforming meshing.
- **Partition by face projection:** select planar floor or end faces and project their outlines along X, Y or Z. This splits the solid into constant-section columns without changing its volume.
- **Simplify holes to passages:** replace selected feature faces with explicit rectangular through-passages in one reversible operation. Define the passage axes, centers, sections and extents to retain structural openings.
- **Heal geometry:** repair small/degenerate edges and faces, sew surfaces and rebuild solids.
- **Sweep quads → hex:** select a planar source face and optionally its matching opposite face, set the source surface size and number of through-thickness layers. The source is meshed entirely with quads and swept to hexes. Two exact CAD Boolean differences check that this proposed extrusion matches the prepared solid before meshing. Transverse holes, bosses or variable sections must be prepared first. The current sweep supports one translated constant-section solid.
- **Map prepared blocks:** mesh compatible six-face blocks with four-sided faces and matching curve divisions. Geometry preparation is explicit; this does not automatically decompose arbitrary solids.
- **Sweep partitioned columns:** choose the sweep axis and set a layer count for each detected elevation interval. Adjacent columns share their quad mesh and layer interfaces, including where shorter columns end. The generated solids must match the prepared CAD exactly before meshing proceeds.
- **Triangle, quad and tetrahedral methods:** mesh the prepared geometry. Quad generation rejects mixed element output. Both linear and quadratic elements are supported.
- **STL:** displayed as discrete geometry, with triangle and tetrahedral meshing. STEP/BREP preparation and mapped or swept hexes require boundary-representation CAD.

Every generated CAD mesh is checked for requested element types, nonpositive Jacobians, non-manifold interfaces and face-connected components. Sweeps report minimum Jacobian and scaled Jacobian, with symmetric CAD difference volumes. Regenerating a CAD mesh replaces the prior generated elements in one undo step; nodes still referenced by other model definitions are retained. Element-based loads that would become dangling references block replacement.

Poor quadratic hexes receive a bounded high-order optimization pass that moves nodes on their CAD parametrizations without adding elements. The result must still have positive adaptive Jacobians, conforming shared midside nodes and a minimum scaled Jacobian of at least `0.1`; otherwise generation fails with a request to refine the curved region.

Preparation uses temporary, immutable BREP snapshots. The service accepts CAD data rather than executable GEO programs, binds only to loopback, and limits file sizes, processing time and memory. This is a focused preparation toolset; arbitrary sketching, general boolean design tools, curved sweeps and interactive point-to-point face partitioning are not implemented.

### Flexure acceptance workflow

For the supplied `flexure.step`, one explicit simplification produces a constant cross section while preserving the thin flexures, their corner radii and the three through-holes along Y:

1. Import the STEP in **CAD & mesh**. It displays immediately with 77 faces and no finite elements.
2. Choose **Remove faces & heal**, select faces `3, 8, 13, 14, 19, 20, 71, 75, 76, 77`, and apply. These are the transverse bores and their blind caps, plus the small rear protrusion. The prepared model has 67 faces. IDs refer to this original import; preparation changes later IDs.
3. Choose **Mesh → Sweep quads → hex**, source face `1`, target face `3`, surface size `3`, and `4` through layers. These controls double the original target size and layer spacing while keeping the thin CAD features.
4. Generate the mesh. Without additional local controls, this coarser case yields **4,880 hex elements**, with **7,470 first-order nodes** or **27,066 second-order nodes**, one connected component and zero missing/added CAD volume. The exported mesh has a minimum scaled Jacobian of at least `0.1537`; second-order generation includes high-order optimization.

The denser reference uses size `1.5` and `8` layers: **24,720 hex elements**, minimum first-order scaled Jacobian `0.2263`. Local sizing or exact edge divisions can resolve selected thin regions while retaining the coarser bulk target; resulting counts depend on those controls.

The removed features are a deliberate analysis idealization, recorded in preparation history and reversible before saving; they are not silently omitted by meshing. `tests/test_cad.py` exercises this workflow and also checks connected mapped meshing after solid splitting.

### Local controls and matching thin-section meshes

Edge and face target sizes refine selected regions while retaining a coarse bulk target. Exact edge divisions are hard constraints: incompatible opposite counts fail explicitly, and the quality report lists requested and achieved counts. Preparation changes clear these controls because entity IDs belong to one CAD revision.

For an exact odd division count such as three, partition the thin region into mapped source patches. The mesher matches opposite/shared boundary groups, balances free boundary counts for a conforming quadrilateral mesh and keeps the requested counts unchanged. Adjacent bulk regions use an unstructured quad mesh; quality-driven refinement is confined to troublesome transition profiles. Linear source smoothing precedes quadratic elevation. Shared layer node maps then sweep these quads into connected hexes without globally subdividing the mapped patches.

For the supplied flexure after the preparation above, an acceptance example retains every remaining corner fillet and all three Y holes:

1. Split all solids at X `-12.5`, `-5.5`, `5.5`, `12.5`, then Z `-4.5`, `5.5`. These six reversible plane cuts produce 29 solids and 200 faces without changing material volume.
2. Set exact `3` divisions on the two thickness edges of each of the eight horizontal 0.5-wide and two vertical 1.5-wide source patches. For this final revision, the 20 edge IDs are `26, 28, 37, 39, 49, 51, 61, 63, 78, 106, 146, 155, 161, 163, 173, 175, 211, 278, 312, 374`.
3. Use **Sweep partitioned columns**, axis **Y**, bulk size `3`, and `4` layers over `-12–0`. First order yields **8,548 HEX8 / 11,905 nodes**, minimum scaled Jacobian `0.1881`. Second order yields **8,548 HEX20 / 44,069 nodes**, minimum scaled Jacobian `0.2003`.

Both have one connected component, positive adaptive Jacobians, zero CAD difference and all 20 requested counts achieved exactly. The Python acceptance test also checks the actual corner-node rows across every thin section, plus shared quadratic midside connectivity. These coordinates and IDs are test inputs and documented modeling choices; the production mesher uses topology, dimensions and requested controls for any CAD model.

### Corner bracket acceptance workflow

The large openings in `long corner bracket.step` remain closed through-openings in the angled web. The acceptance idealization replaces their intersecting 8.5-diameter bores with six **6 × 6 rectangular passage branches**, preserving the three web openings and the ligaments above and below them. The smaller attachment bores are removed explicitly; connector elements can represent their attachments.

1. Import the STEP (49 faces). Choose **Simplify holes to passages** and select feature faces `7-12, 16, 17, 19, 20, 22, 23, 38-49` for healing and replacement in the same operation.
2. Define these six passages, each with width and height `6`. The coordinate along the through axis is unused; **From / To** determine that extent.

   | Through axis | Center X | Center Y | Center Z | From | To |
   | --- | ---: | ---: | ---: | ---: | ---: |
   | X | 0 | 30 | 10 | 6 | 76 |
   | X | 0 | 55 | 10 | 6 | 76 |
   | X | 0 | 80 | 10 | 6 | 76 |
   | Y | 54 | 0 | 10 | 6 | 101 |
   | Y | 35.5 | 0 | 10 | 6 | 101 |
   | Y | 17 | 0 | 10 | 6 | 101 |

3. Apply **Create passages**. The prepared solid has 37 faces; crossing branches are cut as one opening, so each crossing has a single floor and ceiling. Each square branch is inscribed in the original bore; this is a deliberate geometric approximation, not an equivalent stiffness claim.
4. Choose **Partition by face projection**, axis **Z**, and **Select internal floors**. Review the 4 selected faces (the pocket floor and the three crossing floors), then **Partition solid**. This creates 10 columns with shared interfaces, including the bridges above the openings.
5. Choose **Sweep partitioned columns**, axis **Z**, surface size `8`. Use layer counts `2, 1, 2, 2` for intervals `0–6`, `6–7`, `7–13`, `13–20`. The thin lower ligament retains its own layer.
6. First and second order both produce **2,100 hex elements**, one face-connected component, minimum scaled Jacobian `0.4859`, and zero missing/added CAD volume. First order has **3,194 nodes**; second order has **11,636 nodes** and verified shared midside connectivity. Empty passage regions contain no exported elements.

The denser reference uses size `4` and interval counts `3, 1, 3, 4`: **9,656 hex elements**, **47,964 second-order nodes** and minimum scaled Jacobian `0.4584`.

Both STEP acceptance workflows are exercised through the UI and in the Python suite. Original STEP files remain unchanged. Preparation dimensions and operations are recorded in the saved project.

### Simulated bolts

Open **Pattern → Bolts** or **Model setup → Simulated bolts**. Define the mid-grip center, bolt axis and grip length, then create a single bolt, linear array or circular array. Attachment searches use boundary nodes inside a disk on each end plane; optional explicit node lists restrict those candidates. Preview displays both attachment spiders and shanks before creation.

The primary connection is **RBE2 + CBUSH** with a new PBUSH containing six user-supplied stiffnesses. Local X follows the bolt axis; the orientation vector sets the other axes. Use consistent force/length and moment/radian units. The axial-only alternative creates CROD/PROD with a material and cross-sectional area. RBE2 defaults to dependent components `123` for solid faces. Empty, collinear, overlapping or already constrained attachment patches are rejected rather than silently creating a disconnected or multiply dependent connection. These are connector idealizations; preload, contact and bolt stiffness calibration are not automatic.

## Open, save and export

**Open** accepts Nastran decks or saved `.webmesh` projects. For decks containing `INCLUDE` statements, use the model file/folder controls or drop the entry deck together with its included files. Imported source is retained worker-side so editing and export can preserve other solver cards and case-control content.

**Save project** downloads a `.webmesh` JSON snapshot containing the current deck, original source CAD, the prepared BREP geometry, generated-mesh association and recent operation descriptions. The project file does not include imported F06 results, the full undo stack, or every viewport setting; reopen results files after restoring a project. Projects are downloaded files, not an automatic cloud save.

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

The mesh checker detects missing references, duplicate IDs/connectivity, degenerate or inverted linear cells, damaged midside connectivity and boundary topology issues. It is not a substitute for solver-specific quality checks. CAD-generated meshes additionally check first- and second-order Jacobians in Gmsh. Complete material/unit validity, all element formulations and full solver-deck completeness still need separate verification. Rendered curved elements use faceted tessellation.

Interactive scratch generation and pattern operations are capped at 500,000 nodes and 250,000 elements per generated operation. Large imported decks use the existing compact worker/typed-array rendering path. Browser memory and GPU capacity still determine practical limits.

## Development

The repository is source-ready and has no JavaScript build requirement:

| File | Responsibility |
| --- | --- |
| `WebMeshEditor.html` | HTML shell and retained editing controls |
| `styles/workbench.css` | Modern workspace layout and styles |
| `styles/editor.css` | Existing editor/card styles |
| `app/workbench.js` | Workspace UI, docked editors and project orchestration |
| `app/cad-workspace.js` | Prepare → Size → Mesh workspace: inferred actions, previews, Auto-fix, sizing and native mesh commits |
| `app/cad-viewport.js` | CAD display, solid/face/edge/vertex picking with hover, per-entity colors, preview overlays and 3D labels |
| `app/hex-mapping.js` | Mapped-block recognition, edge-count equations and integer solver, transfinite HEX8/HEX20 generation and quality |
| `app/cad-features.js` | Hole, boss, fillet and chamfer recognition; selection inference and fixes for unmappable solids |
| `app/bolt-workspace.js` | Bolt and attachment patterns with explicit connector stiffness |
| `app/compact-forms.js` | Shared compact create/modify cards, vectors, DOFs and repeated inputs |
| `app/modeling.js` | Pure mesh generation, patterning, validation and BDF helpers; browser/Node UMD module |
| `app/editor-engine.js` | Nastran editor state, rendering, selection, card editing, results and undo/redo |
| `app/card-worker.js` | Readable parser/writer worker, wrapped as an uncalled factory for offline Blob-worker startup |
| `app/nastran-schema.js` | Readable schema for card forms |
| `vendor/three-runtime.js` | Bundled Three.js, controls, label renderer and environment loaders; preserved MIT notices |
| `server.py` | Loopback HTTP server, bounded worker execution and Gmsh bridge |
| `cad_sessions.py` | Revisioned CAD snapshots, undo and prepared BREP export |
| `cad_kernel.py` | Isolated OpenCASCADE preparation (slice, defeature, passages, projection, heal) and CAD display tessellation |
| `cad_mapping.py` | Exact classification data: oriented face loops, corner and dihedral angles, analytic surface and curve descriptors |
| `cad_sweep.py` | Mapped/swept mesh generation, geometry equivalence and mesh validation |
| `cad_controls.py` | Revision-specific local sizes, exact counts and shared-boundary constraints |
| `cad_mesh_extrusion.py` | Mixed mapped/bulk quad profiles and conforming explicit hex extrusion |

`window.WebMeshAPI` is the boundary between the new workbench and the existing engine: state/ID queries, global-coordinate mesh reads, validated append, preview, import/export, selection, card editors and history controls. Changes emit `webmesh:change`; engine availability emits `webmesh:ready`. Keep solver data in the engine and geometry algorithms in the modeling module rather than duplicating them in UI code.

Run the JavaScript and Python suites:

```sh
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

Or use `npm test` and `npm run test:cad`. Mapped-meshing fixtures in `tests/fixtures/mapping` are real kernel topologies; regenerate them with `python3 tests/fixtures/mapping/make_fixtures.py`. `tests/cad-hex-workflow.test.cjs` starts the local server and runs the L-bracket (bore kept and removed) and corner bracket (holes removed by Auto-fix, holes kept by hand) workflows end to end; it is skipped when the Gmsh/OpenCASCADE kernel is not installed. JavaScript tests cover analytic mesh topology, volume/orientation, conforming quadratic midsides, patterns/welding, append validation, parser continuations, scalar interpolation and solver-card roundtrips. Python tests cover request validation, HTTP behavior and actual CAD-to-mesh integration. Gmsh integration cases are skipped when the required executable or Python bindings are unavailable. No browser automation package is required by these suites.

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
