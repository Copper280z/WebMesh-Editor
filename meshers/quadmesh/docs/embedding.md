# Embedding and boundary control

The public C++ entry point is `MeshingPipeline::run(domain, config)`. It returns
the mesh and its validation report. The C ABI, Python binding, and JavaScript
binding expose fixed runs, per-loop and local sizing, circle resolution,
feature classification, smoothing, provenance, and quality.

## Boundary geometry and discretization

Input coordinates and target sizes use the same units. Supply simple, closed
polyline loops; omit a repeated closing point when possible. Outer loops must
precede holes and control loops in the bindings. Loops must not touch or cross.
A hole removes material. A control loop divides the mesh while retaining
material and shared edges on both sides.

Geometry samples describe a curve; they do not prescribe mesh nodes. Sample CAD
arcs densely enough that the polyline's chord error meets the application's
geometric accuracy requirement. A useful starting point is a maximum turning
step of 5 degrees, refined further for a stricter absolute chord error. For a
circle of radius `r` and allowable chord error `e`, choose a step no larger than
`2*acos(1-e/r)`. Include every true corner and curve junction exactly once.
Do not add clusters of almost coincident points at tangent joins. Small source
edges are accepted; they need not become small finite elements.

`vertex_kinds` optionally gives one classification per original vertex:
`Automatic` (0), `Smooth` (1), or `Corner` (2). Automatic classification uses
`feature_angle_deg`, ignores very short edges when estimating tangents, and
recognizes sampled circles. Explicit corners are retained. Explicit smooth
points permit resampling across shallow polyline joints. Original segment
indices remain unchanged in provenance.

Use fixed runs when mesh nodes are already chosen:

```cpp
quadmesh::PolylineLoop loop;
loop.vertices = {{0, 0}, {10, 0}, {10, 10}, {0, 10}};
// A whole loop: follow the geometry's order and do not repeat the first node.
loop.fixed_runs.push_back({{}, {}, loop.vertices, true});

// Alternatively, fix just the lower side using nonuniform spacing.
loop.fixed_runs = {
    {{0, 0.0}, {0, 1.0}, {{0, 0}, {1, 0}, {4, 0}, {10, 0}}, false}
};
```

Each position is an original segment index and a parameter in `[0,1]`. Segment
`i` runs from vertex `i` to the next vertex. Runs follow input orientation and
may wrap across the closing seam. A whole-loop run starts at its first supplied
node; set `start` if this is not vertex zero. Partial runs include both endpoints.
Runs may share endpoints but may not overlap. Supplied consecutive pairs become
exact mesh edges: no added, removed, or moved nodes. Supplied nodes must lie on,
or within the configured chord tolerance of, their source loop. The fixed
polyline is the authoritative mesh boundary.

An all-quad region needs an even total boundary-edge count, counting its holes
and control interfaces. Individual loops may have odd counts if the region
total is even. Free runs can absorb parity by gaining a node; fully constrained
odd regions fail with an error identifying the region. Free control interfaces
are adjusted consistently on both sides. Boundary parity is necessary but does
not guarantee acceptable element quality for arbitrary fixed geometry.

Without fixed runs or finite-element sizing, the existing quadtree algorithm
and its sizing rules remain the default. With fixed runs alone, free boundary
nodes are sampled by that existing algorithm, with parity adjustments as needed.

## Finite-element sizing and smoothing

```cpp
quadmesh::MeshingConfig config;
config.refinement.target_cell_size = 4;
config.finite_element_sizing = true;
config.elements_per_circle = 12; // minimum 8
config.enable_smoothing = true; // default false
config.smoothing_iterations = 12;
```

Finite-element sizing uses target element spacing independently of geometry
tessellation. Circle resolution defaults to 12; closer features, a finer target,
or tighter chord tolerance can require more. Counts between geometric corners
are rounded up to even numbers for boundary subdivision. Local clearance and
arc-length size samples refine nearby arcs and grade back toward the global
size. `target_cell_size` on a loop overrides its global boundary target;
`sizing_samples` contains `(arc_fraction, target_cell_size)` pairs and uses
logarithmic interpolation. The legacy whole-loop/local promotion selector
applies to the quadtree path; finite-element sizing always grades locally.

