#include "quadmesh/validation.hpp"

#include "quadmesh/geometry.hpp"
#include "detail/boundary.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
#include <numbers>
#include <string>
#include <unordered_map>
#include <vector>

namespace quadmesh {
namespace {

constexpr double pi = std::numbers::pi_v<double>;

double corner_angle_deg(Point2 prev, Point2 at, Point2 next)
{
  const Vec2 u = prev - at;
  const Vec2 v = next - at;
  const double lu = length(u);
  const double lv = length(v);
  if (lu <= 0.0 || lv <= 0.0) {
    return 0.0;
  }
  double angle = std::atan2(cross(v, u), dot(v, u));
  if (angle < 0.0) {
    angle += 2.0 * pi;
  }
  return angle * 180.0 / pi;
}

} // namespace

ValidationReport validate_mesh(const GlobalMesh& mesh, const DomainGeometry& domain, const MeshingConfig& config)
{
  if (detail::uses_prescribed_boundary(domain, config)) {
    const auto boundary = detail::prepare_boundary(domain, config);
    auto effective_config = config;
    effective_config.finite_element_sizing = false;
    auto report = validate_mesh(mesh, boundary.geometry, effective_config);
    std::map<std::pair<double, double>, std::uint32_t> nodes;
    std::map<std::pair<std::uint32_t, std::uint32_t>, int> edges;
    for (std::size_t i = 0; i < mesh.nodes.size(); ++i)
      if (mesh.nodes[i].on_boundary) nodes[{mesh.nodes[i].point.x, mesh.nodes[i].point.y}] = static_cast<std::uint32_t>(i);
    for (const auto& q : mesh.quads) for (int k = 0; k < 4; ++k) {
      const auto a = q.nodes[k].value, b = q.nodes[(k + 1) % 4].value;
      ++edges[{std::min(a, b), std::max(a, b)}];
    }
    for (std::size_t li = 0; li < boundary.loops.size(); ++li) {
      const auto& loop = boundary.loops[li];
      for (std::size_t k = 0; k < loop.points.size(); ++k) {
        const Point2 p = loop.points[k], q = loop.points[(k + 1) % loop.points.size()];
        const auto a = nodes.find({p.x, p.y}), b = nodes.find({q.x, q.y});
        if (a == nodes.end() || b == nodes.end()
            || edges[{std::min(a->second, b->second), std::max(a->second, b->second)}] != (loop.control ? 2 : 1)) {
          report.ok = false;
          report.issues.push_back("prescribed edge missing or split on loop " + std::to_string(li)
                                 + ", edge " + std::to_string(k));
        }
      }
    }
    return report;
  }
  ValidationReport report;
  report.quad_count = mesh.quads.size();
  report.node_count = mesh.nodes.size();
  if (mesh.quads.empty()) {
    report.ok = false;
    report.issues.push_back("mesh is empty");
    return report;
  }

  report.min_angle_deg = std::numeric_limits<double>::max();
  report.max_angle_deg = 0.0;
  report.min_scaled_jacobian = std::numeric_limits<double>::max();
  report.min_edge_ratio = std::numeric_limits<double>::max();

  double edge_ratio_sum = 0.0;
  std::unordered_map<std::uint64_t, int> edge_count;
  const auto edge_key = [](std::uint32_t a, std::uint32_t b) {
    return (static_cast<std::uint64_t>(std::min(a, b)) << 32) | std::max(a, b);
  };

  std::vector<Segment2> geometry_segments;
  const auto collect_segments = [&geometry_segments](const PolylineLoop& loop) {
    const std::vector<Segment2> segments = loop_segments(loop);
    geometry_segments.insert(geometry_segments.end(), segments.begin(), segments.end());
  };
  for (const PolylineLoop& loop : domain.outer_loops) {
    collect_segments(loop);
  }
  for (const InnerLoop& inner : domain.inner_loops) {
    collect_segments(inner.loop);
  }
  const Aabb2 domain_bounds = bounds_of(domain);
  const double domain_extent = std::max(max_extent(domain_bounds), 1.0e-12);
  const double geometry_eps = std::max(config.tolerances.absolute_distance,
                                       config.tolerances.relative_distance * domain_extent);
  const auto edge_deviation = [&](Point2 a, Point2 b) {
    double worst = 0.0;
    for (int sample = 0; sample <= 8; ++sample) {
      const double t = static_cast<double>(sample) / 8.0;
      const Point2 p = a + (b - a) * t;
      double nearest = std::numeric_limits<double>::max();
      for (const Segment2& segment : geometry_segments) {
        nearest = std::min(nearest, distance_to_segment(p, segment));
      }
      worst = std::max(worst, nearest);
    }
    return worst;
  };

  for (std::size_t qi = 0; qi < mesh.quads.size(); ++qi) {
    const Quad4& quad = mesh.quads[qi];
    Point2 p[4];
    for (int k = 0; k < 4; ++k) {
      if (quad.nodes[k].value >= mesh.nodes.size()) {
        report.ok = false;
        report.issues.push_back("quad references a node outside the mesh");
        return report;
      }
      p[k] = mesh.nodes[quad.nodes[k].value].point;
    }
    double shortest = std::numeric_limits<double>::max();
    double longest = 0.0;
    for (int k = 0; k < 4; ++k) {
      const std::uint32_t a = quad.nodes[k].value;
      const std::uint32_t b = quad.nodes[(k + 1) % 4].value;
      edge_count[edge_key(a, b)] += 1;
      const double len = distance(p[k], p[(k + 1) % 4]);
      shortest = std::min(shortest, len);
      longest = std::max(longest, len);

      const Point2 prev = p[(k + 3) % 4];
      const Point2 next = p[(k + 1) % 4];
      const double angle = corner_angle_deg(prev, p[k], next);
      report.min_angle_deg = std::min(report.min_angle_deg, angle);
      report.max_angle_deg = std::max(report.max_angle_deg, angle);
      if (angle < 1.0 || angle > 179.0) {
        ++report.flat_angle_count;
      }
      const Vec2 e1 = next - p[k];
      const Vec2 e2 = prev - p[k];
      const double denominator = length(e1) * length(e2);
      const double scaled = denominator > 0.0 ? cross(e1, e2) / denominator : -1.0;
      report.min_scaled_jacobian = std::min(report.min_scaled_jacobian, scaled);
    }
    if (longest > 0.0) {
      const double ratio = shortest / longest;
      report.min_edge_ratio = std::min(report.min_edge_ratio, ratio);
      edge_ratio_sum += ratio;
    }
    if (signed_quad_area(mesh, quad) <= 0.0) {
      ++report.inverted_quad_count;
    }
  }
  report.average_edge_ratio = edge_ratio_sum / static_cast<double>(mesh.quads.size());

  // Conformity: interior edges shared by exactly two quads; single-sided
  // edges must lie on the input geometry.
  for (const auto& [edge, count] : edge_count) {
    if (count > 2) {
      ++report.nonconforming_edge_count;
      continue;
    }
    if (count == 1) {
      const auto node_a = static_cast<std::uint32_t>(edge >> 32);
      const auto node_b = static_cast<std::uint32_t>(edge & 0xffffffffu);
      const Point2 a = mesh.nodes[node_a].point;
      const Point2 b = mesh.nodes[node_b].point;
      const double deviation = edge_deviation(a, b);
      report.max_boundary_deviation = std::max(report.max_boundary_deviation, deviation);
      const double tolerance = std::max(geometry_eps,
                                        config.features.chord_tolerance_fraction * distance(a, b));
      const bool on_geometry = mesh.nodes[node_a].on_boundary && mesh.nodes[node_b].on_boundary
          && deviation <= tolerance;
      if (!on_geometry) {
        ++report.nonconforming_edge_count;
        ++report.boundary_off_geometry_edge_count;
      }
    }
  }

  // No element edge may cross the input boundary: gather all geometry
  // segments into a bucket grid, then test each unique mesh edge for a
  // proper interior crossing. Edges lying on the geometry are parallel to
  // it (or touch only at endpoints) and are not flagged.
  {
    const std::vector<Segment2>& segments = geometry_segments;
    const Aabb2& bounds = domain_bounds;
    const double extent = domain_extent;
    const double bucket = extent / 64.0;
    std::unordered_map<long long, std::vector<int>> grid;
    for (int s = 0; s < static_cast<int>(segments.size()); ++s) {
      const Segment2& seg = segments[s];
      const long long x0 = static_cast<long long>(
          std::floor((std::min(seg.a.x, seg.b.x) - bounds.min.x) / bucket));
      const long long x1 = static_cast<long long>(
          std::floor((std::max(seg.a.x, seg.b.x) - bounds.min.x) / bucket));
      const long long y0 = static_cast<long long>(
          std::floor((std::min(seg.a.y, seg.b.y) - bounds.min.y) / bucket));
      const long long y1 = static_cast<long long>(
          std::floor((std::max(seg.a.y, seg.b.y) - bounds.min.y) / bucket));
      for (long long y = y0; y <= y1; ++y) {
        for (long long x = x0; x <= x1; ++x) {
          grid[(x << 32) ^ (y & 0xffffffffll)].push_back(s);
        }
      }
    }
    const double eps_abs = 1.0e-9 * extent;
    const auto proper_crossing = [&](Point2 a, Point2 b, const Segment2& seg) {
      const Vec2 sd = seg.b - seg.a;
      const Vec2 ed = b - a;
      const double e_seg = eps_abs * std::max(length(ed), 1.0e-300);
      const double e_edge = eps_abs * std::max(length(sd), 1.0e-300);
      const double d1 = cross(sd, a - seg.a);
      const double d2 = cross(sd, b - seg.a);
      const double d3 = cross(ed, seg.a - a);
      const double d4 = cross(ed, seg.b - a);
      const bool edge_straddles = (d1 > e_edge && d2 < -e_edge) || (d1 < -e_edge && d2 > e_edge);
      const bool seg_straddles = (d3 > e_seg && d4 < -e_seg) || (d3 < -e_seg && d4 > e_seg);
      return edge_straddles && seg_straddles;
    };
    for (const auto& [edge, count] : edge_count) {
      (void)count;
      const Point2 a = mesh.nodes[static_cast<std::uint32_t>(edge >> 32)].point;
      const Point2 b = mesh.nodes[static_cast<std::uint32_t>(edge & 0xffffffffu)].point;
      const long long x0 = static_cast<long long>(
          std::floor((std::min(a.x, b.x) - bounds.min.x) / bucket));
      const long long x1 = static_cast<long long>(
          std::floor((std::max(a.x, b.x) - bounds.min.x) / bucket));
      const long long y0 = static_cast<long long>(
          std::floor((std::min(a.y, b.y) - bounds.min.y) / bucket));
      const long long y1 = static_cast<long long>(
          std::floor((std::max(a.y, b.y) - bounds.min.y) / bucket));
      bool crossing = false;
      for (long long y = y0; y <= y1 && !crossing; ++y) {
        for (long long x = x0; x <= x1 && !crossing; ++x) {
          const auto it = grid.find((x << 32) ^ (y & 0xffffffffll));
          if (it == grid.end()) {
            continue;
          }
          for (const int s : it->second) {
            if (proper_crossing(a, b, segments[s])) {
              crossing = true;
              break;
            }
          }
        }
      }
      if (crossing) {
        ++report.boundary_crossing_edge_count;
      }
    }
  }

  if (report.inverted_quad_count > 0) {
    report.ok = false;
    report.issues.push_back("inverted quads: " + std::to_string(report.inverted_quad_count));
  }
  if (report.boundary_crossing_edge_count > 0) {
    report.ok = false;
    report.issues.push_back(
        "element edges crossing the boundary: " + std::to_string(report.boundary_crossing_edge_count));
  }
  if (report.nonconforming_edge_count > 0) {
    report.ok = false;
    report.issues.push_back(
        "non-conforming edges: " + std::to_string(report.nonconforming_edge_count));
  }
  if (report.boundary_off_geometry_edge_count > 0) {
    report.ok = false;
    report.issues.push_back("boundary edges off input geometry: "
                            + std::to_string(report.boundary_off_geometry_edge_count));
  }
  if (report.flat_angle_count > 0) {
    report.ok = false;
    report.issues.push_back("near-flat corners: " + std::to_string(report.flat_angle_count));
  }

  // Boundary fidelity: every sharp input corner must coincide with a node.
  const Aabb2 bounds = bounds_of(domain);
  const double tol = 1.0e-6 * std::max(max_extent(bounds), 1.0e-12);
  auto check_loop = [&](const PolylineLoop& loop) {
    const std::size_t n = loop.vertices.size();
    if (!loop.vertex_kinds.empty() && loop.vertex_kinds.size() != n) {
      report.ok = false;
      report.issues.push_back("vertex_kinds must have one entry per input vertex");
      return;
    }
    for (std::size_t i = 0; i < n; ++i) {
      const auto kind = loop.vertex_kinds.empty() ? VertexKind::Automatic : loop.vertex_kinds[i];
      if (kind == VertexKind::Smooth) continue;
      const Point2 prev = loop.vertices[(i + n - 1) % n];
      const Point2 next = loop.vertices[(i + 1) % n];
      const Vec2 in = loop.vertices[i] - prev;
      const Vec2 out = next - loop.vertices[i];
      const double li = length(in);
      const double lo = length(out);
      if (li <= 0.0 || lo <= 0.0) {
        continue;
      }
      const double turn = std::acos(std::clamp(dot(in, out) / (li * lo), -1.0, 1.0)) * 180.0 / pi;
      if (kind != VertexKind::Corner && turn <= config.features.feature_angle_deg) {
        continue; // only require exact capture of decidedly sharp corners
      }
      bool found = false;
      for (const MeshNode& node : mesh.nodes) {
        if (node.on_boundary && distance(node.point, loop.vertices[i]) <= tol) {
          found = true;
          break;
        }
      }
      if (!found) {
        report.ok = false;
        report.issues.push_back("sharp input vertex not present in mesh");
      }
    }
  };
  for (const PolylineLoop& loop : domain.outer_loops) {
    if (loop.closed) {
      check_loop(loop);
    }
  }
  for (const InnerLoop& inner : domain.inner_loops) {
    if (inner.loop.closed) {
      check_loop(inner.loop);
    }
  }
  return report;
}

} // namespace quadmesh
