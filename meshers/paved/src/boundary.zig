//! Input model and boundary discretization.
//!
//! A domain is a list of closed loops (outer boundaries, holes and control
//! loops) given as polylines in face-plane coordinates. Parts of a loop may be
//! covered by fixed runs: ordered node lists that the mesh must use exactly.
//! The rest of each loop (free runs) is discretized here according to the
//! size field, the elements-per-circle setting and sharp corners. The total
//! number of edges on outer and hole loops is made even (free runs absorb the
//! parity), which an all-quad mesh requires.

const std = @import("std");
const geom = @import("geom.zig");
const sizefield = @import("sizefield.zig");
const Vec2 = geom.Vec2;
const Allocator = std.mem.Allocator;

pub const LoopRole = enum(u8) {
    outer = 0,
    hole = 1,
    /// Closed loop inside the domain: its edges are mesh edges with quads on both sides.
    control = 2,
    /// Open curve inside the domain (ABI 0.3): n >= 2 points, n - 1 segments, fully fixed.
    curve = 3,
};
pub const VertexKind = enum(u8) { automatic = 0, smooth = 1, corner = 2 };

/// A location on an input polyline: segment i runs from point i to point i+1 (cyclically).
pub const Position = struct {
    segment: u32 = 0,
    parameter: f64 = 0,
};

/// Nodes follow the loop's traversal direction. An open run includes both endpoints and spans
/// from `start` to `end` along the polyline; a closed run covers the whole loop (no repeated node).
pub const FixedRun = struct {
    start: Position = .{},
    end: Position = .{},
    nodes: []const Vec2,
    closed: bool = false,
};

pub const SizingSample = struct {
    arc_fraction: f64,
    size: f64,
};

pub const Loop = struct {
    role: LoopRole,
    points: []const Vec2,
    /// 0 uses the global target size.
    target_size: f64 = 0,
    sizing_samples: []const SizingSample = &.{},
    vertex_kinds: []const VertexKind = &.{},
    fixed_runs: []const FixedRun = &.{},
};

pub const Options = struct {
    /// Target element size; 0 selects (largest extent) / 24.
    target_size: f64 = 0,
    /// Elements on a full circle; arcs are refined to at least this density.
    elements_per_circle: u32 = 12,
    /// Maximum size ratio between neighboring elements away from curved features.
    growth_rate: f64 = 1.2,
    /// Polyline joints turning more than this are kept as sharp corners.
    feature_angle_deg: f64 = 30,
    /// Optional chord-deviation cap as a fraction of the local size (0 = off).
    chord_tolerance: f64 = 0,
    enable_smoothing: bool = true,
    smoothing_iterations: u32 = 30,
    enable_cleanup: bool = true,
    /// Remesh small patches around quads still poor after cleanup.
    remesh_patches: bool = true,
    remesh_below: f64 = 0.5,
    absolute_tolerance: f64 = 1e-9,
    relative_tolerance: f64 = 1e-12,
};

pub const Error = error{ InvalidInput, OddBoundary, Unsupported, OutOfMemory };

/// Fixed-size diagnostic message for errors.
pub const Diag = struct {
    buf: [512]u8 = undefined,
    len: usize = 0,

    pub fn set(self: *Diag, comptime fmt: []const u8, args: anytype) void {
        const s = std.fmt.bufPrint(&self.buf, fmt, args) catch {
            self.len = self.buf.len;
            return;
        };
        self.len = s.len;
    }
    pub fn message(self: *const Diag) []const u8 {
        return self.buf[0..self.len];
    }
};

/// One occurrence of a node on a loop with its provenance.
pub const LoopNode = struct {
    node: u32,
    segment: u32,
    parameter: f64,
    fixed_run: i32 = -1,
    fixed_node: i32 = -1,
    /// A node shared by the end of one fixed run and the start of the next.
    fixed_run2: i32 = -1,
    fixed_node2: i32 = -1,
};

pub const BLoop = struct {
    role: LoopRole,
    /// Cyclic node sequence in input traversal direction.
    items: []LoopNode,
    /// For edge k (items[k] -> items[k+1]): fixed run and edge index, or -1.
    edge_run: []i32,
    edge_index: []i32,
    /// +1 if the meshed domain lies to the left of the input traversal, -1 otherwise (0 for control loops
    /// and curves).
    domain_side: i8,
    /// Open curve: items[k] -> items[k + 1] for k < len - 1 only.
    open: bool = false,

    pub fn edgeCount(self: BLoop) usize {
        return if (self.open) self.items.len - 1 else self.items.len;
    }
    /// Mesh-edge constraint with quads on both sides (control loops and curves).
    pub fn interior(self: BLoop) bool {
        return self.role == .control or self.role == .curve;
    }
};

pub const Boundary = struct {
    points: std.ArrayList(Vec2) = .empty,
    /// True for nodes whose coordinates come from a fixed run.
    fixed: std.ArrayList(bool) = .empty,
    loops: std.ArrayList(BLoop) = .empty,
    target_size: f64 = 0,
    /// Interior size field built from the final boundary spacing.
    field: ?sizefield.SizeField = null,
    /// Number of boundary edges on outer and hole loops.
    edge_count: usize = 0,
    /// Distance below which two points are the same.
    tol: f64 = 0,

    pub fn deinit(self: *Boundary, gpa: Allocator) void {
        for (self.loops.items) |l| {
            gpa.free(l.items);
            gpa.free(l.edge_run);
            gpa.free(l.edge_index);
        }
        self.loops.deinit(gpa);
        self.points.deinit(gpa);
        self.fixed.deinit(gpa);
        if (self.field) |*f| f.deinit(gpa);
    }
};

// ---------------------------------------------------------------------------
// Polyline helpers

const Polyline = struct {
    pts: []const Vec2,
    /// Cumulative arc length at each vertex; arc[n] = total length.
    arc: []f64,
    total: f64,

    fn init(gpa: Allocator, pts: []const Vec2) !Polyline {
        const n = pts.len;
        const arc = try gpa.alloc(f64, n + 1);
        arc[0] = 0;
        for (0..n) |i| arc[i + 1] = arc[i] + pts[i].dist(pts[(i + 1) % n]);
        return .{ .pts = pts, .arc = arc, .total = arc[n] };
    }
    fn deinit(self: *Polyline, gpa: Allocator) void {
        gpa.free(self.arc);
    }
    fn segLen(self: *const Polyline, i: usize) f64 {
        return self.arc[i + 1] - self.arc[i];
    }
    fn wrap(self: *const Polyline, s: f64) f64 {
        var v = @mod(s, self.total);
        if (v < 0) v += self.total;
        return v;
    }
    /// Segment and parameter of arc length s (wrapped).
    fn locate(self: *const Polyline, s_in: f64) Position {
        const s = self.wrap(s_in);
        const n = self.pts.len;
        // Last vertex index with arc <= s.
        var lo: usize = 0;
        var hi: usize = n;
        while (hi - lo > 1) {
            const m = (lo + hi) / 2;
            if (self.arc[m] <= s) lo = m else hi = m;
        }
        // Skip zero-length segments.
        var seg = lo;
        var guard: usize = 0;
        while (self.segLen(seg) == 0 and guard < n) : (guard += 1) seg = (seg + 1) % n;
        const l = self.segLen(seg);
        var t: f64 = if (l > 0) (s - self.arc[seg]) / l else 0;
        t = std.math.clamp(t, 0.0, 1.0);
        return .{ .segment = @intCast(seg), .parameter = t };
    }
    fn point(self: *const Polyline, p: Position) Vec2 {
        const n = self.pts.len;
        const a = self.pts[p.segment];
        const b = self.pts[(p.segment + 1) % n];
        if (p.parameter == 0) return a;
        if (p.parameter == 1) return b;
        return a.lerp(b, p.parameter);
    }
    fn pointAt(self: *const Polyline, s: f64) Vec2 {
        return self.point(self.locate(s));
    }
    fn arcOf(self: *const Polyline, p: Position) f64 {
        return self.arc[p.segment] + p.parameter * self.segLen(p.segment);
    }
    /// Turning angle at vertex i (signed, left turn positive), skipping zero-length segments.
    fn turn(self: *const Polyline, i: usize) f64 {
        const n = self.pts.len;
        var a = (i + n - 1) % n;
        var guard: usize = 0;
        while (self.pts[a].eql(self.pts[i]) and guard < n) : (guard += 1) a = (a + n - 1) % n;
        var c = (i + 1) % n;
        guard = 0;
        while (self.pts[c].eql(self.pts[i]) and guard < n) : (guard += 1) c = (c + 1) % n;
        const u = self.pts[i].sub(self.pts[a]);
        const v = self.pts[c].sub(self.pts[i]);
        if (u.len2() == 0 or v.len2() == 0) return 0;
        return std.math.atan2(u.cross(v), u.dot(v));
    }
};

