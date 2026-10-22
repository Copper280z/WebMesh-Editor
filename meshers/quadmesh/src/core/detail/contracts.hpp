#pragma once

#include "detail/chain.hpp"
#include "detail/geom_index.hpp"
#include "detail/tree.hpp"
#include "detail/types.hpp"

#include "quadmesh/config.hpp"
#include "quadmesh/geometry.hpp"
#include "quadmesh/mesh.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <map>
#include <unordered_map>
#include <vector>

namespace quadmesh::detail {

// Normalized input: closed/open polyline chains plus their sharp vertices.
// Produced by the input-normalization step; consumed by every later stage.
struct GeometryModel {
  std::vector<Chain> chains;
  std::vector<FeatureVertex> features; // .node seeded by orchestrator, .leaf by classify
};

// An automatically promoted interval on one source polyline segment. `t0` and
// `t1` are segment parameters in [0,1]. Promotions only refine; overlapping
// intervals take the maximum level.
struct BoundaryLevelPromotion {
  double t0 = 0.0;
  double t1 = 0.0;
  std::uint16_t level = 0;
};

// Indexed as [segment][interval] within one chain, then [chain] in Lattice.
using ChainSizingPromotions = std::vector<std::vector<BoundaryLevelPromotion>>;

// The strongly balanced quadtree plus the frame, per-chain base band levels,
// and optional arc-local promotion field it was built from. `geom` indexes into
// GeometryModel::chains, which the orchestrator owns for the whole run (so the
// pointer stays valid after the Lattice is moved out of build_lattice).
struct Lattice {
  Tree tree;
  GeomIndex geom;
  std::vector<std::uint16_t> chain_levels;
  std::vector<ChainSizingPromotions> sizing_promotions;
  Point2 origin{};
  double root_size = 1.0;

  double chain_size(int c) const { return root_size / static_cast<double>(1u << chain_levels[c]); }
  double chain_delta(int c, const MeshingConfig& config) const
  {
    return chain_size(c) * config.repelling.distance_fraction;
  }
  std::uint16_t max_chain_level() const
  {
    std::uint16_t level = 0;
    for (const std::uint16_t l : chain_levels) {
      level = std::max(level, l);
    }
    return level;
  }
  double eps(const MeshingConfig& config) const
  {
    return std::max(config.tolerances.absolute_distance, root_size * config.tolerances.relative_distance);
  }
};

// Repelled grid-point positions (paper 2.2). Empty for points left in place.
struct Perturbation {
  std::unordered_map<std::uint64_t, Point2> moved_gp; // grid point key -> repelled position
};

// Boundary extraction: per-side crossings, leaf classification, and the
// vertex-square bend treatment. side_crossings + leaf_class are produced by
// classify; side_bend + vertex_corner_rays + leaf_vertex by build_vertex_bends.
struct BoundaryTopology {
  std::map<std::pair<std::uint64_t, std::uint64_t>, std::vector<Crossing>> side_crossings;
  // Empty-template nodes on atomic side spans. Cut paths deliberately do not
  // consume these: midpoint subdivision already creates the matching node.
  std::map<std::pair<std::uint64_t, std::uint64_t>, std::vector<SideSplit>> side_splits;
  std::unordered_map<int, LeafClass> leaf_class;
  std::unordered_map<std::int32_t, int> leaf_vertex;     // leaf -> feature index
  std::map<std::pair<std::uint64_t, std::uint64_t>, int> side_bend; // vertex-square pulled midpoints
  // Fallback wedge splits: rays from a feature vertex to square corners,
  // used when no side midpoint is available inside a wide wedge.
  std::map<std::int32_t, std::vector<int>> vertex_corner_rays;
};

// The single shared mutable accumulator for emitted mesh entities. Conformity
// is by construction: every shared node lives in one of the registries below
// (gp_node, edge_mid) and is created once and looked up, never welded.
// `tree`/`perturb` are wired by the orchestrator once they exist; node-factory
// methods that need a grid-point position (gp_pos) must not be called before.
struct MeshBuilder {
  std::vector<MeshNode> nodes;
  std::vector<std::array<int, 4>> quads;
  std::unordered_map<std::uint64_t, int> gp_node;  // grid point -> node
  std::unordered_map<std::uint64_t, int> edge_mid; // (node,node) -> midpoint node

