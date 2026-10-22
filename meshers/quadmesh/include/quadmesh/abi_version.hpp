#pragma once

#include <cstdint>

namespace quadmesh {

inline constexpr std::uint32_t abi_version_major = 0;
inline constexpr std::uint32_t abi_version_minor = 2;
inline constexpr std::uint32_t abi_version_patch = 0;
inline constexpr std::uint32_t abi_version =
    (abi_version_major << 24U) | (abi_version_minor << 12U) | abi_version_patch;

} // namespace quadmesh
