#include "stage_test_util.hpp"

#include "detail/empty_templates.hpp"
#include "stages/classify.hpp"
#include "stages/empty_fill.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <set>

using namespace quadmesh;
using namespace quadmesh::detail;

namespace {

int count_class(const BoundaryTopology& topo, LeafClass want)
{
  int n = 0;
  for (const auto& [leaf, cls] : topo.leaf_class) {
    if (cls == want) {
      ++n;
    }
  }
  return n;
}

std::array<int, 4> canonical_quad(const std::array<int, 4>& quad)
{
  std::array<int, 4> best = quad;
  for (int start = 0; start < 4; ++start) {
    for (const int direction : {-1, 1}) {
      std::array<int, 4> candidate{};
      for (int i = 0; i < 4; ++i) {
        candidate[static_cast<std::size_t>(i)] =
            quad[static_cast<std::size_t>((start + direction * i + 8) % 4)];
      }
      best = std::min(best, candidate);
    }
  }
  return best;
}

std::vector<std::array<int, 4>> canonical_quads(
    const std::vector<std::array<int, 4>>& quads)
{
  std::vector<std::array<int, 4>> result;
  result.reserve(quads.size());
  std::transform(quads.begin(), quads.end(), std::back_inserter(result), canonical_quad);
  std::sort(result.begin(), result.end());
  return result;
}

} // namespace

