#include "stages/finalize.hpp"

#include "quadmesh/geometry.hpp"
#include "quadmesh/ids.hpp"

#include <cstddef>
#include <cstdint>
#include <utility>
#include <vector>

namespace quadmesh::detail {

GlobalMesh finalize(const MeshBuilder& mb)
{
  const auto& nodes = mb.nodes;
  const auto& quads = mb.quads;
  GlobalMesh result;

  // Compact: keep only nodes referenced by quads, orient quads CCW.
  std::vector<int> remap(nodes.size(), -1);
  for (const auto& quad : quads) {
    for (const int node : quad) {
      remap[static_cast<std::size_t>(node)] = 0;
    }
  }
  for (std::size_t i = 0, next = 0; i < remap.size(); ++i) {
    if (remap[i] == 0) {
      remap[i] = static_cast<int>(next++);
      result.nodes.push_back(nodes[i]);
    }
  }
  result.quads.reserve(quads.size());
  for (const auto& quad : quads) {
    Quad4 q;
    for (int k = 0; k < 4; ++k) {
      q.nodes[k] = NodeId{static_cast<std::uint32_t>(remap[static_cast<std::size_t>(quad[k])])};
    }
    // Orient CCW.
    const Point2 a = result.nodes[q.nodes[0].value].point;
    const Point2 b = result.nodes[q.nodes[1].value].point;
    const Point2 c = result.nodes[q.nodes[2].value].point;
    const Point2 d = result.nodes[q.nodes[3].value].point;
    const double area2 = cross(b - a, c - a) + cross(c - a, d - a);
    if (area2 < 0.0) {
      std::swap(q.nodes[1], q.nodes[3]);
    }
    result.quads.push_back(q);
  }
  return result;
}

} // namespace quadmesh::detail
