#include "quadmesh_c/quadmesh.h"

#include "quadmesh/abi_version.hpp"
#include "quadmesh/pipeline.hpp"
#include "quadmesh/quality.hpp"

#include <cmath>
#include <cstddef>
#include <exception>
#include <memory>
#include <new>
#include <string>

struct mq_context {
  std::string last_error;
};

struct mq_domain {
  quadmesh::DomainGeometry domain;
};

struct mq_mesh {
  quadmesh::GlobalMesh mesh;
};

struct mq_validation_report {
  quadmesh::ValidationReport report;
};

struct mq_options {
  quadmesh::MeshingConfig config;
};

static_assert(sizeof(mq_boundary_node_t) == 32 && offsetof(mq_boundary_node_t, parameter) == 24);
static_assert(sizeof(mq_boundary_edge_t) == 40 && offsetof(mq_boundary_edge_t, parameter_start) == 24);

namespace {

mq_status_t set_error(mq_context_t* ctx, mq_status_t status, const char* message)
{
  if (ctx != nullptr) {
    ctx->last_error = message == nullptr ? "" : message;
  }
  return status;
}

quadmesh::MeshingConfig convert_config(const mq_meshing_config_t* config)
{
  quadmesh::MeshingConfig converted;
  if (config == nullptr) {
    return converted;
  }
  if (config->max_refinement_level != 0U) {
    converted.refinement.max_level = config->max_refinement_level;
  }
  converted.refinement.target_cell_size = config->target_cell_size;
  converted.enable_smoothing = config->enable_smoothing != 0;
  return converted;
}

quadmesh::InnerLoopRole convert_role(mq_inner_loop_role_t role)
{
  switch (role) {
  case MQ_INNER_LOOP_HOLE:
    return quadmesh::InnerLoopRole::Hole;
  case MQ_INNER_LOOP_MESH_CONTROL_FEATURE:
    return quadmesh::InnerLoopRole::MeshControlFeature;
  }
  throw std::invalid_argument("unknown inner loop role");
}

mq_status_t map_exception(mq_context_t* ctx)
{
  try {
    throw;
  } catch (const std::bad_alloc&) {
    return set_error(ctx, MQ_STATUS_ALLOCATION_FAILURE, "allocation failure");
  } catch (const std::invalid_argument& e) {
    return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, e.what());
  } catch (const std::logic_error& e) {
    return set_error(ctx, MQ_STATUS_INVARIANT_FAILURE, e.what());
  } catch (const std::exception& e) {
    return set_error(ctx, MQ_STATUS_INTERNAL_ERROR, e.what());
  } catch (...) {
    return set_error(ctx, MQ_STATUS_INTERNAL_ERROR, "unknown error");
  }
}

quadmesh::PolylineLoop& get_loop(mq_domain_t* domain, uint32_t index)
{
  if (domain == nullptr) throw std::invalid_argument("null domain");
  if (index < domain->domain.outer_loops.size()) return domain->domain.outer_loops[index];
  const auto inner = index - domain->domain.outer_loops.size();
  if (inner >= domain->domain.inner_loops.size()) throw std::invalid_argument("loop index is out of range");
  return domain->domain.inner_loops[inner].loop;
}

void check_size(double size)
{
  if (!std::isfinite(size) || size < 0) throw std::invalid_argument("target size must be finite and nonnegative");
}

mq_status_t generate(mq_context_t* ctx, const mq_domain_t* domain, const quadmesh::MeshingConfig& config,
                     mq_mesh_t** out_mesh, mq_validation_report_t** out_report)
{
  if (out_mesh) *out_mesh = nullptr;
  if (out_report) *out_report = nullptr;
  if (!ctx || !domain || !out_mesh)
    return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "mesh generation requires context, domain and output mesh");
  try {
    auto run = quadmesh::MeshingPipeline{}.run(domain->domain, config);
    auto mesh = std::make_unique<mq_mesh>();
    mesh->mesh = std::move(run.mesh);
    std::unique_ptr<mq_validation_report> report;
    if (out_report) {
      report = std::make_unique<mq_validation_report>();
      report->report = std::move(run.validation);
    }
    *out_mesh = mesh.release();
    if (out_report) *out_report = report.release();
    ctx->last_error.clear();
    return MQ_STATUS_SUCCESS;
  } catch (...) { return map_exception(ctx); }
}

} // namespace