TEST(EmptyFill, AtomicSideTemplateFamilyMeetsQualityContract)
{
  const std::array<Point2, 4> corners{{{0.0, 0.0}, {1.0, 0.0}, {1.0, 1.0}, {0.0, 1.0}}};
  const std::array<std::vector<double>, 5> side_patterns{
      std::vector<double>{},
      std::vector<double>{0.5},
      std::vector<double>{0.25, 0.5},
      std::vector<double>{0.5, 0.75},
      std::vector<double>{0.25, 0.5, 0.75},
  };
  int even_pattern_count = 0;
  int recursive_split_count = 0;
  int one_ring_fallback_count = 0;
  EmptyTemplateKind three_midpoints_and_full_side_kind = EmptyTemplateKind::OneRing;
  std::size_t three_midpoints_and_full_side_quads = 0;
  EmptyTemplateKind adjacent_midpoint_and_full_side_kind = EmptyTemplateKind::OneRing;
  std::size_t adjacent_midpoint_and_full_side_quads = 0;
  double recursive_min_angle = 360.0;
  double recursive_max_angle = 0.0;
  double recursive_min_scaled_jacobian = 1.0;
  double recursive_min_edge_ratio = 1.0;
  for (int south = 0; south < 5; ++south) {
    for (int east = 0; east < 5; ++east) {
      for (int north = 0; north < 5; ++north) {
        for (int west = 0; west < 5; ++west) {
          const std::array<int, 4> pattern{south, east, north, west};
          std::vector<Point2> boundary;
          EmptyTemplateSideParameters side_parameters;
          for (int side = 0; side < 4; ++side) {
            boundary.push_back(corners[static_cast<std::size_t>(side)]);
            side_parameters[static_cast<std::size_t>(side)] =
                side_patterns[static_cast<std::size_t>(pattern[side])];
            for (const double t : side_patterns[static_cast<std::size_t>(pattern[side])]) {
              const Point2 a = corners[static_cast<std::size_t>(side)];
              const Point2 b = corners[static_cast<std::size_t>((side + 1) % 4)];
              boundary.push_back(a + (b - a) * t);
            }
          }
          if (boundary.size() % 2 != 0) {
            continue; // global parity pairing eliminates these states before
                      // emission
          }
          ++even_pattern_count;

          const EmptyTemplatePlan plan =
              choose_empty_template(corners, boundary, side_parameters);
          recursive_split_count += plan.kind == EmptyTemplateKind::RecursiveSplit ? 1 : 0;
          one_ring_fallback_count += plan.kind == EmptyTemplateKind::OneRing ? 1 : 0;
          if (plan.kind == EmptyTemplateKind::RecursiveSplit) {
            recursive_min_angle = std::min(recursive_min_angle, plan.quality.min_angle_deg);
            recursive_max_angle = std::max(recursive_max_angle, plan.quality.max_angle_deg);
            recursive_min_scaled_jacobian =
                std::min(recursive_min_scaled_jacobian, plan.quality.min_scaled_jacobian);
            recursive_min_edge_ratio =
                std::min(recursive_min_edge_ratio, plan.quality.min_edge_ratio);
          }
          if (pattern == std::array<int, 4>{1, 1, 1, 4}) {
            three_midpoints_and_full_side_kind = plan.kind;
            three_midpoints_and_full_side_quads = plan.quads.size();
          }
          if (pattern == std::array<int, 4>{1, 0, 0, 4}) {
            adjacent_midpoint_and_full_side_kind = plan.kind;
            adjacent_midpoint_and_full_side_quads = plan.quads.size();
          }
          SCOPED_TRACE("patterns " + std::to_string(south) + "," + std::to_string(east) + ","
                       + std::to_string(north) + "," + std::to_string(west));
          EXPECT_TRUE(plan.meets_quality_contract)
              << "angle=" << plan.quality.min_angle_deg
              << " scaled_jacobian=" << plan.quality.min_scaled_jacobian
              << " edge_ratio=" << plan.quality.min_edge_ratio;
          EXPECT_GE(plan.quality.min_angle_deg, 20.0);
          EXPECT_LE(plan.quality.max_angle_deg, 160.0);
          EXPECT_GE(plan.quality.min_scaled_jacobian, 0.3);
          EXPECT_GE(plan.quality.min_edge_ratio, 0.1);

          std::map<std::pair<int, int>, int> edge_count;
          const int node_count = static_cast<int>(boundary.size() + plan.interior.size());
          for (const std::array<int, 4>& quad : plan.quads) {
            for (int k = 0; k < 4; ++k) {
              EXPECT_GE(quad[k], 0);
              EXPECT_LT(quad[k], node_count);
              const int a = quad[k];
              const int b = quad[(k + 1) % 4];
              ++edge_count[{std::min(a, b), std::max(a, b)}];
            }
          }
          std::set<std::pair<int, int>> boundary_edges;
          for (int i = 0; i < static_cast<int>(boundary.size()); ++i) {
            const int next = (i + 1) % static_cast<int>(boundary.size());
            const std::pair<int, int> edge{std::min(i, next), std::max(i, next)};
            boundary_edges.insert(edge);
            EXPECT_EQ(edge_count[edge], 1);
          }
          for (const auto& [edge, count] : edge_count) {
            EXPECT_EQ(count, boundary_edges.count(edge) > 0 ? 1 : 2);
          }
        }
      }
    }
  }
  // Exhaustive certificate over the bounded 2:1 atomic-side state space: all
  // 313 even states decompose in this grammar. The unsplit boundary quad
  // accounts for one; the remaining 312 use recursive or exact drawn-template
  // splits. No bounded even state retains the one-ring fallback.
  EXPECT_EQ(even_pattern_count, 313);
  EXPECT_EQ(recursive_split_count, 312);
  EXPECT_EQ(one_ring_fallback_count, 0);
  EXPECT_EQ(three_midpoints_and_full_side_kind, EmptyTemplateKind::RecursiveSplit);
  EXPECT_EQ(three_midpoints_and_full_side_quads, 6u);
  EXPECT_EQ(adjacent_midpoint_and_full_side_kind, EmptyTemplateKind::RecursiveSplit);
  EXPECT_EQ(adjacent_midpoint_and_full_side_quads, 7u);
  EXPECT_GE(recursive_min_angle, 20.55604521958346);
  EXPECT_LE(recursive_max_angle, 159.44395478041655);
  EXPECT_GE(recursive_min_scaled_jacobian, 0.3511234415883917);
  EXPECT_GE(recursive_min_edge_ratio, 0.1170411471961305);
}

