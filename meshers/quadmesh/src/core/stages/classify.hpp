#pragma once

#include "detail/contracts.hpp"
#include "quadmesh/config.hpp"
#include "quadmesh/mesher.hpp"

namespace quadmesh::detail {

// Phase 4a: per-side boundary crossings (canonical orientation), with vertex
// snapping. Writes BoundaryTopology::side_crossings and creates crossing nodes.
void compute_side_crossings(const Lattice& lat, const GeometryModel& gm, BoundaryTopology& topo,
                            MeshBuilder& mb, const MeshingConfig& config);

// Phase 4b: classify each leaf (Vertex / Cut / Unset) and resolve each feature
// vertex's containing leaf. Mutates GeometryModel::features[].leaf.
void classify_leaves(const Lattice& lat, GeometryModel& gm, BoundaryTopology& topo, MeshBuilder& mb,
                     MesherDebug* debug);

} // namespace quadmesh::detail