extern "C" {

uint32_t mq_abi_version(void)
{
  return quadmesh::abi_version;
}

mq_status_t mq_context_create(mq_context_t** out_ctx)
{
  if (out_ctx == nullptr) {
    return MQ_STATUS_INVALID_ARGUMENT;
  }
  try {
    *out_ctx = new mq_context();
    return MQ_STATUS_SUCCESS;
  } catch (...) {
    *out_ctx = nullptr;
    return MQ_STATUS_ALLOCATION_FAILURE;
  }
}

void mq_context_destroy(mq_context_t* ctx)
{
  delete ctx;
}

const char* mq_context_last_error(const mq_context_t* ctx)
{
  if (ctx == nullptr) {
    return "null context";
  }
  return ctx->last_error.c_str();
}

mq_status_t mq_options_create(mq_context_t* ctx, mq_options_t** out_options)
{
  if (out_options) *out_options = nullptr;
  if (!ctx || !out_options) return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "options require context and output pointer");
  try { *out_options = new mq_options(); ctx->last_error.clear(); return MQ_STATUS_SUCCESS; }
  catch (...) { return map_exception(ctx); }
}

void mq_options_destroy(mq_options_t* options) { delete options; }

mq_status_t mq_options_set(mq_context_t* ctx, mq_options_t* options, mq_option_t key, double value)
{
  if (!ctx || !options || !std::isfinite(value))
    return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "options require context, handle and finite value");
  try {
    const auto integer = [&](double low, double high) {
      if (value < low || value > high || std::floor(value) != value)
        throw std::invalid_argument("integer option is out of range");
      return static_cast<uint32_t>(value);
    };
    auto& c = options->config;
    switch (key) {
    case MQ_OPTION_TARGET_SIZE: check_size(value); c.refinement.target_cell_size = value; break;
    case MQ_OPTION_MAX_REFINEMENT_LEVEL: c.refinement.max_level = static_cast<uint16_t>(integer(1, 24)); break;
    case MQ_OPTION_LOCAL_SIZING_PROMOTION:
      c.refinement.sizing_promotion = integer(0, 1) ? quadmesh::SizingPromotionMode::Local : quadmesh::SizingPromotionMode::WholeLoop; break;
    case MQ_OPTION_FEATURE_ANGLE:
      if (value < 0 || value > 180) throw std::invalid_argument("feature angle must be in [0,180]");
      c.features.feature_angle_deg = value; break;
    case MQ_OPTION_CHORD_TOLERANCE:
      if (value < 0 || value > 1) throw std::invalid_argument("chord tolerance must be in [0,1]");
      c.features.chord_tolerance_fraction = value; break;
    case MQ_OPTION_FINITE_ELEMENT_SIZING: c.finite_element_sizing = integer(0, 1) != 0; break;
    case MQ_OPTION_ELEMENTS_PER_CIRCLE: c.elements_per_circle = integer(8, 100000); break;
    case MQ_OPTION_ENABLE_SMOOTHING: c.enable_smoothing = integer(0, 1) != 0; break;
    case MQ_OPTION_SMOOTHING_ITERATIONS: c.smoothing_iterations = integer(0, 1000); break;
    case MQ_OPTION_ABSOLUTE_TOLERANCE:
      if (value <= 0) throw std::invalid_argument("absolute tolerance must be positive");
      c.tolerances.absolute_distance = value; break;
    case MQ_OPTION_RELATIVE_TOLERANCE:
      if (value < 0) throw std::invalid_argument("relative tolerance must be nonnegative");
      c.tolerances.relative_distance = value; break;
    default: throw std::invalid_argument("unknown meshing option");
    }
    ctx->last_error.clear(); return MQ_STATUS_SUCCESS;
  } catch (...) { return map_exception(ctx); }
}

mq_status_t mq_domain_create(mq_context_t* ctx, mq_domain_t** out_domain)
{
  if (out_domain) *out_domain = nullptr;
  if (!ctx || !out_domain) return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "domain requires context and output pointer");
  try { *out_domain = new mq_domain(); ctx->last_error.clear(); return MQ_STATUS_SUCCESS; }
  catch (...) { return map_exception(ctx); }
}

size_t mq_domain_loop_count(const mq_domain_t* domain)
{
  return domain ? domain->domain.outer_loops.size() + domain->domain.inner_loops.size() : 0;
}