TEST(EmptyFill, AdjacentMidpointFullSideUsesDrawnSevenQuadConnectivity)
{
  const std::array<Point2, 4> corners{{{0.0, 0.0}, {1.0, 0.0}, {1.0, 1.0}, {0.0, 1.0}}};
  const std::vector<Point2> boundary{
      {0.0, 0.0}, {0.5, 0.0}, {1.0, 0.0}, {1.0, 1.0},
      {0.0, 1.0}, {0.0, 0.75}, {0.0, 0.5}, {0.0, 0.25},
  };
  EmptyTemplateSideParameters side_parameters;
  side_parameters[0] = {0.5};
  side_parameters[3] = {0.25, 0.5, 0.75};

  const EmptyTemplatePlan plan = choose_empty_template(corners, boundary, side_parameters);

  ASSERT_EQ(plan.kind, EmptyTemplateKind::RecursiveSplit);
  ASSERT_EQ(plan.interior.size(), 4u);
  EXPECT_DOUBLE_EQ(plan.interior[0].x, 0.5);
  EXPECT_DOUBLE_EQ(plan.interior[0].y, 0.25);
  EXPECT_DOUBLE_EQ(plan.interior[1].x, 0.5);
  EXPECT_DOUBLE_EQ(plan.interior[1].y, 0.5);
  EXPECT_DOUBLE_EQ(plan.interior[2].x, 0.75);
  EXPECT_DOUBLE_EQ(plan.interior[2].y, 0.75);
  EXPECT_DOUBLE_EQ(plan.interior[3].x, 0.75);
  EXPECT_DOUBLE_EQ(plan.interior[3].y, 0.25);

  const std::vector<std::array<int, 4>> expected_quads{
      {0, 1, 8, 7}, {7, 8, 9, 6}, {6, 9, 10, 5}, {5, 10, 3, 4},
      {9, 8, 11, 10}, {8, 1, 2, 11}, {10, 11, 2, 3},
  };
  EXPECT_EQ(plan.quads, expected_quads);
  EXPECT_NEAR(plan.quality.min_angle_deg, 45.0, 1.0e-12);
  EXPECT_NEAR(plan.quality.max_angle_deg, 135.0, 1.0e-12);
  EXPECT_NEAR(plan.quality.min_scaled_jacobian, std::sqrt(0.5), 1.0e-12);
  EXPECT_NEAR(plan.quality.min_edge_ratio, 0.25, 1.0e-12);
}

TEST(EmptyFill, TwoNodeSideWithAdjacentMidpointsUsesDrawnTenQuadConnectivity)
{
  const std::array<Point2, 4> corners{{{0.0, 0.0}, {1.0, 0.0}, {1.0, 1.0}, {0.0, 1.0}}};
  const std::vector<Point2> boundary{
      {0.0, 0.0}, {0.25, 0.0}, {0.5, 0.0}, {1.0, 0.0},
      {1.0, 0.5}, {1.0, 1.0}, {0.0, 1.0}, {0.0, 0.5},
  };
  EmptyTemplateSideParameters side_parameters;
  side_parameters[0] = {0.25, 0.5};
  side_parameters[1] = {0.5};
  side_parameters[3] = {0.5};

  const EmptyTemplatePlan plan = choose_empty_template(corners, boundary, side_parameters);

  ASSERT_EQ(plan.kind, EmptyTemplateKind::RecursiveSplit);
  ASSERT_EQ(plan.interior.size(), 7u);
  const std::array<Point2, 7> expected_interior{
      Point2{0.5, 0.75}, Point2{0.75, 0.75}, Point2{0.5, 0.5},
      Point2{0.75, 0.5}, Point2{0.25, 0.25}, Point2{0.5, 0.25},
      Point2{0.75, 0.25},
  };
  for (std::size_t i = 0; i < expected_interior.size(); ++i) {
    EXPECT_DOUBLE_EQ(plan.interior[i].x, expected_interior[i].x);
    EXPECT_DOUBLE_EQ(plan.interior[i].y, expected_interior[i].y);
  }

  const std::vector<std::array<int, 4>> expected_quads{
      {6, 8, 9, 5}, {6, 7, 10, 8}, {8, 10, 11, 9}, {9, 11, 4, 5},
      {0, 1, 12, 7}, {7, 12, 13, 10}, {1, 2, 13, 12}, {10, 13, 14, 11},
      {2, 3, 14, 13}, {11, 14, 3, 4},
  };
  EXPECT_EQ(plan.quads, expected_quads);
  EXPECT_NEAR(plan.quality.min_angle_deg, 26.56505117707799, 1.0e-12);
  EXPECT_NEAR(plan.quality.max_angle_deg, 153.43494882292202, 1.0e-12);
  EXPECT_NEAR(plan.quality.min_scaled_jacobian, 1.0 / std::sqrt(5.0), 1.0e-12);
  EXPECT_NEAR(plan.quality.min_edge_ratio, 0.25, 1.0e-12);
}

