#include "quadmesh/geometry.hpp"

#include <gtest/gtest.h>

TEST(Geometry, SegmentIntersectionFindsCrossing)
{
  const auto hit = quadmesh::intersect_segments(
      {{0.0, 0.0}, {1.0, 1.0}},
      {{0.0, 1.0}, {1.0, 0.0}},
      1.0e-12);

  ASSERT_TRUE(hit.has_value());
  EXPECT_NEAR(hit->point.x, 0.5, 1.0e-12);
  EXPECT_NEAR(hit->point.y, 0.5, 1.0e-12);
  EXPECT_NEAR(hit->t_first, 0.5, 1.0e-12);
  EXPECT_NEAR(hit->t_second, 0.5, 1.0e-12);
}

TEST(Geometry, SegmentIntersectionRejectsParallelAndDisjoint)
{
  EXPECT_FALSE(quadmesh::intersect_segments(
                   {{0.0, 0.0}, {1.0, 0.0}}, {{0.0, 1.0}, {1.0, 1.0}}, 1.0e-12)
                   .has_value());
  EXPECT_FALSE(quadmesh::intersect_segments(
                   {{0.0, 0.0}, {1.0, 0.0}}, {{2.0, -1.0}, {2.0, 1.0}}, 1.0e-12)
                   .has_value());
}

TEST(Geometry, DistanceToSegmentHandlesEndpoints)
{
  const quadmesh::Segment2 seg{{0.0, 0.0}, {1.0, 0.0}};
  EXPECT_NEAR(quadmesh::distance_to_segment({0.5, 0.5}, seg), 0.5, 1.0e-12);
  EXPECT_NEAR(quadmesh::distance_to_segment({2.0, 0.0}, seg), 1.0, 1.0e-12);
  EXPECT_NEAR(quadmesh::distance_to_segment({-3.0, 4.0}, seg), 5.0, 1.0e-12);
}

TEST(Geometry, SegmentAabbIntersection)
{
  const quadmesh::Aabb2 box{{0.0, 0.0}, {1.0, 1.0}};
  EXPECT_TRUE(quadmesh::segment_intersects_aabb({{-1.0, 0.5}, {2.0, 0.5}}, box));
  EXPECT_TRUE(quadmesh::segment_intersects_aabb({{0.25, 0.25}, {0.75, 0.75}}, box));
  EXPECT_FALSE(quadmesh::segment_intersects_aabb({{-1.0, 2.0}, {2.0, 2.0}}, box));
  EXPECT_FALSE(quadmesh::segment_intersects_aabb({{1.5, -1.0}, {1.5, 2.0}}, box));
}

TEST(Geometry, BoundsOfDomainMergesLoops)
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back({{{0.0, 0.0}, {2.0, 0.0}, {2.0, 1.0}, {0.0, 1.0}}, true});
  domain.inner_loops.push_back({{{{0.5, -0.5}, {1.0, -0.5}, {1.0, 0.5}}, true},
                                quadmesh::InnerLoopRole::Hole});
  const quadmesh::Aabb2 box = quadmesh::bounds_of(domain);
  EXPECT_DOUBLE_EQ(box.min.x, 0.0);
  EXPECT_DOUBLE_EQ(box.min.y, -0.5);
  EXPECT_DOUBLE_EQ(box.max.x, 2.0);
  EXPECT_DOUBLE_EQ(box.max.y, 1.0);
}
