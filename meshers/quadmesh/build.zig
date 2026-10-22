const std = @import("std");

// The mesher itself: geometry, the staged pipeline, quality, validation and file output.
const core_sources = [_][]const u8{
    "src/core/geometry.cpp",
    "src/core/mesh.cpp",
    "src/core/mesher.cpp",
    "src/core/pipeline.cpp",
    "src/core/quality.cpp",
    "src/core/shapes.cpp",
    "src/core/validation.cpp",
    "src/core/detail/chain.cpp",
    "src/core/detail/boundary.cpp",
    "src/core/detail/empty_templates.cpp",
    "src/core/stages/sizing.cpp",
    "src/core/stages/repel.cpp",
    "src/core/stages/classify.cpp",
    "src/core/stages/vertex_bends.cpp",
    "src/core/stages/face_mesh.cpp",
    "src/core/stages/empty_fill.cpp",
    "src/core/stages/finalize.cpp",
    "src/core/stages/constrained.cpp",
    "src/io/io.cpp",
    "src/io/svg.cpp",
};

const cpp_flags = [_][]const u8{ "-std=c++20", "-Wall", "-Wextra", "-Wpedantic" };

// Programs built against the public C++ API (cpp_template_gaps also reads the private headers).
const examples = [_][]const u8{
    "cpp_minimal",       "cpp_dump_svg", "cpp_export_mesh", "cpp_plate_circle", "cpp_plate",
    "cpp_plate_star",    "repro_debug",  "cpp_gallery",     "cpp_local_sizing", "cpp_template_gaps",
};
const tools = [_][]const u8{ "quadmesh_probe", "quadmesh_svg" };

