#include "quadmesh/shapes.hpp"

#include <algorithm>
#include <cmath>
#include <numbers>

namespace quadmesh {
namespace {

constexpr double pi = std::numbers::pi_v<double>;

} // namespace

PolylineLoop circle_loop(Point2 center, double radius, int segments,
                         double phase) {
  PolylineLoop loop;
  loop.closed = true;
  loop.vertices.reserve(static_cast<std::size_t>(std::max(0, segments)));
  for (int i = 0; i < segments; ++i) {
    const double theta = 2.0 * pi * static_cast<double>(i) /
                             static_cast<double>(segments) +
                         phase;
    loop.vertices.push_back({center.x + radius * std::cos(theta),
                             center.y + radius * std::sin(theta)});
  }
  return loop;
}

PolylineLoop star_loop(Point2 center, double outer_radius, double inner_radius,
                       int points) {
  PolylineLoop loop;
  loop.closed = true;
  loop.vertices.reserve(static_cast<std::size_t>(std::max(0, points) * 2));
  for (int i = 0; i < points * 2; ++i) {
    const double radius = (i % 2 == 0) ? outer_radius : inner_radius;
    const double theta = -pi / 2.0 + static_cast<double>(i) * pi /
                                         static_cast<double>(points);
    loop.vertices.push_back({center.x + radius * std::cos(theta),
                             center.y + radius * std::sin(theta)});
  }
  return loop;
}

PolylineLoop flower_loop(Point2 center, double radius, int petals, int segments,
                         double amplitude) {
  PolylineLoop loop;
  loop.closed = true;
  loop.vertices.reserve(static_cast<std::size_t>(std::max(0, segments)));
  for (int i = 0; i < segments; ++i) {
    const double theta =
        2.0 * pi * static_cast<double>(i) / static_cast<double>(segments);
    const double r =
        radius * (1.0 + amplitude * std::cos(static_cast<double>(petals) * theta));
    loop.vertices.push_back(
        {center.x + r * std::cos(theta), center.y + r * std::sin(theta)});
  }
  return loop;
}

} // namespace quadmesh
