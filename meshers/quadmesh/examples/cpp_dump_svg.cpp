#include "quadmesh/io.hpp"
#include "quadmesh/pipeline.hpp"

#include <iostream>

int main()
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back({{{0.0, 0.0}, {2.0, 0.0}, {2.0, 1.0}, {0.8, 1.0}, {0.8, 1.6}, {0.0, 1.6}}, true});

  quadmesh::MeshingConfig config;
  config.refinement.max_level = 3;
  const quadmesh::PipelineRunResult result = quadmesh::MeshingPipeline{}.run(domain, config);

  quadmesh::SvgStyle style;
  style.size = 720.0;
  style.margin = 20.0;
  style.loop_stroke = 3.0;
  quadmesh::write_mesh_svg("mesh.svg", result.mesh, domain, style);

  std::cout << "wrote mesh.svg with " << result.mesh.quads.size() << " quads\n";
  return result.validation.ok ? 0 : 1;
}
