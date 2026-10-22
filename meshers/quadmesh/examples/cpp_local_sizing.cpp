#include "quadmesh/io.hpp"
#include "quadmesh/pipeline.hpp"

#include <iomanip>
#include <iostream>
#include <string>

namespace {

quadmesh::PolylineLoop rectangle()
{
  return {{{0.0, 0.0}, {16.0, 0.0}, {16.0, 8.0}, {0.0, 8.0}}, true};
}

bool print_issues(const std::string& label, const quadmesh::PipelineRunResult& result)
{
  if (result.validation.ok) {
    return false;
  }
  std::cerr << label << " mesh failed validation:\n";
  for (const std::string& issue : result.validation.issues) {
    std::cerr << "  " << issue << '\n';
  }
  return true;
}

} // namespace

int main()
{
  quadmesh::PolylineLoop local = rectangle();
  local.target_cell_size = 4.0;
  local.sizing_samples = {
      {0.0, 0.125}, {0.05, 0.125}, {0.1, 4.0},
      {0.9, 4.0}, {0.95, 0.125}, {1.0, 0.125}};

  quadmesh::PolylineLoop uniform = rectangle();
  uniform.target_cell_size = 0.125;

  quadmesh::DomainGeometry local_domain;
  local_domain.outer_loops.push_back(local);
  quadmesh::DomainGeometry uniform_domain;
  uniform_domain.outer_loops.push_back(uniform);

  quadmesh::MeshingConfig config;
  config.features.chord_tolerance_fraction = 0.0;
  const auto local_result = quadmesh::MeshingPipeline{}.run(local_domain, config);
  const auto uniform_result = quadmesh::MeshingPipeline{}.run(uniform_domain, config);
  if (print_issues("locally sized", local_result)
      || print_issues("uniform fine", uniform_result)) {
    return 1;
  }

  quadmesh::write_nastran_bdf("local_sizing.bdf", local_result.mesh,
                              "quadmesh locally sized rectangle");
  quadmesh::write_mesh_ppm("local_sizing.ppm", local_result.mesh, local_domain);
  quadmesh::write_nastran_bdf("local_sizing_uniform_fine.bdf", uniform_result.mesh,
                              "quadmesh uniform fine rectangle");
  quadmesh::write_mesh_ppm("local_sizing_uniform_fine.ppm", uniform_result.mesh,
                           uniform_domain);

  const double reduction = 100.0
      * (1.0 - static_cast<double>(local_result.mesh.quads.size())
                   / static_cast<double>(uniform_result.mesh.quads.size()));
  std::cout << "locally sized quads: " << local_result.mesh.quads.size() << '\n'
            << "uniform fine quads: " << uniform_result.mesh.quads.size() << '\n'
            << "element-count reduction: " << std::fixed << std::setprecision(1)
            << reduction << "%\n"
            << std::setprecision(3)
            << "local quality: min angle " << local_result.validation.min_angle_deg
            << " deg, scaled Jacobian " << local_result.validation.min_scaled_jacobian
            << ", edge ratio " << local_result.validation.min_edge_ratio << '\n'
            << "wrote local_sizing.{bdf,ppm}\n"
            << "wrote local_sizing_uniform_fine.{bdf,ppm}\n";
}
