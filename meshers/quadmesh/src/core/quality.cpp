#include "quadmesh/quality.hpp"

#include "quadmesh/geometry.hpp"

#include <algorithm>
#include <limits>

namespace quadmesh {
namespace {

double corner_jacobian(Point2 a, Point2 b, Point2 c) noexcept {
  return 0.25 * cross(b - a, c - a);
}

double scaled_corner_jacobian(Point2 a, Point2 b, Point2 c) noexcept {
  const Vec2 ab = b - a;
  const Vec2 ac = c - a;
  const double denominator = length(ab) * length(ac);
  if (denominator <= 1.0e-14) {
    return 0.0;
  }
  return cross(ab, ac) / denominator;
}

} // namespace

QuadQuality quad_quality(const GlobalMesh& mesh, const Quad4& quad) noexcept {
  const Point2 p0 = mesh.nodes[quad.nodes[0].value].point;
  const Point2 p1 = mesh.nodes[quad.nodes[1].value].point;
  const Point2 p2 = mesh.nodes[quad.nodes[2].value].point;
  const Point2 p3 = mesh.nodes[quad.nodes[3].value].point;
  QuadQuality quality;
  quality.min_jacobian =
      std::min({corner_jacobian(p0, p1, p3), corner_jacobian(p1, p2, p0),
                corner_jacobian(p2, p3, p1), corner_jacobian(p3, p0, p2)});
  quality.min_scaled_jacobian = std::min(
      {scaled_corner_jacobian(p0, p1, p3), scaled_corner_jacobian(p1, p2, p0),
       scaled_corner_jacobian(p2, p3, p1), scaled_corner_jacobian(p3, p0, p2)});
  return quality;
}

MeshQualityReport mesh_quality_report(const GlobalMesh& mesh) noexcept {
  MeshQualityReport report;
  if (mesh.quads.empty()) {
    return report;
  }
  report.min_jacobian = std::numeric_limits<double>::infinity();
  report.min_scaled_jacobian = std::numeric_limits<double>::infinity();
  for (std::size_t i = 0; i < mesh.quads.size(); ++i) {
    const QuadQuality quality = quad_quality(mesh, mesh.quads[i]);
    if (quality.min_jacobian < report.min_jacobian) {
      report.min_jacobian = quality.min_jacobian;
      report.min_jacobian_element = i + 1U;
    }
    if (quality.min_scaled_jacobian < report.min_scaled_jacobian) {
      report.min_scaled_jacobian = quality.min_scaled_jacobian;
      report.min_scaled_jacobian_element = i + 1U;
    }
  }
  return report;
}

} // namespace quadmesh
