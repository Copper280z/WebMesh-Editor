//! C ABI. The functions and struct layouts are those of the quadtree mesher's
//! `quadmesh_c/quadmesh.h` (ABI 0.2), so its Python (ctypes) and JavaScript
//! (wasm) bindings work unchanged with this library. ABI 0.3 adds open control
//! curves (MQ_LOOP_CURVE = 3). Options that only apply
//! to the quadtree mesher are accepted and ignored. Extra option keys:
//! MQ_OPTION_GROWTH_RATE (64) and MQ_OPTION_ENABLE_CLEANUP (65).

const std = @import("std");
const builtin = @import("builtin");
const geom = @import("geom.zig");
const boundary = @import("boundary.zig");
const mesher = @import("mesher.zig");
const Vec2 = geom.Vec2;
const Allocator = std.mem.Allocator;

const gpa: Allocator = if (builtin.cpu.arch.isWasm()) std.heap.wasm_allocator else std.heap.smp_allocator;

/// 0.3: open control curves (MQ_LOOP_CURVE = 3).
pub const abi_version: u32 = (0 << 24) | (3 << 12) | 0;

pub const Status = enum(c_int) {
    success = 0,
    invalid_argument = 1,
    unsupported_input = 2,
    invariant_failure = 3,
    allocation_failure = 4,
    internal_error = 5,
};

pub const Option = enum(c_int) {
    target_size = 0,
    max_refinement_level = 1,
    local_sizing_promotion = 2,
    feature_angle = 3,
    chord_tolerance = 4,
    finite_element_sizing = 5,
    elements_per_circle = 6,
    enable_smoothing = 7,
    smoothing_iterations = 8,
    absolute_tolerance = 9,
    relative_tolerance = 10,
    growth_rate = 64,
    enable_cleanup = 65,
    _,
};

pub const SizingSample = extern struct { arc_fraction: f64, target_cell_size: f64 };
pub const Quad4 = extern struct { nodes: [4]u32 };
pub const MeshingConfig = extern struct { max_refinement_level: u16, target_cell_size: f64, enable_smoothing: u8 };
pub const QualitySummary = extern struct {
    min_angle_deg: f64,
    max_angle_deg: f64,
    min_scaled_jacobian: f64,
    min_edge_ratio: f64,
    max_boundary_deviation: f64,
};
/// Extended report of the paved mesher (mq_paved_quality_t).
pub const PavedQuality = extern struct {
    min_angle_deg: f64,
    max_angle_deg: f64,
    min_scaled_jacobian: f64,
    p5_scaled_jacobian: f64,
    share_scaled_jacobian_05: f64,
    irregular_share: f64,
    min_edge_ratio: f64,
    max_boundary_deviation: f64,
    quad_count: u32,
    node_count: u32,
    interior_nodes: u32,
    irregular_nodes: u32,
    inverted: u32,
    all_quads: u8,
    conforming: u8,
    covers_domain: u8,
    fixed_kept: u8,
};

comptime {
    std.debug.assert(@sizeOf(mesher.BoundaryNode) == 32);
    std.debug.assert(@sizeOf(mesher.BoundaryEdge) == 40);
    std.debug.assert(@sizeOf(mesher.QuadQuality) == 16);
    std.debug.assert(@sizeOf(Vec2) == 16);
}

pub const Context = struct {
    err: [512:0]u8 = std.mem.zeroes([512:0]u8),

    fn set(self: *Context, status: Status, comptime fmt: []const u8, args: anytype) Status {
        const s = std.fmt.bufPrint(self.err[0..511], fmt, args) catch self.err[0..511];
        self.err[s.len] = 0;
        return status;
    }
    fn clear(self: *Context) void {
        self.err[0] = 0;
    }
};

pub const Options = struct {
    opts: boundary.Options = .{},
};

const RunData = struct {
    start: boundary.Position,
    end: boundary.Position,
    nodes: []Vec2,
    closed: bool,
};

