#include "quadmesh_c/quadmesh.h"

#include <stdio.h>
#include <stdlib.h>

int main(void)
{
  mq_context_t* ctx = NULL;
  if (mq_context_create(&ctx) != MQ_STATUS_SUCCESS) {
    return 1;
  }

  const mq_point2_t points[] = {
      {0.0, 0.0},
      {1.0, 0.0},
      {1.0, 1.0},
      {0.0, 1.0},
  };

  mq_domain_t* domain = NULL;
  if (mq_domain_create_polygon(ctx, points, 4, &domain) != MQ_STATUS_SUCCESS) {
    printf("%s\n", mq_context_last_error(ctx));
    mq_context_destroy(ctx);
    return 1;
  }

  mq_meshing_config_t config = {2, 0.0, 0};
  mq_mesh_t* mesh = NULL;
  mq_validation_report_t* report = NULL;
  if (mq_mesh_generate(ctx, domain, &config, &mesh, &report) != MQ_STATUS_SUCCESS) {
    printf("%s\n", mq_context_last_error(ctx));
    mq_domain_destroy(domain);
    mq_context_destroy(ctx);
    return 1;
  }

  printf("nodes=%zu\n", mq_mesh_node_count(mesh));
  printf("quads=%zu\n", mq_mesh_quad_count(mesh));
  printf("validation_ok=%u\n", (unsigned)mq_validation_report_ok(report));

  mq_validation_report_destroy(report);
  mq_mesh_destroy(mesh);
  mq_domain_destroy(domain);
  mq_context_destroy(ctx);
  return 0;
}
