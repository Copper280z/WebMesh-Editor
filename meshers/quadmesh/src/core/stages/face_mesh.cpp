#include "stages/face_mesh.hpp"

#include "detail/empty_templates.hpp"
#include "detail/types.hpp" // pi
#include "quadmesh/geometry.hpp"
#include "quadmesh/mesh.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace quadmesh::detail {
namespace {

Point2 polyline_point_at_fraction(const std::vector<Point2>& pts, double fraction)
{
  double total = 0.0;
  for (std::size_t i = 0; i + 1 < pts.size(); ++i) {
    total += distance(pts[i], pts[i + 1]);
  }
  const double target = total * fraction;
  double walked = 0.0;
  for (std::size_t i = 0; i + 1 < pts.size(); ++i) {
    const double step = distance(pts[i], pts[i + 1]);
    if (walked + step >= target && step > 0.0) {
      const double t = (target - walked) / step;
      return pts[i] + (pts[i + 1] - pts[i]) * t;
    }
    walked += step;
  }
  return pts.back();
}

double quad_min_scaled_jacobian(Point2 p0, Point2 p1, Point2 p2, Point2 p3)
{
  const Point2 pts[4] = {p0, p1, p2, p3};
  double worst = std::numeric_limits<double>::max();
  for (int i = 0; i < 4; ++i) {
    const Point2 a = pts[i];
    const Point2 b = pts[(i + 1) % 4];
    const Point2 d = pts[(i + 3) % 4];
    const Vec2 e1 = b - a;
    const Vec2 e2 = d - a;
    const double denominator = length(e1) * length(e2);
    worst = std::min(worst, denominator > 0.0 ? cross(e1, e2) / denominator : -1.0);
  }
  return worst;
}

// Points of a chain between two arc positions (seg + t), walking forward.
std::vector<Point2> chain_piece_points(const std::vector<Chain>& chains, double root_size,
                                       int chain_id, double arc_from, double arc_to)
{
  const Chain& chain = chains[chain_id];
  const int n = static_cast<int>(chain.points.size());
  const int m = static_cast<int>(chain.segment_count());
  std::vector<Point2> pts;
  int seg = static_cast<int>(std::floor(arc_from));
  double t = arc_from - seg;
  const auto seg_point = [&](int si, double ti) {
    const Segment2 sg = chain.segment(static_cast<std::size_t>(si % m));
    return sg.a + (sg.b - sg.a) * ti;
  };
  pts.push_back(seg_point(seg, t));
  const int end_seg = static_cast<int>(std::floor(arc_to));
  const double end_t = arc_to - end_seg;
  int guard = 0;
  while (guard++ <= m + 1) {
    if ((seg % m) == (end_seg % m)
        && ((arc_to >= arc_from && guard == 1) || guard > 1)) {
      pts.push_back(seg_point(end_seg, end_t));
      break;
    }
    // advance to next joint
    seg = (seg + 1) % m;
    pts.push_back(chain.points[static_cast<std::size_t>(seg % n)]);
    if ((seg % m) == (end_seg % m)) {
      pts.push_back(seg_point(end_seg, end_t));
      break;
    }
  }
  // Drop degenerate steps.
  std::vector<Point2> cleaned;
  for (const Point2& p : pts) {
    if (cleaned.empty() || distance(cleaned.back(), p) > 1.0e-12 * root_size) {
      cleaned.push_back(p);
    }
  }
  return cleaned;
}

// A chord is acceptable when it neither crosses another collected edge nor
// exceeds the caller's smooth-curve approximation tolerance.
bool chord_ok(const std::vector<MeshNode>& nodes, double root_size,
              const std::vector<GraphEdge>& edges, const std::vector<Point2>& pts)
{
  const Segment2 chord{pts.front(), pts.back()};
  const double tol = 1.0e-9 * root_size;
  for (const GraphEdge& edge : edges) {
    const std::vector<Point2>* geometry = edge.curve ? &edge.geometry : nullptr;
    std::vector<Point2> straight;
    if (geometry == nullptr) {
      straight = {nodes[edge.a].point, nodes[edge.b].point};
      geometry = &straight;
    }
    for (std::size_t i = 0; i + 1 < geometry->size(); ++i) {
      const auto hit = intersect_segments(chord, {(*geometry)[i], (*geometry)[i + 1]}, tol);
      if (!hit.has_value()) {
        continue;
      }
      if (distance(hit->point, chord.a) < 10.0 * tol || distance(hit->point, chord.b) < 10.0 * tol) {
        continue;
      }
      return false;
    }
  }
  return true;
}

double chord_deviation(const std::vector<Point2>& pts)
{
  if (pts.size() <= 2) {
    return 0.0;
  }
  const Segment2 chord{pts.front(), pts.back()};
  double worst = 0.0;
  for (std::size_t i = 1; i + 1 < pts.size(); ++i) {
    worst = std::max(worst, distance_to_segment(pts[i], chord));
  }
  return worst;
}

// Preserve a smooth polyline as a chord only within the configured local
// tolerance. Otherwise emit one graph edge per source segment so the linear
// output follows the input exactly.
void add_chain_piece_edges(MeshBuilder& mb, MesherDebug* debug, double root_size,
                           std::vector<GraphEdge>& edges, std::int32_t leaf,
                           const std::vector<Point2>& piece, int node_from, int node_to,
                           const FeatureVertex* vertex, double s, double chord_tolerance_fraction)
{
  const auto& nodes = mb.nodes;
  const auto add_node = [&](Point2 p, bool on_boundary) { return mb.add_node(p, on_boundary); };
  const auto warn = [&](std::string message) {
    if (debug != nullptr) {
      debug->warnings.push_back(std::move(message));
    }
  };
  (void)leaf;
  // Degenerate piece between two crossings snapped onto the same vertex.
  if (node_from == node_to) {
    double arc = 0.0;
    for (std::size_t i = 0; i + 1 < piece.size(); ++i) {
      arc += distance(piece[i], piece[i + 1]);
    }
    if (arc < 0.3 * s) {
      return;
    }
    warn("self-loop chain piece skipped");
    return;
  }
  std::vector<Point2> pts = piece;
  // Snapped crossings: make the polyline endpoints agree with the node
  // positions exactly.
  pts.front() = nodes[node_from].point;
  pts.back() = nodes[node_to].point;

  bool contains_feature = false;
  if (vertex != nullptr) {
    for (std::size_t i = 1; i + 1 < pts.size(); ++i) {
      if (distance(pts[i], vertex->point) < 1.0e-9 * s) {
        contains_feature = true;
        break;
      }
    }
  }
  if (!contains_feature && chord_deviation(pts) <= chord_tolerance_fraction * s
      && chord_ok(nodes, root_size, edges, pts)) {
    GraphEdge edge;
    edge.a = node_from;
    edge.b = node_to;
    edge.curve = true;
    edge.geometry = std::move(pts);
    edges.push_back(std::move(edge));
    return;
  }

  int prev_node = node_from;
  std::size_t start = 0;
  for (std::size_t i = 1; i < pts.size(); ++i) {
    const bool last = i + 1 == pts.size();
    int next_node = node_to;
    if (!last) {
      next_node = vertex != nullptr && distance(pts[i], vertex->point) < 1.0e-9 * s
                      ? vertex->node
                      : add_node(pts[i], true);
    }
    if (next_node != prev_node) {
      GraphEdge edge;
      edge.a = prev_node;
      edge.b = next_node;
      edge.curve = true;
      edge.geometry.assign(pts.begin() + static_cast<std::ptrdiff_t>(start),
                           pts.begin() + static_cast<std::ptrdiff_t>(i + 1));
      edges.push_back(std::move(edge));
    }
    prev_node = next_node;
    start = i;
  }
}

// Planar face walk over the local graph.
std::vector<Face> walk_faces(const std::vector<MeshNode>& nodes, MesherDebug* debug,
                             const std::vector<GraphEdge>& edges, double s)
{
  const auto warn = [&](std::string message) {
    if (debug != nullptr) {
      debug->warnings.push_back(std::move(message));
    }
  };
  struct Half {
    int edge = 0;
    bool reversed = false;
    int from = 0;
    int to = 0;
    double angle = 0.0;
    int next = -1;
    bool used = false;
  };
  std::vector<Half> halves;
  std::map<int, std::vector<int>> outgoing; // node -> half indices
  for (int e = 0; e < static_cast<int>(edges.size()); ++e) {
    const GraphEdge& edge = edges[e];
    const Point2 pa = nodes[edge.a].point;
    const Point2 pb = nodes[edge.b].point;
    Vec2 dir_ab = pb - pa;
    Vec2 dir_ba = pa - pb;
    if (edge.curve && edge.geometry.size() > 2) {
      dir_ab = edge.geometry[1] - edge.geometry[0];
      dir_ba = edge.geometry[edge.geometry.size() - 2] - edge.geometry.back();
    }
    Half forward;
    forward.edge = e;
    forward.reversed = false;
    forward.from = edge.a;
    forward.to = edge.b;
    forward.angle = std::atan2(dir_ab.y, dir_ab.x);
    halves.push_back(forward);
    outgoing[edge.a].push_back(static_cast<int>(halves.size()) - 1);
    Half backward;
    backward.edge = e;
    backward.reversed = true;
    backward.from = edge.b;
    backward.to = edge.a;
    backward.angle = std::atan2(dir_ba.y, dir_ba.x);
    halves.push_back(backward);
    outgoing[edge.b].push_back(static_cast<int>(halves.size()) - 1);
  }
  for (auto& [node, list] : outgoing) {
    std::sort(list.begin(), list.end(),
              [&](int l, int r) { return halves[l].angle < halves[r].angle; });
  }
  // next(h): at h.to, take the outgoing half that is the clockwise-next
  // from the reverse of h. With CCW-sorted lists this is the entry just
  // below the reverse angle.
  for (int h = 0; h < static_cast<int>(halves.size()); ++h) {
    const int twin = h ^ 1;
    const auto& list = outgoing[halves[h].to];
    const double ref = halves[twin].angle;
    // Rotation system: the twin participates with diff = 2*pi, so it is
    // chosen only at dead ends; this keeps `next` a permutation and every
    // walk provably closes.
    int best = twin;
    double best_delta = std::numeric_limits<double>::max();
    for (const int candidate : list) {
      double diff = candidate == twin ? 2.0 * pi : ref - halves[candidate].angle;
      while (diff <= 0.0) {
        diff += 2.0 * pi;
      }
      while (diff > 2.0 * pi) {
        diff -= 2.0 * pi;
      }
      if (diff < best_delta) {
        best_delta = diff;
        best = candidate;
      }
    }
    halves[h].next = best;
  }

  std::vector<Face> faces;
  for (int h = 0; h < static_cast<int>(halves.size()); ++h) {
    if (halves[h].used) {
      continue;
    }
    Face face;
    double area2 = 0.0;
    int current = h;
    int guard = 0;
    bool valid = true;
    while (guard++ < 1000) {
      halves[current].used = true;
      const GraphEdge& edge = edges[halves[current].edge];
      face.corners.push_back(halves[current].from);
      GraphEdge directed = edge;
      if (halves[current].reversed) {
        std::swap(directed.a, directed.b);
        std::reverse(directed.geometry.begin(), directed.geometry.end());
      }
      face.edges.push_back(std::move(directed));
      // Accumulate area along actual edge geometry.
      std::vector<Point2> geometry = face.edges.back().geometry;
      if (geometry.empty()) {
        geometry = {nodes[halves[current].from].point, nodes[halves[current].to].point};
      }
      for (std::size_t i = 0; i + 1 < geometry.size(); ++i) {
        area2 += cross({geometry[i].x, geometry[i].y}, {geometry[i + 1].x, geometry[i + 1].y});
      }
      current = halves[current].next;
      if (current == h) {
        break;
      }
      if (current < 0) {
        valid = false;
        break;
      }
    }
    if (!valid || guard >= 1000) {
      const Point2 at = nodes[halves[h].from].point;
      warn("face walk failed to close near (" + std::to_string(at.x) + ", "
           + std::to_string(at.y) + ")");
      continue;
    }
    if (area2 <= 1.0e-12 * s * s) {
      continue; // outer face (negative) or degenerate
    }
    faces.push_back(std::move(face));
  }
  return faces;
}

} // namespace