fn loopSizeAt(loop: *const Loop, global: f64, frac: f64) f64 {
    const base = if (loop.target_size > 0) loop.target_size else global;
    const ss = loop.sizing_samples;
    if (ss.len == 0) return base;
    if (ss.len == 1) return ss[0].size;
    // Cyclic piecewise-linear interpolation in arc fraction.
    var f = @mod(frac, 1.0);
    if (f < 0) f += 1;
    var i: usize = 0;
    while (i < ss.len and ss[i].arc_fraction <= f) i += 1;
    const a = if (i == 0) ss[ss.len - 1] else ss[i - 1];
    const b = if (i == ss.len) ss[0] else ss[i];
    const fa = a.arc_fraction;
    var fb = b.arc_fraction;
    var ff = f;
    if (fb <= fa) {
        fb += 1;
        if (ff < fa) ff += 1;
    }
    if (fb - fa <= 0) return a.size;
    const t = (ff - fa) / (fb - fa);
    return a.size + (b.size - a.size) * t;
}

/// Per-vertex intrinsic data used by sizing and discretization.
const VertexInfo = struct {
    turn: f64,
    corner: bool,
    /// Unsigned curvature of the smooth curve through the vertex (0 at corners).
    kappa: f64,
};

fn computeVertexInfo(gpa: Allocator, pl: *const Polyline, loop: *const Loop, feature_angle: f64) ![]VertexInfo {
    const n = pl.pts.len;
    const info = try gpa.alloc(VertexInfo, n);
    for (0..n) |i| {
        const t = pl.turn(i);
        const kind: VertexKind = if (loop.vertex_kinds.len == n) loop.vertex_kinds[i] else .automatic;
        const corner = switch (kind) {
            .corner => true,
            .smooth => false,
            .automatic => @abs(t) > feature_angle,
        };
        const lprev = pl.segLen((i + n - 1) % n);
        const lnext = pl.segLen(i);
        const l = 0.5 * (lprev + lnext);
        info[i] = .{ .turn = t, .corner = corner, .kappa = if (!corner and l > 0) @abs(t) / l else 0 };
    }
    // Light smoothing of curvature along smooth stretches (removes sampling noise).
    const k2 = try gpa.alloc(f64, n);
    defer gpa.free(k2);
    for (0..n) |i| {
        if (info[i].corner) {
            k2[i] = 0;
            continue;
        }
        const a = info[(i + n - 1) % n];
        const b = info[(i + 1) % n];
        var s = 2.0 * info[i].kappa;
        var w: f64 = 2.0;
        if (!a.corner) {
            s += a.kappa;
            w += 1;
        }
        if (!b.corner) {
            s += b.kappa;
            w += 1;
        }
        k2[i] = s / w;
    }
    for (0..n) |i| info[i].kappa = k2[i];
    return info;
}

const Interval = struct {
    a: f64, // arc start
    b: f64, // arc end (b >= a, may exceed total for wrap)
    start_node: u32,
    end_node: u32,
};

