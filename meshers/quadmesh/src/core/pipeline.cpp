#include "quadmesh/pipeline.hpp"

namespace quadmesh {

PipelineRunResult MeshingPipeline::run(const DomainGeometry& domain, const MeshingConfig& config) const
{
  PipelineRunResult result;
  result.mesh = build_mesh(domain, config, &result.debug);
  result.validation = validate_mesh(result.mesh, domain, config);
  return result;
}

} // namespace quadmesh
