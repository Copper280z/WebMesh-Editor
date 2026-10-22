#include "quadmesh_c/quadmesh.h"

#include <gtest/gtest.h>

#include <vector>
#include <string>

TEST(CApi, GeneratesMeshAndCopiesArrays)
{
  mq_context_t* ctx = nullptr;
  ASSERT_EQ(mq_context_create(&ctx), MQ_STATUS_SUCCESS);

  const mq_point2_t points[] = {{0.0, 0.0}, {1.0, 0.0}, {1.0, 1.0}, {0.0, 1.0}};
  mq_domain_t* domain = nullptr;
  ASSERT_EQ(mq_domain_create_polygon(ctx, points, 4, &domain), MQ_STATUS_SUCCESS) << mq_context_last_error(ctx);

  mq_meshing_config_t config{2, 0.0, 0};
  mq_mesh_t* mesh = nullptr;
  mq_validation_report_t* report = nullptr;
  ASSERT_EQ(mq_mesh_generate(ctx, domain, &config, &mesh, &report), MQ_STATUS_SUCCESS) << mq_context_last_error(ctx);
  EXPECT_EQ(mq_validation_report_ok(report), 1U);

  std::vector<mq_point2_t> nodes(mq_mesh_node_count(mesh));
  std::vector<mq_quad4_t> quads(mq_mesh_quad_count(mesh));
  EXPECT_EQ(mq_mesh_copy_nodes(ctx, mesh, nodes.data(), nodes.size()), MQ_STATUS_SUCCESS);
  EXPECT_EQ(mq_mesh_copy_quads(ctx, mesh, quads.data(), quads.size()), MQ_STATUS_SUCCESS);
  EXPECT_FALSE(nodes.empty());
  EXPECT_FALSE(quads.empty());

  mq_validation_report_destroy(report);
  mq_mesh_destroy(mesh);
  mq_domain_destroy(domain);
  mq_context_destroy(ctx);
}

TEST(CApi, ReportsInvalidArguments)
{
  mq_context_t* ctx = nullptr;
  ASSERT_EQ(mq_context_create(&ctx), MQ_STATUS_SUCCESS);
  mq_domain_t* domain = nullptr;
  EXPECT_EQ(mq_domain_create_polygon(ctx, nullptr, 0, &domain), MQ_STATUS_INVALID_ARGUMENT);
  EXPECT_NE(mq_context_last_error(ctx), nullptr);
  mq_context_destroy(ctx);
}

TEST(CApi, AddsMeshControlFeatureInnerLoop)
{
  mq_context_t* ctx = nullptr;
  ASSERT_EQ(mq_context_create(&ctx), MQ_STATUS_SUCCESS);

  const mq_point2_t outer[] = {{0.0, 0.0}, {4.0, 0.0}, {4.0, 2.4}, {0.0, 2.4}};
  const mq_point2_t feature[] = {{1.6, 0.8}, {2.4, 0.8}, {2.4, 1.6}, {1.6, 1.6}};

  mq_domain_t* domain = nullptr;
  ASSERT_EQ(mq_domain_create_polygon(ctx, outer, 4, &domain), MQ_STATUS_SUCCESS);
  ASSERT_EQ(
      mq_domain_add_inner_loop(ctx, domain, feature, 4, MQ_INNER_LOOP_MESH_CONTROL_FEATURE),
      MQ_STATUS_SUCCESS);

  mq_meshing_config_t config{4, 0.0, 0};
  mq_mesh_t* mesh = nullptr;
  mq_validation_report_t* report = nullptr;
  ASSERT_EQ(mq_mesh_generate(ctx, domain, &config, &mesh, &report), MQ_STATUS_SUCCESS)
      << mq_context_last_error(ctx);
  EXPECT_EQ(mq_validation_report_ok(report), 1U);
  EXPECT_GT(mq_mesh_quad_count(mesh), 0U);

  mq_validation_report_destroy(report);
  mq_mesh_destroy(mesh);
  mq_domain_destroy(domain);
  mq_context_destroy(ctx);
}