const LoopData = struct {
    role: boundary.LoopRole,
    points: []Vec2,
    target_size: f64 = 0,
    samples: []boundary.SizingSample = &.{},
    kinds: []boundary.VertexKind = &.{},
    runs: std.ArrayList(RunData) = .empty,

    fn deinit(self: *LoopData) void {
        gpa.free(self.points);
        gpa.free(self.samples);
        gpa.free(self.kinds);
        for (self.runs.items) |r| gpa.free(r.nodes);
        self.runs.deinit(gpa);
    }
};

pub const Domain = struct {
    loops: std.ArrayList(LoopData) = .empty,
};

pub const Mesh = struct {
    result: mesher.Result,
};

pub const Report = struct {
    report: mesher.Report,
    issues: [][:0]u8,
};

fn mapError(ctx: *Context, e: anyerror, diag: *const boundary.Diag) Status {
    return switch (e) {
        error.OutOfMemory => ctx.set(.allocation_failure, "out of memory", .{}),
        error.OddBoundary, error.Unsupported => ctx.set(.unsupported_input, "{s}", .{diag.message()}),
        error.InvalidInput => ctx.set(.invalid_argument, "{s}", .{diag.message()}),
        else => ctx.set(.internal_error, "internal error: {s}", .{@errorName(e)}),
    };
}

fn finitePoints(points: ?[*]const Vec2, count: usize) bool {
    const p = points orelse return count == 0;
    for (p[0..count]) |q| if (!std.math.isFinite(q.x) or !std.math.isFinite(q.y)) return false;
    return true;
}

// ---------------------------------------------------------------------------
// Context and options

export fn mq_abi_version() u32 {
    return abi_version;
}

/// Name of the implementation behind this ABI ("paved").
export fn mq_implementation() [*:0]const u8 {
    return "paved";
}

export fn mq_context_create(out_ctx: ?*?*Context) Status {
    const out = out_ctx orelse return .invalid_argument;
    out.* = null;
    const c = gpa.create(Context) catch return .allocation_failure;
    c.* = .{};
    out.* = c;
    return .success;
}

export fn mq_context_destroy(ctx: ?*Context) void {
    if (ctx) |c| gpa.destroy(c);
}

export fn mq_context_last_error(ctx: ?*const Context) [*:0]const u8 {
    const c = ctx orelse return "invalid context";
    return &c.err;
}

export fn mq_options_create(ctx: ?*Context, out_options: ?*?*Options) Status {
    const c = ctx orelse return .invalid_argument;
    const out = out_options orelse return c.set(.invalid_argument, "options require context and output pointer", .{});
    out.* = null;
    const o = gpa.create(Options) catch return c.set(.allocation_failure, "out of memory", .{});
    o.* = .{};
    out.* = o;
    c.clear();
    return .success;
}

export fn mq_options_destroy(options: ?*Options) void {
    if (options) |o| gpa.destroy(o);
}

