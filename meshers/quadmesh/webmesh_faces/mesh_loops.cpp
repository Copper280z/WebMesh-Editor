// Mesh loops read from a text file (count, then per loop: n and n "x y" lines; first loop outer, rest holes).
#include "quadmesh/pipeline.hpp"
#include "quadmesh/io.hpp"
#include "quadmesh/quality.hpp"
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <map>
using namespace quadmesh;
int main(int argc, char** argv) {
  std::ifstream in(argv[1]);
  double size = std::atof(argv[2]);
  int loops; in >> loops;
  DomainGeometry domain;
  std::vector<std::vector<Point2>> input;
  for (int l = 0; l < loops; ++l) {
    int n; in >> n; PolylineLoop loop; loop.closed = true;
    for (int i = 0; i < n; ++i) { Point2 p; in >> p.x >> p.y; loop.vertices.push_back(p); }
    input.push_back(loop.vertices);
    if (l == 0) domain.outer_loops.push_back(loop); else domain.inner_loops.push_back({loop, InnerLoopRole::Hole});
  }
  MeshingConfig config; config.refinement.target_cell_size = size;
  auto t0 = std::chrono::steady_clock::now();
  auto result = MeshingPipeline{}.run(domain, config);
  double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  const auto& v = result.validation;
  std::printf("size %.3g: ok=%d quads=%zu nodes=%zu angles=[%.1f, %.1f] minSJ=%.3f edgeRatio=%.3f boundaryDev=%.4g (%.1f ms)\n", size, v.ok, v.quad_count, v.node_count, v.min_angle_deg, v.max_angle_deg, v.min_scaled_jacobian, v.min_edge_ratio, v.max_boundary_deviation, ms);
  for (auto& issue : v.issues) std::printf("  issue: %s\n", issue.c_str());
  // Boundary edges (single-sided) and how many input vertices are mesh nodes.
  std::map<std::pair<unsigned, unsigned>, int> use;
  for (auto& q : result.mesh.quads) for (int k = 0; k < 4; ++k) { unsigned a = q.nodes[k].value, b = q.nodes[(k + 1) % 4].value; use[{std::min(a, b), std::max(a, b)}]++; }
  size_t boundary = 0; for (auto& [e, n] : use) if (n == 1) boundary++;
  size_t kept = 0, total = 0;
  for (auto& loop : input) for (auto& p : loop) { total++; for (auto& node : result.mesh.nodes) if (std::hypot(node.point.x - p.x, node.point.y - p.y) < 1e-7) { kept++; break; } }
  std::printf("  boundary edges %zu; input vertices that are mesh nodes: %zu of %zu\n", boundary, kept, total);
  if (argc > 3) write_mesh_svg(argv[3], result.mesh, domain);
  return v.ok ? 0 : 1;
}
