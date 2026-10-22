#include "quadmesh/pipeline.hpp"

#include <iostream>

int main()
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back({{{0.0, 0.0}, {1.0, 0.0}, {1.0, 1.0}, {0.0, 1.0}}, true});

  quadmesh::MeshingConfig config;
  config.refinement.target_cell_size = 0.25;

  const quadmesh::PipelineRunResult result = quadmesh::MeshingPipeline{}.run(domain, config);
  std::cout << "nodes=" << result.mesh.nodes.size() << "\n";
  std::cout << "quads=" << result.mesh.quads.size() << "\n";
  std::cout << "validation_ok=" << (result.validation.ok ? "true" : "false") << "\n";
  return result.validation.ok ? 0 : 1;
}
