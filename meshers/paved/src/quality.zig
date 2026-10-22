//! Validation and quality report of a finished quad mesh.
//!
//! Validity means: all elements are quads; every quad is strictly convex and
//! counterclockwise; the mesh is conforming (each edge used by one or two
//! quads, the edges used once are exactly the outer and hole loop edges, and
//! control-loop edges are interior edges); the quads cover the domain area;
//! and every fixed boundary node is present bit for bit with its fixed edges.

const std = @import("std");
const geom = @import("geom.zig");
const Vec2 = geom.Vec2;
const Allocator = std.mem.Allocator;

pub const LoopEdges = struct {
    /// Closed node cycle of a loop (final node numbering).
    nodes: []const u32,
    /// Control loops are interior constraints (edges shared by two quads).
    control: bool = false,
    hole: bool = false,
    /// Open curve: no edge from the last node back to the first.
    open: bool = false,
};

pub const FixedNode = struct {
    node: u32,
    pos: Vec2,
};

pub const Input = struct {
    nodes: []const Vec2,
    quads: []const [4]u32,
    tris: []const [3]u32 = &.{},
    loops: []const LoopEdges,
    fixed_nodes: []const FixedNode = &.{},
    /// Fixed edges as node pairs (consecutive fixed-run nodes).
    fixed_edges: []const [2]u32 = &.{},
    /// Largest distance of a free boundary node from its input polyline (computed by the caller).
    boundary_deviation: f64 = 0,
};

pub const Report = struct {
    valid: bool = false,
    all_quads: bool = false,
    conforming: bool = false,
    covers_domain: bool = false,
    fixed_kept: bool = false,
    inverted: usize = 0,
    quad_count: usize = 0,
    node_count: usize = 0,
    boundary_edge_count: usize = 0,
    min_angle_deg: f64 = 0,
    max_angle_deg: f64 = 0,
    min_scaled_jacobian: f64 = 0,
    /// 5th percentile of the per-quad minimum scaled Jacobian.
    p5_scaled_jacobian: f64 = 0,
    /// Share of quads with scaled Jacobian of at least 0.5.
    share_sj_05: f64 = 0,
    interior_nodes: usize = 0,
    irregular_nodes: usize = 0,
    /// Share of interior nodes not shared by exactly four quads.
    irregular_share: f64 = 0,
    min_edge_ratio: f64 = 0,
    max_boundary_deviation: f64 = 0,
    domain_area: f64 = 0,
    mesh_area: f64 = 0,
    issues: std.ArrayList([]u8) = .empty,

    pub fn deinit(self: *Report, gpa: Allocator) void {
        for (self.issues.items) |s| gpa.free(s);
        self.issues.deinit(gpa);
    }

    fn issue(self: *Report, gpa: Allocator, comptime fmt: []const u8, args: anytype) !void {
        if (self.issues.items.len >= 64) return;
        try self.issues.append(gpa, try std.fmt.allocPrint(gpa, fmt, args));
    }
};

inline fn ekey(a: u32, b: u32) u64 {
    return (@as(u64, @min(a, b)) << 32) | @max(a, b);
}

