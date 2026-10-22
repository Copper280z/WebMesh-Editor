#include "quadmesh/mesher.hpp"

#include "quadmesh/geometry.hpp"

#include "detail/chain.hpp"
#include "detail/contracts.hpp"
#include "detail/boundary.hpp"
#include "stages/constrained.hpp"
#include "stages/classify.hpp"
#include "stages/empty_fill.hpp"
#include "stages/face_mesh.hpp"
#include "stages/finalize.hpp"
#include "stages/repel.hpp"
#include "stages/sizing.hpp"
#include "stages/vertex_bends.hpp"

#include <cstdint>
#include <cmath>
#include <stdexcept>
#include <vector>

namespace quadmesh {

using namespace quadmesh::detail;

GlobalMesh build_mesh(const DomainGeometry& domain, const MeshingConfig& config, MesherDebug* debug)
{
  if (!std::isfinite(config.refinement.target_cell_size) || config.refinement.target_cell_size < 0
      || config.refinement.max_level == 0 || config.refinement.max_level > 24
      || !std::isfinite(config.features.feature_angle_deg) || config.features.feature_angle_deg < 0
      || config.features.feature_angle_deg > 180 || !std::isfinite(config.features.chord_tolerance_fraction)
      || config.features.chord_tolerance_fraction < 0 || config.features.chord_tolerance_fraction > 1
      || !std::isfinite(config.tolerances.absolute_distance) || config.tolerances.absolute_distance <= 0
      || !std::isfinite(config.tolerances.relative_distance) || config.tolerances.relative_distance < 0
      || config.smoothing_iterations > 1000)
    throw std::invalid_argument("invalid meshing configuration");
  const auto check_loop = [](const PolylineLoop& loop) {
    if (!std::isfinite(loop.target_cell_size) || loop.target_cell_size < 0)
      throw std::invalid_argument("loop target size must be finite and nonnegative");
    if (!loop.vertex_kinds.empty() && loop.vertex_kinds.size() != loop.vertices.size())
      throw std::invalid_argument("vertex_kinds must have one entry per input vertex");
    for (const auto p : loop.vertices)
      if (!std::isfinite(p.x) || !std::isfinite(p.y))
        throw std::invalid_argument("non-finite boundary coordinate");
  };
  for (const auto& loop : domain.outer_loops) check_loop(loop);
  for (const auto& inner : domain.inner_loops) check_loop(inner.loop);
  if (uses_prescribed_boundary(domain, config)) {
    auto mesh = mesh_prescribed_boundary(domain, config, debug);
    if (config.enable_smoothing) smooth_interior(mesh, config.smoothing_iterations);
    return mesh;
  }
  const auto warn = [&](const char* message) {
    if (debug != nullptr) {
      debug->warnings.emplace_back(message);
    }
  };

  // Input normalization: chains + feature vertices. Feature nodes are created
  // first so they reserve node ids 0..F-1 deterministically.
  GeometryModel gm;
  gm.chains = build_chains(domain, config.features.feature_angle_deg);
  GlobalMesh result;
  if (gm.chains.empty()) {
    warn("no usable input loops");
    return result;
  }

  MeshBuilder mb;
  // for chain in chains
  for (int c = 0; c < static_cast<int>(gm.chains.size()); ++c) {
    // for point in chain
    for (std::size_t i = 0; i < gm.chains[c].points.size(); ++i) {
      if (gm.chains[c].feature[i]) {
        gm.features.push_back({gm.chains[c].points[i], c, static_cast<int>(i), -1, -1});
        gm.features.back().node = mb.add_node(gm.features.back().point, true);
      }
    }
  }

  // Phases 1-2: per-chain band levels + strongly balanced quadtree (fixpoint).
  const Aabb2 bounds = bounds_of(domain);
  Lattice lat = build_lattice(gm, bounds, config, debug);
  if (debug != nullptr) {
    debug->boundary_level = lat.max_chain_level();
  }
  mb.tree = &lat.tree;

  // Phase 2 (paper 2.2): corner repelling.
  Perturbation pert = repel(lat, config, debug);
  mb.perturb = &pert;

  // Phase 4: side crossings + leaf classification. Phase 5: vertex bends.
  BoundaryTopology topo;
  compute_side_crossings(lat, gm, topo, mb, config);
  classify_leaves(lat, gm, topo, mb, debug);
  build_vertex_bends(lat, gm, config, topo, mb, debug);

  // Phase 8: empty templates must settle before cut faces are emitted. The
  // stage pre-registers cut-side mids and records any coarse/fine side split
  // back into BoundaryTopology, so cut paths consume the final shared edge
  // topology below.
  classify_empty_components(lat, topo);
  mesh_empty_squares(lat, gm, config, topo, mb, debug);

  // Phases 6-7: cut and vertex squares — faces and midpoint subdivision.
  std::vector<std::int32_t> cut_leaves;
  lat.tree.for_each_leaf([&](std::int32_t i) {
    const LeafClass cls = topo.leaf_class[i];
    if (cls == LeafClass::Cut || cls == LeafClass::Vertex) {
      cut_leaves.push_back(i);
    }
  });
  for (const std::int32_t leaf : cut_leaves) {
    const std::vector<PathEntry> path = build_path(lat, topo, mb, leaf);
    const std::vector<Face> faces = build_faces(lat, gm, topo, mb, config, debug, leaf, path);
    for (const Face& face : faces) {
      if (lat.geom.inside(face_sample(mb, face))) {
        subdivide_face(mb, face);
      }
    }
  }

  if (debug != nullptr) {
    lat.tree.for_each_leaf([&](std::int32_t i) {
      MesherDebug::Leaf leaf;
      leaf.box = lat.tree.box(lat.tree.cells[i]);
      leaf.level = lat.tree.cells[i].level;
      switch (topo.leaf_class[i]) {
      case LeafClass::EmptyInside: leaf.classification = 1; break;
      case LeafClass::Cut: leaf.classification = 2; break;
      case LeafClass::Vertex: leaf.classification = 3; break;
      default: leaf.classification = 0; break;
      }
      debug->leaves.push_back(leaf);
    });
  }

  auto mesh = finalize(mb);
  attach_boundary_sources(mesh, domain);
  if (config.enable_smoothing) smooth_interior(mesh, config.smoothing_iterations);
  return mesh;
}

} // namespace quadmesh
