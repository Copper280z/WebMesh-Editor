#include "quadmesh/pipeline.hpp"

#include <gtest/gtest.h>

#include <cmath>
#include <numbers>

namespace {

constexpr double pi = std::numbers::pi_v<double>;

quadmesh::PolylineLoop circle(quadmesh::Point2 center, double radius, int segments)
{
  quadmesh::PolylineLoop loop;
  loop.closed = true;
  for (int i = 0; i < segments; ++i) {
    const double theta = 2.0 * pi * i / segments;
    loop.vertices.push_back(
        {center.x + radius * std::cos(theta), center.y + radius * std::sin(theta)});
  }
  return loop;
}

quadmesh::PolylineLoop star(quadmesh::Point2 center, double outer, double inner)
{
  quadmesh::PolylineLoop loop;
  loop.closed = true;
  for (int i = 0; i < 10; ++i) {
    const double radius = (i % 2 == 0) ? outer : inner;
    const double theta = -pi / 2.0 + i * pi / 5.0;
    loop.vertices.push_back(
        {center.x + radius * std::cos(theta), center.y + radius * std::sin(theta)});
  }
  return loop;
}

struct Expectation {
  double min_angle_deg = 20.0;
  double max_angle_deg = 170.0;
};

void expect_good_mesh(const quadmesh::DomainGeometry& domain,
                      const quadmesh::MeshingConfig& config,
                      const Expectation& expect)
{
  const quadmesh::PipelineRunResult result = quadmesh::MeshingPipeline{}.run(domain, config);
  for (const std::string& issue : result.validation.issues) {
    ADD_FAILURE() << "validation issue: " << issue;
  }
  EXPECT_TRUE(result.validation.ok);
  EXPECT_GT(result.mesh.quads.size(), 0u);
  EXPECT_EQ(result.validation.inverted_quad_count, 0u);
  EXPECT_EQ(result.validation.nonconforming_edge_count, 0u);
  EXPECT_EQ(result.validation.boundary_crossing_edge_count, 0u);
  EXPECT_GE(result.validation.min_angle_deg, expect.min_angle_deg)
      << "min angle " << result.validation.min_angle_deg;
  EXPECT_LE(result.validation.max_angle_deg, expect.max_angle_deg)
      << "max angle " << result.validation.max_angle_deg;
}

// Median length of mesh boundary edges whose endpoints both satisfy
// `on_loop` — the typical boundary spacing along that loop. The minimum is
// not used: midpoint subdivision legitimately makes individual boundary
// edges a small fraction of the band size.
template <typename Predicate>
double median_boundary_edge(const quadmesh::PipelineRunResult& result, Predicate on_loop)
{
  std::vector<double> lengths;
  for (const quadmesh::Quad4& quad : result.mesh.quads) {
    for (int k = 0; k < 4; ++k) {
      const quadmesh::MeshNode& a = result.mesh.nodes[quad.nodes[k].value];
      const quadmesh::MeshNode& b = result.mesh.nodes[quad.nodes[(k + 1) % 4].value];
      if (a.on_boundary && b.on_boundary && on_loop(a.point) && on_loop(b.point)) {
        lengths.push_back(quadmesh::distance(a.point, b.point));
      }
    }
  }
  if (lengths.empty()) {
    return 0.0;
  }
  std::sort(lengths.begin(), lengths.end());
  return lengths[lengths.size() / 2];
}

void expect_boundary_edges_on_geometry(const quadmesh::PipelineRunResult& result,
                                       const quadmesh::DomainGeometry& domain)
{
  std::vector<quadmesh::Segment2> segments;
  for (const quadmesh::PolylineLoop& loop : domain.outer_loops) {
    const auto loop_segments = quadmesh::loop_segments(loop);
    segments.insert(segments.end(), loop_segments.begin(), loop_segments.end());
  }
  for (const quadmesh::InnerLoop& inner : domain.inner_loops) {
    const auto loop_segments = quadmesh::loop_segments(inner.loop);
    segments.insert(segments.end(), loop_segments.begin(), loop_segments.end());
  }
  std::map<std::pair<std::uint32_t, std::uint32_t>, int> edge_count;
  for (const quadmesh::Quad4& quad : result.mesh.quads) {
    for (int k = 0; k < 4; ++k) {
      const std::uint32_t a = quad.nodes[k].value;
      const std::uint32_t b = quad.nodes[(k + 1) % 4].value;
      ++edge_count[{std::min(a, b), std::max(a, b)}];
    }
  }
  for (const auto& [edge, count] : edge_count) {
    if (count != 1) {
      continue;
    }
    const quadmesh::Point2 a = result.mesh.nodes[edge.first].point;
    const quadmesh::Point2 b = result.mesh.nodes[edge.second].point;
    bool found = false;
    for (const quadmesh::Segment2& segment : segments) {
      const quadmesh::Vec2 direction = segment.b - segment.a;
      const double len2 = quadmesh::dot(direction, direction);
      if (len2 <= 1.0e-24) {
        continue;
      }
      const double len = std::sqrt(len2);
      if (std::abs(quadmesh::cross(direction, a - segment.a)) > 1.0e-8 * len
          || std::abs(quadmesh::cross(direction, b - segment.a)) > 1.0e-8 * len) {
        continue;
      }
      const double ta = quadmesh::dot(a - segment.a, direction) / len2;
      const double tb = quadmesh::dot(b - segment.a, direction) / len2;
      if (ta >= -1.0e-8 && ta <= 1.0 + 1.0e-8 && tb >= -1.0e-8 && tb <= 1.0 + 1.0e-8) {
        found = true;
        break;
      }
    }
    EXPECT_TRUE(found) << "boundary edge off geometry from (" << a.x << ", " << a.y << ") to ("
                       << b.x << ", " << b.y << ")";
  }
}

bool has_adjacent_boundary_level_transition(const quadmesh::PipelineRunResult& result)
{
  const auto& leaves = result.debug.leaves;
  const auto overlap = [](double a0, double a1, double b0, double b1) {
    return std::min(a1, b1) - std::max(a0, b0);
  };
  for (std::size_t i = 0; i < leaves.size(); ++i) {
    if (leaves[i].classification != 2 && leaves[i].classification != 3) {
      continue;
    }
    for (std::size_t j = i + 1; j < leaves.size(); ++j) {
      if ((leaves[j].classification != 2 && leaves[j].classification != 3)
          || std::abs(static_cast<int>(leaves[i].level) - static_cast<int>(leaves[j].level)) != 1) {
        continue;
      }
      const bool vertical_side =
          (std::abs(leaves[i].box.max.x - leaves[j].box.min.x) < 1.0e-10
           || std::abs(leaves[j].box.max.x - leaves[i].box.min.x) < 1.0e-10)
          && overlap(leaves[i].box.min.y, leaves[i].box.max.y,
                     leaves[j].box.min.y, leaves[j].box.max.y) > 1.0e-10;
      const bool horizontal_side =
          (std::abs(leaves[i].box.max.y - leaves[j].box.min.y) < 1.0e-10
           || std::abs(leaves[j].box.max.y - leaves[i].box.min.y) < 1.0e-10)
          && overlap(leaves[i].box.min.x, leaves[i].box.max.x,
                     leaves[j].box.min.x, leaves[j].box.max.x) > 1.0e-10;
      if (vertical_side || horizontal_side) {
        return true;
      }
    }
  }
  return false;
}

} // namespace

