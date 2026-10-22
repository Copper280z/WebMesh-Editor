#pragma once

#include "quadmesh/geometry.hpp"
#include "quadmesh/ids.hpp"

#include <array>
#include <vector>

namespace quadmesh {

struct MeshNode {
  Point2 point;
  // True when the node lies on an input geometry curve or vertex.
  bool on_boundary = false;
};

struct Quad4 {
  std::array<NodeId, 4> nodes{};
};

// Loop indices enumerate outer_loops followed by inner_loops. A mesh node
// can have multiple records at run junctions. -1 denotes no fixed-run source.
struct BoundaryNodeSource {
  NodeId node;
  std::uint32_t loop = 0;
  BoundaryPosition position;
  std::int32_t fixed_run = -1;
  std::int32_t fixed_node = -1;
};

// One mesh edge can span several sampled source segments. Records describe
// those segments without inserting extra mesh nodes. Parameters follow the
// source segment direction; node order follows the input loop direction.
struct BoundaryEdgeSource {
  std::array<NodeId, 2> nodes;
  std::uint32_t loop = 0;
  std::uint32_t segment = 0;
  double parameter_start = 0.0;
  double parameter_end = 1.0;
  std::int32_t fixed_run = -1;
  std::int32_t fixed_edge = -1;
};

struct GlobalMesh {
  std::vector<MeshNode> nodes;
  std::vector<Quad4> quads;
  std::vector<BoundaryNodeSource> boundary_nodes;
  std::vector<BoundaryEdgeSource> boundary_edges;
};

double signed_quad_area(const GlobalMesh& mesh, const Quad4& quad) noexcept;

} // namespace quadmesh