TEST(EmptyFill, DrawnCornerStripsCoverFirstFiveCanonicalGapCases)
{
  const std::array<Point2, 4> corners{{{0.0, 0.0}, {1.0, 0.0}, {1.0, 1.0}, {0.0, 1.0}}};
  const std::array<std::vector<double>, 5> side_patterns{
      std::vector<double>{},
      std::vector<double>{0.5},
      std::vector<double>{0.25, 0.5},
      std::vector<double>{0.5, 0.75},
      std::vector<double>{0.25, 0.5, 0.75},
  };
  const auto make_plan = [&](const std::array<int, 4>& pattern) {
    std::vector<Point2> boundary;
    EmptyTemplateSideParameters side_parameters;
    for (int side = 0; side < 4; ++side) {
      boundary.push_back(corners[static_cast<std::size_t>(side)]);
      side_parameters[static_cast<std::size_t>(side)] =
          side_patterns[static_cast<std::size_t>(pattern[static_cast<std::size_t>(side)])];
      for (const double t : side_parameters[static_cast<std::size_t>(side)]) {
        const Point2 a = corners[static_cast<std::size_t>(side)];
        const Point2 b = corners[static_cast<std::size_t>((side + 1) % 4)];
        boundary.push_back(a + (b - a) * t);
      }
    }
    return choose_empty_template(corners, boundary, side_parameters);
  };
  struct ExpectedCase {
    std::array<int, 4> pattern;
    std::vector<Point2> interior;
    std::vector<std::array<int, 4>> quads;
  };
  const std::vector<ExpectedCase> cases{
      {{0, 0, 0, 2},
       {{0.75, 0.75}, {0.75, 0.5}},
       {{3, 2, 6, 4}, {4, 6, 7, 5}, {5, 7, 1, 0}, {6, 2, 1, 7}}},
      {{0, 0, 2, 2},
       {{0.5, 0.75}, {0.75, 0.5}},
       {{5, 4, 8, 6}, {4, 3, 9, 8}, {6, 8, 9, 7}, {3, 2, 1, 9}, {7, 9, 1, 0}}},
      {{0, 0, 2, 3},
       {{0.5, 0.5}, {0.75, 0.25}},
       {{5, 4, 8, 6}, {4, 3, 9, 8}, {6, 8, 9, 7}, {3, 2, 1, 9}, {7, 9, 1, 0}}},
      {{0, 0, 3, 2},
       {{0.25, 0.75}, {0.5, 0.5}},
       {{5, 4, 8, 6}, {4, 3, 9, 8}, {6, 8, 9, 7}, {3, 2, 1, 9}, {7, 9, 1, 0}}},
      {{0, 0, 4, 4},
       {{0.25, 0.75}, {0.5, 0.5}, {0.75, 0.25}},
       {{6, 5, 10, 7}, {5, 4, 11, 10}, {7, 10, 11, 8}, {4, 3, 12, 11},
        {8, 11, 12, 9}, {3, 2, 1, 12}, {9, 12, 1, 0}}},
  };

  for (std::size_t case_index = 0; case_index < cases.size(); ++case_index) {
    SCOPED_TRACE("canonical gap case " + std::to_string(case_index + 1));
    const ExpectedCase& expected = cases[case_index];
    const EmptyTemplatePlan plan = make_plan(expected.pattern);
    ASSERT_EQ(plan.kind, EmptyTemplateKind::RecursiveSplit);
    ASSERT_EQ(plan.interior.size(), expected.interior.size());
    for (std::size_t i = 0; i < expected.interior.size(); ++i) {
      EXPECT_DOUBLE_EQ(plan.interior[i].x, expected.interior[i].x);
      EXPECT_DOUBLE_EQ(plan.interior[i].y, expected.interior[i].y);
    }
    EXPECT_EQ(canonical_quads(plan.quads), canonical_quads(expected.quads));
    EXPECT_TRUE(plan.meets_quality_contract);
  }
}

