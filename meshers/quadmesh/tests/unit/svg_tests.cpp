#include "quadmesh/svg.hpp"
#include "quadmesh/pipeline.hpp"

#include <gtest/gtest.h>

#include <filesystem>
#include <fstream>
#include <string>

namespace {

class SvgImportTest : public ::testing::Test {
protected:
  std::filesystem::path path;

  void SetUp() override
  {
    path = std::filesystem::temp_directory_path() / "quadmesh_svg_import_test.svg";
  }

  void TearDown() override { std::filesystem::remove(path); }

  void write(const std::string& svg)
  {
    std::ofstream out(path);
    ASSERT_TRUE(out) << path;
    out << svg;
  }
};

TEST_F(SvgImportTest, ImportsTransformedClosedShapesAndFiltersFill)
{
  write(R"svg(
    <svg xmlns="http://www.w3.org/2000/svg">
      <g transform="translate(5,7) scale(2)" fill="#aBcDeF">
        <path d="M 0,0 H 4 V 4 H 0 Z"/>
      </g>
      <circle cx="20" cy="20" r="4" fill="#000000"/>
      <polyline points="0,0 1,1 2,0" fill="#abcdef"/>
    </svg>)svg");

  quadmesh::SvgImportOptions options;
  options.fill = "#ABCDEF";
  const quadmesh::SvgImportResult result = quadmesh::read_svg(path.string(), options);

  ASSERT_EQ(result.domain.outer_loops.size(), 1U);
  const auto& loop = result.domain.outer_loops.front();
  ASSERT_EQ(loop.vertices.size(), 4U);
  EXPECT_TRUE(quadmesh::nearly_equal(loop.vertices[0], {5.0, 7.0}, 1.0e-12));
  EXPECT_TRUE(quadmesh::nearly_equal(loop.vertices[1], {13.0, 7.0}, 1.0e-12));
}

TEST_F(SvgImportTest, FlattensCurvesArcsAndRoundedRectangles)
{
  write(R"svg(
    <svg xmlns="http://www.w3.org/2000/svg">
      <path d="M 0 0 C 0 10 10 10 10 0 S 20 -10 20 0 Q 25 5 30 0 T 40 0 A 5 5 0 0 1 50 0 Z"/>
      <rect x="60" y="0" width="10" height="8" rx="2"/>
      <ellipse cx="80" cy="4" rx="4" ry="3"/>
    </svg>)svg");

  quadmesh::SvgImportOptions options;
  options.curve_tolerance = 0.1;
  const quadmesh::SvgImportResult result = quadmesh::read_svg(path.string(), options);

  ASSERT_EQ(result.domain.outer_loops.size(), 3U);
  for (const quadmesh::PolylineLoop& loop : result.domain.outer_loops) {
    EXPECT_TRUE(loop.closed);
    EXPECT_GT(loop.vertices.size(), 4U);
  }
}

TEST_F(SvgImportTest, ImportedBoundaryRunsThroughMeshingPipeline)
{
  write(R"svg(
    <svg xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="8" height="6"/>
    </svg>)svg");

  const quadmesh::SvgImportResult imported = quadmesh::read_svg(path.string());
  quadmesh::MeshingConfig config;
  config.refinement.target_cell_size = 1.0;
  const quadmesh::PipelineRunResult mesh = quadmesh::MeshingPipeline{}.run(imported.domain, config);

  EXPECT_TRUE(mesh.validation.ok);
  EXPECT_GT(mesh.mesh.quads.size(), 0U);
}

TEST_F(SvgImportTest, ReportsCrossingOrOverlappingBoundariesBeforeMeshing)
{
  write(R"svg(
    <svg xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="8" height="6"/>
      <rect x="4" y="2" width="8" height="6"/>
    </svg>)svg");

  const quadmesh::SvgImportResult imported = quadmesh::read_svg(path.string());

  EXPECT_FALSE(imported.topology.meshable());
  EXPECT_GT(imported.topology.conflict_count, 0U);
  EXPECT_FALSE(imported.topology.issues.empty());
}

} // namespace