/// Builds the boundary: discretizes free runs, copies fixed runs, enforces parity and
/// builds the interior size field.
pub fn build(gpa: Allocator, loops: []const Loop, opts: Options, diag: *Diag) Error!Boundary {
    var bd = Boundary{};
    errdefer bd.deinit(gpa);
    if (loops.len == 0) {
        diag.set("no loops given", .{});
        return error.InvalidInput;
    }
    if (!(opts.growth_rate >= 1.0) or !(opts.growth_rate <= 4.0)) {
        diag.set("growth rate must be in [1, 4]", .{});
        return error.InvalidInput;
    }
    if (opts.elements_per_circle < 3) {
        diag.set("elements per circle must be at least 3", .{});
        return error.InvalidInput;
    }
    // Extent, validation.
    var lo = Vec2.init(std.math.inf(f64), std.math.inf(f64));
    var hi = Vec2.init(-std.math.inf(f64), -std.math.inf(f64));
    var has_outer = false;
    for (loops, 0..) |l, li| {
        if (l.role == .outer) has_outer = true;
        if (l.role == .curve) {
            if (l.points.len < 2) {
                diag.set("curve {d} has fewer than 2 points", .{li});
                return error.InvalidInput;
            }
            const n = l.points.len;
            const ok = l.fixed_runs.len == 1 and !l.fixed_runs[0].closed and l.fixed_runs[0].start.segment == 0 and
                l.fixed_runs[0].start.parameter == 0 and l.fixed_runs[0].end.segment == n - 2 and l.fixed_runs[0].end.parameter == 1;
            if (!ok) {
                diag.set("curve {d} needs one open fixed run over all its points (start (0, 0), end ({d}, 1)); free curves are not supported", .{ li, n - 2 });
                return error.Unsupported;
            }
        } else if (l.points.len < 3) {
            diag.set("loop {d} has fewer than 3 points", .{li});
            return error.InvalidInput;
        }
        for (l.points) |p| {
            if (!std.math.isFinite(p.x) or !std.math.isFinite(p.y)) {
                diag.set("loop {d} has a non-finite point", .{li});
                return error.InvalidInput;
            }
            lo.x = @min(lo.x, p.x);
            lo.y = @min(lo.y, p.y);
            hi.x = @max(hi.x, p.x);
            hi.y = @max(hi.y, p.y);
        }
        for (l.fixed_runs, 0..) |r, ri| {
            if (r.nodes.len < @as(usize, if (r.closed) 3 else 2)) {
                diag.set("fixed run {d} of loop {d} has too few nodes", .{ ri, li });
                return error.InvalidInput;
            }
            for (r.nodes) |p| if (!std.math.isFinite(p.x) or !std.math.isFinite(p.y)) {
                diag.set("fixed run {d} of loop {d} has a non-finite node", .{ ri, li });
                return error.InvalidInput;
            };
            if (r.closed and l.fixed_runs.len != 1) {
                diag.set("loop {d}: a closed fixed run must be the only run on its loop", .{li});
                return error.InvalidInput;
            }
            if (!r.closed) {
                if (r.start.segment >= l.points.len or r.end.segment >= l.points.len or
                    !(r.start.parameter >= 0 and r.start.parameter <= 1) or !(r.end.parameter >= 0 and r.end.parameter <= 1))
                {
                    diag.set("fixed run {d} of loop {d} has an invalid start or end position", .{ ri, li });
                    return error.InvalidInput;
                }
            }
        }
        for (l.sizing_samples) |s| {
            if (!(s.size > 0) or !(s.arc_fraction >= 0 and s.arc_fraction <= 1)) {
                diag.set("loop {d} has an invalid sizing sample", .{li});
                return error.InvalidInput;
            }
        }
        if (l.target_size < 0 or !std.math.isFinite(l.target_size)) {
            diag.set("loop {d} has an invalid target size", .{li});
            return error.InvalidInput;
        }
    }
    if (!has_outer) {
        diag.set("no outer loop given", .{});
        return error.InvalidInput;
    }
    const extent = @max(hi.x - lo.x, hi.y - lo.y);
    if (!(extent > 0)) {
        diag.set("degenerate geometry (zero extent)", .{});
        return error.InvalidInput;
    }
    const H = if (opts.target_size > 0) opts.target_size else extent / 24.0;
    if (!std.math.isFinite(H) or H <= 0) {
        diag.set("invalid target size", .{});
        return error.InvalidInput;
    }
    bd.target_size = H;
    const tol = opts.absolute_tolerance + opts.relative_tolerance * extent;
    bd.tol = tol;
    const feature = opts.feature_angle_deg * std.math.pi / 180.0;
    const n_circle: f64 = @floatFromInt(opts.elements_per_circle);
    const g1 = opts.growth_rate - 1.0;
    var max_loop_size = H;
    for (loops) |l| {
        max_loop_size = @max(max_loop_size, l.target_size);
        for (l.sizing_samples) |s| max_loop_size = @max(max_loop_size, s.size);
    }

    // Polylines and vertex info.
    const pls = try gpa.alloc(Polyline, loops.len);
    defer gpa.free(pls);
    var npl: usize = 0;
    defer for (pls[0..npl]) |*p| p.deinit(gpa);
    const infos = try gpa.alloc([]VertexInfo, loops.len);
    defer gpa.free(infos);
    var ninfo: usize = 0;
    defer for (infos[0..ninfo]) |x| gpa.free(x);
    const sides = try gpa.alloc(i8, loops.len);
    defer gpa.free(sides);
    for (loops, 0..) |*l, li| {
        pls[li] = try Polyline.init(gpa, l.points);
        npl += 1;
        if (!(pls[li].total > 10 * tol)) {
            diag.set("loop {d} has zero length", .{li});
            return error.InvalidInput;
        }
        infos[li] = try computeVertexInfo(gpa, &pls[li], l, feature);
        ninfo += 1;
        const area = geom.polygonArea(l.points);
        sides[li] = switch (l.role) {
            .outer => if (area > 0) 1 else -1,
            .hole => if (area < 0) 1 else -1,
            .control, .curve => 0,
        };
    }

    // ---- Sizing sources for boundary discretization (intrinsic sizes along all loops).
    var sources: std.ArrayList(sizefield.Source) = .empty;
    defer sources.deinit(gpa);
    for (loops, 0..) |*l, li| {
        const pl = &pls[li];
        const info = infos[li];
        const n = l.points.len;
        // Fixed nodes are sources with their own spacing.
        for (l.fixed_runs) |r| {
            const m = r.nodes.len;
            for (0..m) |k| {
                var sum: f64 = 0;
                var cnt: f64 = 0;
                if (k > 0 or r.closed) {
                    sum += r.nodes[k].dist(r.nodes[(k + m - 1) % m]);
                    cnt += 1;
                }
                if (k + 1 < m or r.closed) {
                    sum += r.nodes[k].dist(r.nodes[(k + 1) % m]);
                    cnt += 1;
                }
                const h = sum / cnt;
                if (h > 0) try sources.append(gpa, .{ .p = r.nodes[k], .h = h, .k = g1 });
            }
        }
        // Polyline samples (curves are fully fixed: their nodes are the sources).
        if (l.role == .curve) continue;
        for (0..n) |i| {
            const seg_len = pl.segLen(i);
            const frac0 = pl.arc[i] / pl.total;
            const ka = info[i].kappa;
            const kb = info[(i + 1) % n].kappa;
            // Subdivide long segments so samples are at most half the local size apart.
            const h0 = loopSizeAt(l, H, frac0);
            const steps: usize = @intFromFloat(@min(4096.0, @ceil(seg_len / (0.5 * @max(h0 * 0.25, 1e-12)))));
            const ns = @max(steps, 1);
            for (0..ns) |j| {
                const t = @as(f64, @floatFromInt(j)) / @as(f64, @floatFromInt(ns));
                const s = pl.arc[i] + t * seg_len;
                const p = pl.pointAt(s);
                var h = loopSizeAt(l, H, s / pl.total);
                const kappa = ka + (kb - ka) * t;
                var slope = g1;
                if (kappa > 0) {
                    const cap = 2.0 * std.math.pi / (n_circle * kappa);
                    if (opts.chord_tolerance > 0) h = @min(h, 8.0 * opts.chord_tolerance / kappa);
                    h = @min(h, cap);
                    // Domain on the outer side of the bend: rows grow naturally (2 pi / N per row).
                    const tsign = if (j == 0) info[i].turn else info[i].turn + (info[(i + 1) % n].turn - info[i].turn) * t;
                    if (sides[li] != 0 and @as(f64, @floatFromInt(sides[li])) * tsign < 0) slope = @max(g1, h * kappa);
                }
                if (!inFixedRun(l, pl, s, tol)) try sources.append(gpa, .{ .p = p, .h = h, .k = slope });
            }
        }
    }
    var bfield = try sizefield.SizeField.init(gpa, sources.items, max_loop_size);
    defer bfield.deinit(gpa);

    // ---- Discretize each loop.
    // Parity bookkeeping: candidate free pieces with their ideal (real) segment counts.
    const Piece = struct { loop: usize, ideal: f64, n: usize };
    var pieces: std.ArrayList(Piece) = .empty;
    defer pieces.deinit(gpa);

    // Curve ends: free loop runs put a node exactly there.
    var curve_ends: std.ArrayList(Vec2) = .empty;
    defer curve_ends.deinit(gpa);
    for (loops) |l| {
        if (l.role != .curve) continue;
        const ns = l.fixed_runs[0].nodes;
        try curve_ends.append(gpa, ns[0]);
        try curve_ends.append(gpa, ns[ns.len - 1]);
    }

    // Pass 1 computes piece counts; parity adjustment; pass 2 places nodes.
    var plans: std.ArrayList(LoopPlan) = .empty;
    defer {
        for (plans.items) |*p| p.deinit(gpa);
        plans.deinit(gpa);
    }
    for (loops, 0..) |*l, li| {
        if (l.role == .curve) {
            try plans.append(gpa, .{ .fixed_edges = l.fixed_runs[0].nodes.len - 1 });
            continue;
        }
        const plan = try planLoop(gpa, l, &pls[li], infos[li], &bfield, H, tol, diag, li, curve_ends.items);
        try plans.append(gpa, plan);
    }
    var total_edges: usize = 0;
    for (plans.items, 0..) |p, li| {
        // Control loops and curves add their edges to the front on both sides: no parity change.
        if (loops[li].role == .control or loops[li].role == .curve) continue;
        total_edges += p.fixedEdgeCount();
        for (p.pieces.items) |pc| total_edges += pc.n;
    }
    if (total_edges % 2 == 1) {
        // Find the free piece whose count changes least in relative terms.
        var best_li: ?usize = null;
        var best_pi: usize = 0;
        var best_delta: i32 = 0;
        var best_cost: f64 = std.math.inf(f64);
        for (plans.items, 0..) |p, li| {
            if (loops[li].role == .control or loops[li].role == .curve) continue;
            for (p.pieces.items, 0..) |pc, pi| {
                const nf: f64 = @floatFromInt(pc.n);
                const up = @abs(nf + 1 - pc.ideal) / @max(pc.ideal, 1e-12);
                if (up < best_cost) {
                    best_cost = up;
                    best_li = li;
                    best_pi = pi;
                    best_delta = 1;
                }
                if (pc.n >= 2) {
                    const down = @abs(nf - 1 - pc.ideal) / @max(pc.ideal, 1e-12);
                    if (down < best_cost) {
                        best_cost = down;
                        best_li = li;
                        best_pi = pi;
                        best_delta = -1;
                    }
                }
            }
        }
        if (best_li) |li| {
            const pc = &plans.items[li].pieces.items[best_pi];
            pc.n = @intCast(@as(i64, @intCast(pc.n)) + best_delta);
            total_edges = @intCast(@as(i64, @intCast(total_edges)) + best_delta);
        } else {
            diag.set("odd number of fixed boundary edges ({d}) on outer and hole loops and no free run to absorb the parity: an all-quad mesh is impossible", .{total_edges});
            return error.OddBoundary;
        }
    }
    bd.edge_count = total_edges;

    // Pass 2: emit nodes.
    for (loops, 0..) |*l, li| {
        const bl = if (l.role == .curve) try emitCurve(gpa, &bd, l) else try emitLoop(gpa, &bd, l, &pls[li], &plans.items[li], &bfield, sides[li]);
        try bd.loops.append(gpa, bl);
    }
    // Curve ends (and nodes) on other loops' or curves' nodes become one mesh node, then the
    // curve geometry rules are checked.
    try mergeCurveNodes(gpa, &bd, tol);
    try checkCurves(gpa, &bd, loops, tol, diag);

    // Interior size field from final boundary spacing.
    var isrc: std.ArrayList(sizefield.Source) = .empty;
    defer isrc.deinit(gpa);
    for (bd.loops.items) |bl| {
        const m = bl.items.len;
        for (0..m) |k| {
            // Open curves: an end has one neighbor.
            const ka = if (bl.open and k == 0) 1 else (k + m - 1) % m;
            const kb = if (bl.open and k == m - 1) m - 2 else (k + 1) % m;
            const a = bd.points.items[bl.items[ka].node];
            const p = bd.points.items[bl.items[k].node];
            const b = bd.points.items[bl.items[kb].node];
            const la = a.dist(p);
            const lb = p.dist(b);
            const h = if (bl.open and (k == 0 or k == m - 1)) la else 0.5 * (la + lb);
            var slope = g1;
            const u = p.sub(a);
            const v = b.sub(p);
            if (bl.domain_side != 0 and la > 0 and lb > 0) {
                const t = std.math.atan2(u.cross(v), u.dot(v));
                const dom_turn = @as(f64, @floatFromInt(bl.domain_side)) * t;
                // Domain outside a smooth bend (a sampled arc of a hole): rows grow by about the
                // turning angle per row, h * kappa = |t|.
                if (dom_turn < 0 and @abs(t) <= 1.25 * 2.0 * std.math.pi / n_circle) {
                    slope = @max(g1, @abs(t));
                }
            }
            if (h > 0) try isrc.append(gpa, .{ .p = p, .h = @min(h, H), .k = slope });
        }
    }
    bd.field = try sizefield.SizeField.init(gpa, isrc.items, H);
    return bd;
}

