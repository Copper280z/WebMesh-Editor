//! Milestone tests for the paved mesher (run with `zig build test`).

const std = @import("std");
const geom = @import("geom.zig");
const boundary = @import("boundary.zig");
const mesher = @import("mesher.zig");
const faces = @import("faces.zig");
const fixtures = @import("fixtures.zig");
const Vec2 = geom.Vec2;
const gpa = std.testing.allocator;

fn meshLoops(loops: []const boundary.Loop, opts: mesher.Options) !mesher.Result {
    var diag = mesher.Diag{};
    return mesher.generate(gpa, loops, opts, &diag) catch |e| {
        std.debug.print("meshing failed: {s}: {s}\n", .{ @errorName(e), diag.message() });
        return e;
    };
}

fn expectValid(r: *const mesher.Result) !void {
    if (!r.report.valid) {
        for (r.report.issues.items) |s| std.debug.print("issue: {s}\n", .{s});
    }
    try std.testing.expect(r.report.valid);
    try std.testing.expect(r.report.all_quads);
    try std.testing.expect(r.report.conforming);
    try std.testing.expectEqual(@as(usize, 0), r.report.inverted);
    try std.testing.expect(r.report.fixed_kept);
}

fn rect(w: f64, h: f64) [4]Vec2 {
    return .{ .init(0, 0), .init(w, 0), .init(w, h), .init(0, h) };
}

// ---------------------------------------------------------------------------
// Milestone 2: Q-Morph on single-loop domains, convex and concave.

test "milestone 2: rectangles mesh to the exact structured grid" {
    const cases = [_][3]f64{ .{ 40, 40, 4 }, .{ 60, 25, 4 }, .{ 44, 18, 4 }, .{ 30, 10, 2 } };
    for (cases) |c| {
        const pts = rect(c[0], c[1]);
        const loops = [_]boundary.Loop{.{ .role = .outer, .points = &pts }};
        var r = try meshLoops(&loops, .{ .target_size = c[2] });
        defer r.deinit(gpa);
        try expectValid(&r);
        const nx: usize = @intFromFloat(@round(c[0] / c[2]));
        const ny: usize = @intFromFloat(@round(c[1] / c[2]));
        try std.testing.expectEqual(nx * ny, r.quads.len);
        try std.testing.expectEqual(@as(usize, 0), r.report.irregular_nodes);
        try std.testing.expect(r.report.min_angle_deg > 85);
    }
}

test "milestone 2: L-shape (reflex corner) meshes to the exact grid" {
    const pts = [_]Vec2{ .init(0, 0), .init(40, 0), .init(40, 20), .init(20, 20), .init(20, 40), .init(0, 40) };
    const loops = [_]boundary.Loop{.{ .role = .outer, .points = &pts }};
    var r = try meshLoops(&loops, .{ .target_size = 4 });
    defer r.deinit(gpa);
    try expectValid(&r);
    try std.testing.expectEqual(@as(usize, 75), r.quads.len);
    try std.testing.expectEqual(@as(usize, 0), r.report.irregular_nodes);
}

test "milestone 2: concave and curved single loops are valid" {
    // A C-shape and a disk.
    const c_shape = [_]Vec2{ .init(0, 0), .init(30, 0), .init(30, 8), .init(10, 8), .init(10, 22), .init(30, 22), .init(30, 30), .init(0, 30) };
    const disk = try fixtures.circlePoints(gpa, 0, 0, 15, 96, true);
    defer gpa.free(disk);
    for ([_][]const Vec2{ &c_shape, disk }) |pts| {
        const loops = [_]boundary.Loop{.{ .role = .outer, .points = pts }};
        var r = try meshLoops(&loops, .{ .target_size = 2.5 });
        defer r.deinit(gpa);
        try expectValid(&r);
        try std.testing.expect(r.report.min_scaled_jacobian >= 0.3);
    }
}

// ---------------------------------------------------------------------------
// Milestone 3: holes, several fronts, splits and merges, closures, parity.