export fn mq_options_set(ctx: ?*Context, options: ?*Options, key: Option, value: f64) Status {
    const c = ctx orelse return .invalid_argument;
    const o = options orelse return c.set(.invalid_argument, "options require context, handle and finite value", .{});
    if (!std.math.isFinite(value)) return c.set(.invalid_argument, "options require context, handle and finite value", .{});
    const isInt = struct {
        fn f(v: f64, lo: f64, hi: f64) bool {
            return v >= lo and v <= hi and @floor(v) == v;
        }
    }.f;
    switch (key) {
        .target_size => {
            if (value < 0) return c.set(.invalid_argument, "target size must be positive (0 selects an automatic size)", .{});
            o.opts.target_size = value;
        },
        .max_refinement_level => if (!isInt(value, 1, 24)) return c.set(.invalid_argument, "integer option is out of range", .{}),
        .local_sizing_promotion, .finite_element_sizing => if (!isInt(value, 0, 1)) return c.set(.invalid_argument, "integer option is out of range", .{}),
        .feature_angle => {
            if (value < 0 or value > 180) return c.set(.invalid_argument, "feature angle must be in [0,180]", .{});
            o.opts.feature_angle_deg = value;
        },
        .chord_tolerance => {
            if (value < 0 or value > 1) return c.set(.invalid_argument, "chord tolerance must be in [0,1]", .{});
            o.opts.chord_tolerance = value;
        },
        .elements_per_circle => {
            if (!isInt(value, 8, 100000)) return c.set(.invalid_argument, "integer option is out of range", .{});
            o.opts.elements_per_circle = @intFromFloat(value);
        },
        .enable_smoothing => {
            if (!isInt(value, 0, 1)) return c.set(.invalid_argument, "integer option is out of range", .{});
            o.opts.enable_smoothing = value != 0;
        },
        .smoothing_iterations => {
            if (!isInt(value, 0, 1000)) return c.set(.invalid_argument, "integer option is out of range", .{});
            o.opts.smoothing_iterations = @intFromFloat(value);
        },
        .absolute_tolerance => {
            if (value <= 0) return c.set(.invalid_argument, "absolute tolerance must be positive", .{});
            o.opts.absolute_tolerance = value;
        },
        .relative_tolerance => {
            if (value < 0) return c.set(.invalid_argument, "relative tolerance must be nonnegative", .{});
            o.opts.relative_tolerance = value;
        },
        .growth_rate => {
            if (value < 1 or value > 4) return c.set(.invalid_argument, "growth rate must be in [1,4]", .{});
            o.opts.growth_rate = value;
        },
        .enable_cleanup => {
            if (!isInt(value, 0, 1)) return c.set(.invalid_argument, "integer option is out of range", .{});
            o.opts.enable_cleanup = value != 0;
        },
        _ => return c.set(.invalid_argument, "unknown meshing option", .{}),
    }
    c.clear();
    return .success;
}

// ---------------------------------------------------------------------------
// Domain

export fn mq_domain_create(ctx: ?*Context, out_domain: ?*?*Domain) Status {
    const c = ctx orelse return .invalid_argument;
    const out = out_domain orelse return c.set(.invalid_argument, "domain requires context and output pointer", .{});
    out.* = null;
    const d = gpa.create(Domain) catch return c.set(.allocation_failure, "out of memory", .{});
    d.* = .{};
    out.* = d;
    c.clear();
    return .success;
}

export fn mq_domain_destroy(domain: ?*Domain) void {
    const d = domain orelse return;
    for (d.loops.items) |*l| l.deinit();
    d.loops.deinit(gpa);
    gpa.destroy(d);
}

export fn mq_domain_add_loop(ctx: ?*Context, domain: ?*Domain, role: c_int, points: ?[*]const Vec2, count: usize, out_loop: ?*u32) Status {
    const c = ctx orelse return .invalid_argument;
    const d = domain orelse return c.set(.invalid_argument, "invalid loop arguments", .{});
    if (role < 0 or role > 3) return c.set(.invalid_argument, "unknown loop role", .{});
    const min_points: usize = if (role == 3) 2 else 3;
    if (count < min_points or points == null or !finitePoints(points, count)) {
        if (role == 3) return c.set(.invalid_argument, "a curve needs at least 2 finite points", .{});
        return c.set(.invalid_argument, "a loop needs at least 3 finite points", .{});
    }
    const r: boundary.LoopRole = @fromBackingInt(@intCast(@as(u8, @intCast(role))));
    if (r == .outer) {
        for (d.loops.items) |l| if (l.role != .outer) return c.set(.invalid_argument, "outer loops must be added before inner loops", .{});
    }
    const pts = gpa.dupe(Vec2, points.?[0..count]) catch return c.set(.allocation_failure, "out of memory", .{});
    d.loops.append(gpa, .{ .role = r, .points = pts }) catch {
        gpa.free(pts);
        return c.set(.allocation_failure, "out of memory", .{});
    };
    if (out_loop) |o| o.* = @intCast(d.loops.items.len - 1);
    c.clear();
    return .success;
}