mq_status_t mq_domain_add_loop(mq_context_t* ctx, mq_domain_t* domain, mq_loop_role_t role,
                              const mq_point2_t* points, size_t count, uint32_t* out_loop)
{
  if (!ctx || !domain || !points || count < 3)
    return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "loop requires a domain and at least three points");
  try {
    if (role < MQ_LOOP_OUTER || role > MQ_LOOP_CONTROL) throw std::invalid_argument("unknown loop role");
    if (role == MQ_LOOP_OUTER && !domain->domain.inner_loops.empty())
      throw std::invalid_argument("add outer loops before inner loops");
    quadmesh::PolylineLoop loop;
    for (size_t k = 0; k < count; ++k) {
      if (!std::isfinite(points[k].x) || !std::isfinite(points[k].y)) throw std::invalid_argument("non-finite coordinate");
      loop.vertices.push_back({points[k].x, points[k].y});
    }
    const auto index = static_cast<uint32_t>(mq_domain_loop_count(domain));
    if (role == MQ_LOOP_OUTER) domain->domain.outer_loops.push_back(std::move(loop));
    else domain->domain.inner_loops.push_back({std::move(loop),
        role == MQ_LOOP_HOLE ? quadmesh::InnerLoopRole::Hole : quadmesh::InnerLoopRole::MeshControlFeature});
    if (out_loop) *out_loop = index;
    ctx->last_error.clear(); return MQ_STATUS_SUCCESS;
  } catch (...) { return map_exception(ctx); }
}

mq_status_t mq_domain_set_loop_sizing(mq_context_t* ctx, mq_domain_t* domain, uint32_t loop,
                                    double target_size, const mq_sizing_sample_t* samples, size_t count)
{
  if (!ctx || (count && !samples)) return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "invalid sizing arguments");
  try {
    check_size(target_size);
    auto& l = get_loop(domain, loop);
    std::vector<quadmesh::BoundarySizingSample> converted;
    for (size_t k = 0; k < count; ++k) {
      const auto& s = samples[k];
      if (!std::isfinite(s.arc_fraction) || s.arc_fraction < 0 || s.arc_fraction > 1
          || !std::isfinite(s.target_cell_size) || s.target_cell_size <= 0)
        throw std::invalid_argument("invalid arc-length sizing sample");
      converted.push_back({s.arc_fraction, s.target_cell_size});
    }
    l.target_cell_size = target_size; l.sizing_samples = std::move(converted);
    ctx->last_error.clear(); return MQ_STATUS_SUCCESS;
  } catch (...) { return map_exception(ctx); }
}

mq_status_t mq_domain_set_vertex_kinds(mq_context_t* ctx, mq_domain_t* domain, uint32_t loop,
                                     const uint8_t* kinds, size_t count)
{
  if (!ctx || (count && !kinds)) return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "invalid vertex kinds");
  try {
    auto& l = get_loop(domain, loop);
    if (count != 0 && count != l.vertices.size()) throw std::invalid_argument("vertex kinds count must equal input point count");
    std::vector<quadmesh::VertexKind> converted;
    for (size_t k = 0; k < count; ++k) {
      if (kinds[k] > MQ_VERTEX_CORNER) throw std::invalid_argument("unknown vertex kind");
      converted.push_back(static_cast<quadmesh::VertexKind>(kinds[k]));
    }
    l.vertex_kinds = std::move(converted); ctx->last_error.clear(); return MQ_STATUS_SUCCESS;
  } catch (...) { return map_exception(ctx); }
}

mq_status_t mq_domain_add_fixed_run(mq_context_t* ctx, mq_domain_t* domain, uint32_t loop,
                                  uint32_t start_segment, double start_parameter,
                                  uint32_t end_segment, double end_parameter,
                                  const mq_point2_t* nodes, size_t count, uint8_t closed, uint32_t* out_run)
{
  if (!ctx || !nodes || count < (closed ? 3U : 2U) || closed > 1)
    return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "invalid fixed run arguments");
  try {
    auto& l = get_loop(domain, loop);
    if (start_segment >= l.vertices.size() || !std::isfinite(start_parameter) || start_parameter < 0 || start_parameter > 1
        || (!closed && (end_segment >= l.vertices.size() || !std::isfinite(end_parameter) || end_parameter < 0 || end_parameter > 1)))
      throw std::invalid_argument("invalid fixed run source positions");
    quadmesh::FixedBoundaryRun run;
    run.start = {start_segment, start_parameter}; run.end = {end_segment, end_parameter}; run.closed = closed != 0;
    for (size_t k = 0; k < count; ++k) {
      if (!std::isfinite(nodes[k].x) || !std::isfinite(nodes[k].y)) throw std::invalid_argument("non-finite fixed node");
      run.nodes.push_back({nodes[k].x, nodes[k].y});
    }
    const auto index = static_cast<uint32_t>(l.fixed_runs.size());
    l.fixed_runs.push_back(std::move(run));
    if (out_run) *out_run = index;
    ctx->last_error.clear(); return MQ_STATUS_SUCCESS;
  } catch (...) { return map_exception(ctx); }
}

