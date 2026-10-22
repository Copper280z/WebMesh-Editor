#include "stages/sizing.hpp"

#include "detail/chain.hpp" // turn_angle_deg
#include "detail/types.hpp" // pi, LatticeInfo

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <deque>
#include <limits>
#include <map>
#include <numbers>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace quadmesh::detail {
namespace {

// A cell's (chain, segment) pieces, all from one chain, sorted by segment index.
using Run = std::vector<std::pair<int, int>>;

double fallback_target(const Chain& chain, double default_target)
{
  return chain.target_cell_size > 0.0 ? chain.target_cell_size : default_target;
}

std::uint16_t level_for_target(double root_size, double target, const MeshingConfig& config)
{
  std::uint16_t level = 1;
  while (root_size / static_cast<double>(1u << level) > target * std::numbers::sqrt2_v<double>
         && level < config.refinement.max_level) {
    ++level;
  }
  return level;
}

std::optional<std::pair<double, double>> segment_box_interval(Segment2 segment, const Aabb2& box)
{
  const Vec2 d = segment.b - segment.a;
  double lo = 0.0;
  double hi = 1.0;
  const auto clip_axis = [&](double p, double dp, double min, double max) {
    if (std::abs(dp) <= 1.0e-30) {
      return p >= min && p <= max;
    }
    const double a = (min - p) / dp;
    const double b = (max - p) / dp;
    lo = std::max(lo, std::min(a, b));
    hi = std::min(hi, std::max(a, b));
    return lo <= hi;
  };
  if (!clip_axis(segment.a.x, d.x, box.min.x, box.max.x)
      || !clip_axis(segment.a.y, d.y, box.min.y, box.max.y)) {
    return std::nullopt;
  }
  return std::pair{std::clamp(lo, 0.0, 1.0), std::clamp(hi, 0.0, 1.0)};
}

double segment_arc_fraction(const Chain& chain, int segment, double t)
{
  const double total = chain.total_length();
  if (total <= 0.0) {
    return 0.0;
  }
  const std::size_t index = static_cast<std::size_t>(segment);
  const double arc = chain.cumulative_length[index]
      + (chain.cumulative_length[index + 1] - chain.cumulative_length[index]) * t;
  return arc / total;
}

std::uint16_t local_level_for_interval(const Chain& chain, int segment, double t0, double t1,
                                       std::uint16_t floor_level, double root_size,
                                       const MeshingConfig& config)
{
  if (!chain.has_local_sizing() || chain.sizing_unconstrained) {
    return floor_level;
  }
  const double a = segment_arc_fraction(chain, segment, t0);
  const double b = segment_arc_fraction(chain, segment, t1);
  std::uint16_t level = floor_level;
  const auto consider = [&](double fraction) {
    level = std::max(level, level_for_target(root_size,
                                             chain.target_size_at_fraction(fraction, 0.0), config));
  };
  consider(a);
  consider(b);
  for (const BoundarySizingSample& sample : chain.sizing_samples) {
    if (sample.arc_fraction > a && sample.arc_fraction < b) {
      consider(sample.arc_fraction);
    }
  }
  return level;
}

std::uint16_t local_level_for_point(const Chain& chain, int segment, double t,
                                    std::uint16_t floor_level, double root_size,
                                    const MeshingConfig& config)
{
  return local_level_for_interval(chain, segment, t, t, floor_level, root_size, config);
}

std::uint16_t local_level_for_joint(const Chain& chain, int point_index,
                                    std::uint16_t floor_level, double root_size,
                                    const MeshingConfig& config)
{
  int segment = point_index;
  double t = 0.0;
  if (!chain.closed && segment == static_cast<int>(chain.segment_count())) {
    --segment;
    t = 1.0;
  }
  return local_level_for_point(chain, segment, t, floor_level, root_size, config);
}

std::uint16_t promoted_level_for_interval(
    const std::vector<BoundaryLevelPromotion>& promotions, double t0, double t1,
    std::uint16_t floor_level)
{
  if (t1 < t0) {
    std::swap(t0, t1);
  }
  std::uint16_t level = floor_level;
  for (const BoundaryLevelPromotion& promotion : promotions) {
    if (std::max(t0, promotion.t0) <= std::min(t1, promotion.t1) + 1.0e-12) {
      level = std::max(level, promotion.level);
    }
  }
  return level;
}

// Collapse overlapping leaf-contact intervals into a non-overlapping maximum
// level envelope, so later tree queries are proportional to level transitions
// rather than the number of initially contacted leaves.
void normalize_promotions(std::vector<BoundaryLevelPromotion>& promotions)
{
  std::vector<double> cuts;
  cuts.reserve(2 * promotions.size());
  for (const BoundaryLevelPromotion& promotion : promotions) {
    if (promotion.t1 > promotion.t0 + 1.0e-12) {
      cuts.push_back(promotion.t0);
      cuts.push_back(promotion.t1);
    }
  }
  if (cuts.size() < 2) {
    return;
  }
  std::sort(cuts.begin(), cuts.end());
  cuts.erase(std::unique(cuts.begin(), cuts.end(), [](double a, double b) {
               return std::abs(a - b) <= 1.0e-12;
             }),
             cuts.end());

  std::vector<BoundaryLevelPromotion> normalized;
  for (std::size_t i = 0; i + 1 < cuts.size(); ++i) {
    const double a = cuts[i];
    const double b = cuts[i + 1];
    const double midpoint = (a + b) / 2.0;
    std::uint16_t level = 0;
    for (const BoundaryLevelPromotion& promotion : promotions) {
      if (promotion.t0 <= midpoint && midpoint <= promotion.t1) {
        level = std::max(level, promotion.level);
      }
    }
    if (level == 0) {
      continue;
    }
    if (!normalized.empty() && normalized.back().level == level
        && std::abs(normalized.back().t1 - a) <= 1.0e-12) {
      normalized.back().t1 = b;
    } else {
      normalized.push_back({a, b, level});
    }
  }
  promotions = std::move(normalized);
}

std::uint16_t effective_level_for_interval(
    const Chain& chain, const ChainSizingPromotions& promotions, int segment,
    double t0, double t1, std::uint16_t floor_level, double root_size,
    const MeshingConfig& config)
{
  const std::uint16_t requested = local_level_for_interval(
      chain, segment, t0, t1, floor_level, root_size, config);
  return promoted_level_for_interval(promotions[static_cast<std::size_t>(segment)], t0, t1,
                                     requested);
}

std::uint16_t effective_level_for_joint(
    const Chain& chain, const ChainSizingPromotions& promotions, int point_index,
    std::uint16_t floor_level, double root_size, const MeshingConfig& config)
{
  std::uint16_t level = local_level_for_joint(
      chain, point_index, floor_level, root_size, config);
  const int segment_count = static_cast<int>(chain.segment_count());
  if (point_index < segment_count) {
    level = promoted_level_for_interval(promotions[static_cast<std::size_t>(point_index)],
                                        0.0, 0.0, level);
  }
  if (chain.closed || point_index > 0) {
    const int previous = (point_index + segment_count - 1) % segment_count;
    level = promoted_level_for_interval(promotions[static_cast<std::size_t>(previous)],
                                        1.0, 1.0, level);
  }
  return level;
}

std::uint16_t required_level_for_segment_box(const Chain& chain, int segment, const Aabb2& box,
                                             std::uint16_t floor_level, double root_size,
                                             const MeshingConfig& config,
                                             const std::vector<BoundaryLevelPromotion>& promotions)
{
  const auto interval = segment_box_interval(chain.segment(static_cast<std::size_t>(segment)), box);
  if (!interval.has_value()) {
    return floor_level;
  }
  const std::uint16_t requested = local_level_for_interval(
      chain, segment, interval->first, interval->second, floor_level, root_size, config);
  return promoted_level_for_interval(promotions, interval->first, interval->second, requested);
}

std::uint16_t maximum_requested_level(const GeometryModel& gm,
                                      const std::vector<std::uint16_t>& chain_levels,
                                      const std::vector<ChainSizingPromotions>& promotions,
                                      double root_size, const MeshingConfig& config)
{
  std::uint16_t result = 0;
  for (int c = 0; c < static_cast<int>(gm.chains.size()); ++c) {
    const Chain& chain = gm.chains[c];
    result = std::max(result, chain_levels[c]);
    for (const auto& segment_promotions : promotions[c]) {
      for (const BoundaryLevelPromotion& promotion : segment_promotions) {
        result = std::max(result, promotion.level);
      }
    }
    if (chain.sizing_unconstrained) {
      continue;
    }
    for (const BoundarySizingSample& sample : chain.sizing_samples) {
      result = std::max(result, level_for_target(root_size, sample.target_cell_size, config));
    }
  }
  return result;
}

// Walks the cells of chain `c` on the lattice (`origin`, cell size `s`), filling
// `info` with the chain's pieces, shallow joints, and feature vertices.
void gather_lattice_info(const GeometryModel& gm, Point2 origin, double s, int c,
                         std::map<std::pair<int, int>, LatticeInfo>& info)
{
  const auto& chains = gm.chains;
  const auto& features = gm.features;
  const auto cell_of = [&](Point2 p) {
    const int cx = static_cast<int>(std::floor((p.x - origin.x) / s));
    const int cy = static_cast<int>(std::floor((p.y - origin.y) / s));
    return std::pair<int, int>{cx, cy};
  };
  const Chain& chain = chains[c];
  for (std::size_t i = 0; i < chain.segment_count(); ++i) {
    const Segment2 seg = chain.segment(i);
    const auto [cx0, cy0] = cell_of({std::min(seg.a.x, seg.b.x), std::min(seg.a.y, seg.b.y)});
    const auto [cx1, cy1] = cell_of({std::max(seg.a.x, seg.b.x), std::max(seg.a.y, seg.b.y)});
    for (int cy = cy0; cy <= cy1; ++cy) {
      for (int cx = cx0; cx <= cx1; ++cx) {
        const Aabb2 box{{origin.x + cx * s, origin.y + cy * s},
                        {origin.x + (cx + 1) * s, origin.y + (cy + 1) * s}};
        if (segment_intersects_aabb(seg, box)) {
          info[{cx, cy}].pieces.push_back({c, static_cast<int>(i)});
        }
      }
    }
  }
  for (std::size_t i = 0; i < chain.points.size(); ++i) {
    if (!chain.feature[i]) {
      info[cell_of(chain.points[i])].joints.push_back({c, static_cast<int>(i)});
    }
  }
  for (int v = 0; v < static_cast<int>(features.size()); ++v) {
    if (features[v].chain == c) {
      info[cell_of(features[v].point)].vertices.push_back(v);
    }
  }
}

// Shortest arc distance along `chain` from segment `seg` to point `point_index`,
// walking both ways (max() if an open chain's walk runs off an end).
double arc_distance_to_point(const Chain& chain, int seg, int point_index)
{
  const int n = static_cast<int>(chain.points.size());
  const int m = static_cast<int>(chain.segment_count());
  double forward = 0.0;
  int idx = seg;
  for (int steps = 0; steps < m; ++steps) {
    idx = (idx + 1) % n;
    if (idx == point_index) {
      break;
    }
    if (!chain.closed && idx >= m) {
      forward = std::numeric_limits<double>::max();
      break;
    }
    forward += distance(chain.points[idx], chain.points[(idx + 1) % n]);
    if (forward > 1.0e30) {
      break;
    }
  }
  double backward = 0.0;
  idx = seg;
  for (int steps = 0; steps < m; ++steps) {
    if (idx == point_index) {
      break;
    }
    const int prev = (idx + n - 1) % n;
    if (!chain.closed && idx == 0) {
      backward = std::numeric_limits<double>::max();
      break;
    }
    backward += distance(chain.points[prev], chain.points[idx]);
    idx = prev;
  }
  return std::min(forward, backward);
}

// Whether segment `i` of chain `c` is within arc distance `reach` of feature
// vertex `fv` along its chain.
bool piece_near_vertex(const std::vector<Chain>& chains, int c, int i, const FeatureVertex& fv,
                       double reach)
{
  if (c != fv.chain) {
    return false;
  }
  return arc_distance_to_point(chains[c], i, fv.index) <= reach;
}

// Whether some feature vertex has a piece within `reach` in both runs (so the
// two runs are really one curve folding around that vertex, not a self-approach).
bool runs_share_near_vertex(const GeometryModel& gm, const Run& a, const Run& b, double reach)
{
  for (const FeatureVertex& fv : gm.features) {
    const auto run_near = [&](const Run& run) {
      for (const auto& [c, i] : run) {
        if (piece_near_vertex(gm.chains, c, i, fv, reach)) {
          return true;
        }
      }
      return false;
    };
    if (run_near(a) && run_near(b)) {
      return true;
    }
  }
  return false;
}

// Groups a cell's (chain, segment) pieces into maximal runs of consecutive
// segment indices (wrapping on closed chains). The pieces all belong to one
// chain and arrive sorted by segment index.
std::vector<Run> contiguous_runs(const std::vector<Chain>& chains, const Run& pieces)
{
  std::vector<Run> runs;
  for (const auto& piece : pieces) {
    if (runs.empty() || piece.second != runs.back().back().second + 1) {
      runs.push_back({});
    }
    runs.back().push_back(piece);
  }
  // Closed chain: the run ending at the last segment continues into the run
  // starting at segment 0.
  if (runs.size() > 1 && chains[pieces.front().first].closed && pieces.front().second == 0
      && pieces.back().second == static_cast<int>(chains[pieces.front().first].segment_count()) - 1) {
    runs.back().insert(runs.back().end(), runs.front().begin(), runs.front().end());
    runs.erase(runs.begin());
  }
  return runs;
}

// One pass of the separation rules at the chains' current levels; raises levels
// in place. Returns true when every rule is already satisfied.
bool separation_pass(const GeometryModel& gm, const MeshingConfig& config, Point2 origin,
                     double root_size, std::vector<std::uint16_t>& levels)
{
  const auto& chains = gm.chains;
  const auto& features = gm.features;
  bool ok = true;
  const auto raise = [&](int c) {
    if (levels[c] < config.refinement.max_level) {
      ++levels[c];
      ok = false;
      return true;
    }
    return false;
  };
  const double turn_cap_deg =
      std::max(10.0, 4.0 * config.features.chord_tolerance_fraction * 180.0 / pi);

  // Within-chain rules at the chain's own level.
  for (int c = 0; c < static_cast<int>(chains.size()); ++c) {
    const Chain& chain = chains[c];
    const double s = root_size / static_cast<double>(1u << levels[c]);
    // Closed loops smaller than ~2 cells would vanish inside one square.
    if (chain.closed && max_extent(bounds_of({chain.points, true})) < 2.0 * s) {
      raise(c);
      continue;
    }
    std::map<std::pair<int, int>, LatticeInfo> info;
    gather_lattice_info(gm, origin, s, c, info);
    bool raised = false;
    for (const auto& [cell, data] : info) {
      (void)cell;
      if (data.vertices.size() > 1) {
        raised = raise(c);
        break;
      }
      if (data.joints.size() >= 2) {
        double total_turn = 0.0;
        for (const auto& [jc, i] : data.joints) {
          const std::size_t n = chains[jc].points.size();
          total_turn += turn_angle_deg(chains[jc].points[(i + n - 1) % n], chains[jc].points[i],
                                       chains[jc].points[(i + 1) % n]);
        }
        if (total_turn > turn_cap_deg) {
          raised = raise(c);
          break;
        }
      }
      if (data.vertices.size() == 1) {
        const FeatureVertex& fv = features[data.vertices.front()];
        for (const auto& [pc, i] : data.pieces) {
          if (!piece_near_vertex(chains, pc, i, fv, 3.0 * s)) {
            raised = raise(c);
            break;
          }
        }
        if (raised) {
          break;
        }
        continue;
      }
      // The chain coming close to itself: disjoint pieces in one square. A run
      // of consecutive segments crossing the square is one piece of curve (a
      // smooth chain sweeps several segments through a square); only separate
      // runs mean the chain left the square and came back.
      const std::vector<Run> runs = contiguous_runs(chains, data.pieces);
      if (runs.size() > 1) {
        for (std::size_t a = 0; a < runs.size() && !raised; ++a) {
          for (std::size_t b = a + 1; b < runs.size(); ++b) {
            if (!runs_share_near_vertex(gm, runs[a], runs[b], 3.0 * s)) {
              raised = raise(c);
              break;
            }
          }
        }
        if (raised) {
          break;
        }
      }
    }
  }

  // Cross-chain rule: two different chains must not share a square at the finer
  // of their two levels. Contact raises the coarser chain (aligning the bands),
  // or both when already equal.
  for (int a = 0; a < static_cast<int>(chains.size()); ++a) {
    for (int b = a + 1; b < static_cast<int>(chains.size()); ++b) {
      const std::uint16_t level = std::max(levels[a], levels[b]);
      const double s = root_size / static_cast<double>(1u << level);
      const Aabb2 bounds_a = bounds_of({chains[a].points, true});
      const Aabb2 bounds_b = bounds_of({chains[b].points, true});
      if (bounds_a.min.x > bounds_b.max.x + 2.0 * s || bounds_b.min.x > bounds_a.max.x + 2.0 * s
          || bounds_a.min.y > bounds_b.max.y + 2.0 * s
          || bounds_b.min.y > bounds_a.max.y + 2.0 * s) {
        continue;
      }
      std::map<std::pair<int, int>, LatticeInfo> info;
      gather_lattice_info(gm, origin, s, a, info);
      gather_lattice_info(gm, origin, s, b, info);
      bool contact = false;
      for (const auto& [cell, data] : info) {
        (void)cell;
        bool has_a = false;
        bool has_b = false;
        for (const auto& [pc, i] : data.pieces) {
          (void)i;
          has_a = has_a || pc == a;
          has_b = has_b || pc == b;
        }
        if (has_a && has_b) {
          contact = true;
          break;
        }
      }
      if (!contact) {
        continue;
      }
      if (levels[a] < levels[b]) {
        raise(a);
      } else if (levels[b] < levels[a]) {
        raise(b);
      } else {
        raise(a);
        raise(b);
      }
    }
  }
  return ok;
}

// Whether leaf `i`'s box, expanded by the repelling clearance of its own level,
// touches geometry whose requested or promoted local level matches the leaf.
bool is_band_leaf(const Tree& tree, const GeomIndex& geom, const GeometryModel& gm,
                  const std::vector<std::uint16_t>& chain_levels,
                  const std::vector<ChainSizingPromotions>& promotions,
                  const MeshingConfig& config, std::int32_t i)
{
  const Cell& cell = tree.cells[i];
  const double d = tree.size_at(cell.level) * config.repelling.distance_fraction;
  Aabb2 box = tree.box(cell);
  box.min.x -= d;
  box.min.y -= d;
  box.max.x += d;
  box.max.y += d;
  bool hit = false;
  geom.for_each_near(box, [&](int s) {
    const int c = geom.refs[s].chain;
    const std::uint16_t required = required_level_for_segment_box(
        gm.chains[c], geom.refs[s].index, box, chain_levels[c], tree.root_size, config,
        promotions[c][static_cast<std::size_t>(geom.refs[s].index)]);
    if (!hit && required == cell.level && segment_intersects_aabb(geom.segments[s], box)) {
      hit = true;
    }
  });
  return hit;
}

// Strongly balanced quadtree (corner-adjacent level difference <= 1). Queue
// based: a split re-enqueues the splitter and the new children instead of
// re-sweeping the whole tree.
void strong_balance(Tree& tree)
{
  std::deque<std::int32_t> queue;
  tree.for_each_leaf([&](std::int32_t i) { queue.push_back(i); });
  while (!queue.empty()) {
    const std::int32_t i = queue.front();
    queue.pop_front();
    if (!tree.cells[i].leaf()) {
      continue;
    }
    const std::uint16_t level = tree.cells[i].level;
    bool split_any = false;
    for (int dy = -1; dy <= 1; ++dy) {
      for (int dx = -1; dx <= 1; ++dx) {
        if (dx == 0 && dy == 0) {
          continue;
        }
        for (const std::int32_t n : tree.neighbors_in_direction(i, dx, dy)) {
          if (level > tree.cells[n].level + 1 && tree.cells[n].leaf()) {
            tree.split(n);
            split_any = true;
            for (int k = 0; k < 4; ++k) {
              queue.push_back(tree.cells[n].child0 + k);
            }
          }
        }
      }
    }
    if (split_any) {
      queue.push_back(i);
    }
  }
}

// Builds the strongly balanced quadtree: refine each cell toward the level of
// every chain whose delta-expanded geometry reaches it, force the band 1-ring
// and feature 2-ring, then strong-balance.
void build_tree(Tree& tree, GeomIndex& geom, const GeometryModel& gm,
                const std::vector<std::uint16_t>& chain_levels,
                const std::vector<ChainSizingPromotions>& promotions,
                const MeshingConfig& config, Point2 origin, double root_size)
{
  const auto& chains = gm.chains;
  const auto& features = gm.features;
  tree.init(origin, root_size, config.refinement.max_level);

  const auto chain_delta = [&](int c) {
    return root_size / static_cast<double>(1u << chain_levels[c]) * config.repelling.distance_fraction;
  };
  double max_delta = 0.0;
  for (int c = 0; c < static_cast<int>(chains.size()); ++c) {
    max_delta = std::max(max_delta, chain_delta(c));
  }

  // Refine each cell toward the level of every chain whose delta-expanded
  // geometry reaches it.
  std::deque<std::int32_t> queue{0};
  while (!queue.empty()) {
    const std::int32_t i = queue.front();
    queue.pop_front();
    const Cell cell = tree.cells[i];
    const Aabb2 raw = tree.box(cell);
    Aabb2 query = raw;
    query.min.x -= max_delta;
    query.min.y -= max_delta;
    query.max.x += max_delta;
    query.max.y += max_delta;
    int required = -1;
    geom.for_each_near(query, [&](int s) {
      const int c = geom.refs[s].chain;
      const double d = chain_delta(c);
      Aabb2 box = raw;
      box.min.x -= d;
      box.min.y -= d;
      box.max.x += d;
      box.max.y += d;
      if (!segment_intersects_aabb(geom.segments[s], box)) {
        return;
      }
      const std::uint16_t segment_required = required_level_for_segment_box(
          chains[c], geom.refs[s].index, box, chain_levels[c], root_size, config,
          promotions[c][static_cast<std::size_t>(geom.refs[s].index)]);
      if (segment_required > cell.level && static_cast<int>(segment_required) > required) {
        required = segment_required;
      }
    });
    if (required <= static_cast<int>(cell.level)) {
      continue;
    }
    if (tree.cells[i].leaf()) {
      tree.split(i);
    }
    for (int k = 0; k < 4; ++k) {
      queue.push_back(tree.cells[i].child0 + k);
    }
  }

  // Force the 1-ring around band leaves to the leaf's level, and the 2-ring
  // around feature vertices to their chain's level.
  const auto force_ring = [&](std::uint16_t level, std::int64_t ix, std::int64_t iy, int radius) {
    const std::int64_t extent = 1ll << level;
    for (int dy = -radius; dy <= radius; ++dy) {
      for (int dx = -radius; dx <= radius; ++dx) {
        const std::int64_t nx = ix + dx;
        const std::int64_t ny = iy + dy;
        if (nx < 0 || ny < 0 || nx >= extent || ny >= extent) {
          continue;
        }
        tree.force_leaf(level, static_cast<std::uint32_t>(nx), static_cast<std::uint32_t>(ny));
      }
    }
  };
  std::vector<std::int32_t> band;
  tree.for_each_leaf([&](std::int32_t i) {
    if (is_band_leaf(tree, geom, gm, chain_levels, promotions, config, i)) {
      band.push_back(i);
    }
  });
  for (const std::int32_t i : band) {
    const Cell& cell = tree.cells[i];
    force_ring(cell.level, cell.ix, cell.iy, 1);
  }
  for (const FeatureVertex& fv : features) {
    const std::uint16_t level = effective_level_for_joint(
        chains[fv.chain], promotions[fv.chain], fv.index, chain_levels[fv.chain], root_size,
        config);
    const double s = root_size / static_cast<double>(1u << level);
    force_ring(level, static_cast<std::int64_t>(std::floor((fv.point.x - origin.x) / s)),
               static_cast<std::int64_t>(std::floor((fv.point.y - origin.y) / s)), 2);
  }

  strong_balance(tree);
}

// WholeLoop mode preserves the legacy invariant that every uniformly sized band
// has a same-level neighborhood. Local mode instead snapshots finer leaves that
// touch a uniform chain into arc-local promotion intervals; generalized
// atomic-side templates make the resulting mixed boundary levels conforming.
bool verify_band_uniformity(const Tree& tree, const GeomIndex& geom, const GeometryModel& gm,
                            std::vector<std::uint16_t>& chain_levels,
                            std::vector<ChainSizingPromotions>& promotions,
                            bool& local_promotion_initialized, const MeshingConfig& config,
                            MesherDebug* debug)
{
  if (config.refinement.sizing_promotion == SizingPromotionMode::Local) {
    if (local_promotion_initialized) {
      // Mixed boundary levels are intentional in this mode. Atomic-side
      // transitions and generalized templates keep them conforming.
      return true;
    }
    local_promotion_initialized = true;
    bool promoted = false;
    // Snapshot the balanced tree before any automatic promotions. A finer leaf
    // touching a uniformly sized chain is grading imported from elsewhere;
    // recording this once avoids recursively walking the chain with each new
    // same-level ring on subsequent rebuilds.
    tree.for_each_leaf([&](std::int32_t i) {
      const Cell& cell = tree.cells[i];
      const double d = tree.size_at(cell.level) * config.repelling.distance_fraction;
      Aabb2 box = tree.box(cell);
      box.min.x -= d;
      box.min.y -= d;
      box.max.x += d;
      box.max.y += d;
      geom.for_each_near(box, [&](int s) {
        const int c = geom.refs[s].chain;
        const int segment = geom.refs[s].index;
        if (gm.chains[c].has_local_sizing()) {
          return;
        }
        const auto interval = segment_box_interval(geom.segments[s], box);
        if (!interval.has_value()) {
          return;
        }
        const std::uint16_t required = effective_level_for_interval(
            gm.chains[c], promotions[c], segment, interval->first, interval->second,
            chain_levels[c], tree.root_size, config);
        if (required >= cell.level) {
          return;
        }
        promotions[c][static_cast<std::size_t>(segment)].push_back(
            {interval->first, interval->second, cell.level});
        promoted = true;
      });
    });
    for (ChainSizingPromotions& chain_promotions : promotions) {
      for (auto& segment_promotions : chain_promotions) {
        normalize_promotions(segment_promotions);
      }
    }
    return !promoted;
  }

  bool ok = true;
  std::vector<bool> raised(gm.chains.size(), false);
  // A chain's geometry passing through leaves finer than its band level (another
  // chain's grading refined the tree there) breaks the uniform band premise:
  // adjacent cut squares of different levels mesh their shared side
  // inconsistently. Raise the chain to the finest such leaf.
  tree.for_each_leaf([&](std::int32_t i) {
    const Cell& cell = tree.cells[i];
    const double d = tree.size_at(cell.level) * config.repelling.distance_fraction;
    Aabb2 box = tree.box(cell);
    box.min.x -= d;
    box.min.y -= d;
    box.max.x += d;
    box.max.y += d;
    geom.for_each_near(box, [&](int s) {
      const int c = geom.refs[s].chain;
      if (gm.chains[c].has_local_sizing() || chain_levels[c] >= cell.level
          || !segment_intersects_aabb(geom.segments[s], box)) {
        return;
      }
      chain_levels[c] = cell.level;
      raised[c] = true;
      ok = false;
    });
  });
  if (!ok) {
    return false;
  }
  tree.for_each_leaf([&](std::int32_t i) {
    if (!is_band_leaf(tree, geom, gm, chain_levels, promotions, config, i)) {
      return;
    }
    const Cell& cell = tree.cells[i];
    bool finer_neighbor = false;
    for (int dy = -1; dy <= 1 && !finer_neighbor; ++dy) {
      for (int dx = -1; dx <= 1 && !finer_neighbor; ++dx) {
        if (dx == 0 && dy == 0) {
          continue;
        }
        for (const std::int32_t n : tree.neighbors_in_direction(i, dx, dy)) {
          if (tree.cells[n].level > cell.level) {
            finer_neighbor = true;
            break;
          }
        }
      }
    }
    if (!finer_neighbor) {
      return;
    }
    const double d = tree.size_at(cell.level) * config.repelling.distance_fraction;
    Aabb2 box = tree.box(cell);
    box.min.x -= d;
    box.min.y -= d;
    box.max.x += d;
    box.max.y += d;
    geom.for_each_near(box, [&](int s) {
      const int c = geom.refs[s].chain;
      if (!gm.chains[c].has_local_sizing() && chain_levels[c] == cell.level && !raised[c]
          && segment_intersects_aabb(geom.segments[s], box)) {
        if (chain_levels[c] < config.refinement.max_level) {
          ++chain_levels[c];
          raised[c] = true;
          ok = false;
        } else if (debug != nullptr) {
          debug->warnings.push_back("band contact at max refinement level; quality may degrade");
        }
      }
    });
  });
  return ok;
}

// Per-chain band levels from the targets alone (before separation). The target
// is rounded to the *nearest* representable size in log scale (achieved band
// size within sqrt(2) of the request); flooring instead would hand out cells up
// to 2x finer than asked. Targets coarser than any representable size behave
// like sizing_unconstrained: the level stays at the coarsest.
std::vector<std::uint16_t> initial_chain_levels(const GeometryModel& gm, const MeshingConfig& config,
                                                double root_size, double default_target)
{
  std::vector<std::uint16_t> levels(gm.chains.size(), 1);
  for (int c = 0; c < static_cast<int>(gm.chains.size()); ++c) {
    const Chain& chain = gm.chains[c];
    if (chain.sizing_unconstrained) {
      continue; // start at the coarsest level; separation raises as needed
    }
    double target = fallback_target(chain, default_target);
    // The base chain level is the coarsest local request. Finer samples are
    // imposed per leaf in build_tree, while separation remains a safety floor
    // that can raise the full chain when geometry requires it.
    for (const BoundarySizingSample& sample : chain.sizing_samples) {
      target = std::max(target, sample.target_cell_size);
    }
    levels[c] = level_for_target(root_size, target, config);
  }
  return levels;
}

// Shifts the origin so feature vertices clear grid lines at their requested and
// actual balanced-tree levels. Locally sized chains also score the distance of
// every geometry/grid crossing from the nearest lattice corner; otherwise a
// valid but acute cut-face sector can survive repelling. Smooth joints retain a
// small exact-tangency guard.
Point2 shifted_origin(const GeometryModel& gm, const std::vector<std::uint16_t>& chain_levels,
                      const std::vector<ChainSizingPromotions>& promotions,
                      Point2 base_origin, double root_size, const Aabb2& bounds,
                      const MeshingConfig& config,
                      const std::vector<std::uint16_t>& feature_clearance_levels)
{
  const auto& chains = gm.chains;
  const auto& features = gm.features;
  Point2 origin = base_origin;
  const double s_coarse =
      root_size
      / static_cast<double>(1u << *std::min_element(chain_levels.begin(), chain_levels.end()));
  const auto level_at_joint = [&](int chain, int point_index) {
    return effective_level_for_joint(chains[chain], promotions[chain], point_index,
                                     chain_levels[chain], root_size, config);
  };
  const auto margin_at_level = [&](Point2 p, std::uint16_t level, Point2 candidate) {
    const double s_c = root_size / static_cast<double>(1u << level);
    const double fx = (p.x - candidate.x) / s_c;
    const double fy = (p.y - candidate.y) / s_c;
    const double mx = std::min(fx - std::floor(fx), std::ceil(fx) - fx);
    const double my = std::min(fy - std::floor(fy), std::ceil(fy) - fy);
    return std::min(mx, my);
  };
  // The shift must keep the domain inside the root square; skip candidates that
  // would push it past the far edge.
  const double margin_x = (root_size - width(bounds)) / 2.0;
  const double margin_y = (root_size - height(bounds)) / 2.0;
  double best_score = -1.0;
  bool has_local_sizing = false;
  for (std::size_t c = 0; c < chains.size(); ++c) {
    const bool has_promotion = std::any_of(
        promotions[c].begin(), promotions[c].end(), [](const auto& segment) {
          return !segment.empty();
        });
    has_local_sizing = has_local_sizing || chains[c].has_local_sizing() || has_promotion;
  }
  struct ClearanceSegment {
    Segment2 segment;
    std::uint16_t level = 1;
  };
  std::vector<ClearanceSegment> clearance_segments;
  if (has_local_sizing) {
    for (int c = 0; c < static_cast<int>(chains.size()); ++c) {
      for (int segment = 0; segment < static_cast<int>(chains[c].segment_count()); ++segment) {
        clearance_segments.push_back(
            {chains[c].segment(static_cast<std::size_t>(segment)),
             effective_level_for_interval(chains[c], promotions[c], segment, 0.0, 1.0,
                                          chain_levels[c], root_size, config)});
      }
    }
  }
  const auto grid_crossing_margin = [&](const ClearanceSegment& entry, Point2 candidate) {
    const double cell_size = root_size / static_cast<double>(1u << entry.level);
    const Point2 a{(entry.segment.a.x - candidate.x) / cell_size,
                   (entry.segment.a.y - candidate.y) / cell_size};
    const Point2 b{(entry.segment.b.x - candidate.x) / cell_size,
                   (entry.segment.b.y - candidate.y) / cell_size};
    double result = 0.5;
    const auto axis_margin = [](double coordinate) {
      const double fraction = coordinate - std::floor(coordinate);
      return std::min(fraction, 1.0 - fraction);
    };
    const auto scan = [&](double from, double to, double other_from, double other_to) {
      const double delta = to - from;
      if (std::abs(delta) <= 1.0e-14) {
        return;
      }
      const std::int64_t first = static_cast<std::int64_t>(std::ceil(std::min(from, to) - 1.0e-12));
      const std::int64_t last = static_cast<std::int64_t>(std::floor(std::max(from, to) + 1.0e-12));
      for (std::int64_t line = first; line <= last; ++line) {
        const double t = (static_cast<double>(line) - from) / delta;
        if (t < -1.0e-12 || t > 1.0 + 1.0e-12) {
          continue;
        }
        result = std::min(result, axis_margin(other_from + t * (other_to - other_from)));
      }
    };
    scan(a.x, b.x, a.y, b.y);
    scan(a.y, b.y, a.x, b.x);
    return result;
  };
  // An odd denominator prevents the candidates from aliasing with any nested
  // dyadic grid. Twenty-three phases give sub-0.05 phase resolution; with the
  // old /32 steps, a level five or more finer than the coarsest grid sees every
  // candidate at the same phase and can remain exactly on a grid line.
  const int phase_count = has_local_sizing ? 23 : 32;
  for (int oy = 0; oy < phase_count; ++oy) {
    if (s_coarse * oy / static_cast<double>(phase_count) > margin_y) {
      break;
    }
    for (int ox = 0; ox < phase_count; ++ox) {
      if (s_coarse * ox / static_cast<double>(phase_count) > margin_x) {
        break;
      }
      const Point2 candidate{base_origin.x - s_coarse * ox / static_cast<double>(phase_count),
                             base_origin.y - s_coarse * oy / static_cast<double>(phase_count)};
      double score = std::numeric_limits<double>::max();
      for (std::size_t f = 0; f < features.size(); ++f) {
        const FeatureVertex& fv = features[f];
        const std::uint16_t level =
            std::max(level_at_joint(fv.chain, fv.index), feature_clearance_levels[f]);
        score = std::min(score, margin_at_level(fv.point, level, candidate));
      }
      for (const ClearanceSegment& segment : clearance_segments) {
        score = std::min(score, grid_crossing_margin(segment, candidate));
      }
      // Joints only need to clear exact tangency; they cap the score only when
      // nearly on a grid line, so feature clearance stays the primary criterion.
      for (int c = 0; c < static_cast<int>(chains.size()); ++c) {
        for (std::size_t i = 0; i < chains[c].points.size(); ++i) {
          if (chains[c].feature[i]) {
            continue;
          }
          const double m = margin_at_level(chains[c].points[i],
                                           level_at_joint(c, static_cast<int>(i)), candidate);
          if (m < 0.005) {
            score = std::min(score, m);
          }
        }
      }
      if (score > best_score) {
        best_score = score;
        origin = candidate;
      }
    }
  }
  return origin;
}

} // namespace