export fn mq_domain_loop_count(domain: ?*const Domain) usize {
    const d = domain orelse return 0;
    return d.loops.items.len;
}

export fn mq_domain_set_loop_sizing(ctx: ?*Context, domain: ?*Domain, loop: u32, target_size: f64, samples: ?[*]const SizingSample, count: usize) Status {
    const c = ctx orelse return .invalid_argument;
    const d = domain orelse return c.set(.invalid_argument, "invalid sizing arguments", .{});
    if (count > 0 and samples == null) return c.set(.invalid_argument, "invalid sizing arguments", .{});
    if (loop >= d.loops.items.len) return c.set(.invalid_argument, "loop index out of range", .{});
    if (!std.math.isFinite(target_size) or target_size < 0) return c.set(.invalid_argument, "invalid loop target size", .{});
    const ss = gpa.alloc(boundary.SizingSample, count) catch return c.set(.allocation_failure, "out of memory", .{});
    var prev: f64 = -1;
    for (0..count) |k| {
        const s = samples.?[k];
        if (!std.math.isFinite(s.arc_fraction) or s.arc_fraction < 0 or s.arc_fraction > 1 or !(s.target_cell_size > 0) or !std.math.isFinite(s.target_cell_size) or s.arc_fraction < prev) {
            gpa.free(ss);
            return c.set(.invalid_argument, "invalid arc-length sizing sample", .{});
        }
        prev = s.arc_fraction;
        ss[k] = .{ .arc_fraction = s.arc_fraction, .size = s.target_cell_size };
    }
    const l = &d.loops.items[loop];
    gpa.free(l.samples);
    l.samples = ss;
    l.target_size = target_size;
    c.clear();
    return .success;
}

export fn mq_domain_set_vertex_kinds(ctx: ?*Context, domain: ?*Domain, loop: u32, kinds: ?[*]const u8, count: usize) Status {
    const c = ctx orelse return .invalid_argument;
    const d = domain orelse return c.set(.invalid_argument, "invalid vertex kind arguments", .{});
    if (loop >= d.loops.items.len) return c.set(.invalid_argument, "loop index out of range", .{});
    const l = &d.loops.items[loop];
    if (count != l.points.len or (count > 0 and kinds == null)) return c.set(.invalid_argument, "vertex kinds must match the loop's point count", .{});
    const ks = gpa.alloc(boundary.VertexKind, count) catch return c.set(.allocation_failure, "out of memory", .{});
    for (0..count) |k| {
        if (kinds.?[k] > 2) {
            gpa.free(ks);
            return c.set(.invalid_argument, "unknown vertex kind", .{});
        }
        ks[k] = @fromBackingInt(@intCast(kinds.?[k]));
    }
    gpa.free(l.kinds);
    l.kinds = ks;
    c.clear();
    return .success;
}

export fn mq_domain_add_fixed_run(ctx: ?*Context, domain: ?*Domain, loop: u32, start_segment: u32, start_parameter: f64, end_segment: u32, end_parameter: f64, nodes: ?[*]const Vec2, count: usize, closed: u8, out_run: ?*u32) Status {
    const c = ctx orelse return .invalid_argument;
    const d = domain orelse return c.set(.invalid_argument, "invalid fixed run arguments", .{});
    if (nodes == null or closed > 1 or count < @as(usize, if (closed != 0) 3 else 2)) return c.set(.invalid_argument, "invalid fixed run arguments", .{});
    if (loop >= d.loops.items.len) return c.set(.invalid_argument, "loop index out of range", .{});
    const l = &d.loops.items[loop];
    if (start_segment >= l.points.len or !std.math.isFinite(start_parameter) or start_parameter < 0 or start_parameter > 1 or
        (closed == 0 and (end_segment >= l.points.len or !std.math.isFinite(end_parameter) or end_parameter < 0 or end_parameter > 1)))
        return c.set(.invalid_argument, "invalid fixed run source positions", .{});
    if (!finitePoints(nodes, count)) return c.set(.invalid_argument, "non-finite fixed node", .{});
    const ns = gpa.dupe(Vec2, nodes.?[0..count]) catch return c.set(.allocation_failure, "out of memory", .{});
    l.runs.append(gpa, .{
        .start = .{ .segment = start_segment, .parameter = start_parameter },
        .end = .{ .segment = if (closed != 0) start_segment else end_segment, .parameter = if (closed != 0) start_parameter else end_parameter },
        .nodes = ns,
        .closed = closed != 0,
    }) catch {
        gpa.free(ns);
        return c.set(.allocation_failure, "out of memory", .{});
    };
    if (out_run) |o| o.* = @intCast(l.runs.items.len - 1);
    c.clear();
    return .success;
}

