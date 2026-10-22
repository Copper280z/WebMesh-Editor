const std = @import("std");

// Builds the face meshers WebMesh loads (see quadmesh_bridge.py) into zig-out/lib:
// quadmesh (meshers/quadmesh, C++20) and the paved Q-Morph mesher (meshers/paved, Zig).
pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.option(std.builtin.Optimize, "optimize", "Optimization mode (default fast)") orelse .fast;
    for ([_][]const u8{ "quadmesh", "paved" }) |name| {
        const mesher = b.dependency(name, .{ .target = target, .optimize = optimize });
        b.getInstallStep().dependOn(mesher.builder.getInstallStep());
    }

    // Each mesher's own suites, run in its folder: quadmesh's gtest and Python binding tests,
    // paved's unit and milestone tests and its Python and wasm binding tests.
    const test_step = b.step("test", "Run both meshers' test suites");
    const suites = [_][3][]const u8{
        .{ "meshers/quadmesh", "test", "-Doptimize=fast" },
        .{ "meshers/paved", "test", "-Doptimize=debug" },
        .{ "meshers/paved", "test-bindings", "-Doptimize=fast" },
    };
    for (suites) |suite| {
        const run = b.addSystemCommand(&.{ b.graph.zig_exe, "build", suite[1], suite[2] });
        run.setCwd(b.path(suite[0]));
        run.has_side_effects = true;
        test_step.dependOn(&run.step);
    }
}