fn inFixedRun(l: *const Loop, pl: *const Polyline, s: f64, tol: f64) bool {
    for (l.fixed_runs) |r| {
        if (r.closed) return true;
        const a = pl.arcOf(r.start);
        var b = pl.arcOf(r.end);
        if (b <= a + tol) b += pl.total;
        var x = s;
        if (x < a) x += pl.total;
        if (x >= a - tol and x <= b + tol) return true;
    }
    return false;
}

const PlanPiece = struct {
    a: f64,
    b: f64,
    ideal: f64,
    n: usize,
    /// The piece starts at a curve end: its first node takes these exact coordinates.
    exact_start: ?Vec2 = null,
};

const RunSpan = struct {
    run: usize,
    a: f64,
    b: f64,
};

const LoopPlan = struct {
    /// Fixed runs sorted by start arc length.
    runs: std.ArrayList(RunSpan) = .empty,
    /// Free pieces in traversal order, interleaved with runs: free run k follows run k.
    pieces: std.ArrayList(PlanPiece) = .empty,
    /// For each free run (between runs k and k+1), index range into pieces.
    free_ranges: std.ArrayList([2]usize) = .empty,
    closed_run: bool = false,
    fixed_edges: usize = 0,

    fn deinit(self: *LoopPlan, gpa: Allocator) void {
        self.runs.deinit(gpa);
        self.pieces.deinit(gpa);
        self.free_ranges.deinit(gpa);
    }
    fn fixedEdgeCount(self: *const LoopPlan) usize {
        return self.fixed_edges;
    }
};

