#include "quadmesh/pipeline.hpp"
#include "quadmesh/shapes.hpp"

#include <gtest/gtest.h>
#include <cmath>
#include <fstream>
#include <map>
#include <numbers>
#include <set>
#include <filesystem>

namespace {
using namespace quadmesh;

PolylineLoop rectangle(double w, double h, double spacing)
{
  PolylineLoop l;
  for (double x = 0; x < w; x += spacing) l.vertices.push_back({x, 0});
  for (double y = 0; y < h; y += spacing) l.vertices.push_back({w, y});
  for (double x = w; x > 0; x -= spacing) l.vertices.push_back({x, h});
  for (double y = h; y > 0; y -= spacing) l.vertices.push_back({0, y});
  return l;
}

PolylineLoop circle(Point2 center, double r, int n)
{
  PolylineLoop l;
  for (int k = 0; k < n; ++k) {
    const double a = 2 * std::numbers::pi * k / n;
    l.vertices.push_back({center.x + r * std::cos(a), center.y + r * std::sin(a)});
  }
  return l;
}

void fix(PolylineLoop& l) { l.fixed_runs.push_back({{}, {}, l.vertices, true}); }
void valid(const PipelineRunResult& r)
{
  for (const auto& issue : r.validation.issues) ADD_FAILURE() << issue;
  EXPECT_TRUE(r.validation.ok);
  EXPECT_GE(r.validation.min_scaled_jacobian, 0.3);
  EXPECT_GE(r.validation.min_angle_deg, 20.0);
}
}

TEST(PrescribedBoundary, PlateWithHoleHasExactly76BoundaryNodes)
{
  DomainGeometry d;
  auto outer = rectangle(40, 20, 2);
  auto hole = circle({20, 10}, 5, 16);
  fix(outer); fix(hole);
  d.outer_loops.push_back(outer);
  d.inner_loops.push_back({hole, InnerLoopRole::Hole});
  MeshingConfig c;
  c.refinement.target_cell_size = 2;
  c.enable_smoothing = true;
  const auto r = MeshingPipeline{}.run(d, c);
  valid(r);
  std::size_t count = 0;
  for (const auto& n : r.mesh.nodes) count += n.on_boundary ? 1U : 0U;
  EXPECT_EQ(count, 76U);
  EXPECT_EQ(r.mesh.boundary_nodes.size(), 76U);
  for (const auto& loop : {outer, hole}) for (const auto p : loop.vertices) {
    std::size_t found = 0;
    for (const auto& n : r.mesh.nodes) found += n.on_boundary && n.point.x == p.x && n.point.y == p.y ? 1U : 0U;
    EXPECT_EQ(found, 1U);
  }
}

TEST(PrescribedBoundary, OddFullyFixedBoundaryFailsClearly)
{
  DomainGeometry d;
  auto loop = circle({0, 0}, 10, 9);
  fix(loop); d.outer_loops.push_back(loop);
  try {
    (void)MeshingPipeline{}.run(d, {});
    FAIL() << "odd fixed boundary accepted";
  } catch (const std::invalid_argument& e) {
    EXPECT_NE(std::string(e.what()).find("odd boundary"), std::string::npos);
  }
}

TEST(PrescribedBoundary, SmallHoleUsesTwelveNodes)
{
  DomainGeometry d;
  d.outer_loops.push_back(rectangle(60, 40, 20));
  d.inner_loops.push_back({circle({30, 20}, 1.5, 256), InnerLoopRole::Hole});
  MeshingConfig c;
  c.refinement.target_cell_size = 4;
  c.finite_element_sizing = true;
  c.enable_smoothing = true;
  const auto r = MeshingPipeline{}.run(d, c);
  valid(r);
  std::size_t count = 0;
  for (const auto& source : r.mesh.boundary_nodes) count += source.loop == 1 ? 1U : 0U;
  EXPECT_EQ(count, 12U);
}

TEST(PrescribedBoundary, PartialNonuniformRunWrapsAcrossTheLoopSeam)
{
  DomainGeometry d;
  PolylineLoop loop{{{0, 0}, {12, 0}, {12, 12}, {0, 12}}, true};
  const std::vector<Point2> fixed{{0, 6}, {0, 2}, {0, 0}, {1, 0}, {6, 0}};
  loop.fixed_runs.push_back({{3, 0.5}, {0, 0.5}, fixed, false});
  d.outer_loops.push_back(loop);
  MeshingConfig c;
  c.refinement.target_cell_size = 3;
  c.enable_smoothing = true;
  const auto r = MeshingPipeline{}.run(d, c);
  EXPECT_TRUE(r.validation.ok);
  std::set<int> found;
  for (const auto& s : r.mesh.boundary_nodes) if (s.fixed_run == 0) {
    ASSERT_GE(s.fixed_node, 0);
    const auto p = r.mesh.nodes[s.node.value].point;
    EXPECT_EQ(p.x, fixed[s.fixed_node].x);
    EXPECT_EQ(p.y, fixed[s.fixed_node].y);
    found.insert(s.fixed_node);
  }
  EXPECT_EQ(found.size(), fixed.size());
  std::set<int> fixed_edges;
  for (const auto& e : r.mesh.boundary_edges) if (e.fixed_run == 0) fixed_edges.insert(e.fixed_edge);
  EXPECT_EQ(fixed_edges.size(), fixed.size() - 1);
}