std::vector<PathEntry> build_path(const Lattice& lat, const BoundaryTopology& topo, MeshBuilder& mb,
                                  std::int32_t leaf)
{
  const Tree& tree = lat.tree;
  const auto& side_crossings = topo.side_crossings;
  const auto& side_bend = topo.side_bend;
  const auto gp_node_id = [&](std::uint32_t gx, std::uint32_t gy) { return mb.gp_node_id(gx, gy); };

  const Cell& cell = tree.cells[leaf];
  std::vector<PathEntry> path;
  for (int side = 0; side < 4; ++side) {
    const std::vector<SideSpan> spans = tree.side_spans(leaf, side);
    PathEntry corner;
    corner.node = gp_node_id(spans.front().ax, spans.front().ay);
    path.push_back(corner);
    for (std::size_t span_index = 0; span_index < spans.size(); ++span_index) {
      const SideSpan& span = spans[span_index];
      if (span_index > 0) {
        PathEntry junction;
        junction.node = gp_node_id(span.ax, span.ay);
        path.push_back(junction);
      }
      struct OnSide {
        double t = 0.0;
        PathEntry entry;
      };
      std::vector<OnSide> additions;
      const auto key = Tree::side_span_key(span);
      const auto cross_it = side_crossings.find(key);
      if (cross_it != side_crossings.end()) {
        for (const Crossing& crossing : cross_it->second) {
          OnSide on;
          on.t = crossing.t_on_side;
          on.entry.node = crossing.node;
          on.entry.is_crossing = true;
          on.entry.crossing = crossing;
          additions.push_back(on);
        }
      }
      if (!span.subside) {
        const auto bend_it = side_bend.find(tree.side_key(cell, side));
        if (bend_it != side_bend.end()) {
          OnSide on;
          on.t = 0.5;
          on.entry.node = bend_it->second;
          additions.push_back(on);
        }
      }
      const bool forward = gp_key(span.ax, span.ay) < gp_key(span.bx, span.by);
      std::sort(additions.begin(), additions.end(), [&](const OnSide& l, const OnSide& r) {
        return forward ? l.t < r.t : l.t > r.t;
      });
      for (const OnSide& on : additions) {
        path.push_back(on.entry);
      }
    }
  }
  // Crossings snapped onto a shared vertex can repeat the same node;
  // collapse consecutive duplicates (cyclically), and remove spurs
  // (X -> Y -> X), which arise when a vertex close to a grid corner is
  // inserted into both adjacent sides: the pinched-off sliver between the
  // two identical chords has zero area, and the neighboring squares meet
  // directly across the chord.
  std::vector<PathEntry> deduped = std::move(path);
  bool changed = true;
  while (changed) {
    changed = false;
    std::vector<PathEntry> next;
    for (const PathEntry& entry : deduped) {
      if (!next.empty() && next.back().node == entry.node) {
        changed = true;
        continue;
      }
      next.push_back(entry);
    }
    while (next.size() > 1 && next.front().node == next.back().node) {
      next.pop_back();
      changed = true;
    }
    deduped = std::move(next);
    const std::size_t n = deduped.size();
    if (n < 3) {
      break;
    }
    for (std::size_t i = 0; i < n; ++i) {
      const std::size_t prev = (i + n - 1) % n;
      const std::size_t after = (i + 1) % n;
      if (deduped[prev].node == deduped[after].node) {
        // Drop the spur tip and one of the duplicate endpoints.
        std::vector<PathEntry> rebuilt;
        for (std::size_t k = 0; k < n; ++k) {
          if (k == i || k == after) {
            continue;
          }
          rebuilt.push_back(deduped[k]);
        }
        deduped = std::move(rebuilt);
        changed = true;
        break;
      }
    }
  }
  return deduped;
}