test "milestone 3: 40 x 20 plate, diameter-10 hole, fixed nodes every 2 mm" {
    var fx = try fixtures.plateWithHoleFixed(gpa);
    defer fx.deinit(gpa);
    var r = try meshLoops(fx.loops.items, .{ .target_size = 2 });
    defer r.deinit(gpa);
    try expectValid(&r);
    // Exactly those 76 boundary nodes, bit for bit, in order.
    try std.testing.expectEqual(@as(usize, 76), r.report.boundary_edge_count);
    var k: usize = 0;
    for (fx.loops.items) |l| for (l.fixed_runs[0].nodes) |q| {
        try std.testing.expect(r.nodes[k].eql(q));
        k += 1;
    };
    try std.testing.expect(r.report.min_scaled_jacobian >= 0.3);
    // Provenance: every boundary node record points at a fixed run node.
    try std.testing.expectEqual(@as(usize, 76), r.boundary_nodes.len);
    for (r.boundary_nodes) |b| try std.testing.expect(b.fixed_run == 0 and b.fixed_node >= 0);
}

test "milestone 3: a diameter-3 hole gets 12 elements at size 4" {
    var fx = try fixtures.plateWithSmallHole(gpa);
    defer fx.deinit(gpa);
    var r = try meshLoops(fx.loops.items, .{ .target_size = 4 });
    defer r.deinit(gpa);
    try expectValid(&r);
    var on_hole: usize = 0;
    for (r.boundary_nodes) |b| {
        if (b.loop == 1) on_hole += 1;
    }
    try std.testing.expectEqual(@as(usize, 12), on_hole);
    try std.testing.expect(r.report.min_scaled_jacobian >= 0.3);
    // Element budget: 1.5 * area / h^2 plus one row of boundary elements.
    const area = 60.0 * 40.0 - std.math.pi * 1.5 * 1.5;
    try std.testing.expect(@as(f64, @floatFromInt(r.quads.len)) <= 1.5 * area / 16.0 + @as(f64, @floatFromInt(r.report.boundary_edge_count)));
}

test "milestone 3: an odd fixed boundary-edge count is rejected with a clear error" {
    const sq = rect(10, 10);
    const nodes = [_]Vec2{ .init(0, 0), .init(10, 0), .init(10, 10), .init(5, 10), .init(0, 10) };
    const runs = [_]boundary.FixedRun{.{ .nodes = &nodes, .closed = true }};
    const loops = [_]boundary.Loop{.{ .role = .outer, .points = &sq, .fixed_runs = &runs }};
    var diag = mesher.Diag{};
    try std.testing.expectError(error.OddBoundary, mesher.generate(gpa, &loops, .{ .target_size = 2 }, &diag));
    try std.testing.expect(std.mem.indexOf(u8, diag.message(), "odd number of fixed boundary edges") != null);
    try std.testing.expect(std.mem.indexOf(u8, diag.message(), "all-quad mesh is impossible") != null);
}

test "milestone 3: several holes, mixed fixed and free runs, odd loops" {
    // Plate with three holes; the outer loop has a fixed run on the bottom edge.
    const outer = rect(60, 30);
    const bottom = [_]Vec2{ .init(0, 0), .init(3, 0), .init(6, 0), .init(10, 0), .init(15, 0), .init(21, 0), .init(30, 0) };
    const runs = [_]boundary.FixedRun{.{ .start = .{ .segment = 0, .parameter = 0 }, .end = .{ .segment = 0, .parameter = 0.5 }, .nodes = &bottom }};
    const h1 = try fixtures.circlePoints(gpa, 12, 15, 4, 64, false);
    defer gpa.free(h1);
    const h2 = try fixtures.circlePoints(gpa, 30, 15, 1.5, 128, true); // given counterclockwise
    defer gpa.free(h2);
    const h3 = try fixtures.circlePoints(gpa, 47, 12, 6, 80, false);
    defer gpa.free(h3);
    const loops = [_]boundary.Loop{
        .{ .role = .outer, .points = &outer, .fixed_runs = &runs },
        .{ .role = .hole, .points = h1 },
        .{ .role = .hole, .points = h2 },
        .{ .role = .hole, .points = h3, .target_size = 1.5 },
    };
    var r = try meshLoops(&loops, .{ .target_size = 3 });
    defer r.deinit(gpa);
    try expectValid(&r);
    for (bottom, 0..) |q, k| try std.testing.expect(r.nodes[k].eql(q));
    try std.testing.expect(r.report.min_scaled_jacobian >= 0.3);
}

