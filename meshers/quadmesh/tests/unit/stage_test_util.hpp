#pragma once

// Shared helpers for the per-stage unit tests. These reach into the mesher's
// private detail/ and stages/ headers (compiled against core_inc).

#include "detail/chain.hpp"
#include "detail/contracts.hpp"
#include "stages/repel.hpp"
#include "stages/sizing.hpp"

#include "quadmesh/config.hpp"
#include "quadmesh/geometry.hpp"

#include <cstddef>

namespace qtest {

inline quadmesh::DomainGeometry rect_domain(double w, double h, double target = 0.0,
                                            bool unconstrained = false)
{
  quadmesh::PolylineLoop loop;
  loop.vertices = {{0.0, 0.0}, {w, 0.0}, {w, h}, {0.0, h}};
  loop.closed = true;
  loop.target_cell_size = target;
  loop.sizing_unconstrained = unconstrained;
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back(loop);
  return domain;
}

// Owns the inter-stage state so that Lattice::geom (which points into
// GeometryModel::chains) stays valid for the lifetime of the fixture.
struct StageFixture {
  quadmesh::MeshingConfig config;
  quadmesh::detail::GeometryModel gm;
  quadmesh::detail::Lattice lat;
  quadmesh::detail::Perturbation pert;
  quadmesh::detail::MeshBuilder mb;

  // Mirrors the orchestrator: build chains, seed feature vertices + their nodes
  // (ids 0..F-1), then build the lattice and repel.
  void build(const quadmesh::DomainGeometry& domain)
  {
    using namespace quadmesh;
    using namespace quadmesh::detail;
    gm.chains = build_chains(domain, config.features.feature_angle_deg);
    for (int c = 0; c < static_cast<int>(gm.chains.size()); ++c) {
      for (std::size_t i = 0; i < gm.chains[c].points.size(); ++i) {
        if (gm.chains[c].feature[i]) {
          gm.features.push_back({gm.chains[c].points[i], c, static_cast<int>(i), -1, -1});
          gm.features.back().node = mb.add_node(gm.features.back().point, true);
        }
      }
    }
    lat = build_lattice(gm, bounds_of(domain), config, nullptr);
    mb.tree = &lat.tree;
    pert = repel(lat, config, nullptr);
    mb.perturb = &pert;
  }
};

} // namespace qtest