TEST(PrescribedBoundary, ControlLoopEdgesAreSharedAndStayFixed)
{
  DomainGeometry d;
  d.outer_loops.push_back(rectangle(30, 30, 10));
  PolylineLoop control{{{10, 10}, {20, 10}, {20, 20}, {10, 20}}, true};
  fix(control);
  d.inner_loops.push_back({control, InnerLoopRole::MeshControlFeature});
  MeshingConfig c;
  c.refinement.target_cell_size = 5;
  c.finite_element_sizing = true;
  c.enable_smoothing = true;
  const auto r = MeshingPipeline{}.run(d, c);
  EXPECT_TRUE(r.validation.ok);
  std::map<std::pair<unsigned, unsigned>, int> edges;
  for (const auto& q : r.mesh.quads) for (int k = 0; k < 4; ++k) {
    auto a = q.nodes[k].value, b = q.nodes[(k + 1) % 4].value;
    ++edges[{std::min(a, b), std::max(a, b)}];
  }
  int found = 0;
  for (const auto& e : r.mesh.boundary_edges) if (e.loop == 1) {
    EXPECT_EQ((edges[{std::min(e.nodes[0].value, e.nodes[1].value),
                     std::max(e.nodes[0].value, e.nodes[1].value)}]), 2);
    ++found;
  }
  EXPECT_EQ(found, 4);
}

TEST(PrescribedBoundary, OddControlRegionFailsEvenWhenExteriorIsEven)
{
  DomainGeometry d;
  d.outer_loops.push_back(rectangle(30, 30, 10));
  auto control = circle({15, 15}, 5, 9);
  fix(control); d.inner_loops.push_back({control, InnerLoopRole::MeshControlFeature});
  MeshingConfig c;
  c.finite_element_sizing = true;
  EXPECT_THROW(MeshingPipeline{}.run(d, c), std::invalid_argument);
}

TEST(PrescribedBoundary, OddLoopsCanTogetherBoundAnEvenRegion)
{
  DomainGeometry d;
  auto outer = circle({0, 0}, 15, 9), hole = circle({0, 0}, 5, 9);
  fix(outer); fix(hole);
  d.outer_loops.push_back(outer); d.inner_loops.push_back({hole, InnerLoopRole::Hole});
  MeshingConfig c;
  c.refinement.target_cell_size = 4;
  c.enable_smoothing = true;
  const auto r = MeshingPipeline{}.run(d, c);
  EXPECT_TRUE(r.validation.ok);
  EXPECT_EQ(r.mesh.boundary_nodes.size(), 18U);
}

TEST(PrescribedBoundary, FreeRunsCanAbsorbParityAcrossControlRegions)
{
  DomainGeometry d;
  auto outer = circle({0, 0}, 15, 9);
  fix(outer);
  d.outer_loops.push_back(outer);
  d.inner_loops.push_back({circle({0, 0}, 8, 96), InnerLoopRole::MeshControlFeature});
  d.inner_loops.push_back({circle({0, 0}, 2, 96), InnerLoopRole::Hole});
  MeshingConfig c;
  c.finite_element_sizing = true;
  c.refinement.target_cell_size = 4;
  c.enable_smoothing = true;
  const auto r = MeshingPipeline{}.run(d, c);
  EXPECT_TRUE(r.validation.ok);
  std::array<std::size_t, 3> counts{};
  for (const auto& n : r.mesh.boundary_nodes) ++counts[n.loop];
  EXPECT_EQ(counts[0], 9U);
  EXPECT_EQ((counts[0] + counts[1]) % 2, 0U);
  EXPECT_EQ((counts[1] + counts[2]) % 2, 0U);
}

