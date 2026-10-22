#include "stages/vertex_bends.hpp"

#include "detail/types.hpp" // pi
#include "quadmesh/geometry.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

namespace quadmesh::detail {

void build_vertex_bends(const Lattice& lat, const GeometryModel& gm, const MeshingConfig& config,
                        BoundaryTopology& topo, MeshBuilder& mb, MesherDebug* debug)
{
  const Tree& tree = lat.tree;
  const auto& chains = gm.chains;
  const auto& features = gm.features;
  auto& leaf_class = topo.leaf_class;
  auto& leaf_vertex = topo.leaf_vertex;
  auto& side_crossings = topo.side_crossings;
  auto& side_bend = topo.side_bend;
  auto& vertex_corner_rays = topo.vertex_corner_rays;
  const auto side_key = [&](const Cell& cell, int side) { return tree.side_key(cell, side); };
  const auto gp_pos = [&](std::uint32_t gx, std::uint32_t gy) { return mb.gp_pos(gx, gy); };
  const auto add_node = [&](Point2 p, bool on_boundary) { return mb.add_node(p, on_boundary); };
  const auto gp_node_id = [&](std::uint32_t gx, std::uint32_t gy) { return mb.gp_node_id(gx, gy); };
  const auto warn = [&](std::string message) {
    if (debug != nullptr) {
      debug->warnings.push_back(std::move(message));
    }
  };

  // The assigned vertex square, plus every square whose boundary path runs
  // through the vertex (a crossing snapped onto it), gets the vertex
  // treatment: side midpoints pulled toward the vertex.
  for (int f = 0; f < static_cast<int>(features.size()); ++f) {
    if (features[f].leaf >= 0) {
      leaf_vertex.emplace(features[f].leaf, f);
    }
  }
  tree.for_each_leaf([&](std::int32_t i) {
    const Cell& cell = tree.cells[i];
    const auto class_it = leaf_class.find(i);
    if (class_it == leaf_class.end()
        || (class_it->second != LeafClass::Cut && class_it->second != LeafClass::Vertex)) {
      return;
    }
    for (int side = 0; side < 4; ++side) {
      const auto it = side_crossings.find(side_key(cell, side));
      if (it == side_crossings.end()) {
        continue;
      }
      for (const Crossing& crossing : it->second) {
        for (int f = 0; f < static_cast<int>(features.size()); ++f) {
          if (features[f].node == crossing.node) {
            leaf_vertex.emplace(i, f);
          }
        }
      }
    }
  });

  // Pull side midpoints toward the vertex, but only into angular wedges at
  // the vertex that are wide enough to need splitting; pulling into a
  // narrow wedge would create sliver elements instead of removing them.
  constexpr double wedge_split_deg = 120.0;
  constexpr double gap_margin_deg = 22.0;
  constexpr double separation_deg = 40.0;
  for (const auto& [leaf, f] : leaf_vertex) {
    const FeatureVertex& fv = features[f];
    const Cell& cell = tree.cells[leaf];
    const double s = tree.size_at(cell.level);

    // Incident directions at the vertex within this square: its geometry
    // rays that point into the square, and the side directions when the
    // vertex lies on the square's boundary path.
    std::vector<double> dirs;
    const auto try_dir = [&](Vec2 d) {
      const double len = length(d);
      if (len <= 0.0) {
        return;
      }
      d = d * (1.0 / len);
      if (point_in_deformed(mb, leaf, fv.point + d * (0.05 * s))) {
        dirs.push_back(std::atan2(d.y, d.x));
      }
    };
    const Chain& chain = chains[fv.chain];
    const int n = static_cast<int>(chain.points.size());
    if (chain.closed || fv.index + 1 < n) {
      try_dir(chain.points[static_cast<std::size_t>((fv.index + 1) % n)] - fv.point);
    }
    if (chain.closed || fv.index > 0) {
      try_dir(chain.points[static_cast<std::size_t>((fv.index + n - 1) % n)] - fv.point);
    }
    for (int side = 0; side < 4; ++side) {
      const auto it = side_crossings.find(side_key(cell, side));
      if (it == side_crossings.end()) {
        continue;
      }
      bool vertex_on_side = false;
      for (const Crossing& crossing : it->second) {
        vertex_on_side = vertex_on_side || crossing.node == fv.node;
      }
      if (!vertex_on_side) {
        continue;
      }
      const auto [ax, ay] = tree.corner_gp(cell, side_corner_a(side));
      const auto [bx, by] = tree.corner_gp(cell, side_corner_b(side));
      const Vec2 da = gp_pos(ax, ay) - fv.point;
      const Vec2 db = gp_pos(bx, by) - fv.point;
      dirs.push_back(std::atan2(da.y, da.x));
      dirs.push_back(std::atan2(db.y, db.x));
    }

    // Candidate bends: uncrossed, not-yet-bent sides.
    struct Candidate {
      std::pair<std::uint64_t, std::uint64_t> key;
      Point2 position;
      double angle = 0.0;
    };
    std::vector<Candidate> candidates;
    for (int side = 0; side < 4; ++side) {
      const auto key = side_key(cell, side);
      const auto it = side_crossings.find(key);
      if ((it != side_crossings.end() && !it->second.empty()) || side_bend.count(key) > 0) {
        continue;
      }
      const auto [ax, ay] = tree.corner_gp(cell, side_corner_a(side));
      const auto [bx, by] = tree.corner_gp(cell, side_corner_b(side));
      const Point2 pa = gp_pos(ax, ay);
      const Point2 pb = gp_pos(bx, by);
      const Point2 mid{(pa.x + pb.x) / 2.0, (pa.y + pb.y) / 2.0};
      Vec2 toward = fv.point - mid;
      const double dist = length(toward);
      const double pull = std::min(config.repelling.vertex_pull_fraction * s, dist / 2.0);
      Point2 bent = mid;
      if (dist > 1.0e-12 * s) {
        bent = mid + toward * (pull / dist);
      }
      Candidate candidate;
      candidate.key = key;
      candidate.position = bent;
      const Vec2 dm = bent - fv.point;
      candidate.angle = std::atan2(dm.y, dm.x);
      candidates.push_back(candidate);
    }
    if (candidates.empty()) {
      continue;
    }
    if (dirs.empty()) {
      // Isolated vertex: split all four quadrants (paper figure 6a).
      for (const Candidate& candidate : candidates) {
        side_bend[candidate.key] = add_node(candidate.position, false);
      }
      continue;
    }

    std::sort(dirs.begin(), dirs.end());
    const auto norm = [](double a) {
      while (a < 0.0) {
        a += 2.0 * pi;
      }
      while (a >= 2.0 * pi) {
        a -= 2.0 * pi;
      }
      return a;
    };
    for (std::size_t i = 0; i < dirs.size(); ++i) {
      const double start = dirs[i];
      const double gap = i + 1 < dirs.size() ? dirs[i + 1] - start : dirs.front() + 2.0 * pi - start;
      if (gap <= wedge_split_deg * pi / 180.0) {
        continue;
      }
      const double bisector = start + gap / 2.0;
      if (!point_in_deformed(
              mb, leaf, fv.point + Vec2{std::cos(bisector), std::sin(bisector)} * (0.05 * s))) {
        continue; // wedge opens outside this square
      }
      // Greedily place bends inside the wedge, keeping angular separation.
      std::vector<Candidate> in_gap;
      for (const Candidate& candidate : candidates) {
        if (side_bend.count(candidate.key) > 0) {
          continue;
        }
        const double rel = norm(candidate.angle - start);
        if (rel > gap_margin_deg * pi / 180.0 && rel < gap - gap_margin_deg * pi / 180.0) {
          Candidate relative = candidate;
          relative.angle = rel;
          in_gap.push_back(relative);
        }
      }
      std::sort(in_gap.begin(), in_gap.end(),
                [](const Candidate& a, const Candidate& b) { return a.angle < b.angle; });
      std::vector<double> placed{0.0, gap};
      for (const Candidate& candidate : in_gap) {
        double nearest = std::numeric_limits<double>::max();
        for (const double p : placed) {
          nearest = std::min(nearest, std::abs(candidate.angle - p));
        }
        if (nearest >= separation_deg * pi / 180.0) {
          side_bend[candidate.key] = add_node(candidate.position, false);
          placed.push_back(candidate.angle);
        }
      }
      if (placed.size() == 2) {
        // No side midpoint usable inside this wedge (both uncrossed sides
        // can lie on the other side of the curve). Split the wedge with a
        // ray to a square corner instead: corners are shared nodes already
        // on the boundary path, so no cross-square coordination is needed.
        int best_corner = -1;
        double best_off = std::numeric_limits<double>::max();
        for (int corner = 0; corner < 4; ++corner) {
          const auto [gx, gy] = tree.corner_gp(cell, corner);
          const Vec2 d = gp_pos(gx, gy) - fv.point;
          if (length(d) <= 0.0) {
            continue;
          }
          const double rel = norm(std::atan2(d.y, d.x) - start);
          if (rel <= gap_margin_deg * pi / 180.0 || rel >= gap - gap_margin_deg * pi / 180.0) {
            continue;
          }
          const double off = std::abs(rel - gap / 2.0);
          if (off < best_off) {
            best_off = off;
            best_corner = corner;
          }
        }
        if (best_corner >= 0) {
          const auto [gx, gy] = tree.corner_gp(cell, best_corner);
          vertex_corner_rays[leaf].push_back(gp_node_id(gx, gy));
        } else if (gap > pi) {
          warn("reflex wedge of " + std::to_string(gap * 180.0 / pi) + " deg at ("
               + std::to_string(fv.point.x) + ", " + std::to_string(fv.point.y)
               + ") could not be split");
        }
      }
    }
  }
}

} // namespace quadmesh::detail