Lattice build_lattice(const GeometryModel& gm, const Aabb2& bounds, const MeshingConfig& config,
                      MesherDebug* debug)
{
  Lattice lat;
  const auto& chains = gm.chains;
  GeomIndex& geom = lat.geom;
  auto& chain_levels = lat.chain_levels;
  auto& promotions = lat.sizing_promotions;

  const auto warn = [&](std::string message) {
    if (debug != nullptr) {
      debug->warnings.push_back(std::move(message));
    }
  };

  // -------------------------------------------------------------------------
  // Prologue: root frame and initial per-chain levels.
  // -------------------------------------------------------------------------
  const double extent = std::max(max_extent(bounds), 1.0e-9);
  double default_target = config.refinement.target_cell_size;
  if (default_target <= 0.0) {
    default_target = extent / 24.0;
  }
  // The root square is sized from the geometry alone, never from the targets:
  // cell sizes are quantized to root_size/2^level, so a target-dependent root
  // would move the whole lattice with every sizing request and make element
  // counts non-monotone in the target. 2x the extent leaves alignment-shift
  // headroom on every side.
  const double root_size = 2.0 * extent;

  chain_levels = initial_chain_levels(gm, config, root_size, default_target);
  promotions.resize(gm.chains.size());
  for (std::size_t c = 0; c < gm.chains.size(); ++c) {
    promotions[c].resize(gm.chains[c].segment_count());
  }
  std::vector<std::uint16_t> feature_clearance_levels(gm.features.size(), 1);
  const Point2 base_origin{center(bounds).x - root_size / 2.0, center(bounds).y - root_size / 2.0};

  // Settle separation, origin shift, tree build, and band uniformity to a joint
  // fixpoint: raising a chain level or adding a local promotion invalidates the
  // origin shift and the separation rules at the new lattice, so the whole
  // stage reruns. Convergence holds because sizing levels only grow.
  Point2 origin = base_origin;
  bool bands_uniform = false;
  bool local_promotion_initialized = false;
  for (int iteration = 0; iteration < 24 && !bands_uniform; ++iteration) {
    for (std::size_t f = 0; f < gm.features.size(); ++f) {
      const FeatureVertex& fv = gm.features[f];
      feature_clearance_levels[f] =
          std::max(feature_clearance_levels[f],
                   effective_level_for_joint(gm.chains[fv.chain], promotions[fv.chain], fv.index,
                                             chain_levels[fv.chain], root_size, config));
    }
    bool separated = false;
    for (int k = 0; k < 64 && !separated; ++k) {
      separated = separation_pass(gm, config, base_origin, root_size, chain_levels);
    }
    if (!separated) {
      warn("feature separation not achieved at max refinement level");
    }
    origin = shifted_origin(gm, chain_levels, promotions, base_origin, root_size, bounds, config,
                            feature_clearance_levels);
    const std::uint16_t index_level =
        maximum_requested_level(gm, chain_levels, promotions, root_size, config);
    const double s_finest = root_size / static_cast<double>(1u << index_level);
    geom.build(chains, {{origin.x, origin.y}, {origin.x + root_size, origin.y + root_size}},
               s_finest);
    build_tree(lat.tree, geom, gm, chain_levels, promotions, config, origin, root_size);
    bool feature_levels_stable = true;
    const double lattice_size = lat.tree.size_at(lat.tree.lattice_level);
    const std::int64_t lattice_extent = 1ll << lat.tree.lattice_level;
    for (std::size_t f = 0; f < gm.features.size(); ++f) {
      const Point2 point = gm.features[f].point;
      const std::int64_t ix =
          static_cast<std::int64_t>(std::floor((point.x - origin.x) / lattice_size));
      const std::int64_t iy =
          static_cast<std::int64_t>(std::floor((point.y - origin.y) / lattice_size));
      if (ix < 0 || iy < 0 || ix >= lattice_extent || iy >= lattice_extent) {
        continue;
      }
      const std::int32_t leaf = lat.tree.leaf_covering(
          lat.tree.lattice_level, static_cast<std::uint32_t>(ix), static_cast<std::uint32_t>(iy));
      const std::uint16_t actual_level = lat.tree.cells[leaf].level;
      if (actual_level > feature_clearance_levels[f]) {
        feature_clearance_levels[f] = actual_level;
        feature_levels_stable = false;
      }
    }
    const bool current_bands_uniform =
        verify_band_uniformity(lat.tree, geom, gm, chain_levels, promotions,
                               local_promotion_initialized, config, debug);
    bands_uniform = current_bands_uniform && feature_levels_stable;
  }
  if (!bands_uniform) {
    warn("band uniformity not reached within iteration limit");
  }

  lat.origin = origin;
  lat.root_size = root_size;
  return lat;
}

} // namespace quadmesh::detail
