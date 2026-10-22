#pragma once

#include "quadmesh/geometry.hpp"

#include <cstddef>
#include <optional>
#include <string>
#include <vector>

namespace quadmesh {

// Settings for SVG-to-polyline conversion. Curves are recursively flattened
// until their maximum deviation from the generated chord is at most
// curve_tolerance in SVG user units.
struct SvgImportOptions {
  double curve_tolerance = 0.5;
  // When set, only visible filled elements whose computed `fill` value is
  // this value are imported. The comparison is case-insensitive and accepts
  // the literal colour spelling from the SVG (for example "#000000").
  std::optional<std::string> fill;
};

// A conservative preflight for the simple-boundary model accepted by the
// mesher. It catches boundary crossings and contacts; it does not perform SVG
// paint-order Boolean operations.
struct SvgTopologyReport {
  std::size_t segment_count = 0;
  std::size_t conflict_count = 0; // capped at the number of reported issues
  std::vector<std::string> issues;

  [[nodiscard]] bool meshable() const noexcept { return conflict_count == 0; }
};

struct SvgImportResult {
  DomainGeometry domain;
  std::vector<std::string> warnings;
  SvgTopologyReport topology;
};

// Reads filled SVG paths and the standard polygon, polyline, rect, circle,
// and ellipse primitives. The resulting closed rings are appended as outer
// loops: quadmesh uses an even-odd rule across closed boundary loops, so
// nested rings naturally become holes. Open paths and unfilled elements are
// skipped and reported through warnings. Unsupported SVG elements are ignored.
// `topology` reports crossings and touching boundaries that cannot safely be
// passed to the mesher without Boolean cleanup.
//
// Throws std::runtime_error when `path` cannot be read or its supported SVG
// geometry is malformed. SVG presentation is intentionally out of scope:
// strokes, clipping, masks, text, and boolean paint compositing are not
// converted to mesh geometry.
SvgImportResult read_svg(const std::string& path,
                         const SvgImportOptions& options = {});

} // namespace quadmesh
