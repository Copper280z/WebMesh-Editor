#pragma once

#include <optional>
#include <cstdint>
#include <vector>

namespace quadmesh {

struct Vec2 {
  double x = 0.0;
  double y = 0.0;
};

struct Point2 {
  double x = 0.0;
  double y = 0.0;
};

struct Segment2 {
  Point2 a;
  Point2 b;
};

struct Aabb2 {
  Point2 min;
  Point2 max;
};

// A target size at a normalized arc-length position on a PolylineLoop.
// Samples are interpolated in log-size space. For closed loops the interval
// wraps from 1 back to 0; open loops clamp outside their end samples.
struct BoundarySizingSample {
  double arc_fraction = 0.0;
  double target_cell_size = 0.0;
};

// A location on the original input polyline, before normalization/sampling.
struct BoundaryPosition {
  std::uint32_t segment = 0;
  double parameter = 0.0;
};

// Nodes follow the loop's traversal direction. An open run includes both
// endpoints; a closed run includes each node once (no closing duplicate).
// start/end refer to the original polyline. end is ignored for a closed run.
struct FixedBoundaryRun {
  BoundaryPosition start;
  BoundaryPosition end;
  std::vector<Point2> nodes;
  bool closed = false;
};

enum class VertexKind : std::uint8_t { Automatic, Smooth, Corner };

struct PolylineLoop {
  std::vector<Point2> vertices;
  bool closed = true;
  // Boundary square size to use along this loop; 0 inherits the global
  // RefinementConfig::target_cell_size. Without sizing_samples this produces
  // a uniform per-loop band. With samples it supplies the coarse base level,
  // while the interpolated samples refine locally along the loop.
  //
  // Quantization: band squares are root/2^level with root = 2 * (max extent
  // of the whole input's bounding box). The level nearest the target in log
  // scale is chosen, so the achieved size is within a factor sqrt(2) of the
  // request. Coarsening the target never refines the mesh; a target coarser
  // than the refinement floor below behaves exactly like
  // sizing_unconstrained.
  //
  // Refinement floor — the algorithm refines past the target until each of
  // these holds, so the effective square size is also bounded above by:
  //   - curvature: the curve's total turn inside one square is capped at
  //     max(10 deg, 4 * FeatureConfig::chord_tolerance_fraction radians),
  //     i.e. s <~ 0.23 * (radius of curvature) at the default tolerance.
  //     Coarsely tessellated smooth curves (per-joint turn above ~half the
  //     cap but below feature_angle_deg) degrade this to s <~ segment
  //     length — tessellate smooth geometry finely rather than coarsely.
  //   - feature isolation: one feature vertex (joint turning more than
  //     FeatureConfig::feature_angle_deg) per square, and a vertex square
  //     only contains curve within 3s arc of its vertex: s is below ~half
  //     the spacing between nearby features.
  //   - separation: squares hold a single piece of curve, so s is below the
  //     clearance where a loop approaches itself or another loop (loops in
  //     contact refine to RefinementConfig::max_level, then warn).
  //   - closed loops span at least two squares: s <= loop extent / 2.
  //   - band contact: a loop lying inside a finer loop's quadtree grading
  //     (square size doubles per ring with distance) is raised to the local
  //     leaf size, roughly s <~ distance to the nearest finer loop. The
  //     affected arc is controlled by RefinementConfig::sizing_promotion:
  //     WholeLoop raises the uniform band; Local promotes only nearby arcs.
  // The hard floor is root/2^RefinementConfig::max_level (extent/2048 at
  // the default max_level of 12); targets below it are clamped.
  double target_cell_size = 0.0;
  // Optional local boundary sizing field. A non-empty list defines a target
  // over the whole loop by arc-length interpolation; target_cell_size (or the
  // global target) remains the coarse base level. Values are normalized arc
  // positions in [0, 1] and positive target square sizes. The mesher grades
  // the resulting dyadic target levels through the quadtree.
  std::vector<BoundarySizingSample> sizing_samples = {};
  // Sizing along this loop does not matter: target_cell_size is ignored and
  // the loop keeps the coarsest band that the refinement floor above (the
  // separation rules and band uniformity against the other loops) allows.
  // Sharp features always remain exact. Smooth sampled portions are bounded
  // by FeatureConfig::chord_tolerance_fraction unless it is set to zero.
  bool sizing_unconstrained = false;
  std::vector<FixedBoundaryRun> fixed_runs = {};
  // Optional per-input-vertex overrides; empty means Automatic everywhere.
  std::vector<VertexKind> vertex_kinds = {};
};

enum class InnerLoopRole {
  Hole,
  MeshControlFeature,
};

struct InnerLoop {
  PolylineLoop loop;
  InnerLoopRole role = InnerLoopRole::Hole;
};

struct DomainGeometry {
  std::vector<PolylineLoop> outer_loops;
  std::vector<InnerLoop> inner_loops;
};

Vec2 operator-(Point2 a, Point2 b) noexcept;
Point2 operator+(Point2 p, Vec2 v) noexcept;
Point2 operator-(Point2 p, Vec2 v) noexcept;
Vec2 operator+(Vec2 a, Vec2 b) noexcept;
Vec2 operator-(Vec2 a, Vec2 b) noexcept;
Vec2 operator*(Vec2 v, double scalar) noexcept;
double dot(Vec2 a, Vec2 b) noexcept;
double cross(Vec2 a, Vec2 b) noexcept;
double length(Vec2 v) noexcept;
double distance(Point2 a, Point2 b) noexcept;
bool nearly_equal(double a, double b, double eps) noexcept;
bool nearly_equal(Point2 a, Point2 b, double eps) noexcept;

Aabb2 bounds_of(const PolylineLoop& loop);
Aabb2 bounds_of(const DomainGeometry& geometry);
bool contains(const Aabb2& box, Point2 point, double eps = 0.0) noexcept;
Point2 center(const Aabb2& box) noexcept;
double width(const Aabb2& box) noexcept;
double height(const Aabb2& box) noexcept;
double max_extent(const Aabb2& box) noexcept;

std::vector<Segment2> loop_segments(const PolylineLoop& loop);

Point2 closest_point_on_segment(Segment2 segment, Point2 point) noexcept;
double distance_to_segment(Point2 point, Segment2 segment) noexcept;

// Proper crossing of two segments; returns parameters along each when the
// interiors (or endpoints, within eps) intersect at a single point.
struct SegmentHit {
  Point2 point;
  double t_first = 0.0;
  double t_second = 0.0;
};
std::optional<SegmentHit> intersect_segments(Segment2 first, Segment2 second, double eps) noexcept;

bool segment_intersects_aabb(Segment2 segment, const Aabb2& box) noexcept;

} // namespace quadmesh