In finite-element mode, positive `chord_tolerance_fraction` bounds the deviation
of source vertices from each free output chord as a fraction of that chord's
length. Zero retains every nonduplicate source vertex, with additional samples
to permit quad subdivision. Fixed runs always retain the requested pairs.

The constrained path uses triangulation, triangle recombination, and shared
edge subdivision to produce quads. It uses a separate algorithm from the
default quadtree path. `max_level` caps its interior sampling depth; prescribed
boundary spacing is never relaxed to meet that cap.

Optional smoothing optimizes minimum incident scaled Jacobian while locking
all boundary nodes, including control interfaces. It is deterministic and is
also available on the default path. The legacy C `enable_smoothing` flag now
performs this operation. A local edge-ratio guard prevents smoothing from
creating arbitrarily short edges to improve angles: the local ratio cannot
fall below 0.1, or its initial value when already smaller.

## Provenance and validation

Loop indices enumerate all outer loops, then all inner loops, in input order.
`GlobalMesh::boundary_nodes` records node ID, original loop, original segment,
segment parameter, and fixed-run/node indices (`-1` when not fixed). A node at
the junction of two fixed runs has a record for each membership.

`boundary_edges` records the two node IDs, original loop and segment, parameter
interval, and fixed-run/edge indices. A mesh edge spanning several original
segments has **one record per source span**. Deduplicate by node pair to count
distinct mesh edges. Parameters follow source orientation even if the mesh
element traverses the edge in reverse.

Always inspect the validation report. Successful API execution does not imply
`report.ok`: a diagnostic mesh may be returned with issues. Validation checks
connectivity, Jacobians, near-flat corners, boundary fidelity, and exact
prescribed edges. In constrained mode, geometric validation uses the prescribed
or resampled boundary; its deviation metric is relative to that boundary.
The quality summary includes minimum/maximum angle, minimum scaled Jacobian,
minimum edge ratio, and boundary deviation. Per-quad output includes minimum
Jacobian and minimum scaled Jacobian. The acceptance tests require angle ≥20°
and scaled Jacobian ≥0.3 on the CAD fixtures. Arbitrarily sharp corners or
extreme fixed spacing can impose lower quality.

## Native shared library and Python

```sh
zig build
zig build test
```

The shared ABI library is `zig-out/lib/libquadmesh_capi.dylib` on macOS,
`libquadmesh_capi.so` on Linux, or the corresponding DLL on Windows. It is
self-contained: the mesher core and the C++ runtime are linked into it, so
it is the only file to ship. Add `bindings/python`
to the application's Python module path; the binding uses only the standard
library.

```python
from quadmesh import Mesher

mesher = Mesher("/absolute/path/to/zig-out/lib/libquadmesh_capi.dylib")
points = [(0, 0), (10, 0), (10, 10), (0, 10)]
result = mesher.mesh(
    [{"points": points, "fixed_runs": [{"nodes": points, "closed": True}]}],
    target_size=3, finite_element_sizing=True, enable_smoothing=True,
)
assert result["valid"], result["issues"]
nodes, quads = result["nodes"], result["quads"]
```

Loops accept `role` (`outer`, `hole`, `control`), `target_size`,
`sizing_samples`, `vertex_kinds`, and `fixed_runs`. A partial fixed run uses
`start=(segment, parameter)` and `end=(segment, parameter)`.

Options are `target_size`, `max_refinement_level`, `local_sizing_promotion`,
`feature_angle`, `chord_tolerance`, `finite_element_sizing`,
`elements_per_circle`, `enable_smoothing`, `smoothing_iterations`,
`absolute_tolerance`, and `relative_tolerance`. All result data is copied into
Python objects before native handles are destroyed; later calls cannot
invalidate earlier results. Invalid input raises `ValueError`.

For C callers, create a context, domain and options; add loops and settings;
call `mq_mesh_generate_with_options`; inspect/copy results; and destroy handles.
`mq_context_last_error` is borrowed until the next operation on that context.
Validation issue strings are borrowed until report destruction. Copy functions
require capacity in records, not bytes. Existing functions and the original
configuration struct retain their ABI layouts; new features use opaque options.
The additive ABI version is 0.2.

## WebAssembly and JavaScript

The WebAssembly module was built with Meson and Emscripten in the standalone
quadmesh repository (frozen at commit 1abbe66, where these commands still work);
the Zig build here does not build it yet. Install and activate the
[Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html), then run
from its initialized shell, in that repository:

