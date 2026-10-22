#pragma once

#include <algorithm>
#include <numeric>
#include <queue>
#include <vector>

namespace quadmesh::detail {

// Edmonds' augmenting-path algorithm for a general, unweighted graph.
// Adjacency order supplies deterministic preference among maximum matchings.
inline std::vector<int> maximum_matching(const std::vector<std::vector<int>>& graph)
{
  const int n = static_cast<int>(graph.size());
  std::vector<int> match(n, -1), parent(n), base(n);
  std::vector<bool> used(n), blossom(n);
  for (int v = 0; v < n; ++v) if (match[v] < 0)
    for (int u : graph[v]) if (match[u] < 0) { match[v] = u; match[u] = v; break; }
  const auto ancestor = [&](int a, int b) {
    std::vector<bool> path(n, false);
    while (true) {
      a = base[a]; path[a] = true;
      if (match[a] < 0) break;
      a = parent[match[a]];
    }
    while (true) {
      b = base[b];
      if (path[b]) return b;
      b = parent[match[b]];
    }
  };
  const auto mark_path = [&](int v, int root, int child) {
    while (base[v] != root) {
      blossom[base[v]] = blossom[base[match[v]]] = true;
      parent[v] = child; child = match[v]; v = parent[match[v]];
    }
  };
  const auto augment = [&](int root) {
    std::fill(used.begin(), used.end(), false);
    std::fill(parent.begin(), parent.end(), -1);
    std::iota(base.begin(), base.end(), 0);
    std::queue<int> queue;
    queue.push(root); used[root] = true;
    while (!queue.empty()) {
      const int v = queue.front(); queue.pop();
      for (int u : graph[v]) {
        if (base[v] == base[u] || match[v] == u) continue;
        if (u == root || (match[u] >= 0 && parent[match[u]] >= 0)) {
          const int common = ancestor(v, u);
          std::fill(blossom.begin(), blossom.end(), false);
          mark_path(v, common, u); mark_path(u, common, v);
          for (int i = 0; i < n; ++i) if (blossom[base[i]]) {
            base[i] = common;
            if (!used[i]) { used[i] = true; queue.push(i); }
          }
        } else if (parent[u] < 0) {
          parent[u] = v;
          if (match[u] < 0) {
            for (int at = u; at >= 0;) {
              const int previous = parent[at], next = previous < 0 ? -1 : match[previous];
              match[at] = previous;
              if (previous >= 0) match[previous] = at;
              at = next;
            }
            return true;
          }
          used[match[u]] = true; queue.push(match[u]);
        }
      }
    }
    return false;
  };
  for (int root = 0; root < n; ++root) if (match[root] < 0) augment(root);
  return match;
}

} // namespace quadmesh::detail
