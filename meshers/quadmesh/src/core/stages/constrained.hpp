#pragma once

#include "detail/boundary.hpp"
#include "quadmesh/mesher.hpp"

namespace quadmesh::detail {

GlobalMesh mesh_prescribed_boundary(const DomainGeometry& domain, const MeshingConfig& config,
                                   MesherDebug* debug);

} // namespace quadmesh::detail
