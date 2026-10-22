#include "stages/classify.hpp"

#include "quadmesh/geometry.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <vector>

namespace quadmesh::detail {

void compute_side_crossings(const Lattice& lat, const GeometryModel& gm, BoundaryTopology& topo,
                            MeshBuilder& mb, const MeshingConfig& config)
{
  const Tree& tree = lat.tree;
  const GeomIndex& geom = lat.geom;
  const auto& chains = gm.chains;
  const auto& features = gm.features;
  auto& side_crossings = topo.side_crossings;
  const auto gp_pos = [&](std::uint32_t gx, std::uint32_t gy) { return mb.gp_pos(gx, gy); };
  const auto add_node = [&](Point2 p, bool on_boundary) { return mb.add_node(p, on_boundary); };
  const auto eps = [&] { return lat.eps(config); };

  const auto register_span = [&](const SideSpan& span, double span_size) {
    const auto key = Tree::side_span_key(span);
    if (side_crossings.count(key) > 0) {
      return;
    }
    auto& list = side_crossings[key];
    auto [ax, ay] = std::pair{span.ax, span.ay};
    auto [bx, by] = std::pair{span.bx, span.by};
    // Canonical orientation (min gp key -> max gp key) so t_on_side means
    // the same thing for both adjacent squares.
    if (gp_key(ax, ay) > gp_key(bx, by)) {
      std::swap(ax, bx);
      std::swap(ay, by);
    }
    const Point2 pa = gp_pos(ax, ay);
    const Point2 pb = gp_pos(bx, by);
    const Segment2 side_seg{pa, pb};
    Aabb2 side_box{{std::min(pa.x, pb.x), std::min(pa.y, pb.y)},
                   {std::max(pa.x, pb.x), std::max(pa.y, pb.y)}};
    geom.for_each_near(side_box, [&](int si) {
      const auto hit = intersect_segments(side_seg, geom.segments[si], eps());
      if (!hit.has_value()) {
        return;
      }
      Crossing crossing;
      crossing.point = hit->point;
      crossing.chain = geom.refs[si].chain;
      crossing.seg = geom.refs[si].index;
      crossing.t_on_seg = hit->t_second;
      crossing.t_on_side = hit->t_first;
      list.push_back(crossing);
    });
    std::sort(list.begin(), list.end(),
              [](const Crossing& a, const Crossing& b) { return a.t_on_side < b.t_on_side; });
    // Merge duplicates where a polyline joint lies exactly on the side.
    for (std::size_t k = 0; k + 1 < list.size();) {
      if (std::abs(list[k].t_on_side - list[k + 1].t_on_side) * distance(pa, pb)
          < 1.0e-7 * span_size) {
        list.erase(list.begin() + static_cast<std::ptrdiff_t>(k + 1));
      } else {
        ++k;
      }
    }
    // Snap crossings of a vertex's own incident segments onto the vertex
    // when the side passes very close to it: the side path then bends
    // exactly through the vertex, avoiding degenerate sliver faces.
    for (Crossing& crossing : list) {
      for (const FeatureVertex& fv : features) {
        if (fv.node < 0 || fv.chain != crossing.chain) {
          continue;
        }
        const int m = static_cast<int>(chains[fv.chain].segment_count());
        const bool incident =
            crossing.seg == fv.index || crossing.seg == (fv.index + m - 1) % m;
        if (incident && distance(crossing.point, fv.point) < 0.22 * span_size) {
          crossing.point = fv.point;
          crossing.node = fv.node;
          break;
        }
      }
    }
    for (Crossing& crossing : list) {
      if (crossing.node < 0) {
        crossing.node = add_node(crossing.point, true);
      }
    }
    // A feature vertex lying almost on the side (possible because
    // repelling slides corners along grid lines): bend the side path
    // exactly through the vertex for both adjacent squares. Marked with
    // chain = -1 so it does not participate in chain piece pairing.
    for (const FeatureVertex& fv : features) {
      if (fv.node < 0 || distance_to_segment(fv.point, side_seg) >= 0.12 * span_size) {
        continue;
      }
      bool already = false;
      for (const Crossing& crossing : list) {
        if (crossing.node == fv.node) {
          already = true;
          break;
        }
      }
      if (already) {
        continue;
      }
      Crossing pseudo;
      pseudo.point = fv.point;
      pseudo.node = fv.node;
      pseudo.chain = -1;
      const Vec2 dir = pb - pa;
      const double len2 = dot(dir, dir);
      pseudo.t_on_side = len2 > 0.0 ? std::clamp(dot(fv.point - pa, dir) / len2, 0.0, 1.0) : 0.5;
      list.push_back(pseudo);
      std::sort(list.begin(), list.end(),
                [](const Crossing& a, const Crossing& b) { return a.t_on_side < b.t_on_side; });
    }
  };

  tree.for_each_leaf([&](std::int32_t i) {
    const Cell& cell = tree.cells[i];
    const double leaf_size = tree.size_at(cell.level);
    Aabb2 box = tree.box(cell);
    const double margin = 0.5 * leaf_size;
    box.min.x -= margin;
    box.min.y -= margin;
    box.max.x += margin;
    box.max.y += margin;
    if (!geom.any_segment_intersects(box)) {
      return;
    }
    for (int side = 0; side < 4; ++side) {
      for (const SideSpan& span : tree.side_spans(i, side)) {
        register_span(span, span.subside ? 0.5 * leaf_size : leaf_size);
      }
    }
  });
}

void classify_leaves(const Lattice& lat, GeometryModel& gm, BoundaryTopology& topo, MeshBuilder& mb,
                     MesherDebug* debug)
{
  const Tree& tree = lat.tree;
  auto& features = gm.features;
  auto& leaf_class = topo.leaf_class;
  auto& side_crossings = topo.side_crossings;
  const auto warn = [&](std::string message) {
    if (debug != nullptr) {
      debug->warnings.push_back(std::move(message));
    }
  };

  // The lattice assignment can disagree with the deformed squares when a
  // vertex sits very close to a repelled side; check the deformed corner quad
  // and fall back to the neighbor that actually contains the vertex.
  const auto locate_vertex_leaf = [&](std::int32_t lattice_leaf, Point2 v) -> std::int32_t {
    if (point_in_deformed(mb, lattice_leaf, v)) {
      return lattice_leaf;
    }
    for (int dy = -1; dy <= 1; ++dy) {
      for (int dx = -1; dx <= 1; ++dx) {
        if (dx == 0 && dy == 0) {
          continue;
        }
        for (const std::int32_t n : tree.neighbors_in_direction(lattice_leaf, dx, dy)) {
          if (point_in_deformed(mb, n, v)) {
            return n;
          }
        }
      }
    }
    warn("feature vertex not contained in any deformed square; keeping lattice square");
    return lattice_leaf;
  };

  // Locate feature vertices.
  for (FeatureVertex& fv : features) {
    const double sl = tree.root_size / static_cast<double>(1u << tree.lattice_level);
    const std::int64_t gx = static_cast<std::int64_t>(std::floor((fv.point.x - tree.origin.x) / sl));
    const std::int64_t gy = static_cast<std::int64_t>(std::floor((fv.point.y - tree.origin.y) / sl));
    const std::int64_t lattice_extent = 1ll << tree.lattice_level;
    if (gx < 0 || gy < 0 || gx >= lattice_extent || gy >= lattice_extent) {
      warn("feature vertex outside root box");
      continue;
    }
    const std::int32_t leaf = tree.leaf_covering(
        tree.lattice_level, static_cast<std::uint32_t>(gx), static_cast<std::uint32_t>(gy));
    if (leaf < 0) {
      warn("feature vertex not in tree");
      continue;
    }
    fv.leaf = locate_vertex_leaf(leaf, fv.point);
    leaf_class[fv.leaf] = LeafClass::Vertex;
  }

  tree.for_each_leaf([&](std::int32_t i) {
    if (leaf_class.count(i) > 0) {
      return;
    }
    bool cut = false;
    for (int side = 0; side < 4; ++side) {
      for (const SideSpan& span : tree.side_spans(i, side)) {
        const auto it = side_crossings.find(Tree::side_span_key(span));
        if (it != side_crossings.end() && !it->second.empty()) {
          cut = true;
          break;
        }
      }
      if (cut) {
        break;
      }
    }
    leaf_class[i] = cut ? LeafClass::Cut : LeafClass::Unset;
  });
}

} // namespace quadmesh::detail