test "milestone 3: control loops become interior mesh edges; crossing loops are rejected" {
    const outer = rect(60, 30);
    const ctrl = [_]Vec2{ .init(10, 10), .init(30, 10), .init(30, 22), .init(10, 22) };
    const hole = try fixtures.circlePoints(gpa, 45, 15, 4, 48, false);
    defer gpa.free(hole);
    const loops = [_]boundary.Loop{
        .{ .role = .outer, .points = &outer },
        .{ .role = .control, .points = &ctrl },
        .{ .role = .hole, .points = hole },
    };
    var r = try meshLoops(&loops, .{ .target_size = 3 });
    defer r.deinit(gpa);
    // The validator requires every control edge to be shared by two quads.
    try expectValid(&r);
    try std.testing.expect(r.report.min_scaled_jacobian >= 0.3);

    const crossing = try fixtures.circlePoints(gpa, 30, 15, 4, 48, false);
    defer gpa.free(crossing);
    const bad = [_]boundary.Loop{
        .{ .role = .outer, .points = &outer },
        .{ .role = .control, .points = &ctrl },
        .{ .role = .hole, .points = crossing },
    };
    var diag = mesher.Diag{};
    try std.testing.expectError(error.InvalidInput, mesher.generate(gpa, &bad, .{ .target_size = 3 }, &diag));
    try std.testing.expect(std.mem.indexOf(u8, diag.message(), "intersect") != null);
}

// ---------------------------------------------------------------------------
// Milestone 4 and 5: cleanup, smoothing, fallback; the seven faces; determinism.

const face_files = [_][]const u8{
    "balancer_chassis_face17", "balancer_chassis_face19", "balancer_chassis_face21",
    "rover_chassis_face1",     "rover_chassis_face2",     "rover_chassis_face61",
    "wheel_top",
};

fn faceText(comptime name: []const u8) []const u8 {
    return @embedFile(name);
}

test "milestone 4: cleanup and smoothing improve a raw Q-Morph mesh" {
    var face = try faces.parse(gpa, faceText("balancer_chassis_face19"));
    defer face.deinit(gpa);
    var raw = try meshLoops(face.loops, .{ .target_size = 4, .enable_smoothing = false, .enable_cleanup = false });
    defer raw.deinit(gpa);
    var full = try meshLoops(face.loops, .{ .target_size = 4 });
    defer full.deinit(gpa);
    try std.testing.expect(raw.report.all_quads); // the fallback leaves no triangles
    try expectValid(&full);
    try std.testing.expect(full.report.min_scaled_jacobian > raw.report.min_scaled_jacobian);
    try std.testing.expect(full.report.irregular_share <= raw.report.irregular_share);
}

test "milestone 5: the seven test faces meet the validity and quality floor" {
    inline for (face_files) |name| {
        var face = try faces.parse(gpa, faceText(name));
        defer face.deinit(gpa);
        var r = try meshLoops(face.loops, .{ .target_size = 4 });
        defer r.deinit(gpa);
        expectValid(&r) catch |e| {
            std.debug.print("face {s}\n", .{name});
            return e;
        };
        try std.testing.expect(r.report.min_scaled_jacobian >= 0.3);
        try std.testing.expect(r.report.share_sj_05 >= 0.95);
        // Every input corner node is a mesh node (all faces here have no fixed runs).
        try std.testing.expect(r.report.max_boundary_deviation < 1e-9);
    }
}

test "milestone 5: the same input gives the same mesh" {
    var face = try faces.parse(gpa, faceText("rover_chassis_face61"));
    defer face.deinit(gpa);
    var a = try meshLoops(face.loops, .{ .target_size = 4 });
    defer a.deinit(gpa);
    var b = try meshLoops(face.loops, .{ .target_size = 4 });
    defer b.deinit(gpa);
    try std.testing.expectEqual(a.nodes.len, b.nodes.len);
    try std.testing.expectEqual(a.quads.len, b.quads.len);
    try std.testing.expectEqualSlices(u8, std.mem.sliceAsBytes(a.nodes), std.mem.sliceAsBytes(b.nodes));
    try std.testing.expectEqualSlices(u8, std.mem.sliceAsBytes(a.quads), std.mem.sliceAsBytes(b.quads));
}

