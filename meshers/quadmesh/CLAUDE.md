# quadmesh

C++20 library implementing Rushdi et al. 2017, "All-Quad Meshing without
Cleanup" (the paper is not kept in this repository). Input: a 2D domain as closed polyline loops (outer boundaries + holes +
embedded mesh-control loops). Output: a fully conforming, quad-only mesh of
the domain interior with provable angle bounds and no smoothing/cleanup pass.

## Build, test, run

```sh
zig build examples              # optimized by default; -Doptimize=debug
                                #   only when debugging
zig build test                  # gtest suites (GoogleTest is fetched and
                                #   built by Zig) and the Python binding test
zig-out/bin/cpp_gallery         # meshes 8 stress domains, writes
                                #   gallery_<name>.svg per case + quality table
```

`cpp_gallery` is the main visual/quality harness — run it after any mesher
change and check `ok=true`, the angle ranges, and the SVGs. The contract
suite (`tests/contract/pipeline_contract_tests.cpp`) asserts validity, angle
bounds, determinism, per-loop sizing ratios, and boundary fidelity.

## Layout

- `src/core/mesher.cpp` — thin orchestrator: `build_mesh()` (the public entry
  in `include/quadmesh/mesher.hpp`) sequences the stages below, threading the
  shared-contract structs. The algorithm itself lives in per-stage modules.
- `src/core/detail/` — internal (uninstalled) headers shared across stages, all
  in `namespace quadmesh::detail`:
  - `chain.{hpp,cpp}` — `Chain`, `build_chains`, `turn_angle_deg`.
  - `empty_templates.{hpp,cpp}` — finite generalized-cell template family,
    candidate quality evaluation, and deterministic interior-node placement.
  - `geom_index.hpp` — `GeomIndex` (segment bucket grid; `inside`/`nearest`).
  - `tree.hpp` — `Cell`/`Tree` quadtree + cross-stage queries
    (`neighbors_in_direction`, `side_key`, `corner_gp`, `leaf_covering`).
  - `types.hpp` — `Crossing`, `GraphEdge`, `FeatureVertex`, `Face`, `LeafClass`.
  - `contracts.hpp` — the explicit inter-stage contracts: `GeometryModel`,
    `Lattice`, `Perturbation`, `BoundaryTopology`, and `MeshBuilder` (the one
    shared mutable accumulator: `nodes`/`quads` + the `gp_node`/`edge_mid`
    registries + node factory; `point_in_deformed` helper).
- `src/core/stages/` — one stage each, a free function over the contracts:
  `sizing.cpp` (`build_lattice`, the phase 1-2 fixpoint), `repel.cpp`
  (`repel`), `classify.cpp` (`compute_side_crossings` + `classify_leaves`),
  `vertex_bends.cpp` (`build_vertex_bends`), `face_mesh.cpp`
  (`build_path`/`build_faces`/`face_sample`/`subdivide_face`), `empty_fill.cpp`
  (`classify_empty_components` + `mesh_empty_squares`), `finalize.cpp`
  (compaction + CCW orient). Each is unit-tested in `tests/unit/<stage>_tests.cpp`.
- `src/core/validation.cpp` — `validate_mesh()`: conformity, inverted quads,
  flat corners, edges crossing the boundary, sharp-vertex capture, metrics.
- `src/core/pipeline.cpp` — thin `MeshingPipeline` = build + validate.
- `src/core/geometry.cpp` — `Point2`/segment primitives, segment-AABB tests.
- `src/core/quality.cpp` (`quadmesh/quality.hpp`) — per-quad / per-mesh
  Jacobian metrics (`mesh_quality_report`).
- `src/core/shapes.cpp` (`quadmesh/shapes.hpp`) — input-loop generators
  (`circle_loop`, `star_loop`, `flower_loop`) shared by examples.
- `src/io/io.cpp` (`quadmesh/io.hpp`) — mesh exporters: `write_nastran_bdf`,
  `write_mesh_svg`, `write_mesh_ppm`. Examples render through these.
- `src/abi/c_api.cpp` + `include/quadmesh_c/quadmesh.h` — stable C ABI.
- `examples/` — plate-with-hole demos (BDF/PPM output), `cpp_gallery`,
  `cpp_local_sizing` (element-count comparison against uniform fine sizing),
  `cpp_plate_circle` (offset fine hole with automatic local border promotion),
  `cpp_template_gaps` (SVG of canonical uncovered atomic-side states),
  and `repro_debug` (robustness harness: parameter sweeps plus annotated SVG
  dumps — quadtree leaves by class, non-conforming edges in red, flat-corner
  and bad-edge coordinate listings).

## Algorithm (paper section -> code stage in src/core/stages)

