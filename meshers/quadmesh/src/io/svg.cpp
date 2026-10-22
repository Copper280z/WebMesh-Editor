#include "quadmesh/svg.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <numbers>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace quadmesh {
namespace {

constexpr double pi = std::numbers::pi_v<double>;

struct Matrix {
  double a = 1.0;
  double b = 0.0;
  double c = 0.0;
  double d = 1.0;
  double e = 0.0;
  double f = 0.0;
};

Point2 apply(Matrix m, Point2 p)
{
  return {m.a * p.x + m.c * p.y + m.e, m.b * p.x + m.d * p.y + m.f};
}

// Returns lhs * rhs, i.e. rhs is applied to a point first.
Matrix multiply(Matrix lhs, Matrix rhs)
{
  return {lhs.a * rhs.a + lhs.c * rhs.b, lhs.b * rhs.a + lhs.d * rhs.b,
          lhs.a * rhs.c + lhs.c * rhs.d, lhs.b * rhs.c + lhs.d * rhs.d,
          lhs.a * rhs.e + lhs.c * rhs.f + lhs.e,
          lhs.b * rhs.e + lhs.d * rhs.f + lhs.f};
}

std::string lower(std::string value)
{
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return value;
}

void skip_separators(std::string_view text, std::size_t& pos)
{
  while (pos < text.size() &&
         (std::isspace(static_cast<unsigned char>(text[pos])) || text[pos] == ',')) {
    ++pos;
  }
}

bool number(std::string_view text, std::size_t& pos, double& value)
{
  skip_separators(text, pos);
  if (pos == text.size()) {
    return false;
  }
  const char* begin = text.data() + pos;
  char* end = nullptr;
  value = std::strtod(begin, &end);
  if (end == begin) {
    return false;
  }
  pos = static_cast<std::size_t>(end - text.data());
  return std::isfinite(value);
}

double required_number(std::string_view text, std::size_t& pos, std::string_view what)
{
  double value = 0.0;
  if (!number(text, pos, value)) {
    throw std::runtime_error("SVG: expected " + std::string(what));
  }
  return value;
}

Matrix parse_transform(std::string_view text)
{
  Matrix result;
  std::size_t pos = 0;
  while (true) {
    skip_separators(text, pos);
    if (pos == text.size()) {
      return result;
    }
    const std::size_t name_begin = pos;
    while (pos < text.size() && std::isalpha(static_cast<unsigned char>(text[pos]))) {
      ++pos;
    }
    const std::string name = lower(std::string(text.substr(name_begin, pos - name_begin)));
    skip_separators(text, pos);
    if (name.empty() || pos == text.size() || text[pos++] != '(') {
      throw std::runtime_error("SVG: malformed transform");
    }
    const std::size_t end = text.find(')', pos);
    if (end == std::string_view::npos) {
      throw std::runtime_error("SVG: unterminated transform");
    }
    const std::string_view values = text.substr(pos, end - pos);
    pos = end + 1;
    std::size_t value_pos = 0;
    std::vector<double> v;
    double item = 0.0;
    while (number(values, value_pos, item)) {
      v.push_back(item);
    }
    Matrix next;
    if (name == "matrix" && v.size() == 6) {
      next = {v[0], v[1], v[2], v[3], v[4], v[5]};
    } else if (name == "translate" && (v.size() == 1 || v.size() == 2)) {
      next.e = v[0];
      next.f = v.size() == 2 ? v[1] : 0.0;
    } else if (name == "scale" && (v.size() == 1 || v.size() == 2)) {
      next.a = v[0];
      next.d = v.size() == 2 ? v[1] : v[0];
    } else if (name == "rotate" && (v.size() == 1 || v.size() == 3)) {
      const double radians = v[0] * pi / 180.0;
      next.a = std::cos(radians);
      next.b = std::sin(radians);
      next.c = -next.b;
      next.d = next.a;
      if (v.size() == 3) {
        next.e = v[1] - next.a * v[1] - next.c * v[2];
        next.f = v[2] - next.b * v[1] - next.d * v[2];
      }
    } else if (name == "skewx" && v.size() == 1) {
      next.c = std::tan(v[0] * pi / 180.0);
    } else if (name == "skewy" && v.size() == 1) {
      next.b = std::tan(v[0] * pi / 180.0);
    } else {
      throw std::runtime_error("SVG: unsupported or malformed transform '" + name + "'");
    }
    result = multiply(result, next);
  }
}

using Attributes = std::unordered_map<std::string, std::string>;

Attributes attributes(std::string_view tag)
{
  Attributes result;
  std::size_t pos = 0;
  while (pos < tag.size() && !std::isspace(static_cast<unsigned char>(tag[pos]))) {
    ++pos;
  }
  while (pos < tag.size()) {
    while (pos < tag.size() && std::isspace(static_cast<unsigned char>(tag[pos]))) {
      ++pos;
    }
    if (pos == tag.size() || tag[pos] == '/') {
      break;
    }
    const std::size_t name_begin = pos;
    while (pos < tag.size() && !std::isspace(static_cast<unsigned char>(tag[pos])) &&
           tag[pos] != '=' && tag[pos] != '/') {
      ++pos;
    }
    const std::string name = lower(std::string(tag.substr(name_begin, pos - name_begin)));
    while (pos < tag.size() && std::isspace(static_cast<unsigned char>(tag[pos]))) {
      ++pos;
    }
    if (name.empty() || pos == tag.size() || tag[pos++] != '=') {
      throw std::runtime_error("SVG: malformed attribute");
    }
    while (pos < tag.size() && std::isspace(static_cast<unsigned char>(tag[pos]))) {
      ++pos;
    }
    if (pos == tag.size() || (tag[pos] != '\'' && tag[pos] != '"')) {
      throw std::runtime_error("SVG: expected quoted attribute");
    }
    const char quote = tag[pos++];
    const std::size_t value_begin = pos;
    while (pos < tag.size() && tag[pos] != quote) {
      ++pos;
    }
    if (pos == tag.size()) {
      throw std::runtime_error("SVG: unterminated attribute");
    }
    result.emplace(name, std::string(tag.substr(value_begin, pos - value_begin)));
    ++pos;
  }
  return result;
}

void parse_style(const std::string& style, Attributes& attrs)
{
  std::size_t pos = 0;
  while (pos < style.size()) {
    const std::size_t colon = style.find(':', pos);
    if (colon == std::string::npos) {
      return;
    }
    const std::size_t semicolon = style.find(';', colon + 1);
    const std::size_t end = semicolon == std::string::npos ? style.size() : semicolon;
    const auto trim = [](std::string_view value) {
      while (!value.empty() && std::isspace(static_cast<unsigned char>(value.front()))) {
        value.remove_prefix(1);
      }
      while (!value.empty() && std::isspace(static_cast<unsigned char>(value.back()))) {
        value.remove_suffix(1);
      }
      return std::string(value);
    };
    attrs[lower(trim(std::string_view(style).substr(pos, colon - pos)))] =
        trim(std::string_view(style).substr(colon + 1, end - colon - 1));
    pos = end + 1;
  }
}

double attribute_number(const Attributes& attrs, std::string_view name, double fallback = 0.0)
{
  const auto it = attrs.find(std::string(name));
  if (it == attrs.end()) {
    return fallback;
  }
  std::size_t pos = 0;
  const double value = required_number(it->second, pos, name);
  return value;
}

double point_line_distance(Point2 p, Point2 a, Point2 b)
{
  const Vec2 ab = b - a;
  const double len = length(ab);
  return len == 0.0 ? distance(p, a) : std::abs(cross(ab, p - a)) / len;
}

void flatten_cubic(std::vector<Point2>& out, Point2 a, Point2 b, Point2 c, Point2 d,
                   double tolerance, int depth = 0)
{
  if (depth == 20 || std::max(point_line_distance(b, a, d), point_line_distance(c, a, d)) <= tolerance) {
    out.push_back(d);
    return;
  }
  const Point2 ab = {(a.x + b.x) / 2.0, (a.y + b.y) / 2.0};
  const Point2 bc = {(b.x + c.x) / 2.0, (b.y + c.y) / 2.0};
  const Point2 cd = {(c.x + d.x) / 2.0, (c.y + d.y) / 2.0};
  const Point2 abc = {(ab.x + bc.x) / 2.0, (ab.y + bc.y) / 2.0};
  const Point2 bcd = {(bc.x + cd.x) / 2.0, (bc.y + cd.y) / 2.0};
  const Point2 mid = {(abc.x + bcd.x) / 2.0, (abc.y + bcd.y) / 2.0};
  flatten_cubic(out, a, ab, abc, mid, tolerance, depth + 1);
  flatten_cubic(out, mid, bcd, cd, d, tolerance, depth + 1);
}

void flatten_quadratic(std::vector<Point2>& out, Point2 a, Point2 b, Point2 c,
                       double tolerance, int depth = 0)
{
  if (depth == 20 || point_line_distance(b, a, c) <= tolerance) {
    out.push_back(c);
    return;
  }
  const Point2 ab = {(a.x + b.x) / 2.0, (a.y + b.y) / 2.0};
  const Point2 bc = {(b.x + c.x) / 2.0, (b.y + c.y) / 2.0};
  const Point2 mid = {(ab.x + bc.x) / 2.0, (ab.y + bc.y) / 2.0};
  flatten_quadratic(out, a, ab, mid, tolerance, depth + 1);
  flatten_quadratic(out, mid, bc, c, tolerance, depth + 1);
}

void flatten_arc(std::vector<Point2>& out, Point2 from, double rx, double ry,
                 double rotation_deg, bool large_arc, bool sweep, Point2 to,
                 double tolerance)
{
  if (nearly_equal(from, to, 1.0e-14) || rx == 0.0 || ry == 0.0) {
    out.push_back(to);
    return;
  }
  rx = std::abs(rx);
  ry = std::abs(ry);
  const double phi = rotation_deg * pi / 180.0;
  const double cos_phi = std::cos(phi);
  const double sin_phi = std::sin(phi);
  const double dx = (from.x - to.x) / 2.0;
  const double dy = (from.y - to.y) / 2.0;
  const double xp = cos_phi * dx + sin_phi * dy;
  const double yp = -sin_phi * dx + cos_phi * dy;
  double radius_scale = xp * xp / (rx * rx) + yp * yp / (ry * ry);
  if (radius_scale > 1.0) {
    radius_scale = std::sqrt(radius_scale);
    rx *= radius_scale;
    ry *= radius_scale;
  }
  const double numerator = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const double denominator = rx * rx * yp * yp + ry * ry * xp * xp;
  const double sign = large_arc == sweep ? -1.0 : 1.0;
  const double factor = denominator == 0.0 ? 0.0 : sign * std::sqrt(std::max(0.0, numerator / denominator));
  const double cxp = factor * rx * yp / ry;
  const double cyp = factor * -ry * xp / rx;
  const Point2 center{cos_phi * cxp - sin_phi * cyp + (from.x + to.x) / 2.0,
                      sin_phi * cxp + cos_phi * cyp + (from.y + to.y) / 2.0};
  const auto angle = [](double ux, double uy, double vx, double vy) {
    return std::atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  };
  const double ux = (xp - cxp) / rx;
  const double uy = (yp - cyp) / ry;
  const double vx = (-xp - cxp) / rx;
  const double vy = (-yp - cyp) / ry;
  const double start = std::atan2(uy, ux);
  double span = angle(ux, uy, vx, vy);
  if (!sweep && span > 0.0) {
    span -= 2.0 * pi;
  } else if (sweep && span < 0.0) {
    span += 2.0 * pi;
  }
  const double safe_tolerance = std::max(tolerance, 1.0e-12);
  const double r = std::max(rx, ry);
  const double max_step = r <= safe_tolerance ? pi / 2.0
      : 2.0 * std::acos(std::clamp(1.0 - safe_tolerance / r, -1.0, 1.0));
  const int count = std::max(1, static_cast<int>(std::ceil(std::abs(span) / std::max(max_step, pi / 180.0))));
  for (int i = 1; i <= count; ++i) {
    const double theta = start + span * static_cast<double>(i) / static_cast<double>(count);
    const double x = rx * std::cos(theta);
    const double y = ry * std::sin(theta);
    out.push_back({center.x + cos_phi * x - sin_phi * y,
                   center.y + sin_phi * x + cos_phi * y});
  }
}

std::vector<PolylineLoop> path_loops(std::string_view text, double tolerance,
                                     std::vector<std::string>& warnings)
{
  std::vector<PolylineLoop> loops;
  std::vector<Point2> points;
  Point2 current{};
  Point2 subpath_start{};
  Point2 last_control{};
  char command = '\0';
  char previous_command = '\0';
  std::size_t pos = 0;
  const auto finish = [&](bool closed) {
    if (points.empty()) {
      return;
    }
    if (closed && points.size() >= 3) {
      if (nearly_equal(points.front(), points.back(), 1.0e-12)) {
        points.pop_back();
      }
      loops.push_back({std::move(points), true});
    } else {
      warnings.push_back("SVG: ignored an open or degenerate path subpath");
    }
    points.clear();
  };
  const auto coordinate = [&](bool relative) {
    Point2 p{required_number(text, pos, "x coordinate"), required_number(text, pos, "y coordinate")};
    if (relative) {
      p = p + (current - Point2{});
    }
    return p;
  };
  while (true) {
    skip_separators(text, pos);
    if (pos == text.size()) {
      break;
    }
    if (std::isalpha(static_cast<unsigned char>(text[pos]))) {
      command = text[pos++];
    } else if (command == '\0') {
      throw std::runtime_error("SVG: path data does not begin with a command");
    }
    const bool relative = std::islower(static_cast<unsigned char>(command));
    const char op = static_cast<char>(std::toupper(static_cast<unsigned char>(command)));
    if (op == 'Z') {
      finish(true);
      current = subpath_start;
      previous_command = op;
      command = '\0';
      continue;
    }
    if (op == 'M') {
      const Point2 p = coordinate(relative);
      finish(false);
      current = p;
      subpath_start = p;
      points.push_back(p);
      command = relative ? 'l' : 'L';
      previous_command = 'M';
      continue;
    }
    if (points.empty()) {
      throw std::runtime_error("SVG: path drawing command appears before moveto");
    }
    if (op == 'L') {
      current = coordinate(relative);
      points.push_back(current);
    } else if (op == 'H') {
      const double x = required_number(text, pos, "horizontal coordinate");
      current.x = relative ? current.x + x : x;
      points.push_back(current);
    } else if (op == 'V') {
      const double y = required_number(text, pos, "vertical coordinate");
      current.y = relative ? current.y + y : y;
      points.push_back(current);
    } else if (op == 'C') {
      const Point2 a = coordinate(relative);
      const Point2 b = coordinate(relative);
      const Point2 end = coordinate(relative);
      flatten_cubic(points, current, a, b, end, tolerance);
      current = end;
      last_control = b;
    } else if (op == 'S') {
      const Point2 a = previous_command == 'C' || previous_command == 'S'
          ? current + (current - last_control) : current;
      const Point2 b = coordinate(relative);
      const Point2 end = coordinate(relative);
      flatten_cubic(points, current, a, b, end, tolerance);
      current = end;
      last_control = b;
    } else if (op == 'Q') {
      const Point2 a = coordinate(relative);
      const Point2 end = coordinate(relative);
      flatten_quadratic(points, current, a, end, tolerance);
      current = end;
      last_control = a;
    } else if (op == 'T') {
      const Point2 a = previous_command == 'Q' || previous_command == 'T'
          ? current + (current - last_control) : current;
      const Point2 end = coordinate(relative);
      flatten_quadratic(points, current, a, end, tolerance);
      current = end;
      last_control = a;
    } else if (op == 'A') {
      const double rx = required_number(text, pos, "arc radius");
      const double ry = required_number(text, pos, "arc radius");
      const double rotation = required_number(text, pos, "arc rotation");
      const double large = required_number(text, pos, "arc flag");
      const double sweep = required_number(text, pos, "arc flag");
      const Point2 end = coordinate(relative);
      if ((large != 0.0 && large != 1.0) || (sweep != 0.0 && sweep != 1.0)) {
        throw std::runtime_error("SVG: arc flags must be zero or one");
      }
      flatten_arc(points, current, rx, ry, rotation, large != 0.0, sweep != 0.0, end, tolerance);
      current = end;
    } else {
      throw std::runtime_error("SVG: unsupported path command");
    }
    previous_command = op;
  }
  finish(false);
  return loops;
}

std::vector<Point2> parse_points(std::string_view text)
{
  std::vector<Point2> result;
  std::size_t pos = 0;
  while (true) {
    skip_separators(text, pos);
    if (pos == text.size()) {
      return result;
    }
    const double x = required_number(text, pos, "polygon x coordinate");
    const double y = required_number(text, pos, "polygon y coordinate");
    result.push_back({x, y});
  }
}

void transform_loop(PolylineLoop& loop, Matrix transform)
{
  for (Point2& p : loop.vertices) {
    p = apply(transform, p);
  }
}

void simplify_loop(PolylineLoop& loop)
{
  std::vector<Point2> simplified;
  simplified.reserve(loop.vertices.size());
  for (const Point2 point : loop.vertices) {
    if (simplified.empty() || !nearly_equal(simplified.back(), point, 1.0e-12)) {
      simplified.push_back(point);
    }
  }
  if (simplified.size() > 1 && nearly_equal(simplified.front(), simplified.back(), 1.0e-12)) {
    simplified.pop_back();
  }
  loop.vertices = std::move(simplified);
}

struct Style {
  Matrix transform;
  std::string fill = "black";
  bool visible = true;
};

Style child_style(const Style& parent, Attributes attrs)
{
  if (const auto it = attrs.find("style"); it != attrs.end()) {
    parse_style(it->second, attrs);
  }
  Style result = parent;
  if (const auto it = attrs.find("transform"); it != attrs.end()) {
    result.transform = multiply(parent.transform, parse_transform(it->second));
  }
  if (const auto it = attrs.find("fill"); it != attrs.end()) {
    result.fill = lower(it->second);
  }
  if (const auto it = attrs.find("display"); it != attrs.end() && lower(it->second) == "none") {
    result.visible = false;
  }
  if (const auto it = attrs.find("visibility"); it != attrs.end() && lower(it->second) == "hidden") {
    result.visible = false;
  }
  return result;
}

bool is_container(std::string_view name)
{
  return name == "svg" || name == "g" || name == "a" || name == "switch" ||
      name == "defs" || name == "clippath" || name == "mask" || name == "symbol" ||
      name == "pattern" || name == "marker";
}

bool is_definition_container(std::string_view name)
{
  return name == "defs" || name == "clippath" || name == "mask" || name == "symbol" ||
      name == "pattern" || name == "marker";
}

struct IndexedSegment {
  Segment2 segment;
  std::size_t loop = 0;
  std::size_t index = 0;
};

bool segments_conflict(Segment2 a, Segment2 b, double epsilon)
{
  if (intersect_segments(a, b, epsilon)) {
    return true;
  }
  return distance_to_segment(a.a, b) <= epsilon || distance_to_segment(a.b, b) <= epsilon ||
      distance_to_segment(b.a, a) <= epsilon || distance_to_segment(b.b, a) <= epsilon;
}

SvgTopologyReport inspect_topology(const DomainGeometry& domain)
{
  SvgTopologyReport report;
  const Aabb2 bounds = bounds_of(domain);
  const double extent = std::max(max_extent(bounds), 1.0);
  const double epsilon = std::max(1.0e-9, extent * 1.0e-9);
  std::vector<IndexedSegment> segments;
  std::vector<std::size_t> loop_segment_counts;
  for (std::size_t loop = 0; loop < domain.outer_loops.size(); ++loop) {
    const std::vector<Segment2> loop_segments_value = loop_segments(domain.outer_loops[loop]);
    loop_segment_counts.push_back(loop_segments_value.size());
    for (std::size_t index = 0; index < loop_segments_value.size(); ++index) {
      segments.push_back({loop_segments_value[index], loop, index});
    }
  }
  report.segment_count = segments.size();
  if (segments.empty()) {
    return report;
  }

  constexpr int cells_per_axis = 64;
  std::array<std::vector<std::size_t>, cells_per_axis * cells_per_axis> grid;
  const auto clamp_cell = [](int cell) {
    return std::clamp(cell, 0, cells_per_axis - 1);
  };
  const auto x_cell = [&](double x) {
    return clamp_cell(static_cast<int>(std::floor((x - bounds.min.x) / extent * cells_per_axis)));
  };
  const auto y_cell = [&](double y) {
    return clamp_cell(static_cast<int>(std::floor((y - bounds.min.y) / extent * cells_per_axis)));
  };
  for (std::size_t i = 0; i < segments.size(); ++i) {
    const Segment2 segment = segments[i].segment;
    const int min_x = x_cell(std::min(segment.a.x, segment.b.x));
    const int max_x = x_cell(std::max(segment.a.x, segment.b.x));
    const int min_y = y_cell(std::min(segment.a.y, segment.b.y));
    const int max_y = y_cell(std::max(segment.a.y, segment.b.y));
    for (int y = min_y; y <= max_y; ++y) {
      for (int x = min_x; x <= max_x; ++x) {
        grid[static_cast<std::size_t>(y * cells_per_axis + x)].push_back(i);
      }
    }
  }
  constexpr std::size_t issue_limit = 8;
  std::unordered_set<std::uint64_t> reported_pairs;
  for (const std::vector<std::size_t>& bucket : grid) {
    for (std::size_t i = 0; i < bucket.size(); ++i) {
      const IndexedSegment& first = segments[bucket[i]];
      for (std::size_t j = 0; j < i; ++j) {
        const IndexedSegment& second = segments[bucket[j]];
        if (first.loop == second.loop) {
          const std::size_t count = loop_segment_counts[first.loop];
          const std::size_t delta = first.index > second.index ? first.index - second.index
                                                               : second.index - first.index;
          if (delta <= 1 || delta + 1 == count) {
            continue; // adjacent polygon edges meet at their shared endpoint.
          }
        }
        if (!segments_conflict(first.segment, second.segment, epsilon)) {
          continue;
        }
        const std::size_t first_id = bucket[i];
        const std::size_t second_id = bucket[j];
        const std::uint64_t pair = (static_cast<std::uint64_t>(std::min(first_id, second_id)) << 32U) |
            static_cast<std::uint64_t>(std::max(first_id, second_id));
        if (!reported_pairs.insert(pair).second) {
          continue;
        }
        ++report.conflict_count;
        if (first.loop == second.loop) {
          report.issues.push_back("loop " + std::to_string(first.loop + 1) +
                                  " crosses or touches itself");
        } else {
          report.issues.push_back("loops " + std::to_string(first.loop + 1) + " and " +
                                  std::to_string(second.loop + 1) +
                                  " cross or touch");
        }
        if (report.issues.size() == issue_limit) {
          return report;
        }
      }
    }
  }
  return report;
}

} // namespace

