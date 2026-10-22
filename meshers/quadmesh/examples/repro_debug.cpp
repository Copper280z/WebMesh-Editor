// Temporary debug harness for robustness investigation.
#include "quadmesh/pipeline.hpp"
#include "quadmesh/shapes.hpp"

#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <numbers>
#include <string>
#include <utility>

namespace {

void dump_svg(const std::string& path, const quadmesh::PipelineRunResult& result,
              const quadmesh::DomainGeometry& domain)
{
  quadmesh::Aabb2 bounds = quadmesh::bounds_of(domain);
  const double margin = 0.15 * quadmesh::max_extent(bounds);
  bounds.min.x -= margin;
  bounds.min.y -= margin;
  bounds.max.x += margin;
  bounds.max.y += margin;
  const double scale = 1400.0 / quadmesh::max_extent(bounds);
  const auto mx = [&](double x) { return (x - bounds.min.x) * scale; };
  const auto my = [&](double y) { return (bounds.max.y - y) * scale; };

  std::ofstream svg(path);
  svg << "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" << mx(bounds.max.x) << "\" height=\""
      << my(bounds.min.y) << "\">\n<rect width=\"100%\" height=\"100%\" fill=\"white\"/>\n";
  // Quadtree leaves colored by classification.
  for (const auto& leaf : result.debug.leaves) {
    const char* color = leaf.classification == 1 ? "#eef" : leaf.classification == 2 ? "#fee"
        : leaf.classification == 3                        ? "#efe"
                                                          : "none";
    svg << "<rect x=\"" << mx(leaf.box.min.x) << "\" y=\"" << my(leaf.box.max.y) << "\" width=\""
        << (leaf.box.max.x - leaf.box.min.x) * scale << "\" height=\""
        << (leaf.box.max.y - leaf.box.min.y) * scale << "\" fill=\"" << color
        << "\" stroke=\"#ccc\" stroke-width=\"0.5\"/>\n";
  }
  for (const quadmesh::Quad4& quad : result.mesh.quads) {
    svg << "<polygon points=\"";
    for (const quadmesh::NodeId node_id : quad.nodes) {
      const quadmesh::Point2 p = result.mesh.nodes[node_id.value].point;
      svg << mx(p.x) << "," << my(p.y) << " ";
    }
    svg << "\" fill=\"none\" stroke=\"#567\" stroke-width=\"0.8\"/>\n";
  }
  // Non-conforming edges in red.
  std::map<std::pair<unsigned, unsigned>, int> edge_count;
  for (const quadmesh::Quad4& quad : result.mesh.quads) {
    for (int k = 0; k < 4; ++k) {
      const unsigned a = quad.nodes[k].value;
      const unsigned b = quad.nodes[(k + 1) % 4].value;
      edge_count[{std::min(a, b), std::max(a, b)}] += 1;
    }
  }
  for (const auto& [edge, count] : edge_count) {
    const auto& na = result.mesh.nodes[edge.first];
    const auto& nb = result.mesh.nodes[edge.second];
    const bool bad = count > 2 || (count == 1 && !(na.on_boundary && nb.on_boundary));
    if (!bad) {
      continue;
    }
    svg << "<line x1=\"" << mx(na.point.x) << "\" y1=\"" << my(na.point.y) << "\" x2=\""
        << mx(nb.point.x) << "\" y2=\"" << my(nb.point.y)
        << "\" stroke=\"red\" stroke-width=\"3\"/>\n";
  }
  const auto draw_loop = [&](const quadmesh::PolylineLoop& loop) {
    svg << "<polyline points=\"";
    for (const quadmesh::Point2 p : loop.vertices) {
      svg << mx(p.x) << "," << my(p.y) << " ";
    }
    svg << mx(loop.vertices.front().x) << "," << my(loop.vertices.front().y);
    svg << "\" fill=\"none\" stroke=\"#2a2\" stroke-width=\"1.5\"/>\n";
  };
  for (const auto& loop : domain.outer_loops) {
    draw_loop(loop);
  }
  for (const auto& inner : domain.inner_loops) {
    draw_loop(inner.loop);
  }
  svg << "</svg>\n";
}

int run_case(const std::string& name, const quadmesh::DomainGeometry& domain, bool svg = false,
             quadmesh::MeshingConfig config = {})
{
  const quadmesh::PipelineRunResult result = quadmesh::MeshingPipeline{}.run(domain, config);
  std::cout << name << ": ok=" << (result.validation.ok ? "true" : "false")
            << " quads=" << result.mesh.quads.size() << " angles=["
            << result.validation.min_angle_deg << ", " << result.validation.max_angle_deg << "]";
  for (const std::string& issue : result.validation.issues) {
    std::cout << " issue{" << issue << "}";
  }
  for (const std::string& warning : result.debug.warnings) {
    std::cout << " warn{" << warning << "}";
  }
  std::cout << "\n";
  if (svg) {
    dump_svg("debug_" + name + ".svg", result, domain);
    std::cout << "wrote debug_" << name << ".svg\n";
    // Print bad edges with the leaves containing their midpoints.
    std::map<std::pair<unsigned, unsigned>, int> edge_count;
    for (const quadmesh::Quad4& quad : result.mesh.quads) {
      for (int k = 0; k < 4; ++k) {
        const unsigned a = quad.nodes[k].value;
        const unsigned b = quad.nodes[(k + 1) % 4].value;
        edge_count[{std::min(a, b), std::max(a, b)}] += 1;
      }
    }
    // Flat/reflex corners and inverted quads.
    int flat_shown = 0;
    for (const quadmesh::Quad4& quad : result.mesh.quads) {
      for (int k = 0; k < 4 && flat_shown < 12; ++k) {
        const quadmesh::Point2 prev = result.mesh.nodes[quad.nodes[(k + 3) % 4].value].point;
        const quadmesh::Point2 at = result.mesh.nodes[quad.nodes[k].value].point;
        const quadmesh::Point2 next = result.mesh.nodes[quad.nodes[(k + 1) % 4].value].point;
        const quadmesh::Vec2 u = prev - at;
        const quadmesh::Vec2 v = next - at;
        double angle = std::atan2(quadmesh::cross(v, u), quadmesh::dot(v, u)) * 180.0
            / std::numbers::pi_v<double>;
        if (angle < 0.0) {
          angle += 360.0;
        }
        if (angle < 1.0 || angle > 179.0) {
          ++flat_shown;
          std::cout << "flat corner " << angle << " deg at (" << at.x << "," << at.y << ")\n";
        }
      }
    }
    int shown = 0;
    for (const auto& [edge, count] : edge_count) {
      const auto& na = result.mesh.nodes[edge.first];
      const auto& nb = result.mesh.nodes[edge.second];
      const bool bad = count > 2 || (count == 1 && !(na.on_boundary && nb.on_boundary));
      if (!bad || shown++ >= 12) {
        continue;
      }
      const quadmesh::Point2 mid{(na.point.x + nb.point.x) / 2.0,
                                 (na.point.y + nb.point.y) / 2.0};
      std::cout << "bad edge count=" << count << " (" << na.point.x << "," << na.point.y
                << ")b" << na.on_boundary << "-(" << nb.point.x << "," << nb.point.y << ")b"
                << nb.on_boundary << " leaves:";
      for (const auto& leaf : result.debug.leaves) {
        if (mid.x >= leaf.box.min.x - 1e-9 && mid.x <= leaf.box.max.x + 1e-9
            && mid.y >= leaf.box.min.y - 1e-9 && mid.y <= leaf.box.max.y + 1e-9) {
          std::cout << " [L" << leaf.level << " c" << leaf.classification << " ("
                    << leaf.box.min.x << "," << leaf.box.min.y << ")-(" << leaf.box.max.x << ","
                    << leaf.box.max.y << ")]";
        }
      }
      std::cout << "\n";
    }
  }
  return result.validation.ok ? 0 : 1;
}

} // namespace

