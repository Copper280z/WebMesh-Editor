#pragma once

#include "detail/contracts.hpp"
#include "quadmesh/config.hpp"
#include "quadmesh/mesher.hpp"

namespace quadmesh::detail {

// Phase 5 (paper 2.3.1): vertex-square treatment. Pulls uncrossed side
// midpoints toward each feature vertex inside wide angular wedges, falling back
// to corner rays. Writes side_bend, vertex_corner_rays, leaf_vertex and the
// pulled-midpoint nodes.
void build_vertex_bends(const Lattice& lat, const GeometryModel& gm, const MeshingConfig& config,
                        BoundaryTopology& topo, MeshBuilder& mb, MesherDebug* debug);

} // namespace quadmesh::detail
