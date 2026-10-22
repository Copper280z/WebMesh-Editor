#include "quadmesh/io.hpp"
#include "quadmesh/pipeline.hpp"
#include "quadmesh/svg.hpp"

#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <exception>
#include <limits>
#include <iostream>
#include <string>
#include <string_view>

namespace {

[[noreturn]] void usage(const char* program, int code)
{
  std::ostream& out = code == 0 ? std::cout : std::cerr;
  out << "Usage: " << program << " INPUT.svg [options]\n"
      << "  -o, --output FILE       mesh SVG output (default: mesh.svg)\n"
      << "  --bdf FILE              additionally write Nastran BDF\n"
      << "  --ppm FILE              additionally write PPM\n"
      << "  --size VALUE            target boundary cell size\n"
      << "  --curve-tolerance VALUE flattening tolerance in SVG units (default: 0.5)\n"
      << "  --fill COLOR            import only elements with this fill color\n"
      << "  --max-level N           maximum quadtree refinement level\n"
      << "  --force                 attempt meshing even when topology preflight fails\n";
  std::exit(code);
}

double parse_double(std::string_view value, std::string_view option)
{
  char* end = nullptr;
  const double parsed = std::strtod(value.data(), &end);
  if (end != value.data() + value.size() || !std::isfinite(parsed) || parsed <= 0.0) {
    throw std::runtime_error("invalid value for " + std::string(option));
  }
  return parsed;
}

unsigned parse_unsigned(std::string_view value, std::string_view option)
{
  unsigned parsed = 0;
  const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), parsed);
  if (error != std::errc{} || end != value.data() + value.size()) {
    throw std::runtime_error("invalid value for " + std::string(option));
  }
  return parsed;
}

} // namespace

int main(int argc, char** argv)
{
  try {
    if (argc < 2) usage(argv[0], 2);
    std::string input;
    std::string output = "mesh.svg";
    std::string bdf;
    std::string ppm;
    bool force = false;
    quadmesh::SvgImportOptions import;
    quadmesh::MeshingConfig config;
    for (int i = 1; i < argc; ++i) {
      const std::string_view arg(argv[i]);
      const auto value = [&](std::string_view option) -> std::string_view {
        if (++i == argc) throw std::runtime_error("missing value for " + std::string(option));
        return argv[i];
      };
      if (arg == "-h" || arg == "--help") usage(argv[0], 0);
      else if (arg == "-o" || arg == "--output") output = value(arg);
      else if (arg == "--bdf") bdf = value(arg);
      else if (arg == "--ppm") ppm = value(arg);
      else if (arg == "--size") config.refinement.target_cell_size = parse_double(value(arg), arg);
      else if (arg == "--curve-tolerance") import.curve_tolerance = parse_double(value(arg), arg);
      else if (arg == "--fill") import.fill = std::string(value(arg));
      else if (arg == "--force") force = true;
      else if (arg == "--max-level") {
        const unsigned level = parse_unsigned(value(arg), arg);
        if (level > std::numeric_limits<std::uint16_t>::max()) {
          throw std::runtime_error("invalid value for " + std::string(arg));
        }
        config.refinement.max_level = static_cast<std::uint16_t>(level);
      }
      else if (!arg.empty() && arg.front() == '-') throw std::runtime_error("unknown option " + std::string(arg));
      else if (input.empty()) input = arg;
      else throw std::runtime_error("only one SVG input is accepted");
    }
    if (input.empty()) usage(argv[0], 2);
    const quadmesh::SvgImportResult imported = quadmesh::read_svg(input, import);
    if (!imported.topology.meshable()) {
      std::cerr << "warning: imported " << imported.domain.outer_loops.size() << " loops and "
                << imported.topology.segment_count << " segments, but found at least "
                << imported.topology.conflict_count
                << " boundary crossings or contacts. quadmesh requires closed, non-touching "
                   "boundaries; no mesh was generated.\n";
      for (const std::string& issue : imported.topology.issues) {
        std::cerr << "warning: " << issue << '\n';
      }
      if (!force) {
        std::cerr << "hint: simplify/Boolean-union the SVG first, or use --force to attempt meshing "
                     "despite these conflicts.\n";
        return 2;
      }
      std::cerr << "warning: --force requested; meshing may be slow or invalid.\n";
    }
    const quadmesh::PipelineRunResult run = quadmesh::MeshingPipeline{}.run(imported.domain, config);
    quadmesh::write_mesh_svg(output, run.mesh, imported.domain);
    if (!bdf.empty()) quadmesh::write_nastran_bdf(bdf, run.mesh, input);
    if (!ppm.empty()) quadmesh::write_mesh_ppm(ppm, run.mesh, imported.domain);
    std::cout << "imported " << imported.domain.outer_loops.size() << " closed loops; wrote "
              << output << " with " << run.mesh.quads.size() << " quads\n";
    for (const std::string& warning : imported.warnings) std::cerr << "warning: " << warning << '\n';
    for (const std::string& warning : run.debug.warnings) std::cerr << "warning: " << warning << '\n';
    if (!run.validation.ok) {
      for (const std::string& issue : run.validation.issues) std::cerr << "validation: " << issue << '\n';
      return 1;
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "quadmesh_svg: " << error.what() << '\n';
    return 2;
  }
}