1. Per-chain boundary levels (`chain_levels`): each input loop has a coarse
   base level (`PolylineLoop::target_cell_size`, 0 = global default) and can
   refine it locally with log-interpolated arc-length samples
   (`PolylineLoop::sizing_samples`;
   `sizing_unconstrained = true` ignores the target and keeps the coarsest
   viable band). The root square is 2x the geometry extent and
   *target-independent*; a target picks the level nearest in log scale
   (achieved size within sqrt(2) of the request), so coarsening a target
   never refines the mesh, and any target above the floor below reproduces
   the unconstrained mesh exactly (both contract-tested).
   `separation_pass` raises levels until feature vertices and
   disjoint curves are isolated. When another loop's grading reaches a
   coarser boundary, `RefinementConfig::sizing_promotion` chooses between the
   historical `WholeLoop` promotion and `Local` promotion. Local mode snapshots
   the contacted segment intervals and leaf levels from the first balanced
   tree, rebuilds them as an automatic local sizing field with same-level
   boundary rings, and leaves distant arcs at their requested level.
   Separation, the feature-clearing origin shift, geometry index, tree build,
   and band verification iterate to a joint fixpoint in `build_lattice`
   (`stages/sizing.cpp`), which consumes a `GeometryModel` and returns a
   `Lattice`.

   Size bounds (the refinement floor; full list in `geometry.hpp` at
   `PolylineLoop::target_cell_size`): squares are quantized to
   `2*extent / 2^level`, hard floor at `max_level` (default 12 ->
   extent/2048); curvature caps s at ~0.23x the radius of curvature
   (turn-per-square cap of `4*chord_tolerance_fraction` rad, min 10 deg);
   *coarsely tessellated* smooth curves (per-joint turn above ~half the cap
   but below `feature_angle_deg`) degrade that to s <~ segment length;
   feature isolation and self/cross-loop separation cap s at ~half the
   local feature spacing / clearance gap; closed loops span >= 2 squares;
   band contact raises a loop sitting inside a finer loop's grading to roughly
   the distance to that loop, either globally or only on contacted arcs. A run
   of consecutive segments crossing one square is *one* piece of curve in the
   self-approach rule
   (`contiguous_runs`) — treating them as disjoint was the old implicit
   "minimum size ~ segment length" bug.
2. Strongly balanced quadtree (`strong_balance`, corner-adjacent diff <= 1)
   with a 1-ring of same-level squares around the band and a 2-ring around
   feature vertices. These rings are load-bearing: the 2-ref template proof
   and the no-flat-vertex argument depend on them.
3. Repelling (`repel_corners`): grid corners within delta = s/4 of geometry
   move (grid-aligned, paper 2.2) to exactly delta clearance.
4. Cut/vertex squares: side crossings (`compute_side_crossings`) -> boundary
   path (`build_path`) -> local planar graph + rotation-system face walk
   (`build_faces`/`walk_faces`) -> keep inside-domain faces -> midpoint
   subdivision (`subdivide_face`) with a pattern-search center placement.
   Squares containing a sharp feature vertex get the paper's 2.3.1 wedge
   treatment (pulled side midpoints `side_bend`, vertex rays). When a wide
   wedge has no uncrossed side to bend (both free sides on the other side of
   the curve, or stolen by a nearby vertex), a ray to a square corner
   (`vertex_corner_rays`) splits it instead — corners are already shared
   path nodes, so no extra cross-square registry is needed.
5. Empty squares: flood-classified per component, then 2-ref templates with
   per-level checkerboard marking (`mesh_empty_squares`); a fixpoint
   propagates required side splits (3-quad pinwheel / 4-quad full template).
   A split landing on a *coarser* empty neighbor stays on the shared atomic
   half-side. The classified quadtree is immutable. Odd generalized-cell
   boundaries are paired globally by a T-join on the empty-cell dual graph
   (fewest atomic spans first, then shortest physical length). Matching is
   exact for components through 20 defects and deterministically improved for
   larger components. Before using a radial fallback, an even atomic-side
   pattern is decomposed by a finite decision tree of horizontal/vertical
   bisections (four-way splits are their composition) whose leaves are a
   single quad or the paper's 3-/4-quad 2-ref templates. Splits preserve the
   existing outer boundary exactly and candidates are accepted only when the
   instantiated, possibly repelled quads meet the local quality contract. The
   adjacent-midpoint/full-side state is covered by an exact seven-quad
   construction: four graded strip quads consume the full side, and the
   residual six-node region uses the paper's 3-quad template. Its canonical
   quality bounds are 45 degrees, scaled Jacobian sqrt(1/2), and edge ratio
   1/4. The quarter-plus-midpoint side with midpoints on both adjacent sides
   has an exact ten-quad construction with seven dyadic interior nodes; its
   canonical bounds are 26.565 degrees, scaled Jacobian 1/sqrt(5), and edge
   ratio 1/4. The first five canonical gap cases use a common corner-strip
   grammar: nodes on one side form a transverse strip, while equally sized
   node sets on adjacent sides are paired in distance order and connected
   through their logical row/column intersections to the opposite corner. An
   exact three-side grid-and-cap family handles the final cases: the opposite
   side supplies two columns, the adjacent sides supply aligned rows, and a
   finite quality-ranked cap placement closes to the empty side. The
   exhaustive check now covers all 313 even 2:1 atomic states (312 split plans
   plus the boundary quad); paired-fan/one-ring remains only as a defensive
   fallback for deformed instances that fail the quality contract. A poor
   convex cut-face fan whose expanded boundary has exactly four strict turns
   is treated as the same macro-quad problem (covering clipped cells with
   collinear 2:1 junctions); genuinely polygonal faces continue to use the
   radial family.