TEST(PipelineContract, AxisAlignedSquare)
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back({{{0.0, 0.0}, {1.0, 0.0}, {1.0, 1.0}, {0.0, 1.0}}, true});
  expect_good_mesh(domain, {}, {25.0, 161.0});
}

TEST(PipelineContract, RotatedSquare)
{
  quadmesh::DomainGeometry domain;
  const double c = std::cos(pi / 4.0);
  domain.outer_loops.push_back({{{c, 0.0}, {2.0 * c, c}, {c, 2.0 * c}, {0.0, c}}, true});
  expect_good_mesh(domain, {}, {20.0, 170.0});
}

TEST(PipelineContract, PlateWithCircularHole)
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back({{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true});
  domain.inner_loops.push_back({circle({2.0, 1.2}, 0.42, 64), quadmesh::InnerLoopRole::Hole});
  quadmesh::MeshingConfig config;
  config.refinement.target_cell_size = 0.16;
  expect_good_mesh(domain, config, {25.0, 161.0});
}

TEST(PipelineContract, PlateWithStarHole)
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back({{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true});
  domain.inner_loops.push_back({star({2.0, 1.2}, 0.54, 0.24), quadmesh::InnerLoopRole::Hole});
  quadmesh::MeshingConfig config;
  config.refinement.target_cell_size = 0.16;
  // Sharp input features: the paper's star example reports (27.2, 160.6).
  expect_good_mesh(domain, config, {20.0, 170.0});
}

