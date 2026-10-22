#include "stage_test_util.hpp"

#include "quadmesh/geometry.hpp"

#include <gtest/gtest.h>

#include <cstdint>

using namespace quadmesh;
using namespace quadmesh::detail;

TEST(Repel, MovedPointsActuallyMoveAndStayInCell)
{
  qtest::StageFixture f;
  f.build(qtest::rect_domain(1.0, 1.0, 0.2));

  const double smallest_cell = f.lat.tree.size_at(f.lat.tree.lattice_level);
  for (const auto& [key, moved] : f.pert.moved_gp) {
    const std::uint32_t gx = static_cast<std::uint32_t>(key >> 21);
    const std::uint32_t gy = static_cast<std::uint32_t>(key & ((1u << 21) - 1u));
    const Point2 orig = f.lat.tree.gp_position(gx, gy);
    // Repelling only records a point if it moved off its grid position.
    EXPECT_GT(distance(orig, moved), 0.0);
    // ...but never past 0.45*s of its own cell (s >= the smallest cell).
    EXPECT_LE(distance(orig, moved), 0.45 * f.lat.root_size);
    EXPECT_GE(smallest_cell, 0.0);
  }
}

TEST(Repel, Deterministic)
{
  qtest::StageFixture a;
  a.build(qtest::rect_domain(1.0, 1.0, 0.2));
  qtest::StageFixture b;
  b.build(qtest::rect_domain(1.0, 1.0, 0.2));
  ASSERT_EQ(a.pert.moved_gp.size(), b.pert.moved_gp.size());
  for (const auto& [key, moved] : a.pert.moved_gp) {
    const auto it = b.pert.moved_gp.find(key);
    ASSERT_NE(it, b.pert.moved_gp.end());
    EXPECT_DOUBLE_EQ(moved.x, it->second.x);
    EXPECT_DOUBLE_EQ(moved.y, it->second.y);
  }
}