## Invariants — read before touching the mesher stages

- **Stages communicate only through the contract structs** (`GeometryModel` ->
  `Lattice` -> `Perturbation` -> `BoundaryTopology`, plus the shared
  `MeshBuilder`). Method bodies were lifted verbatim from the old `Mesher`
  class; cross-stage helpers were promoted to `Tree`/`MeshBuilder` methods. The
  orchestrator owns `GeometryModel` for the whole run because `Lattice::geom`
  points into its `chains`. Feature nodes are seeded first (ids 0..F-1) so node
  numbering is deterministic; preserve that ordering.
- **Conformity is by construction, never by node welding.** Shared entities
  live in registries: `side_crossings` and `side_splits` (keyed by canonical
  atomic-span endpoints), `edge_mid` (keyed by sorted node-id pair), `side_bend`, `gp_node`,
  `moved_gp`. Any node that two squares must agree on is created once and
  looked up; creating a coincident node ad hoc breaks the mesh. The
  validator's nonconforming-edge count catches violations.
- Crossing `t_on_side` is stored against the canonical side orientation
  (min grid-point key -> max); `build_path` flips per traversal direction.
- The face walk's `next` must remain a permutation (twin included with
  diff = 2*pi); duplicate parallel edges with coincident geometry must be
  merged beforehand or angular ties corrupt every face.
- Degenerate vertex-near-grid handling is layered and ordered: snap
  crossings of a vertex's incident segments onto it (tol 0.22*s), insert a
  vertex lying near a side into the side path as a pseudo-crossing
  (chain = -1, tol 0.12*s), collapse path spurs X->Y->X (vertex near a grid
  corner), merge coincident path/curve duplicate edges (curve wins so the
  shared midpoint is marked on-geometry). These tolerances interlock with
  the delta = s/4 repelling clearance — don't change one in isolation.
- Vertex midpoint pulls (`build_vertex_bends`) only split angular wedges at
  the vertex wider than 120 deg; pulling into a narrow wedge creates the
  sliver it is meant to prevent.
- Everything must stay deterministic (contract test): no iteration over
  unordered containers where order affects node numbering.
- The origin shift must keep every *feature* well off the grid lines at both
  its requested and actual balanced-tree levels. For locally sized chains it
  also scores geometry/grid intersections at the local level, preventing a
  crossing close to a lattice corner from creating an acute cut-face sector.
  Smooth joints still receive a small exact-tangency guard; they must not
  outweigh features in that score.

## Performance notes

- `GeomIndex::for_each_near`/`inside()` use epoch stamps for dedup —
  **not reentrant**: never call one from within the other's callback.
- Chain pieces are prefiltered by O(1) arc length (`Chain::arc_between`)
  before materializing; the complement piece of a cut square is nearly the
  whole loop.
- Benchmark: 2048-segment circle at target 0.02 (~5.3k quads, the `hires`
  gallery case) ~40 ms release. If it regresses to seconds, check the
  buildtype first.

## Known limitations

- Input loops must not touch or cross each other (separation refines to
  `max_level`, then warns and degrades).
- Min angle at sharp input corners is bounded by the input angle itself
  (paper accepts this; `needle` gallery case: 11.4 deg apex -> 11.4 deg).
- Open polylines are partially supported (treated as embedded curves);
  isolated point features are not.
- Uniform and local boundary targets are honored only down to the refinement
  floor (curvature, feature spacing, loop clearance — see algorithm step 1); a
  coarse target on tightly curved or closely spaced geometry is silently
  refined past.
- Expected quality on smooth-ish input: angles within the paper's
  (24.3 deg, 160.6 deg), min scaled jacobian ~0.4.
- Arc-length local-sizing contracts additionally require minimum angle >= 20
  deg, minimum scaled Jacobian >= 0.3, and minimum per-quad edge ratio >= 0.1
  on both the smooth-loop and straight-polygon transition probes.