TEST(CApi, OptionsFixedRunsProvenanceAndQuality)
{
  mq_context_t* ctx = nullptr;
  mq_domain_t* domain = nullptr;
  mq_options_t* options = nullptr;
  mq_mesh_t* mesh = nullptr;
  mq_validation_report_t* report = nullptr;
  ASSERT_EQ(mq_context_create(&ctx), MQ_STATUS_SUCCESS);
  ASSERT_EQ(mq_domain_create(ctx, &domain), MQ_STATUS_SUCCESS);
  ASSERT_EQ(mq_options_create(ctx, &options), MQ_STATUS_SUCCESS);
  const mq_point2_t square[] = {{0, 0}, {10, 0}, {10, 10}, {0, 10}};
  uint32_t loop = 99, run = 99;
  ASSERT_EQ(mq_domain_add_loop(ctx, domain, MQ_LOOP_OUTER, square, 4, &loop), MQ_STATUS_SUCCESS);
  EXPECT_EQ(loop, 0U);
  ASSERT_EQ(mq_domain_add_fixed_run(ctx, domain, loop, 0, 0, 0, 0, square, 4, 1, &run), MQ_STATUS_SUCCESS);
  EXPECT_EQ(run, 0U);
  ASSERT_EQ(mq_options_set(ctx, options, MQ_OPTION_TARGET_SIZE, 3), MQ_STATUS_SUCCESS);
  ASSERT_EQ(mq_options_set(ctx, options, MQ_OPTION_ENABLE_SMOOTHING, 1), MQ_STATUS_SUCCESS);
  ASSERT_EQ(mq_mesh_generate_with_options(ctx, domain, options, &mesh, &report), MQ_STATUS_SUCCESS)
      << mq_context_last_error(ctx);
  EXPECT_EQ(mq_validation_report_ok(report), 1);
  std::vector<mq_boundary_node_t> nodes(mq_mesh_boundary_node_count(mesh));
  std::vector<mq_boundary_edge_t> edges(mq_mesh_boundary_edge_count(mesh));
  ASSERT_EQ(mq_mesh_copy_boundary_nodes(ctx, mesh, nodes.data(), nodes.size()), MQ_STATUS_SUCCESS);
  ASSERT_EQ(mq_mesh_copy_boundary_edges(ctx, mesh, edges.data(), edges.size()), MQ_STATUS_SUCCESS);
  ASSERT_EQ(nodes.size(), 4U);
  ASSERT_EQ(edges.size(), 4U);
  for (size_t k = 0; k < 4; ++k) {
    EXPECT_EQ(nodes[k].fixed_run, 0);
    EXPECT_EQ(nodes[k].fixed_node, static_cast<int>(k));
    EXPECT_EQ(edges[k].fixed_edge, static_cast<int>(k));
    EXPECT_EQ(edges[k].segment, k);
  }
  EXPECT_EQ(mq_mesh_copy_boundary_nodes(ctx, mesh, nullptr, 4), MQ_STATUS_INVALID_ARGUMENT);
  EXPECT_EQ(mq_mesh_copy_boundary_edges(ctx, mesh, edges.data(), 3), MQ_STATUS_INVALID_ARGUMENT);
  std::vector<mq_quad_quality_t> quality(mq_mesh_quad_count(mesh));
  EXPECT_EQ(mq_mesh_copy_quad_quality(ctx, mesh, quality.data(), quality.size()), MQ_STATUS_SUCCESS);
  mq_quality_summary_t summary{};
  EXPECT_EQ(mq_validation_report_quality(report, &summary), MQ_STATUS_SUCCESS);
  EXPECT_GT(summary.min_scaled_jacobian, 0);
  EXPECT_EQ(mq_validation_report_issue(report, 0), nullptr);
  mq_validation_report_destroy(report);
  mq_mesh_destroy(mesh);
  mq_options_destroy(options);
  mq_domain_destroy(domain);
  mq_context_destroy(ctx);
}

TEST(CApi, InvalidOptionsAndFailedGenerationHaveClearErrors)
{
  mq_context_t* ctx = nullptr;
  mq_domain_t* domain = nullptr;
  mq_options_t* options = nullptr;
  ASSERT_EQ(mq_context_create(&ctx), MQ_STATUS_SUCCESS);
  ASSERT_EQ(mq_domain_create(ctx, &domain), MQ_STATUS_SUCCESS);
  ASSERT_EQ(mq_options_create(ctx, &options), MQ_STATUS_SUCCESS);
  EXPECT_EQ(mq_options_set(ctx, options, MQ_OPTION_ELEMENTS_PER_CIRCLE, 7), MQ_STATUS_INVALID_ARGUMENT);
  EXPECT_EQ(mq_options_set(ctx, options, MQ_OPTION_MAX_REFINEMENT_LEVEL, 2.5), MQ_STATUS_INVALID_ARGUMENT);
  EXPECT_EQ(mq_options_set(ctx, options, MQ_OPTION_TARGET_SIZE, -1), MQ_STATUS_INVALID_ARGUMENT);
  const mq_point2_t triangle[] = {{0, 0}, {10, 0}, {0, 10}};
  ASSERT_EQ(mq_domain_add_loop(ctx, domain, MQ_LOOP_OUTER, triangle, 3, nullptr), MQ_STATUS_SUCCESS);
  ASSERT_EQ(mq_domain_add_fixed_run(ctx, domain, 0, 0, 0, 0, 0, triangle, 3, 1, nullptr), MQ_STATUS_SUCCESS);
  mq_mesh_t* mesh = nullptr;
  mq_validation_report_t* report = nullptr;
  EXPECT_EQ(mq_mesh_generate_with_options(ctx, domain, options, &mesh, &report), MQ_STATUS_INVALID_ARGUMENT);
  EXPECT_EQ(mesh, nullptr);
  EXPECT_EQ(report, nullptr);
  EXPECT_NE(std::string(mq_context_last_error(ctx)).find("odd boundary"), std::string::npos);
  mq_options_destroy(options);
  mq_domain_destroy(domain);
  mq_context_destroy(ctx);
}