std::vector<Face> build_faces(const Lattice& lat, const GeometryModel& gm,
                              const BoundaryTopology& topo, MeshBuilder& mb, const MeshingConfig& config,
                              MesherDebug* debug,
                              std::int32_t leaf, const std::vector<PathEntry>& path)
{
  const Tree& tree = lat.tree;
  const auto& chains = gm.chains;
  const auto& features = gm.features;
  const auto& nodes = mb.nodes;
  const auto& side_bend = topo.side_bend;
  const auto& leaf_vertex = topo.leaf_vertex;
  const auto& vertex_corner_rays = topo.vertex_corner_rays;
  const auto side_key = [&](const Cell& cell, int side) { return tree.side_key(cell, side); };

  const Cell& cell = tree.cells[leaf];
  const double s = tree.size_at(cell.level);

  // Path polygon for inside tests.
  std::vector<Point2> poly;
  poly.reserve(path.size());
  for (const PathEntry& entry : path) {
    poly.push_back(nodes[entry.node].point);
  }
  const auto in_poly = [&](Point2 p) {
    bool in = false;
    const std::size_t n = poly.size();
    for (std::size_t a = 0, b = n - 1; a < n; b = a++) {
      if ((poly[a].y > p.y) != (poly[b].y > p.y)
          && p.x < poly[a].x + (p.y - poly[a].y) * (poly[b].x - poly[a].x) / (poly[b].y - poly[a].y)) {
        in = !in;
      }
    }
    return in;
  };

  std::vector<GraphEdge> edges;
  // Path edges.
  for (std::size_t i = 0; i < path.size(); ++i) {
    GraphEdge edge;
    edge.a = path[i].node;
    edge.b = path[(i + 1) % path.size()].node;
    edges.push_back(edge);
  }

  // Chain pieces inside this square.
  const FeatureVertex* vertex = nullptr;
  const auto vertex_it = leaf_vertex.find(leaf);
  if (vertex_it != leaf_vertex.end()) {
    vertex = &features[vertex_it->second];
  }

  std::map<int, std::vector<ChainArcPos>> by_chain;
  for (std::size_t i = 0; i < path.size(); ++i) {
    if (!path[i].is_crossing || path[i].crossing.chain < 0) {
      continue;
    }
    ChainArcPos pos;
    pos.chain = path[i].crossing.chain;
    pos.arc = path[i].crossing.seg + path[i].crossing.t_on_seg;
    pos.path_index = static_cast<int>(i);
    by_chain[pos.chain].push_back(pos);
  }
  for (auto& [chain_id, list] : by_chain) {
    const Chain& chain = chains[chain_id];
    std::sort(list.begin(), list.end(),
              [](const ChainArcPos& a, const ChainArcPos& b) { return a.arc < b.arc; });
    const std::size_t count = list.size();
    if (count < 2 && chain.closed) {
      // A vertex grazing the square: both ray stubs collapsed onto the
      // snapped vertex; the square is meshed as a plain bent polygon.
      continue;
    }
    const std::size_t pieces = chain.closed ? count : count - 1;
    for (std::size_t k = 0; k < pieces; ++k) {
      const ChainArcPos& from = list[k];
      const ChainArcPos& to = list[(k + 1) % count];
      // Pieces much longer than the square cannot lie inside it; skip them
      // before materializing (the complement of a small bite out of a long
      // closed chain is nearly the whole chain).
      if (chain.arc_between(from.arc, to.arc) > 6.0 * s) {
        continue;
      }
      // Sample the piece to decide whether it runs inside. A piece can
      // also hug the (bent) path exactly — e.g. a ray stub between two
      // snapped crossings — in which case it is kept so that it merges
      // with the coincident path edge and marks it as geometry.
      const std::vector<Point2> piece = chain_piece_points(chains, tree.root_size, chain_id,
                                                           from.arc, to.arc);
      if (piece.size() < 2) {
        continue;
      }
      bool keep = false;
      for (const double fraction : {0.5, 0.25, 0.75}) {
        if (in_poly(polyline_point_at_fraction(piece, fraction))) {
          keep = true;
          break;
        }
      }
      if (!keep) {
        const Point2 sample = polyline_point_at_fraction(piece, 0.5);
        double to_path = std::numeric_limits<double>::max();
        for (std::size_t a = 0, b = poly.size() - 1; a < poly.size(); b = a++) {
          to_path = std::min(to_path, distance_to_segment(sample, {poly[b], poly[a]}));
        }
        keep = to_path < 1.0e-6 * s;
      }
      if (!keep) {
        continue;
      }
      add_chain_piece_edges(mb, debug, tree.root_size, edges, leaf, piece,
                            path[from.path_index].node, path[to.path_index].node, vertex, s,
                            config.features.chord_tolerance_fraction);
    }
  }

  // Vertex rays to pulled side midpoints.
  if (vertex != nullptr) {
    for (int side = 0; side < 4; ++side) {
      const auto key = side_key(cell, side);
      const auto bend_it = side_bend.find(key);
      if (bend_it == side_bend.end()) {
        continue;
      }
      GraphEdge ray;
      ray.a = vertex->node;
      ray.b = bend_it->second;
      edges.push_back(ray);
    }
    const auto rays_it = vertex_corner_rays.find(leaf);
    if (rays_it != vertex_corner_rays.end()) {
      for (const int corner_node : rays_it->second) {
        GraphEdge ray;
        ray.a = vertex->node;
        ray.b = corner_node;
        edges.push_back(ray);
      }
    }
  }

  // A side path bent through a vertex can coincide with a chain ray
  // between the same two nodes (a zero-area lens). Duplicate connections
  // with near-coincident geometry break the angular sort; merge them,
  // preferring the curve edge. Distinct geometry (a genuine dip between a
  // side and the curve) is kept: its face has real area.
  {
    std::map<std::pair<int, int>, std::size_t> first_seen;
    std::vector<GraphEdge> merged;
    for (GraphEdge& edge : edges) {
      const std::pair<int, int> key{std::min(edge.a, edge.b), std::max(edge.a, edge.b)};
      const auto it = first_seen.find(key);
      if (it == first_seen.end()) {
        first_seen.emplace(key, merged.size());
        merged.push_back(std::move(edge));
        continue;
      }
      GraphEdge& kept = merged[it->second];
      const auto deviation = [&](const GraphEdge& e) {
        if (!e.curve || e.geometry.size() <= 2) {
          return 0.0;
        }
        const Segment2 chord{nodes[e.a].point, nodes[e.b].point};
        double worst = 0.0;
        for (const Point2& p : e.geometry) {
          worst = std::max(worst, distance_to_segment(p, chord));
        }
        return worst;
      };
      if (deviation(edge) < 0.05 * s && deviation(kept) < 0.05 * s) {
        if (edge.curve && !kept.curve) {
          kept = std::move(edge);
        }
        continue; // drop the duplicate
      }
      merged.push_back(std::move(edge));
    }
    edges = std::move(merged);
  }

  return walk_faces(nodes, debug, edges, s);
}

