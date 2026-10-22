#pragma once

#include "quadmesh/geometry.hpp"

#include <numbers>
#include <vector>

namespace quadmesh::detail {

inline constexpr double pi = std::numbers::pi_v<double>;

enum class LeafClass { Unset, EmptyOutside, EmptyInside, Cut, Vertex };

struct Crossing {
  Point2 point;
  int node = -1;
  int chain = -1;
  int seg = -1;
  double t_on_seg = 0.0;
  double t_on_side = 0.0;
};

// A non-grid node inserted along an atomic leaf-side span by empty-square
// closure. `t_on_side` is measured in the canonical span orientation.
struct SideSplit {
  double t_on_side = 0.5;
  int node = -1;
};

struct GraphEdge {
  int a = -1;
  int b = -1;
  bool curve = false;                 // lies on input geometry
  std::vector<Point2> geometry;       // polyline including endpoints (curve edges)
};

// feature vertices: position + (chain, point index)
struct FeatureVertex {
  Point2 point;
  int chain = 0;
  int index = 0;
  std::int32_t leaf = -1;
  int node = -1;
};

struct LatticeInfo {
  std::vector<std::pair<int, int>> pieces; // (chain, seg)
  std::vector<std::pair<int, int>> joints; // (chain, point index), non-feature
  std::vector<int> vertices;               // feature vertex ids
};

struct PathEntry {
  int node = -1;
  bool is_crossing = false;
  Crossing crossing; // valid when is_crossing
};

struct ChainArcPos {
  int chain = 0;
  double arc = 0.0; // seg index + t
  int path_index = 0;
};

struct Face {
  std::vector<int> corners;            // node loop (CCW)
  std::vector<GraphEdge> edges;        // edge i connects corners[i] -> corners[i+1]
};

} // namespace quadmesh::detail
