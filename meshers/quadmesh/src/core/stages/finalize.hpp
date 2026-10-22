#pragma once

#include "detail/contracts.hpp"
#include "quadmesh/mesh.hpp"

namespace quadmesh::detail {

// Compaction: keep only nodes referenced by quads, remap to dense NodeIds, and
// orient each quad CCW. Produces the public GlobalMesh.
GlobalMesh finalize(const MeshBuilder& mb);

} // namespace quadmesh::detail
