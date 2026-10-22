#include "stages/constrained.hpp"

#include "detail/empty_templates.hpp"
#include "detail/matching.hpp"
#include "quadmesh/quality.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <map>
#include <numeric>
#include <queue>
#include <set>
#include <stdexcept>
#include <tuple>

namespace quadmesh::detail {
namespace {

using Edge = std::pair<int, int>;
Edge key(int a, int b) { return {std::min(a, b), std::max(a, b)}; }
struct Triangle { std::array<int, 3> v; };
using Adjacency = std::map<Edge, std::vector<int>>;

long double orient(Point2 a, Point2 b, Point2 c)
{
  return (static_cast<long double>(b.x) - a.x) * (static_cast<long double>(c.y) - a.y)
       - (static_cast<long double>(b.y) - a.y) * (static_cast<long double>(c.x) - a.x);
}

Triangle ccw(int a, int b, int c, const std::vector<Point2>& p)
{
  if (orient(p[a], p[b], p[c]) < 0) std::swap(b, c);
  return {{a, b, c}};
}

long double incircle(Point2 a, Point2 b, Point2 c, Point2 d)
{
  const long double ax = static_cast<long double>(a.x) - d.x, ay = static_cast<long double>(a.y) - d.y;
  const long double bx = static_cast<long double>(b.x) - d.x, by = static_cast<long double>(b.y) - d.y;
  const long double cx = static_cast<long double>(c.x) - d.x, cy = static_cast<long double>(c.y) - d.y;
  const auto aa = ax * ax + ay * ay, bb = bx * bx + by * by, cc = cx * cx + cy * cy;
  const auto det = aa * (bx * cy - by * cx) - bb * (ax * cy - ay * cx) + cc * (ax * by - ay * bx);
  const auto magnitude = aa * (std::abs(bx * cy) + std::abs(by * cx))
                       + bb * (std::abs(ax * cy) + std::abs(ay * cx))
                       + cc * (std::abs(ax * by) + std::abs(ay * bx));
  return std::abs(det) <= 1e-16L * magnitude ? 0 : det;
}

Adjacency adjacency(const std::vector<Triangle>& triangles)
{
  Adjacency result;
  for (std::size_t i = 0; i < triangles.size(); ++i)
    for (int k = 0; k < 3; ++k)
      result[key(triangles[i].v[k], triangles[i].v[(k + 1) % 3])].push_back(static_cast<int>(i));
  return result;
}

int opposite(const Triangle& t, Edge e)
{
  for (int v : t.v) if (v != e.first && v != e.second) return v;
  throw std::logic_error("invalid triangulation adjacency");
}

bool crosses(Point2 a, Point2 b, Point2 c, Point2 d)
{
  const auto u = orient(a, b, c), v = orient(a, b, d);
  const auto s = orient(c, d, a), t = orient(c, d, b);
  return ((u > 0 && v < 0) || (u < 0 && v > 0)) && ((s > 0 && t < 0) || (s < 0 && t > 0));
}

bool inside(const PreparedBoundary& boundary, Point2 p)
{
  bool in = false;
  for (const auto& loop : boundary.loops) {
    if (loop.control) continue;
    bool local = false;
    for (std::size_t i = 0, j = loop.points.size() - 1; i < loop.points.size(); j = i++)
      if ((loop.points[i].y > p.y) != (loop.points[j].y > p.y)
          && p.x < loop.points[i].x + (p.y - loop.points[i].y) * (loop.points[j].x - loop.points[i].x)
                        / (loop.points[j].y - loop.points[i].y))
        local = !local;
    if (local) in = !in;
  }
  return in;
}

std::vector<Triangle> triangulate(std::vector<Point2> points, const std::set<Edge>& constraints)
{
  const int n = static_cast<int>(points.size());
  Point2 lo = points[0], hi = points[0];
  for (Point2 p : points) {
    lo.x = std::min(lo.x, p.x); lo.y = std::min(lo.y, p.y);
    hi.x = std::max(hi.x, p.x); hi.y = std::max(hi.y, p.y);
  }
  const double size = std::max(hi.x - lo.x, hi.y - lo.y);
  const Point2 center{(lo.x + hi.x) / 2, (lo.y + hi.y) / 2};
  // Translate/scale predicates; boundary output coordinates remain untouched.
  for (auto& p : points) p = {(p.x - center.x) / size, (p.y - center.y) / size};
  points.push_back({-32, -16}); points.push_back({32, -16}); points.push_back({0, 32});
  std::vector<Triangle> tris{{{n, n + 1, n + 2}}};
  Adjacency live = adjacency(tris);
  const auto remove_triangle = [&](int index) {
    const auto t = tris[index];
    for (int k = 0; k < 3; ++k) {
      const Edge e = key(t.v[k], t.v[(k + 1) % 3]);
      auto it = live.find(e);
      auto& ids = it->second;
      ids.erase(std::remove(ids.begin(), ids.end(), index), ids.end());
      if (ids.empty()) live.erase(it);
    }
  };
  const auto put_triangle = [&](int index, Triangle t) {
    if (index == static_cast<int>(tris.size())) tris.push_back(t);
    else tris[index] = t;
    for (int k = 0; k < 3; ++k) live[key(t.v[k], t.v[(k + 1) % 3])].push_back(index);
  };
  for (int i = 0; i < n; ++i) {
    int containing = -1;
    Edge on_edge{-1, -1};
    for (std::size_t j = 0; j < tris.size(); ++j) {
      const auto& t = tris[j];
      const std::array<long double, 3> sides{
        orient(points[t.v[0]], points[t.v[1]], points[i]),
        orient(points[t.v[1]], points[t.v[2]], points[i]),
        orient(points[t.v[2]], points[t.v[0]], points[i])};
      if (*std::min_element(sides.begin(), sides.end()) < 0) continue;
      containing = static_cast<int>(j);
      for (int k = 0; k < 3; ++k) if (sides[k] == 0) on_edge = key(t.v[k], t.v[(k + 1) % 3]);
      break;
    }
    if (containing < 0) throw std::logic_error("interior point escaped the triangulation");
    std::vector<Edge> legalize;
    if (on_edge.first >= 0) {
      const auto incident = live.at(on_edge);
      for (int t : incident) {
        const int other = opposite(tris[t], on_edge);
        remove_triangle(t);
        put_triangle(t, ccw(on_edge.first, i, other, points));
        put_triangle(static_cast<int>(tris.size()), ccw(i, on_edge.second, other, points));
        legalize.push_back(key(on_edge.first, other));
        legalize.push_back(key(on_edge.second, other));
      }
    } else {
      const auto t = tris[containing];
      remove_triangle(containing);
      put_triangle(containing, ccw(t.v[0], t.v[1], i, points));
      put_triangle(static_cast<int>(tris.size()), ccw(t.v[1], t.v[2], i, points));
      put_triangle(static_cast<int>(tris.size()), ccw(t.v[2], t.v[0], i, points));
      for (int k = 0; k < 3; ++k) legalize.push_back(key(t.v[k], t.v[(k + 1) % 3]));
    }
    while (!legalize.empty()) {
      const Edge e = legalize.back(); legalize.pop_back();
      const auto it = live.find(e);
      if (it == live.end() || it->second.size() != 2) continue;
      const auto adjacent = it->second;
      const int a = opposite(tris[adjacent[0]], e), b = opposite(tris[adjacent[1]], e);
      if (a != i && b != i) continue;
      const int other = a == i ? b : a;
      if (!crosses(points[i], points[other], points[e.first], points[e.second])) continue;
      const auto t = ccw(e.first, e.second, i, points);
      if (incircle(points[t.v[0]], points[t.v[1]], points[t.v[2]], points[other]) <= 0) continue;
      remove_triangle(adjacent[0]); remove_triangle(adjacent[1]);
      put_triangle(adjacent[0], ccw(i, other, e.first, points));
      put_triangle(adjacent[1], ccw(other, i, e.second, points));
      legalize.push_back(key(other, e.first)); legalize.push_back(key(other, e.second));
    }
  }
  tris.erase(std::remove_if(tris.begin(), tris.end(), [&](const Triangle& t) {
    return t.v[0] >= n || t.v[1] >= n || t.v[2] >= n;
  }), tris.end());

  std::set<Edge> recovered;
  for (Edge required : constraints) {
    bool done = false;
    auto adj = adjacency(tris);
    std::queue<Edge> crossing_edges;
    for (const auto& [edge, incident] : adj) {
      (void)incident;
      if (crosses(points[required.first], points[required.second], points[edge.first], points[edge.second]))
        crossing_edges.push(edge);
    }
    for (std::size_t pass = 0; pass <= tris.size() * 16 + 1; ++pass) {
      if (adj.contains(required)) { done = true; break; }
      if (crossing_edges.empty()) break;
      const Edge edge = crossing_edges.front(); crossing_edges.pop();
      const auto found = adj.find(edge);
      if (found == adj.end()) continue;
      const auto incident = found->second;
      if (incident.size() != 2 || recovered.contains(edge)) break;
      const int a = opposite(tris[incident[0]], edge), b = opposite(tris[incident[1]], edge);
      if (!crosses(points[a], points[b], points[edge.first], points[edge.second])) {
        crossing_edges.push(edge);
        continue;
      }
      tris[incident[0]] = ccw(a, b, edge.first, points);
      tris[incident[1]] = ccw(b, a, edge.second, points);
      if (crosses(points[required.first], points[required.second], points[a], points[b]))
        crossing_edges.push(key(a, b));
      adj = adjacency(tris);
    }
    if (!done) throw std::invalid_argument("cannot recover boundary edge " + std::to_string(required.first)
        + "-" + std::to_string(required.second) + "; check intersecting or touching loops");
    recovered.insert(required);
  }
  // Restore constrained Delaunay edges after boundary recovery.
  for (int pass = 0; pass < 32; ++pass) {
    bool changed = false;
    const auto adj = adjacency(tris);
    std::set<int> touched;
    for (const auto& [e, incident] : adj) {
      if (incident.size() != 2 || constraints.contains(e) || touched.contains(incident[0]) || touched.contains(incident[1])) continue;
      const int a = opposite(tris[incident[0]], e), b = opposite(tris[incident[1]], e);
      if (!crosses(points[a], points[b], points[e.first], points[e.second])) continue;
      const auto t = ccw(e.first, e.second, a, points);
      if (incircle(points[t.v[0]], points[t.v[1]], points[t.v[2]], points[b]) <= 1e-18L) continue;
      tris[incident[0]] = ccw(a, b, e.first, points);
      tris[incident[1]] = ccw(b, a, e.second, points);
      touched.insert(incident[0]); touched.insert(incident[1]); changed = true;
    }
    if (!changed) break;
  }
  return tris;
}

Point2 centroid(const Triangle& t, const std::vector<Point2>& p)
{
  return {(p[t.v[0]].x + p[t.v[1]].x + p[t.v[2]].x) / 3,
          (p[t.v[0]].y + p[t.v[1]].y + p[t.v[2]].y) / 3};
}

} // namespace

GlobalMesh mesh_prescribed_boundary(const DomainGeometry& domain, const MeshingConfig& config, MesherDebug* debug)
{
  const auto original_boundary = prepare_boundary(domain, config);
  auto boundary = original_boundary;
  const bool paired_boundary = std::all_of(boundary.loops.begin(), boundary.loops.end(),
      [](const SampledLoop& loop) { return loop.points.size() >= 6 && loop.points.size() % 2 == 0; });
  if (paired_boundary) {
    boundary.geometry = {};
    for (std::size_t li = 0; li < boundary.loops.size(); ++li) {
      auto& loop = boundary.loops[li];
      std::vector<Point2> corners;
      for (std::size_t i = 0; i < loop.points.size(); i += 2) corners.push_back(loop.points[i]);
      loop.points = std::move(corners);
      PolylineLoop geometry;
      geometry.vertices = loop.points;
      if (li < domain.outer_loops.size()) boundary.geometry.outer_loops.push_back(geometry);
      else boundary.geometry.inner_loops.push_back({geometry, domain.inner_loops[li - domain.outer_loops.size()].role});
    }
  }
  std::vector<Point2> points;
  std::set<Edge> constraints;
  std::map<Edge, Point2> prescribed_midpoints;
  for (std::size_t li = 0; li < boundary.loops.size(); ++li) {
    const auto& loop = boundary.loops[li];
    const int offset = static_cast<int>(points.size());
    for (auto p : loop.points) points.push_back(p);
    for (int k = 0; k < static_cast<int>(loop.points.size()); ++k) {
      const auto edge = key(offset + k, offset + (k + 1) % static_cast<int>(loop.points.size()));
      constraints.insert(edge);
      if (paired_boundary) prescribed_midpoints[edge] = original_boundary.loops[li].points[static_cast<std::size_t>(2 * k + 1)];
    }
  }
  const std::size_t boundary_count = points.size();
  std::set<std::pair<double, double>> unique_boundary_points;
  for (auto p : points) if (!unique_boundary_points.insert({p.x, p.y}).second)
    throw std::invalid_argument("boundary loops contain coincident nodes");
  const auto bounds = bounds_of(boundary.geometry);
  const double extent = max_extent(bounds);
  const double target = config.refinement.target_cell_size > 0 ? config.refinement.target_cell_size : extent / 24;
  const double coarse = 2.8 * target;
  const double eps = extent * 1e-10;
  auto field = [&](Point2 p) {
    double h = coarse, clearance = extent;
    for (Edge e : constraints) {
      const double d = distance_to_segment(p, {points[e.first], points[e.second]});
      clearance = std::min(clearance, d);
      h = std::min(h, 1.5 * distance(points[e.first], points[e.second]) + 1.4 * d);
    }
    return std::pair{h, clearance};
  };
  auto insert = [&](Point2 p, double minimum_distance) {
    if (!inside(boundary, p)) return false;
    const auto [h, clearance] = field(p);
    (void)h;
    if (clearance < minimum_distance) return false;
    for (auto q : points) if (distance(p, q) < minimum_distance) return false;
    points.push_back(p);
    return true;
  };
  // Boundary-adjacent seeds are proportional to actual edge lengths, so
  // tiny holes do not impose their spacing on the whole domain.
  for (Edge e : constraints) {
    const Point2 a = points[e.first], b = points[e.second];
    const Vec2 d = b - a;
    const double len = length(d);
    if (len <= eps) throw std::invalid_argument("zero-length or duplicate boundary edge");
    const Point2 mid{(a.x + b.x) / 2, (a.y + b.y) / 2};
    const Vec2 normal{-d.y / len, d.x / len};
    for (double sign : {1.0, -1.0}) insert(mid + normal * (sign * 0.8 * len), 0.55 * len);
  }
  struct Cell { Point2 lo; double size; int depth; };
  std::vector<Cell> pending{{bounds.min, extent, 0}}, leaves;
  while (!pending.empty()) {
    const auto c = pending.back(); pending.pop_back();
    const Point2 mid = c.lo + Vec2{c.size / 2, c.size / 2};
    const auto [h, clearance] = field(mid);
    (void)clearance;
    if (c.size > h && c.depth < config.refinement.max_level) {
      for (int y = 0; y < 2; ++y) for (int x = 0; x < 2; ++x)
        pending.push_back({c.lo + Vec2{x * c.size / 2, y * c.size / 2}, c.size / 2, c.depth + 1});
    } else leaves.push_back(c);
    if (leaves.size() + pending.size() > 200000) throw std::invalid_argument("requested mesh exceeds the interior sampling limit");
  }
  std::stable_sort(leaves.begin(), leaves.end(), [](const Cell& a, const Cell& b) {
    return std::tie(a.size, a.lo.y, a.lo.x) < std::tie(b.size, b.lo.y, b.lo.x);
  });
  for (const auto& c : leaves) {
    const Point2 p = c.lo + Vec2{c.size / 2, c.size / 2};
    const auto [h, clearance] = field(p);
    (void)clearance;
    insert(p, 0.52 * h);
  }

  auto tris = triangulate(points, constraints);
  auto clip = [&] {
    tris.erase(std::remove_if(tris.begin(), tris.end(), [&](const Triangle& t) {
      return !inside(boundary, centroid(t, points));
    }), tris.end());
  };
  clip();
  const auto midpoint = [&](int a, int b) {
    const auto found = prescribed_midpoints.find(key(a, b));
    return found != prescribed_midpoints.end() ? found->second :
        Point2{(points[a].x + points[b].x) / 2, (points[a].y + points[b].y) / 2};
  };
  // Coarsening a sampled turn can create an ear at a point that is smooth
  // in the prescribed boundary. Its two actual edge directions still form
  // 180 degrees: insert an interior ray instead of emitting a flat quad.
  if (paired_boundary) for (int pass = 0; pass < 4; ++pass) {
    std::vector<Point2> additions;
    for (const auto& t : tris) for (int k = 0; k < 3; ++k) {
      const int at = t.v[k], next = t.v[(k + 1) % 3], prev = t.v[(k + 2) % 3];
      if (!constraints.contains(key(at, next)) || !constraints.contains(key(at, prev))) continue;
      const auto u = midpoint(at, next) - points[at], v = midpoint(at, prev) - points[at];
      if (cross(u, v) / (length(u) * length(v)) < 0.3421) {
        additions.push_back(centroid(t, points));
        break;
      }
    }
    if (additions.empty()) break;
    points.insert(points.end(), additions.begin(), additions.end());
    tris = triangulate(points, constraints);
    clip();
  }
  if (tris.empty()) throw std::invalid_argument("boundary encloses no meshable area");
  const auto tri_adj = adjacency(tris);
  struct PairCandidate { int a, b; std::array<int, 4> nodes; double score; };
  std::vector<PairCandidate> candidates;
  for (const auto& [e, incident] : tri_adj) {
    if (incident.size() != 2 || constraints.contains(e)) continue;
    const int a = opposite(tris[incident[0]], e), b = opposite(tris[incident[1]], e);
    std::array<int, 4> nodes{a, e.first, b, e.second};
    if (orient(points[nodes[0]], points[nodes[1]], points[nodes[2]]) < 0)
      std::reverse(nodes.begin(), nodes.end());
    double score = 1, shortest = extent, longest = 0;
    for (int k = 0; k < 4; ++k) {
      const Vec2 u = points[nodes[(k + 1) % 4]] - points[nodes[k]];
      const Vec2 v = points[nodes[(k + 3) % 4]] - points[nodes[k]];
      score = std::min(score, cross(u, v) / (length(u) * length(v)));
      if (paired_boundary) {
        const Vec2 actual_u = midpoint(nodes[k], nodes[(k + 1) % 4]) - points[nodes[k]];
        const Vec2 actual_v = midpoint(nodes[k], nodes[(k + 3) % 4]) - points[nodes[k]];
        score = std::min(score, cross(actual_u, actual_v) / (length(actual_u) * length(actual_v)));
      }
      shortest = std::min(shortest, length(u)); longest = std::max(longest, length(u));
    }
    if (score >= 0.5 && shortest / longest >= 0.2)
      candidates.push_back({incident[0], incident[1], nodes, score + 0.1 * shortest / longest});
  }
  std::stable_sort(candidates.begin(), candidates.end(), [](const auto& a, const auto& b) { return a.score > b.score; });
  std::vector<std::vector<int>> graph(tris.size());
  for (const auto& c : candidates) {
    graph[c.a].push_back(c.b); graph[c.b].push_back(c.a);
  }
  const auto matching = maximum_matching(graph);
  struct Patch { std::vector<int> nodes; };
  std::vector<Patch> patches;
  std::vector<bool> paired(tris.size(), false);
  for (const auto& c : candidates) if (matching[c.a] == c.b) {
    paired[c.a] = paired[c.b] = true;
    patches.push_back({std::vector<int>(c.nodes.begin(), c.nodes.end())});
  }
  for (std::size_t i = 0; i < tris.size(); ++i) if (!paired[i])
    patches.push_back({std::vector<int>(tris[i].v.begin(), tris[i].v.end())});
  Adjacency adj;
  for (std::size_t i = 0; i < patches.size(); ++i) {
    const auto& p = patches[i].nodes;
    for (std::size_t k = 0; k < p.size(); ++k) adj[key(p[k], p[(k + 1) % p.size()])].push_back(static_cast<int>(i));
  }
  std::vector<std::vector<std::pair<int, Edge>>> dual(patches.size());
  std::set<Edge> split;
  std::vector<bool> defect;
  for (const auto& p : patches) defect.push_back(!paired_boundary && p.nodes.size() % 2 != 0);
  for (const auto& [e, incident] : adj) {
    if (paired_boundary) split.insert(e);
    if (constraints.contains(e)) continue;
    if (incident.size() != 2) throw std::logic_error("unconstrained open triangulation edge");
    dual[incident[0]].push_back({incident[1], e});
    dual[incident[1]].push_back({incident[0], e});
  }
  // Interior edge splits form a T-join: every triangular patch receives an
  // odd number of split edges, hence an even boundary. Constraints are never
  // candidates, including control edges with an element on each side.
  for (std::size_t from = 0; from < patches.size(); ++from) if (defect[from]) {
    if (debug) ++debug->parity_defect_count;
    std::vector<int> parent(patches.size(), -1);
    std::vector<Edge> via(patches.size());
    std::queue<int> queue;
    queue.push(static_cast<int>(from)); parent[from] = static_cast<int>(from);
    int found = -1;
    while (!queue.empty() && found < 0) {
      const int at = queue.front(); queue.pop();
      for (const auto& [next, edge] : dual[at]) if (parent[next] < 0) {
        parent[next] = at; via[next] = edge;
        if (defect[next]) { found = next; break; }
        queue.push(next);
      }
    }
    if (found < 0) throw std::invalid_argument("odd boundary edge count in a constrained region");
    defect[from] = false; defect[found] = false;
    for (int at = found; at != static_cast<int>(from); at = parent[at]) {
      if (split.contains(via[at])) split.erase(via[at]); else split.insert(via[at]);
    }
  }
  GlobalMesh mesh;
  for (std::size_t i = 0; i < points.size(); ++i) mesh.nodes.push_back({points[i], i < boundary_count});
  std::map<Edge, int> midpoints;
  for (Edge e : split) {
    midpoints[e] = static_cast<int>(mesh.nodes.size());
    const auto prescribed = prescribed_midpoints.find(e);
    mesh.nodes.push_back({prescribed != prescribed_midpoints.end() ? prescribed->second :
                          Point2{(points[e.first].x + points[e.second].x) / 2,
                                 (points[e.first].y + points[e.second].y) / 2},
                          prescribed != prescribed_midpoints.end()});
  }
  for (const auto& patch : patches) {
    std::vector<int> ids;
    std::vector<Point2> polygon;
    for (std::size_t k = 0; k < patch.nodes.size(); ++k) {
      ids.push_back(patch.nodes[k]);
      auto it = midpoints.find(key(patch.nodes[k], patch.nodes[(k + 1) % patch.nodes.size()]));
      if (it != midpoints.end()) ids.push_back(it->second);
    }
    for (int i : ids) polygon.push_back(mesh.nodes[i].point);
    if (ids.size() % 2 != 0) throw std::logic_error("constrained patch parity was not resolved");
    if (patch.nodes.size() == 4 && ids.size() == 4) {
      mesh.quads.push_back({{NodeId{static_cast<std::uint32_t>(ids[0])}, NodeId{static_cast<std::uint32_t>(ids[1])},
                            NodeId{static_cast<std::uint32_t>(ids[2])}, NodeId{static_cast<std::uint32_t>(ids[3])}}});
      continue;
    }
    if (paired_boundary || (patch.nodes.size() == 3 && ids.size() == 6)) {
      // Three split sides have the ordinary three-quad subdivision. Avoid
      // searching the general polygon family for each interior triangle.
      const auto center = static_cast<std::uint32_t>(mesh.nodes.size());
      Point2 c{};
      for (int i : patch.nodes) { c.x += points[i].x; c.y += points[i].y; }
      c.x /= static_cast<double>(patch.nodes.size()); c.y /= static_cast<double>(patch.nodes.size());
      mesh.nodes.push_back({c, false});
      const std::size_t first_quad = mesh.quads.size();
      for (std::size_t k = 0; k < ids.size(); k += 2)
        mesh.quads.push_back({{NodeId{static_cast<std::uint32_t>(ids[k])},
                              NodeId{static_cast<std::uint32_t>(ids[(k + 1) % ids.size()])},
                              NodeId{center},
                              NodeId{static_cast<std::uint32_t>(ids[(k + ids.size() - 1) % ids.size()])}}});
      const auto quality = [&] {
        double q = 1;
        for (std::size_t i = first_quad; i < mesh.quads.size(); ++i)
          q = std::min(q, quad_quality(mesh, mesh.quads[i]).min_scaled_jacobian);
        return q;
      };
      double best = quality(), step = 0;
      for (int i : patch.nodes) step = std::max(step, distance(c, points[i]) * 0.2);
      for (int pass = 0; pass < 24; ++pass) {
        bool improved = false;
        const auto start = c;
        for (const Vec2 dir : {Vec2{1, 0}, {-1, 0}, {0, 1}, {0, -1}, {.707, .707}, {-.707, .707}, {.707, -.707}, {-.707, -.707}}) {
          mesh.nodes[center].point = start + dir * step;
          const double q = quality();
          if (q > best + 1e-12) { best = q; c = mesh.nodes[center].point; improved = true; }
        }
        mesh.nodes[center].point = c;
        if (!improved) step *= 0.5;
      }
      continue;
    }
    EmptyTemplatePlan plan;
    if (patch.nodes.size() == 4) {
      std::array<Point2, 4> corners;
      EmptyTemplateSideParameters parameters;
      for (int k = 0; k < 4; ++k) {
        corners[k] = points[patch.nodes[k]];
        if (midpoints.contains(key(patch.nodes[k], patch.nodes[(k + 1) % 4]))) parameters[k].push_back(0.5);
      }
      plan = choose_empty_template(corners, polygon, parameters);
    } else plan = choose_polygon_template(polygon);
    if (!(plan.quality.min_scaled_jacobian > 0))
      throw std::invalid_argument("fixed boundary spacing cannot produce a positive constrained patch");
    for (auto p : plan.interior) {
      ids.push_back(static_cast<int>(mesh.nodes.size()));
      mesh.nodes.push_back({p, false});
    }
    for (const auto& q : plan.quads)
      mesh.quads.push_back({{NodeId{static_cast<std::uint32_t>(ids[q[0]])}, NodeId{static_cast<std::uint32_t>(ids[q[1]])},
                            NodeId{static_cast<std::uint32_t>(ids[q[2]])}, NodeId{static_cast<std::uint32_t>(ids[q[3]])}}});
  }
  // Compact unused seed/template nodes without changing the prescribed points.
  std::vector<int> remap(mesh.nodes.size(), -1);
  for (const auto& q : mesh.quads) for (auto n : q.nodes) remap[n.value] = 0;
  std::vector<MeshNode> compact;
  for (std::size_t i = 0; i < mesh.nodes.size(); ++i) if (remap[i] == 0) {
    remap[i] = static_cast<int>(compact.size()); compact.push_back(mesh.nodes[i]);
  }
  for (auto& q : mesh.quads) for (auto& n : q.nodes) n.value = static_cast<std::uint32_t>(remap[n.value]);
  mesh.nodes = std::move(compact);
  attach_boundary_sources(mesh, domain, &original_boundary);
  return mesh;
}

} // namespace quadmesh::detail