Point2 face_sample(const MeshBuilder& mb, const Face& face)
{
  const auto& nodes = mb.nodes;
  std::vector<Point2> poly;
  for (const GraphEdge& edge : face.edges) {
    std::vector<Point2> geometry = edge.geometry;
    if (geometry.empty()) {
      geometry = {nodes[edge.a].point, nodes[edge.b].point};
    }
    for (std::size_t i = 0; i + 1 < geometry.size(); ++i) {
      poly.push_back(geometry[i]);
    }
  }
  const auto in_poly = [&](Point2 p) {
    bool in = false;
    const std::size_t n = poly.size();
    for (std::size_t a = 0, b = n - 1; a < n; b = a++) {
      if ((poly[a].y > p.y) != (poly[b].y > p.y)
          && p.x < poly[a].x + (p.y - poly[a].y) * (poly[b].x - poly[a].x) / (poly[b].y - poly[a].y)) {
        in = !in;
      }
    }
    return in;
  };
  Point2 centroid{0.0, 0.0};
  for (const Point2& p : poly) {
    centroid.x += p.x;
    centroid.y += p.y;
  }
  centroid.x /= static_cast<double>(poly.size());
  centroid.y /= static_cast<double>(poly.size());
  if (in_poly(centroid)) {
    return centroid;
  }
  // Offset inward from edge midpoints until a point lands inside.
  for (double scale : {0.25, 0.1, 0.02}) {
    const std::size_t n = poly.size();
    for (std::size_t a = 0; a < n; ++a) {
      const Point2 pa = poly[a];
      const Point2 pb = poly[(a + 1) % n];
      const Point2 mid{(pa.x + pb.x) / 2.0, (pa.y + pb.y) / 2.0};
      const Vec2 d = pb - pa;
      const Vec2 normal{-d.y, d.x}; // left of CCW edge = interior
      const Point2 candidate = mid + normal * scale;
      if (in_poly(candidate)) {
        return candidate;
      }
    }
  }
  return centroid;
}

