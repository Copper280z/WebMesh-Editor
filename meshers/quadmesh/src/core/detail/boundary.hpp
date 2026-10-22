#pragma once

#include "quadmesh/config.hpp"
#include "quadmesh/mesh.hpp"

namespace quadmesh::detail {

struct SampledLoop {
  std::vector<Point2> points;
  std::vector<BoundaryNodeSource> sources;
  std::vector<std::int32_t> fixed_edges;
  std::vector<std::int32_t> fixed_edge_indices;
  bool hole = false;
  bool control = false;
};

struct PreparedBoundary {
  std::vector<SampledLoop> loops;
  DomainGeometry geometry;
};

bool uses_prescribed_boundary(const DomainGeometry& domain, const MeshingConfig& config);
PreparedBoundary prepare_boundary(const DomainGeometry& domain, const MeshingConfig& config);
void attach_boundary_sources(GlobalMesh& mesh, const DomainGeometry& domain,
                             const PreparedBoundary* prepared = nullptr);
void smooth_interior(GlobalMesh& mesh, std::uint32_t iterations);

} // namespace quadmesh::detail
