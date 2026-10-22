#pragma once

#include "quadmesh/geometry.hpp"

#include <cassert>
#include <cstdint>
#include <deque>
#include <unordered_map>
#include <utility>
#include <vector>

namespace quadmesh::detail {

// ---------------------------------------------------------------------------
// Quadtree with integer addressing
// ---------------------------------------------------------------------------

struct Cell {
  std::uint16_t level = 0;
  std::uint32_t ix = 0;
  std::uint32_t iy = 0;
  std::int32_t child0 = -1; // children are contiguous child0..child0+3

  bool leaf() const { return child0 < 0; }
};

// An atomic span of a leaf side. A coarse side adjacent to one-level finer
// leaves is represented by its two half-spans so both sides of the transition
// use the same crossing/path keys.
struct SideSpan {
  std::uint32_t ax = 0;
  std::uint32_t ay = 0;
  std::uint32_t bx = 0;
  std::uint32_t by = 0;
  bool subside = false;
};

constexpr std::uint64_t cell_key(std::uint32_t level, std::uint32_t ix, std::uint32_t iy)
{
  return (static_cast<std::uint64_t>(level) << 42) | (static_cast<std::uint64_t>(ix) << 21) | iy;
}

constexpr std::uint64_t gp_key(std::uint32_t gx, std::uint32_t gy)
{
  return (static_cast<std::uint64_t>(gx) << 21) | gy;
}

// Sides of a leaf: 0=S,1=E,2=N,3=W. side i runs CCW from corner i to corner (i+1)%4.
constexpr int side_corner_a(int side) { return side; }
constexpr int side_corner_b(int side) { return (side + 1) % 4; }

struct Tree {
  Point2 origin;
  double root_size = 1.0;
  std::uint16_t lattice_level = 0; // finest lattice used for grid point coords

  std::vector<Cell> cells;
  std::unordered_map<std::uint64_t, std::int32_t> by_key;

  void init(Point2 o, double size, std::uint16_t lattice)
  {
    origin = o;
    root_size = size;
    lattice_level = lattice;
    cells.clear();
    by_key.clear();
    cells.push_back({});
    by_key.emplace(cell_key(0, 0, 0), 0);
  }

  double size_at(std::uint16_t level) const { return root_size / static_cast<double>(1u << level); }

  Aabb2 box(const Cell& c) const
  {
    const double s = size_at(c.level);
    const Point2 lo{origin.x + c.ix * s, origin.y + c.iy * s};
    return {lo, {lo.x + s, lo.y + s}};
  }

  std::int32_t find(std::uint32_t level, std::uint32_t ix, std::uint32_t iy) const
  {
    const auto it = by_key.find(cell_key(level, ix, iy));
    return it == by_key.end() ? -1 : it->second;
  }

  void split(std::int32_t index)
  {
    Cell& parent = cells[index];
    assert(parent.leaf());
    const std::int32_t base = static_cast<std::int32_t>(cells.size());
    parent.child0 = base;
    const std::uint16_t cl = static_cast<std::uint16_t>(parent.level + 1);
    const std::uint32_t cx = parent.ix * 2;
    const std::uint32_t cy = parent.iy * 2;
    // Note: emplace after taking parent reference invalidates it; copy first.
    const std::uint32_t order[4][2] = {{cx, cy}, {cx + 1, cy}, {cx, cy + 1}, {cx + 1, cy + 1}};
    for (int i = 0; i < 4; ++i) {
      Cell child;
      child.level = cl;
      child.ix = order[i][0];
      child.iy = order[i][1];
      cells.push_back(child);
      by_key.emplace(cell_key(cl, child.ix, child.iy), base + i);
    }
  }

  // Splits ancestors as needed so the cell (level, ix, iy) exists as a leaf
  // (or finer; never coarser).
  void force_leaf(std::uint32_t level, std::uint32_t ix, std::uint32_t iy)
  {
    std::int32_t current = 0;
    for (std::uint32_t l = 0; l < level; ++l) {
      if (cells[current].leaf()) {
        split(current);
      }
      const std::uint32_t shift = level - l - 1;
      const std::uint32_t cx = ix >> shift;
      const std::uint32_t cy = iy >> shift;
      current = find(l + 1, cx, cy);
      assert(current >= 0);
    }
  }

  // Deepest leaf containing lattice cell (level, ix, iy); the returned leaf
  // has level <= the requested level, or the exact cell if it exists.
  // Descends through child indices, avoiding hash lookups.
  std::int32_t leaf_covering(std::uint32_t level, std::uint32_t ix, std::uint32_t iy) const
  {
    std::int32_t current = 0;
    for (std::uint32_t l = 0; l < level; ++l) {
      const Cell& cell = cells[current];
      if (cell.leaf()) {
        return current;
      }
      const std::uint32_t shift = level - l - 1;
      const std::uint32_t cx = (ix >> shift) & 1u;
      const std::uint32_t cy = (iy >> shift) & 1u;
      current = cell.child0 + static_cast<std::int32_t>(cy * 2u + cx);
    }
    return current;
  }

