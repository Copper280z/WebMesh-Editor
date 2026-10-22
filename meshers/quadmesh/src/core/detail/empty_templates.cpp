#include "detail/empty_templates.hpp"

#include <algorithm>
#include <cstddef>
#include <cmath>
#include <iterator>
#include <limits>
#include <numbers>
#include <utility>

namespace quadmesh::detail {
namespace {

constexpr double min_contract_angle = 20.0;
constexpr double max_contract_angle = 160.0;
constexpr double min_contract_scaled_jacobian = 0.3;
constexpr double min_contract_edge_ratio = 0.1;

Point2 bilinear(const std::array<Point2, 4>& corners, double u, double v)
{
  const double w0 = (1.0 - u) * (1.0 - v);
  const double w1 = u * (1.0 - v);
  const double w2 = u * v;
  const double w3 = (1.0 - u) * v;
  return {w0 * corners[0].x + w1 * corners[1].x + w2 * corners[2].x + w3 * corners[3].x,
          w0 * corners[0].y + w1 * corners[1].y + w2 * corners[2].y + w3 * corners[3].y};
}

double signed_area2(const std::array<int, 4>& quad, const std::vector<Point2>& points)
{
  double area2 = 0.0;
  for (int i = 0; i < 4; ++i) {
    const Point2 a = points[static_cast<std::size_t>(quad[i])];
    const Point2 b = points[static_cast<std::size_t>(quad[(i + 1) % 4])];
    area2 += cross({a.x, a.y}, {b.x, b.y});
  }
  return area2;
}

void orient_ccw(std::array<int, 4>& quad, const std::vector<Point2>& points)
{
  if (signed_area2(quad, points) < 0.0) {
    std::swap(quad[1], quad[3]);
  }
}

EmptyTemplateQuality evaluate(const std::vector<Point2>& points,
                              const std::vector<std::array<int, 4>>& quads)
{
  EmptyTemplateQuality quality;
  quality.min_angle_deg = std::numeric_limits<double>::max();
  quality.max_angle_deg = 0.0;
  quality.min_scaled_jacobian = std::numeric_limits<double>::max();
  quality.min_edge_ratio = std::numeric_limits<double>::max();
  for (const std::array<int, 4>& quad : quads) {
    double shortest = std::numeric_limits<double>::max();
    double longest = 0.0;
    for (int k = 0; k < 4; ++k) {
      const Point2 at = points[static_cast<std::size_t>(quad[k])];
      const Point2 next = points[static_cast<std::size_t>(quad[(k + 1) % 4])];
      const Point2 prev = points[static_cast<std::size_t>(quad[(k + 3) % 4])];
      const Vec2 e1 = next - at;
      const Vec2 e2 = prev - at;
      const double l1 = length(e1);
      const double l2 = length(e2);
      shortest = std::min(shortest, l1);
      longest = std::max(longest, l1);
      const double denominator = l1 * l2;
      const double scaled = denominator > 0.0 ? cross(e1, e2) / denominator : -1.0;
      quality.min_scaled_jacobian = std::min(quality.min_scaled_jacobian, scaled);
      double angle = std::atan2(cross(e1, e2), dot(e1, e2)) * 180.0 / std::numbers::pi_v<double>;
      if (angle < 0.0) {
        angle += 360.0;
      }
      quality.min_angle_deg = std::min(quality.min_angle_deg, angle);
      quality.max_angle_deg = std::max(quality.max_angle_deg, angle);
    }
    quality.min_edge_ratio =
        std::min(quality.min_edge_ratio, longest > 0.0 ? shortest / longest : 0.0);
  }
  return quality;
}

bool meets_contract(const EmptyTemplateQuality& quality)
{
  constexpr double eps = 1.0e-10;
  return quality.min_angle_deg + eps >= min_contract_angle
         && quality.max_angle_deg <= max_contract_angle + eps
         && quality.min_scaled_jacobian + eps >= min_contract_scaled_jacobian
         && quality.min_edge_ratio + eps >= min_contract_edge_ratio;
}

double contract_margin(const EmptyTemplateQuality& quality)
{
  return std::min({quality.min_angle_deg / min_contract_angle,
                   (180.0 - quality.max_angle_deg) / (180.0 - max_contract_angle),
                   quality.min_scaled_jacobian / min_contract_scaled_jacobian,
                   quality.min_edge_ratio / min_contract_edge_ratio});
}

void finish_candidate(EmptyTemplatePlan& candidate, const std::vector<Point2>& boundary)
{
  std::vector<Point2> points = boundary;
  points.insert(points.end(), candidate.interior.begin(), candidate.interior.end());
  for (std::array<int, 4>& quad : candidate.quads) {
    orient_ccw(quad, points);
  }
  candidate.quality = evaluate(points, candidate.quads);
  candidate.meets_quality_contract = meets_contract(candidate.quality);
}

bool better_than(const EmptyTemplatePlan& candidate, const EmptyTemplatePlan& current)
{
  if (candidate.meets_quality_contract != current.meets_quality_contract) {
    return candidate.meets_quality_contract;
  }
  if (candidate.meets_quality_contract && candidate.quads.size() != current.quads.size()) {
    return candidate.quads.size() < current.quads.size();
  }
  const double candidate_margin = contract_margin(candidate.quality);
  const double current_margin = contract_margin(current.quality);
  if (std::abs(candidate_margin - current_margin) > 1.0e-12) {
    return candidate_margin > current_margin;
  }
  if (candidate.quality.min_scaled_jacobian != current.quality.min_scaled_jacobian) {
    return candidate.quality.min_scaled_jacobian > current.quality.min_scaled_jacobian;
  }
  return candidate.quality.min_edge_ratio > current.quality.min_edge_ratio;
}

// The atomic side topology of a strongly balanced cell has dyadic positions
// 0, 1/4, 1/2, 3/4, 1. Work in those integer coordinates so the recursive
// search is finite and its failure is a certificate that no decomposition in
// this split grammar exists.
constexpr int split_resolution = 4;

struct SplitSideNode {
  int coordinate = 0;
  int node = -1;
};

struct SplitCell {
  int x0 = 0;
  int x1 = split_resolution;
  int y0 = 0;
  int y1 = split_resolution;
  std::array<int, 4> corners{}; // SW, SE, NE, NW
  // South/north coordinates are x; east/west coordinates are y. Stored in
  // increasing lattice order, independently of the boundary-walk direction.
  std::array<std::vector<SplitSideNode>, 4> sides;
};

struct SplitWorkingPlan {
  std::vector<Point2> points; // root boundary first, then internal points
  std::vector<std::array<int, 4>> quads;
};

int split_midpoint(int a, int b)
{
  return (a + b) % 2 == 0 ? (a + b) / 2 : -1;
}

const SplitSideNode* split_node_at(const std::vector<SplitSideNode>& side, int coordinate)
{
  const auto found = std::find_if(side.begin(), side.end(), [&](const SplitSideNode& node) {
    return node.coordinate == coordinate;
  });
  return found == side.end() ? nullptr : &*found;
}

std::vector<SplitSideNode> split_nodes_below(const std::vector<SplitSideNode>& side, int value)
{
  std::vector<SplitSideNode> result;
  std::copy_if(side.begin(), side.end(), std::back_inserter(result),
               [&](const SplitSideNode& node) { return node.coordinate < value; });
  return result;
}

std::vector<SplitSideNode> split_nodes_above(const std::vector<SplitSideNode>& side, int value)
{
  std::vector<SplitSideNode> result;
  std::copy_if(side.begin(), side.end(), std::back_inserter(result),
               [&](const SplitSideNode& node) { return node.coordinate > value; });
  return result;
}

std::vector<std::vector<int>> split_interface_patterns(int lo, int hi)
{
  std::vector<std::vector<int>> result{{}};
  const int middle = split_midpoint(lo, hi);
  if (middle < 0) {
    return result;
  }
  result.push_back({middle});
  if ((hi - lo) % 4 == 0) {
    const int quarter = lo + (hi - lo) / 4;
    const int three_quarters = lo + 3 * (hi - lo) / 4;
    result.push_back({quarter, middle});
    result.push_back({middle, three_quarters});
    result.push_back({quarter, middle, three_quarters});
  }
  return result;
}

Point2 split_center(const SplitCell& cell, const SplitWorkingPlan& plan)
{
  Point2 center{0.0, 0.0};
  for (const int corner : cell.corners) {
    center.x += plan.points[static_cast<std::size_t>(corner)].x;
    center.y += plan.points[static_cast<std::size_t>(corner)].y;
  }
  center.x *= 0.25;
  center.y *= 0.25;
  return center;
}

bool primitive_meets_contract(SplitWorkingPlan& plan, std::vector<std::array<int, 4>> primitive)
{
  for (std::array<int, 4>& quad : primitive) {
    orient_ccw(quad, plan.points);
  }
  if (!meets_contract(evaluate(plan.points, primitive))) {
    return false;
  }
  plan.quads.insert(plan.quads.end(), primitive.begin(), primitive.end());
  return true;
}

bool try_split_primitive(const SplitCell& cell, SplitWorkingPlan& plan)
{
  std::size_t side_node_count = 0;
  for (const auto& side : cell.sides) {
    side_node_count += side.size();
  }
  if (side_node_count == 0) {
    return primitive_meets_contract(
        plan, {{cell.corners[0], cell.corners[1], cell.corners[2], cell.corners[3]}});
  }

  const int x_mid = split_midpoint(cell.x0, cell.x1);
  const int y_mid = split_midpoint(cell.y0, cell.y1);
  if (x_mid < 0 || y_mid < 0) {
    return false;
  }
  std::array<int, 4> mids{-1, -1, -1, -1};
  for (int side = 0; side < 4; ++side) {
    const int coordinate = side % 2 == 0 ? x_mid : y_mid;
    if (cell.sides[static_cast<std::size_t>(side)].size() == 1
        && cell.sides[static_cast<std::size_t>(side)].front().coordinate == coordinate) {
      mids[static_cast<std::size_t>(side)] =
          cell.sides[static_cast<std::size_t>(side)].front().node;
    }
  }

  if (side_node_count == 2) {
    for (int corner = 0; corner < 4; ++corner) {
      const int previous_side = (corner + 3) % 4;
      if (mids[static_cast<std::size_t>(corner)] < 0
          || mids[static_cast<std::size_t>(previous_side)] < 0) {
        continue;
      }
      SplitWorkingPlan candidate = plan;
      const int center = static_cast<int>(candidate.points.size());
      candidate.points.push_back(split_center(cell, candidate));
      const int next_corner = (corner + 1) % 4;
      const int opposite_corner = (corner + 2) % 4;
      const int previous_corner = (corner + 3) % 4;
      std::vector<std::array<int, 4>> quads{
          {cell.corners[static_cast<std::size_t>(opposite_corner)],
           cell.corners[static_cast<std::size_t>(next_corner)],
           mids[static_cast<std::size_t>(corner)], center},
          {mids[static_cast<std::size_t>(corner)],
           cell.corners[static_cast<std::size_t>(corner)],
           mids[static_cast<std::size_t>(previous_side)], center},
          {cell.corners[static_cast<std::size_t>(opposite_corner)], center,
           mids[static_cast<std::size_t>(previous_side)],
           cell.corners[static_cast<std::size_t>(previous_corner)]},
      };
      if (primitive_meets_contract(candidate, std::move(quads))) {
        plan = std::move(candidate);
        return true;
      }
    }
    return false;
  }

  if (side_node_count == 4
      && std::all_of(mids.begin(), mids.end(), [](int node) { return node >= 0; })) {
    SplitWorkingPlan candidate = plan;
    const int center = static_cast<int>(candidate.points.size());
    candidate.points.push_back(split_center(cell, candidate));
    std::vector<std::array<int, 4>> quads;
    for (int corner = 0; corner < 4; ++corner) {
      quads.push_back(
          {cell.corners[static_cast<std::size_t>(corner)],
           mids[static_cast<std::size_t>(corner)], center,
           mids[static_cast<std::size_t>((corner + 3) % 4)]});
    }
    if (primitive_meets_contract(candidate, std::move(quads))) {
      plan = std::move(candidate);
      return true;
    }
  }
  return false;
}

Point2 split_bilinear(const SplitCell& cell, const SplitWorkingPlan& plan,
                      double u, double v)
{
  std::array<Point2, 4> corners;
  for (int corner = 0; corner < 4; ++corner) {
    corners[static_cast<std::size_t>(corner)] =
        plan.points[static_cast<std::size_t>(cell.corners[static_cast<std::size_t>(corner)])];
  }
  return bilinear(corners, u, v);
}

// Exact seven-quad template for the bounded state with quarter/mid/quarter
// nodes on one side and a midpoint on one adjacent side. In local coordinates
// based at the common corner (u follows the adjacent side and v follows the
// full side), the four interior nodes are
//
//   p1=(1/2,1/4), p2=(1/2,1/2), p3=(3/4,3/4), q=(3/4,1/4).
//
// Four quads form the graded strip against the full side. The residual
// six-node region is the paper's 3-quad template, connected through q. This is
// the drawn construction: it avoids both a radial ring and the long diagonal
// produced by independently refining two children of a root 3-ref template.
bool try_adjacent_midpoint_full_side(const SplitCell& cell, SplitWorkingPlan& plan)
{
  constexpr std::array<Point2, 4> logical_corners{
      Point2{0.0, 0.0}, Point2{1.0, 0.0}, Point2{1.0, 1.0}, Point2{0.0, 1.0}};
  for (int full_side = 0; full_side < 4; ++full_side) {
    const int lo = full_side % 2 == 0 ? cell.x0 : cell.y0;
    const int hi = full_side % 2 == 0 ? cell.x1 : cell.y1;
    if ((hi - lo) % 4 != 0
        || cell.sides[static_cast<std::size_t>(full_side)].size() != 3) {
      continue;
    }
    const int quarter_coordinate = lo + (hi - lo) / 4;
    const int midpoint_coordinate = lo + (hi - lo) / 2;
    const int three_quarter_coordinate = lo + 3 * (hi - lo) / 4;
    const SplitSideNode* quarter =
        split_node_at(cell.sides[static_cast<std::size_t>(full_side)], quarter_coordinate);
    const SplitSideNode* midpoint =
        split_node_at(cell.sides[static_cast<std::size_t>(full_side)], midpoint_coordinate);
    const SplitSideNode* three_quarters =
        split_node_at(cell.sides[static_cast<std::size_t>(full_side)], three_quarter_coordinate);
    if (quarter == nullptr || midpoint == nullptr || three_quarters == nullptr) {
      continue;
    }

    for (const int adjacent_side : {(full_side + 1) % 4, (full_side + 3) % 4}) {
      const int adjacent_mid_coordinate = adjacent_side % 2 == 0
          ? split_midpoint(cell.x0, cell.x1)
          : split_midpoint(cell.y0, cell.y1);
      const SplitSideNode* adjacent_mid =
          split_node_at(cell.sides[static_cast<std::size_t>(adjacent_side)],
                        adjacent_mid_coordinate);
      if (adjacent_mid == nullptr
          || cell.sides[static_cast<std::size_t>(adjacent_side)].size() != 1) {
        continue;
      }
      bool other_sides_empty = true;
      for (int side = 0; side < 4; ++side) {
        if (side != full_side && side != adjacent_side
            && !cell.sides[static_cast<std::size_t>(side)].empty()) {
          other_sides_empty = false;
        }
      }
      if (!other_sides_empty) {
        continue;
      }

      SplitWorkingPlan candidate = plan;
      const int common_corner = adjacent_side == (full_side + 1) % 4
          ? adjacent_side
          : full_side;
      const int adjacent_far_corner = adjacent_side == common_corner
          ? (common_corner + 1) % 4
          : (common_corner + 3) % 4;
      const int full_far_corner = full_side == common_corner
          ? (common_corner + 1) % 4
          : (common_corner + 3) % 4;
      const int opposite_corner = (common_corner + 2) % 4;
      const Point2 logical_common = logical_corners[static_cast<std::size_t>(common_corner)];
      const Vec2 logical_u =
          logical_corners[static_cast<std::size_t>(adjacent_far_corner)] - logical_common;
      const Vec2 logical_v =
          logical_corners[static_cast<std::size_t>(full_far_corner)] - logical_common;
      const auto add_local_point = [&](double u, double v) {
        const Point2 logical = logical_common + logical_u * u + logical_v * v;
        const int node = static_cast<int>(candidate.points.size());
        candidate.points.push_back(split_bilinear(cell, candidate, logical.x, logical.y));
        return node;
      };
      const int p1 = add_local_point(0.5, 0.25);
      const int p2 = add_local_point(0.5, 0.5);
      const int p3 = add_local_point(0.75, 0.75);
      const int q = add_local_point(0.75, 0.25);

      const bool full_is_outgoing = full_side == common_corner;
      const bool common_at_physical_low = full_side < 2 ? full_is_outgoing : !full_is_outgoing;
      const int near_node = common_at_physical_low ? quarter->node : three_quarters->node;
      const int far_node = common_at_physical_low ? three_quarters->node : quarter->node;
      std::vector<std::array<int, 4>> quads{
          {cell.corners[static_cast<std::size_t>(common_corner)], adjacent_mid->node, p1,
           near_node},
          {near_node, p1, p2, midpoint->node},
          {midpoint->node, p2, p3, far_node},
          {far_node, p3, cell.corners[static_cast<std::size_t>(opposite_corner)],
           cell.corners[static_cast<std::size_t>(full_far_corner)]},
          {p2, p1, q, p3},
          {p1, adjacent_mid->node,
           cell.corners[static_cast<std::size_t>(adjacent_far_corner)], q},
          {p3, q, cell.corners[static_cast<std::size_t>(adjacent_far_corner)],
           cell.corners[static_cast<std::size_t>(opposite_corner)]},
      };
      if (primitive_meets_contract(candidate, std::move(quads))) {
        plan = std::move(candidate);
        return true;
      }
    }
  }
  return false;
}

// Exact ten-quad template for the state drawn in the local-sizing example:
// one side has its quarter and midpoint nodes, both adjacent sides have their
// midpoint, and the opposite side is empty. Local coordinates start at the
// quarter-node end of the two-node side. Seven interior nodes lie at
//
//   (1/2,3/4), (3/4,3/4), (1/2,1/2), (3/4,1/2),
//   (1/4,1/4), (1/2,1/4), (3/4,1/4).
//
// This is the drawn connectivity, including its three rectangular center
// quads; it is not a radial approximation of the same boundary-node count.
bool try_two_node_side_with_adjacent_midpoints(const SplitCell& cell,
                                               SplitWorkingPlan& plan)
{
  constexpr std::array<Point2, 4> logical_corners{
      Point2{0.0, 0.0}, Point2{1.0, 0.0}, Point2{1.0, 1.0}, Point2{0.0, 1.0}};
  for (int partial_side = 0; partial_side < 4; ++partial_side) {
    const int lo = partial_side % 2 == 0 ? cell.x0 : cell.y0;
    const int hi = partial_side % 2 == 0 ? cell.x1 : cell.y1;
    if ((hi - lo) % 4 != 0
        || cell.sides[static_cast<std::size_t>(partial_side)].size() != 2) {
      continue;
    }
    const int quarter_coordinate = lo + (hi - lo) / 4;
    const int midpoint_coordinate = lo + (hi - lo) / 2;
    const int three_quarter_coordinate = lo + 3 * (hi - lo) / 4;
    const SplitSideNode* quarter =
        split_node_at(cell.sides[static_cast<std::size_t>(partial_side)], quarter_coordinate);
    const SplitSideNode* midpoint =
        split_node_at(cell.sides[static_cast<std::size_t>(partial_side)], midpoint_coordinate);
    const SplitSideNode* three_quarters =
        split_node_at(cell.sides[static_cast<std::size_t>(partial_side)],
                      three_quarter_coordinate);
    if (midpoint == nullptr || (quarter == nullptr) == (three_quarters == nullptr)) {
      continue;
    }

    const int opposite_side = (partial_side + 2) % 4;
    if (!cell.sides[static_cast<std::size_t>(opposite_side)].empty()) {
      continue;
    }
    const int previous_side = (partial_side + 3) % 4;
    const int next_side = (partial_side + 1) % 4;
    const auto adjacent_midpoint = [&](int side) -> const SplitSideNode* {
      if (cell.sides[static_cast<std::size_t>(side)].size() != 1) {
        return nullptr;
      }
      const int coordinate = side % 2 == 0
          ? split_midpoint(cell.x0, cell.x1)
          : split_midpoint(cell.y0, cell.y1);
      return split_node_at(cell.sides[static_cast<std::size_t>(side)], coordinate);
    };
    const SplitSideNode* previous_midpoint = adjacent_midpoint(previous_side);
    const SplitSideNode* next_midpoint = adjacent_midpoint(next_side);
    if (previous_midpoint == nullptr || next_midpoint == nullptr) {
      continue;
    }

    const int physical_low_corner = partial_side < 2
        ? partial_side
        : (partial_side + 1) % 4;
    const int physical_high_corner = partial_side < 2
        ? (partial_side + 1) % 4
        : partial_side;
    const bool dense_at_physical_low = quarter != nullptr;
    const int dense_corner = dense_at_physical_low ? physical_low_corner : physical_high_corner;
    const int coarse_corner = dense_at_physical_low ? physical_high_corner : physical_low_corner;
    const int dense_adjacent_side = dense_corner == partial_side ? previous_side : next_side;
    const int coarse_adjacent_side = dense_adjacent_side == previous_side ? next_side : previous_side;
    const SplitSideNode* dense_adjacent_midpoint =
        dense_adjacent_side == previous_side ? previous_midpoint : next_midpoint;
    const SplitSideNode* coarse_adjacent_midpoint =
        coarse_adjacent_side == previous_side ? previous_midpoint : next_midpoint;
    const int dense_far_corner = dense_adjacent_side == dense_corner
        ? (dense_corner + 1) % 4
        : (dense_corner + 3) % 4;
    const int coarse_far_corner = coarse_adjacent_side == coarse_corner
        ? (coarse_corner + 1) % 4
        : (coarse_corner + 3) % 4;
    const int near_node = quarter != nullptr ? quarter->node : three_quarters->node;

    SplitWorkingPlan candidate = plan;
    const Point2 logical_dense = logical_corners[static_cast<std::size_t>(dense_corner)];
    const Vec2 logical_u =
        logical_corners[static_cast<std::size_t>(coarse_corner)] - logical_dense;
    const Vec2 logical_v =
        logical_corners[static_cast<std::size_t>(dense_far_corner)] - logical_dense;
    const auto add_local_point = [&](double u, double v) {
      const Point2 logical = logical_dense + logical_u * u + logical_v * v;
      const int node = static_cast<int>(candidate.points.size());
      candidate.points.push_back(split_bilinear(cell, candidate, logical.x, logical.y));
      return node;
    };
    const int upper_left = add_local_point(0.5, 0.75);
    const int upper_right = add_local_point(0.75, 0.75);
    const int center_left = add_local_point(0.5, 0.5);
    const int center_right = add_local_point(0.75, 0.5);
    const int lower_left = add_local_point(0.25, 0.25);
    const int lower_center = add_local_point(0.5, 0.25);
    const int lower_right = add_local_point(0.75, 0.25);

    std::vector<std::array<int, 4>> quads{
        {cell.corners[static_cast<std::size_t>(dense_far_corner)], upper_left, upper_right,
         cell.corners[static_cast<std::size_t>(coarse_far_corner)]},
        {cell.corners[static_cast<std::size_t>(dense_far_corner)],
         dense_adjacent_midpoint->node, center_left, upper_left},
        {upper_left, center_left, center_right, upper_right},
        {upper_right, center_right, coarse_adjacent_midpoint->node,
         cell.corners[static_cast<std::size_t>(coarse_far_corner)]},
        {cell.corners[static_cast<std::size_t>(dense_corner)], near_node, lower_left,
         dense_adjacent_midpoint->node},
        {dense_adjacent_midpoint->node, lower_left, lower_center, center_left},
        {near_node, midpoint->node, lower_center, lower_left},
        {center_left, lower_center, lower_right, center_right},
        {midpoint->node, cell.corners[static_cast<std::size_t>(coarse_corner)], lower_right,
         lower_center},
        {center_right, lower_right, cell.corners[static_cast<std::size_t>(coarse_corner)],
         coarse_adjacent_midpoint->node},
    };
    if (primitive_meets_contract(candidate, std::move(quads))) {
      plan = std::move(candidate);
      return true;
    }
  }
  return false;
}

struct LogicalSideNode {
  double distance_from_corner = 0.0;
  int node = -1;
};

bool side_is_incident_to_corner(int side, int corner)
{
  return side == corner || (side + 1) % 4 == corner;
}

int other_side_corner(int side, int corner)
{
  return side == corner ? (corner + 1) % 4 : (corner + 3) % 4;
}

Point2 split_logical_side_point(const SplitCell& cell, int side, int coordinate)
{
  if (side % 2 == 0) {
    const double x = static_cast<double>(coordinate - cell.x0)
        / static_cast<double>(cell.x1 - cell.x0);
    return {x, side == 0 ? 0.0 : 1.0};
  }
  const double y = static_cast<double>(coordinate - cell.y0)
      / static_cast<double>(cell.y1 - cell.y0);
  return {side == 1 ? 1.0 : 0.0, y};
}

std::vector<LogicalSideNode> side_nodes_from_corner(const SplitCell& cell, int side,
                                                    int corner)
{
  constexpr std::array<Point2, 4> logical_corners{
      Point2{0.0, 0.0}, Point2{1.0, 0.0}, Point2{1.0, 1.0}, Point2{0.0, 1.0}};
  const Point2 origin = logical_corners[static_cast<std::size_t>(corner)];
  std::vector<LogicalSideNode> result;
  for (const SplitSideNode& side_node : cell.sides[static_cast<std::size_t>(side)]) {
    const Point2 point = split_logical_side_point(cell, side, side_node.coordinate);
    result.push_back({std::abs(point.x - origin.x) + std::abs(point.y - origin.y),
                      side_node.node});
  }
  std::sort(result.begin(), result.end(), [](const LogicalSideNode& a,
                                             const LogicalSideNode& b) {
    return a.distance_from_corner < b.distance_from_corner;
  });
  return result;
}

// Case 1 in cpp_template_gaps: two nodes on one side and no nodes on the
// other three. A two-node interior strip ends at the two corners of the
// opposite side. The 3/4 transverse placement is the exact drawn topology and
// gives the canonical square a 45-degree minimum angle.
bool try_single_two_node_side_strip(const SplitCell& cell, SplitWorkingPlan& plan)
{
  int active_side = -1;
  for (int side = 0; side < 4; ++side) {
    if (cell.sides[static_cast<std::size_t>(side)].empty()) {
      continue;
    }
    if (active_side >= 0 || cell.sides[static_cast<std::size_t>(side)].size() != 2) {
      return false;
    }
    active_side = side;
  }
  if (active_side < 0) {
    return false;
  }

  constexpr std::array<Point2, 4> logical_corners{
      Point2{0.0, 0.0}, Point2{1.0, 0.0}, Point2{1.0, 1.0}, Point2{0.0, 1.0}};
  for (const int common_corner : {active_side, (active_side + 1) % 4}) {
    const std::vector<LogicalSideNode> nodes =
        side_nodes_from_corner(cell, active_side, common_corner);
    if (nodes.size() != 2 || std::abs(nodes[0].distance_from_corner - 0.25) > 1.0e-12
        || std::abs(nodes[1].distance_from_corner - 0.5) > 1.0e-12) {
      continue;
    }
    const int previous_side = (common_corner + 3) % 4;
    const int outgoing_side = common_corner;
    const int transverse_side = previous_side == active_side ? outgoing_side : previous_side;
    const int transverse_far_corner = other_side_corner(transverse_side, common_corner);
    const int active_far_corner = other_side_corner(active_side, common_corner);
    const int opposite_corner = (common_corner + 2) % 4;
    const Point2 logical_common = logical_corners[static_cast<std::size_t>(common_corner)];
    const Vec2 logical_u =
        logical_corners[static_cast<std::size_t>(transverse_far_corner)] - logical_common;
    const Vec2 logical_v =
        logical_corners[static_cast<std::size_t>(active_far_corner)] - logical_common;

    SplitWorkingPlan candidate = plan;
    std::array<int, 2> interior{};
    for (int i = 0; i < 2; ++i) {
      const Point2 logical =
          logical_common + logical_u * 0.75 + logical_v * nodes[i].distance_from_corner;
      interior[static_cast<std::size_t>(i)] = static_cast<int>(candidate.points.size());
      candidate.points.push_back(split_bilinear(cell, candidate, logical.x, logical.y));
    }
    std::vector<std::array<int, 4>> quads{
        {cell.corners[static_cast<std::size_t>(common_corner)],
         cell.corners[static_cast<std::size_t>(transverse_far_corner)], interior[0],
         nodes[0].node},
        {nodes[0].node, interior[0], interior[1], nodes[1].node},
        {nodes[1].node, interior[1],
         cell.corners[static_cast<std::size_t>(opposite_corner)],
         cell.corners[static_cast<std::size_t>(active_far_corner)]},
        {interior[0], cell.corners[static_cast<std::size_t>(transverse_far_corner)],
         cell.corners[static_cast<std::size_t>(opposite_corner)], interior[1]},
    };
    if (primitive_meets_contract(candidate, std::move(quads))) {
      plan = std::move(candidate);
      return true;
    }
  }
  return false;
}

// Cases 2-5 in cpp_template_gaps are one construction. Two adjacent sides
// carry the same number of nodes. Pair them in distance order from their
// common corner, place an interior node at each logical row/column
// intersection, and connect that chain to the opposite corner. This emits
// 2*k+1 quads for k=2 or 3 without adding an outer boundary node.
bool try_equal_adjacent_side_strip(const SplitCell& cell, SplitWorkingPlan& plan)
{
  std::vector<int> active_sides;
  for (int side = 0; side < 4; ++side) {
    if (!cell.sides[static_cast<std::size_t>(side)].empty()) {
      active_sides.push_back(side);
    }
  }
  if (active_sides.size() != 2) {
    return false;
  }
  const std::size_t side_node_count =
      cell.sides[static_cast<std::size_t>(active_sides[0])].size();
  if ((side_node_count != 2 && side_node_count != 3)
      || cell.sides[static_cast<std::size_t>(active_sides[1])].size()
          != side_node_count) {
    return false;
  }

  int common_corner = -1;
  for (int corner = 0; corner < 4; ++corner) {
    if (side_is_incident_to_corner(active_sides[0], corner)
        && side_is_incident_to_corner(active_sides[1], corner)) {
      common_corner = corner;
      break;
    }
  }
  if (common_corner < 0) {
    return false; // the two active sides are opposite
  }

  constexpr std::array<Point2, 4> logical_corners{
      Point2{0.0, 0.0}, Point2{1.0, 0.0}, Point2{1.0, 1.0}, Point2{0.0, 1.0}};
  const int u_side = active_sides[0];
  const int v_side = active_sides[1];
  const int u_far_corner = other_side_corner(u_side, common_corner);
  const int v_far_corner = other_side_corner(v_side, common_corner);
  const int opposite_corner = (common_corner + 2) % 4;
  const std::vector<LogicalSideNode> u_nodes =
      side_nodes_from_corner(cell, u_side, common_corner);
  const std::vector<LogicalSideNode> v_nodes =
      side_nodes_from_corner(cell, v_side, common_corner);
  const Point2 logical_common = logical_corners[static_cast<std::size_t>(common_corner)];
  const Vec2 logical_u =
      logical_corners[static_cast<std::size_t>(u_far_corner)] - logical_common;
  const Vec2 logical_v =
      logical_corners[static_cast<std::size_t>(v_far_corner)] - logical_common;

  SplitWorkingPlan candidate = plan;
  std::vector<int> interior;
  for (std::size_t i = 0; i < side_node_count; ++i) {
    const Point2 logical = logical_common + logical_u * u_nodes[i].distance_from_corner
        + logical_v * v_nodes[i].distance_from_corner;
    interior.push_back(static_cast<int>(candidate.points.size()));
    candidate.points.push_back(split_bilinear(cell, candidate, logical.x, logical.y));
  }

  std::vector<std::array<int, 4>> quads{
      {cell.corners[static_cast<std::size_t>(common_corner)], u_nodes[0].node,
       interior[0], v_nodes[0].node},
  };
  for (std::size_t i = 0; i + 1 < side_node_count; ++i) {
    quads.push_back(
        {u_nodes[i].node, u_nodes[i + 1].node, interior[i + 1], interior[i]});
    quads.push_back(
        {v_nodes[i].node, interior[i], interior[i + 1], v_nodes[i + 1].node});
  }
  const std::size_t last = side_node_count - 1;
  quads.push_back({u_nodes[last].node,
                   cell.corners[static_cast<std::size_t>(u_far_corner)],
                   cell.corners[static_cast<std::size_t>(opposite_corner)], interior[last]});
  quads.push_back({v_nodes[last].node, interior[last],
                   cell.corners[static_cast<std::size_t>(opposite_corner)],
                   cell.corners[static_cast<std::size_t>(v_far_corner)]});
  if (primitive_meets_contract(candidate, std::move(quads))) {
    plan = std::move(candidate);
    return true;
  }
  return false;
}

// Cases 6-8 in the original gap chart are one grid-and-cap construction. One
// side is empty, the opposite side supplies two columns, and the other two
// sides supply two or three aligned rows. A two-node interior cap closes the
// grid to the empty side's corners. The cap height is selected from a finite
// family relative to the lowest row; topology and outer boundary remain
// fixed, while the instantiated quads must meet the production contract.
bool try_three_side_grid_with_cap(const SplitCell& cell, SplitWorkingPlan& plan)
{
  int empty_side = -1;
  for (int side = 0; side < 4; ++side) {
    if (!cell.sides[static_cast<std::size_t>(side)].empty()) {
      continue;
    }
    if (empty_side >= 0) {
      return false;
    }
    empty_side = side;
  }
  if (empty_side < 0) {
    return false;
  }
  const int column_side = (empty_side + 2) % 4;
  if (cell.sides[static_cast<std::size_t>(column_side)].size() != 2) {
    return false;
  }

  constexpr std::array<Point2, 4> logical_corners{
      Point2{0.0, 0.0}, Point2{1.0, 0.0}, Point2{1.0, 1.0}, Point2{0.0, 1.0}};
  SplitWorkingPlan best;
  bool have_best = false;
  double best_margin = -std::numeric_limits<double>::max();
  for (const int origin_corner : {empty_side, (empty_side + 1) % 4}) {
    const int bottom_far_corner = other_side_corner(empty_side, origin_corner);
    const int left_side = origin_corner == empty_side ? (origin_corner + 3) % 4
                                                       : origin_corner;
    const int right_side = left_side == (empty_side + 1) % 4
        ? (empty_side + 3) % 4
        : (empty_side + 1) % 4;
    const std::size_t row_count = cell.sides[static_cast<std::size_t>(left_side)].size();
    if ((row_count != 2 && row_count != 3)
        || cell.sides[static_cast<std::size_t>(right_side)].size() != row_count) {
      continue;
    }
    const int top_left_corner = other_side_corner(left_side, origin_corner);
    const int top_right_corner = other_side_corner(right_side, bottom_far_corner);
    const std::vector<LogicalSideNode> columns =
        side_nodes_from_corner(cell, column_side, top_left_corner);
    const std::vector<LogicalSideNode> left_rows =
        side_nodes_from_corner(cell, left_side, origin_corner);
    const std::vector<LogicalSideNode> right_rows =
        side_nodes_from_corner(cell, right_side, bottom_far_corner);
    bool rows_align = columns.size() == 2;
    for (std::size_t row = 0; row < row_count && rows_align; ++row) {
      rows_align = std::abs(left_rows[row].distance_from_corner
                            - right_rows[row].distance_from_corner)
          <= 1.0e-12;
    }
    if (!rows_align) {
      continue;
    }

    const Point2 logical_origin = logical_corners[static_cast<std::size_t>(origin_corner)];
    const Vec2 logical_u =
        logical_corners[static_cast<std::size_t>(bottom_far_corner)] - logical_origin;
    const Vec2 logical_v =
        logical_corners[static_cast<std::size_t>(top_left_corner)] - logical_origin;
    const double lowest_row = left_rows.front().distance_from_corner;
    for (const double cap_ratio : {0.5, 2.0 / 3.0, 0.75, 0.8}) {
      const double cap_height = cap_ratio * lowest_row;
      SplitWorkingPlan candidate = plan;
      std::vector<std::array<int, 2>> grid(row_count);
      for (std::size_t row = 0; row < row_count; ++row) {
        for (int column = 0; column < 2; ++column) {
          const Point2 logical = logical_origin
              + logical_u * columns[static_cast<std::size_t>(column)].distance_from_corner
              + logical_v * left_rows[row].distance_from_corner;
          grid[row][static_cast<std::size_t>(column)] =
              static_cast<int>(candidate.points.size());
          candidate.points.push_back(split_bilinear(cell, candidate, logical.x, logical.y));
        }
      }
      std::array<int, 2> cap{};
      for (int column = 0; column < 2; ++column) {
        const Point2 logical = logical_origin
            + logical_u * columns[static_cast<std::size_t>(column)].distance_from_corner
            + logical_v * cap_height;
        cap[static_cast<std::size_t>(column)] = static_cast<int>(candidate.points.size());
        candidate.points.push_back(split_bilinear(cell, candidate, logical.x, logical.y));
      }

      const std::size_t top_row = row_count - 1;
      std::vector<std::array<int, 4>> quads{
          {cell.corners[static_cast<std::size_t>(top_left_corner)], columns[0].node,
           grid[top_row][0], left_rows[top_row].node},
          {columns[0].node, columns[1].node, grid[top_row][1], grid[top_row][0]},
          {columns[1].node, cell.corners[static_cast<std::size_t>(top_right_corner)],
           right_rows[top_row].node, grid[top_row][1]},
      };
      for (std::size_t row = 0; row + 1 < row_count; ++row) {
        quads.push_back({left_rows[row].node, grid[row][0], grid[row + 1][0],
                         left_rows[row + 1].node});
        quads.push_back(
            {grid[row][0], grid[row][1], grid[row + 1][1], grid[row + 1][0]});
        quads.push_back({grid[row][1], right_rows[row].node, right_rows[row + 1].node,
                         grid[row + 1][1]});
      }
      quads.push_back({cell.corners[static_cast<std::size_t>(origin_corner)], cap[0],
                       grid[0][0], left_rows[0].node});
      quads.push_back({cap[0], cap[1], grid[0][1], grid[0][0]});
      quads.push_back({cap[1],
                       cell.corners[static_cast<std::size_t>(bottom_far_corner)],
                       right_rows[0].node, grid[0][1]});
      quads.push_back({cell.corners[static_cast<std::size_t>(origin_corner)],
                       cell.corners[static_cast<std::size_t>(bottom_far_corner)], cap[1],
                       cap[0]});
      for (std::array<int, 4>& quad : quads) {
        orient_ccw(quad, candidate.points);
      }
      const EmptyTemplateQuality quality = evaluate(candidate.points, quads);
      if (!meets_contract(quality)) {
        continue;
      }
      const double margin = contract_margin(quality);
      if (!have_best || margin > best_margin + 1.0e-12) {
        candidate.quads.insert(candidate.quads.end(), quads.begin(), quads.end());
        best = std::move(candidate);
        best_margin = margin;
        have_best = true;
      }
    }
  }
  if (!have_best) {
    return false;
  }
  plan = std::move(best);
  return true;
}

std::vector<SplitSideNode> add_vertical_interface(const SplitCell& cell,
                                                  const std::vector<int>& coordinates,
                                                  int south, int north,
                                                  SplitWorkingPlan& plan)
{
  std::vector<SplitSideNode> result;
  const Point2 a = plan.points[static_cast<std::size_t>(south)];
  const Point2 b = plan.points[static_cast<std::size_t>(north)];
  for (const int coordinate : coordinates) {
    const double t = static_cast<double>(coordinate - cell.y0)
        / static_cast<double>(cell.y1 - cell.y0);
    const int node = static_cast<int>(plan.points.size());
    plan.points.push_back(a + (b - a) * t);
    result.push_back({coordinate, node});
  }
  return result;
}

std::vector<SplitSideNode> add_horizontal_interface(const SplitCell& cell,
                                                    const std::vector<int>& coordinates,
                                                    int west, int east,
                                                    SplitWorkingPlan& plan)
{
  std::vector<SplitSideNode> result;
  const Point2 a = plan.points[static_cast<std::size_t>(west)];
  const Point2 b = plan.points[static_cast<std::size_t>(east)];
  for (const int coordinate : coordinates) {
    const double t = static_cast<double>(coordinate - cell.x0)
        / static_cast<double>(cell.x1 - cell.x0);
    const int node = static_cast<int>(plan.points.size());
    plan.points.push_back(a + (b - a) * t);
    result.push_back({coordinate, node});
  }
  return result;
}

bool solve_split_cell(const SplitCell& cell, SplitWorkingPlan& plan)
{
  const std::size_t original_quad_count = plan.quads.size();
  const std::size_t original_point_count = plan.points.size();
  SplitWorkingPlan best;
  bool have_best = false;
  const auto consider = [&](SplitWorkingPlan candidate) {
    if (!have_best) {
      best = std::move(candidate);
      have_best = true;
      return;
    }
    const std::size_t candidate_quads = candidate.quads.size() - original_quad_count;
    const std::size_t best_quads = best.quads.size() - original_quad_count;
    if (candidate_quads != best_quads) {
      if (candidate_quads < best_quads) {
        best = std::move(candidate);
      }
      return;
    }
    const std::vector<std::array<int, 4>> candidate_added(
        candidate.quads.begin() + static_cast<std::ptrdiff_t>(original_quad_count),
        candidate.quads.end());
    const std::vector<std::array<int, 4>> best_added(
        best.quads.begin() + static_cast<std::ptrdiff_t>(original_quad_count), best.quads.end());
    const EmptyTemplateQuality candidate_quality = evaluate(candidate.points, candidate_added);
    const EmptyTemplateQuality best_quality = evaluate(best.points, best_added);
    const double candidate_margin = contract_margin(candidate_quality);
    const double best_margin = contract_margin(best_quality);
    if (candidate_margin > best_margin + 1.0e-12
        || (std::abs(candidate_margin - best_margin) <= 1.0e-12
            && candidate.points.size() - original_point_count
                < best.points.size() - original_point_count)) {
      best = std::move(candidate);
    }
  };

  SplitWorkingPlan primitive = plan;
  if (try_split_primitive(cell, primitive)) {
    consider(std::move(primitive));
  }

  SplitWorkingPlan adjacent_midpoint_full_side = plan;
  if (try_adjacent_midpoint_full_side(cell, adjacent_midpoint_full_side)) {
    consider(std::move(adjacent_midpoint_full_side));
  }

  SplitWorkingPlan two_node_side_with_adjacent_midpoints = plan;
  if (try_two_node_side_with_adjacent_midpoints(
          cell, two_node_side_with_adjacent_midpoints)) {
    consider(std::move(two_node_side_with_adjacent_midpoints));
  }

  SplitWorkingPlan single_two_node_side_strip = plan;
  if (try_single_two_node_side_strip(cell, single_two_node_side_strip)) {
    consider(std::move(single_two_node_side_strip));
  }

  SplitWorkingPlan equal_adjacent_side_strip = plan;
  if (try_equal_adjacent_side_strip(cell, equal_adjacent_side_strip)) {
    consider(std::move(equal_adjacent_side_strip));
  }

  SplitWorkingPlan three_side_grid_with_cap = plan;
  if (try_three_side_grid_with_cap(cell, three_side_grid_with_cap)) {
    consider(std::move(three_side_grid_with_cap));
  }

  const int x_mid = split_midpoint(cell.x0, cell.x1);
  if (x_mid >= 0) {
    const SplitSideNode* south = split_node_at(cell.sides[0], x_mid);
    const SplitSideNode* north = split_node_at(cell.sides[2], x_mid);
    if (south != nullptr && north != nullptr) {
      for (const std::vector<int>& coordinates : split_interface_patterns(cell.y0, cell.y1)) {
        SplitWorkingPlan candidate = plan;
        const std::vector<SplitSideNode> interface =
            add_vertical_interface(cell, coordinates, south->node, north->node, candidate);
        SplitCell left;
        left.x0 = cell.x0;
        left.x1 = x_mid;
        left.y0 = cell.y0;
        left.y1 = cell.y1;
        left.corners = {cell.corners[0], south->node, north->node, cell.corners[3]};
        left.sides = {split_nodes_below(cell.sides[0], x_mid), interface,
                      split_nodes_below(cell.sides[2], x_mid), cell.sides[3]};
        SplitCell right;
        right.x0 = x_mid;
        right.x1 = cell.x1;
        right.y0 = cell.y0;
        right.y1 = cell.y1;
        right.corners = {south->node, cell.corners[1], cell.corners[2], north->node};
        right.sides = {split_nodes_above(cell.sides[0], x_mid), cell.sides[1],
                       split_nodes_above(cell.sides[2], x_mid), interface};
        if (solve_split_cell(left, candidate) && solve_split_cell(right, candidate)) {
          consider(std::move(candidate));
        }
      }
    }
  }

  const int y_mid = split_midpoint(cell.y0, cell.y1);
  if (y_mid >= 0) {
    const SplitSideNode* east = split_node_at(cell.sides[1], y_mid);
    const SplitSideNode* west = split_node_at(cell.sides[3], y_mid);
    if (east != nullptr && west != nullptr) {
      for (const std::vector<int>& coordinates : split_interface_patterns(cell.x0, cell.x1)) {
        SplitWorkingPlan candidate = plan;
        const std::vector<SplitSideNode> interface =
            add_horizontal_interface(cell, coordinates, west->node, east->node, candidate);
        SplitCell bottom;
        bottom.x0 = cell.x0;
        bottom.x1 = cell.x1;
        bottom.y0 = cell.y0;
        bottom.y1 = y_mid;
        bottom.corners = {cell.corners[0], cell.corners[1], east->node, west->node};
        bottom.sides = {cell.sides[0], split_nodes_below(cell.sides[1], y_mid), interface,
                        split_nodes_below(cell.sides[3], y_mid)};
        SplitCell top;
        top.x0 = cell.x0;
        top.x1 = cell.x1;
        top.y0 = y_mid;
        top.y1 = cell.y1;
        top.corners = {west->node, east->node, cell.corners[2], cell.corners[3]};
        top.sides = {interface, split_nodes_above(cell.sides[1], y_mid), cell.sides[2],
                     split_nodes_above(cell.sides[3], y_mid)};
        if (solve_split_cell(bottom, candidate) && solve_split_cell(top, candidate)) {
          consider(std::move(candidate));
        }
      }
    }
  }
  if (!have_best) {
    return false;
  }
  plan = std::move(best);
  return true;
}

bool build_split_root(const std::vector<Point2>& boundary,
                      const EmptyTemplateSideParameters& side_parameters,
                      SplitCell& root)
{
  std::size_t cursor = 0;
  for (int side = 0; side < 4; ++side) {
    if (cursor >= boundary.size()) {
      return false;
    }
    root.corners[static_cast<std::size_t>(side)] = static_cast<int>(cursor++);
    for (const double t_on_side : side_parameters[static_cast<std::size_t>(side)]) {
      if (cursor >= boundary.size() || !(t_on_side > 0.0 && t_on_side < 1.0)) {
        return false;
      }
      const double increasing_t = side < 2 ? t_on_side : 1.0 - t_on_side;
      const int coordinate = static_cast<int>(std::llround(split_resolution * increasing_t));
      if (coordinate <= 0 || coordinate >= split_resolution
          || std::abs(split_resolution * increasing_t - coordinate) > 1.0e-9) {
        return false;
      }
      root.sides[static_cast<std::size_t>(side)].push_back(
          {coordinate, static_cast<int>(cursor++)});
    }
    auto& nodes = root.sides[static_cast<std::size_t>(side)];
    std::sort(nodes.begin(), nodes.end(), [](const SplitSideNode& a, const SplitSideNode& b) {
      return a.coordinate < b.coordinate;
    });
    if (std::adjacent_find(nodes.begin(), nodes.end(), [](const SplitSideNode& a,
                                                         const SplitSideNode& b) {
          return a.coordinate == b.coordinate;
        }) != nodes.end()) {
      return false;
    }
  }
  return cursor == boundary.size();
}

bool recursive_split_template(const std::vector<Point2>& boundary,
                              const EmptyTemplateSideParameters& side_parameters,
                              EmptyTemplatePlan& result)
{
  SplitCell root;
  if (!build_split_root(boundary, side_parameters, root)) {
    return false;
  }
  SplitWorkingPlan working;
  working.points = boundary;
  if (!solve_split_cell(root, working)) {
    return false;
  }
  result.kind = EmptyTemplateKind::RecursiveSplit;
  result.interior.assign(working.points.begin() + static_cast<std::ptrdiff_t>(boundary.size()),
                         working.points.end());
  result.quads = std::move(working.quads);
  finish_candidate(result, boundary);
  return result.meets_quality_contract;
}

EmptyTemplatePlan paired_fan(const std::vector<Point2>& boundary, Point2 center, int offset)
{
  EmptyTemplatePlan candidate;
  candidate.kind = EmptyTemplateKind::PairedFan;
  candidate.interior.push_back(center);
  const int n = static_cast<int>(boundary.size());
  const int center_index = n;
  for (int k = 0; k < n; k += 2) {
    const int i = (offset + k) % n;
    candidate.quads.push_back({center_index, i, (i + 1) % n, (i + 2) % n});
  }
  finish_candidate(candidate, boundary);
  return candidate;
}

EmptyTemplatePlan one_ring(const std::vector<Point2>& boundary, Point2 center,
                           double radial_fraction, double circular_blend, int offset)
{
  EmptyTemplatePlan candidate;
  candidate.kind = EmptyTemplateKind::OneRing;
  const int n = static_cast<int>(boundary.size());
  double shortest_radius = std::numeric_limits<double>::max();
  for (const Point2 p : boundary) {
    shortest_radius = std::min(shortest_radius, distance(center, p));
  }
  if (shortest_radius <= 0.0) {
    return candidate;
  }
  candidate.interior.push_back(center);
  for (const Point2 p : boundary) {
    const Vec2 direction = p - center;
    const double radius = length(direction);
    const double homothetic = radial_fraction * radius;
    const double circular = radial_fraction * shortest_radius;
    const double inner_radius = (1.0 - circular_blend) * homothetic + circular_blend * circular;
    candidate.interior.push_back(center + direction * (inner_radius / radius));
  }
  const int center_index = n;
  const int inner0 = n + 1;
  for (int i = 0; i < n; ++i) {
    const int next = (i + 1) % n;
    candidate.quads.push_back({i, next, inner0 + next, inner0 + i});
  }
  if (n == 4) {
    candidate.quads.push_back({inner0, inner0 + 1, inner0 + 2, inner0 + 3});
  } else {
    for (int k = 0; k < n; k += 2) {
      const int i = (offset + k) % n;
      candidate.quads.push_back(
          {center_index, inner0 + i, inner0 + (i + 1) % n, inner0 + (i + 2) % n});
    }
  }
  finish_candidate(candidate, boundary);
  return candidate;
}

void optimize_interior_points(EmptyTemplatePlan& plan, const std::vector<Point2>& boundary)
{
  if (plan.interior.empty()) {
    return;
  }
  Aabb2 bounds{boundary.front(), boundary.front()};
  for (const Point2 point : boundary) {
    bounds.min.x = std::min(bounds.min.x, point.x);
    bounds.min.y = std::min(bounds.min.y, point.y);
    bounds.max.x = std::max(bounds.max.x, point.x);
    bounds.max.y = std::max(bounds.max.y, point.y);
  }
  const double extent = std::max(width(bounds), height(bounds));
  const double inside_eps = std::max(1.0e-14, extent * extent * 1.0e-12);
  const auto inside = [&](Point2 point) {
    for (std::size_t i = 0; i < boundary.size(); ++i) {
      const Point2 a = boundary[i];
      const Point2 b = boundary[(i + 1) % boundary.size()];
      if (cross(b - a, point - a) < -inside_eps) {
        return false;
      }
    }
    return true;
  };
  const auto refresh = [&] {
    std::vector<Point2> points = boundary;
    points.insert(points.end(), plan.interior.begin(), plan.interior.end());
    plan.quality = evaluate(points, plan.quads);
    plan.meets_quality_contract = meets_contract(plan.quality);
  };
  double step = 0.05 * extent;
  for (int iteration = 0; iteration < 48 && step > 1.0e-4 * extent; ++iteration) {
    bool improved = false;
    for (std::size_t node = 0; node < plan.interior.size(); ++node) {
      const Point2 original = plan.interior[node];
      EmptyTemplateQuality best_quality = plan.quality;
      Point2 best_point = original;
      for (const auto [dx, dy] : {std::pair{1.0, 0.0}, std::pair{-1.0, 0.0}, std::pair{0.0, 1.0},
                                  std::pair{0.0, -1.0}, std::pair{1.0, 1.0}, std::pair{1.0, -1.0},
                                  std::pair{-1.0, 1.0}, std::pair{-1.0, -1.0}}) {
        const Point2 candidate{original.x + dx * step, original.y + dy * step};
        if (!inside(candidate)) {
          continue;
        }
        plan.interior[node] = candidate;
        refresh();
        const double candidate_margin = contract_margin(plan.quality);
        const double best_margin = contract_margin(best_quality);
        if (candidate_margin > best_margin + 1.0e-12
            || (std::abs(candidate_margin - best_margin) <= 1.0e-12
                && plan.quality.min_scaled_jacobian > best_quality.min_scaled_jacobian)) {
          best_quality = plan.quality;
          best_point = candidate;
        }
      }
      plan.interior[node] = best_point;
      plan.quality = best_quality;
      plan.meets_quality_contract = meets_contract(plan.quality);
      improved = improved || distance(best_point, original) > 0.0;
    }
    if (!improved) {
      step *= 0.5;
    }
  }
}

EmptyTemplatePlan choose_from_centers(const std::vector<Point2>& boundary,
                                      const std::vector<Point2>& centers)
{
  EmptyTemplatePlan best;
  bool have_best = false;
  const auto consider = [&](EmptyTemplatePlan candidate) {
    if (!have_best || better_than(candidate, best)) {
      best = std::move(candidate);
      have_best = true;
    }
  };
  for (const Point2 center : centers) {
    consider(paired_fan(boundary, center, 0));
    consider(paired_fan(boundary, center, 1));
    for (const double radial_fraction : {0.3, 0.4, 0.5, 0.6, 0.7, 0.8}) {
      for (const double circular_blend : {0.0, 0.2, 0.4, 0.6, 0.8, 1.0}) {
        consider(one_ring(boundary, center, radial_fraction, circular_blend, 0));
        consider(one_ring(boundary, center, radial_fraction, circular_blend, 1));
      }
    }
  }
  if (!best.meets_quality_contract) {
    optimize_interior_points(best, boundary);
  }
  return best;
}

} // namespace

EmptyTemplatePlan choose_empty_template(const std::array<Point2, 4>& cell_corners,
                                        const std::vector<Point2>& boundary,
                                        const EmptyTemplateSideParameters& side_parameters)
{
  if (boundary.size() == 4) {
    EmptyTemplatePlan plan;
    plan.kind = EmptyTemplateKind::BoundaryQuad;
    plan.quads.push_back({0, 1, 2, 3});
    finish_candidate(plan, boundary);
    return plan;
  }
  EmptyTemplatePlan split_plan;
  if (recursive_split_template(boundary, side_parameters, split_plan)) {
    return split_plan;
  }
  // Finite center locations in the safe central portion of the deformed cell.
  std::vector<Point2> centers;
  constexpr double positions[] = {0.25, 1.0 / 3.0, 5.0 / 12.0, 0.5, 7.0 / 12.0, 2.0 / 3.0, 0.75};
  for (const double v : positions) {
    for (const double u : positions) {
      centers.push_back(bilinear(cell_corners, u, v));
    }
  }
  return choose_from_centers(boundary, centers);
}

EmptyTemplatePlan choose_polygon_template(const std::vector<Point2>& boundary)
{
  Point2 centroid{0.0, 0.0};
  Aabb2 bounds{boundary.front(), boundary.front()};
  for (const Point2 point : boundary) {
    centroid.x += point.x;
    centroid.y += point.y;
    bounds.min.x = std::min(bounds.min.x, point.x);
    bounds.min.y = std::min(bounds.min.y, point.y);
    bounds.max.x = std::max(bounds.max.x, point.x);
    bounds.max.y = std::max(bounds.max.y, point.y);
  }
  centroid.x /= static_cast<double>(boundary.size());
  centroid.y /= static_cast<double>(boundary.size());
  const double extent = std::max(width(bounds), height(bounds));
  const double eps = std::max(1.0e-14, extent * extent * 1.0e-12);
  const auto inside_convex = [&](Point2 point) {
    for (std::size_t i = 0; i < boundary.size(); ++i) {
      const Point2 a = boundary[i];
      const Point2 b = boundary[(i + 1) % boundary.size()];
      if (cross(b - a, point - a) < -eps) {
        return false;
      }
    }
    return true;
  };
  std::vector<Point2> centers;
  constexpr double offsets[] = {-0.25, -1.0 / 6.0, -1.0 / 12.0, 0.0, 1.0 / 12.0, 1.0 / 6.0, 0.25};
  for (const double dy : offsets) {
    for (const double dx : offsets) {
      const Point2 candidate{centroid.x + dx * width(bounds), centroid.y + dy * height(bounds)};
      if (inside_convex(candidate)) {
        centers.push_back(candidate);
      }
    }
  }
  if (centers.empty()) {
    centers.push_back(centroid);
  }
  return choose_from_centers(boundary, centers);
}

} // namespace quadmesh::detail
