#include "detail/chain.hpp"

#include "detail/types.hpp" // pi

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace quadmesh::detail {

double turn_angle_deg(Point2 prev, Point2 at, Point2 next)
{
  const Vec2 in = at - prev;
  const Vec2 out = next - at;
  const double li = length(in);
  const double lo = length(out);
  if (li <= 0.0 || lo <= 0.0) {
    return 0.0;
  }
  const double c = std::clamp(dot(in, out) / (li * lo), -1.0, 1.0);
  return std::acos(c) * 180.0 / pi;
}

double Chain::target_size_at_fraction(double fraction, double fallback) const
{
  if (sizing_samples.empty()) {
    return fallback;
  }
  if (closed) {
    fraction -= std::floor(fraction);
  } else {
    fraction = std::clamp(fraction, 0.0, 1.0);
  }
  if (sizing_samples.size() == 1) {
    return sizing_samples.front().target_cell_size;
  }

  std::size_t right = 0;
  while (right < sizing_samples.size() && sizing_samples[right].arc_fraction < fraction) {
    ++right;
  }
  if (!closed) {
    if (right == 0) {
      return sizing_samples.front().target_cell_size;
    }
    if (right == sizing_samples.size()) {
      return sizing_samples.back().target_cell_size;
    }
  }
  const std::size_t left = right == 0 ? sizing_samples.size() - 1 : right - 1;
  right %= sizing_samples.size();
  double a = sizing_samples[left].arc_fraction;
  double b = sizing_samples[right].arc_fraction;
  double f = fraction;
  if (closed && right == 0) {
    b += 1.0;
    if (f < a) {
      f += 1.0;
    }
  }
  const double t = b > a ? std::clamp((f - a) / (b - a), 0.0, 1.0) : 0.0;
  const double log_a = std::log(sizing_samples[left].target_cell_size);
  const double log_b = std::log(sizing_samples[right].target_cell_size);
  return std::exp(log_a + (log_b - log_a) * t);
}

std::vector<Chain> build_chains(const DomainGeometry& domain, double feature_angle_deg)
{
  std::vector<Chain> chains;
  auto add_loop = [&](const PolylineLoop& loop, bool bounds_domain) {
    if (loop.vertices.size() < 2) {
      return;
    }
    Chain chain;
    chain.closed = loop.closed;
    chain.counts_for_parity = loop.closed && bounds_domain;
    chain.target_cell_size = loop.target_cell_size;
    chain.sizing_unconstrained = loop.sizing_unconstrained;
    for (const BoundarySizingSample& sample : loop.sizing_samples) {
      if (std::isfinite(sample.arc_fraction) && std::isfinite(sample.target_cell_size)
          && sample.arc_fraction >= 0.0 && sample.arc_fraction <= 1.0
          && sample.target_cell_size > 0.0) {
        chain.sizing_samples.push_back(sample);
      }
    }
    std::sort(chain.sizing_samples.begin(), chain.sizing_samples.end(),
              [](const BoundarySizingSample& a, const BoundarySizingSample& b) {
                return a.arc_fraction < b.arc_fraction;
              });
    std::vector<BoundarySizingSample> unique_samples;
    for (const BoundarySizingSample& sample : chain.sizing_samples) {
      if (!unique_samples.empty()
          && std::abs(unique_samples.back().arc_fraction - sample.arc_fraction) < 1.0e-12) {
        unique_samples.back() = sample;
      } else {
        unique_samples.push_back(sample);
      }
    }
    chain.sizing_samples = std::move(unique_samples);
    chain.points = loop.vertices;
    // Drop a duplicated closing vertex.
    if (chain.closed && chain.points.size() > 2
        && nearly_equal(chain.points.front(), chain.points.back(), 1.0e-12)) {
      chain.points.pop_back();
    }
    const std::size_t n = chain.points.size();
    if (!loop.vertex_kinds.empty() && loop.vertex_kinds.size() != loop.vertices.size())
      throw std::invalid_argument("vertex_kinds must have one entry per input vertex");
    chain.feature.assign(n, false);
    for (std::size_t i = 0; i < n; ++i) {
      if (!chain.closed && (i == 0 || i + 1 == n)) {
        chain.feature[i] = true; // open chain endpoints are features
        continue;
      }
      const Point2 prev = chain.points[(i + n - 1) % n];
      const Point2 next = chain.points[(i + 1) % n];
      chain.feature[i] = turn_angle_deg(prev, chain.points[i], next) > feature_angle_deg;
      if (!loop.vertex_kinds.empty() && loop.vertex_kinds[i] != VertexKind::Automatic)
        chain.feature[i] = loop.vertex_kinds[i] == VertexKind::Corner;
    }
    chain.cumulative_length.assign(chain.segment_count() + 1, 0.0);
    for (std::size_t i = 0; i < chain.segment_count(); ++i) {
      const Segment2 seg = chain.segment(i);
      chain.cumulative_length[i + 1] = chain.cumulative_length[i] + distance(seg.a, seg.b);
    }
    chains.push_back(std::move(chain));
  };
  for (const PolylineLoop& loop : domain.outer_loops) {
    add_loop(loop, true);
  }
  for (const InnerLoop& inner : domain.inner_loops) {
    // Mesh-control features are embedded curves: the mesh conforms to them
    // on both sides but they do not bound the domain.
    add_loop(inner.loop, inner.role == InnerLoopRole::Hole);
  }
  return chains;
}

} // namespace quadmesh::detail