fn planLoop(gpa: Allocator, l: *const Loop, pl: *const Polyline, info: []const VertexInfo, field: *const sizefield.SizeField, H: f64, tol: f64, diag: *Diag, li: usize, forced: []const Vec2) Error!LoopPlan {
    var plan = LoopPlan{};
    errdefer plan.deinit(gpa);
    const n = l.points.len;
    if (l.fixed_runs.len == 1 and l.fixed_runs[0].closed) {
        plan.closed_run = true;
        plan.fixed_edges = l.fixed_runs[0].nodes.len;
        try plan.runs.append(gpa, .{ .run = 0, .a = 0, .b = pl.total });
        return plan;
    }
    for (l.fixed_runs, 0..) |r, ri| {
        const a = pl.arcOf(r.start);
        var b = pl.arcOf(r.end);
        if (b <= a + tol) b += pl.total;
        try plan.runs.append(gpa, .{ .run = ri, .a = a, .b = b });
        plan.fixed_edges += r.nodes.len - 1;
    }
    std.mem.sort(RunSpan, plan.runs.items, {}, struct {
        fn lt(_: void, x: RunSpan, y: RunSpan) bool {
            return x.a < y.a or (x.a == y.a and x.run < y.run);
        }
    }.lt);
    // Overlap check.
    const nr = plan.runs.items.len;
    for (0..nr) |k| {
        const cur = plan.runs.items[k];
        const nxt = plan.runs.items[(k + 1) % nr];
        var na = nxt.a;
        if (k + 1 == nr) na += pl.total;
        if (nr > 1 and cur.b > na + tol) {
            diag.set("loop {d}: fixed runs {d} and {d} overlap", .{ li, cur.run, nxt.run });
            return error.InvalidInput;
        }
        if (nr == 1 and cur.b - cur.a > pl.total + tol) {
            diag.set("loop {d}: fixed run {d} covers more than the loop", .{ li, cur.run });
            return error.InvalidInput;
        }
    }
    // Free intervals.
    var intervals: std.ArrayList([2]f64) = .empty;
    defer intervals.deinit(gpa);
    if (nr == 0) {
        // Whole loop; start at the sharpest corner if any, else at point 0.
        var start: f64 = 0;
        var best: f64 = 0;
        for (0..n) |i| if (info[i].corner and @abs(info[i].turn) > best) {
            best = @abs(info[i].turn);
            start = pl.arc[i];
        };
        try intervals.append(gpa, .{ start, start + pl.total });
    } else {
        for (0..nr) |k| {
            const cur = plan.runs.items[k];
            var na = plan.runs.items[(k + 1) % nr].a;
            if (k + 1 == nr) na += pl.total;
            var ca = cur.b;
            if (na < ca) na = ca;
            if (ca > na) ca = na;
            try intervals.append(gpa, .{ ca, na });
        }
    }
    // Pieces between corners in each free interval.
    var breaks: std.ArrayList(Break) = .empty;
    defer breaks.deinit(gpa);
    for (intervals.items) |iv| {
        const first = plan.pieces.items.len;
        if (iv[1] - iv[0] <= tol) {
            try plan.free_ranges.append(gpa, .{ first, first });
            continue;
        }
        breaks.clearRetainingCapacity();
        try breaks.append(gpa, .{ .s = iv[0], .turn = std.math.inf(f64), .removable = false });
        // Corner vertices strictly inside (with wrap).
        for (0..2) |wrapk| {
            for (0..n) |i| {
                if (!info[i].corner) continue;
                const s = pl.arc[i] + @as(f64, @floatFromInt(wrapk)) * pl.total;
                if (s > iv[0] + tol and s < iv[1] - tol) {
                    const kind: VertexKind = if (l.vertex_kinds.len == n) l.vertex_kinds[i] else .automatic;
                    try breaks.append(gpa, .{ .s = s, .turn = @abs(info[i].turn), .removable = kind != .corner });
                }
            }
        }
        // Curve ends on this free run become nodes at their exact coordinates.
        for (forced) |fp| {
            for (0..n) |i| {
                const a = pl.pts[i];
                const b = pl.pts[(i + 1) % n];
                const t = geom.segmentParam(fp, a, b);
                if (fp.dist(a.lerp(b, t)) > tol) continue;
                const s0 = pl.arc[i] + t * pl.segLen(i);
                for (0..2) |wrapk| {
                    const s = s0 + @as(f64, @floatFromInt(wrapk)) * pl.total;
                    if (s > iv[0] + tol and s < iv[1] - tol)
                        try breaks.append(gpa, .{ .s = s, .turn = std.math.inf(f64), .removable = false, .exact = fp });
                }
                break;
            }
        }
        try breaks.append(gpa, .{ .s = iv[1], .turn = std.math.inf(f64), .removable = false });
        std.mem.sort(Break, breaks.items, {}, Break.lt);
        // Merge corners closer than a fraction of the local size (defeaturing remnants).
        var changed = true;
        while (changed) {
            changed = false;
            var k: usize = 0;
            while (k + 1 < breaks.items.len) : (k += 1) {
                const x = breaks.items[k];
                const y = breaks.items[k + 1];
                const h = field.eval(pl.pointAt(0.5 * (x.s + y.s)));
                if (y.s - x.s < 0.3 * h) {
                    // Remove the less sharp removable one.
                    var rm: ?usize = null;
                    if (x.removable and y.removable) {
                        rm = if (x.turn < y.turn) k else k + 1;
                    } else if (x.removable) {
                        rm = k;
                    } else if (y.removable) {
                        rm = k + 1;
                    }
                    if (rm) |r| {
                        _ = breaks.orderedRemove(r);
                        changed = true;
                        break;
                    }
                }
            }
        }
        for (0..breaks.items.len - 1) |k| {
            const a = breaks.items[k].s;
            const b = breaks.items[k + 1].s;
            const ideal = integrateInvSize(pl, field, l, H, a, b);
            const nn: usize = @max(1, @as(usize, @intFromFloat(@round(ideal))));
            try plan.pieces.append(gpa, .{ .a = a, .b = b, .ideal = ideal, .n = nn, .exact_start = breaks.items[k].exact });
        }
        try plan.free_ranges.append(gpa, .{ first, plan.pieces.items.len });
    }
    return plan;
}

const Break = struct {
    s: f64,
    turn: f64,
    removable: bool,
    exact: ?Vec2 = null,
    fn lt(_: void, x: Break, y: Break) bool {
        return x.s < y.s;
    }
};

fn sizeAlong(pl: *const Polyline, field: *const sizefield.SizeField, l: *const Loop, H: f64, s: f64) f64 {
    const p = pl.pointAt(s);
    const h = @min(field.eval(p), loopSizeAt(l, H, pl.wrap(s) / pl.total));
    return @max(h, 1e-12);
}

fn integrateInvSize(pl: *const Polyline, field: *const sizefield.SizeField, l: *const Loop, H: f64, a: f64, b: f64) f64 {
    var s = a;
    var h_prev = sizeAlong(pl, field, l, H, s);
    var total: f64 = 0;
    var guard: usize = 0;
    while (s < b and guard < 1_000_000) : (guard += 1) {
        const step = @min(0.2 * h_prev, b - s);
        const s1 = s + step;
        const h1 = sizeAlong(pl, field, l, H, s1);
        total += step * 0.5 * (1.0 / h_prev + 1.0 / h1);
        s = s1;
        h_prev = h1;
    }
    return total;
}

/// Arc positions of n+1 nodes (including both ends) equidistributed in 1/h on [a, b].
fn distribute(gpa: Allocator, pl: *const Polyline, field: *const sizefield.SizeField, l: *const Loop, H: f64, a: f64, b: f64, n: usize) ![]f64 {
    // Tabulate the cumulative integral.
    var ss: std.ArrayList(f64) = .empty;
    defer ss.deinit(gpa);
    var ii: std.ArrayList(f64) = .empty;
    defer ii.deinit(gpa);
    var s = a;
    var h_prev = sizeAlong(pl, field, l, H, s);
    var acc: f64 = 0;
    try ss.append(gpa, s);
    try ii.append(gpa, 0);
    var guard: usize = 0;
    while (s < b and guard < 1_000_000) : (guard += 1) {
        const step = @min(0.1 * h_prev, b - s);
        const s1 = s + step;
        const h1 = sizeAlong(pl, field, l, H, s1);
        acc += step * 0.5 * (1.0 / h_prev + 1.0 / h1);
        s = s1;
        h_prev = h1;
        try ss.append(gpa, s);
        try ii.append(gpa, acc);
    }
    const out = try gpa.alloc(f64, n + 1);
    out[0] = a;
    out[n] = b;
    var j: usize = 0;
    for (1..n) |k| {
        const target = acc * @as(f64, @floatFromInt(k)) / @as(f64, @floatFromInt(n));
        while (j + 1 < ii.items.len and ii.items[j + 1] < target) j += 1;
        const c0 = ii.items[j];
        const c1 = ii.items[@min(j + 1, ii.items.len - 1)];
        const t = if (c1 > c0) (target - c0) / (c1 - c0) else 0;
        out[k] = ss.items[j] + t * (ss.items[@min(j + 1, ss.items.len - 1)] - ss.items[j]);
    }
    return out;
}