TEST(PipelineContract, LShapedDomain)
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back(
      {{{0.0, 0.0}, {2.0, 0.0}, {2.0, 1.0}, {0.8, 1.0}, {0.8, 1.6}, {0.0, 1.6}}, true});
  expect_good_mesh(domain, {}, {20.0, 170.0});
}

TEST(PipelineContract, PlateWithTwoHoles)
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back({{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.0}, {0.0, 2.0}}, true});
  domain.inner_loops.push_back({circle({1.2, 1.0}, 0.35, 48), quadmesh::InnerLoopRole::Hole});
  domain.inner_loops.push_back({circle({2.8, 1.0}, 0.35, 48), quadmesh::InnerLoopRole::Hole});
  quadmesh::MeshingConfig config;
  config.refinement.target_cell_size = 0.15;
  expect_good_mesh(domain, config, {25.0, 161.0});
}

TEST(PipelineContract, PerLoopSizing)
{
  quadmesh::DomainGeometry domain;
  quadmesh::PolylineLoop outer{{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true};
  outer.target_cell_size = 0.5;
  domain.outer_loops.push_back(outer);
  quadmesh::PolylineLoop hole = circle({2.0, 1.2}, 0.42, 64);
  hole.target_cell_size = 0.06;
  domain.inner_loops.push_back({hole, quadmesh::InnerLoopRole::Hole});
  // Band uniformity against the fine hole costs a few degrees at transitions.
  expect_good_mesh(domain, {}, {20.0, 168.0});

  const auto result = quadmesh::MeshingPipeline{}.run(domain, {});
  // The hole boundary must be sampled much more finely than the outer
  // border: compare typical boundary spacing on each loop.
  const double hole_spacing = median_boundary_edge(result, [](quadmesh::Point2 p) {
    return std::abs(std::hypot(p.x - 2.0, p.y - 1.2) - 0.42) < 0.01;
  });
  const double outer_spacing = median_boundary_edge(
      result, [](quadmesh::Point2 p) { return std::abs(p.y) < 1.0e-9; });
  EXPECT_LT(hole_spacing * 3.0, outer_spacing)
      << "hole=" << hole_spacing << " outer=" << outer_spacing;
}

TEST(PipelineContract, OffsetFineHolePromotesOnlyTheNearbyBorder)
{
  quadmesh::DomainGeometry domain;
  quadmesh::PolylineLoop outer{{{0.0, 0.0}, {8.0, 0.0}, {8.0, 4.4}, {0.0, 4.4}}, true};
  outer.target_cell_size = 3.0;
  domain.outer_loops.push_back(outer);
  quadmesh::PolylineLoop hole = circle({2.0, 1.2}, 0.42, 64);
  hole.target_cell_size = 0.1;
  domain.inner_loops.push_back({hole, quadmesh::InnerLoopRole::Hole});

  quadmesh::MeshingConfig local_config;
  local_config.refinement.sizing_promotion = quadmesh::SizingPromotionMode::Local;
  const auto local = quadmesh::MeshingPipeline{}.run(domain, local_config);
  const auto whole = quadmesh::MeshingPipeline{}.run(domain, {});
  for (const std::string& issue : local.validation.issues) {
    ADD_FAILURE() << "local promotion validation issue: " << issue;
  }
  for (const std::string& warning : local.debug.warnings) {
    ADD_FAILURE() << "local promotion warning: " << warning;
  }
  ASSERT_TRUE(local.validation.ok);
  ASSERT_TRUE(whole.validation.ok);
  EXPECT_EQ(local.validation.nonconforming_edge_count, 0u);

  const auto near_border = [](quadmesh::Point2 p) {
    return (std::abs(p.y) < 1.0e-9 && p.x < 4.0)
        || (std::abs(p.x) < 1.0e-9 && p.y < 2.8);
  };
  const auto far_border = [](quadmesh::Point2 p) {
    return (std::abs(p.y - 4.4) < 1.0e-9 && p.x > 4.0)
        || (std::abs(p.x - 8.0) < 1.0e-9 && p.y > 2.2);
  };
  const double local_near = median_boundary_edge(local, near_border);
  const double local_far = median_boundary_edge(local, far_border);
  const double whole_far = median_boundary_edge(whole, far_border);
  EXPECT_GT(local_near, 0.0);
  EXPECT_GT(whole_far, 0.0);
  EXPECT_GT(local_far, 1.75 * local_near)
      << "near=" << local_near << " far=" << local_far;
  EXPECT_GT(local_far, 3.0 * whole_far)
      << "local_far=" << local_far << " whole_far=" << whole_far;
  EXPECT_LT(local.mesh.quads.size() * 100u, whole.mesh.quads.size() * 85u);
  EXPECT_GE(local.validation.min_angle_deg, 20.0);
  EXPECT_GE(local.validation.min_scaled_jacobian, 0.3);
  EXPECT_GE(local.validation.min_edge_ratio, 0.1);
}

TEST(PipelineContract, ArcLengthLocalSizingOnSmoothLoop)
{
  quadmesh::DomainGeometry domain;
  quadmesh::PolylineLoop loop = circle({0.0, 0.0}, 1.0, 64);
  loop.target_cell_size = 0.5;
  loop.sizing_samples = {
      {0.0, 0.0625}, {0.18, 0.0625}, {0.35, 0.5},
      {0.65, 0.5}, {0.82, 0.0625}, {1.0, 0.0625}};
  domain.outer_loops.push_back(loop);

  const auto result = quadmesh::MeshingPipeline{}.run(domain, {});
  for (const std::string& issue : result.validation.issues) {
    ADD_FAILURE() << "validation issue: " << issue;
  }
  for (const std::string& warning : result.debug.warnings) {
    ADD_FAILURE() << "mesher warning: " << warning;
  }
  EXPECT_TRUE(result.validation.ok);
  EXPECT_EQ(result.validation.nonconforming_edge_count, 0u);
  EXPECT_TRUE(has_adjacent_boundary_level_transition(result));
  EXPECT_GE(result.validation.min_angle_deg, 20.0);
  EXPECT_GE(result.validation.min_scaled_jacobian, 0.3);
  EXPECT_GE(result.validation.min_edge_ratio, 0.1);

  const double fine_spacing = median_boundary_edge(result, [](quadmesh::Point2 p) {
    return p.x > 0.7;
  });
  const double coarse_spacing = median_boundary_edge(result, [](quadmesh::Point2 p) {
    return p.x < -0.7;
  });
  EXPECT_GT(fine_spacing, 0.0);
  EXPECT_GT(coarse_spacing, fine_spacing * 3.0)
      << "fine=" << fine_spacing << " coarse=" << coarse_spacing;
}

TEST(PipelineContract, ArcLengthLocalSizingOnStraightPolygonSides)
{
  quadmesh::DomainGeometry domain;
  quadmesh::PolylineLoop loop{{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.0}, {0.0, 2.0}}, true};
  loop.target_cell_size = 1.0;
  loop.sizing_samples = {
      {0.0, 0.125}, {0.25, 0.125}, {0.35, 1.0},
      {0.75, 1.0}, {0.85, 0.125}, {1.0, 0.125}};
  domain.outer_loops.push_back(loop);
  quadmesh::MeshingConfig config;
  config.features.chord_tolerance_fraction = 0.0;

  const auto result = quadmesh::MeshingPipeline{}.run(domain, config);
  for (const std::string& issue : result.validation.issues) {
    ADD_FAILURE() << "validation issue: " << issue;
  }
  for (const std::string& warning : result.debug.warnings) {
    ADD_FAILURE() << "mesher warning: " << warning;
  }
  EXPECT_TRUE(result.validation.ok);
  EXPECT_EQ(result.validation.nonconforming_edge_count, 0u);
  EXPECT_TRUE(has_adjacent_boundary_level_transition(result));
  EXPECT_GE(result.validation.min_angle_deg, 20.0);
  EXPECT_GE(result.validation.min_scaled_jacobian, 0.3);
  EXPECT_GE(result.validation.min_edge_ratio, 0.1);

  const double fine_spacing = median_boundary_edge(result, [](quadmesh::Point2 p) {
    return std::abs(p.y) < 1.0e-10 && p.x > 0.5 && p.x < 2.0;
  });
  const double coarse_spacing = median_boundary_edge(result, [](quadmesh::Point2 p) {
    return std::abs(p.y - 2.0) < 1.0e-10 && p.x > 1.5 && p.x < 3.0;
  });
  EXPECT_NEAR(fine_spacing, 0.0625, 1.0e-10);
  EXPECT_NEAR(coarse_spacing, 0.5, 1.0e-10);

  for (const quadmesh::Point2 corner : loop.vertices) {
    const bool present = std::any_of(result.mesh.nodes.begin(), result.mesh.nodes.end(),
                                     [&](const quadmesh::MeshNode& node) {
                                       return node.on_boundary
                                           && quadmesh::distance(node.point, corner) < 1.0e-12;
                                     });
    EXPECT_TRUE(present) << "missing sharp corner (" << corner.x << ", " << corner.y << ")";
  }
}