void subdivide_face(MeshBuilder& mb, const Face& face)
{
  auto& nodes = mb.nodes;
  auto& quads = mb.quads;
  const auto add_node = [&](Point2 p, bool on_boundary) { return mb.add_node(p, on_boundary); };
  const auto curve_mid_node = [&](const GraphEdge& edge) { return mb.curve_mid_node(edge); };
  const auto straight_mid_node = [&](int a, int b) { return mb.straight_mid_node(a, b); };
  const auto emit_template_plan = [&](const EmptyTemplatePlan& plan,
                                      const std::vector<int>& boundary_nodes) {
    std::vector<int> local_nodes = boundary_nodes;
    local_nodes.reserve(boundary_nodes.size() + plan.interior.size());
    for (const Point2 point : plan.interior) {
      local_nodes.push_back(add_node(point, false));
    }
    for (const std::array<int, 4>& local_quad : plan.quads) {
      std::array<int, 4> quad;
      for (int k = 0; k < 4; ++k) {
        quad[k] = local_nodes[static_cast<std::size_t>(local_quad[k])];
      }
      quads.push_back(quad);
    }
  };

  const std::size_t n = face.corners.size();
  std::vector<int> mids(n, -1);
  for (std::size_t i = 0; i < n; ++i) {
    const GraphEdge& edge = face.edges[i];
    mids[i] = edge.curve ? curve_mid_node(edge) : straight_mid_node(edge.a, edge.b);
  }
  // Center placement: start at corner average, then locally optimize the
  // worst scaled jacobian of the fan.
  Point2 c{0.0, 0.0};
  for (std::size_t i = 0; i < n; ++i) {
    const Point2 p = nodes[face.corners[i]].point;
    c.x += p.x;
    c.y += p.y;
  }
  c.x /= static_cast<double>(n);
  c.y /= static_cast<double>(n);

  const auto fan_quality = [&](Point2 candidate) {
    double worst = std::numeric_limits<double>::max();
    for (std::size_t i = 0; i < n; ++i) {
      const Point2 q0 = nodes[face.corners[i]].point;
      const Point2 q1 = nodes[mids[i]].point;
      const Point2 q3 = nodes[mids[(i + n - 1) % n]].point;
      worst = std::min(worst, quad_min_scaled_jacobian(q3, q0, q1, candidate));
    }
    return worst;
  };
  const auto fan_edge_ratio = [&](Point2 candidate) {
    double worst = std::numeric_limits<double>::max();
    for (std::size_t i = 0; i < n; ++i) {
      const Point2 points[4] = {
          nodes[mids[(i + n - 1) % n]].point,
          nodes[face.corners[i]].point,
          nodes[mids[i]].point,
          candidate,
      };
      double shortest = std::numeric_limits<double>::max();
      double longest = 0.0;
      for (int k = 0; k < 4; ++k) {
        const double edge = distance(points[k], points[(k + 1) % 4]);
        shortest = std::min(shortest, edge);
        longest = std::max(longest, edge);
      }
      worst = std::min(worst, longest > 0.0 ? shortest / longest : 0.0);
    }
    return worst;
  };
  double scale = 0.0;
  for (std::size_t i = 0; i < n; ++i) {
    scale = std::max(scale, distance(c, nodes[face.corners[i]].point));
  }
  double best_q = fan_quality(c);
  double step = scale * 0.25;
  for (int iter = 0; iter < 40 && step > scale * 1.0e-3; ++iter) {
    bool improved = false;
    for (const auto& [dx, dy] : std::initializer_list<std::pair<double, double>>{
             {1.0, 0.0}, {-1.0, 0.0}, {0.0, 1.0}, {0.0, -1.0}}) {
      const Point2 candidate{c.x + dx * step, c.y + dy * step};
      const double q = fan_quality(candidate);
      if (q > best_q) {
        best_q = q;
        c = candidate;
        improved = true;
      }
    }
    if (!improved) {
      step *= 0.5;
    }
  }

  // A 2:1 side junction can add a collinear corner to an otherwise convex cut
  // face. The ordinary midpoint fan then has a flat quad at that corner, while
  // the old ear fallback can turn the long residual triangle into very acute
  // quads. Once all shared edge midpoints are known, the expanded boundary is
  // even; use the same split-first, quality-checked template family as
  // generalized empty cells whenever the ordinary fan misses the production
  // threshold.
  // sin(20 degrees): the angle bound is slightly stricter than the separate
  // 0.3 scaled-Jacobian bound, so use it to decide whether the fan is eligible.
  constexpr double local_quality_fan_threshold = 0.3420201433256687;
  constexpr double local_quality_edge_ratio = 0.1;
  if (best_q < local_quality_fan_threshold || fan_edge_ratio(c) < local_quality_edge_ratio) {
    std::vector<int> expanded_nodes;
    std::vector<Point2> expanded_points;
    expanded_nodes.reserve(2 * n);
    expanded_points.reserve(2 * n);
    for (std::size_t i = 0; i < n; ++i) {
      expanded_nodes.push_back(face.corners[i]);
      expanded_nodes.push_back(mids[i]);
      expanded_points.push_back(nodes[face.corners[i]].point);
      expanded_points.push_back(nodes[mids[i]].point);
    }
    double polygon_scale = 0.0;
    for (std::size_t i = 0; i < expanded_points.size(); ++i) {
      polygon_scale =
          std::max(polygon_scale,
                   distance(expanded_points[i], expanded_points[(i + 1) % expanded_points.size()]));
    }
    const double convex_eps = std::max(1.0e-14, polygon_scale * polygon_scale * 1.0e-12);
    bool convex = true;
    for (std::size_t i = 0; i < expanded_points.size(); ++i) {
      const Point2 a = expanded_points[(i + expanded_points.size() - 1) % expanded_points.size()];
      const Point2 b = expanded_points[i];
      const Point2 d = expanded_points[(i + 1) % expanded_points.size()];
      if (cross(b - a, d - b) < -convex_eps) {
        convex = false;
        break;
      }
    }
    if (convex) {
      // A clipped boundary cell can be a quadrilateral with an extra collinear
      // 2:1 transition corner. Midpoint expansion then produces four strict
      // corners and dyadic nodes along their sides even though the face does
      // not contain all four corners of the source quadtree leaf. Recover the
      // macro quadrilateral from its strict turns and try the same certified
      // split tree as an empty cell. A single side junction has side-node
      // counts 1,1,1,3; bisecting through the other opposite midpoints leaves
      // two halves, each covered by one 3-quad template.
      std::vector<std::size_t> macro_corners;
      for (std::size_t i = 0; i < expanded_points.size(); ++i) {
        const Point2 previous =
            expanded_points[(i + expanded_points.size() - 1) % expanded_points.size()];
        const Point2 current = expanded_points[i];
        const Point2 next = expanded_points[(i + 1) % expanded_points.size()];
        if (cross(current - previous, next - current) > convex_eps) {
          macro_corners.push_back(i);
        }
      }
      if (macro_corners.size() == 4) {
        const std::size_t offset = macro_corners.front();
        std::vector<int> ordered_nodes;
        std::vector<Point2> ordered_points;
        ordered_nodes.reserve(expanded_nodes.size());
        ordered_points.reserve(expanded_points.size());
        for (std::size_t i = 0; i < expanded_nodes.size(); ++i) {
          const std::size_t at = (offset + i) % expanded_nodes.size();
          ordered_nodes.push_back(expanded_nodes[at]);
          ordered_points.push_back(expanded_points[at]);
        }
        std::array<std::size_t, 4> corner_positions{0, 0, 0, 0};
        std::array<Point2, 4> macro_corner_points;
        for (std::size_t corner = 0; corner < 4; ++corner) {
          corner_positions[corner] =
              (macro_corners[corner] + expanded_nodes.size() - offset) % expanded_nodes.size();
          macro_corner_points[corner] = ordered_points[corner_positions[corner]];
        }
        bool dyadic_sides = true;
        EmptyTemplateSideParameters side_parameters;
        for (int side = 0; side < 4; ++side) {
          const std::size_t begin = corner_positions[static_cast<std::size_t>(side)];
          const std::size_t end = side < 3
              ? corner_positions[static_cast<std::size_t>(side + 1)]
              : ordered_nodes.size();
          const std::size_t interior_count = end - begin - 1;
          if (interior_count != 0 && interior_count != 1 && interior_count != 3) {
            dyadic_sides = false;
            break;
          }
          for (std::size_t i = 0; i < interior_count; ++i) {
            side_parameters[static_cast<std::size_t>(side)].push_back(
                static_cast<double>(i + 1) / static_cast<double>(interior_count + 1));
          }
        }
        if (dyadic_sides) {
          const EmptyTemplatePlan cell_plan =
              choose_empty_template(macro_corner_points, ordered_points, side_parameters);
          if (cell_plan.kind == EmptyTemplateKind::RecursiveSplit
              && cell_plan.meets_quality_contract) {
            emit_template_plan(cell_plan, ordered_nodes);
            return;
          }
        }
      }

      const EmptyTemplatePlan plan = choose_polygon_template(expanded_points);
      if (plan.meets_quality_contract) {
        emit_template_plan(plan, expanded_nodes);
        return;
      }
    }
  }

  // A fan requires a point visible from every boundary edge. Exact polyline
  // joints can make an otherwise ordinary cut face non-convex, in which case
  // no fan center has a positive Jacobian. Partition only those faces into
  // ears and apply triangle midpoint subdivision; shared diagonal midpoints
  // come from the same edge registry, so adjacent triangles stay conforming.
  if (best_q <= 0.1) {
    std::map<std::pair<int, int>, const GraphEdge*> boundary_edges;
    for (const GraphEdge& edge : face.edges) {
      boundary_edges.emplace(std::minmax(edge.a, edge.b), &edge);
    }
    const auto midpoint = [&](int a, int b) {
      const auto it = boundary_edges.find(std::minmax(a, b));
      return it != boundary_edges.end() && it->second->curve
          ? curve_mid_node(*it->second)
          : straight_mid_node(a, b);
    };
    const auto point_in_or_on_triangle = [](Point2 p, Point2 a, Point2 b, Point2 c,
                                             double eps) {
      const double ab = cross(b - a, p - a);
      const double bc = cross(c - b, p - b);
      const double ca = cross(a - c, p - c);
      return ab >= -eps && bc >= -eps && ca >= -eps;
    };
    std::vector<int> remaining = face.corners;
    double area2 = 0.0;
    double face_scale = 0.0;
    for (std::size_t i = 0; i < remaining.size(); ++i) {
      const Point2 a = nodes[remaining[i]].point;
      const Point2 b = nodes[remaining[(i + 1) % remaining.size()]].point;
      area2 += cross({a.x, a.y}, {b.x, b.y});
      face_scale = std::max(face_scale, distance(a, b));
    }
    if (area2 < 0.0) {
      std::reverse(remaining.begin(), remaining.end());
    }
    const double ear_eps = std::max(1.0e-14, face_scale * face_scale * 1.0e-12);
    std::vector<std::array<int, 3>> triangles;
    bool clipped = remaining.size() >= 3;
    int guard = 0;
    while (clipped && remaining.size() > 3 && guard++ < 4 * static_cast<int>(face.corners.size())) {
      clipped = false;
      for (std::size_t i = 0; i < remaining.size(); ++i) {
        const std::size_t prev = (i + remaining.size() - 1) % remaining.size();
        const std::size_t next = (i + 1) % remaining.size();
        const Point2 a = nodes[remaining[prev]].point;
        const Point2 b = nodes[remaining[i]].point;
        const Point2 d = nodes[remaining[next]].point;
        if (cross(b - a, d - a) <= ear_eps) {
          continue;
        }
        bool contains_vertex = false;
        for (std::size_t j = 0; j < remaining.size(); ++j) {
          if (j == prev || j == i || j == next) {
            continue;
          }
          if (point_in_or_on_triangle(nodes[remaining[j]].point, a, b, d, ear_eps)) {
            contains_vertex = true;
            break;
          }
        }
        if (contains_vertex) {
          continue;
        }
        triangles.push_back({remaining[prev], remaining[i], remaining[next]});
        remaining.erase(remaining.begin() + static_cast<std::ptrdiff_t>(i));
        clipped = true;
        break;
      }
    }
    if (clipped && remaining.size() == 3) {
      triangles.push_back({remaining[0], remaining[1], remaining[2]});
      for (const std::array<int, 3>& triangle : triangles) {
        const int a = triangle[0];
        const int b = triangle[1];
        const int d = triangle[2];
        const int ab = midpoint(a, b);
        const int bd = midpoint(b, d);
        const int da = midpoint(d, a);
        const Point2 pa = nodes[a].point;
        const Point2 pb = nodes[b].point;
        const Point2 pd = nodes[d].point;
        const int center = add_node({(pa.x + pb.x + pd.x) / 3.0,
                                     (pa.y + pb.y + pd.y) / 3.0}, false);
        quads.push_back({a, ab, center, da});
        quads.push_back({b, bd, center, ab});
        quads.push_back({d, da, center, bd});
      }
      return;
    }
  }
  const int center = add_node(c, false);
  for (std::size_t i = 0; i < n; ++i) {
    quads.push_back({face.corners[i], mids[i], center, mids[(i + n - 1) % n]});
  }
}

} // namespace quadmesh::detail