/// Monotone projection of fixed nodes onto the polyline span [a, b] for provenance.
fn projectRun(pl: *const Polyline, nodes: []const Vec2, a: f64, b: f64, out: []Position) void {
    const n = pl.pts.len;
    var cur = a;
    for (nodes, 0..) |p, k| {
        // Search segments from the current arc position to b.
        var best_s = cur;
        var best_d = std.math.inf(f64);
        var pos = pl.locate(cur);
        var seg_arc_base = cur - pos.parameter * pl.segLen(pos.segment);
        var visited: usize = 0;
        while (visited <= n) : (visited += 1) {
            const seg = pos.segment;
            const sa = pl.pts[seg];
            const sb = pl.pts[(seg + 1) % n];
            const sl = pl.segLen(seg);
            var t = geom.segmentParam(p, sa, sb);
            var s_here = seg_arc_base + t * sl;
            if (s_here < cur) {
                s_here = cur;
                t = if (sl > 0) (cur - seg_arc_base) / sl else 0;
            }
            if (s_here > b) break;
            const d = p.dist(sa.lerp(sb, t));
            if (d < best_d) {
                best_d = d;
                best_s = s_here;
            }
            seg_arc_base += sl;
            if (seg_arc_base > b) break;
            pos = .{ .segment = @intCast((seg + 1) % n), .parameter = 0 };
        }
        if (k == 0) best_s = a;
        if (k == nodes.len - 1 and b - a < pl.total) best_s = b;
        cur = best_s;
        out[k] = pl.locate(best_s);
    }
}

/// Emits an open curve: its fixed run's nodes, with positions projected monotonically onto
/// the curve's polyline for provenance.
fn emitCurve(gpa: Allocator, bd: *Boundary, l: *const Loop) !BLoop {
    const r = l.fixed_runs[0];
    const m = r.nodes.len;
    const nseg = l.points.len - 1;
    const items = try gpa.alloc(LoopNode, m);
    errdefer gpa.free(items);
    const eruns = try gpa.alloc(i32, m);
    errdefer gpa.free(eruns);
    const eidx = try gpa.alloc(i32, m);
    errdefer gpa.free(eidx);
    var seg: usize = 0;
    var t_cur: f64 = 0;
    for (r.nodes, 0..) |q, k| {
        var best_s = seg;
        var best_t = t_cur;
        var best_d = std.math.inf(f64);
        var s2 = seg;
        while (s2 < nseg) : (s2 += 1) {
            const a = l.points[s2];
            const b = l.points[s2 + 1];
            var t = geom.segmentParam(q, a, b);
            if (s2 == seg and t < t_cur) t = t_cur;
            const d = q.dist(a.lerp(b, t));
            if (d < best_d) {
                best_d = d;
                best_s = s2;
                best_t = t;
            }
        }
        if (k == 0) {
            best_s = 0;
            best_t = 0;
        } else if (k == m - 1) {
            best_s = nseg - 1;
            best_t = 1;
        } else if (best_t >= 1 and best_s + 1 < nseg) {
            best_s += 1;
            best_t = 0;
        }
        seg = best_s;
        t_cur = best_t;
        const id: u32 = @intCast(bd.points.items.len);
        try bd.points.append(gpa, q);
        try bd.fixed.append(gpa, true);
        items[k] = .{ .node = id, .segment = @intCast(best_s), .parameter = best_t, .fixed_run = 0, .fixed_node = @intCast(k) };
        eruns[k] = if (k + 1 < m) 0 else -1;
        eidx[k] = if (k + 1 < m) @intCast(k) else -1;
    }
    return .{ .role = .curve, .items = items, .edge_run = eruns, .edge_index = eidx, .domain_side = 0, .open = true };
}

/// Makes a curve node and a node of another loop or curve that coincide within the tolerance
/// one node (the earlier one, whose coordinates are kept). Nodes of two closed loops are never
/// merged (touching loops are an input error reported by the triangulation).
fn mergeCurveNodes(gpa: Allocator, bd: *Boundary, tol: f64) !void {
    const n = bd.points.items.len;
    var any_curve = false;
    for (bd.loops.items) |bl| {
        if (bl.role == .curve) any_curve = true;
    }
    if (!any_curve or n == 0) return;
    const owner = try gpa.alloc(u32, n);
    defer gpa.free(owner);
    const is_curve = try gpa.alloc(bool, n);
    defer gpa.free(is_curve);
    for (bd.loops.items, 0..) |bl, li| for (bl.items) |it| {
        owner[it.node] = @intCast(li);
        is_curve[it.node] = bl.role == .curve;
    };
    const rep = try gpa.alloc(u32, n);
    defer gpa.free(rep);
    const nxt = try gpa.alloc(u32, n);
    defer gpa.free(nxt);
    var heads = std.AutoHashMap([2]i64, u32).init(gpa);
    defer heads.deinit();
    const cell = @max(4.0 * tol, 1e-300);
    for (0..n) |vi| {
        const v: u32 = @intCast(vi);
        rep[v] = v;
        const p = bd.points.items[v];
        const cx: i64 = @intFromFloat(@floor(p.x / cell));
        const cy: i64 = @intFromFloat(@floor(p.y / cell));
        var found: u32 = std.math.maxInt(u32);
        var dx: i64 = -1;
        while (dx <= 1) : (dx += 1) {
            var dy: i64 = -1;
            while (dy <= 1) : (dy += 1) {
                var w = heads.get(.{ cx + dx, cy + dy }) orelse continue;
                while (true) {
                    if (owner[w] != owner[v] and (is_curve[v] or is_curve[w]) and bd.points.items[w].dist(p) <= tol)
                        found = @min(found, rep[w]);
                    if (nxt[w] == std.math.maxInt(u32)) break;
                    w = nxt[w];
                }
            }
        }
        if (found != std.math.maxInt(u32)) rep[v] = found;
        const gop = try heads.getOrPut(.{ cx, cy });
        nxt[v] = if (gop.found_existing) gop.value_ptr.* else std.math.maxInt(u32);
        gop.value_ptr.* = v;
    }
    // Compact: representatives keep their order.
    const newid = try gpa.alloc(u32, n);
    defer gpa.free(newid);
    var count: u32 = 0;
    for (0..n) |v| {
        if (rep[v] == v) {
            newid[v] = count;
            bd.points.items[count] = bd.points.items[v];
            bd.fixed.items[count] = bd.fixed.items[v];
            count += 1;
        }
    }
    if (count == n) return;
    for (0..n) |v| newid[v] = newid[rep[v]];
    bd.points.shrinkRetainingCapacity(count);
    bd.fixed.shrinkRetainingCapacity(count);
    for (bd.loops.items) |bl| for (bl.items) |*it| {
        it.node = newid[it.node];
    };
}

fn roleName(r: LoopRole) []const u8 {
    return switch (r) {
        .outer => "outer loop",
        .hole => "hole",
        .control => "control loop",
        .curve => "curve",
    };
}

fn onSegment(p: Vec2, a: Vec2, b: Vec2) bool {
    if (geom.orient(a, b, p) != 0) return false;
    return @min(a.x, b.x) <= p.x and p.x <= @max(a.x, b.x) and @min(a.y, b.y) <= p.y and p.y <= @max(a.y, b.y);
}

fn insidePolygon(p: Vec2, pts: []const Vec2, nodes: []const LoopNode) bool {
    var inside = false;
    const m = nodes.len;
    for (0..m) |k| {
        const a = pts[nodes[k].node];
        const b = pts[nodes[(k + 1) % m].node];
        if ((a.y > p.y) != (b.y > p.y)) {
            const x = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y);
            if (p.x < x) inside = !inside;
        }
    }
    return inside;
}

