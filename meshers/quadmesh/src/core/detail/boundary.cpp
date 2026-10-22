#include "detail/boundary.hpp"

#include "detail/chain.hpp"
#include "quadmesh/mesher.hpp"
#include "quadmesh/quality.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
#include <numbers>
#include <queue>
#include <set>
#include <stdexcept>
#include <string>

namespace quadmesh::detail {
namespace {

std::vector<const PolylineLoop*> input_loops(const DomainGeometry& domain)
{
  std::vector<const PolylineLoop*> loops;
  for (const auto& loop : domain.outer_loops) loops.push_back(&loop);
  for (const auto& inner : domain.inner_loops) loops.push_back(&inner.loop);
  return loops;
}

struct Curve {
  const PolylineLoop& loop;
  std::size_t n;
  std::vector<double> lengths;
  explicit Curve(const PolylineLoop& l) : loop(l), n(l.vertices.size()), lengths{0.0}
  {
    if (n > 1 && distance(l.vertices.front(), l.vertices.back()) == 0.0) --n;
    if (!l.closed || n < 3) throw std::invalid_argument("prescribed boundaries require closed loops with at least three points");
    for (std::size_t i = 0; i < n; ++i) {
      const auto p = l.vertices[i];
      if (!std::isfinite(p.x) || !std::isfinite(p.y)) throw std::invalid_argument("non-finite boundary coordinate");
      lengths.push_back(lengths.back() + distance(p, l.vertices[(i + 1) % n]));
    }
    if (!(lengths.back() > 0.0)) throw std::invalid_argument("zero-length boundary loop");
    if (!l.vertex_kinds.empty() && l.vertex_kinds.size() != l.vertices.size())
      throw std::invalid_argument("vertex_kinds must have one entry per input vertex");
  }
  double total() const { return lengths.back(); }
  double arc(BoundaryPosition pos) const
  {
    if (pos.segment >= n || !std::isfinite(pos.parameter) || pos.parameter < 0 || pos.parameter > 1)
      throw std::invalid_argument("boundary position is outside its source segment");
    return lengths[pos.segment] + pos.parameter * (lengths[pos.segment + 1] - lengths[pos.segment]);
  }
  BoundaryPosition position(double s) const
  {
    s = std::fmod(s, total());
    if (s < 0) s += total();
    auto it = std::upper_bound(lengths.begin(), lengths.end(), s);
    const auto i = std::min<std::size_t>(n - 1, static_cast<std::size_t>(it - lengths.begin() - 1));
    const double len = lengths[i + 1] - lengths[i];
    return {static_cast<std::uint32_t>(i), len > 0 ? (s - lengths[i]) / len : 0};
  }
  Point2 point(double s) const
  {
    const auto pos = position(s);
    return loop.vertices[pos.segment] +
        (loop.vertices[(pos.segment + 1) % n] - loop.vertices[pos.segment]) * pos.parameter;
  }
  std::pair<BoundaryPosition, double> nearest(Point2 p) const
  {
    BoundaryPosition best;
    double dist = std::numeric_limits<double>::max();
    for (std::size_t i = 0; i < n; ++i) {
      const Point2 a = loop.vertices[i], b = loop.vertices[(i + 1) % n];
      const auto v = b - a;
      const double t = dot(v, v) > 0 ? std::clamp(dot(p - a, v) / dot(v, v), 0.0, 1.0) : 0;
      const double d = distance(p, a + v * t);
      if (d < dist) {
        dist = d;
        best = {static_cast<std::uint32_t>(i), t};
      }
    }
    if (best.parameter >= 1.0 - 1e-12) {
      best.segment = (best.segment + 1) % static_cast<std::uint32_t>(n);
      best.parameter = 0;
    }
    return {best, dist};
  }
};

bool circle_like(const Curve& c)
{
  if (c.n < 8) return false;
  for (auto k : c.loop.vertex_kinds) if (k == VertexKind::Corner) return false;
  const Point2 a = c.loop.vertices[0], b = c.loop.vertices[c.n / 3], d = c.loop.vertices[2 * c.n / 3];
  const Vec2 u = b - a, v = d - a;
  const double det = 2 * cross(u, v);
  if (std::abs(det) < 1e-14 * c.total() * c.total()) return false;
  const Point2 center = a + Vec2{(dot(u, u) * v.y - dot(v, v) * u.y) / det,
                               (u.x * dot(v, v) - v.x * dot(u, u)) / det};
  const double r = distance(center, a);
  for (std::size_t i = 0; i < c.n; ++i)
    if (std::abs(distance(center, c.loop.vertices[i]) - r) > 1e-5 * r) return false;
  return true;
}

bool inside(const std::vector<Point2>& poly, Point2 p)
{
  bool result = false;
  for (std::size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++)
    if ((poly[i].y > p.y) != (poly[j].y > p.y)
        && p.x < poly[i].x + (p.y - poly[i].y) * (poly[j].x - poly[i].x) / (poly[j].y - poly[i].y))
      result = !result;
  return result;
}

double area(const std::vector<Point2>& p)
{
  double a = 0;
  for (std::size_t i = 0; i < p.size(); ++i) a += cross(p[i] - p[0], p[(i + 1) % p.size()] - p[0]);
  return std::abs(a);
}

using Edge = std::pair<std::uint32_t, std::uint32_t>;
Edge edge_key(std::uint32_t a, std::uint32_t b) { return {std::min(a, b), std::max(a, b)}; }

} // namespace

bool uses_prescribed_boundary(const DomainGeometry& domain, const MeshingConfig& config)
{
  if (config.finite_element_sizing) return true;
  for (const auto* l : input_loops(domain)) if (!l->fixed_runs.empty()) return true;
  return false;
}

PreparedBoundary prepare_boundary(const DomainGeometry& domain, const MeshingConfig& config)
{
  if (config.elements_per_circle < 8 || config.elements_per_circle > 100000)
    throw std::invalid_argument("elements_per_circle must be between 8 and 100000");
  const auto loops = input_loops(domain);
  std::vector<Aabb2> loop_bounds;
  for (const auto* loop : loops) loop_bounds.push_back(bounds_of(*loop));
  if (domain.outer_loops.empty()) throw std::invalid_argument("domain requires an outer loop");
  const double extent = max_extent(bounds_of(domain));
  const double target = config.refinement.target_cell_size > 0 ? config.refinement.target_cell_size : extent / 24;
  if (!(target > 0) || !std::isfinite(target)) throw std::invalid_argument("target size must be finite and positive");
  const double eps = std::max(config.tolerances.absolute_distance, extent * 1e-10);
  GlobalMesh free_mesh;
  bool need_free = false;
  for (const auto* l : loops)
    if (l->fixed_runs.empty() || !l->fixed_runs.front().closed) need_free = true;
  if (need_free && !config.finite_element_sizing) {
    auto free_domain = domain;
    for (auto& l : free_domain.outer_loops) l.fixed_runs.clear();
    for (auto& l : free_domain.inner_loops) l.loop.fixed_runs.clear();
    auto free_config = config;
    free_config.enable_smoothing = false;
    free_mesh = build_mesh(free_domain, free_config);
  }
  PreparedBoundary result;
  for (std::size_t li = 0; li < loops.size(); ++li) {
    const Curve c(*loops[li]);
    const auto& input = *loops[li];
    struct Station { double arc; Point2 point; BoundaryNodeSource source; };
    std::vector<Station> stations;
    auto add = [&](double s, Point2 p, int run = -1, int node = -1) {
      const auto pos = c.position(s);
      stations.push_back({c.arc(pos), p, {{}, static_cast<std::uint32_t>(li), pos, run, node}});
    };
    const bool full = !input.fixed_runs.empty() && input.fixed_runs.front().closed;
    if (!full) {
      if (!config.finite_element_sizing) {
        for (const auto& node : free_mesh.nodes) if (node.on_boundary) {
          auto [pos, d] = c.nearest(node.point);
          if (d <= eps) add(c.arc(pos), node.point);
        }
      } else if (config.features.chord_tolerance_fraction == 0) {
        for (std::size_t k = 0; k < c.n; ++k) {
          if (c.lengths[k + 1] == c.lengths[k]) continue;
          add(c.lengths[k], input.vertices[k]);
          const double middle = (c.lengths[k] + c.lengths[k + 1]) / 2;
          add(middle, c.point(middle));
        }
      } else {
        double h = input.target_cell_size > 0 ? input.target_cell_size : target;
        Chain sizing;
        sizing.closed = true;
        sizing.sizing_samples = input.sizing_samples;
        for (const auto& sample : sizing.sizing_samples)
          if (!(sample.target_cell_size > 0) || !std::isfinite(sample.target_cell_size)
              || sample.arc_fraction < 0 || sample.arc_fraction > 1 || !std::isfinite(sample.arc_fraction))
            throw std::invalid_argument("invalid local sizing sample");
        std::stable_sort(sizing.sizing_samples.begin(), sizing.sizing_samples.end(),
                         [](const auto& a, const auto& b) { return a.arc_fraction < b.arc_fraction; });
        std::vector<std::size_t> corners;
        const bool circle = circle_like(c);
        if (!circle) for (std::size_t i = 0; i < c.n; ++i) {
          const auto kind = input.vertex_kinds.empty() ? VertexKind::Automatic : input.vertex_kinds[i];
          std::size_t prev = (i + c.n - 1) % c.n, next = (i + 1) % c.n;
          // Tiny tessellation remnants do not define a tangent.
          while (prev != i && distance(input.vertices[prev], input.vertices[i]) < extent * 1e-7)
            prev = (prev + c.n - 1) % c.n;
          while (next != i && distance(input.vertices[next], input.vertices[i]) < extent * 1e-7)
            next = (next + 1) % c.n;
          const double turn = turn_angle_deg(input.vertices[prev], input.vertices[i], input.vertices[next]);
          if (kind == VertexKind::Corner || (kind == VertexKind::Automatic && turn > config.features.feature_angle_deg))
            if (corners.empty() || distance(input.vertices[corners.back()], input.vertices[i]) > extent * 1e-7)
              corners.push_back(i);
        }
        if (corners.empty()) corners.push_back(0);
        for (std::size_t j = 0; j < corners.size(); ++j) {
          const std::size_t from = corners[j], to = corners[(j + 1) % corners.size()];
          const double begin = c.lengths[from];
          double end = c.lengths[to];
          if (end <= begin) end += c.total();
          double turn = circle ? 360.0 : 0;
          if (!circle) for (std::size_t k = (from + 1) % c.n; k != to; k = (k + 1) % c.n)
            turn += turn_angle_deg(input.vertices[(k + c.n - 1) % c.n], input.vertices[k], input.vertices[(k + 1) % c.n]);
          const double angular_count = turn * static_cast<double>(config.elements_per_circle) / 360.0;
          const double angular_size = angular_count > 0 ? (end - begin) / angular_count : c.total();
          const auto local_size = [&](double s) {
            double local = std::min({h, angular_size, sizing.target_size_at_fraction(s / c.total(), h)});
            const Point2 p = c.point(s);
            for (std::size_t other = 0; other < loops.size(); ++other) {
              if (other == li) continue;
              const auto& box = loop_bounds[other];
              const double dx = std::max({box.min.x - p.x, p.x - box.max.x, 0.0});
              const double dy = std::max({box.min.y - p.y, p.y - box.max.y, 0.0});
              if (std::hypot(dx, dy) * 0.9 >= local) continue;
              const auto& v = loops[other]->vertices;
              for (std::size_t k = 0; k < v.size(); ++k) {
                const double d = distance_to_segment(p, {v[k], v[(k + 1) % v.size()]});
                if (d <= eps) throw std::invalid_argument("boundary loops touch or intersect");
                local = std::min(local, 0.9 * d);
              }
            }
            return local;
          };
          // Integrate inverse size, then invert that metric to distribute
          // nodes. A nearby hole or local sample refines only its own arc.
          constexpr int resolution = 256;
          std::vector<double> metric(resolution + 1, 0);
          double previous_size = local_size(begin);
          for (int k = 1; k <= resolution; ++k) {
            const double next_size = local_size(begin + (end - begin) * k / resolution);
            metric[k] = metric[k - 1] + (end - begin) / resolution * 0.5 * (1 / previous_size + 1 / next_size);
            previous_size = next_size;
          }
          auto count = static_cast<std::size_t>(std::ceil(metric.back() - 1e-9));
          count = std::max<std::size_t>(1, count);
          if (corners.size() == 1) count = std::max<std::size_t>(8, count);
          // Keep geometric corners at patch corners. An even number of
          // edges between features permits paired boundary subdivision
          // without replacing a sharp turn by an edge midpoint.
          if (count % 2 != 0) ++count;
          std::vector<double> positions;
          for (;;) {
            if (count > 1000000) throw std::invalid_argument("requested boundary sampling is too large");
            positions.clear();
            for (std::size_t k = 0; k < count; ++k) {
              const double desired = metric.back() * static_cast<double>(k) / static_cast<double>(count);
              auto it = std::upper_bound(metric.begin(), metric.end(), desired);
              const auto at = std::min<std::size_t>(resolution - 1, static_cast<std::size_t>(it - metric.begin() - 1));
              const double fraction = (desired - metric[at]) / (metric[at + 1] - metric[at]);
              positions.push_back(begin + (end - begin) * (static_cast<double>(at) + fraction) / resolution);
            }
            positions.push_back(end);
            bool accurate = true;
            for (std::size_t k = 0; k < count && accurate; ++k) {
              const Point2 a = c.point(positions[k]), b = c.point(positions[k + 1]);
              const double allowed = std::max(eps, config.features.chord_tolerance_fraction * distance(a, b));
              for (std::size_t v = 0; v < c.n; ++v) {
                double s = c.lengths[v];
                if (s < positions[k]) s += c.total();
                if (s > positions[k] && s < positions[k + 1]
                    && distance_to_segment(input.vertices[v], {a, b}) > allowed) {
                  accurate = false; break;
                }
              }
            }
            if (accurate) break;
            count *= 2;
          }
          for (std::size_t k = 0; k < count; ++k) add(positions[k], c.point(positions[k]));
        }
      }
    }
    std::vector<std::pair<double, double>> intervals;
    for (std::size_t ri = 0; ri < input.fixed_runs.size(); ++ri) {
      const auto& run = input.fixed_runs[ri];
      if (run.nodes.size() < (run.closed ? 3U : 2U))
        throw std::invalid_argument("fixed run has too few nodes");
      if (run.closed && input.fixed_runs.size() != 1)
        throw std::invalid_argument("a fixed closed loop cannot have additional fixed runs");
      const double begin = c.arc(run.start);
      double end = run.closed ? begin + c.total() : c.arc(run.end);
      if (!run.closed && end <= begin) end += c.total();
      for (auto [a, b] : intervals) for (int shift = -1; shift <= 1; ++shift)
        if (std::min(end, b + shift * c.total()) - std::max(begin, a + shift * c.total()) > eps)
          throw std::invalid_argument("overlapping fixed boundary runs");
      intervals.push_back({begin, end});
      stations.erase(std::remove_if(stations.begin(), stations.end(), [&](const Station& s) {
        double t = s.arc;
        if (t < begin - eps) t += c.total();
        return t >= begin - eps && t <= end + eps;
      }), stations.end());
      double previous = begin - eps;
      for (std::size_t ni = 0; ni < run.nodes.size(); ++ni) {
        const auto p = run.nodes[ni];
        if (!std::isfinite(p.x) || !std::isfinite(p.y)) throw std::invalid_argument("non-finite fixed node");
        const auto [pos, d] = c.nearest(p);
        const double adjacent = distance(p, run.nodes[(ni + 1) % run.nodes.size()]);
        const double tolerance = std::max(eps, config.features.chord_tolerance_fraction * adjacent);
        if (d > tolerance) throw std::invalid_argument("fixed node is off its source loop");
        double s = c.arc(pos);
        if (s < begin - eps) s += c.total();
        if (s <= previous && ni != 0)
          throw std::invalid_argument("fixed nodes must be distinct and follow the loop direction");
        if (s > end + eps) throw std::invalid_argument("fixed node is outside its run");
        if ((ni == 0 && distance(p, c.point(begin)) > tolerance)
            || (!run.closed && ni + 1 == run.nodes.size() && distance(p, c.point(end)) > tolerance))
          throw std::invalid_argument("fixed run endpoints do not match start/end");
        add(s, p, static_cast<int>(ri), static_cast<int>(ni));
        previous = s;
      }
    }
    std::stable_sort(stations.begin(), stations.end(), [](const Station& a, const Station& b) { return a.arc < b.arc; });
    SampledLoop sampled;
    if (li >= domain.outer_loops.size()) {
      sampled.hole = domain.inner_loops[li - domain.outer_loops.size()].role == InnerLoopRole::Hole;
      sampled.control = !sampled.hole;
    }
    for (const auto& s : stations) {
      const bool fixed_pair = !sampled.sources.empty() && s.source.fixed_run >= 0 && sampled.sources.back().fixed_run >= 0;
      if (!sampled.points.empty() && (distance(sampled.points.back(), s.point) == 0
          || (!fixed_pair && distance(sampled.points.back(), s.point) < eps))) {
        if (s.source.fixed_run >= 0) {
          sampled.points.back() = s.point;
          sampled.sources.back() = s.source;
        }
      } else {
        sampled.points.push_back(s.point);
        sampled.sources.push_back(s.source);
      }
    }
    if (sampled.points.size() < 3) throw std::invalid_argument("boundary sampling produced fewer than three nodes");
    sampled.fixed_edges.assign(sampled.points.size(), -1);
    sampled.fixed_edge_indices.assign(sampled.points.size(), -1);
    for (std::size_t i = 0; i < sampled.points.size(); ++i) {
      for (std::size_t ri = 0; ri < input.fixed_runs.size(); ++ri) {
        const auto& run = input.fixed_runs[ri];
        for (std::size_t k = 0; k + (run.closed ? 0U : 1U) < run.nodes.size(); ++k)
          if (distance(sampled.points[i], run.nodes[k]) == 0
              && distance(sampled.points[(i + 1) % sampled.points.size()], run.nodes[(k + 1) % run.nodes.size()]) == 0) {
            sampled.fixed_edges[i] = static_cast<int>(ri);
            sampled.fixed_edge_indices[i] = static_cast<int>(k);
          }
      }
    }
    result.loops.push_back(std::move(sampled));
  }

  // A control loop separates two meshed regions. A free run can change both
  // regions' parities, so solve the region graph before adding any nodes.
  const int exterior = static_cast<int>(result.loops.size());
  std::vector<int> parent(result.loops.size(), -1);
  for (std::size_t i = 0; i < result.loops.size(); ++i) {
    double best = std::numeric_limits<double>::max();
    const double own = area(result.loops[i].points);
    for (std::size_t j = 0; j < result.loops.size(); ++j) if (j != i) {
      const double a = area(result.loops[j].points);
      if (a > own && a < best && inside(result.loops[j].points, result.loops[i].points[0])) {
        parent[i] = static_cast<int>(j); best = a;
      }
    }
  }
  std::vector<bool> odd(result.loops.size() + 1, false);
  for (int region = 0; region < exterior; ++region) {
    if (result.loops[region].hole) continue;
    std::vector<int> boundaries{region};
    for (std::size_t j = 0; j < parent.size(); ++j) if (parent[j] == region) boundaries.push_back(static_cast<int>(j));
    std::size_t count = 0;
    for (int j : boundaries) count += result.loops[j].points.size();
    odd[region] = count % 2 != 0;
  }
  std::vector<std::size_t> free_edge(result.loops.size(), 0);
  std::vector<std::vector<std::pair<int, int>>> graph(result.loops.size() + 1);
  for (int j = 0; j < exterior; ++j) {
    double longest = -1;
    const auto& loop = result.loops[j];
    for (std::size_t k = 0; k < loop.points.size(); ++k) if (loop.fixed_edges[k] < 0) {
      const double len = distance(loop.points[k], loop.points[(k + 1) % loop.points.size()]);
      if (len > longest) { longest = len; free_edge[j] = k; }
    }
    if (longest < 0) continue;
    const int a = loop.hole ? exterior : j;
    const int b = parent[j] < 0 || result.loops[parent[j]].hole ? exterior : parent[j];
    if (a == b) continue;
    graph[a].push_back({b, j});
    graph[b].push_back({a, j});
  }
  std::set<int> split_loops;
  for (int region = 0; region < exterior; ++region) if (odd[region]) {
    std::vector<int> previous(graph.size(), -1), via(graph.size(), -1);
    std::queue<int> queue;
    queue.push(region); previous[region] = region;
    int found = -1;
    while (!queue.empty() && found < 0) {
      const int at = queue.front(); queue.pop();
      for (auto [next, loop] : graph[at]) if (previous[next] < 0) {
        previous[next] = at; via[next] = loop;
        if (next == exterior || odd[next]) { found = next; break; }
        queue.push(next);
      }
    }
    if (found < 0)
      throw std::invalid_argument("odd boundary edge count in region " + std::to_string(region)
                                  + " with no free run to absorb parity");
    odd[region] = false;
    odd[found] = false;
    for (int at = found; at != region; at = previous[at]) {
      if (split_loops.contains(via[at])) split_loops.erase(via[at]);
      else split_loops.insert(via[at]);
    }
  }
  for (int loop_index : split_loops) {
    auto& loop = result.loops[loop_index];
    const std::size_t best_edge = free_edge[loop_index];
    const Curve c(*loops[loop_index]);
    double a = c.arc(loop.sources[best_edge].position), b = c.arc(loop.sources[(best_edge + 1) % loop.points.size()].position);
    if (b <= a) b += c.total();
    const double s = (a + b) / 2;
    loop.points.insert(loop.points.begin() + static_cast<std::ptrdiff_t>(best_edge + 1), c.point(s));
    loop.sources.insert(loop.sources.begin() + static_cast<std::ptrdiff_t>(best_edge + 1),
                        {{}, static_cast<std::uint32_t>(loop_index), c.position(s), -1, -1});
    loop.fixed_edges.insert(loop.fixed_edges.begin() + static_cast<std::ptrdiff_t>(best_edge + 1), -1);
    loop.fixed_edge_indices.insert(loop.fixed_edge_indices.begin() + static_cast<std::ptrdiff_t>(best_edge + 1), -1);
  }
  for (std::size_t i = 0; i < result.loops.size(); ++i) {
    PolylineLoop loop;
    loop.vertices = result.loops[i].points;
    if (i < domain.outer_loops.size()) result.geometry.outer_loops.push_back(std::move(loop));
    else result.geometry.inner_loops.push_back({std::move(loop), domain.inner_loops[i - domain.outer_loops.size()].role});
  }
  return result;
}

void attach_boundary_sources(GlobalMesh& mesh, const DomainGeometry& domain, const PreparedBoundary* prepared)
{
  mesh.boundary_nodes.clear();
  mesh.boundary_edges.clear();
  const auto inputs = input_loops(domain);
  std::set<Edge> edges;
  for (const auto& q : mesh.quads) for (int k = 0; k < 4; ++k)
    edges.insert(edge_key(q.nodes[k].value, q.nodes[(k + 1) % 4].value));
  const double eps = std::max(1e-9, max_extent(bounds_of(domain)) * 1e-9);
  std::vector<std::vector<BoundaryNodeSource>> by_loop(inputs.size());
  if (prepared) {
    std::map<std::pair<double, double>, std::uint32_t> lookup;
    for (std::size_t i = 0; i < mesh.nodes.size(); ++i)
      if (mesh.nodes[i].on_boundary) lookup[{mesh.nodes[i].point.x, mesh.nodes[i].point.y}] = static_cast<std::uint32_t>(i);
    for (std::size_t li = 0; li < prepared->loops.size(); ++li) {
      const auto& loop = prepared->loops[li];
      for (std::size_t j = 0; j < loop.points.size(); ++j) {
        const auto found = lookup.find({loop.points[j].x, loop.points[j].y});
        if (found == lookup.end()) throw std::logic_error("prescribed boundary node lost during meshing");
        auto source = loop.sources[j];
        source.node = NodeId{found->second};
        by_loop[li].push_back(source);
      }
    }
  } else {
    for (std::size_t li = 0; li < inputs.size(); ++li) {
      if (!inputs[li]->closed || inputs[li]->vertices.size() < 3) continue;
      const Curve curve(*inputs[li]);
      for (std::size_t i = 0; i < mesh.nodes.size(); ++i) if (mesh.nodes[i].on_boundary) {
        const auto [pos, d] = curve.nearest(mesh.nodes[i].point);
        if (d <= eps) by_loop[li].push_back({NodeId{static_cast<std::uint32_t>(i)}, static_cast<std::uint32_t>(li), pos, -1, -1});
      }
      std::stable_sort(by_loop[li].begin(), by_loop[li].end(), [](const auto& a, const auto& b) {
        return a.position.segment + a.position.parameter < b.position.segment + b.position.parameter;
      });
    }
  }
  for (std::size_t li = 0; li < by_loop.size(); ++li) {
    const auto& sources = by_loop[li];
    if (sources.empty()) continue;
    const Curve curve(*inputs[li]);
    for (std::size_t i = 0; i < sources.size(); ++i) {
      mesh.boundary_nodes.push_back(sources[i]);
      const auto& a = sources[i];
      const auto& b = sources[(i + 1) % sources.size()];
      if (!edges.contains(edge_key(a.node.value, b.node.value))) {
        if (prepared) throw std::logic_error("prescribed boundary edge lost during meshing");
        continue;
      }
      const double begin = a.position.segment + a.position.parameter;
      double end = b.position.segment + b.position.parameter;
      if (end <= begin) end += static_cast<double>(curve.n);
      for (double s = begin; s < end - 1e-12;) {
        const double next = std::min(end, std::floor(s) + 1);
        const auto seg = static_cast<std::uint32_t>(static_cast<std::size_t>(std::floor(s)) % curve.n);
        const int run = prepared ? prepared->loops[li].fixed_edges[i] : -1;
        const int fixed_edge = prepared ? prepared->loops[li].fixed_edge_indices[i] : -1;
        mesh.boundary_edges.push_back({{a.node, b.node}, static_cast<std::uint32_t>(li), seg,
                                      s - std::floor(s), next - std::floor(s), run, fixed_edge});
        s = next;
      }
    }
    // Junctions belong to both adjacent fixed runs.
    if (prepared) for (std::size_t ri = 0; ri < inputs[li]->fixed_runs.size(); ++ri) {
      const auto& run = inputs[li]->fixed_runs[ri];
      for (std::size_t k = 0; k < run.nodes.size(); ++k)
        for (const auto& source : sources)
          if (distance(mesh.nodes[source.node.value].point, run.nodes[k]) == 0
              && (source.fixed_run != static_cast<int>(ri) || source.fixed_node != static_cast<int>(k))) {
            auto extra = source;
            extra.fixed_run = static_cast<int>(ri); extra.fixed_node = static_cast<int>(k);
            mesh.boundary_nodes.push_back(extra);
          }
    }
  }
}

void smooth_interior(GlobalMesh& mesh, std::uint32_t iterations)
{
  std::vector<std::vector<std::size_t>> incident(mesh.nodes.size());
  std::vector<std::set<std::uint32_t>> neighbors(mesh.nodes.size());
  for (std::size_t qi = 0; qi < mesh.quads.size(); ++qi) {
    const auto& q = mesh.quads[qi];
    for (int k = 0; k < 4; ++k) {
      const auto n = q.nodes[k].value;
      incident[n].push_back(qi);
      neighbors[n].insert(q.nodes[(k + 1) % 4].value);
      neighbors[n].insert(q.nodes[(k + 3) % 4].value);
    }
  }
  for (std::uint32_t iter = 0; iter < iterations; ++iter) {
    bool changed = false;
    for (std::size_t i = 0; i < mesh.nodes.size(); ++i) {
      if (mesh.nodes[i].on_boundary || neighbors[i].empty()) continue;
      auto score = [&] {
        double worst = 1.0, ratio = 1.0;
        for (auto q : incident[i]) {
          worst = std::min(worst, quad_quality(mesh, mesh.quads[q]).min_scaled_jacobian);
          double shortest = std::numeric_limits<double>::max(), longest = 0;
          for (int k = 0; k < 4; ++k) {
            const auto& ids = mesh.quads[q].nodes;
            const double edge = distance(mesh.nodes[ids[k].value].point, mesh.nodes[ids[(k + 1) % 4].value].point);
            shortest = std::min(shortest, edge); longest = std::max(longest, edge);
          }
          ratio = std::min(ratio, longest > 0 ? shortest / longest : 0);
        }
        return std::pair{worst, ratio};
      };
      const Point2 original = mesh.nodes[i].point;
      Point2 average{};
      double scale = 0;
      for (auto j : neighbors[i]) {
        average.x += mesh.nodes[j].point.x; average.y += mesh.nodes[j].point.y;
        scale += distance(original, mesh.nodes[j].point);
      }
      average.x /= static_cast<double>(neighbors[i].size());
      average.y /= static_cast<double>(neighbors[i].size());
      scale /= static_cast<double>(neighbors[i].size());
      Point2 best = original;
      const auto initial = score();
      double best_score = initial.first;
      const double ratio_floor = std::min(0.1, initial.second);
      auto consider = [&](Point2 candidate) {
        mesh.nodes[i].point = candidate;
        const auto [q, ratio] = score();
        if (q > best_score + 1e-10 && ratio >= ratio_floor - 1e-12) {
          best = candidate; best_score = q; changed = true;
        }
      };
      consider(average);
      consider(original + (average - original) * 0.5);
      double step = 0.15 * scale;
      for (int pass = 0; pass < 4; ++pass) {
        const Point2 center = best;
        for (const Vec2 dir : {Vec2{1, 0}, {-1, 0}, {0, 1}, {0, -1}, {.707, .707}, {-.707, .707}, {.707, -.707}, {-.707, -.707}})
          consider(center + dir * step);
        step *= 0.5;
      }
      mesh.nodes[i].point = best;
    }
    if (!changed) break;
  }
}

} // namespace quadmesh::detail
