#include "quadmesh/geometry.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace quadmesh {

Vec2 operator-(Point2 a, Point2 b) noexcept { return {a.x - b.x, a.y - b.y}; }
Point2 operator+(Point2 p, Vec2 v) noexcept { return {p.x + v.x, p.y + v.y}; }
Point2 operator-(Point2 p, Vec2 v) noexcept { return {p.x - v.x, p.y - v.y}; }
Vec2 operator+(Vec2 a, Vec2 b) noexcept { return {a.x + b.x, a.y + b.y}; }
Vec2 operator-(Vec2 a, Vec2 b) noexcept { return {a.x - b.x, a.y - b.y}; }
Vec2 operator*(Vec2 v, double scalar) noexcept { return {v.x * scalar, v.y * scalar}; }
double dot(Vec2 a, Vec2 b) noexcept { return a.x * b.x + a.y * b.y; }
double cross(Vec2 a, Vec2 b) noexcept { return a.x * b.y - a.y * b.x; }
double length(Vec2 v) noexcept { return std::sqrt(v.x * v.x + v.y * v.y); }
double distance(Point2 a, Point2 b) noexcept { return length(a - b); }

bool nearly_equal(double a, double b, double eps) noexcept { return std::abs(a - b) <= eps; }

bool nearly_equal(Point2 a, Point2 b, double eps) noexcept
{
  return nearly_equal(a.x, b.x, eps) && nearly_equal(a.y, b.y, eps);
}

Aabb2 bounds_of(const PolylineLoop& loop)
{
  Aabb2 box{{std::numeric_limits<double>::max(), std::numeric_limits<double>::max()},
            {std::numeric_limits<double>::lowest(), std::numeric_limits<double>::lowest()}};
  for (const Point2& p : loop.vertices) {
    box.min.x = std::min(box.min.x, p.x);
    box.min.y = std::min(box.min.y, p.y);
    box.max.x = std::max(box.max.x, p.x);
    box.max.y = std::max(box.max.y, p.y);
  }
  return box;
}

Aabb2 bounds_of(const DomainGeometry& geometry)
{
  Aabb2 box{{std::numeric_limits<double>::max(), std::numeric_limits<double>::max()},
            {std::numeric_limits<double>::lowest(), std::numeric_limits<double>::lowest()}};
  auto merge = [&box](const PolylineLoop& loop) {
    const Aabb2 b = bounds_of(loop);
    box.min.x = std::min(box.min.x, b.min.x);
    box.min.y = std::min(box.min.y, b.min.y);
    box.max.x = std::max(box.max.x, b.max.x);
    box.max.y = std::max(box.max.y, b.max.y);
  };
  for (const PolylineLoop& loop : geometry.outer_loops) {
    merge(loop);
  }
  for (const InnerLoop& inner : geometry.inner_loops) {
    merge(inner.loop);
  }
  return box;
}

bool contains(const Aabb2& box, Point2 point, double eps) noexcept
{
  return point.x >= box.min.x - eps && point.x <= box.max.x + eps && point.y >= box.min.y - eps
      && point.y <= box.max.y + eps;
}

Point2 center(const Aabb2& box) noexcept
{
  return {(box.min.x + box.max.x) / 2.0, (box.min.y + box.max.y) / 2.0};
}

double width(const Aabb2& box) noexcept { return box.max.x - box.min.x; }
double height(const Aabb2& box) noexcept { return box.max.y - box.min.y; }
double max_extent(const Aabb2& box) noexcept { return std::max(width(box), height(box)); }

std::vector<Segment2> loop_segments(const PolylineLoop& loop)
{
  std::vector<Segment2> segments;
  if (loop.vertices.size() < 2) {
    return segments;
  }
  const std::size_t count = loop.closed ? loop.vertices.size() : loop.vertices.size() - 1;
  segments.reserve(count);
  for (std::size_t i = 0; i < count; ++i) {
    segments.push_back({loop.vertices[i], loop.vertices[(i + 1) % loop.vertices.size()]});
  }
  return segments;
}

Point2 closest_point_on_segment(Segment2 segment, Point2 point) noexcept
{
  const Vec2 ab = segment.b - segment.a;
  const double len2 = dot(ab, ab);
  if (len2 <= 0.0) {
    return segment.a;
  }
  const double t = std::clamp(dot(point - segment.a, ab) / len2, 0.0, 1.0);
  return segment.a + ab * t;
}

double distance_to_segment(Point2 point, Segment2 segment) noexcept
{
  return distance(point, closest_point_on_segment(segment, point));
}

std::optional<SegmentHit> intersect_segments(Segment2 first, Segment2 second, double eps) noexcept
{
  const Vec2 r = first.b - first.a;
  const Vec2 s = second.b - second.a;
  const double denominator = cross(r, s);
  if (std::abs(denominator) <= eps * (length(r) * length(s) + eps)) {
    return std::nullopt; // parallel or degenerate
  }
  const Vec2 qp = second.a - first.a;
  const double t = cross(qp, s) / denominator;
  const double u = cross(qp, r) / denominator;
  const double tol_t = eps / std::max(length(r), eps);
  const double tol_u = eps / std::max(length(s), eps);
  if (t < -tol_t || t > 1.0 + tol_t || u < -tol_u || u > 1.0 + tol_u) {
    return std::nullopt;
  }
  SegmentHit hit;
  hit.t_first = std::clamp(t, 0.0, 1.0);
  hit.t_second = std::clamp(u, 0.0, 1.0);
  hit.point = first.a + r * hit.t_first;
  return hit;
}

bool segment_intersects_aabb(Segment2 segment, const Aabb2& box) noexcept
{
  // Slab clipping.
  double t0 = 0.0;
  double t1 = 1.0;
  const Vec2 d = segment.b - segment.a;
  const double p[4] = {-d.x, d.x, -d.y, d.y};
  const double q[4] = {segment.a.x - box.min.x, box.max.x - segment.a.x, segment.a.y - box.min.y,
                       box.max.y - segment.a.y};
  for (int i = 0; i < 4; ++i) {
    if (p[i] == 0.0) {
      if (q[i] < 0.0) {
        return false;
      }
      continue;
    }
    const double t = q[i] / p[i];
    if (p[i] < 0.0) {
      t0 = std::max(t0, t);
    } else {
      t1 = std::min(t1, t);
    }
    if (t0 > t1) {
      return false;
    }
  }
  return true;
}

} // namespace quadmesh
