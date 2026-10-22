#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct mq_context mq_context_t;
typedef struct mq_domain mq_domain_t;
typedef struct mq_mesh mq_mesh_t;
typedef struct mq_validation_report mq_validation_report_t;
typedef struct mq_options mq_options_t;

// Extensible options avoid changing the layout of mq_meshing_config_t.
typedef enum mq_option {
  MQ_OPTION_TARGET_SIZE = 0,
  MQ_OPTION_MAX_REFINEMENT_LEVEL = 1,
  MQ_OPTION_LOCAL_SIZING_PROMOTION = 2,
  MQ_OPTION_FEATURE_ANGLE = 3,
  MQ_OPTION_CHORD_TOLERANCE = 4,
  MQ_OPTION_FINITE_ELEMENT_SIZING = 5,
  MQ_OPTION_ELEMENTS_PER_CIRCLE = 6,
  MQ_OPTION_ENABLE_SMOOTHING = 7,
  MQ_OPTION_SMOOTHING_ITERATIONS = 8,
  MQ_OPTION_ABSOLUTE_TOLERANCE = 9,
  MQ_OPTION_RELATIVE_TOLERANCE = 10
} mq_option_t;

typedef enum mq_loop_role {
  MQ_LOOP_OUTER = 0,
  MQ_LOOP_HOLE = 1,
  MQ_LOOP_CONTROL = 2
} mq_loop_role_t;

typedef enum mq_vertex_kind {
  MQ_VERTEX_AUTOMATIC = 0,
  MQ_VERTEX_SMOOTH = 1,
  MQ_VERTEX_CORNER = 2
} mq_vertex_kind_t;

typedef enum mq_status {
  MQ_STATUS_SUCCESS = 0,
  MQ_STATUS_INVALID_ARGUMENT = 1,
  MQ_STATUS_UNSUPPORTED_INPUT = 2,
  MQ_STATUS_INVARIANT_FAILURE = 3,
  MQ_STATUS_ALLOCATION_FAILURE = 4,
  MQ_STATUS_INTERNAL_ERROR = 5
} mq_status_t;

typedef enum mq_inner_loop_role {
  MQ_INNER_LOOP_HOLE = 0,
  MQ_INNER_LOOP_MESH_CONTROL_FEATURE = 1
} mq_inner_loop_role_t;

typedef struct mq_point2 {
  double x;
  double y;
} mq_point2_t;

typedef struct mq_quad4 {
  uint32_t nodes[4];
} mq_quad4_t;

typedef struct mq_meshing_config {
  uint16_t max_refinement_level;
  double target_cell_size;
  uint8_t enable_smoothing;
} mq_meshing_config_t;

typedef struct mq_sizing_sample {
  double arc_fraction;
  double target_cell_size;
} mq_sizing_sample_t;

// Fixed-width layouts, including explicit padding, are identical on wasm32
// and native targets. Segment parameters are in [0,1].
typedef struct mq_boundary_node {
  uint32_t node;
  uint32_t loop;
  uint32_t segment;
  int32_t fixed_run;
  int32_t fixed_node;
  uint32_t reserved;
  double parameter;
} mq_boundary_node_t;

typedef struct mq_boundary_edge {
  uint32_t node_a;
  uint32_t node_b;
  uint32_t loop;
  uint32_t segment;
  int32_t fixed_run;
  int32_t fixed_edge;
  double parameter_start;
  double parameter_end;
} mq_boundary_edge_t;

typedef struct mq_quad_quality {
  double min_jacobian;
  double min_scaled_jacobian;
} mq_quad_quality_t;

typedef struct mq_quality_summary {
  double min_angle_deg;
  double max_angle_deg;
  double min_scaled_jacobian;
  double min_edge_ratio;
  double max_boundary_deviation;
} mq_quality_summary_t;

uint32_t mq_abi_version(void);

mq_status_t mq_context_create(mq_context_t** out_ctx);
void mq_context_destroy(mq_context_t* ctx);
const char* mq_context_last_error(const mq_context_t* ctx);

