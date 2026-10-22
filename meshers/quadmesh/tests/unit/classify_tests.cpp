#include "stage_test_util.hpp"

#include "stages/classify.hpp"

#include <gtest/gtest.h>

#include <cstddef>

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

} // namespace

TEST(Classify, ProducesCutsVerticesAndCrossings)
{
  qtest::StageFixture f;
  f.build(qtest::rect_domain(1.0, 1.0, 0.2));
  const std::size_t feature_nodes = f.mb.nodes.size();

  BoundaryTopology topo;
  compute_side_crossings(f.lat, f.gm, topo, f.mb, f.config);
  classify_leaves(f.lat, f.gm, topo, f.mb, nullptr);

  EXPECT_FALSE(topo.side_crossings.empty());
  EXPECT_GT(count_class(topo, LeafClass::Cut), 0);
  // The square's four 90-degree corners are feature vertices.
  EXPECT_GE(count_class(topo, LeafClass::Vertex), 1);
  // compute_side_crossings creates a node per crossing, beyond the seeded
  // feature nodes.
  EXPECT_GT(f.mb.nodes.size(), feature_nodes);
}

TEST(Classify, Deterministic)
{
  qtest::StageFixture a;
  a.build(qtest::rect_domain(1.0, 1.0, 0.2));
  BoundaryTopology ta;
  compute_side_crossings(a.lat, a.gm, ta, a.mb, a.config);
  classify_leaves(a.lat, a.gm, ta, a.mb, nullptr);

  qtest::StageFixture b;
  b.build(qtest::rect_domain(1.0, 1.0, 0.2));
  BoundaryTopology tb;
  compute_side_crossings(b.lat, b.gm, tb, b.mb, b.config);
  classify_leaves(b.lat, b.gm, tb, b.mb, nullptr);

  EXPECT_EQ(ta.side_crossings.size(), tb.side_crossings.size());
  EXPECT_EQ(ta.leaf_class.size(), tb.leaf_class.size());
  EXPECT_EQ(a.mb.nodes.size(), b.mb.nodes.size());
}
