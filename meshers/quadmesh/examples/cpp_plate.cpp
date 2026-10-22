#include "quadmesh/io.hpp"
#include "quadmesh/pipeline.hpp"
#include "quadmesh/quality.hpp"

#include <iostream>

int main() {
  quadmesh::DomainGeometry domain;
  // Plain rectangular plate, no hole: coarse cells along the border.
  quadmesh::PolylineLoop outer{{{0.0, 0.0}, {8.0, 0.0}, {8.0, 4.4}, {0.0, 4.4}},
                               true};
  outer.target_cell_size = 3.0;
  domain.outer_loops.push_back(outer);

  quadmesh::MeshingConfig config;

  const quadmesh::PipelineRunResult result =
      quadmesh::MeshingPipeline{}.run(domain, config);
  quadmesh::write_nastran_bdf("plate.bdf", result.mesh, "quadmesh plate");
  quadmesh::write_mesh_ppm("plate.ppm", result.mesh, domain);
  const quadmesh::MeshQualityReport quality =
      quadmesh::mesh_quality_report(result.mesh);

  std::cout << "wrote plate.bdf and plate.ppm\n";
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
