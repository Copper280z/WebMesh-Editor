#pragma once

#include "quadmesh/geometry.hpp"

#include <cmath>
#include <cstddef>
#include <vector>

namespace quadmesh::detail {

// ---------------------------------------------------------------------------
// Input chains
// ---------------------------------------------------------------------------

struct Chain {
  std::vector<Point2> points; // closed: implicit wrap, no duplicated endpoint
  std::vector<bool> feature;  // per point: sharp feature vertex
  bool closed = true;
  bool counts_for_parity = true; // closed loops bound the domain
  double target_cell_size = 0.0; // 0 = inherit the global target
  bool sizing_unconstrained = false; // ignore the target; coarsest viable band
  std::vector<BoundarySizingSample> sizing_samples;
  std::vector<double> cumulative_length; // arc length up to each segment start

  std::size_t segment_count() const { return closed ? points.size() : points.size() - 1; }

  double total_length() const { return cumulative_length.back(); }

  bool has_local_sizing() const { return !sizing_samples.empty(); }

  // Interpolated local target at normalized arc length. Uses `fallback` when
  // no valid local samples were supplied.
  double target_size_at_fraction(double fraction, double fallback) const;

  // Arc-length coordinate of position (segment index + t).
  double arc_length_at(double arc) const
  {
    const int m = static_cast<int>(segment_count());
    int seg = static_cast<int>(std::floor(arc));
    const double t = arc - seg;
    seg %= m;
    return cumulative_length[static_cast<std::size_t>(seg)]
        + t * (cumulative_length[static_cast<std::size_t>(seg) + 1]
               - cumulative_length[static_cast<std::size_t>(seg)]);
  }

  // Forward arc distance from `from` to `to` (wrapping for closed chains).
  double arc_between(double from, double to) const
  {
    double d = arc_length_at(to) - arc_length_at(from);
    if (d < 0.0 && closed) {
      d += total_length();
    }
    return std::abs(d);
  }
  Segment2 segment(std::size_t i) const
  {
    return {points[i], points[(i + 1) % points.size()]};
  }
};

double turn_angle_deg(Point2 prev, Point2 at, Point2 next);

std::vector<Chain> build_chains(const DomainGeometry& domain, double feature_angle_deg);

struct SegRef {
  int chain = 0;
  int index = 0;
};

} // namespace quadmesh::detail