export fn mq_domain_create_polygon(ctx: ?*Context, points: ?[*]const Vec2, count: usize, out_domain: ?*?*Domain) Status {
    const c = ctx orelse return .invalid_argument;
    const st = mq_domain_create(c, out_domain);
    if (st != .success) return st;
    const d = out_domain.?.*.?;
    const st2 = mq_domain_add_loop(c, d, 0, points, count, null);
    if (st2 != .success) {
        mq_domain_destroy(d);
        out_domain.?.* = null;
        return st2;
    }
    return .success;
}

export fn mq_domain_add_inner_loop(ctx: ?*Context, domain: ?*Domain, points: ?[*]const Vec2, count: usize, role: c_int) Status {
    const c = ctx orelse return .invalid_argument;
    const r: c_int = switch (role) {
        0 => 1, // hole
        1 => 2, // mesh control feature
        else => return c.set(.invalid_argument, "unknown inner loop role", .{}),
    };
    return mq_domain_add_loop(c, domain, r, points, count, null);
}

// ---------------------------------------------------------------------------
// Meshing

fn generate(c: *Context, d: *const Domain, opts: boundary.Options, out_mesh: ?*?*Mesh, out_report: ?*?*Report) Status {
    const om = out_mesh orelse return c.set(.invalid_argument, "mesh generation requires an output pointer", .{});
    om.* = null;
    if (out_report) |r| r.* = null;
    // Assemble loops.
    var loops = gpa.alloc(boundary.Loop, d.loops.items.len) catch return c.set(.allocation_failure, "out of memory", .{});
    defer gpa.free(loops);
    var run_lists = gpa.alloc([]boundary.FixedRun, d.loops.items.len) catch return c.set(.allocation_failure, "out of memory", .{});
    var nrl: usize = 0;
    defer {
        for (run_lists[0..nrl]) |rl| gpa.free(rl);
        gpa.free(run_lists);
    }
    for (d.loops.items, 0..) |l, li| {
        const rl = gpa.alloc(boundary.FixedRun, l.runs.items.len) catch return c.set(.allocation_failure, "out of memory", .{});
        run_lists[li] = rl;
        nrl += 1;
        for (l.runs.items, 0..) |r, k| rl[k] = .{ .start = r.start, .end = r.end, .nodes = r.nodes, .closed = r.closed };
        loops[li] = .{ .role = l.role, .points = l.points, .target_size = l.target_size, .sizing_samples = l.samples, .vertex_kinds = l.kinds, .fixed_runs = rl };
    }
    var diag = boundary.Diag{};
    const res = mesher.generate(gpa, loops, opts, &diag) catch |e| return mapError(c, e, &diag);
    const m = gpa.create(Mesh) catch {
        var r2 = res;
        r2.deinit(gpa);
        return c.set(.allocation_failure, "out of memory", .{});
    };
    m.* = .{ .result = res };
    // Report object (owns a copy of the report with NUL-terminated issues).
    if (out_report) |orp| {
        const rep = gpa.create(Report) catch {
            mq_mesh_destroy(m);
            return c.set(.allocation_failure, "out of memory", .{});
        };
        var issues = gpa.alloc([:0]u8, m.result.report.issues.items.len) catch {
            gpa.destroy(rep);
            mq_mesh_destroy(m);
            return c.set(.allocation_failure, "out of memory", .{});
        };
        var made: usize = 0;
        for (m.result.report.issues.items) |s| {
            issues[made] = gpa.dupeSentinel(u8, s, 0) catch {
                for (issues[0..made]) |x| gpa.free(x);
                gpa.free(issues);
                gpa.destroy(rep);
                mq_mesh_destroy(m);
                return c.set(.allocation_failure, "out of memory", .{});
            };
            made += 1;
        }
        var copy = m.result.report;
        copy.issues = .empty;
        rep.* = .{ .report = copy, .issues = issues };
        orp.* = rep;
    }
    om.* = m;
    c.clear();
    return .success;
}