// gtest suites through the C ABI, and per-stage suites that reach into the private headers.
const api_tests = [_][2][]const u8{
    .{ "unit_geometry", "tests/unit/geometry_tests.cpp" },
    .{ "unit_validation", "tests/unit/validation_tests.cpp" },
    .{ "unit_c_api", "tests/unit/c_api_tests.cpp" },
    .{ "unit_svg", "tests/unit/svg_tests.cpp" },
    .{ "contract_pipeline", "tests/contract/pipeline_contract_tests.cpp" },
    .{ "contract_prescribed_boundary", "tests/contract/prescribed_boundary_tests.cpp" },
};
const stage_tests = [_][2][]const u8{
    .{ "unit_matching", "tests/unit/matching_tests.cpp" },
    .{ "unit_sizing", "tests/unit/sizing_tests.cpp" },
    .{ "unit_repel", "tests/unit/repel_tests.cpp" },
    .{ "unit_classify", "tests/unit/classify_tests.cpp" },
    .{ "unit_face_mesh", "tests/unit/face_mesh_tests.cpp" },
    .{ "unit_empty_fill", "tests/unit/empty_fill_tests.cpp" },
};

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    // Release by default, as the mesher is always used for real work; -Doptimize=debug when debugging.
    const optimize = b.option(std.builtin.Optimize, "optimize", "Optimization mode (default fast)") orelse .fast;

    const core = b.addLibrary(.{
        .linkage = .static,
        .name = "quadmesh_core",
        .root_module = cppModule(b, target, optimize),
    });
    core.root_module.addIncludePath(b.path("src/core"));
    core.root_module.addCSourceFiles(.{ .files = &core_sources, .flags = &cpp_flags });
    b.installArtifact(core);

    // C ABI: one self-contained shared library (the C++ runtime is linked in) plus a static one.
    const capi_shared = b.addLibrary(.{
        .linkage = .dynamic,
        .name = "quadmesh_capi",
        .root_module = cppModule(b, target, optimize),
    });
    const capi_static = b.addLibrary(.{
        .linkage = .static,
        .name = "quadmesh_capi",
        .root_module = cppModule(b, target, optimize),
    });
    for ([_]*std.Build.Step.Compile{ capi_shared, capi_static }) |lib| {
        lib.root_module.addCSourceFiles(.{ .files = &.{"src/abi/c_api.cpp"}, .flags = &cpp_flags });
        lib.root_module.linkLibrary(core);
    }
    capi_shared.installHeader(b.path("include/quadmesh_c/quadmesh.h"), "quadmesh_c/quadmesh.h");
    b.installArtifact(capi_shared);
    b.installArtifact(capi_static);

    const examples_step = b.step("examples", "Build the examples and tools");
    for (examples ++ tools) |name| {
        const exe = b.addExecutable(.{ .name = name, .root_module = cppModule(b, target, optimize) });
        const dir = if (std.mem.startsWith(u8, name, "quadmesh_")) "tools" else "examples";
        exe.root_module.addCSourceFiles(.{ .files = &.{b.fmt("{s}/{s}.cpp", .{ dir, name })}, .flags = &cpp_flags });
        if (std.mem.eql(u8, name, "cpp_template_gaps")) exe.root_module.addIncludePath(b.path("src/core"));
        exe.root_module.linkLibrary(core);
        examples_step.dependOn(&b.addInstallArtifact(exe, .{}).step);
    }
    const c_minimal = b.addExecutable(.{
        .name = "c_minimal",
        .root_module = b.createModule(.{ .target = target, .optimize = optimize, .link_libc = true }),
    });
    c_minimal.root_module.addIncludePath(b.path("include"));
    c_minimal.root_module.addCSourceFiles(.{ .files = &.{"examples/c_minimal.c"}, .flags = &.{"-std=c11"} });
    c_minimal.root_module.linkLibrary(capi_static);
    examples_step.dependOn(&b.addInstallArtifact(c_minimal, .{}).step);

    const test_step = b.step("test", "Run the gtest suites and the Python binding test");
    // The Python binding against the shared library needs nothing else.
    const py = b.addSystemCommand(&.{ "python3", "-I" });
    py.addFileArg(b.path("tests/integration/python_binding_test.py"));
    py.addArtifactArg(capi_shared);
    test_step.dependOn(&py.step);

    // googletest is built from source with this toolchain's libc++, so it matches the tests.
    const googletest = b.lazyDependency("googletest", .{}) orelse return;
    const gtest = b.addLibrary(.{
        .linkage = .static,
        .name = "gtest",
        .root_module = cppModule(b, target, optimize),
    });
    gtest.root_module.addIncludePath(googletest.path("googletest/include"));
    gtest.root_module.addIncludePath(googletest.path("googletest"));
    gtest.root_module.addCSourceFiles(.{
        .root = googletest.path("googletest"),
        .files = &.{ "src/gtest-all.cc", "src/gtest_main.cc" },
        .flags = &.{"-std=c++20"},
    });
    for (api_tests ++ stage_tests, 0..) |spec, i| {
        const exe = b.addExecutable(.{ .name = spec[0], .root_module = cppModule(b, target, optimize) });
        exe.root_module.addIncludePath(googletest.path("googletest/include"));
        if (i >= api_tests.len) exe.root_module.addIncludePath(b.path("src/core"));
        // The CAD-face fixtures are read relative to the package root, the tests' working directory.
        exe.root_module.addCMacro("QUADMESH_CAD_FIXTURES", "\"tests/fixtures/cad_faces\"");
        exe.root_module.addCSourceFiles(.{ .files = &.{spec[1]}, .flags = &(cpp_flags ++ [_][]const u8{"-Wno-character-conversion"}) });
        exe.root_module.linkLibrary(if (i >= api_tests.len) core else capi_static);
        exe.root_module.linkLibrary(gtest);
        const run = b.addRunArtifact(exe);
        run.setCwd(b.path("."));
        test_step.dependOn(&run.step);
    }
}

fn cppModule(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.builtin.Optimize) *std.Build.Module {
    const module = b.createModule(.{ .target = target, .optimize = optimize, .link_libcpp = true });
    module.addIncludePath(b.path("include"));
    return module;
}
