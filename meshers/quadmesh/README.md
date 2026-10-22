# quadmesh

`quadmesh` is a C++20 library for generating conforming, all-quadrilateral
meshes from planar polyline boundaries. It supports holes, embedded mesh-control
loops, per-boundary and arc-length local sizing, automatic local sizing
promotion, and strongly balanced 2:1 transitions.

Fixed boundary runs preserve supplied nodes and consecutive edges exactly.
An optional finite-element sizing mode controls circle resolution and grades
away from small features. Both modes provide boundary provenance, validation
messages, per-quad quality, and optional smoothing with locked boundaries.
See [Embedding and boundary control](docs/embedding.md) for the C ABI,
Python ctypes binding, and WebAssembly/JavaScript build and usage.

## Build

[Zig](https://ziglang.org) 0.17 or later is the only requirement: it compiles the C++20
sources with its own Clang and libc++. The build is optimized by default
(`-Doptimize=debug` when debugging).

```sh
zig build             # zig-out/lib: libquadmesh_capi (shared and static), libquadmesh_core.a
zig build examples    # zig-out/bin: the examples and the quadmesh_svg and quadmesh_probe tools
zig build test        # the gtest suites and the Python binding test
```

`zig build test` fetches GoogleTest 1.17.0 (pinned in `build.zig.zon`) the first time and
builds it with the same toolchain. Within WebMesh, `zig build` in the repository root
builds this library together with the paved mesher.

## Minimal C++ usage

```cpp
#include "quadmesh/io.hpp"
#include "quadmesh/pipeline.hpp"

int main()
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back(
      {{{0, 0}, {1, 0}, {1, 1}, {0, 1}}, true});

  quadmesh::MeshingConfig config;
  config.refinement.target_cell_size = 0.25;

  const auto result = quadmesh::MeshingPipeline{}.run(domain, config);
  quadmesh::write_mesh_svg("mesh.svg", result.mesh, domain);
  return result.validation.ok ? 0 : 1;
}
```

Set `PolylineLoop::target_cell_size` for per-loop sizing and
`PolylineLoop::sizing_samples` for arc-length local sizing. Use
`SizingPromotionMode::Local` when fine grading should promote only nearby arcs
of another boundary.

## Examples and output

- `cpp_minimal` and `c_minimal`: basic C++ and C API usage.
- `cpp_local_sizing`: local sizing versus a uniform fine mesh.
- `cpp_plate_circle`: coarse plate boundary with an offset fine hole.
- `cpp_gallery`: geometry and robustness examples.
- `cpp_template_gaps`: visualization of atomic transition-template coverage.

Meshes can be written as Nastran BDF, SVG, or PPM through `quadmesh/io.hpp`.
Closed, non-self-intersecting loops are the primary input; open polylines are
partially supported and isolated point features are not.

## SVG import CLI

`quadmesh_svg` imports the filled, closed paths in an SVG and writes a mesh
preview. It supports path curves and arcs, transforms, and the standard filled
shape primitives. SVG paint compositing (strokes, masks, clipping, and text)
is intentionally not converted to mesh geometry.

```sh
zig-out/bin/quadmesh_svg artwork.svg --size 5 --curve-tolerance 0.25 -o mesh.svg
```

Use `--fill '#000000'` to select one fill colour from a layered illustration,
and `--bdf mesh.bdf` or `--ppm mesh.ppm` for additional exports. Nested rings
use the mesher's even-odd domain rule and become holes automatically.

Before meshing, the CLI detects self-crossing, overlapping, and touching
boundaries. Those require SVG Boolean cleanup (or a simpler export) and are
reported without running the mesher; `--force` retains the best-effort path
for diagnosis.
