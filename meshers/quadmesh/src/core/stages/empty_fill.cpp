#include "stages/empty_fill.hpp"

#include "detail/empty_templates.hpp"
#include "stages/face_mesh.hpp"

#include "quadmesh/geometry.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdint>
#include <deque>
#include <functional>
#include <limits>
#include <queue>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace quadmesh::detail {
namespace {

// Marked corner of a side under per-level checkerboard marking.
int marked_corner_of_side(const Cell& cell, int side)
{
  const int ca = side_corner_a(side);
  const int cb = side_corner_b(side);
  const auto corner_sum = [&](int corner) {
    const std::uint32_t cx = cell.ix + ((corner == 1 || corner == 2) ? 1u : 0u);
    const std::uint32_t cy = cell.iy + (corner >= 2 ? 1u : 0u);
    return (cx + cy) % 2u;
  };
  return corner_sum(ca) == 0u ? ca : cb;
}

// The side paired with `side` for template application: the other side
// incident to the marked corner.
int paired_side(int side, int marked_corner)
{
  return marked_corner == side ? (side + 3) % 4 : (side + 1) % 4;
}

bool is_marked_pair(const Cell& cell, const bool split[4])
{
  for (int side = 0; side < 4; ++side) {
    if (!split[side]) {
      continue;
    }
    const int marked = marked_corner_of_side(cell, side);
    const int pair = paired_side(side, marked);
    if (split[pair]) {
      // Exactly these two and they share the marked corner.
      int count = 0;
      for (int k = 0; k < 4; ++k) {
        count += split[k] ? 1 : 0;
      }
      return count == 2;
    }
    return false;
  }
  return false;
}

} // namespace

void classify_empty_components(const Lattice& lat, BoundaryTopology& topo)
{
  const Tree& tree = lat.tree;
  const GeomIndex& geom = lat.geom;
  auto& leaf_class = topo.leaf_class;

  std::vector<std::int32_t> empties;
  tree.for_each_leaf([&](std::int32_t i) {
    if (leaf_class[i] == LeafClass::Unset) {
      empties.push_back(i);
    }
  });
  std::unordered_map<std::int32_t, int> component;
  int component_count = 0;
  for (const std::int32_t seed : empties) {
    if (component.count(seed) > 0) {
      continue;
    }
    const int id = component_count++;
    std::deque<std::int32_t> queue{seed};
    component[seed] = id;
    std::vector<std::int32_t> members;
    while (!queue.empty()) {
      const std::int32_t i = queue.front();
      queue.pop_front();
      members.push_back(i);
      for (const auto& [dx, dy] :
           std::initializer_list<std::pair<int, int>>{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}) {
        for (const std::int32_t neighbor : tree.neighbors_in_direction(i, dx, dy)) {
          if (leaf_class[neighbor] != LeafClass::Unset || component.count(neighbor) > 0) {
            continue;
          }
          component[neighbor] = id;
          queue.push_back(neighbor);
        }
      }
    }
    // One parity test for the whole component.
    const Aabb2 box = tree.box(tree.cells[members.front()]);
    const bool inside = geom.inside(center(box));
    for (const std::int32_t member : members) {
      leaf_class[member] = inside ? LeafClass::EmptyInside : LeafClass::EmptyOutside;
    }
  }
}