SvgImportResult read_svg(const std::string& path, const SvgImportOptions& options)
{
  if (!std::isfinite(options.curve_tolerance) || options.curve_tolerance <= 0.0) {
    throw std::runtime_error("SVG: curve_tolerance must be finite and positive");
  }
  std::ifstream file(path);
  if (!file) {
    throw std::runtime_error("SVG: cannot open '" + path + "'");
  }
  const std::string source((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
  SvgImportResult result;
  const std::optional<std::string> requested_fill = options.fill
      ? std::optional<std::string>(lower(*options.fill)) : std::nullopt;
  std::vector<Style> stack(1);
  std::size_t pos = 0;
  while (true) {
    const std::size_t open = source.find('<', pos);
    if (open == std::string::npos) {
      break;
    }
    if (source.compare(open, 4, "<!--") == 0) {
      const std::size_t end = source.find("-->", open + 4);
      if (end == std::string::npos) throw std::runtime_error("SVG: unterminated comment");
      pos = end + 3;
      continue;
    }
    const std::size_t close = source.find('>', open + 1);
    if (close == std::string::npos) throw std::runtime_error("SVG: unterminated tag");
    std::string_view tag(source.data() + open + 1, close - open - 1);
    pos = close + 1;
    if (tag.empty() || tag.front() == '?' || tag.front() == '!') {
      continue;
    }
    if (tag.front() == '/') {
      std::string name = lower(std::string(tag.substr(1)));
      while (!name.empty() && std::isspace(static_cast<unsigned char>(name.back()))) name.pop_back();
      if (is_container(name) && stack.size() > 1) {
        stack.pop_back();
      }
      continue;
    }
    const bool self_closing = tag.back() == '/';
    std::size_t name_end = 0;
    while (name_end < tag.size() && !std::isspace(static_cast<unsigned char>(tag[name_end])) &&
           tag[name_end] != '/') ++name_end;
    const std::string name = lower(std::string(tag.substr(0, name_end)));
    Attributes attrs = attributes(tag);
    const Style style = child_style(stack.back(), std::move(attrs));
    if (is_container(name)) {
      if (!self_closing) {
        Style child = style;
        if (is_definition_container(name)) child.visible = false;
        stack.push_back(std::move(child));
      }
      continue;
    }
    if (!style.visible || style.fill == "none" || (requested_fill && style.fill != *requested_fill)) {
      continue;
    }
    Attributes element_attrs = attributes(tag);
    if (const auto it = element_attrs.find("style"); it != element_attrs.end()) parse_style(it->second, element_attrs);
    std::vector<PolylineLoop> loops;
    if (name == "path") {
      const auto it = element_attrs.find("d");
      if (it == element_attrs.end()) throw std::runtime_error("SVG: path has no d attribute");
      loops = path_loops(it->second, options.curve_tolerance, result.warnings);
    } else if (name == "polygon") {
      const auto it = element_attrs.find("points");
      if (it == element_attrs.end()) throw std::runtime_error("SVG: polygon has no points attribute");
      loops.push_back({parse_points(it->second), true});
    } else if (name == "polyline") {
      result.warnings.push_back("SVG: ignored an open polyline");
    } else if (name == "rect") {
      const double x = attribute_number(element_attrs, "x");
      const double y = attribute_number(element_attrs, "y");
      const double w = attribute_number(element_attrs, "width");
      const double h = attribute_number(element_attrs, "height");
      if (w <= 0.0 || h <= 0.0) throw std::runtime_error("SVG: rect dimensions must be positive");
      double rx = std::abs(attribute_number(element_attrs, "rx"));
      double ry = std::abs(attribute_number(element_attrs, "ry"));
      if (rx == 0.0) rx = ry;
      if (ry == 0.0) ry = rx;
      rx = std::min(rx, w / 2.0);
      ry = std::min(ry, h / 2.0);
      if (rx == 0.0 || ry == 0.0) {
        loops.push_back({{{x, y}, {x + w, y}, {x + w, y + h}, {x, y + h}}, true});
      } else {
        std::vector<Point2> points{{x + rx, y}, {x + w - rx, y}};
        flatten_arc(points, points.back(), rx, ry, 0.0, false, true, {x + w, y + ry}, options.curve_tolerance);
        points.push_back({x + w, y + h - ry});
        flatten_arc(points, points.back(), rx, ry, 0.0, false, true, {x + w - rx, y + h}, options.curve_tolerance);
        points.push_back({x + rx, y + h});
        flatten_arc(points, points.back(), rx, ry, 0.0, false, true, {x, y + h - ry}, options.curve_tolerance);
        points.push_back({x, y + ry});
        flatten_arc(points, points.back(), rx, ry, 0.0, false, true, {x + rx, y}, options.curve_tolerance);
        loops.push_back({std::move(points), true});
      }
    } else if (name == "circle" || name == "ellipse") {
      const double cx = attribute_number(element_attrs, "cx");
      const double cy = attribute_number(element_attrs, "cy");
      const double rx = name == "circle" ? attribute_number(element_attrs, "r") : attribute_number(element_attrs, "rx");
      const double ry = name == "circle" ? rx : attribute_number(element_attrs, "ry");
      if (rx <= 0.0 || ry <= 0.0) throw std::runtime_error("SVG: ellipse radii must be positive");
      const int count = std::max(8, static_cast<int>(std::ceil(2.0 * pi /
          std::max(2.0 * std::acos(std::clamp(1.0 - options.curve_tolerance / std::max(rx, ry), -1.0, 1.0)), pi / 180.0))));
      PolylineLoop loop;
      loop.vertices.reserve(static_cast<std::size_t>(count));
      for (int i = 0; i < count; ++i) {
        const double theta = 2.0 * pi * static_cast<double>(i) / static_cast<double>(count);
        loop.vertices.push_back({cx + rx * std::cos(theta), cy + ry * std::sin(theta)});
      }
      loops.push_back(std::move(loop));
    }
    for (PolylineLoop& loop : loops) {
      transform_loop(loop, style.transform);
      simplify_loop(loop);
      if (loop.vertices.size() >= 3) {
        result.domain.outer_loops.push_back(std::move(loop));
      } else {
        result.warnings.push_back("SVG: ignored a degenerate closed shape");
      }
    }
  }
  if (result.domain.outer_loops.empty()) {
    throw std::runtime_error("SVG: no supported filled closed shapes were found");
  }
  result.topology = inspect_topology(result.domain);
  return result;
}

} // namespace quadmesh