pub fn validate(gpa: Allocator, in: Input) !Report {
    var r = Report{};
    errdefer r.deinit(gpa);
    const nn = in.nodes.len;
    r.node_count = nn;
    r.quad_count = in.quads.len;
    r.all_quads = in.tris.len == 0;
    if (!r.all_quads) try r.issue(gpa, "{d} triangles remain (not all quads)", .{in.tris.len});

    // Element sanity, orientation and quality.
    var sjs = try gpa.alloc(f64, in.quads.len);
    defer gpa.free(sjs);
    var min_ang: f64 = 360;
    var max_ang: f64 = 0;
    var min_ratio: f64 = 1;
    var area: f64 = 0;
    var bad_index = false;
    for (in.quads, 0..) |q, qi| {
        var ok_idx = true;
        for (q, 0..) |v, k| {
            if (v >= nn) ok_idx = false;
            for (q[k + 1 ..]) |w| if (w == v) {
                ok_idx = false;
            };
        }
        if (!ok_idx) {
            if (!bad_index) try r.issue(gpa, "quad {d} has invalid or repeated node indices", .{qi});
            bad_index = true;
            sjs[qi] = -1;
            continue;
        }
        const pq = [4]Vec2{ in.nodes[q[0]], in.nodes[q[1]], in.nodes[q[2]], in.nodes[q[3]] };
        const sj = geom.quadScaledJacobian(pq);
        sjs[qi] = sj;
        if (!geom.quadConvex(pq)) {
            r.inverted += 1;
            if (r.inverted <= 5) {
                const c = pq[0].add(pq[1]).add(pq[2]).add(pq[3]).scale(0.25);
                try r.issue(gpa, "quad {d} is inverted or not strictly convex (scaled Jacobian {d:.3}) near ({d:.3}, {d:.3})", .{ qi, sj, c.x, c.y });
            }
        }
        const ang = geom.quadAngles(pq);
        for (ang) |a| {
            const d = a * 180.0 / std.math.pi;
            min_ang = @min(min_ang, d);
            max_ang = @max(max_ang, d);
        }
        var lmin: f64 = std.math.inf(f64);
        var lmax: f64 = 0;
        for (0..4) |k| {
            const l = pq[k].dist(pq[(k + 1) % 4]);
            lmin = @min(lmin, l);
            lmax = @max(lmax, l);
        }
        if (lmax > 0) min_ratio = @min(min_ratio, lmin / lmax);
        area += geom.polygonArea(&pq);
    }
    if (r.inverted > 5) try r.issue(gpa, "{d} quads are inverted or not strictly convex in total", .{r.inverted});
    r.min_angle_deg = if (in.quads.len > 0) min_ang else 0;
    r.max_angle_deg = max_ang;
    r.min_edge_ratio = min_ratio;
    r.mesh_area = area;
    if (in.quads.len > 0) {
        const sorted = try gpa.dupe(f64, sjs);
        defer gpa.free(sorted);
        std.mem.sort(f64, sorted, {}, std.sort.asc(f64));
        r.min_scaled_jacobian = sorted[0];
        const idx = @min(sorted.len - 1, @as(usize, @intFromFloat(@floor(0.05 * @as(f64, @floatFromInt(sorted.len))))));
        r.p5_scaled_jacobian = sorted[idx];
        var good: usize = 0;
        for (sorted) |s| {
            if (s >= 0.5) good += 1;
        }
        r.share_sj_05 = @as(f64, @floatFromInt(good)) / @as(f64, @floatFromInt(sorted.len));
    }

    // Conformity.
    var use = std.AutoHashMap(u64, u8).init(gpa);
    defer use.deinit();
    for (in.quads) |q| {
        if (bad_index) break;
        for (0..4) |k| {
            const gop = try use.getOrPut(ekey(q[k], q[(k + 1) % 4]));
            if (!gop.found_existing) gop.value_ptr.* = 0;
            gop.value_ptr.* +|= 1;
        }
    }
    var loop_edge = std.AutoHashMap(u64, bool).init(gpa); // value: control
    defer loop_edge.deinit();
    var domain_area: f64 = 0;
    for (in.loops) |l| {
        const m = l.nodes.len;
        const ne = if (l.open) m - 1 else m;
        for (0..ne) |k| try loop_edge.put(ekey(l.nodes[k], l.nodes[(k + 1) % m]), l.control);
        if (!l.control) {
            var pts = try gpa.alloc(Vec2, m);
            defer gpa.free(pts);
            for (l.nodes, 0..) |v, k| pts[k] = in.nodes[v];
            const a = @abs(geom.polygonArea(pts));
            domain_area += if (l.hole) -a else a;
        }
    }
    r.conforming = !bad_index;
    var once: usize = 0;
    var it = use.iterator();
    var over: usize = 0;
    var stray: usize = 0;
    while (it.next()) |e| {
        const cnt = e.value_ptr.*;
        if (cnt > 2) over += 1;
        const le = loop_edge.get(e.key_ptr.*);
        if (cnt == 1) {
            once += 1;
            if (le == null or le.? == true) stray += 1;
        }
    }
    var missing: usize = 0;
    var lit = loop_edge.iterator();
    while (lit.next()) |e| {
        const cnt = use.get(e.key_ptr.*) orelse 0;
        if (e.value_ptr.*) {
            if (cnt != 2) missing += 1;
        } else if (cnt != 1) missing += 1;
    }
    r.boundary_edge_count = once;
    if (over > 0) {
        r.conforming = false;
        try r.issue(gpa, "{d} edges are shared by more than two quads", .{over});
    }
    if (stray > 0) {
        r.conforming = false;
        try r.issue(gpa, "{d} edges are used by one quad but are not boundary edges (hanging nodes or holes in the mesh)", .{stray});
    }
    if (missing > 0) {
        r.conforming = false;
        try r.issue(gpa, "{d} boundary or control edges are not matched by the mesh", .{missing});
    }

    // Domain coverage: total quad area equals the domain area (holes subtracted).
    r.domain_area = domain_area;
    const tol = 1e-9 * @max(1.0, r.domain_area);
    r.covers_domain = @abs(r.mesh_area - r.domain_area) <= tol * 1000 and r.inverted == 0;
    if (!r.covers_domain) try r.issue(gpa, "quad area {d:.6} differs from the domain area {d:.6}", .{ r.mesh_area, r.domain_area });

    // Fixed boundary.
    r.fixed_kept = true;
    for (in.fixed_nodes) |f| {
        if (f.node >= nn or !in.nodes[f.node].eql(f.pos)) {
            r.fixed_kept = false;
            try r.issue(gpa, "fixed node at ({d}, {d}) was moved or dropped", .{ f.pos.x, f.pos.y });
            break;
        }
    }
    for (in.fixed_edges) |e| {
        if ((use.get(ekey(e[0], e[1])) orelse 0) == 0) {
            r.fixed_kept = false;
            try r.issue(gpa, "fixed boundary edge ({d}, {d}) is not a mesh edge", .{ e[0], e[1] });
            break;
        }
    }

    // Irregular interior nodes.
    const val = try gpa.alloc(u16, nn);
    defer gpa.free(val);
    @memset(val, 0);
    if (!bad_index) for (in.quads) |q| for (q) |v| {
        val[v] +|= 1;
    };
    const on_loop = try gpa.alloc(bool, nn);
    defer gpa.free(on_loop);
    @memset(on_loop, false);
    for (in.loops) |l| for (l.nodes) |v| {
        if (v < nn) on_loop[v] = true;
    };
    for (0..nn) |v| {
        if (on_loop[v] or val[v] == 0) continue;
        r.interior_nodes += 1;
        if (val[v] != 4) r.irregular_nodes += 1;
    }
    r.irregular_share = if (r.interior_nodes > 0) @as(f64, @floatFromInt(r.irregular_nodes)) / @as(f64, @floatFromInt(r.interior_nodes)) else 0;
    r.max_boundary_deviation = in.boundary_deviation;

    r.valid = r.all_quads and r.conforming and r.inverted == 0 and r.covers_domain and r.fixed_kept and in.quads.len > 0;
    return r;
}

test "validate a 2x1 grid" {
    const gpa = std.testing.allocator;
    const nodes = [_]Vec2{ .init(0, 0), .init(1, 0), .init(2, 0), .init(2, 1), .init(1, 1), .init(0, 1) };
    const quads = [_][4]u32{ .{ 0, 1, 4, 5 }, .{ 1, 2, 3, 4 } };
    const loop_nodes = [_]u32{ 0, 1, 2, 3, 4, 5 };
    const loops = [_]LoopEdges{.{ .nodes = &loop_nodes }};
    var r = try validate(gpa, .{ .nodes = &nodes, .quads = &quads, .loops = &loops });
    defer r.deinit(gpa);
    try std.testing.expect(r.valid);
    try std.testing.expectEqual(@as(usize, 0), r.interior_nodes);
    try std.testing.expectApproxEqAbs(@as(f64, 90), r.min_angle_deg, 1e-9);
    // Break conformity: drop a quad.
    var r2 = try validate(gpa, .{ .nodes = &nodes, .quads = quads[0..1], .loops = &loops });
    defer r2.deinit(gpa);
    try std.testing.expect(!r2.valid);
    try std.testing.expect(!r2.conforming);
}