// ---------------------------------------------------------------------------
// Milestone 6: open control curves (ABI 0.3).

fn curveRun(pts: []const Vec2) [1]boundary.FixedRun {
    return .{.{ .start = .{ .segment = 0, .parameter = 0 }, .end = .{ .segment = @intCast(pts.len - 2), .parameter = 1 }, .nodes = pts }};
}

/// Checks the open-curve contract on a result: every curve node kept, each curve segment an
/// edge of exactly two quads.
fn expectCurves(r: *const mesher.Result, loops: []const boundary.Loop) !void {
    try expectValid(r);
    var use = std.AutoHashMap(u64, u8).init(gpa);
    defer use.deinit();
    for (r.quads) |q| for (0..4) |k| {
        const a = q[k];
        const b = q[(k + 1) % 4];
        const gop = try use.getOrPut((@as(u64, @min(a, b)) << 32) | @max(a, b));
        if (!gop.found_existing) gop.value_ptr.* = 0;
        gop.value_ptr.* += 1;
    };
    for (loops) |l| {
        if (l.role != .curve) continue;
        var ids: [256]u32 = undefined;
        for (l.points, 0..) |p, k| {
            var found = false;
            for (r.nodes, 0..) |q, v| if (q.eql(p)) {
                ids[k] = @intCast(v);
                found = true;
                break;
            };
            try std.testing.expect(found);
        }
        for (0..l.points.len - 1) |k| {
            const a = ids[k];
            const b = ids[k + 1];
            try std.testing.expectEqual(@as(u8, 2), use.get((@as(u64, @min(a, b)) << 32) | @max(a, b)) orelse 0);
        }
    }
    try std.testing.expect(r.report.min_scaled_jacobian >= 0.3);
    try std.testing.expect(r.report.min_angle_deg >= 15);
}

test "milestone 6: the curve test faces mesh with every segment shared by two quads" {
    inline for (.{ "tee", "floating", "hole_and_boundary", "plus" }) |name| {
        var face = try faces.parseJson(gpa, faceText("curves/" ++ name));
        defer face.deinit(gpa);
        var r = try meshLoops(face.loops, .{ .target_size = face.target_size.?, .elements_per_circle = face.elements_per_circle.? });
        defer r.deinit(gpa);
        expectCurves(&r, face.loops) catch |e| {
            std.debug.print("face {s}\n", .{name});
            return e;
        };
        try std.testing.expect(r.report.min_angle_deg >= 20);
        // Provenance: one record per loop or curve a node belongs to.
        var total: usize = 0;
        for (face.loops) |l| total += l.points.len;
        try std.testing.expectEqual(total, r.boundary_nodes.len);
    }
}

test "milestone 6: crossing curves are refused with a message naming them" {
    var face = try faces.parseJson(gpa, faceText("curves/invalid_crossing"));
    defer face.deinit(gpa);
    var diag = mesher.Diag{};
    try std.testing.expectError(error.Unsupported, mesher.generate(gpa, face.loops, .{ .target_size = 4 }, &diag));
    try std.testing.expect(std.mem.indexOf(u8, diag.message(), "curve 1 crosses curve 2") != null);
}

