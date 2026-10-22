// Enumerates generalized empty-cell boundary states that still require the
// radial fallback, quotients them by the eight symmetries of the square, and
// writes one canonical boundary-node diagram per orbit.
#include "detail/empty_templates.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace {

using quadmesh::Point2;
using quadmesh::detail::EmptyTemplateKind;
using quadmesh::detail::EmptyTemplatePlan;
using quadmesh::detail::EmptyTemplateSideParameters;
using Pattern = std::array<int, 4>; // south, east, north, west

const std::array<Point2, 4> corners{
    Point2{0.0, 0.0}, Point2{1.0, 0.0}, Point2{1.0, 1.0}, Point2{0.0, 1.0}};

const std::array<std::vector<double>, 5> side_patterns{
    std::vector<double>{},
    std::vector<double>{0.5},
    std::vector<double>{0.25, 0.5},
    std::vector<double>{0.5, 0.75},
    std::vector<double>{0.25, 0.5, 0.75},
};

const std::array<std::string, 5> pattern_names{"-", "M", "QM", "MT", "QMT"};

EmptyTemplatePlan plan_for(const Pattern& pattern)
{
  std::vector<Point2> boundary;
  EmptyTemplateSideParameters parameters;
  for (int side = 0; side < 4; ++side) {
    boundary.push_back(corners[static_cast<std::size_t>(side)]);
    parameters[static_cast<std::size_t>(side)] =
        side_patterns[static_cast<std::size_t>(pattern[static_cast<std::size_t>(side)])];
    for (const double t : parameters[static_cast<std::size_t>(side)]) {
      const Point2 a = corners[static_cast<std::size_t>(side)];
      const Point2 b = corners[static_cast<std::size_t>((side + 1) % 4)];
      boundary.push_back(a + (b - a) * t);
    }
  }
  return quadmesh::detail::choose_empty_template(corners, boundary, parameters);
}

int reverse_side_pattern(int pattern)
{
  if (pattern == 2) {
    return 3;
  }
  if (pattern == 3) {
    return 2;
  }
  return pattern;
}

Pattern rotate(const Pattern& pattern, int quarter_turns)
{
  Pattern result{};
  for (int side = 0; side < 4; ++side) {
    result[static_cast<std::size_t>((side + quarter_turns) % 4)] =
        pattern[static_cast<std::size_t>(side)];
  }
  return result;
}

Pattern reflect(const Pattern& pattern)
{
  // Reflection across the vertical axis maps S,E,N,W to S,W,N,E and
  // reverses every side's CCW parameterization.
  constexpr std::array<int, 4> reflected_side{0, 3, 2, 1};
  Pattern result{};
  for (int side = 0; side < 4; ++side) {
    result[static_cast<std::size_t>(reflected_side[static_cast<std::size_t>(side)])] =
        reverse_side_pattern(pattern[static_cast<std::size_t>(side)]);
  }
  return result;
}

std::set<Pattern> orbit(const Pattern& pattern)
{
  std::set<Pattern> result;
  const Pattern mirrored = reflect(pattern);
  for (int turns = 0; turns < 4; ++turns) {
    result.insert(rotate(pattern, turns));
    result.insert(rotate(mirrored, turns));
  }
  return result;
}

Pattern canonical(const Pattern& pattern)
{
  return *orbit(pattern).begin();
}

bool is_fallback(const Pattern& pattern)
{
  const EmptyTemplateKind kind = plan_for(pattern).kind;
  return kind == EmptyTemplateKind::PairedFan || kind == EmptyTemplateKind::OneRing;
}

std::string pattern_label(const Pattern& pattern)
{
  std::ostringstream text;
  text << "S=" << pattern_names[static_cast<std::size_t>(pattern[0])]
       << "  E=" << pattern_names[static_cast<std::size_t>(pattern[1])]
       << "  N=" << pattern_names[static_cast<std::size_t>(pattern[2])]
       << "  W=" << pattern_names[static_cast<std::size_t>(pattern[3])];
  return text.str();
}

Point2 side_point(int side, double t)
{
  const Point2 a = corners[static_cast<std::size_t>(side)];
  const Point2 b = corners[static_cast<std::size_t>((side + 1) % 4)];
  return a + (b - a) * t;
}

