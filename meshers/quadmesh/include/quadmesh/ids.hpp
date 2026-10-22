#pragma once

#include <cstdint>
#include <limits>

namespace quadmesh {

inline constexpr std::uint32_t invalid_index = std::numeric_limits<std::uint32_t>::max();

struct CellId {
  std::uint32_t value = invalid_index;

  constexpr bool valid() const noexcept { return value != invalid_index; }
  friend constexpr bool operator==(CellId a, CellId b) noexcept { return a.value == b.value; }
  friend constexpr bool operator!=(CellId a, CellId b) noexcept { return !(a == b); }
  friend constexpr bool operator<(CellId a, CellId b) noexcept { return a.value < b.value; }
};

struct NodeId {
  std::uint32_t value = invalid_index;

  constexpr bool valid() const noexcept { return value != invalid_index; }
  friend constexpr bool operator==(NodeId a, NodeId b) noexcept { return a.value == b.value; }
  friend constexpr bool operator!=(NodeId a, NodeId b) noexcept { return !(a == b); }
  friend constexpr bool operator<(NodeId a, NodeId b) noexcept { return a.value < b.value; }
};

struct ElementId {
  std::uint32_t value = invalid_index;

  constexpr bool valid() const noexcept { return value != invalid_index; }
  friend constexpr bool operator==(ElementId a, ElementId b) noexcept { return a.value == b.value; }
  friend constexpr bool operator!=(ElementId a, ElementId b) noexcept { return !(a == b); }
  friend constexpr bool operator<(ElementId a, ElementId b) noexcept { return a.value < b.value; }
};

} // namespace quadmesh