TEST(EmptyFill, DrawnThreeSideGridAndCapCoversLastThreeCanonicalGapCases)
{
  const std::array<Point2, 4> corners{{{0.0, 0.0}, {1.0, 0.0}, {1.0, 1.0}, {0.0, 1.0}}};
  const std::array<std::vector<double>, 5> side_patterns{
      std::vector<double>{},
      std::vector<double>{0.5},
      std::vector<double>{0.25, 0.5},
      std::vector<double>{0.5, 0.75},
      std::vector<double>{0.25, 0.5, 0.75},
  };
  const auto make_plan = [&](const std::array<int, 4>& pattern) {
    std::vector<Point2> boundary;
    EmptyTemplateSideParameters side_parameters;
    for (int side = 0; side < 4; ++side) {
      boundary.push_back(corners[static_cast<std::size_t>(side)]);
      side_parameters[static_cast<std::size_t>(side)] =
          side_patterns[static_cast<std::size_t>(pattern[static_cast<std::size_t>(side)])];
      for (const double t : side_parameters[static_cast<std::size_t>(side)]) {
        const Point2 a = corners[static_cast<std::size_t>(side)];
        const Point2 b = corners[static_cast<std::size_t>((side + 1) % 4)];
        boundary.push_back(a + (b - a) * t);
      }
    }
    return choose_empty_template(corners, boundary, side_parameters);
  };
  struct ExpectedCase {
    std::array<int, 4> pattern;
    std::vector<Point2> interior;
    std::vector<std::array<int, 4>> quads;
  };
  const std::vector<std::array<int, 4>> two_row_quads{
      {7, 6, 12, 8}, {6, 5, 13, 12}, {5, 4, 3, 13}, {9, 10, 12, 8},
      {10, 11, 13, 12}, {11, 2, 3, 13}, {0, 14, 10, 9}, {14, 15, 11, 10},
      {15, 1, 2, 11}, {0, 1, 15, 14},
  };
  const std::vector<ExpectedCase> cases{
      {{0, 2, 2, 3},
       {{0.5, 0.25}, {0.75, 0.25}, {0.5, 0.5}, {0.75, 0.5},
        {0.5, 0.1875}, {0.75, 0.1875}},
       two_row_quads},
      {{0, 3, 2, 2},
       {{0.5, 0.5}, {0.75, 0.5}, {0.5, 0.75}, {0.75, 0.75},
        {0.5, 1.0 / 3.0}, {0.75, 1.0 / 3.0}},
       two_row_quads},
      {{0, 4, 2, 4},
       {{0.5, 0.25}, {0.75, 0.25}, {0.5, 0.5}, {0.75, 0.5},
        {0.5, 0.75}, {0.75, 0.75}, {0.5, 0.1875}, {0.75, 0.1875}},
       {{8, 7, 16, 9}, {7, 6, 17, 16}, {6, 5, 4, 17}, {11, 12, 14, 10},
        {12, 13, 15, 14}, {13, 2, 3, 15}, {10, 14, 16, 9}, {14, 15, 17, 16},
        {15, 3, 4, 17}, {0, 18, 12, 11}, {18, 19, 13, 12}, {19, 1, 2, 13},
        {0, 1, 19, 18}}},
  };

  for (std::size_t case_index = 0; case_index < cases.size(); ++case_index) {
    SCOPED_TRACE("canonical gap case " + std::to_string(case_index + 6));
    const ExpectedCase& expected = cases[case_index];
    const EmptyTemplatePlan plan = make_plan(expected.pattern);
    ASSERT_EQ(plan.kind, EmptyTemplateKind::RecursiveSplit);
    ASSERT_EQ(plan.interior.size(), expected.interior.size());
    for (std::size_t i = 0; i < expected.interior.size(); ++i) {
      EXPECT_DOUBLE_EQ(plan.interior[i].x, expected.interior[i].x);
      EXPECT_DOUBLE_EQ(plan.interior[i].y, expected.interior[i].y);
    }
    EXPECT_EQ(canonical_quads(plan.quads), canonical_quads(expected.quads));
    EXPECT_TRUE(plan.meets_quality_contract);
  }
}

