const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Core library module: pure computation, standard library only, no I/O.
    const paved = b.addModule("paved", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
    });

    // The seven test faces, embedded for the milestone tests.
    const face_names = [_][]const u8{
        "balancer_chassis_face17", "balancer_chassis_face19", "balancer_chassis_face21",
        "rover_chassis_face1",     "rover_chassis_face2",     "rover_chassis_face61",
        "wheel_top",
    };
    for (face_names) |name| {
        paved.addAnonymousImport(name, .{ .root_source_file = b.path(b.fmt("faces/{s}.txt", .{name})) });
    }
    // Open-curve faces (ABI 0.3).
    const curve_names = [_][]const u8{ "tee", "floating", "hole_and_boundary", "plus", "invalid_crossing" };
    for (curve_names) |name| {
        paved.addAnonymousImport(b.fmt("curves/{s}", .{name}), .{ .root_source_file = b.path(b.fmt("faces/curves/{s}.json", .{name})) });
    }

    // C ABI: static and shared libraries plus header.
    const c_api_static = b.addLibrary(.{
        .linkage = .static,
        .name = "quadmesh_paved",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/c_api.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    c_api_static.installHeader(b.path("include/quadmesh_paved.h"), "quadmesh_paved.h");
    b.installArtifact(c_api_static);

    const c_api_shared = b.addLibrary(.{
        .linkage = .dynamic,
        .name = "quadmesh_paved",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/c_api.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(c_api_shared);

    // Command-line tool: mesh a test-face file, print the report, write an SVG.
    const exe = b.addExecutable(.{
        .name = "paved",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{ .name = "paved", .module = paved }},
        }),
    });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    run_cmd.addPassthruArgs();
    const run_step = b.step("run", "Run the CLI: zig build run -- face.txt size [out.svg]");
    run_step.dependOn(&run_cmd.step);

    // WebAssembly build: wasm32-freestanding module exporting the C ABI plus malloc/free.
    const wasm_optimize: std.lang.Optimize = if (optimize == .debug) .small else optimize;
    const wasm = b.addExecutable(.{
        .name = "quadmesh_paved",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/wasm.zig"),
            .target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .freestanding }),
            .optimize = wasm_optimize,
            .strip = true,
        }),
    });
    wasm.entry = .disabled;
    wasm.rdynamic = true;
    wasm.stack_size = 1 << 20;
    const install_wasm = b.addInstallArtifact(wasm, .{});
    const wasm_step = b.step("wasm", "Build the WebAssembly module (zig-out/bin/quadmesh_paved.wasm)");
    wasm_step.dependOn(&install_wasm.step);
    b.getInstallStep().dependOn(&install_wasm.step);

    // Unit and milestone tests.
    const lib_tests = b.addTest(.{ .root_module = paved });
    const run_lib_tests = b.addRunArtifact(lib_tests);
    const c_api_tests = b.addTest(.{ .root_module = c_api_static.root_module });
    const run_c_api_tests = b.addRunArtifact(c_api_tests);
    const test_step = b.step("test", "Run unit and milestone tests");
    test_step.dependOn(&run_lib_tests.step);
    test_step.dependOn(&run_c_api_tests.step);

    // Binding tests: Python ctypes against the shared library, Node against the wasm module.
    const py = b.addSystemCommand(&.{ "python3", "-I" });
    py.addFileArg(b.path("tests/test_ctypes.py"));
    py.addArtifactArg(c_api_shared);
    const pyc = b.addSystemCommand(&.{ "python3", "-I" });
    pyc.addFileArg(b.path("tests/test_curves.py"));
    pyc.addArtifactArg(c_api_shared);
    const js = b.addSystemCommand(&.{"node"});
    js.addFileArg(b.path("tests/test_wasm.mjs"));
    js.addArtifactArg(wasm);
    js.addArtifactArg(exe);
    const bindings_step = b.step("test-bindings", "Test the Python ctypes and JavaScript wasm bindings");
    bindings_step.dependOn(&py.step);
    bindings_step.dependOn(&pyc.step);
    bindings_step.dependOn(&js.step);
}
