// Meshes a gallery of stress-test domains and writes one SVG per case
// (gallery_<name>.svg, mesh in blue-grey, input geometry in red) along with
// a quality summary on stdout.
#include "quadmesh/io.hpp"
#include "quadmesh/pipeline.hpp"
#include "quadmesh/shapes.hpp"

#include <chrono>
#include <iostream>
#include <string>

namespace {

bool run_case(const std::string &name, const quadmesh::DomainGeometry &domain, double target) {
  quadmesh::MeshingConfig config;
  config.refinement.target_cell_size = target;
  const auto start = std::chrono::steady_clock::now();
  const quadmesh::PipelineRunResult result = quadmesh::MeshingPipeline{}.run(domain, config);
  const auto elapsed =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start);

  std::cout << name << ": ok=" << (result.validation.ok ? "true" : "false")
            << " quads=" << result.mesh.quads.size() << " angles=["
            << result.validation.min_angle_deg << ", " << result.validation.max_angle_deg
            << "] min_scaled_jacobian=" << result.validation.min_scaled_jacobian
            << " min_edge_ratio=" << result.validation.min_edge_ratio << " (" << elapsed.count()
            << " ms)\n";
  for (const std::string &issue : result.validation.issues) {
    std::cout << "  issue: " << issue << "\n";
  }
  for (const std::string &warning : result.debug.warnings) {
    std::cout << "  warn: " << warning << "\n";
  }
  quadmesh::write_mesh_svg("gallery_" + name + ".svg", result.mesh, domain);
  return result.validation.ok;
}

} // namespace

int main() {
  bool ok = true;

  {
    // Coarse 12-gon hole: every joint is a 30-degree feature vertex.
    quadmesh::DomainGeometry domain;
    domain.outer_loops.push_back({{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true});
    domain.inner_loops.push_back({quadmesh::circle_loop({2.0, 1.2}, 0.42, 12), quadmesh::InnerLoopRole::Hole});
    ok = run_case("coarse12gon", domain, 0.16) && ok;
  }
  {
    // Smooth flower outline as the outer boundary.
    quadmesh::DomainGeometry domain;
    domain.outer_loops.push_back(quadmesh::flower_loop({0.0, 0.0}, 1.0, 6, 256));
    ok = run_case("flower", domain, 0.07) && ok;
  }
  {
    // Sharp isosceles triangle (paper figure 8).
    quadmesh::DomainGeometry domain;
    domain.outer_loops.push_back({{{0.0, 0.0}, {0.4, 0.0}, {0.2, 2.0}}, true});
    ok = run_case("needle", domain, 0.1) && ok;
  }
  {
    // Star-shaped hole with ten sharp corners.
    quadmesh::DomainGeometry domain;
    domain.outer_loops.push_back({{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true});
    domain.inner_loops.push_back({quadmesh::star_loop({2.0, 1.2}, 0.54, 0.24), quadmesh::InnerLoopRole::Hole});
    ok = run_case("star", domain, 0.16) && ok;
  }
  {
    // High-resolution circle: 2048 input segments.
    quadmesh::DomainGeometry domain;
    domain.outer_loops.push_back(quadmesh::circle_loop({0.0, 0.0}, 1.0, 2048));
    ok = run_case("hires", domain, 0.02) && ok;
  }
  {
    // Five staggered holes.
    quadmesh::DomainGeometry domain;
    domain.outer_loops.push_back({{{0.0, 0.0}, {5.0, 0.0}, {5.0, 3.0}, {0.0, 3.0}}, true});
    for (int i = 0; i < 5; ++i) {
      domain.inner_loops.push_back(
          {quadmesh::circle_loop({0.8 + i * 0.85, 1.5 - ((i % 2) ? 0.5 : -0.5)}, 0.3, 40, 0.3 * i),
           quadmesh::InnerLoopRole::Hole});
    }
    ok = run_case("fiveholes", domain, 0.12) && ok;
  }
  {
    // Per-loop sizing: coarse plate border, fine hole.
    quadmesh::DomainGeometry domain;
    quadmesh::PolylineLoop outer{{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true};
    outer.target_cell_size = 0.5;
    domain.outer_loops.push_back(outer);
    quadmesh::PolylineLoop hole = quadmesh::circle_loop({2.0, 1.2}, 0.42, 64);
    hole.target_cell_size = 0.06;
    domain.inner_loops.push_back({hole, quadmesh::InnerLoopRole::Hole});
    ok = run_case("perloop", domain, 0.0) && ok;
  }
  {
    // Embedded mesh-control loop: conforming on both sides, no hole.
    quadmesh::DomainGeometry domain;
    domain.outer_loops.push_back({{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true});
    domain.inner_loops.push_back(
        {quadmesh::circle_loop({2.0, 1.2}, 0.5, 48), quadmesh::InnerLoopRole::MeshControlFeature});
    ok = run_case("control_loop", domain, 0.2) && ok;
  }

  std::cout << (ok ? "all cases valid" : "SOME CASES FAILED") << "\n";
  return ok ? 0 : 1;
}