mq_status_t mq_options_create(mq_context_t* ctx, mq_options_t** out_options);
void mq_options_destroy(mq_options_t* options);
mq_status_t mq_options_set(mq_context_t* ctx, mq_options_t* options, mq_option_t key, double value);

mq_status_t mq_domain_create(mq_context_t* ctx, mq_domain_t** out_domain);
// Outer loops must be added before inner loops, keeping returned indices stable.
mq_status_t mq_domain_add_loop(mq_context_t* ctx, mq_domain_t* domain, mq_loop_role_t role,
                              const mq_point2_t* points, size_t point_count, uint32_t* out_loop);
size_t mq_domain_loop_count(const mq_domain_t* domain);
mq_status_t mq_domain_set_loop_sizing(mq_context_t* ctx, mq_domain_t* domain, uint32_t loop,
                                    double target_size, const mq_sizing_sample_t* samples, size_t count);
mq_status_t mq_domain_set_vertex_kinds(mq_context_t* ctx, mq_domain_t* domain, uint32_t loop,
                                     const uint8_t* kinds, size_t count);
mq_status_t mq_domain_add_fixed_run(mq_context_t* ctx, mq_domain_t* domain, uint32_t loop,
                                  uint32_t start_segment, double start_parameter,
                                  uint32_t end_segment, double end_parameter,
                                  const mq_point2_t* nodes, size_t node_count, uint8_t closed,
                                  uint32_t* out_run);

mq_status_t mq_domain_create_polygon(
    mq_context_t* ctx,
    const mq_point2_t* points,
    size_t point_count,
    mq_domain_t** out_domain);
mq_status_t mq_domain_add_inner_loop(
    mq_context_t* ctx,
    mq_domain_t* domain,
    const mq_point2_t* points,
    size_t point_count,
    mq_inner_loop_role_t role);
void mq_domain_destroy(mq_domain_t* domain);

mq_status_t mq_mesh_generate(
    mq_context_t* ctx,
    const mq_domain_t* domain,
    const mq_meshing_config_t* config,
    mq_mesh_t** out_mesh,
    mq_validation_report_t** out_report);
mq_status_t mq_mesh_generate_with_options(mq_context_t* ctx, const mq_domain_t* domain,
                                        const mq_options_t* options, mq_mesh_t** out_mesh,
                                        mq_validation_report_t** out_report);
void mq_mesh_destroy(mq_mesh_t* mesh);
void mq_validation_report_destroy(mq_validation_report_t* report);

size_t mq_mesh_node_count(const mq_mesh_t* mesh);
size_t mq_mesh_quad_count(const mq_mesh_t* mesh);
mq_status_t mq_mesh_copy_nodes(mq_context_t* ctx, const mq_mesh_t* mesh, mq_point2_t* out_nodes, size_t capacity);
mq_status_t mq_mesh_copy_quads(mq_context_t* ctx, const mq_mesh_t* mesh, mq_quad4_t* out_quads, size_t capacity);

uint8_t mq_validation_report_ok(const mq_validation_report_t* report);
size_t mq_validation_report_issue_count(const mq_validation_report_t* report);
// Borrowed until report destruction. NULL for an invalid index.
const char* mq_validation_report_issue(const mq_validation_report_t* report, size_t index);
mq_status_t mq_validation_report_quality(const mq_validation_report_t* report, mq_quality_summary_t* out_quality);
size_t mq_mesh_boundary_node_count(const mq_mesh_t* mesh);
// Number of source spans, not necessarily the number of distinct mesh edges.
size_t mq_mesh_boundary_edge_count(const mq_mesh_t* mesh);
mq_status_t mq_mesh_copy_boundary_nodes(mq_context_t* ctx, const mq_mesh_t* mesh,
                                       mq_boundary_node_t* out_nodes, size_t capacity);
mq_status_t mq_mesh_copy_boundary_edges(mq_context_t* ctx, const mq_mesh_t* mesh,
                                       mq_boundary_edge_t* out_edges, size_t capacity);
mq_status_t mq_mesh_copy_quad_quality(mq_context_t* ctx, const mq_mesh_t* mesh,
                                    mq_quad_quality_t* out_quality, size_t capacity);

#ifdef __cplusplus
}
#endif
