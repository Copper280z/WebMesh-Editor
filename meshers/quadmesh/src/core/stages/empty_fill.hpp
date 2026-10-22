#pragma once

#include "detail/contracts.hpp"
#include "quadmesh/mesher.hpp"

namespace quadmesh::detail {

// Phase 8a: flood-fill empty leaves into inside/outside components by a single
// parity test per component. Writes BoundaryTopology::leaf_class.
void classify_empty_components(const Lattice& lat, BoundaryTopology& topo);

// Phase 8b: mesh empty inside squares with 2-ref templates (per-level
// checkerboard marking + required-side-split fixpoint), and bent empty squares
// as polygons. The classified tree is immutable; extra transition nodes live
// on shared atomic side spans in BoundaryTopology. Odd side-node parities are
// paired globally before finite quality-controlled templates are selected.
void mesh_empty_squares(const Lattice& lat, const GeometryModel& gm, const MeshingConfig& config,
                        BoundaryTopology& topo,
                        MeshBuilder& mb, MesherDebug* debug);

} // namespace quadmesh::detail
