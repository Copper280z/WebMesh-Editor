#pragma once

#include "quadmesh/geometry.hpp"
#include "quadmesh/mesh.hpp"

#include <string>

namespace quadmesh {

// Nastran bulk-data export: one GRID per node, one CQUAD4 per quad (all on
// property/material id 1). `title` becomes the leading comment line.
void write_nastran_bdf(const std::string& path, const GlobalMesh& mesh,
                       const std::string& title = "quadmesh export");

// Vector (SVG) render: quad edges plus the input loops of `domain` overlaid.
struct SvgStyle {
  // Longest side of the drawing area, in pixels; the shorter side and the
  // canvas follow the mesh aspect ratio.
  double size = 1020.0;
  double margin = 10.0;
  std::string mesh_color = "#456";
  double mesh_stroke = 0.7;
  std::string loop_color = "#d22";
  double loop_stroke = 1.2;
};

void write_mesh_svg(const std::string& path, const GlobalMesh& mesh,
                    const DomainGeometry& domain, const SvgStyle& style = {});

// Raster (binary-free ASCII PPM / P3) render of the mesh with the input loops
// overlaid. The view is fit to the mesh bounds with a uniform scale.
struct PpmStyle {
  int width = 1000;
  int height = 700;
  double margin = 36.0;
  // Draw a small marker over each node flagged on_boundary.
  bool mark_boundary_nodes = false;
};

void write_mesh_ppm(const std::string& path, const GlobalMesh& mesh,
                    const DomainGeometry& domain, const PpmStyle& style = {});

} // namespace quadmesh