test "milestone 6: odd segment counts, T-junctions on curves, one-segment curves" {
    const outer = rect(60, 40);
    // Curve A: 3 segments (odd), from the bottom edge's corner-free node up into the middle.
    const a_pts = [_]Vec2{ .init(20, 0), .init(20, 6), .init(20, 12), .init(20, 18) };
    // Curve B: ends on curve A's interior node (20, 12) and runs to a free end.
    const b_pts = [_]Vec2{ .init(20, 12), .init(26, 12), .init(32, 12), .init(38, 12) };
    // Curve C: a single free segment.
    const c_pts = [_]Vec2{ .init(45, 28), .init(49, 31) };
    const ra = curveRun(&a_pts);
    const rb = curveRun(&b_pts);
    const rc = curveRun(&c_pts);
    const loops = [_]boundary.Loop{
        .{ .role = .outer, .points = &outer },
        .{ .role = .curve, .points = &a_pts, .fixed_runs = &ra },
        .{ .role = .curve, .points = &b_pts, .fixed_runs = &rb },
        .{ .role = .curve, .points = &c_pts, .fixed_runs = &rc },
    };
    var r = try meshLoops(&loops, .{ .target_size = 4 });
    defer r.deinit(gpa);
    try expectCurves(&r, &loops);
    // The free outer loop has a node exactly at curve A's end, shared with the curve.
    var shared: usize = 0;
    for (r.boundary_nodes) |bnode| {
        if (r.nodes[bnode.node].eql(a_pts[0])) shared += 1;
    }
    try std.testing.expectEqual(@as(usize, 2), shared);
}

test "milestone 6: a curve end between the nodes a free loop would get becomes a node" {
    const outer = rect(60, 40);
    const pts = [_]Vec2{ .init(21.3, 0), .init(21.3, 7), .init(21.3, 14), .init(21.3, 21) };
    const run = curveRun(&pts);
    const loops = [_]boundary.Loop{ .{ .role = .outer, .points = &outer }, .{ .role = .curve, .points = &pts, .fixed_runs = &run } };
    var r = try meshLoops(&loops, .{ .target_size = 4 });
    defer r.deinit(gpa);
    try expectCurves(&r, &loops);
}

test "milestone 6: curve rule violations are refused" {
    const outer = rect(40, 30);
    const hole = [_]Vec2{ .init(25, 10), .init(25, 20), .init(35, 20), .init(35, 10) };
    const hole_run = [_]boundary.FixedRun{.{ .nodes = &hole, .closed = true }};
    const outer_nodes = try fixtures.rectNodes(gpa, 0, 0, 40, 30, 5);
    defer gpa.free(outer_nodes);
    const outer_run = [_]boundary.FixedRun{.{ .nodes = outer_nodes, .closed = true }};
    const Case = struct { pts: []const Vec2, msg: []const u8 };
    const cases = [_]Case{
        // End on the outer edge between its nodes (nodes every 5 mm on y = 0).
        .{ .pts = &.{ .init(12, 0), .init(12, 8), .init(12, 14) }, .msg = "touches outer loop 0 between its nodes" },
        // Inside the hole.
        .{ .pts = &.{ .init(28, 13), .init(30, 15), .init(32, 17) }, .msg = "outside the meshed region" },
        // Crossing itself.
        .{ .pts = &.{ .init(5, 10), .init(15, 20), .init(15, 10), .init(5, 20) }, .msg = "crosses itself" },
        // Crossing the hole.
        .{ .pts = &.{ .init(15, 15), .init(30, 15) }, .msg = "crosses hole 1" },
    };
    for (cases) |c| {
        const run = curveRun(c.pts);
        const loops = [_]boundary.Loop{
            .{ .role = .outer, .points = &outer, .fixed_runs = &outer_run },
            .{ .role = .hole, .points = &hole, .fixed_runs = &hole_run },
            .{ .role = .curve, .points = c.pts, .fixed_runs = &run },
        };
        var diag = mesher.Diag{};
        try std.testing.expectError(error.Unsupported, mesher.generate(gpa, &loops, .{ .target_size = 4 }, &diag));
        if (std.mem.indexOf(u8, diag.message(), c.msg) == null) {
            std.debug.print("expected '{s}', got '{s}'\n", .{ c.msg, diag.message() });
            return error.TestUnexpectedResult;
        }
    }
    // A curve without a fixed run is refused (free curves are not supported).
    const pts = [_]Vec2{ .init(5, 5), .init(10, 10) };
    const loops = [_]boundary.Loop{ .{ .role = .outer, .points = &outer }, .{ .role = .curve, .points = &pts } };
    var diag = mesher.Diag{};
    try std.testing.expectError(error.Unsupported, mesher.generate(gpa, &loops, .{ .target_size = 4 }, &diag));
}
