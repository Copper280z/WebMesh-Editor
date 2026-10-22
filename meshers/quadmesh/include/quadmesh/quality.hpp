#pragma once

#include "quadmesh/mesh.hpp"

#include <cstddef>

namespace quadmesh {

// Per-quad Jacobian-based quality. At each corner the Jacobian is one quarter
// of the cross product of the two incident edge vectors; the scaled variant
// divides by the edge lengths, giving sin of the corner angle (1 at a right
// angle, <= 0 when the corner is flat or inverted). The quad value is the
// minimum over its four corners.
struct QuadQuality {
  double min_jacobian = 0.0;
  double min_scaled_jacobian = 0.0;
};

QuadQuality quad_quality(const GlobalMesh& mesh, const Quad4& quad) noexcept;

// Worst-quad Jacobian summary over a whole mesh. Element indices are 1-based to
// match common mesh-file conventions; they are 0 when the mesh has no quads (in
// which case both Jacobians are reported as 0).
struct MeshQualityReport {
  double min_jacobian = 0.0;
  double min_scaled_jacobian = 0.0;
  std::size_t min_jacobian_element = 0;
  std::size_t min_scaled_jacobian_element = 0;
};

MeshQualityReport mesh_quality_report(const GlobalMesh& mesh) noexcept;

} // namespace quadmesh
