#include "quadmesh/validation.hpp"

#include <gtest/gtest.h>

#include <array>
#include <vector>

namespace {

quadmesh::DomainGeometry square_domain()
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back({{{0.0, 0.0}, {2.0, 0.0}, {2.0, 2.0}, {0.0, 2.0}}, true});
  return domain;
}

quadmesh::GlobalMesh mesh_with_quads(
    std::vector<quadmesh::MeshNode> nodes,
    std::vector<std::array<std::uint32_t, 4>> quads)
{
  quadmesh::GlobalMesh mesh;
  mesh.nodes = std::move(nodes);
  for (const auto& q : quads) {
    quadmesh::Quad4 quad;
    for (int k = 0; k < 4; ++k) {
      quad.nodes[k] = quadmesh::NodeId{q[k]};
    }
    mesh.quads.push_back(quad);
  }
  return mesh;
}

} // namespace

TEST(Validation, AcceptsSingleBoundaryQuad)
{
  // A quad whose boundary nodes are all marked on-geometry and coincide with
  // the domain corners is conforming.
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back({{{0.0, 0.0}, {1.0, 0.0}, {1.0, 1.0}, {0.0, 1.0}}, true});
  const auto mesh = mesh_with_quads(
      {{{0.0, 0.0}, true}, {{1.0, 0.0}, true}, {{1.0, 1.0}, true}, {{0.0, 1.0}, true}},
      {{0u, 1u, 2u, 3u}});
  const auto report = quadmesh::validate_mesh(mesh, domain, {});
  EXPECT_TRUE(report.ok);
  EXPECT_EQ(report.quad_count, 1u);
  EXPECT_NEAR(report.min_angle_deg, 90.0, 1.0e-9);
  EXPECT_NEAR(report.max_angle_deg, 90.0, 1.0e-9);
}

TEST(Validation, RejectsInvertedQuad)
{
  const auto mesh = mesh_with_quads(
      {{{0.0, 0.0}, true}, {{0.0, 1.0}, true}, {{1.0, 1.0}, true}, {{1.0, 0.0}, true}},
      {{0u, 1u, 2u, 3u}}); // clockwise = inverted
  const auto report = quadmesh::validate_mesh(mesh, square_domain(), {});
  EXPECT_FALSE(report.ok);
  EXPECT_GT(report.inverted_quad_count, 0u);
}

TEST(Validation, RejectsHangingNode)
{
  // Two small quads against one large quad sharing a split edge: the large
  // quad's edge is overlapped, leaving single-counted interior edges.
  const auto mesh = mesh_with_quads(
      {
          {{0.0, 0.0}, true},
          {{1.0, 0.0}, true},
          {{1.0, 0.5}, false},
          {{1.0, 1.0}, true},
          {{0.0, 1.0}, true},
          {{2.0, 0.0}, true},
          {{2.0, 1.0}, true},
      },
      {{0u, 1u, 3u, 4u}, {1u, 5u, 6u, 2u}, {2u, 6u, 6u, 3u}});
  const auto report = quadmesh::validate_mesh(mesh, square_domain(), {});
  EXPECT_FALSE(report.ok);
}

TEST(Validation, RejectsFlatCorner)
{
  const auto mesh = mesh_with_quads(
      {{{0.0, 0.0}, true}, {{1.0, 0.0}, true}, {{2.0, 0.0001}, true}, {{0.0, 1.0}, true}},
      {{0u, 1u, 2u, 3u}});
  const auto report = quadmesh::validate_mesh(mesh, square_domain(), {});
  EXPECT_FALSE(report.ok);
  EXPECT_GT(report.flat_angle_count, 0u);
}

TEST(Validation, RejectsBoundaryChordAcrossShallowInputJoint)
{
  quadmesh::DomainGeometry domain;
  domain.outer_loops.push_back(
      {{{0.0, 0.0}, {2.0, 0.0}, {2.0, 2.0}, {1.0, 2.1}, {0.0, 2.0}}, true});
  // The top mesh edge joins two valid boundary nodes but shortcuts the shallow
  // input joint at (1, 2.1).
  const auto mesh = mesh_with_quads(
      {{{0.0, 0.0}, true}, {{2.0, 0.0}, true}, {{2.0, 2.0}, true}, {{0.0, 2.0}, true}},
      {{0u, 1u, 2u, 3u}});

  quadmesh::MeshingConfig config;
  config.features.chord_tolerance_fraction = 0.0;
  const auto report = quadmesh::validate_mesh(mesh, domain, config);
  EXPECT_FALSE(report.ok);
  EXPECT_EQ(report.boundary_off_geometry_edge_count, 1u);
}

TEST(Validation, RejectsEmptyMesh)
{
  const auto report = quadmesh::validate_mesh({}, square_domain(), {});
  EXPECT_FALSE(report.ok);
}
