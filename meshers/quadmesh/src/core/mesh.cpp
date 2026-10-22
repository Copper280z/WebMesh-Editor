#include "quadmesh/mesh.hpp"

namespace quadmesh {

double signed_quad_area(const GlobalMesh& mesh, const Quad4& quad) noexcept
{
  const Point2 a = mesh.nodes[quad.nodes[0].value].point;
  const Point2 b = mesh.nodes[quad.nodes[1].value].point;
  const Point2 c = mesh.nodes[quad.nodes[2].value].point;
  const Point2 d = mesh.nodes[quad.nodes[3].value].point;
  return 0.5 * (cross(b - a, c - a) + cross(c - a, d - a));
}

} // namespace quadmesh
