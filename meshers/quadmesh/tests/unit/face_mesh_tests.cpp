#include "detail/contracts.hpp"
#include "stages/face_mesh.hpp"

#include <gtest/gtest.h>

#include <map>

using namespace quadmesh;
using namespace quadmesh::detail;

namespace {

// A unit-square face with four straight sides over four pre-made corner nodes.
Face make_square_face(MeshBuilder& mb)
{
  const int n0 = mb.add_node({0.0, 0.0}, true);
  const int n1 = mb.add_node({1.0, 0.0}, true);
  const int n2 = mb.add_node({1.0, 1.0}, true);
  const int n3 = mb.add_node({0.0, 1.0}, true);
  Face face;
  face.corners = {n0, n1, n2, n3};
  for (int i = 0; i < 4; ++i) {
    GraphEdge edge;
    edge.a = face.corners[i];
    edge.b = face.corners[(i + 1) % 4];
    edge.curve = false;
    face.edges.push_back(edge);
  }
  return face;
}

// A clipped square with one collinear 2:1 transition corner on its west side.
// Midpoint expansion gives one node on three macro sides and three on the
// west side: the case highlighted in target_template.png.
Face make_transition_face(MeshBuilder& mb)
{
  Face face;
  face.corners = {
      mb.add_node({0.0, 0.0}, true),
      mb.add_node({1.0, 0.0}, true),
      mb.add_node({1.0, 1.0}, true),
      mb.add_node({0.0, 1.0}, true),
      mb.add_node({0.0, 0.44}, true), // clipped leaf: junction need not bisect the face geometrically
  };
  for (std::size_t i = 0; i < face.corners.size(); ++i) {
    GraphEdge edge;
    edge.a = face.corners[i];
    edge.b = face.corners[(i + 1) % face.corners.size()];
    face.edges.push_back(edge);
  }
  return face;
}

} // namespace

TEST(FaceMesh, SubdivideEmitsOneQuadPerCorner)
{
  MeshBuilder mb;
  const Face face = make_square_face(mb);
  subdivide_face(mb, face);
  // n corners -> n quads (fan to the center via the n side midpoints).
  EXPECT_EQ(mb.quads.size(), 4u);
  // 4 corners + 4 side midpoints + 1 center.
  EXPECT_EQ(mb.nodes.size(), 9u);
}

TEST(FaceMesh, SharedEdgeMidpointsAreReused)
{
  MeshBuilder mb;
  const Face face = make_square_face(mb);
  subdivide_face(mb, face);
  const std::size_t after_first = mb.nodes.size(); // 9
  subdivide_face(mb, face);
  // Second pass reuses the 4 edge midpoints (edge_mid registry) and only adds
  // a fresh center node.
  EXPECT_EQ(mb.quads.size(), 8u);
  EXPECT_EQ(mb.nodes.size(), after_first + 1u);
  EXPECT_EQ(mb.edge_mid.size(), 4u);
}

TEST(FaceMesh, CollinearTransitionFaceUsesRecursiveTwoRefTemplate)
{
  MeshBuilder mb;
  const Face face = make_transition_face(mb);
  subdivide_face(mb, face);

  // Bisect through the existing east/west midpoints. Each half then has an
  // adjacent pair of side midpoints and takes one paper 3-quad template.
  EXPECT_EQ(mb.quads.size(), 6u);

  std::map<std::pair<int, int>, int> edge_count;
  for (const std::array<int, 4>& quad : mb.quads) {
    for (int side = 0; side < 4; ++side) {
      const int a = quad[side];
      const int b = quad[(side + 1) % 4];
      ++edge_count[std::minmax(a, b)];
    }
  }
  int boundary_edges = 0;
  for (const auto& [edge, count] : edge_count) {
    (void)edge;
    EXPECT_TRUE(count == 1 || count == 2);
    boundary_edges += count == 1 ? 1 : 0;
  }
  EXPECT_EQ(boundary_edges, 10); // five original edges, each midpoint-split
}