TEST(PipelineContract, EmbeddedMeshControlLoopConformsBothSides)
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back({{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true});
  domain.inner_loops.push_back(
      {circle({2.0, 1.2}, 0.5, 48), quadmesh::InnerLoopRole::MeshControlFeature});
  quadmesh::MeshingConfig config;
  config.refinement.target_cell_size = 0.2;
  const quadmesh::PipelineRunResult result = quadmesh::MeshingPipeline{}.run(domain, config);
  for (const std::string& issue : result.validation.issues) {
    ADD_FAILURE() << "validation issue: " << issue;
  }
  EXPECT_TRUE(result.validation.ok);

  // The interior of the control loop must be meshed too: some node lies
  // well inside the circle.
  bool interior_meshed = false;
  for (const quadmesh::MeshNode& node : result.mesh.nodes) {
    const double dx = node.point.x - 2.0;
    const double dy = node.point.y - 1.2;
    if (std::hypot(dx, dy) < 0.25) {
      interior_meshed = true;
      break;
    }
  }
  EXPECT_TRUE(interior_meshed);
}

TEST(PipelineContract, DeterministicAcrossRuns)
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back({{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true});
  domain.inner_loops.push_back({star({2.0, 1.2}, 0.54, 0.24), quadmesh::InnerLoopRole::Hole});
  quadmesh::MeshingConfig config;
  config.refinement.target_cell_size = 0.16;
  const auto first = quadmesh::MeshingPipeline{}.run(domain, config);
  const auto second = quadmesh::MeshingPipeline{}.run(domain, config);
  ASSERT_EQ(first.mesh.nodes.size(), second.mesh.nodes.size());
  ASSERT_EQ(first.mesh.quads.size(), second.mesh.quads.size());
  for (std::size_t i = 0; i < first.mesh.nodes.size(); ++i) {
    EXPECT_EQ(first.mesh.nodes[i].point.x, second.mesh.nodes[i].point.x);
    EXPECT_EQ(first.mesh.nodes[i].point.y, second.mesh.nodes[i].point.y);
  }
  for (std::size_t i = 0; i < first.mesh.quads.size(); ++i) {
    for (int k = 0; k < 4; ++k) {
      EXPECT_EQ(first.mesh.quads[i].nodes[k].value, second.mesh.quads[i].nodes[k].value);
    }
  }
}