export fn mq_mesh_generate(ctx: ?*Context, domain: ?*const Domain, config: ?*const MeshingConfig, out_mesh: ?*?*Mesh, out_report: ?*?*Report) Status {
    const c = ctx orelse return .invalid_argument;
    const d = domain orelse return c.set(.invalid_argument, "mesh generation requires a domain", .{});
    var o = boundary.Options{};
    if (config) |cf| {
        if (!std.math.isFinite(cf.target_cell_size) or cf.target_cell_size < 0) return c.set(.invalid_argument, "invalid target cell size", .{});
        o.target_size = cf.target_cell_size;
        o.enable_smoothing = cf.enable_smoothing != 0;
    }
    return generate(c, d, o, out_mesh, out_report);
}

export fn mq_mesh_generate_with_options(ctx: ?*Context, domain: ?*const Domain, options: ?*const Options, out_mesh: ?*?*Mesh, out_report: ?*?*Report) Status {
    const c = ctx orelse return .invalid_argument;
    const d = domain orelse return c.set(.invalid_argument, "mesh generation requires a domain", .{});
    const o = if (options) |op| op.opts else boundary.Options{};
    return generate(c, d, o, out_mesh, out_report);
}

export fn mq_mesh_destroy(mesh: ?*Mesh) void {
    const m = mesh orelse return;
    m.result.deinit(gpa);
    gpa.destroy(m);
}

export fn mq_validation_report_destroy(report: ?*Report) void {
    const r = report orelse return;
    for (r.issues) |s| gpa.free(s);
    gpa.free(r.issues);
    gpa.destroy(r);
}

export fn mq_mesh_node_count(mesh: ?*const Mesh) usize {
    const m = mesh orelse return 0;
    return m.result.nodes.len;
}

export fn mq_mesh_quad_count(mesh: ?*const Mesh) usize {
    const m = mesh orelse return 0;
    return m.result.quads.len;
}

fn copyOut(c: *Context, comptime T: type, src: []const T, out: ?[*]T, capacity: usize) Status {
    if (src.len > 0 and out == null) return c.set(.invalid_argument, "output buffer is null", .{});
    if (capacity < src.len) return c.set(.invalid_argument, "output buffer too small: need {d}, have {d}", .{ src.len, capacity });
    if (src.len > 0) @memcpy(out.?[0..src.len], src);
    c.clear();
    return .success;
}

export fn mq_mesh_copy_nodes(ctx: ?*Context, mesh: ?*const Mesh, out_nodes: ?[*]Vec2, capacity: usize) Status {
    const c = ctx orelse return .invalid_argument;
    const m = mesh orelse return c.set(.invalid_argument, "invalid mesh handle", .{});
    return copyOut(c, Vec2, m.result.nodes, out_nodes, capacity);
}

export fn mq_mesh_copy_quads(ctx: ?*Context, mesh: ?*const Mesh, out_quads: ?[*]Quad4, capacity: usize) Status {
    const c = ctx orelse return .invalid_argument;
    const m = mesh orelse return c.set(.invalid_argument, "invalid mesh handle", .{});
    return copyOut(c, Quad4, @ptrCast(m.result.quads), out_quads, capacity);
}

