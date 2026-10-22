#pragma once

#include "quadmesh/config.hpp"
#include "quadmesh/mesh.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace quadmesh {

// Debug snapshot of the quadtree and repelling stages, for tests and the
// SVG/stage-debug tooling.
struct MesherDebug {
  struct Leaf {
    Aabb2 box;
    std::uint16_t level = 0;
    // 0 = empty/outside, 1 = empty/inside, 2 = cut, 3 = vertex
    int classification = 0;
  };
  std::vector<Leaf> leaves;
  std::vector<Segment2> corner_moves; // a = original grid point, b = repelled
  std::uint16_t boundary_level = 0;
  std::size_t parity_defect_count = 0; // odd generalized empty-cell boundaries
  std::size_t parity_path_split_count = 0; // atomic spans selected by the global T-join
  double parity_path_total_length = 0.0;
  std::vector<std::string> warnings;
};

// All-quad meshing of the interior of `domain`. The default path follows
// Rushdi et al. 2017, "All-Quad Meshing without Cleanup":
//   1. strongly balanced quadtree, optionally arc-length-graded along boundaries
//   2. grid corners repelled to a clearance of delta = s/4 from the geometry
//   3. cut squares split into polygons and meshed with midpoint subdivision
//   4. remaining hanging nodes resolved with two-refinement templates
// Fixed boundary runs or finite_element_sizing select a constrained
// triangulation/recombination path with shared edge subdivision. It preserves
// the prescribed boundary discretization and grades interior spacing locally.
// Optional smoothing moves only interior nodes in either path.
GlobalMesh build_mesh(const DomainGeometry& domain, const MeshingConfig& config, MesherDebug* debug = nullptr);

} // namespace quadmesh
