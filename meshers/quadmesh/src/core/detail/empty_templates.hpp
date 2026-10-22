#pragma once

#include "quadmesh/geometry.hpp"

#include <array>
#include <vector>

namespace quadmesh::detail {

enum class EmptyTemplateKind {
  BoundaryQuad,
  RecursiveSplit,
  PairedFan,
  OneRing,
};

// Interior nodes on each cell side, parameterized in the side's CCW
// direction. The four cell corners are supplied separately and are not
// repeated here.
using EmptyTemplateSideParameters = std::array<std::vector<double>, 4>;

struct EmptyTemplateQuality {
  double min_angle_deg = 0.0;
  double max_angle_deg = 360.0;
  double min_scaled_jacobian = -1.0;
  double min_edge_ratio = 0.0;
};

// Indices in `quads` address boundary points first, followed by `interior`.
// The caller maps those local indices to its shared boundary node ids.
struct EmptyTemplatePlan {
  EmptyTemplateKind kind = EmptyTemplateKind::OneRing;
  std::vector<Point2> interior;
  std::vector<std::array<int, 4>> quads;
  EmptyTemplateQuality quality;
  bool meets_quality_contract = false;
};

// First searches the finite dyadic split tree whose leaves are a single quad
// or one of the paper's 3-/4-quad 2-ref templates, including the exact drawn
// seven-/ten-quad constructions, the canonical corner-strip family, and the
// three-side grid-and-cap family for bounded asymmetric side states. Splits
// never add an outer boundary node. If no split certificate meets the
// production quality contract on the actual (possibly repelled) points,
// selects from the paired-fan / one-ring fallback family. `cell_corners` are
// SW, SE, NE, NW;
// `boundary` is the complete CCW side-node loop.
EmptyTemplatePlan choose_empty_template(const std::array<Point2, 4>& cell_corners,
                                        const std::vector<Point2>& boundary,
                                        const EmptyTemplateSideParameters& side_parameters);

// Variant for a convex face whose complete even boundary-node loop is already
// known (for example, polygon corners interleaved with shared edge midpoints).
EmptyTemplatePlan choose_polygon_template(const std::vector<Point2>& boundary);

} // namespace quadmesh::detail
