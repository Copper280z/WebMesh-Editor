#pragma once

#include "detail/contracts.hpp"
#include "detail/types.hpp"
#include "quadmesh/mesher.hpp"

#include <vector>

namespace quadmesh::detail {

// Phase 6: boundary walk of a cut/vertex/bent square (side crossings + bends,
// with degenerate-node collapse).
std::vector<PathEntry> build_path(const Lattice& lat, const BoundaryTopology& topo, MeshBuilder& mb,
                                  std::int32_t leaf);

// Phase 6: local planar graph + rotation-system face walk; returns kept faces.
std::vector<Face> build_faces(const Lattice& lat, const GeometryModel& gm,
                              const BoundaryTopology& topo, MeshBuilder& mb, const MeshingConfig& config,
                              MesherDebug* debug,
                              std::int32_t leaf, const std::vector<PathEntry>& path);

// Interior sample point of a face for the inside-domain test.
Point2 face_sample(const MeshBuilder& mb, const Face& face);

// Phase 7: midpoint subdivision of a face with pattern-search center placement.
void subdivide_face(MeshBuilder& mb, const Face& face);

} // namespace quadmesh::detail
