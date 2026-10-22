#pragma once

#include "quadmesh/geometry.hpp"

namespace quadmesh {

// Closed polygonal approximation of a circle: `segments` vertices evenly spaced
// in angle, the first at `phase` radians.
PolylineLoop circle_loop(Point2 center, double radius, int segments,
                         double phase = 0.0);

// Closed n-pointed star alternating between `outer_radius` and `inner_radius`
// (2 * points vertices). The first point sits at the top (-pi/2).
PolylineLoop star_loop(Point2 center, double outer_radius, double inner_radius,
                       int points = 5);

// Closed rose/flower curve r = radius * (1 + amplitude * cos(petals * theta)),
// sampled at `segments` vertices.
PolylineLoop flower_loop(Point2 center, double radius, int petals, int segments,
                         double amplitude = 0.35);

} // namespace quadmesh