mq_status_t mq_domain_create_polygon(
    mq_context_t* ctx,
    const mq_point2_t* points,
    size_t point_count,
    mq_domain_t** out_domain)
{
  if (ctx == nullptr) {
    return MQ_STATUS_INVALID_ARGUMENT;
  }
  if (points == nullptr || out_domain == nullptr || point_count < 3U) {
    return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "polygon creation requires at least three points and a valid output pointer");
  }
  *out_domain = nullptr;
  try {
    auto domain = std::make_unique<mq_domain>();
    quadmesh::PolylineLoop loop;
    loop.closed = true;
    loop.vertices.reserve(point_count);
    for (std::size_t i = 0; i < point_count; ++i) {
      loop.vertices.push_back({points[i].x, points[i].y});
    }
    domain->domain.outer_loops.push_back(std::move(loop));
    *out_domain = domain.release();
    ctx->last_error.clear();
    return MQ_STATUS_SUCCESS;
  } catch (...) {
    return map_exception(ctx);
  }
}

void mq_domain_destroy(mq_domain_t* domain)
{
  delete domain;
}

mq_status_t mq_domain_add_inner_loop(
    mq_context_t* ctx,
    mq_domain_t* domain,
    const mq_point2_t* points,
    size_t point_count,
    mq_inner_loop_role_t role)
{
  if (ctx == nullptr) {
    return MQ_STATUS_INVALID_ARGUMENT;
  }
  if (domain == nullptr || points == nullptr || point_count < 3U) {
    return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "inner loop requires a domain and at least three points");
  }

  try {
    quadmesh::PolylineLoop loop;
    loop.closed = true;
    loop.vertices.reserve(point_count);
    for (std::size_t i = 0; i < point_count; ++i) {
      loop.vertices.push_back({points[i].x, points[i].y});
    }
    domain->domain.inner_loops.push_back({std::move(loop), convert_role(role)});
    ctx->last_error.clear();
    return MQ_STATUS_SUCCESS;
  } catch (...) {
    return map_exception(ctx);
  }
}

mq_status_t mq_mesh_generate(
    mq_context_t* ctx,
    const mq_domain_t* domain,
    const mq_meshing_config_t* config,
    mq_mesh_t** out_mesh,
    mq_validation_report_t** out_report)
{
  return generate(ctx, domain, convert_config(config), out_mesh, out_report);
}

mq_status_t mq_mesh_generate_with_options(mq_context_t* ctx, const mq_domain_t* domain,
                                        const mq_options_t* options, mq_mesh_t** out_mesh,
                                        mq_validation_report_t** out_report)
{
  return generate(ctx, domain, options ? options->config : quadmesh::MeshingConfig{}, out_mesh, out_report);
}

void mq_mesh_destroy(mq_mesh_t* mesh)
{
  delete mesh;
}

void mq_validation_report_destroy(mq_validation_report_t* report)
{
  delete report;
}

size_t mq_mesh_node_count(const mq_mesh_t* mesh)
{
  return mesh == nullptr ? 0U : mesh->mesh.nodes.size();
}

size_t mq_mesh_quad_count(const mq_mesh_t* mesh)
{
  return mesh == nullptr ? 0U : mesh->mesh.quads.size();
}

mq_status_t mq_mesh_copy_nodes(mq_context_t* ctx, const mq_mesh_t* mesh, mq_point2_t* out_nodes, size_t capacity)
{
  if (ctx == nullptr) {
    return MQ_STATUS_INVALID_ARGUMENT;
  }
  if (mesh == nullptr || out_nodes == nullptr) {
    return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "copy nodes requires mesh and output array");
  }
  if (capacity < mesh->mesh.nodes.size()) {
    return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "node output array is too small");
  }
  for (std::size_t i = 0; i < mesh->mesh.nodes.size(); ++i) {
    out_nodes[i] = {mesh->mesh.nodes[i].point.x, mesh->mesh.nodes[i].point.y};
  }
  return MQ_STATUS_SUCCESS;
}