TEST(PipelineContract, BoundaryNodesLieOnGeometry)
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back({{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true});
  domain.inner_loops.push_back({circle({2.0, 1.2}, 0.42, 64), quadmesh::InnerLoopRole::Hole});
  quadmesh::MeshingConfig config;
  config.refinement.target_cell_size = 0.16;
  const auto result = quadmesh::MeshingPipeline{}.run(domain, config);

  std::vector<quadmesh::Segment2> segments;
  for (const auto& seg : quadmesh::loop_segments(domain.outer_loops.front())) {
    segments.push_back(seg);
  }
  for (const auto& seg : quadmesh::loop_segments(domain.inner_loops.front().loop)) {
    segments.push_back(seg);
  }
  for (const quadmesh::MeshNode& node : result.mesh.nodes) {
    if (!node.on_boundary) {
      continue;
    }
    double best = 1.0e30;
    for (const auto& seg : segments) {
      best = std::min(best, quadmesh::distance_to_segment(node.point, seg));
    }
    EXPECT_LE(best, 1.0e-9) << "boundary node off geometry at (" << node.point.x << ", "
                            << node.point.y << ")";
  }
}

TEST(PipelineContract, BoundaryEdgesFollowShallowPolylineJoints)
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back(
      {{{0.0, 0.0}, {8.0, 0.0}, {8.0, 4.0}, {7.0, 4.0}, {5.5, 4.1}, {4.0, 4.0}, {0.0, 4.0}}, true});
  quadmesh::MeshingConfig config;
  config.refinement.target_cell_size = 0.5;
  config.features.chord_tolerance_fraction = 0.0;

  const auto result = quadmesh::MeshingPipeline{}.run(domain, config);
  EXPECT_TRUE(result.validation.ok);
  EXPECT_EQ(result.validation.boundary_off_geometry_edge_count, 0u);
  expect_boundary_edges_on_geometry(result, domain);
}

