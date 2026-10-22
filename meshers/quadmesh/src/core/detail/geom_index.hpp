#pragma once

#include "detail/chain.hpp"
#include "quadmesh/geometry.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <utility>
#include <vector>

namespace quadmesh::detail {

// ---------------------------------------------------------------------------
// Geometry index: flattened segments with a uniform bucket grid
// ---------------------------------------------------------------------------

struct GeomIndex {
  const std::vector<Chain>* chains = nullptr;
  std::vector<Segment2> segments;
  std::vector<SegRef> refs;

  Point2 grid_min;
  double bucket = 1.0;
  int nx = 1;
  int ny = 1;
  std::vector<std::vector<int>> cells;
  mutable std::vector<int> stamp; // per-segment visit marks for query dedup
  mutable int epoch = 0;

  void build(const std::vector<Chain>& input_chains, const Aabb2& bounds, double bucket_size)
  {
    chains = &input_chains;
    segments.clear();
    refs.clear();
    for (int c = 0; c < static_cast<int>(input_chains.size()); ++c) {
      const Chain& chain = input_chains[c];
      for (std::size_t i = 0; i < chain.segment_count(); ++i) {
        segments.push_back(chain.segment(i));
        refs.push_back({c, static_cast<int>(i)});
      }
    }
    bucket = std::max(bucket_size, 1.0e-12);
    stamp.assign(segments.size(), 0);
    epoch = 0;
    grid_min = bounds.min;
    nx = std::max(1, static_cast<int>(std::ceil(width(bounds) / bucket)) + 1);
    ny = std::max(1, static_cast<int>(std::ceil(height(bounds) / bucket)) + 1);
    cells.assign(static_cast<std::size_t>(nx) * static_cast<std::size_t>(ny), {});
    for (int s = 0; s < static_cast<int>(segments.size()); ++s) {
      const Segment2& seg = segments[s];
      const int x0 = clamp_x(std::min(seg.a.x, seg.b.x));
      const int x1 = clamp_x(std::max(seg.a.x, seg.b.x));
      const int y0 = clamp_y(std::min(seg.a.y, seg.b.y));
      const int y1 = clamp_y(std::max(seg.a.y, seg.b.y));
      for (int y = y0; y <= y1; ++y) {
        for (int x = x0; x <= x1; ++x) {
          const Aabb2 box{{grid_min.x + x * bucket, grid_min.y + y * bucket},
                          {grid_min.x + (x + 1) * bucket, grid_min.y + (y + 1) * bucket}};
          if (segment_intersects_aabb(seg, box)) {
            cells[static_cast<std::size_t>(y) * nx + x].push_back(s);
          }
        }
      }
    }
  }

  int clamp_x(double wx) const
  {
    return std::clamp(static_cast<int>(std::floor((wx - grid_min.x) / bucket)), 0, nx - 1);
  }
  int clamp_y(double wy) const
  {
    return std::clamp(static_cast<int>(std::floor((wy - grid_min.y) / bucket)), 0, ny - 1);
  }

  // NOTE: for_each_near/inside use epoch stamps for dedup and are NOT
  // reentrant: never call one from within the other's callback.
  template <typename Fn>
  void for_each_near(const Aabb2& box, Fn&& fn) const
  {
    const int x0 = clamp_x(box.min.x);
    const int x1 = clamp_x(box.max.x);
    const int y0 = clamp_y(box.min.y);
    const int y1 = clamp_y(box.max.y);
    ++epoch;
    for (int y = y0; y <= y1; ++y) {
      for (int x = x0; x <= x1; ++x) {
        for (int s : cells[static_cast<std::size_t>(y) * nx + x]) {
          if (stamp[static_cast<std::size_t>(s)] != epoch) {
            stamp[static_cast<std::size_t>(s)] = epoch;
            fn(s);
          }
        }
      }
    }
  }

  bool any_segment_intersects(const Aabb2& box) const
  {
    bool hit = false;
    for_each_near(box, [&](int s) {
      if (!hit && segment_intersects_aabb(segments[s], box)) {
        hit = true;
      }
    });
    return hit;
  }

  // Nearest segment within `radius` of `p`; returns (distance, segment index).
  std::pair<double, int> nearest(Point2 p, double radius) const
  {
    const Aabb2 box{{p.x - radius, p.y - radius}, {p.x + radius, p.y + radius}};
    double best = std::numeric_limits<double>::max();
    int best_seg = -1;
    for_each_near(box, [&](int s) {
      const double d = distance_to_segment(p, segments[s]);
      if (d < best) {
        best = d;
        best_seg = s;
      }
    });
    return {best, best_seg};
  }

  // Even-odd inside test against all closed boundary chains, casting a +x
  // ray and visiting only the bucket row it passes through. The half-open
  // (ay > py) != (by > py) rule makes vertices on the ray line count
  // consistently; horizontal segments never straddle and are skipped.
  bool inside(Point2 p) const
  {
    bool in = false;
    ++epoch;
    const int y = clamp_y(p.y);
    const int x0 = clamp_x(p.x);
    for (int x = x0; x < nx; ++x) {
      for (int s : cells[static_cast<std::size_t>(y) * nx + x]) {
        if (stamp[static_cast<std::size_t>(s)] == epoch) {
          continue;
        }
        stamp[static_cast<std::size_t>(s)] = epoch;
        if (!(*chains)[refs[s].chain].counts_for_parity) {
          continue;
        }
        const Point2 a = segments[s].a;
        const Point2 b = segments[s].b;
        if ((a.y > p.y) != (b.y > p.y)) {
          const double xc = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y);
          if (p.x < xc) {
            in = !in;
          }
        }
      }
    }
    return in;
  }
};

} // namespace quadmesh::detail