mq_status_t mq_mesh_copy_quads(mq_context_t* ctx, const mq_mesh_t* mesh, mq_quad4_t* out_quads, size_t capacity)
{
  if (ctx == nullptr) {
    return MQ_STATUS_INVALID_ARGUMENT;
  }
  if (mesh == nullptr || out_quads == nullptr) {
    return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "copy quads requires mesh and output array");
  }
  if (capacity < mesh->mesh.quads.size()) {
    return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "quad output array is too small");
  }
  for (std::size_t i = 0; i < mesh->mesh.quads.size(); ++i) {
    for (std::size_t j = 0; j < 4; ++j) {
      out_quads[i].nodes[j] = mesh->mesh.quads[i].nodes[j].value;
    }
  }
  return MQ_STATUS_SUCCESS;
}

uint8_t mq_validation_report_ok(const mq_validation_report_t* report)
{
  return report != nullptr && report->report.ok ? 1U : 0U;
}

size_t mq_validation_report_issue_count(const mq_validation_report_t* report)
{
  return report == nullptr ? 0U : report->report.issues.size();
}

const char* mq_validation_report_issue(const mq_validation_report_t* report, size_t index)
{
  return report && index < report->report.issues.size() ? report->report.issues[index].c_str() : nullptr;
}

mq_status_t mq_validation_report_quality(const mq_validation_report_t* report, mq_quality_summary_t* out)
{
  if (!report || !out) return MQ_STATUS_INVALID_ARGUMENT;
  const auto& r = report->report;
  *out = {r.min_angle_deg, r.max_angle_deg, r.min_scaled_jacobian, r.min_edge_ratio, r.max_boundary_deviation};
  return MQ_STATUS_SUCCESS;
}

size_t mq_mesh_boundary_node_count(const mq_mesh_t* mesh) { return mesh ? mesh->mesh.boundary_nodes.size() : 0; }
size_t mq_mesh_boundary_edge_count(const mq_mesh_t* mesh) { return mesh ? mesh->mesh.boundary_edges.size() : 0; }

mq_status_t mq_mesh_copy_boundary_nodes(mq_context_t* ctx, const mq_mesh_t* mesh,
                                       mq_boundary_node_t* out, size_t capacity)
{
  if (!ctx || !mesh || capacity < mesh->mesh.boundary_nodes.size() || (!out && !mesh->mesh.boundary_nodes.empty()))
    return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "boundary node output array is too small or null");
  for (size_t k = 0; k < mesh->mesh.boundary_nodes.size(); ++k) {
    const auto& n = mesh->mesh.boundary_nodes[k];
    out[k] = {n.node.value, n.loop, n.position.segment, n.fixed_run, n.fixed_node, 0, n.position.parameter};
  }
  ctx->last_error.clear(); return MQ_STATUS_SUCCESS;
}

mq_status_t mq_mesh_copy_boundary_edges(mq_context_t* ctx, const mq_mesh_t* mesh,
                                       mq_boundary_edge_t* out, size_t capacity)
{
  if (!ctx || !mesh || capacity < mesh->mesh.boundary_edges.size() || (!out && !mesh->mesh.boundary_edges.empty()))
    return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "boundary edge output array is too small or null");
  for (size_t k = 0; k < mesh->mesh.boundary_edges.size(); ++k) {
    const auto& e = mesh->mesh.boundary_edges[k];
    out[k] = {e.nodes[0].value, e.nodes[1].value, e.loop, e.segment, e.fixed_run, e.fixed_edge,
              e.parameter_start, e.parameter_end};
  }
  ctx->last_error.clear(); return MQ_STATUS_SUCCESS;
}

mq_status_t mq_mesh_copy_quad_quality(mq_context_t* ctx, const mq_mesh_t* mesh,
                                    mq_quad_quality_t* out, size_t capacity)
{
  if (!ctx || !mesh || capacity < mesh->mesh.quads.size() || (!out && !mesh->mesh.quads.empty()))
    return set_error(ctx, MQ_STATUS_INVALID_ARGUMENT, "quad quality output array is too small or null");
  for (size_t k = 0; k < mesh->mesh.quads.size(); ++k) {
    const auto q = quadmesh::quad_quality(mesh->mesh, mesh->mesh.quads[k]);
    out[k] = {q.min_jacobian, q.min_scaled_jacobian};
  }
  ctx->last_error.clear(); return MQ_STATUS_SUCCESS;
}

} // extern "C"