  template <typename Fn>
  void for_each_leaf(Fn&& fn) const
  {
    for (std::int32_t i = 0; i < static_cast<std::int32_t>(cells.size()); ++i) {
      if (cells[i].leaf()) {
        fn(i);
      }
    }
  }

  // Grid point lattice coordinates of a cell corner. corner: 0=SW,1=SE,2=NE,3=NW
  std::pair<std::uint32_t, std::uint32_t> corner_gp(const Cell& c, int corner) const
  {
    const std::uint32_t shift = lattice_level - c.level;
    const std::uint32_t gx = (c.ix + ((corner == 1 || corner == 2) ? 1u : 0u)) << shift;
    const std::uint32_t gy = (c.iy + (corner >= 2 ? 1u : 0u)) << shift;
    return {gx, gy};
  }

  Point2 gp_position(std::uint32_t gx, std::uint32_t gy) const
  {
    const double s = root_size / static_cast<double>(1u << lattice_level);
    return {origin.x + gx * s, origin.y + gy * s};
  }

  // Canonical key (min gp key -> max gp key) of a leaf side, so the same
  // physical side gets the same key from both adjacent squares.
  std::pair<std::uint64_t, std::uint64_t> side_key(const Cell& cell, int side) const
  {
    const auto [ax, ay] = corner_gp(cell, side_corner_a(side));
    const auto [bx, by] = corner_gp(cell, side_corner_b(side));
    const std::uint64_t ka = gp_key(ax, ay);
    const std::uint64_t kb = gp_key(bx, by);
    return {std::min(ka, kb), std::max(ka, kb)};
  }

  static std::pair<std::uint64_t, std::uint64_t> side_span_key(const SideSpan& span)
  {
    const std::uint64_t ka = gp_key(span.ax, span.ay);
    const std::uint64_t kb = gp_key(span.bx, span.by);
    return {std::min(ka, kb), std::max(ka, kb)};
  }

  // A strongly balanced transition has at most one level difference. The
  // coarse side must therefore be walked as two atomic half-sides; a fine
  // leaf's full side already has the same endpoints as one of those halves.
  std::vector<SideSpan> side_spans(std::int32_t leaf, int side) const
  {
    const Cell& cell = cells[leaf];
    const auto [ax, ay] = corner_gp(cell, side_corner_a(side));
    const auto [bx, by] = corner_gp(cell, side_corner_b(side));
    static constexpr int dirs[4][2] = {{0, -1}, {1, 0}, {0, 1}, {-1, 0}};
    bool finer_neighbor = false;
    for (const std::int32_t neighbor : neighbors_in_direction(leaf, dirs[side][0], dirs[side][1])) {
      if (cells[neighbor].level > cell.level) {
        finer_neighbor = true;
        break;
      }
    }
    if (!finer_neighbor) {
      return {{ax, ay, bx, by, false}};
    }
    const std::uint32_t mx = (ax + bx) / 2;
    const std::uint32_t my = (ay + by) / 2;
    return {{ax, ay, mx, my, true}, {mx, my, bx, by, true}};
  }

  // Neighbor leaves of `leaf` across side or corner directions. Returns leaf
  // indices; finer neighbors give several leaves.
  std::vector<std::int32_t> neighbors_in_direction(std::int32_t leaf, int dx, int dy) const
  {
    std::vector<std::int32_t> out;
    const Cell& cell = cells[leaf];
    const std::int64_t nx = static_cast<std::int64_t>(cell.ix) + dx;
    const std::int64_t ny = static_cast<std::int64_t>(cell.iy) + dy;
    const std::int64_t extent = 1ll << cell.level;
    if (nx < 0 || ny < 0 || nx >= extent || ny >= extent) {
      return out;
    }
    const std::int32_t found =
        leaf_covering(cell.level, static_cast<std::uint32_t>(nx), static_cast<std::uint32_t>(ny));
    if (found < 0) {
      return out;
    }
    if (cells[found].leaf()) {
      out.push_back(found);
      return out;
    }
    // Finer: collect descendant leaves touching the shared side/corner.
    std::deque<std::int32_t> queue{found};
    while (!queue.empty()) {
      const std::int32_t i = queue.front();
      queue.pop_front();
      const Cell& c = cells[i];
      if (c.leaf()) {
        out.push_back(i);
        continue;
      }
      for (int k = 0; k < 4; ++k) {
        const std::int32_t child = c.child0 + k;
        const Cell& cc = cells[child];
        // Child must touch the shared boundary with `cell`.
        const std::uint32_t shift = cc.level - cell.level;
        bool touches = true;
        if (dx == 1) {
          touches = touches && cc.ix == (static_cast<std::uint32_t>(nx) << shift);
        } else if (dx == -1) {
          touches = touches && cc.ix == ((static_cast<std::uint32_t>(nx) + 1u) << shift) - 1u;
        }
        if (dy == 1) {
          touches = touches && cc.iy == (static_cast<std::uint32_t>(ny) << shift);
        } else if (dy == -1) {
          touches = touches && cc.iy == ((static_cast<std::uint32_t>(ny) + 1u) << shift) - 1u;
        }
        if (touches) {
          queue.push_back(child);
        }
      }
    }
    return out;
  }
};

} // namespace quadmesh::detail
