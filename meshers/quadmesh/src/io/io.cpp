#include "quadmesh/io.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <vector>

namespace quadmesh {
namespace {

// Axis-aligned bounds of the mesh node cloud. Falls back to the unit box when
// the mesh has no nodes so the coordinate mapping stays well defined.
Aabb2 mesh_bounds(const GlobalMesh& mesh) noexcept {
  if (mesh.nodes.empty()) {
    return Aabb2{{0.0, 0.0}, {1.0, 1.0}};
  }
  Aabb2 bounds{mesh.nodes.front().point, mesh.nodes.front().point};
  for (const MeshNode& node : mesh.nodes) {
    bounds.min.x = std::min(bounds.min.x, node.point.x);
    bounds.min.y = std::min(bounds.min.y, node.point.y);
    bounds.max.x = std::max(bounds.max.x, node.point.x);
    bounds.max.y = std::max(bounds.max.y, node.point.y);
  }
  return bounds;
}

struct Rgb {
  std::uint8_t r = 255;
  std::uint8_t g = 255;
  std::uint8_t b = 255;
};

struct Image {
  int width;
  int height;
  std::vector<Rgb> pixels;

  Image(int w, int h)
      : width(w), height(h),
        pixels(static_cast<std::size_t>(w) * static_cast<std::size_t>(h)) {}

