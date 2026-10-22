#include "quadmesh/io.hpp"
#include "quadmesh/pipeline.hpp"

#include <iostream>

int main()
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back({{{0.0, 0.0}, {2.0, 0.0}, {2.0, 0.9}, {1.25, 0.9}, {1.25, 1.55}, {0.0, 1.55}}, true});

  quadmesh::MeshingConfig config;
  config.refinement.target_cell_size = 0.12;

  const quadmesh::PipelineRunResult result = quadmesh::MeshingPipeline{}.run(domain, config);
  quadmesh::write_nastran_bdf("quadmesh_example.bdf", result.mesh);

  quadmesh::PpmStyle style;
  style.width = 900;
  style.margin = 32.0;
  style.mark_boundary_nodes = true;
  quadmesh::write_mesh_ppm("quadmesh_example.ppm", result.mesh, domain, style);

  std::cout << "wrote quadmesh_example.bdf and quadmesh_example.ppm\n";
  std::cout << "nodes=" << result.mesh.nodes.size() << " quads=" << result.mesh.quads.size() << "\n";
  return result.validation.ok ? 0 : 1;
}
