#pragma once

#include "detail/contracts.hpp"
#include "quadmesh/config.hpp"
#include "quadmesh/mesher.hpp"

namespace quadmesh::detail {

// Phase 2 (paper 2.2): grid corners within delta = s/4 of geometry move
// (grid-aligned) to exactly delta clearance. Returns the repelled positions.
Perturbation repel(const Lattice& lat, const MeshingConfig& config, MesherDebug* debug);

} // namespace quadmesh::detail