export fn mq_mesh_boundary_node_count(mesh: ?*const Mesh) usize {
    const m = mesh orelse return 0;
    return m.result.boundary_nodes.len;
}

export fn mq_mesh_boundary_edge_count(mesh: ?*const Mesh) usize {
    const m = mesh orelse return 0;
    return m.result.boundary_edges.len;
}

export fn mq_mesh_copy_boundary_nodes(ctx: ?*Context, mesh: ?*const Mesh, out: ?[*]mesher.BoundaryNode, capacity: usize) Status {
    const c = ctx orelse return .invalid_argument;
    const m = mesh orelse return c.set(.invalid_argument, "invalid mesh handle", .{});
    return copyOut(c, mesher.BoundaryNode, m.result.boundary_nodes, out, capacity);
}

export fn mq_mesh_copy_boundary_edges(ctx: ?*Context, mesh: ?*const Mesh, out: ?[*]mesher.BoundaryEdge, capacity: usize) Status {
    const c = ctx orelse return .invalid_argument;
    const m = mesh orelse return c.set(.invalid_argument, "invalid mesh handle", .{});
    return copyOut(c, mesher.BoundaryEdge, m.result.boundary_edges, out, capacity);
}

export fn mq_mesh_copy_quad_quality(ctx: ?*Context, mesh: ?*const Mesh, out: ?[*]mesher.QuadQuality, capacity: usize) Status {
    const c = ctx orelse return .invalid_argument;
    const m = mesh orelse return c.set(.invalid_argument, "invalid mesh handle", .{});
    return copyOut(c, mesher.QuadQuality, m.result.quality, out, capacity);
}

export fn mq_validation_report_ok(report: ?*const Report) u8 {
    const r = report orelse return 0;
    return @intFromBool(r.report.valid);
}

export fn mq_validation_report_issue_count(report: ?*const Report) usize {
    const r = report orelse return 0;
    return r.issues.len;
}

export fn mq_validation_report_issue(report: ?*const Report, index: usize) ?[*:0]const u8 {
    const r = report orelse return null;
    if (index >= r.issues.len) return null;
    return r.issues[index].ptr;
}

export fn mq_validation_report_quality(report: ?*const Report, out: ?*QualitySummary) Status {
    const r = report orelse return .invalid_argument;
    const o = out orelse return .invalid_argument;
    const q = &r.report;
    o.* = .{
        .min_angle_deg = q.min_angle_deg,
        .max_angle_deg = q.max_angle_deg,
        .min_scaled_jacobian = q.min_scaled_jacobian,
        .min_edge_ratio = q.min_edge_ratio,
        .max_boundary_deviation = q.max_boundary_deviation,
    };
    return .success;
}

/// Extended quality report (paved mesher only): percentiles, irregular share and the
/// individual validity checks.
export fn mq_validation_report_paved_quality(report: ?*const Report, out: ?*PavedQuality) Status {
    const r = report orelse return .invalid_argument;
    const o = out orelse return .invalid_argument;
    const q = &r.report;
    o.* = .{
        .min_angle_deg = q.min_angle_deg,
        .max_angle_deg = q.max_angle_deg,
        .min_scaled_jacobian = q.min_scaled_jacobian,
        .p5_scaled_jacobian = q.p5_scaled_jacobian,
        .share_scaled_jacobian_05 = q.share_sj_05,
        .irregular_share = q.irregular_share,
        .min_edge_ratio = q.min_edge_ratio,
        .max_boundary_deviation = q.max_boundary_deviation,
        .quad_count = @intCast(q.quad_count),
        .node_count = @intCast(q.node_count),
        .interior_nodes = @intCast(q.interior_nodes),
        .irregular_nodes = @intCast(q.irregular_nodes),
        .inverted = @intCast(q.inverted),
        .all_quads = @intFromBool(q.all_quads),
        .conforming = @intFromBool(q.conforming),
        .covers_domain = @intFromBool(q.covers_domain),
        .fixed_kept = @intFromBool(q.fixed_kept),
    };
    return .success;
}

