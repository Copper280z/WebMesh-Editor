//! Topological cleanup of quad meshes (after Kinney 1997 and Canann et al. 1998):
//! changes that bring interior nodes toward four quads each and boundary
//! nodes toward the count their corner angle asks for (one quad per 90
//! degrees). Each change lowers the valence energy sum (q - ideal)^2; it is
//! kept only if local smoothing makes every affected quad valid. Boundary
//! nodes are never moved or removed.
//!
//! Operations: doublet removal (a free node in two quads), diamond collapse
//! (a quad with two opposite free three-valent nodes), and quad edge swaps
//! (rotating the edge shared by two quads inside their hexagon).

const std = @import("std");
const geom = @import("geom.zig");
const polymesh = @import("polymesh.zig");
const smooth = @import("smooth.zig");
const Vec2 = geom.Vec2;
const PolyMesh = polymesh.PolyMesh;
const NONE = polymesh.NONE;

pub const Options = struct {
    max_passes: u32 = 20,
    /// New quads must reach this scaled Jacobian after local smoothing.
    min_sj: f64 = 0.25,
};

pub const Stats = struct {
    doublets: usize = 0,
    swaps: usize = 0,
    collapses: usize = 0,
    quality_swaps: usize = 0,
    rejected: usize = 0,
};

pub inline fn ekey(a: u32, b: u32) u64 {
    return (@as(u64, @min(a, b)) << 32) | @max(a, b);
}

