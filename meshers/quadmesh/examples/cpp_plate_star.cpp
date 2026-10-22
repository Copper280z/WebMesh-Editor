#include "quadmesh/io.hpp"
#include "quadmesh/pipeline.hpp"
#include "quadmesh/quality.hpp"
#include "quadmesh/shapes.hpp"

#include <iostream>

int main() {
  quadmesh::DomainGeometry domain;
  // Coarse cells along the plate border, fine cells around the star.
  quadmesh::PolylineLoop outer{{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}},
                               true};
  outer.target_cell_size = 2.0;
  domain.outer_loops.push_back(outer);
  quadmesh::PolylineLoop hole = quadmesh::star_loop({2.0, 1.2}, 0.54, 0.24, 5);
  hole.target_cell_size = 0.25;
  domain.inner_loops.push_back({hole, quadmesh::InnerLoopRole::Hole});

  quadmesh::MeshingConfig config;

  const quadmesh::PipelineRunResult result =
      quadmesh::MeshingPipeline{}.run(domain, config);
  quadmesh::write_nastran_bdf("plate_star.bdf", result.mesh,
                              "quadmesh plate with star hole");
  quadmesh::write_mesh_ppm("plate_star.ppm", result.mesh, domain);
  const quadmesh::MeshQualityReport quality =
      quadmesh::mesh_quality_report(result.mesh);

  std::cout << "wrote plate_star.bdf and plate_star.ppm\n";
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
  std::cout << "validation_ok=" << (result.validation.ok ? "true" : "false")
            << "\n";
  return result.validation.ok ? 0 : 1;
}