// ---------------------------------------------------------------------------
// Tests through the C ABI

test "C ABI: plate with hole and fixed nodes, provenance, errors" {
    const fixtures = @import("fixtures.zig");
    var ctx: ?*Context = null;
    try std.testing.expectEqual(Status.success, mq_context_create(&ctx));
    defer mq_context_destroy(ctx);
    var dom: ?*Domain = null;
    try std.testing.expectEqual(Status.success, mq_domain_create(ctx, &dom));
    defer mq_domain_destroy(dom);
    var fx = try fixtures.plateWithHoleFixed(std.testing.allocator);
    defer fx.deinit(std.testing.allocator);
    for (fx.loops.items) |l| {
        var id: u32 = 0;
        try std.testing.expectEqual(Status.success, mq_domain_add_loop(ctx, dom, @backingInt(l.role), l.points.ptr, l.points.len, &id));
        const r = l.fixed_runs[0];
        try std.testing.expectEqual(Status.success, mq_domain_add_fixed_run(ctx, dom, id, 0, 0, 0, 0, r.nodes.ptr, r.nodes.len, 1, null));
    }
    var opt: ?*Options = null;
    try std.testing.expectEqual(Status.success, mq_options_create(ctx, &opt));
    defer mq_options_destroy(opt);
    try std.testing.expectEqual(Status.success, mq_options_set(ctx, opt, .target_size, 2));
    try std.testing.expectEqual(Status.invalid_argument, mq_options_set(ctx, opt, .elements_per_circle, 3));
    try std.testing.expect(std.mem.len(mq_context_last_error(ctx)) > 0);
    var mesh: ?*Mesh = null;
    var rep: ?*Report = null;
    try std.testing.expectEqual(Status.success, mq_mesh_generate_with_options(ctx, dom, opt, &mesh, &rep));
    defer mq_mesh_destroy(mesh);
    defer mq_validation_report_destroy(rep);
    try std.testing.expectEqual(@as(u8, 1), mq_validation_report_ok(rep));
    const nb = mq_mesh_boundary_node_count(mesh);
    try std.testing.expectEqual(@as(usize, 76), nb);
    var recs: [76]mesher.BoundaryNode = undefined;
    try std.testing.expectEqual(Status.success, mq_mesh_copy_boundary_nodes(ctx, mesh, &recs, recs.len));
    try std.testing.expectEqual(@as(i32, 15), recs[75].fixed_node);
    try std.testing.expectEqual(@as(u32, 1), recs[75].loop);
    var small: [2]Vec2 = undefined;
    try std.testing.expectEqual(Status.invalid_argument, mq_mesh_copy_nodes(ctx, mesh, &small, small.len));

    // Odd fixed edges: unsupported input with a clear message.
    var dom2: ?*Domain = null;
    try std.testing.expectEqual(Status.success, mq_domain_create(ctx, &dom2));
    defer mq_domain_destroy(dom2);
    const sq = [_]Vec2{ .init(0, 0), .init(10, 0), .init(10, 10), .init(0, 10) };
    const odd = [_]Vec2{ .init(0, 0), .init(10, 0), .init(10, 10), .init(5, 10), .init(0, 10) };
    try std.testing.expectEqual(Status.success, mq_domain_add_loop(ctx, dom2, 0, &sq, 4, null));
    try std.testing.expectEqual(Status.success, mq_domain_add_fixed_run(ctx, dom2, 0, 0, 0, 0, 0, &odd, 5, 1, null));
    var mesh2: ?*Mesh = null;
    try std.testing.expectEqual(Status.unsupported_input, mq_mesh_generate_with_options(ctx, dom2, opt, &mesh2, null));
    try std.testing.expect(mesh2 == null);
    try std.testing.expect(std.mem.indexOf(u8, std.mem.span(mq_context_last_error(ctx)), "odd number") != null);
}