void mesh_empty_squares(const Lattice& lat, const GeometryModel& gm, const MeshingConfig& config,
                        BoundaryTopology& topo,
                        MeshBuilder& mb, MesherDebug* debug)
{
  const Tree& tree = lat.tree;
  const auto& leaf_class = topo.leaf_class;
  const auto& side_crossings = topo.side_crossings;
  auto& side_splits = topo.side_splits;
  const auto& side_bend = topo.side_bend;
  auto& nodes = mb.nodes;
  auto& quads = mb.quads;
  const auto side_key = [&](const Cell& cell, int side) { return tree.side_key(cell, side); };
  const auto gp_node_id = [&](std::uint32_t gx, std::uint32_t gy) { return mb.gp_node_id(gx, gy); };
  const auto existing_mid_node = [&](int a, int b) { return mb.existing_mid_node(a, b); };
  const auto straight_mid_node = [&](int a, int b) { return mb.straight_mid_node(a, b); };
  const auto add_node = [&](Point2 p, bool on_boundary) { return mb.add_node(p, on_boundary); };
  const auto warn = [&](std::string message) {
    if (debug != nullptr) {
      debug->warnings.push_back(std::move(message));
    }
  };
  if (debug != nullptr) {
    debug->parity_defect_count = 0;
    debug->parity_path_split_count = 0;
    debug->parity_path_total_length = 0.0;
  }
  const auto register_side_split = [&](const SideSpan& span, double t_on_side, int node) {
    auto& splits = side_splits[Tree::side_span_key(span)];
    const bool known = std::any_of(splits.begin(), splits.end(), [&](const SideSplit& split) {
      return split.node == node;
    });
    if (known) {
      return false;
    }
    splits.push_back({t_on_side, node});
    std::sort(splits.begin(), splits.end(),
              [](const SideSplit& a, const SideSplit& b) { return a.t_on_side < b.t_on_side; });
    return true;
  };

  // Cut faces are emitted after this stage. Seed the side midpoints they will
  // need now so empty templates close against the same topology rather than
  // discovering a split only after the cut face has been fixed in the mesh.
  const auto preregister_cut_side_mids = [&] {
    static const int dirs[4][2] = {{0, -1}, {1, 0}, {0, 1}, {-1, 0}};
    bool created = false;
    tree.for_each_leaf([&](std::int32_t leaf) {
      const LeafClass cls = leaf_class.at(leaf);
      if (cls != LeafClass::Cut && cls != LeafClass::Vertex) {
        return;
      }
      const Cell& cell = tree.cells[leaf];
      for (int side = 0; side < 4; ++side) {
        if (side_bend.count(side_key(cell, side)) > 0) {
          continue;
        }
        for (const SideSpan& span : tree.side_spans(leaf, side)) {
          const auto span_key = Tree::side_span_key(span);
          bool faces_inside = false;
          for (const std::int32_t neighbor :
               tree.neighbors_in_direction(leaf, dirs[side][0], dirs[side][1])) {
            if (leaf_class.at(neighbor) != LeafClass::EmptyInside) {
              continue;
            }
            for (const SideSpan& neighbor_span : tree.side_spans(neighbor, (side + 2) % 4)) {
              if (Tree::side_span_key(neighbor_span) == span_key) {
                faces_inside = true;
                break;
              }
            }
            if (faces_inside) {
              break;
            }
          }
          if (!faces_inside) {
            continue;
          }
          const auto crossings = side_crossings.find(Tree::side_span_key(span));
          if (crossings != side_crossings.end() && !crossings->second.empty()) {
            continue;
          }
          const int a = gp_node_id(span.ax, span.ay);
          const int b = gp_node_id(span.bx, span.by);
          if (existing_mid_node(a, b) < 0) {
            straight_mid_node(a, b);
            created = true;
          }
        }
      }
    });
    return created;
  };

  (void)preregister_cut_side_mids();

  // Pulled-midpoint (bent) empty squares are meshed as polygons.
  const auto has_bend = [&](std::int32_t leaf) {
    const Cell& cell = tree.cells[leaf];
    for (int side = 0; side < 4; ++side) {
      if (side_bend.count(side_key(cell, side)) > 0) {
        return true;
      }
    }
    return false;
  };

  // Split node on an empty square's side: an existing transition grid point,
  // or a registered edge midpoint. Returns -1 when unsplit.
  const auto side_split_node = [&](std::int32_t leaf, int side, bool& is_transition) {
    const Cell& cell = tree.cells[leaf];
    is_transition = false;
    static const int dirs[4][2] = {{0, -1}, {1, 0}, {0, 1}, {-1, 0}};
    const auto neighbor_leaves = tree.neighbors_in_direction(leaf, dirs[side][0], dirs[side][1]);
    for (const std::int32_t n : neighbor_leaves) {
      if (tree.cells[n].level > cell.level) {
        is_transition = true;
        // Transition node: grid point at the side middle.
        const auto [ax, ay] = tree.corner_gp(cell, side_corner_a(side));
        const auto [bx, by] = tree.corner_gp(cell, side_corner_b(side));
        return gp_node_id((ax + bx) / 2, (ay + by) / 2);
      }
    }
    for (const SideSpan& span : tree.side_spans(leaf, side)) {
      const auto it = side_splits.find(Tree::side_span_key(span));
      if (it != side_splits.end() && !it->second.empty()) {
        return it->second.front().node;
      }
    }
    const auto [ax, ay] = tree.corner_gp(cell, side_corner_a(side));
    const auto [bx, by] = tree.corner_gp(cell, side_corner_b(side));
    const int corner_a = gp_node_id(ax, ay);
    const int corner_b = gp_node_id(bx, by);
    return existing_mid_node(corner_a, corner_b);
  };

  const auto has_registered_side_split = [&](std::int32_t leaf) {
    for (int side = 0; side < 4; ++side) {
      for (const SideSpan& span : tree.side_spans(leaf, side)) {
        const auto it = side_splits.find(Tree::side_span_key(span));
        if (it != side_splits.end() && !it->second.empty()) {
          return true;
        }
      }
    }
    return false;
  };

  struct TemplateBoundary {
    std::vector<int> nodes;
    EmptyTemplateSideParameters side_parameters;
  };
  const auto template_boundary_nodes = [&](std::int32_t leaf) {
    TemplateBoundary boundary;
    for (int side = 0; side < 4; ++side) {
      const std::vector<SideSpan> spans = tree.side_spans(leaf, side);
      boundary.nodes.push_back(gp_node_id(spans.front().ax, spans.front().ay));
      for (std::size_t i = 0; i < spans.size(); ++i) {
        const SideSpan& span = spans[i];
        if (i > 0) {
          const int node = gp_node_id(span.ax, span.ay);
          if (boundary.nodes.back() != node) {
            boundary.nodes.push_back(node);
            boundary.side_parameters[static_cast<std::size_t>(side)].push_back(
                static_cast<double>(i) / static_cast<double>(spans.size()));
          }
        }
        std::vector<SideSplit> additions;
        const auto it = side_splits.find(Tree::side_span_key(span));
        if (it != side_splits.end()) {
          additions.insert(additions.end(), it->second.begin(), it->second.end());
        }
        const int midpoint = existing_mid_node(gp_node_id(span.ax, span.ay),
                                               gp_node_id(span.bx, span.by));
        if (midpoint >= 0
            && std::none_of(additions.begin(), additions.end(),
                            [&](const SideSplit& split) { return split.node == midpoint; })) {
          additions.push_back({0.5, midpoint});
        }
        if (additions.empty()) {
          continue;
        }
        const bool forward = gp_key(span.ax, span.ay) < gp_key(span.bx, span.by);
        std::sort(additions.begin(), additions.end(), [&](const SideSplit& a, const SideSplit& b) {
          const double ta = forward ? a.t_on_side : 1.0 - a.t_on_side;
          const double tb = forward ? b.t_on_side : 1.0 - b.t_on_side;
          return ta < tb;
        });
        for (const SideSplit& split : additions) {
          if (boundary.nodes.back() == split.node) {
            continue;
          }
          const double local_t = forward ? split.t_on_side : 1.0 - split.t_on_side;
          const double side_t = (static_cast<double>(i) + local_t)
              / static_cast<double>(spans.size());
          boundary.nodes.push_back(split.node);
          boundary.side_parameters[static_cast<std::size_t>(side)].push_back(side_t);
        }
      }
    }
    return boundary;
  };

  const auto emit_general_template = [&](std::int32_t leaf) {
    const TemplateBoundary boundary = template_boundary_nodes(leaf);
    if (boundary.nodes.size() < 4 || boundary.nodes.size() % 2 != 0) {
      warn("empty-square closure produced an odd boundary");
      return;
    }
    std::vector<Point2> boundary_points;
    boundary_points.reserve(boundary.nodes.size());
    for (const int node : boundary.nodes) {
      boundary_points.push_back(nodes[node].point);
    }
    std::array<Point2, 4> corners;
    const Cell& cell = tree.cells[leaf];
    for (int corner = 0; corner < 4; ++corner) {
      const auto [gx, gy] = tree.corner_gp(cell, corner);
      corners[corner] = nodes[gp_node_id(gx, gy)].point;
    }
    const EmptyTemplatePlan plan =
        choose_empty_template(corners, boundary_points, boundary.side_parameters);
    if (!plan.meets_quality_contract) {
      warn("empty-square template missed quality contract: angle="
           + std::to_string(plan.quality.min_angle_deg)
           + " scaled-jacobian=" + std::to_string(plan.quality.min_scaled_jacobian)
           + " edge-ratio=" + std::to_string(plan.quality.min_edge_ratio));
    }
    std::vector<int> local_nodes = boundary.nodes;
    local_nodes.reserve(boundary.nodes.size() + plan.interior.size());
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

  const auto emit_template = [&](std::int32_t leaf) {
    if (has_registered_side_split(leaf)) {
      emit_general_template(leaf);
      return;
    }
    const Cell& cell = tree.cells[leaf];
    int corner_nodes[4];
    for (int corner = 0; corner < 4; ++corner) {
      const auto [gx, gy] = tree.corner_gp(cell, corner);
      corner_nodes[corner] = gp_node_id(gx, gy);
    }
    int side_nodes[4];
    bool transition[4];
    int count = 0;
    for (int side = 0; side < 4; ++side) {
      side_nodes[side] = side_split_node(leaf, side, transition[side]);
      if (side_nodes[side] >= 0) {
        ++count;
      }
    }
    if (count == 0) {
      quads.push_back({corner_nodes[0], corner_nodes[1], corner_nodes[2], corner_nodes[3]});
      return;
    }
    const Point2 p0 = nodes[corner_nodes[0]].point;
    const Point2 p1 = nodes[corner_nodes[1]].point;
    const Point2 p2 = nodes[corner_nodes[2]].point;
    const Point2 p3 = nodes[corner_nodes[3]].point;
    const Point2 center_point{(p0.x + p1.x + p2.x + p3.x) / 4.0,
                              (p0.y + p1.y + p2.y + p3.y) / 4.0};
    if (count == 2) {
      // 3-quad template around the marked corner.
      int marked = -1;
      for (int side = 0; side < 4; ++side) {
        if (side_nodes[side] >= 0 && side_nodes[(side + 1) % 4] >= 0) {
          marked = (side + 1) % 4; // corner between side and side+1
          break;
        }
      }
      if (marked >= 0) {
        const int j = marked;
        const int c_j = corner_nodes[j];
        const int c_next = corner_nodes[(j + 1) % 4];
        const int c_opp = corner_nodes[(j + 2) % 4];
        const int c_prev = corner_nodes[(j + 3) % 4];
        const int n_a = side_nodes[j];           // side from corner j to c_next
        const int n_b = side_nodes[(j + 3) % 4]; // side from c_prev to corner j
        const int p = add_node(center_point, false);
        quads.push_back({c_opp, c_next, n_a, p});
        quads.push_back({n_a, c_j, n_b, p});
        quads.push_back({c_opp, p, n_b, c_prev});
        return;
      }
      // Two opposite splits should have been escalated; fall through.
      warn("unexpected split pattern at template emission");
    }
    // 4-quad template: all sides must be split.
    int full_sides[4];
    for (int side = 0; side < 4; ++side) {
      full_sides[side] = side_nodes[side];
      if (full_sides[side] < 0) {
        warn("missing side split at 4-quad emission; creating");
        full_sides[side] =
            straight_mid_node(corner_nodes[side_corner_a(side)], corner_nodes[side_corner_b(side)]);
      }
    }
    const int center_node = add_node(center_point, false);
    for (int corner = 0; corner < 4; ++corner) {
      quads.push_back({corner_nodes[corner], full_sides[corner], center_node,
                       full_sides[(corner + 3) % 4]});
    }
  };

  std::vector<std::int32_t> template_leaves;
  std::vector<std::int32_t> bent_leaves;
  tree.for_each_leaf([&](std::int32_t i) {
    if (leaf_class.at(i) != LeafClass::EmptyInside) {
      return;
    }
    (has_bend(i) ? bent_leaves : template_leaves).push_back(i);
  });

  // Bent squares: polygon path -> midpoint subdivision (single face).
  for (const std::int32_t leaf : bent_leaves) {
    const std::vector<PathEntry> path = build_path(lat, topo, mb, leaf);
    const std::vector<Face> faces = build_faces(lat, gm, topo, mb, config, debug, leaf, path);
    for (const Face& face : faces) {
      subdivide_face(mb, face);
    }
  }

  // Template fixpoint.
  std::deque<std::int32_t> queue(template_leaves.begin(), template_leaves.end());
  std::unordered_set<std::int32_t> queued(template_leaves.begin(), template_leaves.end());
  std::unordered_set<std::int32_t> template_set(template_leaves.begin(), template_leaves.end());
  static const int dirs[4][2] = {{0, -1}, {1, 0}, {0, 1}, {-1, 0}};
  const auto enqueue_template = [&](std::int32_t leaf) {
    if (template_set.count(leaf) > 0 && queued.insert(leaf).second) {
      queue.push_back(leaf);
    }
  };
  // A fine template's side midpoint is a quarter-point on a coarser
  // neighbor. Keep that node on the shared atomic span instead of splitting
  // the tree after classification; late tree splits can violate strong
  // balance next to cut and vertex leaves.
  const auto propagate_split = [&](std::int32_t leaf, int side, int node) {
    const Cell& cell = tree.cells[leaf];
    for (const std::int32_t neighbor :
         tree.neighbors_in_direction(leaf, dirs[side][0], dirs[side][1])) {
      enqueue_template(neighbor);
      if (tree.cells[neighbor].level >= cell.level) {
        continue;
      }
      if (leaf_class.at(neighbor) == LeafClass::EmptyInside && template_set.count(neighbor) > 0) {
        const std::vector<SideSpan> spans = tree.side_spans(leaf, side);
        if (spans.size() != 1 || spans.front().subside) {
          warn("template split did not map to one atomic side span");
          continue;
        }
        if (register_side_split(spans.front(), 0.5, node)) {
          enqueue_template(neighbor);
        }
      } else if (leaf_class.at(neighbor) != LeafClass::Cut
                 && leaf_class.at(neighbor) != LeafClass::Vertex
                 && leaf_class.at(neighbor) != LeafClass::EmptyOutside) {
        warn("template split propagated across a level transition");
      }
    }
  };
  // Guard the template-split fixpoint against pathological non-convergence.
  // (`<<` binds tighter than `<`, so this is `guard++ < (1 << 22)`.) The limit
  // is far above any real input; if it ever trips, warn rather than silently
  // leaving empty squares unmeshed (and the mesh non-conforming).
  int guard = 0;
  while (!queue.empty() && guard++ < (1 << 22)) {
    const std::int32_t leaf = queue.front();
    queue.pop_front();
    queued.erase(leaf);
    if (!tree.cells[leaf].leaf() || template_set.count(leaf) == 0) {
      continue;
    }
    const Cell& cell = tree.cells[leaf];

    if (has_registered_side_split(leaf)) {
      continue;
    }

    bool split[4];
    bool transition[4];
    int count = 0;
    for (int side = 0; side < 4; ++side) {
      split[side] = side_split_node(leaf, side, transition[side]) >= 0;
      if (split[side]) {
        ++count;
      }
    }
    if (count == 0) {
      continue;
    }
    // Closure: each split side demands its marked pair; a set that is not
    // exactly a marked-adjacent pair demands all four.
    bool required[4] = {split[0], split[1], split[2], split[3]};
    bool stable = false;
    while (!stable) {
      stable = true;
      for (int side = 0; side < 4; ++side) {
        if (!required[side]) {
          continue;
        }
        const int pair = paired_side(side, marked_corner_of_side(cell, side));
        if (!required[pair]) {
          required[pair] = true;
          stable = false;
        }
      }
      int required_count = 0;
      for (const bool r : required) {
        required_count += r ? 1 : 0;
      }
      if (required_count > 2
          || (required_count == 2 && !is_marked_pair(cell, required))) {
        for (bool& r : required) {
          r = true;
        }
      }
    }
    // Create missing splits and wake neighbors.
    for (int side = 0; side < 4; ++side) {
      if (!required[side] || split[side]) {
        continue;
      }
      const auto [ax, ay] = tree.corner_gp(cell, side_corner_a(side));
      const auto [bx, by] = tree.corner_gp(cell, side_corner_b(side));
      const int node = straight_mid_node(gp_node_id(ax, ay), gp_node_id(bx, by));
      propagate_split(leaf, side, node);
    }
  }
  if (!queue.empty()) {
    warn("empty-square template fixpoint did not converge; some squares may be unmeshed");
  }

  // Generalized cells with odd boundary cardinality are parity defects. Adding
  // a midpoint to a shared, currently-unsplit atomic span toggles the parity of
  // exactly its two incident template cells. Resolve all defects together as a
  // global T-join on the empty-cell dual graph instead of walking each defect
  // greedily toward the first available side. The bounded case uses an exact
  // metric-closure matching; unusually large terminal sets use a deterministic
  // globally ranked matching followed by endpoint-swap improvement.
  struct ParityEdge {
    int a = -1;
    int b = -1;
    SideSpan span;
    double length = 0.0;
  };
  std::unordered_map<std::int32_t, int> graph_index;
  graph_index.reserve(template_leaves.size());
  for (int i = 0; i < static_cast<int>(template_leaves.size()); ++i) {
    graph_index.emplace(template_leaves[static_cast<std::size_t>(i)], i);
  }
  std::vector<ParityEdge> parity_edges;
  std::vector<std::vector<std::pair<int, int>>> adjacency(template_leaves.size());
  std::unordered_set<std::uint64_t> known_adjacencies;
  for (int from = 0; from < static_cast<int>(template_leaves.size()); ++from) {
    const std::int32_t leaf = template_leaves[static_cast<std::size_t>(from)];
    for (int side = 0; side < 4; ++side) {
      for (const SideSpan& span : tree.side_spans(leaf, side)) {
        const auto span_key = Tree::side_span_key(span);
        const auto split_it = side_splits.find(span_key);
        const int span_a = gp_node_id(span.ax, span.ay);
        const int span_b = gp_node_id(span.bx, span.by);
        if (existing_mid_node(span_a, span_b) >= 0
            || (split_it != side_splits.end() && !split_it->second.empty())) {
          continue;
        }
        for (const std::int32_t neighbor :
             tree.neighbors_in_direction(leaf, dirs[side][0], dirs[side][1])) {
          const auto graph_neighbor = graph_index.find(neighbor);
          if (graph_neighbor == graph_index.end()) {
            continue;
          }
          bool shares_span = false;
          for (const SideSpan& neighbor_span : tree.side_spans(neighbor, (side + 2) % 4)) {
            if (Tree::side_span_key(neighbor_span) == span_key) {
              shares_span = true;
              break;
            }
          }
          if (!shares_span) {
            continue;
          }
          const int to = graph_neighbor->second;
          const std::uint32_t lo = static_cast<std::uint32_t>(std::min(from, to));
          const std::uint32_t hi = static_cast<std::uint32_t>(std::max(from, to));
          const std::uint64_t pair_key = (static_cast<std::uint64_t>(hi) << 32) | lo;
          if (!known_adjacencies.insert(pair_key).second) {
            continue;
          }
          const int edge = static_cast<int>(parity_edges.size());
          parity_edges.push_back(
              {from, to, span, distance(nodes[span_a].point, nodes[span_b].point)});
          adjacency[static_cast<std::size_t>(from)].push_back({to, edge});
          adjacency[static_cast<std::size_t>(to)].push_back({from, edge});
        }
      }
    }
  }

  std::vector<bool> defect(template_leaves.size(), false);
  for (int i = 0; i < static_cast<int>(template_leaves.size()); ++i) {
    defect[static_cast<std::size_t>(i)] =
        template_boundary_nodes(template_leaves[static_cast<std::size_t>(i)]).nodes.size() % 2 != 0;
  }
  if (debug != nullptr) {
    debug->parity_defect_count =
        static_cast<std::size_t>(std::count(defect.begin(), defect.end(), true));
  }
  std::vector<bool> selected_edge(parity_edges.size(), false);
  std::vector<bool> component_seen(template_leaves.size(), false);
  const double graph_size = static_cast<double>(template_leaves.size());
  // Larger than the maximum summed normalized length of any complete
  // matching, making the objective lexicographic: span count, then length.
  const double hop_weight = graph_size * graph_size + 1.0;
  const auto shortest_paths = [&](int source, std::vector<double>& distances,
                                  std::vector<int>* previous_edge) {
    distances.assign(template_leaves.size(), std::numeric_limits<double>::max());
    if (previous_edge != nullptr) {
      previous_edge->assign(template_leaves.size(), -1);
    }
    using QueueEntry = std::pair<double, int>;
    std::priority_queue<QueueEntry, std::vector<QueueEntry>, std::greater<QueueEntry>> pending;
    distances[static_cast<std::size_t>(source)] = 0.0;
    pending.push({0.0, source});
    while (!pending.empty()) {
      const auto [distance_so_far, at] = pending.top();
      pending.pop();
      if (distance_so_far != distances[static_cast<std::size_t>(at)]) {
        continue;
      }
      for (const auto [next, edge] : adjacency[static_cast<std::size_t>(at)]) {
        const double cost =
            hop_weight + parity_edges[static_cast<std::size_t>(edge)].length / tree.root_size;
        const double candidate = distance_so_far + cost;
        if (candidate >= distances[static_cast<std::size_t>(next)]) {
          continue;
        }
        distances[static_cast<std::size_t>(next)] = candidate;
        if (previous_edge != nullptr) {
          (*previous_edge)[static_cast<std::size_t>(next)] = edge;
        }
        pending.push({candidate, next});
      }
    }
  };

  for (int seed = 0; seed < static_cast<int>(template_leaves.size()); ++seed) {
    if (component_seen[static_cast<std::size_t>(seed)]) {
      continue;
    }
    std::vector<int> component;
    std::deque<int> pending{seed};
    component_seen[static_cast<std::size_t>(seed)] = true;
    while (!pending.empty()) {
      const int at = pending.front();
      pending.pop_front();
      component.push_back(at);
      for (const auto [next, edge] : adjacency[static_cast<std::size_t>(at)]) {
        (void)edge;
        if (!component_seen[static_cast<std::size_t>(next)]) {
          component_seen[static_cast<std::size_t>(next)] = true;
          pending.push_back(next);
        }
      }
    }
    std::vector<int> terminals;
    for (const int cell : component) {
      if (defect[static_cast<std::size_t>(cell)]) {
        terminals.push_back(cell);
      }
    }
    if (terminals.empty()) {
      continue;
    }
    if (terminals.size() % 2 != 0) {
      warn("empty-square parity component has an odd number of defects");
      continue;
    }

    const int terminal_count = static_cast<int>(terminals.size());
    std::vector<std::vector<double>> terminal_distance(terminals.size(),
                                                       std::vector<double>(terminals.size(), 0.0));
    for (int i = 0; i < terminal_count; ++i) {
      std::vector<double> distances;
      shortest_paths(terminals[static_cast<std::size_t>(i)], distances, nullptr);
      for (int j = i + 1; j < terminal_count; ++j) {
        terminal_distance[static_cast<std::size_t>(i)][static_cast<std::size_t>(j)] =
            terminal_distance[static_cast<std::size_t>(j)][static_cast<std::size_t>(i)] =
                distances[static_cast<std::size_t>(terminals[static_cast<std::size_t>(j)])];
      }
    }

    std::vector<std::pair<int, int>> pairs;
    if (terminal_count <= 20) {
      const std::size_t states = std::size_t{1} << terminal_count;
      std::vector<double> memo(states, -1.0);
      std::vector<int> choice(states, -1);
      std::function<double(std::size_t)> solve = [&](std::size_t mask) {
        if (mask == 0) {
          return 0.0;
        }
        if (memo[mask] >= 0.0) {
          return memo[mask];
        }
        const int first = std::countr_zero(mask);
        const std::size_t without_first = mask & ~(std::size_t{1} << first);
        double best = std::numeric_limits<double>::max();
        int best_pair = -1;
        for (int other = first + 1; other < terminal_count; ++other) {
          if ((without_first & (std::size_t{1} << other)) == 0) {
            continue;
          }
          const double candidate =
              terminal_distance[static_cast<std::size_t>(first)][static_cast<std::size_t>(other)]
              + solve(without_first & ~(std::size_t{1} << other));
          if (candidate < best) {
            best = candidate;
            best_pair = other;
          }
        }
        choice[mask] = best_pair;
        memo[mask] = best;
        return best;
      };
      std::size_t mask = states - 1;
      (void)solve(mask);
      while (mask != 0) {
        const int first = std::countr_zero(mask);
        const int other = choice[mask];
        pairs.push_back({first, other});
        mask &= ~(std::size_t{1} << first);
        mask &= ~(std::size_t{1} << other);
      }
    } else {
      // Large terminal sets are rare. Start from the globally shortest
      // available pair, then improve the matching by pairwise endpoint swaps.
      std::vector<bool> unmatched(terminals.size(), true);
      for (int remaining = terminal_count; remaining > 0; remaining -= 2) {
        double best = std::numeric_limits<double>::max();
        int a = -1;
        int b = -1;
        for (int i = 0; i < terminal_count; ++i) {
          if (!unmatched[static_cast<std::size_t>(i)]) {
            continue;
          }
          for (int j = i + 1; j < terminal_count; ++j) {
            if (unmatched[static_cast<std::size_t>(j)]
                && terminal_distance[static_cast<std::size_t>(i)][static_cast<std::size_t>(j)]
                       < best) {
              best = terminal_distance[static_cast<std::size_t>(i)][static_cast<std::size_t>(j)];
              a = i;
              b = j;
            }
          }
        }
        unmatched[static_cast<std::size_t>(a)] = false;
        unmatched[static_cast<std::size_t>(b)] = false;
        pairs.push_back({a, b});
      }
      bool improved = true;
      while (improved) {
        improved = false;
        for (std::size_t i = 0; i < pairs.size() && !improved; ++i) {
          for (std::size_t j = i + 1; j < pairs.size(); ++j) {
            const auto [a, b] = pairs[i];
            const auto [c, d] = pairs[j];
            const double current = terminal_distance[a][b] + terminal_distance[c][d];
            const double crossed = terminal_distance[a][c] + terminal_distance[b][d];
            const double parallel = terminal_distance[a][d] + terminal_distance[b][c];
            if (crossed + 1.0e-12 < current) {
              pairs[i] = {a, c};
              pairs[j] = {b, d};
              improved = true;
              break;
            }
            if (parallel + 1.0e-12 < current) {
              pairs[i] = {a, d};
              pairs[j] = {b, c};
              improved = true;
              break;
            }
          }
        }
      }
    }

    for (const auto [terminal_a, terminal_b] : pairs) {
      const int source = terminals[static_cast<std::size_t>(terminal_a)];
      int at = terminals[static_cast<std::size_t>(terminal_b)];
      std::vector<double> distances;
      std::vector<int> previous_edge;
      shortest_paths(source, distances, &previous_edge);
      while (at != source) {
        const int edge = previous_edge[static_cast<std::size_t>(at)];
        if (edge < 0) {
          warn("empty-square parity defects are disconnected");
          break;
        }
        selected_edge[static_cast<std::size_t>(edge)] =
            !selected_edge[static_cast<std::size_t>(edge)];
        const ParityEdge& connection = parity_edges[static_cast<std::size_t>(edge)];
        at = connection.a == at ? connection.b : connection.a;
      }
    }
  }

  for (std::size_t edge = 0; edge < parity_edges.size(); ++edge) {
    if (!selected_edge[edge]) {
      continue;
    }
    const SideSpan& span = parity_edges[edge].span;
    const int a = gp_node_id(span.ax, span.ay);
    const int b = gp_node_id(span.bx, span.by);
    const int node = straight_mid_node(a, b);
    register_side_split(span, 0.5, node);
    if (debug != nullptr) {
      ++debug->parity_path_split_count;
      debug->parity_path_total_length += parity_edges[edge].length;
    }
  }
  for (const std::int32_t leaf : template_leaves) {
    if (template_boundary_nodes(leaf).nodes.size() % 2 != 0) {
      warn("global empty-square parity pairing left an odd boundary");
    }
  }

  // Emission (template_leaves order keeps node numbering deterministic).
  for (const std::int32_t leaf : template_leaves) {
    emit_template(leaf);
  }
}

} // namespace quadmesh::detail