const Ctx = struct {
    pm: *PolyMesh,
    ideal: []f64,
    constrained: *const std.AutoHashMap(u64, void),
    opts: Options,
    stats: *Stats,
    // undo log
    killed: std.ArrayList(u32) = .empty,
    added: std.ArrayList(u32) = .empty,
    moved: std.ArrayList(struct { v: u32, p: Vec2 }) = .empty,
    patch: std.ArrayList(u32) = .empty,
    core: usize = 0,
    /// Candidates that failed validation; element ids change when a neighborhood is
    /// rebuilt, so a key goes stale exactly when a retry could succeed.
    rejected: std.AutoHashMap(u64, void),

    fn deinit(self: *Ctx) void {
        const g = self.pm.gpa;
        self.killed.deinit(g);
        self.added.deinit(g);
        self.moved.deinit(g);
        self.patch.deinit(g);
        self.rejected.deinit();
    }

    fn rkey(op: u64, a: u64, b: u64) u64 {
        return (op << 60) | ((a & 0x3FFFFFFF) << 30) | (b & 0x3FFFFFFF);
    }

    fn val(self: *const Ctx, v: u32) i32 {
        return @intCast(self.pm.node_elems.items[v].items.len);
    }

    fn en(self: *const Ctx, v: u32, q: i32) f64 {
        const d = @as(f64, @floatFromInt(q)) - self.ideal[v];
        return d * d;
    }

    fn begin(self: *Ctx) void {
        self.killed.clearRetainingCapacity();
        self.added.clearRetainingCapacity();
        self.moved.clearRetainingCapacity();
        self.patch.clearRetainingCapacity();
    }

    fn kill(self: *Ctx, x: u32) !void {
        self.pm.killElem(x);
        try self.killed.append(self.pm.gpa, x);
    }

    fn add(self: *Ctx, e: [4]u32) !u32 {
        const id = try self.pm.addElem(e);
        try self.added.append(self.pm.gpa, id);
        return id;
    }

    fn undo(self: *Ctx) !void {
        var i = self.added.items.len;
        while (i > 0) {
            i -= 1;
            self.pm.killElem(self.added.items[i]);
        }
        var j = self.killed.items.len;
        while (j > 0) {
            j -= 1;
            try self.pm.reviveElem(self.killed.items[j]);
        }
        var k = self.moved.items.len;
        while (k > 0) {
            k -= 1;
            self.pm.pts.items[self.moved.items[k].v] = self.moved.items[k].p;
        }
    }

    /// Patch = nodes of the new elements plus their one-ring; positions are saved for undo.
    fn buildPatch(self: *Ctx) !void {
        const g = self.pm.gpa;
        for (self.added.items) |x| {
            const e = self.pm.elems.items[x];
            for (0..PolyMesh.nv(e)) |k| {
                const v = e[k];
                if (std.mem.indexOfScalar(u32, self.patch.items, v) == null) try self.patch.append(g, v);
            }
        }
        const core = self.patch.items.len;
        self.core = core;
        for (0..core) |i| {
            const v = self.patch.items[i];
            for (self.pm.node_elems.items[v].items) |x| {
                const e = self.pm.elems.items[x];
                for (0..PolyMesh.nv(e)) |k| {
                    const w = e[k];
                    if (std.mem.indexOfScalar(u32, self.patch.items, w) == null) try self.patch.append(g, w);
                }
            }
        }
        for (self.patch.items) |v| try self.moved.append(g, .{ .v = v, .p = self.pm.pts.items[v] });
    }

    /// Smooths the patch and checks the result; undoes the change if it is not acceptable.
    fn finish(self: *Ctx) !bool {
        try self.buildPatch();
        try smooth.smoothPatch(self.pm, self.patch.items, self.core, 8);
        var ok = true;
        for (self.patch.items) |v| {
            for (self.pm.node_elems.items[v].items) |x| {
                if (!self.pm.elemValid(x)) ok = false;
            }
        }
        if (ok) {
            for (self.added.items) |x| {
                if (self.pm.alive.items[x] and self.pm.elemSJ(x) < self.opts.min_sj) ok = false;
            }
        }
        if (!ok) {
            try self.undo();
            self.stats.rejected += 1;
        }
        return ok;
    }

    fn rotateTo(e: [4]u32, v: u32) ?[4]u32 {
        for (0..4) |k| if (e[k] == v) return .{ e[k], e[(k + 1) % 4], e[(k + 2) % 4], e[(k + 3) % 4] };
        return null;
    }

    fn tryDoublet(self: *Ctx, v: u32) !bool {
        const pm = self.pm;
        if (pm.fixed.items[v] or self.val(v) != 2) return false;
        const x1 = pm.node_elems.items[v].items[0];
        const x2 = pm.node_elems.items[v].items[1];
        const q1 = rotateTo(pm.elems.items[x1], v) orelse return false;
        const q2 = rotateTo(pm.elems.items[x2], v) orelse return false;
        // q1 = (v, a, x, b), q2 = (v, b, y, a)
        if (q2[1] != q1[3] or q2[3] != q1[1]) return false;
        if (q1[2] == q2[2]) return false;
        const rk = rkey(1, x1, x2);
        if (self.rejected.contains(rk)) return false;
        self.begin();
        try self.kill(x1);
        try self.kill(x2);
        _ = try self.add(.{ q1[1], q1[2], q1[3], q2[2] });
        if (try self.finish()) {
            self.stats.doublets += 1;
            return true;
        }
        try self.rejected.put(rk, {});
        return false;
    }

    fn trySwap(self: *Ctx, x1: u32, k: usize) !bool {
        const pm = self.pm;
        const e1 = pm.elems.items[x1];
        const u = e1[k];
        const v = e1[(k + 1) % 4];
        if (self.constrained.contains(ekey(u, v))) return false;
        const x2 = pm.across(x1, u, v);
        if (x2 == NONE or x2 < x1) return false;
        const q1 = rotateTo(e1, u).?; // (u, v, a, b)
        const q2 = rotateTo(pm.elems.items[x2], v) orelse return false; // (v, u, c, d)
        if (q2[1] != u) return false;
        const hex = [6]u32{ v, q1[2], q1[3], u, q2[2], q2[3] }; // v, a, b, u, c, d
        // Distinct nodes required.
        for (0..6) |i| for (i + 1..6) |j| if (hex[i] == hex[j]) return false;
        const vu = self.val(u);
        const vv = self.val(v);
        if (vu <= 1 or vv <= 1) return false;
        const base_e = self.en(u, vu) + self.en(v, vv);
        const after_uv = self.en(u, vu - 1) + self.en(v, vv - 1);
        // Option A: diagonal (a, c) = hex[1], hex[4]; option B: (b, d) = hex[2], hex[5].
        var best: f64 = -1e-9;
        var choice: usize = 0;
        for ([_]usize{ 1, 2 }) |s| {
            const p1 = hex[s];
            const p2 = hex[s + 3];
            const d = after_uv - base_e + self.en(p1, self.val(p1) + 1) - self.en(p1, self.val(p1)) + self.en(p2, self.val(p2) + 1) - self.en(p2, self.val(p2));
            if (d < best) {
                best = d;
                choice = s;
            }
        }
        if (choice == 0) return false;
        const rk = rkey(2, @as(u64, x1) * 4 + k, x2);
        if (self.rejected.contains(rk)) return false;
        const s = choice;
        self.begin();
        try self.kill(x1);
        try self.kill(x2);
        _ = try self.add(.{ hex[s], hex[s + 1], hex[s + 2], hex[s + 3] });
        _ = try self.add(.{ hex[s + 3], hex[(s + 4) % 6], hex[(s + 5) % 6], hex[s] });
        if (try self.finish()) {
            self.stats.swaps += 1;
            return true;
        }
        try self.rejected.put(rk, {});
        return false;
    }

    /// Quad edge swap for shape: taken when it raises the worse of the two quads' scaled
    /// Jacobian clearly and costs little valence energy. Fixes skewed quads in strips one
    /// element wide, where no interior node exists for smoothing to move.
    fn tryQualitySwap(self: *Ctx, x1: u32, k: usize) !bool {
        const pm = self.pm;
        const e1 = pm.elems.items[x1];
        const u = e1[k];
        const v = e1[(k + 1) % 4];
        if (self.constrained.contains(ekey(u, v))) return false;
        const x2 = pm.across(x1, u, v);
        if (x2 == NONE or x2 < x1) return false;
        const old_min = @min(pm.elemSJ(x1), pm.elemSJ(x2));
        if (old_min >= 0.55) return false;
        const q1 = rotateTo(e1, u).?;
        const q2 = rotateTo(pm.elems.items[x2], v) orelse return false;
        if (q2[1] != u) return false;
        const hex = [6]u32{ v, q1[2], q1[3], u, q2[2], q2[3] };
        for (0..6) |i| for (i + 1..6) |j| if (hex[i] == hex[j]) return false;
        const vu = self.val(u);
        const vv = self.val(v);
        if (vu <= 1 or vv <= 1) return false;
        const base_e = self.en(u, vu) + self.en(v, vv);
        const after_uv = self.en(u, vu - 1) + self.en(v, vv - 1);
        var best_q = old_min + 0.08;
        var choice: usize = 0;
        for ([_]usize{ 1, 2 }) |s| {
            const p1 = hex[s];
            const p2 = hex[s + 3];
            const d = after_uv - base_e + self.en(p1, self.val(p1) + 1) - self.en(p1, self.val(p1)) + self.en(p2, self.val(p2) + 1) - self.en(p2, self.val(p2));
            if (d > 0.6) continue;
            const qa = [4]u32{ hex[s], hex[s + 1], hex[s + 2], hex[s + 3] };
            const qb = [4]u32{ hex[s + 3], hex[(s + 4) % 6], hex[(s + 5) % 6], hex[s] };
            const pa = pm.quadPts(qa);
            const pb = pm.quadPts(qb);
            if (!geom.quadConvex(pa) or !geom.quadConvex(pb)) continue;
            const nq = @min(geom.quadScaledJacobian(pa), geom.quadScaledJacobian(pb));
            if (nq > best_q) {
                best_q = nq;
                choice = s;
            }
        }
        if (choice == 0) return false;
        const rk = rkey(3, @as(u64, x1) * 4 + k, x2);
        if (self.rejected.contains(rk)) return false;
        const s = choice;
        self.begin();
        try self.kill(x1);
        try self.kill(x2);
        _ = try self.add(.{ hex[s], hex[s + 1], hex[s + 2], hex[s + 3] });
        _ = try self.add(.{ hex[s + 3], hex[(s + 4) % 6], hex[(s + 5) % 6], hex[s] });
        if (try self.finish()) {
            self.stats.quality_swaps += 1;
            return true;
        }
        try self.rejected.put(rk, {});
        return false;
    }

    fn tryCollapse(self: *Ctx, x: u32) !bool {
        const pm = self.pm;
        const e = pm.elems.items[x];
        for (0..2) |k| {
            const a = e[k];
            const c = e[k + 2];
            const b = e[k + 1];
            const d = e[(k + 3) % 4];
            if (pm.fixed.items[a] and pm.fixed.items[c]) continue;
            const va = self.val(a);
            const vc = self.val(c);
            const merged = va + vc - 2;
            // Keep the fixed node if there is one.
            const keep = if (pm.fixed.items[c]) c else a;
            const drop = if (keep == a) c else a;
            const dE = self.en(keep, merged) - self.en(a, va) - self.en(c, vc) +
                self.en(b, self.val(b) - 1) - self.en(b, self.val(b)) +
                self.en(d, self.val(d) - 1) - self.en(d, self.val(d));
            if (dE >= -1e-9) continue;
            if (self.val(b) <= 1 or self.val(d) <= 1) continue;
            // The two nodes may not share another element.
            var shared = false;
            for (pm.node_elems.items[drop].items) |y| {
                if (y == x) continue;
                const f = pm.elems.items[y];
                for (0..PolyMesh.nv(f)) |i| if (f[i] == keep) {
                    shared = true;
                };
            }
            if (shared) continue;
            const rk = rkey(4, x, k);
            if (self.rejected.contains(rk)) continue;
            self.begin();
            const g = pm.gpa;
            try self.moved.append(g, .{ .v = keep, .p = pm.pts.items[keep] });
            try self.moved.append(g, .{ .v = drop, .p = pm.pts.items[drop] });
            if (!pm.fixed.items[keep]) pm.pts.items[keep] = pm.p(a).mid(pm.p(c));
            try self.kill(x);
            var list: std.ArrayList(u32) = .empty;
            defer list.deinit(g);
            try list.appendSlice(g, pm.node_elems.items[drop].items);
            for (list.items) |y| {
                var f = pm.elems.items[y];
                try self.kill(y);
                for (0..PolyMesh.nv(f)) |i| if (f[i] == drop) {
                    f[i] = keep;
                };
                _ = try self.add(f);
            }
            if (try self.finish()) {
                self.stats.collapses += 1;
                return true;
            }
            try self.rejected.put(rk, {});
        }
        return false;
    }
};