  void set(int x, int y, Rgb color) noexcept {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return;
    }
    pixels[static_cast<std::size_t>(y) * static_cast<std::size_t>(width) +
           static_cast<std::size_t>(x)] = color;
  }
};

// Bresenham line.
void draw_line(Image& image, std::array<int, 2> a, std::array<int, 2> b,
               Rgb color) noexcept {
  int x0 = a[0];
  int y0 = a[1];
  const int x1 = b[0];
  const int y1 = b[1];
  const int dx = std::abs(x1 - x0);
  const int sx = x0 < x1 ? 1 : -1;
  const int dy = -std::abs(y1 - y0);
  const int sy = y0 < y1 ? 1 : -1;
  int err = dx + dy;
  for (;;) {
    image.set(x0, y0, color);
    if (x0 == x1 && y0 == y1) {
      break;
    }
    const int e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

} // namespace

void write_nastran_bdf(const std::string& path, const GlobalMesh& mesh,
                       const std::string& title) {
  std::ofstream out(path);
  out << "$ " << title << "\n";
  out << "BEGIN BULK\n";
  for (std::size_t i = 0; i < mesh.nodes.size(); ++i) {
    const Point2 p = mesh.nodes[i].point;
    out << "GRID," << (i + 1U) << ",," << p.x << "," << p.y << ",0.0\n";
  }
  for (std::size_t i = 0; i < mesh.quads.size(); ++i) {
    const Quad4& q = mesh.quads[i];
    out << "CQUAD4," << (i + 1U) << ",1," << (q.nodes[0].value + 1U) << ","
        << (q.nodes[1].value + 1U) << "," << (q.nodes[2].value + 1U) << ","
        << (q.nodes[3].value + 1U) << "\n";
  }
  out << "ENDDATA\n";
}

void write_mesh_svg(const std::string& path, const GlobalMesh& mesh,
                    const DomainGeometry& domain, const SvgStyle& style) {
  const Aabb2 bounds = mesh_bounds(mesh);
  const double extent = std::max({width(bounds), height(bounds), 1.0e-12});
  const double scale = style.size / extent;
  const double canvas_w = width(bounds) * scale + 2.0 * style.margin;
  const double canvas_h = height(bounds) * scale + 2.0 * style.margin;
  const auto x = [&](double v) { return style.margin + (v - bounds.min.x) * scale; };
  const auto y = [&](double v) {
    return style.margin + (bounds.max.y - v) * scale;
  };

  std::ofstream svg(path);
  svg << "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" << canvas_w
      << "\" height=\"" << canvas_h << "\">\n";
  svg << "<rect width=\"100%\" height=\"100%\" fill=\"white\"/>\n";
  for (const Quad4& quad : mesh.quads) {
    svg << "<polygon points=\"";
    for (const NodeId node : quad.nodes) {
      const Point2 p = mesh.nodes[node.value].point;
      svg << x(p.x) << "," << y(p.y) << " ";
    }
    svg << "\" fill=\"none\" stroke=\"" << style.mesh_color
        << "\" stroke-width=\"" << style.mesh_stroke << "\"/>\n";
  }
  const auto draw_loop = [&](const PolylineLoop& loop) {
    if (loop.vertices.empty()) {
      return;
    }
    svg << "<polygon points=\"";
    for (const Point2 p : loop.vertices) {
      svg << x(p.x) << "," << y(p.y) << " ";
    }
    svg << "\" fill=\"none\" stroke=\"" << style.loop_color
        << "\" stroke-width=\"" << style.loop_stroke << "\"/>\n";
  };
  for (const PolylineLoop& loop : domain.outer_loops) {
    draw_loop(loop);
  }
  for (const InnerLoop& inner : domain.inner_loops) {
    draw_loop(inner.loop);
  }
  svg << "</svg>\n";
}

void write_mesh_ppm(const std::string& path, const GlobalMesh& mesh,
                    const DomainGeometry& domain, const PpmStyle& style) {
  Image image(style.width, style.height);
  const Aabb2 bounds = mesh_bounds(mesh);
  const Rgb mesh_line{55, 80, 105};
  const Rgb outer_line{20, 20, 20};
  const Rgb inner_line{205, 30, 35};
  const Rgb boundary_node{200, 35, 35};

  const double sx = (static_cast<double>(style.width) - 2.0 * style.margin) /
                    std::max(1.0e-12, width(bounds));
  const double sy = (static_cast<double>(style.height) - 2.0 * style.margin) /
                    std::max(1.0e-12, height(bounds));
  const double scale = std::min(sx, sy);
  const double used_w = width(bounds) * scale;
  const double used_h = height(bounds) * scale;
  const double ox = (static_cast<double>(style.width) - used_w) / 2.0;
  const double oy = (static_cast<double>(style.height) - used_h) / 2.0;
  const auto map_point = [&](Point2 p) -> std::array<int, 2> {
    const int x =
        static_cast<int>(std::lround(ox + (p.x - bounds.min.x) * scale));
    const int y = static_cast<int>(std::lround(
        static_cast<double>(style.height) - oy - (p.y - bounds.min.y) * scale));
    return {x, y};
  };

  for (const Quad4& quad : mesh.quads) {
    for (std::size_t i = 0; i < 4; ++i) {
      const Point2 a = mesh.nodes[quad.nodes[i].value].point;
      const Point2 b = mesh.nodes[quad.nodes[(i + 1U) % 4U].value].point;
      draw_line(image, map_point(a), map_point(b), mesh_line);
    }
  }
  const auto draw_loop = [&](const PolylineLoop& loop, Rgb color) {
    for (std::size_t i = 0; i < loop.vertices.size(); ++i) {
      const Point2 a = loop.vertices[i];
      const Point2 b = loop.vertices[(i + 1U) % loop.vertices.size()];
      draw_line(image, map_point(a), map_point(b), color);
    }
  };
  for (const PolylineLoop& loop : domain.outer_loops) {
    draw_loop(loop, outer_line);
  }
  for (const InnerLoop& inner : domain.inner_loops) {
    draw_loop(inner.loop, inner_line);
  }

  if (style.mark_boundary_nodes) {
    for (const MeshNode& node : mesh.nodes) {
      if (!node.on_boundary) {
        continue;
      }
      const std::array<int, 2> xy = map_point(node.point);
      for (int dy = -2; dy <= 2; ++dy) {
        for (int dx = -2; dx <= 2; ++dx) {
          image.set(xy[0] + dx, xy[1] + dy, boundary_node);
        }
      }
    }
  }

  std::ofstream out(path);
  out << "P3\n" << image.width << " " << image.height << "\n255\n";
  for (const Rgb pixel : image.pixels) {
    out << static_cast<int>(pixel.r) << ' ' << static_cast<int>(pixel.g) << ' '
        << static_cast<int>(pixel.b) << '\n';
  }
}

} // namespace quadmesh