TEST(PrescribedBoundary, CadFacesMeetValidityQualityAndDensityRequirements)
{
  for (const std::string name : {"wheel_top", "rover_chassis_face1", "rover_chassis_face2",
       "rover_chassis_face61", "balancer_chassis_face17", "balancer_chassis_face19", "balancer_chassis_face21"}) {
    SCOPED_TRACE(name);
    std::ifstream file(std::filesystem::path(QUADMESH_CAD_FIXTURES) / (name + ".txt"));
    ASSERT_TRUE(file.good());
    std::size_t count = 0;
    file >> count;
    DomainGeometry d;
    double area = 0;
    for (std::size_t j = 0; j < count; ++j) {
      std::size_t n = 0; file >> n;
      ASSERT_GE(n, 3U);
      PolylineLoop loop;
      for (std::size_t k = 0; k < n; ++k) {
        Point2 p; file >> p.x >> p.y; loop.vertices.push_back(p);
      }
      double twice_area = 0;
      for (std::size_t k = 0; k < n; ++k)
        twice_area += cross(loop.vertices[k] - loop.vertices[0], loop.vertices[(k + 1) % n] - loop.vertices[0]);
      area += (j == 0 ? 1 : -1) * std::abs(twice_area) / 2;
      if (j == 0) d.outer_loops.push_back(loop);
      else d.inner_loops.push_back({loop, InnerLoopRole::Hole});
    }
    ASSERT_FALSE(file.fail());
    MeshingConfig c;
    c.refinement.target_cell_size = 4;
    c.finite_element_sizing = true;
    c.enable_smoothing = true;
    const auto result = MeshingPipeline{}.run(d, c);
    valid(result);
    if (name == "rover_chassis_face1")
      EXPECT_LE(static_cast<double>(result.mesh.quads.size()), 2 * area / 16);
    EXPECT_FALSE(result.mesh.boundary_nodes.empty());
    EXPECT_FALSE(result.mesh.boundary_edges.empty());
  }
}

TEST(PrescribedBoundary, DeterminismAndBoundaryLockingDuringSmoothing)
{
  DomainGeometry d;
  auto outer = rectangle(40, 20, 2), hole = circle({20, 10}, 5, 16);
  fix(outer); fix(hole);
  d.outer_loops.push_back(outer); d.inner_loops.push_back({hole, InnerLoopRole::Hole});
  MeshingConfig c;
  c.refinement.target_cell_size = 2;
  const auto before = MeshingPipeline{}.run(d, c);
  c.enable_smoothing = true;
  const auto first = MeshingPipeline{}.run(d, c), second = MeshingPipeline{}.run(d, c);
  ASSERT_EQ(first.mesh.nodes.size(), before.mesh.nodes.size());
  ASSERT_EQ(first.mesh.nodes.size(), second.mesh.nodes.size());
  ASSERT_EQ(first.mesh.quads.size(), second.mesh.quads.size());
  for (std::size_t i = 0; i < first.mesh.nodes.size(); ++i) {
    EXPECT_EQ(first.mesh.nodes[i].point.x, second.mesh.nodes[i].point.x);
    EXPECT_EQ(first.mesh.nodes[i].point.y, second.mesh.nodes[i].point.y);
    if (first.mesh.nodes[i].on_boundary) {
      EXPECT_EQ(first.mesh.nodes[i].point.x, before.mesh.nodes[i].point.x);
      EXPECT_EQ(first.mesh.nodes[i].point.y, before.mesh.nodes[i].point.y);
    }
  }
  for (std::size_t i = 0; i < first.mesh.quads.size(); ++i)
    for (int k = 0; k < 4; ++k)
      EXPECT_EQ(first.mesh.quads[i].nodes[k].value, second.mesh.quads[i].nodes[k].value);
  EXPECT_GE(first.validation.min_scaled_jacobian, before.validation.min_scaled_jacobian - 1e-12);
  EXPECT_GE(first.validation.min_edge_ratio, std::min(0.1, before.validation.min_edge_ratio) - 1e-9);
}

TEST(PrescribedBoundary, ZeroChordTolerancePreservesGeometryAndValidationDetectsMovedFixedNode)
{
  DomainGeometry d;
  d.outer_loops.push_back({{{0, 0}, {10, 0}, {10, 10}, {5, 10.2}, {0, 10}}, true});
  MeshingConfig c;
  c.finite_element_sizing = true;
  c.refinement.target_cell_size = 3;
  c.features.chord_tolerance_fraction = 0;
  const auto sampled = MeshingPipeline{}.run(d, c);
  EXPECT_TRUE(sampled.validation.ok);
  for (const auto p : d.outer_loops[0].vertices) {
    bool found = false;
    for (const auto& n : sampled.mesh.nodes) found |= n.on_boundary && n.point.x == p.x && n.point.y == p.y;
    EXPECT_TRUE(found);
  }
  fix(d.outer_loops[0]);
  // Five fixed edges cannot bound a quad mesh.
  EXPECT_THROW(MeshingPipeline{}.run(d, c), std::invalid_argument);
  d.outer_loops[0] = rectangle(10, 10, 5);
  fix(d.outer_loops[0]);
  auto mesh = MeshingPipeline{}.run(d, c).mesh;
  const auto node = mesh.boundary_nodes[0].node.value;
  mesh.nodes[node].point.x += 0.01;
  EXPECT_FALSE(validate_mesh(mesh, d, c).ok);
}