  const Tree* tree = nullptr;
  const Perturbation* perturb = nullptr;

  Point2 gp_pos(std::uint32_t gx, std::uint32_t gy) const
  {
    const auto it = perturb->moved_gp.find(gp_key(gx, gy));
    return it == perturb->moved_gp.end() ? tree->gp_position(gx, gy) : it->second;
  }

  int add_node(Point2 p, bool on_boundary)
  {
    nodes.push_back({p, on_boundary});
    return static_cast<int>(nodes.size()) - 1;
  }

  int gp_node_id(std::uint32_t gx, std::uint32_t gy)
  {
    const std::uint64_t key = gp_key(gx, gy);
    const auto it = gp_node.find(key);
    if (it != gp_node.end()) {
      return it->second;
    }
    const int id = add_node(gp_pos(gx, gy), false);
    gp_node.emplace(key, id);
    return id;
  }

  static std::uint64_t node_pair_key(int a, int b)
  {
    const std::uint64_t lo = static_cast<std::uint64_t>(std::min(a, b));
    const std::uint64_t hi = static_cast<std::uint64_t>(std::max(a, b));
    return (hi << 32) | lo;
  }

  // Midpoint node of a straight mesh edge; created once and shared.
  int straight_mid_node(int a, int b)
  {
    const std::uint64_t key = node_pair_key(a, b);
    const auto it = edge_mid.find(key);
    if (it != edge_mid.end()) {
      return it->second;
    }
    const Point2 pa = nodes[a].point;
    const Point2 pb = nodes[b].point;
    const int id = add_node({(pa.x + pb.x) / 2.0, (pa.y + pb.y) / 2.0}, false);
    edge_mid.emplace(key, id);
    return id;
  }

  int existing_mid_node(int a, int b) const
  {
    const auto it = edge_mid.find(node_pair_key(a, b));
    return it == edge_mid.end() ? -1 : it->second;
  }

  // Midpoint of a curve edge: the half-arc-length point of its polyline,
  // which lies exactly on the input geometry.
  int curve_mid_node(const GraphEdge& edge)
  {
    const std::uint64_t key = node_pair_key(edge.a, edge.b);
    const auto it = edge_mid.find(key);
    if (it != edge_mid.end()) {
      return it->second;
    }
    double total = 0.0;
    for (std::size_t i = 0; i + 1 < edge.geometry.size(); ++i) {
      total += distance(edge.geometry[i], edge.geometry[i + 1]);
    }
    Point2 mid = edge.geometry.front();
    double walked = 0.0;
    const double half = total / 2.0;
    for (std::size_t i = 0; i + 1 < edge.geometry.size(); ++i) {
      const double step = distance(edge.geometry[i], edge.geometry[i + 1]);
      if (walked + step >= half && step > 0.0) {
        const double t = (half - walked) / step;
        mid = edge.geometry[i] + (edge.geometry[i + 1] - edge.geometry[i]) * t;
        break;
      }
      walked += step;
    }
    const int id = add_node(mid, true);
    edge_mid.emplace(key, id);
    return id;
  }
};

// Even-odd test of whether point v lies inside a leaf's repelled (deformed)
// quad — its four corners taken at their possibly-moved grid positions. Shared
// by the vertex-bend wedge tests and vertex-leaf relocation. Requires
// mb.tree / mb.perturb to be wired (same precondition as gp_pos).
inline bool point_in_deformed(const MeshBuilder& mb, std::int32_t leaf, Point2 v)
{
  const Cell& cell = mb.tree->cells[leaf];
  Point2 quad[4];
  for (int corner = 0; corner < 4; ++corner) {
    const auto [gx, gy] = mb.tree->corner_gp(cell, corner);
    quad[corner] = mb.gp_pos(gx, gy);
  }
  bool in = false;
  for (int a = 0, b = 3; a < 4; b = a++) {
    if ((quad[a].y > v.y) != (quad[b].y > v.y)
        && v.x < quad[a].x + (v.y - quad[a].y) * (quad[b].x - quad[a].x) / (quad[b].y - quad[a].y)) {
      in = !in;
    }
  }
  return in;
}

} // namespace quadmesh::detail