/// Ideal number of quads at each node: 4 inside, one per 90 degrees of domain angle on the
/// boundary. The boundary value is not rounded: a node on a hole (about 210 degrees) is
/// between 2 and 3, so moving an irregularity from the interior onto it pays off.
fn computeIdeal(pm: *const PolyMesh, out: []f64) void {
    for (out, 0..) |*x, vi| {
        const v: u32 = @intCast(vi);
        if (!pm.fixed.items[v]) {
            x.* = 4.0;
            continue;
        }
        var theta: f64 = 0;
        for (pm.node_elems.items[v].items) |e| {
            const q = pm.elems.items[e];
            const n = PolyMesh.nv(q);
            var k: usize = 0;
            while (q[k] != v) k += 1;
            const pv = pm.p(v);
            theta += geom.ccwAngle(pm.p(q[(k + 1) % n]).sub(pv), pm.p(q[(k + n - 1) % n]).sub(pv));
        }
        x.* = @max(1.0, theta / (0.5 * std.math.pi));
    }
}

pub fn cleanup(pm: *PolyMesh, constrained: *const std.AutoHashMap(u64, void), opts: Options, stats: *Stats) !void {
    const ideal = try pm.gpa.alloc(f64, pm.pts.items.len);
    defer pm.gpa.free(ideal);
    computeIdeal(pm, ideal);
    var ctx = Ctx{ .pm = pm, .ideal = ideal, .constrained = constrained, .opts = opts, .stats = stats, .rejected = std.AutoHashMap(u64, void).init(pm.gpa) };
    defer ctx.deinit();
    var pass: u32 = 0;
    while (pass < opts.max_passes) : (pass += 1) {
        var changed = false;
        for (0..pm.pts.items.len) |vi| {
            if (try ctx.tryDoublet(@intCast(vi))) changed = true;
        }
        var x: usize = 0;
        while (x < pm.elems.items.len) : (x += 1) {
            if (!pm.alive.items[x] or PolyMesh.isTri(pm.elems.items[x])) continue;
            if (try ctx.tryCollapse(@intCast(x))) changed = true;
        }
        x = 0;
        while (x < pm.elems.items.len) : (x += 1) {
            if (!pm.alive.items[x] or PolyMesh.isTri(pm.elems.items[x])) continue;
            for (0..4) |k| {
                if (!pm.alive.items[x]) break;
                if (try ctx.trySwap(@intCast(x), k)) {
                    changed = true;
                    break;
                }
            }
        }
        if (!changed) break;
    }
    // Shape-driven swaps.
    pass = 0;
    while (pass < 3) : (pass += 1) {
        var changed = false;
        var x: usize = 0;
        while (x < pm.elems.items.len) : (x += 1) {
            if (!pm.alive.items[x] or PolyMesh.isTri(pm.elems.items[x])) continue;
            for (0..4) |k| {
                if (!pm.alive.items[x]) break;
                if (try ctx.tryQualitySwap(@intCast(x), k)) {
                    changed = true;
                    break;
                }
            }
        }
        if (!changed) break;
    }
}
