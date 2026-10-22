#include "stage_test_util.hpp"

#include "quadmesh/shapes.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <numbers>

using namespace quadmesh;
using namespace quadmesh::detail;

TEST(Sizing, RootIsTwiceExtent)
{
  qtest::StageFixture f;
  f.build(qtest::rect_domain(1.0, 1.0));
  // extent of [0,1]^2 is 1, and the root square is target-independent 2*extent.
  EXPECT_DOUBLE_EQ(f.lat.root_size, 2.0);
}

TEST(Sizing, BandSizeAtMostSqrt2TimesTarget)
{
  qtest::StageFixture f;
  const double target = 0.25;
  f.build(qtest::rect_domain(1.0, 1.0, target));
  // Achieved band size = root/2^level, rounded to nearest in log scale and only
  // ever refined (never coarsened) by separation: so it stays <= sqrt2*target.
  const double achieved = f.lat.chain_size(0);
  EXPECT_GT(achieved, 0.0);
  EXPECT_LE(achieved, target * std::numbers::sqrt2_v<double> * (1.0 + 1.0e-9));
}

TEST(Sizing, CoarserTargetNeverRefinesPastFiner)
{
  qtest::StageFixture coarse;
  coarse.build(qtest::rect_domain(1.0, 1.0, 0.2));
  qtest::StageFixture fine;
  fine.build(qtest::rect_domain(1.0, 1.0, 0.05));
  // Monotonicity: a coarser target must not produce a finer (higher) level.
  EXPECT_LE(coarse.lat.chain_levels[0], fine.lat.chain_levels[0]);
}

TEST(Sizing, UnconstrainedStaysCoarserThanFineTarget)
{
  qtest::StageFixture unconstrained;
  unconstrained.build(qtest::rect_domain(1.0, 1.0, 0.0, /*unconstrained=*/true));
  qtest::StageFixture fine;
  fine.build(qtest::rect_domain(1.0, 1.0, 0.03));
  EXPECT_LT(unconstrained.lat.chain_levels[0], fine.lat.chain_levels[0]);
}

TEST(Sizing, Deterministic)
{
  qtest::StageFixture a;
  a.build(qtest::rect_domain(1.3, 0.7, 0.1));
  qtest::StageFixture b;
  b.build(qtest::rect_domain(1.3, 0.7, 0.1));
  EXPECT_EQ(a.lat.chain_levels, b.lat.chain_levels);
  EXPECT_DOUBLE_EQ(a.lat.root_size, b.lat.root_size);
  EXPECT_DOUBLE_EQ(a.lat.origin.x, b.lat.origin.x);
  EXPECT_DOUBLE_EQ(a.lat.origin.y, b.lat.origin.y);
  EXPECT_EQ(a.lat.tree.cells.size(), b.lat.tree.cells.size());
}

TEST(Sizing, LocalPromotionKeepsTheDistantBorderCoarse)
{
  DomainGeometry domain;
  PolylineLoop outer{{{0.0, 0.0}, {8.0, 0.0}, {8.0, 4.4}, {0.0, 4.4}}, true};
  outer.target_cell_size = 3.0;
  domain.outer_loops.push_back(outer);
  PolylineLoop hole = circle_loop({2.0, 1.2}, 0.42, 64);
  hole.target_cell_size = 0.1;
  domain.inner_loops.push_back({hole, InnerLoopRole::Hole});

  qtest::StageFixture local;
  local.config.refinement.sizing_promotion = SizingPromotionMode::Local;
  local.build(domain);
  qtest::StageFixture local_again;
  local_again.config.refinement.sizing_promotion = SizingPromotionMode::Local;
  local_again.build(domain);
  qtest::StageFixture whole;
  whole.build(domain);

  ASSERT_EQ(local.lat.sizing_promotions.size(), 2u);
  EXPECT_TRUE(std::any_of(local.lat.sizing_promotions[0].begin(),
                          local.lat.sizing_promotions[0].end(),
                          [](const auto& segment) { return !segment.empty(); }));
  EXPECT_TRUE(std::all_of(local.lat.sizing_promotions[1].begin(),
                         local.lat.sizing_promotions[1].end(),
                         [](const auto& segment) { return segment.empty(); }));
  EXPECT_TRUE(std::all_of(whole.lat.sizing_promotions[0].begin(),
                         whole.lat.sizing_promotions[0].end(),
                         [](const auto& segment) { return segment.empty(); }));
  EXPECT_LT(local.lat.chain_levels[0], whole.lat.chain_levels[0]);

  std::array<std::uint16_t, 4> side_level{};
  for (std::size_t segment = 0; segment < local.lat.sizing_promotions[0].size(); ++segment) {
    for (const BoundaryLevelPromotion& promotion : local.lat.sizing_promotions[0][segment]) {
      side_level[segment] = std::max(side_level[segment], promotion.level);
    }
  }
  EXPECT_GT(side_level[0], side_level[1]); // bottom near the hole vs distant right side
  EXPECT_GT(side_level[3], side_level[1]); // left near the hole vs distant right side

  ASSERT_EQ(local.lat.sizing_promotions[0].size(), local_again.lat.sizing_promotions[0].size());
  for (std::size_t segment = 0; segment < local.lat.sizing_promotions[0].size(); ++segment) {
    ASSERT_EQ(local.lat.sizing_promotions[0][segment].size(),
              local_again.lat.sizing_promotions[0][segment].size());
    for (std::size_t i = 0; i < local.lat.sizing_promotions[0][segment].size(); ++i) {
      const BoundaryLevelPromotion& a = local.lat.sizing_promotions[0][segment][i];
      const BoundaryLevelPromotion& b = local_again.lat.sizing_promotions[0][segment][i];
      EXPECT_DOUBLE_EQ(a.t0, b.t0);
      EXPECT_DOUBLE_EQ(a.t1, b.t1);
      EXPECT_EQ(a.level, b.level);
    }
  }
}