void write_svg(const std::string& path, const std::vector<Pattern>& cases,
               std::size_t fallback_state_count)
{
  constexpr int columns = 4;
  constexpr double card_width = 300.0;
  constexpr double card_height = 285.0;
  constexpr double margin = 28.0;
  constexpr double title_height = 104.0;
  constexpr double footer_height = 72.0;
  const int rows = static_cast<int>((cases.size() + columns - 1) / columns);
  const double width = 2.0 * margin + columns * card_width;
  const double height = title_height + rows * card_height + footer_height;

  std::ofstream out(path);
  out << std::fixed << std::setprecision(2);
  out << "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" << width
      << "\" height=\"" << height << "\" viewBox=\"0 0 " << width << ' ' << height
      << "\">\n";
  out << R"(<rect width="100%" height="100%" fill="#f7f9fc"/>
<style>
  .title { font-family: Arial; font-size: 27px; font-weight: 700; fill: #17263b; }
  .subtitle { font-family: Arial; font-size: 15px; fill: #52657c; }
  .card { fill: white; stroke: #d7e0ea; stroke-width: 1.5; }
  .case { font-family: Arial; font-size: 16px; font-weight: 700; fill: #21364f; }
  .label { font-family: Courier; font-size: 13px; fill: #41566f; }
  .orbit { font-family: Arial; font-size: 12px; fill: #72839a; }
  .cell { fill: #f9fbfd; stroke: #29445f; stroke-width: 3; }
  .corner { fill: #29445f; }
  .side-node { fill: #e23e57; stroke: white; stroke-width: 2; }
  .footer { font-family: Arial; font-size: 13px; fill: #52657c; }
</style>
)";
  out << "<text x=\"" << margin << "\" y=\"42\" class=\"title\">Uncovered atomic-side template cases</text>\n";
  out << "<text x=\"" << margin << "\" y=\"70\" class=\"subtitle\">"
      << fallback_state_count << " oriented fallback states collapse to " << cases.size()
      << " cases under rotations and reflections.</text>\n";

  for (std::size_t index = 0; index < cases.size(); ++index) {
    const int row = static_cast<int>(index / columns);
    const int column = static_cast<int>(index % columns);
    const double card_x = margin + column * card_width;
    const double card_y = title_height + row * card_height;
    const double square_size = 164.0;
    const double square_x = card_x + (card_width - square_size) * 0.5;
    const double square_y = card_y + 48.0;
    const Pattern& pattern = cases[index];
    const std::size_t orbit_size = orbit(pattern).size();

    out << "<g>\n";
    out << "<rect x=\"" << card_x + 8.0 << "\" y=\"" << card_y + 4.0
        << "\" width=\"" << card_width - 16.0 << "\" height=\"" << card_height - 12.0
        << "\" rx=\"12\" class=\"card\"/>\n";
    out << "<text x=\"" << card_x + 22.0 << "\" y=\"" << card_y + 31.0
        << "\" class=\"case\">Case " << index + 1 << "</text>\n";
    out << "<text x=\"" << card_x + card_width - 22.0 << "\" y=\"" << card_y + 31.0
        << "\" text-anchor=\"end\" class=\"orbit\">orbit size " << orbit_size
        << "</text>\n";
    out << "<rect x=\"" << square_x << "\" y=\"" << square_y << "\" width=\""
        << square_size << "\" height=\"" << square_size
        << "\" fill=\"#eef3f8\"/>\n";
    out << "<path d=\"M " << square_x << ' ' << square_y << " H " << square_x + square_size
        << " V " << square_y + square_size << " H " << square_x
        << " Z\" fill=\"none\" stroke=\"#29445f\" stroke-width=\"4.5\"/>\n";
    constexpr double edge_width = 3.5;
    out << "<rect x=\"" << square_x - edge_width * 0.5 << "\" y=\""
        << square_y - edge_width * 0.5 << "\" width=\"" << square_size + edge_width
        << "\" height=\"" << edge_width << "\" fill=\"#29445f\"/>\n";
    out << "<rect x=\"" << square_x - edge_width * 0.5 << "\" y=\""
        << square_y + square_size - edge_width * 0.5 << "\" width=\""
        << square_size + edge_width << "\" height=\"" << edge_width
        << "\" fill=\"#29445f\"/>\n";
    out << "<rect x=\"" << square_x - edge_width * 0.5 << "\" y=\""
        << square_y - edge_width * 0.5 << "\" width=\"" << edge_width
        << "\" height=\"" << square_size + edge_width << "\" fill=\"#29445f\"/>\n";
    out << "<rect x=\"" << square_x + square_size - edge_width * 0.5 << "\" y=\""
        << square_y - edge_width * 0.5 << "\" width=\"" << edge_width
        << "\" height=\"" << square_size + edge_width << "\" fill=\"#29445f\"/>\n";
    for (const Point2 corner : corners) {
      const double x = square_x + corner.x * square_size;
      const double y = square_y + (1.0 - corner.y) * square_size;
      out << "<circle cx=\"" << x << "\" cy=\"" << y
          << "\" r=\"4.2\" class=\"corner\"/>\n";
    }
    for (int side = 0; side < 4; ++side) {
      for (const double t :
           side_patterns[static_cast<std::size_t>(pattern[static_cast<std::size_t>(side)])]) {
        const Point2 point = side_point(side, t);
        const double x = square_x + point.x * square_size;
        const double y = square_y + (1.0 - point.y) * square_size;
        out << "<circle cx=\"" << x << "\" cy=\"" << y
            << "\" r=\"7\" class=\"side-node\"/>\n";
      }
    }
    out << "<text x=\"" << card_x + card_width * 0.5 << "\" y=\""
        << card_y + 236.0 << "\" text-anchor=\"middle\" class=\"label\">"
        << pattern_label(pattern) << "</text>\n";
    out << "</g>\n";
  }

  const double footer_y = title_height + rows * card_height + 26.0;
  if (cases.empty()) {
    out << "<text x=\"" << margin << "\" y=\"" << footer_y
        << "\" class=\"case\">All 313 even atomic-side states have a non-radial template.</text>\n";
    out << "<text x=\"" << margin << "\" y=\"" << footer_y + 24.0
        << "\" class=\"footer\">OneRing remains only as a defensive fallback for deformed instances that fail the quality contract.</text>\n";
  } else {
    out << "<text x=\"" << margin << "\" y=\"" << footer_y
        << "\" class=\"footer\">Red dots are prescribed side nodes.  Q=1/4, M=1/2, T=3/4; '-' means no side node.</text>\n";
    out << "<text x=\"" << margin << "\" y=\"" << footer_y + 24.0
        << "\" class=\"footer\">The OneRing geometry is intentionally omitted: each card shows only the unresolved boundary state.</text>\n";
  }
  out << "</svg>\n";
}

} // namespace

int main(int argc, char** argv)
{
  const std::string output_path = argc > 1 ? argv[1] : "empty_template_gaps.svg";
  std::set<Pattern> canonical_cases;
  std::size_t fallback_state_count = 0;
  for (int south = 0; south < 5; ++south) {
    for (int east = 0; east < 5; ++east) {
      for (int north = 0; north < 5; ++north) {
        for (int west = 0; west < 5; ++west) {
          const Pattern pattern{south, east, north, west};
          const std::size_t boundary_nodes = 4
              + side_patterns[static_cast<std::size_t>(south)].size()
              + side_patterns[static_cast<std::size_t>(east)].size()
              + side_patterns[static_cast<std::size_t>(north)].size()
              + side_patterns[static_cast<std::size_t>(west)].size();
          if (boundary_nodes % 2 != 0 || !is_fallback(pattern)) {
            continue;
          }
          ++fallback_state_count;
          canonical_cases.insert(canonical(pattern));
        }
      }
    }
  }

  std::size_t represented_states = 0;
  for (const Pattern& pattern : canonical_cases) {
    const std::set<Pattern> symmetric_cases = orbit(pattern);
    represented_states += symmetric_cases.size();
    if (!std::all_of(symmetric_cases.begin(), symmetric_cases.end(), is_fallback)) {
      std::cerr << "template selection is not invariant under square symmetry\n";
      return 1;
    }
  }
  if (represented_states != fallback_state_count) {
    std::cerr << "canonical orbits represent " << represented_states << " states, expected "
              << fallback_state_count << '\n';
    return 1;
  }

  const std::vector<Pattern> cases(canonical_cases.begin(), canonical_cases.end());
  write_svg(output_path, cases, fallback_state_count);
  std::cout << "wrote " << output_path << " with " << cases.size()
            << " canonical cases representing " << fallback_state_count << " states\n";
  return 0;
}
