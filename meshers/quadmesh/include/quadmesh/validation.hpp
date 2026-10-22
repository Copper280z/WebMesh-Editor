#pragma once

#include "quadmesh/config.hpp"
#include "quadmesh/mesh.hpp"

#include <string>
#include <vector>

namespace quadmesh {

struct ValidationReport {
  bool ok = true;
  std::vector<std::string> issues;

  std::size_t quad_count = 0;
  std::size_t node_count = 0;
  std::size_t inverted_quad_count = 0;
  std::size_t nonconforming_edge_count = 0;
  // Single-sided mesh edges whose deviation from input geometry exceeds the
  // configured smooth-chain chord tolerance.
  std::size_t boundary_off_geometry_edge_count = 0;
  double max_boundary_deviation = 0.0;
  std::size_t flat_angle_count = 0;
  // Element edges whose interior properly crosses an input boundary curve.
  std::size_t boundary_crossing_edge_count = 0;

  double min_angle_deg = 0.0;
  double max_angle_deg = 0.0;
  double min_scaled_jacobian = 0.0;
  // Minimum and average ratio of shortest to longest edge per quad.
  double min_edge_ratio = 0.0;
  double average_edge_ratio = 0.0;
};

// Checks that the mesh is all-quad, conforming (every interior edge shared by
// exactly two quads), free of inverted elements, and that every
// single-sided edge lies on input geometry within the configured smooth-chain
// chord tolerance. Also gathers quality metrics.
ValidationReport validate_mesh(const GlobalMesh& mesh, const DomainGeometry& domain, const MeshingConfig& config);

} // namespace quadmesh