TEST(EmptyFill, FloodClassifiesInsideAndOutside)
{
  qtest::StageFixture f;
  f.build(qtest::rect_domain(1.0, 1.0, 0.2));
  BoundaryTopology topo;
  compute_side_crossings(f.lat, f.gm, topo, f.mb, f.config);
  classify_leaves(f.lat, f.gm, topo, f.mb, nullptr);
  classify_empty_components(f.lat, topo);

  EXPECT_GT(count_class(topo, LeafClass::EmptyInside), 0);
  EXPECT_GT(count_class(topo, LeafClass::EmptyOutside), 0);
}

TEST(EmptyFill, EmitsInteriorQuadsDeterministically)
{
  qtest::StageFixture a;
  a.build(qtest::rect_domain(1.0, 1.0, 0.2));
  BoundaryTopology ta;
  compute_side_crossings(a.lat, a.gm, ta, a.mb, a.config);
  classify_leaves(a.lat, a.gm, ta, a.mb, nullptr);
  classify_empty_components(a.lat, ta);
  const std::size_t quads_before = a.mb.quads.size();
  mesh_empty_squares(a.lat, a.gm, a.config, ta, a.mb, nullptr);
  EXPECT_GT(a.mb.quads.size(), quads_before);

  qtest::StageFixture b;
  b.build(qtest::rect_domain(1.0, 1.0, 0.2));
  BoundaryTopology tb;
  compute_side_crossings(b.lat, b.gm, tb, b.mb, b.config);
  classify_leaves(b.lat, b.gm, tb, b.mb, nullptr);
  classify_empty_components(b.lat, tb);
  mesh_empty_squares(b.lat, b.gm, b.config, tb, b.mb, nullptr);

  EXPECT_EQ(a.mb.quads.size(), b.mb.quads.size());
  EXPECT_EQ(a.mb.nodes.size(), b.mb.nodes.size());
}

TEST(EmptyFill, LocalTransitionsUseGlobalParityPathsWithoutMutatingTree)
{
  DomainGeometry domain;
  PolylineLoop loop{{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.0}, {0.0, 2.0}}, true};
  loop.target_cell_size = 1.0;
  loop.sizing_samples = {
      {0.0, 0.125}, {0.25, 0.125}, {0.35, 1.0},
      {0.75, 1.0}, {0.85, 0.125}, {1.0, 0.125}};
  domain.outer_loops.push_back(loop);

  qtest::StageFixture f;
  f.build(domain);
  BoundaryTopology topo;
  compute_side_crossings(f.lat, f.gm, topo, f.mb, f.config);
  classify_leaves(f.lat, f.gm, topo, f.mb, nullptr);
  classify_empty_components(f.lat, topo);
  const std::vector<Cell> cells_before = f.lat.tree.cells;

  MesherDebug debug;
  mesh_empty_squares(f.lat, f.gm, f.config, topo, f.mb, &debug);

  std::size_t split_count = 0;
  for (const auto& [span, splits] : topo.side_splits) {
    (void)span;
    split_count += splits.size();
  }
  EXPECT_EQ(split_count, 11u);
  // Four parity defects in this graded fixture have two possible pairings.
  // The global matching selects the seven-span, length-1.25 T-join.
  EXPECT_EQ(debug.parity_defect_count, 4u);
  EXPECT_EQ(debug.parity_path_split_count, 7u);
  EXPECT_DOUBLE_EQ(debug.parity_path_total_length, 1.25);

  ASSERT_EQ(f.lat.tree.cells.size(), cells_before.size());
  for (std::size_t i = 0; i < cells_before.size(); ++i) {
    EXPECT_EQ(f.lat.tree.cells[i].level, cells_before[i].level);
    EXPECT_EQ(f.lat.tree.cells[i].ix, cells_before[i].ix);
    EXPECT_EQ(f.lat.tree.cells[i].iy, cells_before[i].iy);
    EXPECT_EQ(f.lat.tree.cells[i].child0, cells_before[i].child0);
  }
  EXPECT_FALSE(topo.side_splits.empty());
}