```sh
meson setup build-wasm --cross-file build-support/emscripten.ini \
  -Dbuild_tests=false -Dbuild_examples=false -Dbuild_tools=false -Dbuild_wasm=true
meson compile -C build-wasm
node tests/integration/javascript_binding_test.mjs build-wasm/quadmesh.mjs
```

Ship `build-wasm/quadmesh.mjs`, its adjacent `quadmesh.wasm`, and
`bindings/javascript/quadmesh.mjs` with the application. The latter is the
wrapper; it may be renamed when copying to avoid a filename collision.

```javascript
import createModule from "./build-wasm/quadmesh.mjs";
import { createMesher } from "./bindings/javascript/quadmesh.mjs";

const mesh = createMesher(await createModule());
const points = [[0, 0], [10, 0], [10, 10], [0, 10]];
const result = mesh({
  loops: [{ points, fixedRuns: [{ nodes: points, closed: true }] }],
  options: { targetSize: 3, finiteElementSizing: true, enableSmoothing: true },
});
if (!result.valid) throw new Error(result.issues.join("\n"));
```

The JavaScript names use camel case (`elementsPerCircle`, `vertexKinds`,
`sizingSamples`, etc.). Nodes are a flat `Float64Array` of XY pairs; quads are
a flat `Uint32Array` of four node IDs per element. Quality is a flat
`Float64Array` of Jacobian/scaled-Jacobian pairs. Provenance and the summary are
ordinary objects. Arrays own their data even after WebAssembly memory grows.
Handles and temporary allocations are released after each call, including
failure paths. Meshing is synchronous; use a worker for responsive browser UI.
Serve the ES module and `.wasm` through HTTP(S), with the `.wasm` file served as
`application/wasm`.

## Regression checks and previews

The prescribed-boundary contract suite covers the 76-node plate, the 12-node
small hole, partial nonuniform runs, control regions, parity errors, smoothing,
determinism, and all seven CAD fixtures. The fixtures use a simple text format:
loop count, then for each loop its point count and XY pairs (first loop outer,
remaining loops holes).

```sh
zig-out/bin/quadmesh_probe tests/fixtures/cad_faces/rover_chassis_face1.txt 4 fe mesh.svg
python3 tests/integration/python_binding_test.py zig-out/lib/libquadmesh_capi.dylib
python3 tools/render_mesh_gallery.py zig-out/lib/libquadmesh_capi.dylib build/mesh-previews
```

The probe reports validity, element count, quality, and elapsed meshing plus
validation time. Timing checks should use a release build without concurrent
heavy processes; correctness tests intentionally avoid machine-dependent
timing assertions.

The preview command requires Matplotlib; this is only a rendering dependency,
not a dependency of the Python binding. It writes individual PNGs, overview
images, and the exact mesh data and quality metrics used to render them.

### Verified acceptance results

Native release results on 2026-10-20, with target size 4, finite-element sizing
and 12 smoothing iterations:

| Fixture | Quads | Minimum angle | Minimum scaled Jacobian |
| --- | ---: | ---: | ---: |
| rover_chassis_face1 | 3,248 | 36.87° | 0.600 |
| rover_chassis_face2 | 3,204 | 39.57° | 0.637 |
| rover_chassis_face61 | 1,294 | 32.04° | 0.531 |
| wheel_top | 495 | 50.95° | 0.777 |
| balancer_chassis_face17 | 166 | 40.81° | 0.654 |
| balancer_chassis_face19 | 535 | 41.19° | 0.659 |
| balancer_chassis_face21 | 537 | 42.46° | 0.675 |

All seven validate natively and in WebAssembly. The fixed plate preserves
exactly 76 boundary nodes (210 quads, minimum scaled Jacobian 0.827). The small
hole receives exactly 12 boundary nodes (204 quads, minimum scaled Jacobian
0.828). The first chassis fixture at target size 3 produces 5,120 quads in
0.51–0.58 seconds across three runs, including validation, on the local Apple
Silicon release build.

Validation also passed the 13 native test suites (including Python), all
12 C++ suites with UndefinedBehaviorSanitizer, the JavaScript integration
tests, and the eight legacy gallery cases. AddressSanitizer could not be
evaluated on this host: even an independent empty ASan program hung before
`main`.
