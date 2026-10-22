#pragma once

#include "detail/contracts.hpp"
#include "quadmesh/config.hpp"
#include "quadmesh/geometry.hpp"
#include "quadmesh/mesher.hpp"

namespace quadmesh::detail {

// Phases 1-2: choose per-chain band levels and the root frame, then build the
// strongly balanced quadtree, settling separation / origin shift / tree build /
// band uniformity or local band promotion to a joint fixpoint. `bounds` must be
// bounds_of(domain) (the root frame is sized and centered from it). Returns the
// Lattice; its GeomIndex points into gm.chains, which the caller must keep alive
// for the whole run.
Lattice build_lattice(const GeometryModel& gm, const Aabb2& bounds, const MeshingConfig& config,
                      MesherDebug* debug);

} // namespace quadmesh::detail