int main(int argc, char** argv)
{
  const std::string mode = argc > 1 ? argv[1] : "all";
  int failures = 0;

  if (mode == "star" || mode == "all") {
    quadmesh::DomainGeometry domain;
    quadmesh::PolylineLoop outer{{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true};
    outer.target_cell_size = 2.0;
    domain.outer_loops.push_back(outer);
    quadmesh::PolylineLoop hole = quadmesh::star_loop({2.0, 1.2}, 0.54, 0.24, 5);
    hole.target_cell_size = 0.25;
    domain.inner_loops.push_back({hole, quadmesh::InnerLoopRole::Hole});
    failures += run_case("star_border2.0", domain, true);
  }

  if (mode == "circle" || mode == "all") {
    quadmesh::DomainGeometry domain;
    quadmesh::PolylineLoop outer{{{0.0, 0.0}, {8.0, 0.0}, {8.0, 4.4}, {0.0, 4.4}}, true};
    outer.target_cell_size = 3.0;
    domain.outer_loops.push_back(outer);
    quadmesh::PolylineLoop hole = quadmesh::circle_loop({2.0, 1.2}, 0.42,16);
    hole.target_cell_size = 0.4;
    domain.inner_loops.push_back({hole, quadmesh::InnerLoopRole::Hole});
    failures += run_case("circle_border3.0_seg16", domain, true);
  }

  if (mode == "flower") {
    quadmesh::DomainGeometry domain;
    quadmesh::PolylineLoop loop;
    loop.closed = true;
    const int segments = 256;
    for (int i = 0; i < segments; ++i) {
      const double theta = 2.0 * std::numbers::pi_v<double> * i / segments;
      const double r = 1.0 * (1.0 + 0.35 * std::cos(6 * theta));
      loop.vertices.push_back({r * std::cos(theta), r * std::sin(theta)});
    }
    domain.outer_loops.push_back(loop);
    quadmesh::MeshingConfig config;
    config.refinement.target_cell_size = 0.07;
    failures += run_case("flower", domain, true, config);
  }

  if (mode == "one" && argc > 3) {
    const double border = std::atof(argv[2]);
    const int segments = std::atoi(argv[3]);
    quadmesh::DomainGeometry domain;
    quadmesh::PolylineLoop outer{{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true};
    outer.target_cell_size = border;
    domain.outer_loops.push_back(outer);
    quadmesh::PolylineLoop hole = quadmesh::circle_loop({2.0, 1.2}, 0.42,segments);
    hole.target_cell_size = 0.1;
    domain.inner_loops.push_back({hole, quadmesh::InnerLoopRole::Hole});
    failures += run_case("one", domain, true);
  }

  if (mode == "sweep" || mode == "all") {
    for (const double border : {0.4, 0.8, 1.2, 1.6, 2.0, 2.4, 3.0}) {
      for (const int segments : {8, 12, 16, 24, 32, 48, 64, 96, 128}) {
        quadmesh::DomainGeometry domain;
        quadmesh::PolylineLoop outer{{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true};
        outer.target_cell_size = border;
        domain.outer_loops.push_back(outer);
        quadmesh::PolylineLoop hole = quadmesh::circle_loop({2.0, 1.2}, 0.42,segments);
        hole.target_cell_size = 0.1;
        domain.inner_loops.push_back({hole, quadmesh::InnerLoopRole::Hole});
        failures += run_case(
            "sweep_b" + std::to_string(border) + "_s" + std::to_string(segments), domain);
      }
    }
  }

  std::cout << "failures=" << failures << "\n";
  return failures == 0 ? 0 : 1;
}
