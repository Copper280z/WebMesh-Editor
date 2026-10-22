#include "quadmesh/pipeline.hpp"
#include "quadmesh/io.hpp"

#include <chrono>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

int main(int argc, char** argv)
{
  if (argc < 3) { std::cerr << "usage: quadmesh_probe loops.txt size [fe|legacy] [output.svg]\n"; return 2; }
  try {
    std::ifstream in(argv[1]);
    std::size_t count;
    if (!(in >> count) || count == 0 || count > 10000) throw std::invalid_argument("invalid loop count");
    quadmesh::DomainGeometry domain;
    for (std::size_t j = 0; j < count; ++j) {
      std::size_t n;
      if (!(in >> n) || n < 3 || n > 1000000) throw std::invalid_argument("invalid point count");
      quadmesh::PolylineLoop loop;
      for (std::size_t k = 0; k < n; ++k) {
        quadmesh::Point2 p;
        if (!(in >> p.x >> p.y)) throw std::invalid_argument("invalid coordinate");
        loop.vertices.push_back(p);
      }
      if (j == 0) domain.outer_loops.push_back(loop);
      else domain.inner_loops.push_back({loop, quadmesh::InnerLoopRole::Hole});
    }
    quadmesh::MeshingConfig config;
    config.refinement.target_cell_size = std::stod(argv[2]);
    config.finite_element_sizing = argc > 3 && std::string(argv[3]) == "fe";
    config.enable_smoothing = true;
    const auto start = std::chrono::steady_clock::now();
    const auto r = quadmesh::MeshingPipeline{}.run(domain, config);
    const auto& v = r.validation;
    std::cout << "valid=" << v.ok << " quads=" << v.quad_count << " nodes=" << v.node_count
              << " min_angle=" << v.min_angle_deg << " min_sj=" << v.min_scaled_jacobian
              << " ms=" << std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count() << '\n';
    for (const auto& issue : v.issues) std::cout << issue << '\n';
    if (argc > 4) quadmesh::write_mesh_svg(argv[4], r.mesh, domain);
    return v.ok ? 0 : 1;
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
