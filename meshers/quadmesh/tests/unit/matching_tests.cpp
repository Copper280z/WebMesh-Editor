#include "detail/matching.hpp"
#include <gtest/gtest.h>
#include <algorithm>
#include <bit>
#include <cstdint>
#include <random>

namespace {
int exhaustive(const std::vector<std::vector<int>>& graph, unsigned available)
{
  if (!available) return 0;
  const int v = std::countr_zero(available);
  available &= ~(1U << v);
  int best = exhaustive(graph, available);
  for (int u : graph[v]) if (available & (1U << u))
    best = std::max(best, 1 + exhaustive(graph, available & ~(1U << u)));
  return best;
}
}

TEST(Matching, AgreesWithExhaustiveSearchOnSmallGeneralGraphs)
{
  std::mt19937 random(173);
  for (int n = 0; n <= 10; ++n) for (int sample = 0; sample < 100; ++sample) {
    std::vector<std::vector<int>> graph(n);
    for (int v = 0; v < n; ++v) for (int u = v + 1; u < n; ++u)
      if (random() % 100 < static_cast<unsigned>(sample)) {
        graph[v].push_back(u); graph[u].push_back(v);
      }
    const auto match = quadmesh::detail::maximum_matching(graph);
    ASSERT_EQ(match.size(), graph.size());
    int pairs = 0;
    for (int v = 0; v < n; ++v) if (match[v] >= 0) {
      ASSERT_LT(match[v], n);
      EXPECT_EQ(match[match[v]], v);
      EXPECT_NE(std::find(graph[v].begin(), graph[v].end(), match[v]), graph[v].end());
      if (v < match[v]) ++pairs;
    }
    EXPECT_EQ(pairs, exhaustive(graph, (1U << n) - 1));
    EXPECT_EQ(match, quadmesh::detail::maximum_matching(graph));
  }
}
