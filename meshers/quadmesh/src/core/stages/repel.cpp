#include "stages/repel.hpp"

#include "quadmesh/geometry.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <unordered_map>
#include <vector>

namespace quadmesh::detail {

Perturbation repel(const Lattice& lat, const MeshingConfig& config, MesherDebug* debug)
{
  Perturbation out;
  const Tree& tree = lat.tree;
  const GeomIndex& geom = lat.geom;
  auto& moved_gp = out.moved_gp;

  // Repels a single grid point off its nearest segment: prefers sliding along
  // the corner's own grid line to a clear gap, else moves along the geometry
  // normal. Bounded to 0.45*s so the corner stays inside its lattice cell.
  const auto repel_point = [&](Point2 p, double d, double s, int nearest_seg) -> Point2 {
    const Segment2& seg = geom.segments[nearest_seg];
    const Vec2 dir = seg.b - seg.a;
    const bool move_vertical = std::abs(dir.x) >= std::abs(dir.y);

    // Crossings of the corner's grid line with nearby geometry, as signed
    // offsets from p along the movement axis.
    std::vector<double> hits;
    const double range = 0.49 * s + d;
    const Aabb2 query{{p.x - range, p.y - range}, {p.x + range, p.y + range}};
    const Segment2 axis = move_vertical
        ? Segment2{{p.x, p.y - range}, {p.x, p.y + range}}
        : Segment2{{p.x - range, p.y}, {p.x + range, p.y}};
    geom.for_each_near(query, [&](int si) {
      const auto hit = intersect_segments(axis, geom.segments[si], 1.0e-12 * s);
      if (hit.has_value()) {
        const double offset = move_vertical ? hit->point.y - p.y : hit->point.x - p.x;
        hits.push_back(offset);
      }
    });

    if (!hits.empty()) {
      std::sort(hits.begin(), hits.end());
      // Merge near-duplicate crossings (shared polyline joints).
      hits.erase(std::unique(hits.begin(), hits.end(),
                             [&](double a, double b) { return std::abs(a - b) < 1.0e-9 * s; }),
                 hits.end());
      double best = std::numeric_limits<double>::max();
      double nearest_offset = 0.0;
      for (const double h : hits) {
        if (std::abs(h) < std::abs(best)) {
          best = h;
          nearest_offset = h;
        }
      }
      if (std::abs(best) <= d + 1.0e-12) {
        double side = (0.0 - nearest_offset) >= 0.0 ? 1.0 : -1.0;
        if (std::abs(nearest_offset) < 1.0e-12 * s) {
          side = 1.0;
        }
        double target = nearest_offset + side * d;
        // Trapped between two crossings: place midway.
        for (const double other : hits) {
          if (other == nearest_offset) {
            continue;
          }
          const bool same_side = (other - nearest_offset) * side > 0.0;
          if (same_side && std::abs(other - nearest_offset) < 2.0 * d) {
            target = (nearest_offset + other) / 2.0;
            break;
          }
        }
        target = std::clamp(target, -0.45 * s, 0.45 * s);
        return move_vertical ? Point2{p.x, p.y + target} : Point2{p.x + target, p.y};
      }
    }

    // Fall back to geometry-normal repelling (e.g. near segment endpoints).
    const Point2 closest = closest_point_on_segment(seg, p);
    Vec2 away = p - closest;
    const double dist = length(away);
    if (dist < 1.0e-12 * s) {
      away = {-dir.y, dir.x};
      const double len = length(away);
      away = away * (len > 0.0 ? 1.0 / len : 0.0);
    } else {
      away = away * (1.0 / dist);
    }
    Point2 moved = closest + away * d;
    const Vec2 displacement = moved - p;
    const double dl = length(displacement);
    if (dl > 0.45 * s) {
      moved = p + displacement * (0.45 * s / dl);
    }
    return moved;
  };

  // Smallest adjacent leaf size per grid point.
  std::unordered_map<std::uint64_t, double> min_size;
  tree.for_each_leaf([&](std::int32_t i) {
    const Cell& cell = tree.cells[i];
    const double s = tree.size_at(cell.level);
    for (int corner = 0; corner < 4; ++corner) {
      const auto [gx, gy] = tree.corner_gp(cell, corner);
      auto [it, inserted] = min_size.try_emplace(gp_key(gx, gy), s);
      if (!inserted) {
        it->second = std::min(it->second, s);
      }
    }
  });

  for (const auto& [key, s] : min_size) {
    const std::uint32_t gx = static_cast<std::uint32_t>(key >> 21);
    const std::uint32_t gy = static_cast<std::uint32_t>(key & ((1u << 21) - 1u));
    const Point2 p = tree.gp_position(gx, gy);
    const double d = s * config.repelling.distance_fraction;
    const auto [dist, seg_index] = geom.nearest(p, d * 1.0001);
    if (seg_index < 0 || dist >= d) {
      continue;
    }
    const Point2 moved = repel_point(p, d, s, seg_index);
    moved_gp[key] = moved;
    if (debug != nullptr) {
      debug->corner_moves.push_back({p, moved});
    }
  }
  return out;
}

} // namespace quadmesh::detail
