//! Readers for the WebMesh test faces.
//!
//! Text format: the loop count, then per loop a point count followed by that many
//! "x y" lines. The first loop is the outer boundary, the rest are holes.
//!
//! JSON format (curve faces, `OPEN_CURVES.md`): {"target_size", "elements_per_circle",
//! "loops": [{"role": "outer" | "hole" | "control" | "curve", "points": [[x, y], ...]}]}.
//! Every loop and curve is fixed: its points are its nodes.

const std = @import("std");
const geom = @import("geom.zig");
const boundary = @import("boundary.zig");
const Vec2 = geom.Vec2;
const Allocator = std.mem.Allocator;

pub const Face = struct {
    points: [][]Vec2,
    loops: []boundary.Loop,
    /// Fixed runs (JSON faces: one per loop), owned.
    runs: [][]boundary.FixedRun = &.{},
    target_size: ?f64 = null,
    elements_per_circle: ?u32 = null,

    pub fn deinit(self: *Face, gpa: Allocator) void {
        for (self.points) |p| gpa.free(p);
        gpa.free(self.points);
        gpa.free(self.loops);
        for (self.runs) |r| gpa.free(r);
        if (self.runs.len > 0) gpa.free(self.runs);
    }
};

const JsonFace = struct {
    description: ?[]const u8 = null,
    target_size: ?f64 = null,
    elements_per_circle: ?u32 = null,
    loops: []const struct {
        role: []const u8,
        points: []const [2]f64,
    },
};

/// Parses a JSON face; every loop gets a fixed run over all its points.
pub fn parseJson(gpa: Allocator, text: []const u8) ParseError!Face {
    const parsed = std.json.parseFromSlice(JsonFace, gpa, text, .{ .ignore_unknown_fields = true }) catch |e| switch (e) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return error.BadFaceFile,
    };
    defer parsed.deinit();
    const jf = parsed.value;
    const nl = jf.loops.len;
    if (nl == 0) return error.BadFaceFile;
    const points = try gpa.alloc([]Vec2, nl);
    var np: usize = 0;
    errdefer {
        for (points[0..np]) |p| gpa.free(p);
        gpa.free(points);
    }
    const runs = try gpa.alloc([]boundary.FixedRun, nl);
    var nr: usize = 0;
    errdefer {
        for (runs[0..nr]) |r| gpa.free(r);
        gpa.free(runs);
    }
    const loops = try gpa.alloc(boundary.Loop, nl);
    errdefer gpa.free(loops);
    for (jf.loops, 0..) |jl, li| {
        const role: boundary.LoopRole = if (std.mem.eql(u8, jl.role, "outer")) .outer else if (std.mem.eql(u8, jl.role, "hole"))
            .hole
        else if (std.mem.eql(u8, jl.role, "control")) .control else if (std.mem.eql(u8, jl.role, "curve")) .curve else return error.BadFaceFile;
        const pts = try gpa.alloc(Vec2, jl.points.len);
        for (jl.points, 0..) |q, k| pts[k] = .init(q[0], q[1]);
        points[li] = pts;
        np += 1;
        const rl = try gpa.alloc(boundary.FixedRun, 1);
        if (role == .curve) {
            if (pts.len < 2) {
                gpa.free(rl);
                return error.BadFaceFile;
            }
            rl[0] = .{ .start = .{ .segment = 0, .parameter = 0 }, .end = .{ .segment = @intCast(pts.len - 2), .parameter = 1 }, .nodes = pts, .closed = false };
        } else {
            rl[0] = .{ .nodes = pts, .closed = true };
        }
        runs[li] = rl;
        nr += 1;
        loops[li] = .{ .role = role, .points = pts, .fixed_runs = rl };
    }
    return .{ .points = points, .loops = loops, .runs = runs, .target_size = jf.target_size, .elements_per_circle = jf.elements_per_circle };
}

pub const ParseError = error{ BadFaceFile, OutOfMemory };

pub fn parse(gpa: Allocator, text: []const u8) ParseError!Face {
    var it = std.mem.tokenizeAny(u8, text, " \t\r\n");
    const nloops = try nextInt(&it);
    if (nloops == 0 or nloops > 1_000_000) return error.BadFaceFile;
    const points = try gpa.alloc([]Vec2, nloops);
    var filled: usize = 0;
    errdefer {
        for (points[0..filled]) |p| gpa.free(p);
        gpa.free(points);
    }
    for (0..nloops) |li| {
        const n = try nextInt(&it);
        if (n > 100_000_000) return error.BadFaceFile;
        const pts = try gpa.alloc(Vec2, n);
        errdefer gpa.free(pts);
        for (0..n) |k| {
            const x = try nextFloat(&it);
            const y = try nextFloat(&it);
            pts[k] = .init(x, y);
        }
        points[li] = pts;
        filled += 1;
    }
    const loops = try gpa.alloc(boundary.Loop, nloops);
    for (0..nloops) |li| loops[li] = .{ .role = if (li == 0) .outer else .hole, .points = points[li] };
    return .{ .points = points, .loops = loops };
}

fn nextInt(it: anytype) ParseError!usize {
    const tok = it.next() orelse return error.BadFaceFile;
    return std.fmt.parseInt(usize, tok, 10) catch error.BadFaceFile;
}

fn nextFloat(it: anytype) ParseError!f64 {
    const tok = it.next() orelse return error.BadFaceFile;
    return std.fmt.parseFloat(f64, tok) catch error.BadFaceFile;
}

test "parse JSON face with a curve" {
    const gpa = std.testing.allocator;
    var f = try parseJson(gpa,
        \\{"description": "x", "target_size": 2.0, "elements_per_circle": 12, "loops": [
        \\ {"role": "outer", "points": [[0,0],[4,0],[4,4],[0,4]]},
        \\ {"role": "curve", "points": [[1,2],[2,2],[3,2]]}]}
    );
    defer f.deinit(gpa);
    try std.testing.expectEqual(boundary.LoopRole.curve, f.loops[1].role);
    try std.testing.expectEqual(@as(u32, 1), f.loops[1].fixed_runs[0].end.segment);
    try std.testing.expect(!f.loops[1].fixed_runs[0].closed);
    try std.testing.expectEqual(@as(f64, 2.0), f.target_size.?);
}

test "parse face text" {
    const gpa = std.testing.allocator;
    var f = try parse(gpa, "2\n4\n0 0\n1 0\n1 1\n0 1\n3\n0.2 0.2\n0.4 0.2\n0.3 0.4\n");
    defer f.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 2), f.loops.len);
    try std.testing.expectEqual(boundary.LoopRole.hole, f.loops[1].role);
    try std.testing.expectEqual(@as(f64, 0.4), f.loops[1].points[1].x);
    try std.testing.expectError(error.BadFaceFile, parse(gpa, "1\n3\n0 0\n1 0\n"));
}