/// Curve rules: no crossings (of loops, other curves or itself) except at shared nodes, ends
/// either free or on another loop's or curve's node, interior nodes off outer and hole loops,
/// and every node inside the meshed region.
fn checkCurves(gpa: Allocator, bd: *const Boundary, loops: []const Loop, tol: f64, diag: *Diag) Error!void {
    _ = loops;
    _ = tol;
    const pts = bd.points.items;
    const n = pts.len;
    var on_wall = std.ArrayList(i32).empty; // outer or hole loop of each node, or -1
    defer on_wall.deinit(gpa);
    try on_wall.appendNTimes(gpa, -1, n);
    for (bd.loops.items, 0..) |bl, li| {
        if (bl.role != .outer and bl.role != .hole) continue;
        for (bl.items) |it| on_wall.items[it.node] = @intCast(li);
    }
    for (bd.loops.items, 0..) |cl, ci| {
        if (cl.role != .curve) continue;
        const cm = cl.items.len;
        for (0..cm - 1) |k| {
            const a = cl.items[k].node;
            const b = cl.items[k + 1].node;
            if (a == b) {
                diag.set("curve {d}: segment {d} has zero length (its nodes coincide)", .{ ci, k });
                return error.Unsupported;
            }
            const pa = pts[a];
            const pb = pts[b];
            const lo = Vec2.init(@min(pa.x, pb.x), @min(pa.y, pb.y));
            const hi = Vec2.init(@max(pa.x, pb.x), @max(pa.y, pb.y));
            for (bd.loops.items, 0..) |ol, lj| {
                const om = ol.items.len;
                for (0..ol.edgeCount()) |e| {
                    if (lj == ci and e == k) continue;
                    const c = ol.items[e].node;
                    const d = ol.items[(e + 1) % om].node;
                    const pc = pts[c];
                    const pd = pts[d];
                    if (@max(pc.x, pd.x) < lo.x or @min(pc.x, pd.x) > hi.x or @max(pc.y, pd.y) < lo.y or @min(pc.y, pd.y) > hi.y) continue;
                    const shared = a == c or a == d or b == c or b == d;
                    if (shared) {
                        // Only collinear overlap is a problem when segments share a node.
                        const sa = a == c or a == d;
                        const other_t = if (c == a or c == b) pd else pc;
                        const other_s = if (sa) pb else pa;
                        if ((c == a or c == b) and (d == a or d == b)) {
                            diag.set("curve {d} overlaps {s} {d} along segment {d}", .{ ci, roleName(ol.role), lj, k });
                            return error.Unsupported;
                        }
                        if (onSegment(other_t, pa, pb) or onSegment(other_s, pc, pd)) {
                            diag.set("curve {d} overlaps {s} {d} near ({d:.4}, {d:.4})", .{ ci, roleName(ol.role), lj, pa.x, pa.y });
                            return error.Unsupported;
                        }
                        continue;
                    }
                    if (!geom.segmentsIntersect(pa, pb, pc, pd)) continue;
                    const what = if (lj == ci) "itself" else roleName(ol.role);
                    if (k == 0 and onSegment(pa, pc, pd)) {
                        diag.set("curve {d}: its first end ({d:.4}, {d:.4}) touches {s} {d} between its nodes", .{ ci, pa.x, pa.y, what, lj });
                    } else if (k == cm - 2 and onSegment(pb, pc, pd)) {
                        diag.set("curve {d}: its last end ({d:.4}, {d:.4}) touches {s} {d} between its nodes", .{ ci, pb.x, pb.y, what, lj });
                    } else if (ol.role == .curve and lj != ci and ((e == 0 and onSegment(pc, pa, pb)) or (e == om - 2 and onSegment(pd, pa, pb)))) {
                        const q = if (e == 0) pc else pd;
                        diag.set("curve {d}: an end ({d:.4}, {d:.4}) touches curve {d} between its nodes", .{ lj, q.x, q.y, ci });
                    } else {
                        diag.set("curve {d} crosses {s} {d} between their nodes (segment {d} and segment {d})", .{ ci, what, lj, k, e });
                        if (lj == ci) diag.set("curve {d} crosses itself (segments {d} and {d})", .{ ci, k, e });
                    }
                    return error.Unsupported;
                }
            }
        }
        // Interior nodes may not lie on outer or hole loops; free nodes must be inside the region.
        for (cl.items, 0..) |it, k| {
            const w = on_wall.items[it.node];
            if (w >= 0) {
                if (k != 0 and k != cm - 1) {
                    diag.set("curve {d}: node {d} lies on {s} {d}; only curve ends may lie on a loop", .{ ci, k, roleName(bd.loops.items[@intCast(w)].role), w });
                    return error.Unsupported;
                }
                continue;
            }
            const p = pts[it.node];
            var outer_in: usize = 0;
            var hole_in: usize = 0;
            for (bd.loops.items) |ol| {
                if (ol.role != .outer and ol.role != .hole) continue;
                if (insidePolygon(p, pts, ol.items)) {
                    if (ol.role == .outer) outer_in += 1 else hole_in += 1;
                }
            }
            if (outer_in <= hole_in) {
                diag.set("curve {d} lies outside the meshed region (node {d} at ({d:.4}, {d:.4}))", .{ ci, k, p.x, p.y });
                return error.Unsupported;
            }
        }
    }
}

