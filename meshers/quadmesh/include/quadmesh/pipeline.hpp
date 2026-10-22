#pragma once

#include "quadmesh/config.hpp"
#include "quadmesh/mesh.hpp"
#include "quadmesh/mesher.hpp"
#include "quadmesh/validation.hpp"

namespace quadmesh {

struct PipelineRunResult {
  GlobalMesh mesh;
  ValidationReport validation;
  MesherDebug debug;
};

class MeshingPipeline {
public:
  PipelineRunResult run(const DomainGeometry& domain, const MeshingConfig& config = {}) const;
};

} // namespace quadmesh
