//! Test geometry shared by the milestone tests.

const std = @import("std");
const geom = @import("geom.zig");
const boundary = @import("boundary.zig");
const Vec2 = geom.Vec2;
const Allocator = std.mem.Allocator;

pub const Owned = struct {
    bufs: std.ArrayList([]Vec2) = .empty,
    runs: std.ArrayList([]boundary.FixedRun) = .empty,
    loops: std.ArrayList(boundary.Loop) = .empty,

    pub fn deinit(self: *Owned, gpa: Allocator) void {
        for (self.bufs.items) |b| gpa.free(b);
        for (self.runs.items) |r| gpa.free(r);
        self.bufs.deinit(gpa);
        self.runs.deinit(gpa);
        self.loops.deinit(gpa);
    }

    fn keep(self: *Owned, gpa: Allocator, pts: []Vec2) ![]Vec2 {
        try self.bufs.append(gpa, pts);
        return pts;
    }
};

pub fn circlePoints(gpa: Allocator, cx: f64, cy: f64, r: f64, n: usize, ccw: bool) ![]Vec2 {
    const pts = try gpa.alloc(Vec2, n);
    for (0..n) |i| {
        const t = 2.0 * std.math.pi * @as(f64, @floatFromInt(i)) / @as(f64, @floatFromInt(n));
        const a = if (ccw) t else -t;
        pts[i] = .init(cx + r * @cos(a), cy + r * @sin(a));
    }
    return pts;
}

pub fn rectPoints(gpa: Allocator, x0: f64, y0: f64, x1: f64, y1: f64) ![]Vec2 {
    const pts = try gpa.alloc(Vec2, 4);
    pts[0] = .init(x0, y0);
    pts[1] = .init(x1, y0);
    pts[2] = .init(x1, y1);
    pts[3] = .init(x0, y1);
    return pts;
}

/// Nodes every `step` along the rectangle boundary, counterclockwise from (x0, y0).
pub fn rectNodes(gpa: Allocator, x0: f64, y0: f64, x1: f64, y1: f64, step: f64) ![]Vec2 {
    var list: std.ArrayList(Vec2) = .empty;
    errdefer list.deinit(gpa);
    const nx: usize = @intFromFloat(@round((x1 - x0) / step));
    const ny: usize = @intFromFloat(@round((y1 - y0) / step));
    const fx = (x1 - x0) / @as(f64, @floatFromInt(nx));
    const fy = (y1 - y0) / @as(f64, @floatFromInt(ny));
    for (0..nx) |i| try list.append(gpa, .init(x0 + fx * @as(f64, @floatFromInt(i)), y0));
    for (0..ny) |i| try list.append(gpa, .init(x1, y0 + fy * @as(f64, @floatFromInt(i))));
    for (0..nx) |i| try list.append(gpa, .init(x1 - fx * @as(f64, @floatFromInt(i)), y1));
    for (0..ny) |i| try list.append(gpa, .init(x0, y1 - fy * @as(f64, @floatFromInt(i))));
    return list.toOwnedSlice(gpa);
}

/// 40 x 20 plate with a centered diameter-10 hole; fixed boundary nodes every 2 mm
/// (60 on the outer loop, 16 on the hole: 76 in total).
pub fn plateWithHoleFixed(gpa: Allocator) !Owned {
    var o = Owned{};
    errdefer o.deinit(gpa);
    const outer = try o.keep(gpa, try rectPoints(gpa, 0, 0, 40, 20));
    const outer_nodes = try o.keep(gpa, try rectNodes(gpa, 0, 0, 40, 20, 2));
    const hole = try o.keep(gpa, try circlePoints(gpa, 20, 10, 5, 128, false));
    const hole_nodes = try o.keep(gpa, try circlePoints(gpa, 20, 10, 5, 16, false));
    const r1 = try gpa.alloc(boundary.FixedRun, 1);
    r1[0] = .{ .nodes = outer_nodes, .closed = true };
    try o.runs.append(gpa, r1);
    const r2 = try gpa.alloc(boundary.FixedRun, 1);
    r2[0] = .{ .nodes = hole_nodes, .closed = true };
    try o.runs.append(gpa, r2);
    try o.loops.append(gpa, .{ .role = .outer, .points = outer, .fixed_runs = r1 });
    try o.loops.append(gpa, .{ .role = .hole, .points = hole, .fixed_runs = r2 });
    return o;
}

/// 60 x 40 plate with a centered diameter-3 hole sampled with 128 points (all free).
pub fn plateWithSmallHole(gpa: Allocator) !Owned {
    var o = Owned{};
    errdefer o.deinit(gpa);
    const outer = try o.keep(gpa, try rectPoints(gpa, 0, 0, 60, 40));
    const hole = try o.keep(gpa, try circlePoints(gpa, 30, 20, 1.5, 128, false));
    try o.loops.append(gpa, .{ .role = .outer, .points = outer });
    try o.loops.append(gpa, .{ .role = .hole, .points = hole });
    return o;
}
