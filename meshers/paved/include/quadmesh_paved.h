/*
 * Paved (Q-Morph) all-quad face mesher: C ABI.
 *
 * The functions, enums and struct layouts are those of the quadtree mesher's
 * quadmesh_c/quadmesh.h (ABI 0.3, open control curves included), so code and bindings written for one work
 * with the other by loading a different library. Options that only apply to
 * the quadtree mesher (max refinement level, local sizing promotion, finite
 * element sizing) are accepted and ignored. Additions are marked "paved".
 *
 * Link with libquadmesh_paved (static or shared), or load quadmesh_paved.wasm.
 */
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

typedef enum mq_option {
  MQ_OPTION_TARGET_SIZE = 0,            /* element size; 0 = largest extent / 24 */
  MQ_OPTION_MAX_REFINEMENT_LEVEL = 1,   /* ignored (quadtree only) */
  MQ_OPTION_LOCAL_SIZING_PROMOTION = 2, /* ignored (quadtree only) */
  MQ_OPTION_FEATURE_ANGLE = 3,          /* turns above this (degrees) are corners; default 30 */
  MQ_OPTION_CHORD_TOLERANCE = 4,        /* fraction of local size, 0 = off (default) */
  MQ_OPTION_FINITE_ELEMENT_SIZING = 5,  /* ignored: sizing is always FE sizing */
  MQ_OPTION_ELEMENTS_PER_CIRCLE = 6,    /* default 12, at least 8 */
  MQ_OPTION_ENABLE_SMOOTHING = 7,       /* default 1; boundary nodes never move */
  MQ_OPTION_SMOOTHING_ITERATIONS = 8,   /* default 30 */
  MQ_OPTION_ABSOLUTE_TOLERANCE = 9,
  MQ_OPTION_RELATIVE_TOLERANCE = 10,
  MQ_OPTION_GROWTH_RATE = 64,           /* paved: size ratio between neighbors, default 1.2 */
  MQ_OPTION_ENABLE_CLEANUP = 65         /* paved: topological cleanup, default 1 */
} mq_option_t;

typedef enum mq_loop_role {
  MQ_LOOP_OUTER = 0,
  MQ_LOOP_HOLE = 1,
  MQ_LOOP_CONTROL = 2,
  /* ABI 0.3: an open curve inside the domain, n >= 2 points, n - 1 segments. Fix it with
     mq_domain_add_fixed_run(ctx, d, loop, 0, 0.0, n - 2, 1.0, nodes, count, 0, &run).
     Each segment becomes a mesh edge with a quad on each side; an end lies inside the
     region or on another loop's or curve's node. */
  MQ_LOOP_CURVE = 3
} mq_loop_role_t;

typedef enum mq_vertex_kind {
  MQ_VERTEX_AUTOMATIC = 0,
  MQ_VERTEX_SMOOTH = 1,
  MQ_VERTEX_CORNER = 2
} mq_vertex_kind_t;

typedef enum mq_status {
  MQ_STATUS_SUCCESS = 0,
  MQ_STATUS_INVALID_ARGUMENT = 1,
  MQ_STATUS_UNSUPPORTED_INPUT = 2, /* e.g. odd fixed boundary-edge count */
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

/* Segment parameters are in [0,1]; fixed_run/fixed_node are -1 on free runs. */
typedef struct mq_boundary_node {
  uint32_t node;
  uint32_t loop;
  uint32_t segment;
  int32_t fixed_run;
  int32_t fixed_node;
  uint32_t reserved;
  double parameter;
} mq_boundary_node_t;

/* One record per input segment piece covered by a mesh boundary edge. */
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

/* paved: extended report. */
typedef struct mq_paved_quality {
  double min_angle_deg;
  double max_angle_deg;
  double min_scaled_jacobian;
  double p5_scaled_jacobian;       /* 5th percentile of per-quad min scaled Jacobian */
  double share_scaled_jacobian_05; /* share of quads with scaled Jacobian >= 0.5 */
  double irregular_share;          /* interior nodes not shared by exactly four quads */
  double min_edge_ratio;
  double max_boundary_deviation;
  uint32_t quad_count;
  uint32_t node_count;
  uint32_t interior_nodes;
  uint32_t irregular_nodes;
  uint32_t inverted;
  uint8_t all_quads;
  uint8_t conforming;
  uint8_t covers_domain;
  uint8_t fixed_kept;
} mq_paved_quality_t;

/* (major << 24) | (minor << 12) | patch; 0.3 or later supports MQ_LOOP_CURVE. */
uint32_t mq_abi_version(void);
/* paved: "paved" for this library. */
const char* mq_implementation(void);

mq_status_t mq_context_create(mq_context_t** out_ctx);
void mq_context_destroy(mq_context_t* ctx);
const char* mq_context_last_error(const mq_context_t* ctx);

mq_status_t mq_options_create(mq_context_t* ctx, mq_options_t** out_options);
void mq_options_destroy(mq_options_t* options);
mq_status_t mq_options_set(mq_context_t* ctx, mq_options_t* options, mq_option_t key, double value);

mq_status_t mq_domain_create(mq_context_t* ctx, mq_domain_t** out_domain);
/* Outer loops must be added before inner loops, keeping returned indices stable. */
mq_status_t mq_domain_add_loop(mq_context_t* ctx, mq_domain_t* domain, mq_loop_role_t role,
                               const mq_point2_t* points, size_t point_count, uint32_t* out_loop);
size_t mq_domain_loop_count(const mq_domain_t* domain);
mq_status_t mq_domain_set_loop_sizing(mq_context_t* ctx, mq_domain_t* domain, uint32_t loop,
                                      double target_size, const mq_sizing_sample_t* samples, size_t count);
mq_status_t mq_domain_set_vertex_kinds(mq_context_t* ctx, mq_domain_t* domain, uint32_t loop,
                                       const uint8_t* kinds, size_t count);
/* Nodes follow the loop direction. An open run includes both endpoints and spans from
   (start_segment, start_parameter) to (end_segment, end_parameter) on the input polyline;
   a closed run covers the whole loop (no repeated node) and ignores the end position. */
mq_status_t mq_domain_add_fixed_run(mq_context_t* ctx, mq_domain_t* domain, uint32_t loop,
                                    uint32_t start_segment, double start_parameter,
                                    uint32_t end_segment, double end_parameter,
                                    const mq_point2_t* nodes, size_t node_count, uint8_t closed,
                                    uint32_t* out_run);

mq_status_t mq_domain_create_polygon(mq_context_t* ctx, const mq_point2_t* points, size_t point_count,
                                     mq_domain_t** out_domain);
mq_status_t mq_domain_add_inner_loop(mq_context_t* ctx, mq_domain_t* domain, const mq_point2_t* points,
                                     size_t point_count, mq_inner_loop_role_t role);
void mq_domain_destroy(mq_domain_t* domain);

mq_status_t mq_mesh_generate(mq_context_t* ctx, const mq_domain_t* domain, const mq_meshing_config_t* config,
                             mq_mesh_t** out_mesh, mq_validation_report_t** out_report);
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
/* Borrowed until report destruction. NULL for an invalid index. */
const char* mq_validation_report_issue(const mq_validation_report_t* report, size_t index);
mq_status_t mq_validation_report_quality(const mq_validation_report_t* report, mq_quality_summary_t* out_quality);
/* paved */
mq_status_t mq_validation_report_paved_quality(const mq_validation_report_t* report, mq_paved_quality_t* out_quality);
size_t mq_mesh_boundary_node_count(const mq_mesh_t* mesh);
/* Number of source spans, not necessarily the number of distinct mesh edges. */
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
