#include "quadmesh/io.hpp"
#include "quadmesh/pipeline.hpp"
#include "quadmesh/quality.hpp"
#include "quadmesh/shapes.hpp"

#include <iostream>

int main() {
  quadmesh::DomainGeometry domain;
  // Coarse cells along the plate border, fine cells around the hole.
  quadmesh::PolylineLoop outer{{{0.0, 0.0}, {8.0, 0.0}, {8.0, 4.4}, {0.0, 4.4}},
                               true};
  outer.target_cell_size = 3.0;
  domain.outer_loops.push_back(outer);
  quadmesh::PolylineLoop hole = quadmesh::circle_loop({2.0, 1.2}, 0.42, 64);
  hole.target_cell_size = 0.1;
  domain.inner_loops.push_back({hole, quadmesh::InnerLoopRole::Hole});

  quadmesh::MeshingConfig config;
  // Import the hole's fine grading only where it reaches the plate boundary;
  // the distant top/right border remains coarse.
  config.refinement.sizing_promotion = quadmesh::SizingPromotionMode::Local;

  const quadmesh::PipelineRunResult result =
      quadmesh::MeshingPipeline{}.run(domain, config);
  quadmesh::write_nastran_bdf("plate_circle.bdf", result.mesh,
                              "quadmesh plate with circular hole");
  quadmesh::write_mesh_ppm("plate_circle.ppm", result.mesh, domain);
  const quadmesh::MeshQualityReport quality =
      quadmesh::mesh_quality_report(result.mesh);

  std::cout << "wrote plate_circle.bdf and plate_circle.ppm\n";
  for (const std::string &issue : result.validation.issues) {
    std::cout << "issue: " << issue << "\n";
  }
  std::cout << "angles=[" << result.validation.min_angle_deg << ", "
            << result.validation.max_angle_deg << "]\n";
  std::cout << "nodes=" << result.mesh.nodes.size()
            << " quads=" << result.mesh.quads.size() << "\n";
  std::cout << "min_jacobian=" << quality.min_jacobian
            << " element=" << quality.min_jacobian_element << "\n";
  std::cout << "min_scaled_jacobian=" << quality.min_scaled_jacobian
            << " element=" << quality.min_scaled_jacobian_element << "\n";
  std::cout << "min_edge_ratio=" << result.validation.min_edge_ratio << "\n";
  std::cout << "validation_ok=" << (result.validation.ok ? "true" : "false")
            << "\n";
  return result.validation.ok ? 0 : 1;
}
