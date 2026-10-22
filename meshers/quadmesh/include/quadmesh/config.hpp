#pragma once

#include <cstdint>

namespace quadmesh {

enum class SizingPromotionMode : std::uint8_t {
  // Preserve the historical behavior: if another loop's grading reaches a
  // uniformly sized boundary, raise that boundary's entire sizing band.
  WholeLoop,
  // Promote only the contacted arc intervals. The first balanced tree is
  // sampled into an automatic local sizing field, then rebuilt with proper
  // same-level boundary rings around those promoted intervals.
  Local,
};

struct ToleranceConfig {
  double absolute_distance = 1.0e-9;
  double relative_distance = 1.0e-12;
};

struct RefinementConfig {
  // Edge length of quadtree squares along the boundary, for loops that do
  // not set their own PolylineLoop::target_cell_size. 0 selects an
  // automatic size of (geometry max extent) / 24. Sizes are quantized to
  // powers of two of the root square and refined further where geometry
  // demands it; see PolylineLoop::target_cell_size for the achievable
  // bounds.
  double target_cell_size = 0.0;
  // Hard cap on quadtree depth, including refinement forced by feature
  // separation rules: no square is smaller than root/2^max_level, where
  // root = 2 * (geometry max extent). Separation that still fails at this
  // level warns and degrades instead of refining.
  std::uint16_t max_level = 12;
  // Controls how a fine loop's quadtree grading is transferred to another
  // loop whose requested boundary band is coarser at the contact location.
  SizingPromotionMode sizing_promotion = SizingPromotionMode::WholeLoop;
};

struct FeatureConfig {
  // Polyline joints whose turn angle exceeds this are preserved exactly as
  // sharp feature vertices (paper section 2.3.1). Shallower joints are
  // treated as samples of a smooth curve.
  double feature_angle_deg = 20.0;
  // Maximum deviation, as a fraction of the local square size, between a
  // smooth chain and its straight output chord. A zero value preserves each
  // non-collinear input joint exactly; positive values treat shallow joints
  // as samples of a smooth curve and bound their approximation locally.
  double chord_tolerance_fraction = 0.08;
};

struct RepellingConfig {
  // delta/s: grid corners closer than delta to the geometry are repelled to
  // exactly delta away (paper section 2.2). The paper analyzes delta = s/4.
  double distance_fraction = 0.25;
  // Pull distance, as a fraction of square size, applied to side midpoints
  // of squares containing a feature vertex (paper section 2.3.1: s/8).
  double vertex_pull_fraction = 0.125;
};

struct MeshingConfig {
  ToleranceConfig tolerances;
  RefinementConfig refinement;
  FeatureConfig features;
  RepellingConfig repelling;
  // Boundary spacing is an element-size request in this mode, independent
  // of geometry tessellation. Legacy quadtree sizing remains the default.
  bool finite_element_sizing = false;
  std::uint32_t elements_per_circle = 12;
  bool enable_smoothing = false;
  std::uint32_t smoothing_iterations = 12;
};

} // namespace quadmesh