// Parameter-variation robustness: coarse border bands coexisting with fine
// hole bands, and circle tessellations whose joints range from smooth to
// decidedly sharp, must always yield a valid mesh. Angle bounds are not
// asserted here because sharp input corners bound them by the input itself;
// validity (conformity, no inversions, no flat corners, no boundary
// crossings) must hold regardless.
TEST(PipelineContract, BorderSizeAndSegmentCountSweep)
{
  for (const double border : {0.4, 1.2, 2.0, 3.0}) {
    for (const int segments : {8, 12, 16, 24, 48, 96}) {
      quadmesh::DomainGeometry domain;
      quadmesh::PolylineLoop outer{{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true};
      outer.target_cell_size = border;
      domain.outer_loops.push_back(outer);
      quadmesh::PolylineLoop hole = circle({2.0, 1.2}, 0.42, segments);
      hole.target_cell_size = 0.1;
      domain.inner_loops.push_back({hole, quadmesh::InnerLoopRole::Hole});

      const quadmesh::PipelineRunResult result = quadmesh::MeshingPipeline{}.run(domain, {});
      for (const std::string& issue : result.validation.issues) {
        ADD_FAILURE() << "border=" << border << " segments=" << segments
                      << " validation issue: " << issue;
      }
      EXPECT_TRUE(result.validation.ok) << "border=" << border << " segments=" << segments;
      EXPECT_GT(result.mesh.quads.size(), 0u);
    }
  }
}

// The original failing example configurations, kept verbatim.
TEST(PipelineContract, CoarseBorderExamples)
{
  {
    quadmesh::DomainGeometry domain;
    quadmesh::PolylineLoop outer{{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true};
    outer.target_cell_size = 2.0;
    domain.outer_loops.push_back(outer);
    quadmesh::PolylineLoop hole = star({2.0, 1.2}, 0.54, 0.24);
    hole.target_cell_size = 0.25;
    domain.inner_loops.push_back({hole, quadmesh::InnerLoopRole::Hole});
    const quadmesh::PipelineRunResult result = quadmesh::MeshingPipeline{}.run(domain, {});
    for (const std::string& issue : result.validation.issues) {
      ADD_FAILURE() << "star validation issue: " << issue;
    }
    EXPECT_TRUE(result.validation.ok);
  }
  {
    quadmesh::DomainGeometry domain;
    quadmesh::PolylineLoop outer{{{0.0, 0.0}, {8.0, 0.0}, {8.0, 4.4}, {0.0, 4.4}}, true};
    outer.target_cell_size = 3.0;
    domain.outer_loops.push_back(outer);
    quadmesh::PolylineLoop hole = circle({2.0, 1.2}, 0.42, 16);
    hole.target_cell_size = 0.4;
    domain.inner_loops.push_back({hole, quadmesh::InnerLoopRole::Hole});
    const quadmesh::PipelineRunResult result = quadmesh::MeshingPipeline{}.run(domain, {});
    for (const std::string& issue : result.validation.issues) {
      ADD_FAILURE() << "circle validation issue: " << issue;
    }
    EXPECT_TRUE(result.validation.ok);
  }
}

// A loop marked sizing_unconstrained keeps the coarsest viable band: the
// mesh must stay valid and the unconstrained border must be sampled no finer
// than necessary (clearly coarser than the fine hole band).
TEST(PipelineContract, UnconstrainedBorderSizing)
{
  quadmesh::DomainGeometry domain;
  quadmesh::PolylineLoop outer{{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true};
  outer.sizing_unconstrained = true;
  domain.outer_loops.push_back(outer);
  quadmesh::PolylineLoop hole = circle({2.0, 1.2}, 0.42, 64);
  hole.target_cell_size = 0.05;
  domain.inner_loops.push_back({hole, quadmesh::InnerLoopRole::Hole});

  const quadmesh::PipelineRunResult result = quadmesh::MeshingPipeline{}.run(domain, {});
  for (const std::string& issue : result.validation.issues) {
    ADD_FAILURE() << "validation issue: " << issue;
  }
  EXPECT_TRUE(result.validation.ok);

  // Typical boundary edge along the outer rectangle vs along the hole:
  // the rectangle should be much coarser.
  const double rect_edge = median_boundary_edge(result, [](quadmesh::Point2 p) {
    return p.x < 1.0e-9 || p.x > 4.0 - 1.0e-9 || p.y < 1.0e-9 || p.y > 2.4 - 1.0e-9;
  });
  const double hole_edge = median_boundary_edge(result, [](quadmesh::Point2 p) {
    const double r = std::hypot(p.x - 2.0, p.y - 1.2);
    return std::abs(r - 0.42) < 0.02;
  });
  EXPECT_GT(rect_edge, 3.0 * hole_edge)
      << "rect_edge=" << rect_edge << " hole_edge=" << hole_edge;
}

// Coarsening the target must never refine the mesh. Past the floor imposed
// by feature separation and band uniformity against the fine hole, every
// coarser target must produce exactly the mesh that sizing_unconstrained
// produces (the root square is target-independent, so band levels are the
// only degree of freedom).
TEST(PipelineContract, TargetCoarserThanFloorMatchesUnconstrained)
{
  const auto run_with = [](double outer_target, bool unconstrained) {
    quadmesh::DomainGeometry domain;
    quadmesh::PolylineLoop outer{{{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}}, true};
    outer.target_cell_size = outer_target;
    outer.sizing_unconstrained = unconstrained;
    domain.outer_loops.push_back(outer);
    quadmesh::PolylineLoop hole = circle({2.0, 1.2}, 0.42, 64);
    hole.target_cell_size = 0.06;
    domain.inner_loops.push_back({hole, quadmesh::InnerLoopRole::Hole});
    return quadmesh::MeshingPipeline{}.run(domain, {});
  };

  const auto baseline = run_with(0.0, true);
  EXPECT_TRUE(baseline.validation.ok);
  std::size_t previous_quads = std::numeric_limits<std::size_t>::max();
  for (const double target : {0.1, 0.25, 1.0, 4.0, 50.0}) {
    const auto result = run_with(target, false);
    EXPECT_TRUE(result.validation.ok) << "target " << target;
    EXPECT_LE(result.mesh.quads.size(), previous_quads)
        << "coarser target " << target << " refined the mesh";
    previous_quads = result.mesh.quads.size();
    if (target >= 4.0) {
      EXPECT_EQ(result.mesh.quads.size(), baseline.mesh.quads.size())
          << "target " << target << " should hit the unconstrained floor";
      EXPECT_EQ(result.mesh.nodes.size(), baseline.mesh.nodes.size());
    }
  }
}

// The per-loop target is honored to the nearest representable size: band
// squares are root/2^level with root = 2 * (domain max extent), and the
// chosen level is the nearest to the target in log scale, so the achieved
// boundary spacing is within sqrt(2) of the request when no separation or
// uniformity rule interferes.
TEST(PipelineContract, BandSizeTracksTarget)
{
  for (const double target : {0.18, 0.3, 0.4, 0.7}) {
    quadmesh::DomainGeometry domain;
    quadmesh::PolylineLoop outer{{{0.0, 0.0}, {4.0, 0.0}, {4.0, 4.0}, {0.0, 4.0}}, true};
    outer.target_cell_size = target;
    domain.outer_loops.push_back(outer);
    const auto result = quadmesh::MeshingPipeline{}.run(domain, {});
    EXPECT_TRUE(result.validation.ok) << "target " << target;
    const double band = 8.0 / static_cast<double>(1u << result.debug.boundary_level);
    EXPECT_LE(band, target * std::numbers::sqrt2_v<double> * 1.0001) << "target " << target;
    EXPECT_GE(band, target / std::numbers::sqrt2_v<double> * 0.9999) << "target " << target;
  }
}