fn emitLoop(gpa: Allocator, bd: *Boundary, l: *const Loop, pl: *const Polyline, plan: *const LoopPlan, field: *const sizefield.SizeField, side: i8) !BLoop {
    var items: std.ArrayList(LoopNode) = .empty;
    errdefer items.deinit(gpa);
    var eruns: std.ArrayList(i32) = .empty;
    errdefer eruns.deinit(gpa);
    var eidx: std.ArrayList(i32) = .empty;
    errdefer eidx.deinit(gpa);
    const H = bd.target_size;

    const addNode = struct {
        fn f(g: Allocator, b: *Boundary, p: Vec2, fixed: bool) !u32 {
            const id: u32 = @intCast(b.points.items.len);
            try b.points.append(g, p);
            try b.fixed.append(g, fixed);
            return id;
        }
    }.f;

    if (plan.closed_run) {
        const r = l.fixed_runs[0];
        const pos = try gpa.alloc(Position, r.nodes.len);
        defer gpa.free(pos);
        projectRun(pl, r.nodes, 0, pl.total, pos);
        for (r.nodes, 0..) |p, k| {
            const id = try addNode(gpa, bd, p, true);
            try items.append(gpa, .{ .node = id, .segment = pos[k].segment, .parameter = pos[k].parameter, .fixed_run = 0, .fixed_node = @intCast(k) });
            try eruns.append(gpa, 0);
            try eidx.append(gpa, @intCast(k));
        }
    } else if (plan.runs.items.len == 0) {
        const range = plan.free_ranges.items[0];
        for (plan.pieces.items[range[0]..range[1]]) |pc| {
            const arcs = try distribute(gpa, pl, field, l, H, pc.a, pc.b, pc.n);
            defer gpa.free(arcs);
            for (arcs[0..pc.n], 0..) |s, q| {
                const pos = pl.locate(s);
                const exact = if (q == 0) pc.exact_start else null;
                const id = try addNode(gpa, bd, exact orelse pl.point(pos), false);
                try items.append(gpa, .{ .node = id, .segment = pos.segment, .parameter = pos.parameter });
                try eruns.append(gpa, -1);
                try eidx.append(gpa, -1);
            }
        }
    } else {
        const nr = plan.runs.items.len;
        var first_node: ?u32 = null;
        var pending_end: ?struct { node: u32, run: i32, idx: i32 } = null;
        for (0..nr) |k| {
            const span = plan.runs.items[k];
            const r = l.fixed_runs[span.run];
            const pos = try gpa.alloc(Position, r.nodes.len);
            defer gpa.free(pos);
            projectRun(pl, r.nodes, span.a, span.b, pos);
            const m = r.nodes.len;
            for (0..m) |j| {
                // The first node may coincide with the previous run's last node.
                if (j == 0) {
                    if (pending_end) |_| {
                        // Back-to-back runs share their junction node.
                        {
                            items.items[items.items.len - 1].fixed_run2 = @intCast(span.run);
                            items.items[items.items.len - 1].fixed_node2 = 0;
                            // Edge out of this node belongs to the new run.
                            eruns.items[eruns.items.len - 1] = @intCast(span.run);
                            eidx.items[eidx.items.len - 1] = 0;
                            pending_end = null;
                            continue;
                        }
                    }
                }
                if (j == m - 1 and k == nr - 1 and first_node != null) {
                    // The last run's end may coincide with the first run's start.
                    const f0 = first_node.?;
                    _ = f0;
                    if (plan.free_ranges.items[k][0] == plan.free_ranges.items[k][1]) {
                        items.items[0].fixed_run2 = @intCast(span.run);
                        items.items[0].fixed_node2 = @intCast(j);
                        continue;
                    }
                }
                const id = try addNode(gpa, bd, r.nodes[j], true);
                if (first_node == null) first_node = id;
                try items.append(gpa, .{ .node = id, .segment = pos[j].segment, .parameter = pos[j].parameter, .fixed_run = @intCast(span.run), .fixed_node = @intCast(j) });
                if (j + 1 < m) {
                    try eruns.append(gpa, @intCast(span.run));
                    try eidx.append(gpa, @intCast(j));
                } else {
                    try eruns.append(gpa, -1);
                    try eidx.append(gpa, -1);
                }
            }
            pending_end = .{ .node = items.items[items.items.len - 1].node, .run = @intCast(span.run), .idx = @intCast(m - 1) };
            // Free run after this fixed run.
            const range = plan.free_ranges.items[k];
            var first_piece = true;
            for (plan.pieces.items[range[0]..range[1]]) |pc| {
                const arcs = try distribute(gpa, pl, field, l, H, pc.a, pc.b, pc.n);
                defer gpa.free(arcs);
                // Skip the first arc (the fixed run's end node) of the first piece; later pieces
                // start at a corner that is emitted here.
                const from: usize = if (first_piece) 1 else 0;
                first_piece = false;
                var q = from;
                while (q < pc.n) : (q += 1) {
                    const p2 = pl.locate(arcs[q]);
                    const exact = if (q == 0) pc.exact_start else null;
                    const id = try addNode(gpa, bd, exact orelse pl.point(p2), false);
                    try items.append(gpa, .{ .node = id, .segment = p2.segment, .parameter = p2.parameter });
                    try eruns.append(gpa, -1);
                    try eidx.append(gpa, -1);
                }
                pending_end = null;
            }
        }
    }
    return .{
        .role = l.role,
        .items = try items.toOwnedSlice(gpa),
        .edge_run = try eruns.toOwnedSlice(gpa),
        .edge_index = try eidx.toOwnedSlice(gpa),
        .domain_side = side,
    };
}

// ---------------------------------------------------------------------------
// Tests

fn circle(gpa: Allocator, cx: f64, cy: f64, r: f64, n: usize, ccw: bool) ![]Vec2 {
    const pts = try gpa.alloc(Vec2, n);
    for (0..n) |i| {
        const t = 2.0 * std.math.pi * @as(f64, @floatFromInt(i)) / @as(f64, @floatFromInt(n));
        const a = if (ccw) t else -t;
        pts[i] = .init(cx + r * @cos(a), cy + r * @sin(a));
    }
    return pts;
}

test "free discretization: square, small hole gets elements per circle" {
    const gpa = std.testing.allocator;
    const sq = [_]Vec2{ .init(0, 0), .init(60, 0), .init(60, 40), .init(0, 40) };
    const hole = try circle(gpa, 30, 20, 1.5, 128, false);
    defer gpa.free(hole);
    const loops = [_]Loop{ .{ .role = .outer, .points = &sq }, .{ .role = .hole, .points = hole } };
    var diag = Diag{};
    var bd = try build(gpa, &loops, .{ .target_size = 4 }, &diag);
    defer bd.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 12), bd.loops.items[1].items.len);
    try std.testing.expectEqual(@as(usize, 50), bd.loops.items[0].items.len);
    try std.testing.expect(bd.edge_count % 2 == 0);
    // Corners are nodes.
    var corners: usize = 0;
    for (bd.loops.items[0].items) |it| {
        const p = bd.points.items[it.node];
        for (sq) |c| if (p.eql(c)) {
            corners += 1;
        };
    }
    try std.testing.expectEqual(@as(usize, 4), corners);
}

test "fixed runs are kept and odd fixed counts are rejected" {
    const gpa = std.testing.allocator;
    const sq = [_]Vec2{ .init(0, 0), .init(10, 0), .init(10, 10), .init(0, 10) };
    // Closed run with 5 nodes on the outer loop and nothing else: odd, no free run.
    const nodes = [_]Vec2{ .init(0, 0), .init(10, 0), .init(10, 10), .init(5, 10), .init(0, 10) };
    const runs = [_]FixedRun{.{ .nodes = &nodes, .closed = true }};
    const loops = [_]Loop{.{ .role = .outer, .points = &sq, .fixed_runs = &runs }};
    var diag = Diag{};
    try std.testing.expectError(error.OddBoundary, build(gpa, &loops, .{ .target_size = 2 }, &diag));
    try std.testing.expect(std.mem.indexOf(u8, diag.message(), "odd") != null);

    // Open run on the bottom edge plus free remainder: the free part absorbs parity.
    const bottom = [_]Vec2{ .init(0, 0), .init(2, 0), .init(4, 0), .init(10, 0) };
    const runs2 = [_]FixedRun{.{ .start = .{ .segment = 0, .parameter = 0 }, .end = .{ .segment = 0, .parameter = 1 }, .nodes = &bottom }};
    const loops2 = [_]Loop{.{ .role = .outer, .points = &sq, .fixed_runs = &runs2 }};
    var bd = try build(gpa, &loops2, .{ .target_size = 2.5 }, &diag);
    defer bd.deinit(gpa);
    try std.testing.expect(bd.edge_count % 2 == 0);
    const it = bd.loops.items[0].items;
    try std.testing.expect(bd.points.items[it[0].node].eql(bottom[0]));
    try std.testing.expect(bd.points.items[it[1].node].eql(bottom[1]));
    try std.testing.expect(bd.points.items[it[2].node].eql(bottom[2]));
    try std.testing.expect(bd.points.items[it[3].node].eql(bottom[3]));
    try std.testing.expectEqual(@as(i32, 0), it[2].fixed_run);
    try std.testing.expectEqual(@as(i32, 2), it[2].fixed_node);
    try std.testing.expectEqual(@as(i32, -1), it[4].fixed_run);
}
