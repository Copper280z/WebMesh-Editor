//! Q-Morph (Owen et al. 1999): converts the triangle mesh into quads row by
//! row with an advancing front.
//!
//! The front is the set of directed triangle edges whose neighbor is NONE
//! (a quad or the domain boundary on the other side); the unmeshed triangles
//! lie to the left. Front loops are implicit: the next front edge is found by
//! rotating around the end node through the triangles, which also handles
//! pinch nodes where several loops touch.

const std = @import("std");
const geom = @import("geom.zig");
const tm = @import("trimesh.zig");
const sizefield = @import("sizefield.zig");
const Vec2 = geom.Vec2;
const Mesh = tm.Mesh;
const NONE = tm.NONE;
const next3 = tm.next3;
const prev3 = tm.prev3;
const Allocator = std.mem.Allocator;

const pi = std.math.pi;

pub inline fn dkey(a: u32, b: u32) u64 {
    return (@as(u64, a) << 32) | b;
}

const FrontInfo = struct {
    tri: u32,
    level: u32,
    stamp: u32 = 0,
    fails: u16 = 0,
};

const Item = struct {
    level: u32,
    class: u32,
    score: f64,
    seq: u64,
    a: u32,
    b: u32,
    stamp: u32,
};

fn itemCmp(_: void, x: Item, y: Item) std.math.Order {
    if (x.level != y.level) return std.math.order(x.level, y.level);
    if (x.class != y.class) return std.math.order(x.class, y.class);
    if (x.score != y.score) return std.math.order(x.score, y.score);
    return std.math.order(x.seq, y.seq);
}

pub const Options = struct {
    /// Adjacent front edge is used as side edge when the angle is below this.
    side_angle: f64 = 145.0 * pi / 180.0,
    /// Existing triangle edges within this deviation of the bisector are used as side edges.
    bisector_tol: f64 = pi / 6.0,
    max_fails: u16 = 6,
    /// Quads below this scaled Jacobian are not formed by the front.
    min_quad_sj: f64 = 0.35,
    /// Adjacent front edges meeting at less than this angle are merged (seam).
    seam_angle: f64 = 30.0 * pi / 180.0,
    /// Front angles above this get a row corner when the front edges are long.
    wedge_angle: f64 = 210.0 * pi / 180.0,
    /// Front angles above this always get a row corner.
    corner_angle: f64 = 240.0 * pi / 180.0,
    smooth: bool = true,
    /// Stop after this many processed front edges (debugging; 0 = unlimited).
    max_steps: usize = 0,
};

pub const Stats = struct {
    quads: usize = 0,
    closures: usize = 0,
    splits: usize = 0,
    swaps: usize = 0,
    failures: usize = 0,
    seams: usize = 0,
    leftover_tris: usize = 0,
    inserts: usize = 0,
    removed: usize = 0,
    closes: usize = 0,
    fail_side: usize = 0,
    fail_tips: usize = 0,
    fail_shape: usize = 0,
    fail_parity: usize = 0,
    fail_top: usize = 0,
    fail_fill: usize = 0,
};

pub const QMorph = struct {
    gpa: Allocator,
    m: *Mesh,
    field: *const sizefield.SizeField,
    opts: Options,
    quads: std.ArrayList([4]u32) = .empty,
    qalive: std.ArrayList(bool) = .empty,
    node_quads: std.ArrayList(std.ArrayList(u32)) = .empty,
    front: std.AutoHashMap(u64, FrontInfo),
    front_out: std.ArrayList(std.ArrayList(u32)) = .empty,
    pq: std.PriorityQueue(Item, void, itemCmp),
    seq: u64 = 0,
    stats: Stats = .{},
    split_budget: usize = 0,
    /// Side-edge length chosen by the last sideEdge call (after look-ahead).
    last_want: f64 = 0,
    // scratch
    s_tris: std.ArrayList(u32) = .empty,
    s_tris2: std.ArrayList(u32) = .empty,
    s_nodes: std.ArrayList(u32) = .empty,
    s_edges: std.ArrayList([2]u32) = .empty,

    pub fn init(gpa: Allocator, m: *Mesh, field: *const sizefield.SizeField, opts: Options) !QMorph {
        var q = QMorph{
            .gpa = gpa,
            .m = m,
            .field = field,
            .opts = opts,
            .front = std.AutoHashMap(u64, FrontInfo).init(gpa),
            .pq = std.PriorityQueue(Item, void, itemCmp).initContext({}),
        };
        try q.ensureNodes();
        return q;
    }

    pub fn deinit(self: *QMorph) void {
        const g = self.gpa;
        self.quads.deinit(g);
        self.qalive.deinit(g);
        for (self.node_quads.items) |*l| l.deinit(g);
        self.node_quads.deinit(g);
        for (self.front_out.items) |*l| l.deinit(g);
        self.front_out.deinit(g);
        self.front.deinit();
        self.pq.deinit(g);
        self.s_tris.deinit(g);
        self.s_tris2.deinit(g);
        self.s_nodes.deinit(g);
        self.s_edges.deinit(g);
    }

    fn ensureNodes(self: *QMorph) !void {
        const n = self.m.pts.items.len;
        while (self.node_quads.items.len < n) try self.node_quads.append(self.gpa, .empty);
        while (self.front_out.items.len < n) try self.front_out.append(self.gpa, .empty);
    }

    fn hook(ctx: *anyopaque, t: u32) void {
        const self: *QMorph = @ptrCast(@alignCast(ctx));
        const tv = self.m.tv.items[t];
        for (0..3) |i| {
            if (self.m.tn.items[t][i] != NONE) continue;
            const a = tv[next3(i)];
            const b = tv[prev3(i)];
            if (self.front.getPtr(dkey(a, b))) |fi| fi.tri = t;
        }
    }

    // ------------------------------------------------------------------
    // Front bookkeeping

    fn addFront(self: *QMorph, a: u32, b: u32, t: u32, level: u32) !void {
        const gop = try self.front.getOrPut(dkey(a, b));
        if (!gop.found_existing) {
            gop.value_ptr.* = .{ .tri = t, .level = level };
            try self.front_out.items[a].append(self.gpa, b);
        } else {
            gop.value_ptr.tri = t;
        }
    }

    fn removeFront(self: *QMorph, a: u32, b: u32) void {
        if (self.front.remove(dkey(a, b))) {
            const l = &self.front_out.items[a];
            for (l.items, 0..) |x, k| if (x == b) {
                _ = l.orderedRemove(k);
                break;
            };
        }
    }

    pub fn isFront(self: *const QMorph, a: u32, b: u32) bool {
        return self.front.contains(dkey(a, b));
    }

    fn frontTri(self: *const QMorph, a: u32, b: u32) ?u32 {
        const fi = self.front.get(dkey(a, b)) orelse return null;
        return fi.tri;
    }

    inline fn onFront(self: *const QMorph, v: u32) bool {
        return self.front_out.items[v].items.len > 0;
    }

    const Adj = struct { v: u32, t: u32 };

    /// Next front edge b -> n after a -> b (t is the triangle left of a -> b).
    fn nextFront(self: *const QMorph, b: u32, t_start: u32) ?Adj {
        var cur = t_start;
        var guard: usize = 0;
        while (guard < 512) : (guard += 1) {
            const ib = self.m.vertIndex(cur, b) orelse return null;
            const e = prev3(ib); // edge (b, v[ib+1])
            const u = self.m.tn.items[cur][e];
            if (u == NONE) return .{ .v = self.m.tv.items[cur][next3(ib)], .t = cur };
            cur = u;
        }
        return null;
    }

    /// Previous front edge p -> a before a -> b (t is the triangle left of a -> b).
    fn prevFront(self: *const QMorph, a: u32, t_start: u32) ?Adj {
        var cur = t_start;
        var guard: usize = 0;
        while (guard < 512) : (guard += 1) {
            const ia = self.m.vertIndex(cur, a) orelse return null;
            const e = next3(ia); // edge (v[ia+2], a)
            const u = self.m.tn.items[cur][e];
            if (u == NONE) return .{ .v = self.m.tv.items[cur][prev3(ia)], .t = cur };
            cur = u;
        }
        return null;
    }

    fn P(self: *const QMorph, v: u32) Vec2 {
        return self.m.pts.items[v];
    }

    /// Interior angle at node a between front edges a -> b and p -> a (region on the left).
    /// p == b happens at the free end of a curve, where the front turns around the slit tip.
    fn angleAt(self: *const QMorph, p: u32, a: u32, b: u32) f64 {
        if (p == b) return 2.0 * pi;
        return geom.ccwAngle(self.P(b).sub(self.P(a)), self.P(p).sub(self.P(a)));
    }

    fn classify(self: *QMorph, a: u32, b: u32) !void {
        const fi = self.front.getPtr(dkey(a, b)) orelse return;
        const t = fi.tri;
        const pe = self.prevFront(a, t) orelse return;
        const ne = self.nextFront(b, t) orelse return;
        const ta = self.angleAt(pe.v, a, b);
        const tb = self.angleAt(a, b, ne.v);
        var class: u32 = 2;
        if (ta < self.opts.side_angle) class -= 1;
        if (tb < self.opts.side_angle) class -= 1;
        // Seam candidates (small angle at a) go first.
        if (ta < self.opts.seam_angle) class = 0;
        fi.stamp +%= 1;
        if (fi.fails >= self.opts.max_fails) return;
        self.seq += 1;
        try self.pq.push(self.gpa, .{
            .level = fi.level,
            .class = class + 4 * @as(u32, fi.fails),
            .score = @min(ta, tb),
            .seq = self.seq,
            .a = a,
            .b = b,
            .stamp = fi.stamp,
        });
    }

    /// Re-classifies front edges incident to v and their neighbors.
    fn touch(self: *QMorph, v: u32) !void {
        if (v >= self.front_out.items.len) return;
        self.s_edges.clearRetainingCapacity();
        for (self.front_out.items[v].items) |w| {
            const t = self.frontTri(v, w) orelse continue;
            try self.s_edges.append(self.gpa, .{ v, w });
            if (self.prevFront(v, t)) |pe| {
                try self.s_edges.append(self.gpa, .{ pe.v, v });
                if (self.frontTri(pe.v, v)) |tp| if (self.prevFront(pe.v, tp)) |pp| try self.s_edges.append(self.gpa, .{ pp.v, pe.v });
            }
            if (self.nextFront(w, t)) |ne| try self.s_edges.append(self.gpa, .{ w, ne.v });
        }
        var k: usize = 0;
        while (k < self.s_edges.items.len) : (k += 1) {
            const e = self.s_edges.items[k];
            if (self.front.getPtr(dkey(e[0], e[1]))) |fi| fi.fails = 0;
            try self.classify(e[0], e[1]);
        }
    }

    // ------------------------------------------------------------------
    // Node neighborhoods

    /// All alive triangles incident to v.
    fn nodeTris(self: *QMorph, v: u32, out: *std.ArrayList(u32)) !bool {
        out.clearRetainingCapacity();
        if (self.onFront(v)) {
            for (self.front_out.items[v].items) |w| {
                var cur = self.frontTri(v, w) orelse return false;
                var guard: usize = 0;
                while (guard < 512) : (guard += 1) {
                    try out.append(self.gpa, cur);
                    const iv = self.m.vertIndex(cur, v) orelse return false;
                    const u = self.m.tn.items[cur][next3(iv)];
                    if (u == NONE) break;
                    cur = u;
                }
            }
            return true;
        }
        const t = self.m.vtri.items[v];
        if (t == NONE) return true; // only quads around v
        if (!self.m.talive.items[t] or self.m.vertIndex(t, v) == null) return false;
        return try self.m.fan(v, t, self.gpa, out);
    }

    /// Moves v to q if every incident triangle and quad stays valid. Fixed nodes never move.
    fn safeMove(self: *QMorph, v: u32, q: Vec2) !bool {
        if (self.m.isFixed(v)) return false;
        if (!std.math.isFinite(q.x) or !std.math.isFinite(q.y)) return false;
        if (!try self.nodeTris(v, &self.s_tris2)) return false;
        const old = self.m.pts.items[v];
        self.m.pts.items[v] = q;
        var ok = true;
        for (self.s_tris2.items) |t| {
            if (self.m.orientTri(t) <= 0) {
                ok = false;
                break;
            }
        }
        if (ok) {
            for (self.node_quads.items[v].items) |qi| {
                if (!self.quadValid(qi)) {
                    ok = false;
                    break;
                }
            }
        }
        if (!ok) self.m.pts.items[v] = old;
        return ok;
    }

    pub fn addQuad(self: *QMorph, q: [4]u32) !void {
        try self.ensureNodes();
        const qi: u32 = @intCast(self.quads.items.len);
        try self.quads.append(self.gpa, q);
        try self.qalive.append(self.gpa, true);
        for (q) |v| try self.node_quads.items[v].append(self.gpa, qi);
    }

    fn quadPts(self: *const QMorph, qi: u32) [4]Vec2 {
        const q = self.quads.items[qi];
        return .{ self.P(q[0]), self.P(q[1]), self.P(q[2]), self.P(q[3]) };
    }

    fn quadValid(self: *const QMorph, qi: u32) bool {
        return geom.quadConvex(self.quadPts(qi));
    }

    // ------------------------------------------------------------------
    // Side edges

    const WedgeDir = enum { ccw, cw };

    /// Finds or creates a side edge from v into the wedge that starts at triangle t_start
    /// (the triangle left of the current front edge) and rotates in `dir` around v.
    /// `u_dir` is the start ray of the wedge (counterclockwise reference) and theta the
    /// wedge angle. Returns the tip node.
    const RayHit = struct { dist: f64, x: u32, y: u32 };

    /// Casts a ray from node v along dir through the unmeshed triangles (starting in t,
    /// which contains the ray direction at v) and returns where it first meets the front.
    fn rayToFront(self: *const QMorph, v: u32, t: u32, dir: Vec2, maxd: f64) ?RayHit {
        const p0 = self.P(v);
        const p1 = p0.add(dir.scale(maxd));
        var cur = t;
        var ex = self.m.vertIndex(cur, v) orelse return null;
        var guard: usize = 0;
        while (guard < 256) : (guard += 1) {
            const tv = self.m.tv.items[cur];
            const x = tv[next3(ex)];
            const y = tv[prev3(ex)];
            const px = self.P(x);
            const py = self.P(y);
            // Ray parameter of the crossing with segment x-y.
            const d = py.sub(px);
            const den = dir.cross(d);
            if (@abs(den) < 1e-300) return null;
            const s = px.sub(p0).cross(d) / den;
            if (s > maxd) return null;
            const u = self.m.tn.items[cur][ex];
            if (u == NONE) return .{ .dist = s, .x = x, .y = y };
            const j = self.m.edgeIndex(u, y, x) orelse return null;
            const w = self.m.tv.items[u][j];
            const ox = geom.orient(p0, p1, px);
            const ow = geom.orient(p0, p1, self.P(w));
            // Exit through the edge of u joining w to the endpoint on the other side of the ray.
            const other = if ((ow > 0) == (ox > 0)) y else x;
            cur = u;
            ex = self.m.edgeIndex(u, w, other) orelse self.m.edgeIndex(u, other, w) orelse return null;
        }
        return null;
    }

    fn sideEdge(self: *QMorph, v: u32, t_start: u32, dir: WedgeDir, tip_dir: Vec2, want_in: f64, forbid: u32) !?u32 {
        const pv = self.P(v);
        const bis = tip_dir;
        var want_len = want_in;
        // Look ahead: if another front is near, close the gap evenly instead of leaving a thin row.
        {
            var cur0 = t_start;
            var g0: usize = 0;
            var hit0: u32 = NONE;
            while (g0 < 512) : (g0 += 1) {
                const iv = self.m.vertIndex(cur0, v) orelse break;
                const tv = self.m.tv.items[cur0];
                const r1 = self.P(tv[next3(iv)]).sub(pv);
                const r2 = self.P(tv[prev3(iv)]).sub(pv);
                if (r1.cross(bis) >= 0 and bis.cross(r2) >= 0) {
                    hit0 = cur0;
                    break;
                }
                const e: usize = if (dir == .ccw) next3(iv) else prev3(iv);
                const u = self.m.tn.items[cur0][e];
                if (u == NONE) break;
                cur0 = u;
            }
            if (hit0 != NONE) {
                if (self.rayToFront(v, hit0, bis, 2.4 * want_in)) |hit| {
                    if (hit.dist < 1.35 * want_in) {
                        // Connect to the nearer end of the front edge ahead.
                        const hp = pv.add(bis.scale(hit.dist));
                        const x = if (self.P(hit.x).dist(hp) <= self.P(hit.y).dist(hp)) hit.x else hit.y;
                        const dev = geom.angleBetween(self.P(x).sub(pv), bis);
                        if (x != forbid and x != v and dev < 0.3 * pi) {
                            if (self.findEdgeTri(v, x) != null or try self.recoverTop(v, x)) {
                                self.stats.closes += 1;
                                return x;
                            }
                        }
                    } else if (hit.dist < 2.4 * want_in) {
                        want_len = 0.5 * hit.dist;
                    }
                }
            }
        }
        self.last_want = want_len;
        const ideal = pv.add(bis.scale(want_len));
        // Walk the wedge, collecting interior edges (v, x).
        var best_x: u32 = NONE;
        var best_dev: f64 = std.math.inf(f64);
        var best_t: u32 = NONE;
        var best_e: usize = 0;
        var good_x: u32 = NONE; // aligned edge of about the wanted length
        var good_score: f64 = std.math.inf(f64);
        var front_x: u32 = NONE; // aligned edge to another part of the front
        var front_score: f64 = std.math.inf(f64);
        var hit_t: u32 = NONE; // wedge triangle containing the bisector
        var cur = t_start;
        var guard: usize = 0;
        while (guard < 512) : (guard += 1) {
            const iv = self.m.vertIndex(cur, v) orelse return null;
            const tv = self.m.tv.items[cur];
            // Angular span of cur at v (counterclockwise): from tv[iv+1] to tv[iv+2].
            const r1 = self.P(tv[next3(iv)]).sub(pv);
            const r2 = self.P(tv[prev3(iv)]).sub(pv);
            if (hit_t == NONE and r1.cross(bis) >= 0 and bis.cross(r2) >= 0) hit_t = cur;
            const e: usize = if (dir == .ccw) next3(iv) else prev3(iv);
            const x = if (dir == .ccw) tv[prev3(iv)] else tv[next3(iv)];
            const u = self.m.tn.items[cur][e];
            if (u == NONE) break;
            if (x != forbid) {
                const dx = self.P(x).sub(pv);
                const dev = geom.angleBetween(dx, bis);
                if (dev < best_dev) {
                    best_dev = dev;
                    best_x = x;
                    best_t = cur;
                    best_e = e;
                }
                const lr = dx.len() / want_len;
                if (self.onFront(x) or self.m.isFixed(x)) {
                    // Another front close to where the tip belongs: the fronts meet here.
                    const sc = self.P(x).dist(ideal) / want_len;
                    if (dev < self.opts.bisector_tol and lr < 1.6 and sc < 0.65 and sc < front_score) {
                        front_score = sc;
                        front_x = x;
                    }
                } else {
                    // Interior node: only if it is already close to the ideal tip.
                    const sc = self.P(x).dist(ideal) / want_len;
                    if (sc < 0.3 and sc < good_score) {
                        good_score = sc;
                        good_x = x;
                    }
                }
            }
            cur = u;
        }
        // 1. Another part of the front right where the tip belongs: connect to it.
        if (front_x != NONE and front_score < good_score + 0.25) return front_x;
        // 2. An existing interior node close to the ideal tip: use it and move it there.
        if (good_x != NONE) {
            if (self.opts.smooth) {
                const cp = self.P(good_x);
                var w: f64 = 1.0;
                while (w > 0.1) : (w *= 0.5) {
                    if (try self.safeMove(good_x, cp.lerp(ideal, w))) break;
                }
            }
            return good_x;
        }
        // 3. Insert a new node at the ideal tip and recover the side edge.
        if (hit_t != NONE) {
            if (try self.insertTip(v, hit_t, ideal, want_len)) |m| return m;
        }
        if (best_x != NONE and best_dev < self.opts.bisector_tol) {
            return try self.adjustLength(v, best_x, best_t, best_e, want_len);
        }
        // Swap the edge opposite v in the triangle containing the bisector.
        if (hit_t != NONE) {
            const iv = self.m.vertIndex(hit_t, v).?;
            const tv = self.m.tv.items[hit_t];
            const y = tv[next3(iv)];
            const z = tv[prev3(iv)];
            if (self.m.tn.items[hit_t][iv] != NONE and !self.m.isCons(hit_t, iv)) {
                if (self.m.canFlip(hit_t, iv)) {
                    const r = self.m.flip(hit_t, iv);
                    self.stats.swaps += 1;
                    // New edge (v, w): t' = (v, y, w) in r[0] as (c, a, d) with c = v.
                    const w = self.m.tv.items[r[0]][2];
                    const dev = geom.angleBetween(self.P(w).sub(pv), bis);
                    if (dev < self.opts.bisector_tol and w != forbid) {
                        const e = self.m.edgeIndex(r[0], w, v).?; // edge (w, v) in (v, y, w)
                        return try self.adjustLength(v, w, r[0], e, want_len);
                    }
                    // Undo: flip the new edge back.
                    if (self.m.edgeIndex(r[0], w, v)) |e| {
                        if (self.m.canFlip(r[0], e)) _ = self.m.flip(r[0], e);
                    }
                }
                // Split (y, z) where the bisector crosses it.
                const ft = self.findEdgeTri(y, z) orelse return null;
                const py = self.P(y);
                const pz = self.P(z);
                const d = pz.sub(py);
                const den = bis.cross(d);
                if (@abs(den) > 1e-300) {
                    var s = py.sub(pv).cross(bis) / den; // param on y->z
                    s = std.math.clamp(s, 0.15, 0.85);
                    const q = py.add(d.scale(s));
                    const m = try self.splitAt(ft.t, ft.i, q);
                    if (m) |mm| {
                        // Move toward the ideal position along the bisector.
                        if (pv.dist(q) > 1.2 * want_len) _ = try self.safeMove(mm, ideal);
                        return mm;
                    }
                }
                return null;
            }
            // The opposite edge is on the front: use the closer existing edge if acceptable.
        }
        if (best_x != NONE and best_dev < pi / 3.0) return best_x;
        return null;
    }

    /// Inserts a node at q (inside the unmeshed region, away from the front) and makes
    /// (v, new node) an edge. Returns the new node or null.
    fn insertTip(self: *QMorph, v: u32, t_hint: u32, q: Vec2, want_len: f64) !?u32 {
        const loc = self.m.locate(q, t_hint);
        if (loc.outside) return null;
        // Stay away from the front: no front edge or front node close to q.
        const lim = 0.45 * want_len;
        var check = [4]u32{ loc.t, self.m.tn.items[loc.t][0], self.m.tn.items[loc.t][1], self.m.tn.items[loc.t][2] };
        for (&check) |t| {
            if (t == NONE) continue;
            const tv = self.m.tv.items[t];
            for (0..3) |i| {
                const x = tv[i];
                if (x != v and (self.onFront(x) or self.m.isFixed(x)) and self.P(x).dist(q) < lim) return null;
                if (self.m.tn.items[t][i] == NONE) {
                    const a = tv[next3(i)];
                    const b = tv[prev3(i)];
                    if (a != v and b != v and geom.pointSegmentDist(q, self.P(a), self.P(b)) < lim) return null;
                }
            }
        }
        var cavity: std.ArrayList(u32) = .empty;
        defer cavity.deinit(self.gpa);
        var bnd: std.ArrayList(Mesh.BEdge) = .empty;
        defer bnd.deinit(self.gpa);
        const m = (try self.m.insertBW(q, loc.t, 0, &cavity, &bnd)) orelse return null;
        try self.ensureNodes();
        self.stats.inserts += 1;
        if (!try self.recoverTop(v, m)) return null;
        return m;
    }

    fn findEdgeTri(self: *QMorph, a: u32, b: u32) ?struct { t: u32, i: usize } {
        if (!(self.nodeTris(a, &self.s_tris2) catch return null)) return null;
        for (self.s_tris2.items) |t| {
            if (self.m.edgeIndex(t, a, b)) |i| return .{ .t = t, .i = i };
            if (self.m.edgeIndex(t, b, a)) |i| return .{ .t = t, .i = i };
        }
        return null;
    }

    fn splitAt(self: *QMorph, t: u32, i: usize, q: Vec2) !?u32 {
        const u = self.m.tn.items[t][i];
        if (u == NONE or self.m.isCons(t, i)) return null;
        if (self.stats.splits >= self.split_budget) return null;
        // The four triangles around the new node must be counterclockwise.
        const tv = self.m.tv.items[t];
        const pc = self.P(tv[i]);
        const pa = self.P(tv[next3(i)]);
        const pb = self.P(tv[prev3(i)]);
        // Never create pieces much smaller than the local size.
        const hloc = self.field.eval(q);
        if (pa.dist(q) < 0.3 * hloc or pb.dist(q) < 0.3 * hloc) return null;
        const j = self.m.edgeIndex(u, tv[prev3(i)], tv[next3(i)]) orelse return null;
        const pd = self.P(self.m.tv.items[u][j]);
        if (geom.orient(pc, pa, q) <= 0 or geom.orient(pc, q, pb) <= 0 or geom.orient(pd, pb, q) <= 0 or geom.orient(pd, q, pa) <= 0) return null;
        const m = try self.m.splitEdge(t, i, q);
        try self.ensureNodes();
        self.stats.splits += 1;
        return m;
    }

    /// If the side edge (v, x) is much longer than wanted, split it at the wanted length.
    fn adjustLength(self: *QMorph, v: u32, x: u32, t: u32, e: usize, want_len: f64) !?u32 {
        const l = self.P(v).dist(self.P(x));
        if (l > 1.7 * want_len and self.m.tn.items[t][e] != NONE) {
            const q = self.P(v).lerp(self.P(x), want_len / l);
            if (try self.splitAt(t, e, q)) |m| return m;
        }
        return x;
    }

    // ------------------------------------------------------------------
    // Top edge recovery

    /// Makes (d, c) an edge of the triangulation by flipping crossing edges. Fails when the
    /// segment crosses the front or passes through a node.
    fn recoverTop(self: *QMorph, d: u32, c: u32) !bool {
        if (self.findEdgeTri(d, c) != null) return true;
        const pd = self.P(d);
        const pc = self.P(c);
        if (!try self.nodeTris(d, &self.s_tris)) return false;
        // Triangle at d whose opposite edge the segment crosses.
        var start: u32 = NONE;
        var si: usize = 0;
        for (self.s_tris.items) |t| {
            const id = self.m.vertIndex(t, d).?;
            const tv = self.m.tv.items[t];
            const ox = geom.orient(pd, pc, self.P(tv[next3(id)]));
            const oy = geom.orient(pd, pc, self.P(tv[prev3(id)]));
            if (ox < 0 and oy > 0) {
                start = t;
                si = id;
                break;
            }
        }
        if (start == NONE) return false;
        self.s_edges.clearRetainingCapacity();
        var t = start;
        var i = si;
        var guard: usize = 0;
        while (guard < 256) : (guard += 1) {
            const tv = self.m.tv.items[t];
            const x = tv[next3(i)];
            const y = tv[prev3(i)];
            const u = self.m.tn.items[t][i];
            if (u == NONE or self.m.isCons(t, i)) return false;
            try self.s_edges.append(self.gpa, .{ x, y });
            const j = self.m.edgeIndex(u, y, x) orelse return false;
            const w = self.m.tv.items[u][j];
            if (w == c) break;
            const ow = geom.orient(pd, pc, self.P(w));
            if (ow == 0) return false;
            t = u;
            i = if (ow > 0) self.m.edgeIndex(u, x, w).? else self.m.edgeIndex(u, w, y).?;
        } else return false;
        var qi: usize = 0;
        var iter: usize = 0;
        while (qi < self.s_edges.items.len) : (iter += 1) {
            if (iter > 2000) return false;
            const e = self.s_edges.items[qi];
            qi += 1;
            const f = self.findEdgeTri(e[0], e[1]) orelse continue;
            if (!self.m.canFlip(f.t, f.i)) {
                try self.s_edges.append(self.gpa, e);
                continue;
            }
            const r = self.m.flip(f.t, f.i);
            self.stats.swaps += 1;
            const nc = self.m.tv.items[r[0]][0];
            const nd = self.m.tv.items[r[0]][2];
            if (geom.segmentsCross(pd, pc, self.P(nc), self.P(nd))) try self.s_edges.append(self.gpa, .{ nc, nd });
        }
        return self.findEdgeTri(d, c) != null;
    }

    // ------------------------------------------------------------------
    // Quad formation

    const Fill = struct {
        tris: std.ArrayList(u32) = .empty,
        /// Quad boundary edges as seen from inside: (inner tri, edge index).
        rim: std.ArrayList([2]u32) = .empty,
        inner_nodes: std.ArrayList(u32) = .empty,
        fn deinit(f: *Fill, g: Allocator) void {
            f.tris.deinit(g);
            f.rim.deinit(g);
            f.inner_nodes.deinit(g);
        }
    };

    /// Collects the triangles inside the polygon `poly` (CCW node cycle) starting from t0.
    fn floodPolygon(self: *QMorph, t0: u32, poly: []const u32, fill: *Fill, limit: usize) !bool {
        fill.tris.clearRetainingCapacity();
        fill.rim.clearRetainingCapacity();
        fill.inner_nodes.clearRetainingCapacity();
        const mark = self.m.newMark();
        self.m.tmark.items[t0] = mark;
        try fill.tris.append(self.gpa, t0);
        var k: usize = 0;
        while (k < fill.tris.items.len) : (k += 1) {
            if (fill.tris.items.len > limit) return false;
            const t = fill.tris.items[k];
            const tv = self.m.tv.items[t];
            for (0..3) |i| {
                const x = tv[next3(i)];
                const y = tv[prev3(i)];
                if (polyHasEdge(poly, x, y)) {
                    try fill.rim.append(self.gpa, .{ t, @intCast(i) });
                    continue;
                }
                const u = self.m.tn.items[t][i];
                if (u == NONE) return false;
                if (self.m.tmark.items[u] == mark) continue;
                self.m.tmark.items[u] = mark;
                try fill.tris.append(self.gpa, u);
            }
        }
        if (fill.rim.items.len != poly.len) return false;
        // Inner nodes.
        for (fill.tris.items) |t| {
            for (self.m.tv.items[t]) |v| {
                if (std.mem.indexOfScalar(u32, poly, v) != null) continue;
                if (std.mem.indexOfScalar(u32, fill.inner_nodes.items, v) != null) continue;
                if (self.m.isFixed(v)) return false;
                try fill.inner_nodes.append(self.gpa, v);
            }
        }
        return true;
    }

    fn polyHasEdge(poly: []const u32, x: u32, y: u32) bool {
        const n = poly.len;
        for (0..n) |i| {
            const a = poly[i];
            const b = poly[(i + 1) % n];
            if (a == x and b == y) return true;
        }
        return false;
    }

    /// Replaces the filled triangles by quads. `qs` are CCW quads covering the polygon;
    /// `new_nodes` are interior nodes already added to the mesh for templates.
    fn commit(self: *QMorph, fill: *Fill, qs: []const [4]u32, level: u32) !void {
        try self.m.reserveKills(fill.tris.items.len);
        // Rim: update outer neighbors / front.
        for (fill.rim.items) |r| {
            const t = r[0];
            const i: usize = r[1];
            const tv = self.m.tv.items[t];
            const x = tv[next3(i)];
            const y = tv[prev3(i)];
            const u = self.m.tn.items[t][i];
            if (u == NONE) {
                self.removeFront(x, y);
            } else {
                const j = self.m.edgeIndex(u, y, x).?;
                self.m.tn.items[u][j] = NONE;
                self.m.setCons(u, j, false);
                try self.addFront(y, x, u, level + 1);
                self.m.vtri.items[y] = u;
                self.m.vtri.items[x] = u;
            }
        }
        for (fill.tris.items) |t| try self.m.killTri(t);
        for (fill.inner_nodes.items) |v| {
            self.m.nflags.items[v] |= tm.NodeFlags.deleted;
            self.m.vtri.items[v] = NONE;
        }
        for (qs) |q| {
            const qi: u32 = @intCast(self.quads.items.len);
            try self.quads.append(self.gpa, q);
            try self.qalive.append(self.gpa, true);
            for (q) |v| try self.node_quads.items[v].append(self.gpa, qi);
            self.stats.quads += 1;
        }
        // Repair vertex seeds of the polygon nodes.
        for (fill.rim.items) |r| {
            const tv = self.m.tv.items[r[0]];
            for ([_]u32{ tv[next3(r[1])], tv[prev3(r[1])] }) |v| {
                const s = self.m.vtri.items[v];
                if (s != NONE and self.m.talive.items[s] and self.m.vertIndex(s, v) != null) continue;
                self.m.vtri.items[v] = NONE;
                for (self.front_out.items[v].items) |w| {
                    if (self.frontTri(v, w)) |ft| {
                        self.m.vtri.items[v] = ft;
                        break;
                    }
                }
            }
        }
    }

    /// Parity check for front splits. After the fill triangles are removed, every connected
    /// unmeshed region must still have an even number of front edges. The regions around the
    /// new quad are explored by alternating breadth-first searches, which stop as soon as all
    /// but one region are known (the last one's parity follows from the others).
    fn componentParityOk(self: *QMorph, fill: *const Fill) !bool {
        const base = self.m.newMark();
        // Reserve stamps base+1 .. base+4 for up to four seeds.
        self.m.mark_stamp +%= 5;
        if (self.m.mark_stamp < base) return true; // wrapped: skip the check (rare)
        for (fill.tris.items) |t| self.m.tmark.items[t] = base;
        var seeds: [8]u32 = undefined;
        var ns: usize = 0;
        for (fill.rim.items) |r| {
            const u = self.m.tn.items[r[0]][r[1]];
            if (u == NONE or self.m.tmark.items[u] == base) continue;
            if (std.mem.indexOfScalar(u32, seeds[0..ns], u) != null) continue;
            if (ns == 4) break;
            seeds[ns] = u;
            ns += 1;
        }
        if (ns <= 1) return true;
        var queues: [4]std.ArrayList(u32) = .{ .empty, .empty, .empty, .empty };
        defer for (&queues) |*q| q.deinit(self.gpa);
        var heads = [4]usize{ 0, 0, 0, 0 };
        var counts = [4]usize{ 0, 0, 0, 0 };
        var group = [4]usize{ 0, 1, 2, 3 };
        for (0..ns) |i| {
            self.m.tmark.items[seeds[i]] = base + 1 + @as(u32, @intCast(i));
            try queues[i].append(self.gpa, seeds[i]);
        }
        const find = struct {
            fn f(g: *[4]usize, x: usize) usize {
                var y = x;
                while (g[y] != y) y = g[y];
                return y;
            }
        }.f;
        var finished = [4]bool{ false, false, false, false };
        var guard: usize = 0;
        while (guard < 4_000_000) : (guard += 1) {
            // Groups still open.
            var open_groups: usize = 0;
            var any_progress = false;
            for (0..ns) |gi| {
                if (find(&group, gi) != gi or finished[gi]) continue;
                open_groups += 1;
            }
            if (open_groups <= 1) return true;
            for (0..ns) |i| {
                const gi = find(&group, i);
                if (finished[gi]) continue;
                if (heads[i] >= queues[i].items.len) continue;
                any_progress = true;
                const t = queues[i].items[heads[i]];
                heads[i] += 1;
                for (0..3) |e| {
                    const u = self.m.tn.items[t][e];
                    if (u == NONE) {
                        counts[i] += 1;
                        continue;
                    }
                    const mk = self.m.tmark.items[u];
                    if (mk == base) {
                        counts[i] += 1; // becomes a front edge
                        continue;
                    }
                    if (mk > base and mk <= base + 4) {
                        const j: usize = mk - base - 1;
                        const gj = find(&group, j);
                        const gi2 = find(&group, i);
                        if (gj != gi2) group[gj] = gi2;
                        continue;
                    }
                    self.m.tmark.items[u] = base + 1 + @as(u32, @intCast(i));
                    try queues[i].append(self.gpa, u);
                }
            }
            // Groups whose queues are all exhausted are complete.
            for (0..ns) |gi| {
                if (find(&group, gi) != gi or finished[gi]) continue;
                var done = true;
                var total: usize = 0;
                for (0..ns) |i| {
                    if (find(&group, i) != gi) continue;
                    if (heads[i] < queues[i].items.len) done = false;
                    total += counts[i];
                }
                if (done) {
                    if (total % 2 != 0) return false;
                    finished[gi] = true;
                }
            }
            if (!any_progress) return true;
        }
        return true;
    }

    fn tryQuad(self: *QMorph, a: u32, b: u32, level: u32) !bool {
        const t0 = self.frontTri(a, b) orelse return false;
        const pe = self.prevFront(a, t0) orelse return false;
        const ne = self.nextFront(b, t0) orelse return false;
        const p = pe.v;
        const n = ne.v;
        const pa = self.P(a);
        const pb = self.P(b);
        const ta = self.angleAt(p, a, b);
        const tb = self.angleAt(a, b, n);
        const lab = pa.dist(pb);
        // Left side at a.
        var d: u32 = undefined;
        var dir_a = Vec2.init(0, 0);
        var want_a: f64 = 0;
        if (ta < self.opts.side_angle and p != n) {
            d = p;
        } else {
            const flen = 0.5 * (lab + pa.dist(self.P(p)));
            // Row corner (wedge): a large angle with long edges gets three quads in this row.
            const frac: f64 = if (self.isWedge(a, ta, flen)) 1.0 / 3.0 else 0.5;
            dir_a = tipDir(pb.sub(pa), self.P(p).sub(pa), frac, p == b);
            want_a = self.wantLength(a, flen, dir_a);
            d = (try self.sideEdge(a, t0, .ccw, dir_a, want_a, b)) orelse {
                self.stats.fail_side += 1;
                return false;
            };
            want_a = self.last_want;
        }
        // Right side at b (the triangle left of a->b may have changed).
        const t1 = self.frontTri(a, b) orelse return false;
        var c: u32 = undefined;
        var dir_b = Vec2.init(0, 0);
        var want_b: f64 = 0;
        if (tb < self.opts.side_angle and n != p) {
            c = n;
        } else {
            const flen = 0.5 * (lab + pb.dist(self.P(n)));
            const frac: f64 = if (self.isWedge(b, tb, flen)) 2.0 / 3.0 else 0.5;
            dir_b = tipDir(self.P(n).sub(pb), pa.sub(pb), frac, n == a);
            want_b = self.wantLength(b, flen, dir_b);
            c = (try self.sideEdge(b, t1, .cw, dir_b, want_b, a)) orelse {
                self.stats.fail_side += 1;
                return false;
            };
            want_b = self.last_want;
        }
        if (c == d or c == a or d == b) {
            self.stats.fail_tips += 1;
            return false;
        }
        // Inserting the right tip may have removed the left side edge: recover it.
        if (self.findEdgeTri(a, d) == null and !try self.recoverTop(a, d)) {
            self.stats.fail_tips += 1;
            return false;
        }
        if (self.findEdgeTri(b, c) == null and !try self.recoverTop(b, c)) {
            self.stats.fail_tips += 1;
            return false;
        }
        // Place free interior tips well (side-edge length adjustment).
        if (self.opts.smooth) {
            if (want_a > 0) try self.placeTip(d, a, dir_a, want_a);
            if (want_b > 0) try self.placeTip(c, b, dir_b, want_b);
        }
        var quad = [4]u32{ a, b, c, d };
        if (!self.quadAcceptable(quad)) {
            self.stats.fail_shape += 1;
            return false;
        }
        if (!try self.recoverTop(d, c) or self.findEdgeTri(a, d) == null or self.findEdgeTri(b, c) == null) {
            self.stats.fail_top += 1;
            return false;
        }
        const t2 = self.frontTri(a, b) orelse return false;
        var fill = Fill{};
        defer fill.deinit(self.gpa);
        if (!try self.floodPolygon(t2, &quad, &fill, 400)) {
            self.stats.fail_fill += 1;
            return false;
        }
        // A quad touching the front away from p -> a -> b -> n may split a region.
        const touches = (self.onFront(d) and d != p) or (self.onFront(c) and c != n) or self.isFront(d, c) or self.isFront(c, d);
        if (touches and !try self.componentParityOk(&fill)) {
            self.stats.fail_parity += 1;
            return false;
        }
        try self.commit(&fill, &.{quad}, level);
        try self.cleanNearFront(&quad);
        if (self.opts.smooth) try self.smoothAround(&quad);
        try self.localDelaunay(&quad);
        for (quad) |v| try self.touch(v);
        return true;
    }

    /// Desired side-edge length at v: the size field half a row inward, kept within
    /// [0.7, 1.5] of the adjacent front edges so quads stay close to square.
    fn wantLength(self: *const QMorph, v: u32, front_len: f64, dir: Vec2) f64 {
        const h = self.field.eval(self.P(v).add(dir.scale(0.5 * front_len)));
        return std.math.clamp(h, 0.7 * front_len, 1.5 * front_len);
    }

    /// Paving's row corner: a large front angle whose edges are long for the local size
    /// gets two side edges (three quads around the node in this row), which adds one
    /// element to the next row.
    fn isWedge(self: *const QMorph, v: u32, theta: f64, front_len: f64) bool {
        if (theta >= self.opts.corner_angle) return true;
        if (theta < self.opts.wedge_angle) return false;
        return front_len > 1.3 * self.field.eval(self.P(v));
    }

    /// Unit vector at frac * (angle from start to end, counterclockwise) from start.
    /// `full`: the wedge is a whole turn (a free curve end), so start and end rays coincide.
    fn tipDir(start_ray: Vec2, end_ray: Vec2, frac: f64, full: bool) Vec2 {
        const us = start_ray.normalized();
        if (full) return geom.rotateDet(us, frac * 2.0 * pi).normalized();
        if (frac == 0.5) {
            var bis = us.perp().sub(end_ray.normalized().perp());
            if (bis.len2() == 0) bis = us.perp();
            return bis.normalized();
        }
        const theta = geom.ccwAngle(start_ray, end_ray);
        return geom.rotateDet(us, frac * theta).normalized();
    }

    /// Shape and size check for a quad about to be formed.
    fn quadAcceptable(self: *const QMorph, q: [4]u32) bool {
        const pq = [4]Vec2{ self.P(q[0]), self.P(q[1]), self.P(q[2]), self.P(q[3]) };
        if (!geom.quadConvex(pq)) return false;
        if (geom.quadScaledJacobian(pq) < self.opts.min_quad_sj) return false;
        const cen = pq[0].add(pq[1]).add(pq[2]).add(pq[3]).scale(0.25);
        const h = self.field.eval(cen);
        const area = geom.polygonArea(&pq);
        return area >= 0.06 * h * h;
    }

    /// Lawson flips in the unmeshed region around the given nodes.
    fn localDelaunay(self: *QMorph, nodes: []const u32) !void {
        var stack: std.ArrayList([2]u32) = .empty;
        defer stack.deinit(self.gpa);
        for (nodes) |v| {
            if (!try self.nodeTris(v, &self.s_tris)) continue;
            for (self.s_tris.items) |t| {
                const tv = self.m.tv.items[t];
                for (0..3) |i| {
                    if (self.m.tn.items[t][i] == NONE) continue;
                    try stack.append(self.gpa, .{ tv[next3(i)], tv[prev3(i)] });
                }
            }
        }
        var guard: usize = 0;
        while (stack.pop()) |e| {
            guard += 1;
            if (guard > 2000) break;
            const f = self.findEdgeTri(e[0], e[1]) orelse continue;
            const t = f.t;
            const i = f.i;
            const u = self.m.tn.items[t][i];
            if (u == NONE or self.m.isCons(t, i)) continue;
            const tv = self.m.tv.items[t];
            const j = self.m.edgeIndex(u, tv[prev3(i)], tv[next3(i)]) orelse continue;
            const dd = self.m.tv.items[u][j];
            const pp = self.m.triPoints(t);
            if (geom.inCircle(pp[0], pp[1], pp[2], self.P(dd)) <= 0) continue;
            if (!self.m.canFlip(t, i)) continue;
            const r = self.m.flip(t, i);
            const t1 = self.m.tv.items[r[0]];
            const t2 = self.m.tv.items[r[1]];
            try stack.append(self.gpa, .{ t1[1], t1[2] });
            try stack.append(self.gpa, .{ t1[0], t1[1] });
            try stack.append(self.gpa, .{ t2[1], t2[2] });
            try stack.append(self.gpa, .{ t2[0], t2[2] });
        }
    }

    /// Removes interior triangle nodes that ended up very close to the edges of a new quad;
    /// left in place they would produce a thin row later.
    fn cleanNearFront(self: *QMorph, quad: []const u32) !void {
        var cand: std.ArrayList(u32) = .empty;
        defer cand.deinit(self.gpa);
        for (quad) |v| {
            if (!try self.nodeTris(v, &self.s_tris)) continue;
            for (self.s_tris.items) |t| for (self.m.tv.items[t]) |x| {
                if (std.mem.indexOfScalar(u32, quad, x) != null) continue;
                if (self.m.isFixed(x) or self.onFront(x)) continue;
                if (std.mem.indexOfScalar(u32, cand.items, x) == null) try cand.append(self.gpa, x);
            };
        }
        for (cand.items) |x| {
            if (self.m.nflags.items[x] & tm.NodeFlags.deleted != 0) continue;
            var dmin: f64 = std.math.inf(f64);
            var lref: f64 = 0;
            for (0..quad.len) |k| {
                const a = self.P(quad[k]);
                const b = self.P(quad[(k + 1) % quad.len]);
                const d = geom.pointSegmentDist(self.P(x), a, b);
                if (d < dmin) {
                    dmin = d;
                    lref = a.dist(b);
                }
            }
            if (dmin < 0.4 * lref) {
                if (try self.m.removeVertex(x, &self.s_tris)) self.stats.removed += 1;
            }
        }
    }

    /// Moves a free interior tip toward base + want * bisector (keeps validity).
    fn placeTip(self: *QMorph, tip: u32, base: u32, dir: Vec2, want: f64) !void {
        if (self.m.isFixed(tip) or self.onFront(tip)) return;
        const target = self.P(base).add(dir.scale(want));
        const cur = self.P(tip);
        // Blend: move most of the way; retry with smaller steps if invalid.
        var w: f64 = 1.0;
        while (w > 0.1) : (w *= 0.5) {
            if (try self.safeMove(tip, cur.lerp(target, w))) return;
        }
    }

    /// Local smoothing of free front nodes of a new quad and nearby unmeshed nodes.
    fn smoothAround(self: *QMorph, quad: []const u32) !void {
        for (quad) |v| {
            if (self.m.isFixed(v)) continue;
            try self.smoothNode(v);
        }
    }

    /// Isoparametric smoothing over quads blended with Laplacian over triangle neighbors.
    fn smoothNode(self: *QMorph, v: u32) !void {
        const qs = self.node_quads.items[v].items;
        var acc = Vec2.init(0, 0);
        var w: f64 = 0;
        for (qs) |qi| {
            const q = self.quads.items[qi];
            var k: usize = 0;
            while (q[k] != v) k += 1;
            const j = self.P(q[(k + 1) % 4]);
            const l = self.P(q[(k + 3) % 4]);
            const o = self.P(q[(k + 2) % 4]);
            acc = acc.add(j.add(l).sub(o));
            w += 1;
        }
        if (!try self.nodeTris(v, &self.s_tris)) return;
        // Triangle neighbors (unique).
        self.s_nodes.clearRetainingCapacity();
        for (self.s_tris.items) |t| {
            for (self.m.tv.items[t]) |x| {
                if (x == v) continue;
                if (std.mem.indexOfScalar(u32, self.s_nodes.items, x) == null) try self.s_nodes.append(self.gpa, x);
            }
        }
        if (w == 0 and self.s_nodes.items.len == 0) return;
        var target: Vec2 = undefined;
        if (w > 0) {
            target = acc.scale(1.0 / w);
        } else {
            var s = Vec2.init(0, 0);
            for (self.s_nodes.items) |x| s = s.add(self.P(x));
            target = s.scale(1.0 / @as(f64, @floatFromInt(self.s_nodes.items.len)));
        }
        const cur = self.P(v);
        var f: f64 = 0.5;
        while (f > 0.05) : (f *= 0.5) {
            if (try self.safeMove(v, cur.lerp(target, f))) return;
        }
    }

    // ------------------------------------------------------------------
    // Seams

    /// Nodes adjacent to v through triangles or quads.
    fn nodeNeighbors(self: *QMorph, v: u32, out: *std.ArrayList(u32)) !bool {
        out.clearRetainingCapacity();
        if (!try self.nodeTris(v, &self.s_tris2)) return false;
        for (self.s_tris2.items) |t| {
            for (self.m.tv.items[t]) |x| {
                if (x != v and std.mem.indexOfScalar(u32, out.items, x) == null) try out.append(self.gpa, x);
            }
        }
        for (self.node_quads.items[v].items) |qi| {
            if (!self.qalive.items[qi]) continue;
            const q = self.quads.items[qi];
            var k: usize = 0;
            while (q[k] != v) k += 1;
            for ([_]u32{ q[(k + 1) % 4], q[(k + 3) % 4] }) |x| {
                if (std.mem.indexOfScalar(u32, out.items, x) == null) try out.append(self.gpa, x);
            }
        }
        return true;
    }

    /// Closes a small front angle at node a (between p -> a and a -> b) by merging p and b
    /// into one node (Owen's seam). Boundary nodes keep their position; at most one of p
    /// and b may be a boundary node.
    fn trySeam(self: *QMorph, a: u32, b: u32) !bool {
        var t0 = self.frontTri(a, b) orelse return false;
        const pe = self.prevFront(a, t0) orelse return false;
        const p = pe.v;
        if (p == b) return false;
        const theta = self.angleAt(p, a, b);
        if (theta >= self.opts.seam_angle) return false;
        const la = self.P(a).dist(self.P(b));
        const lp = self.P(a).dist(self.P(p));
        if (@max(la, lp) > 1.8 * @min(la, lp)) return false;
        if (self.m.isFixed(p) and self.m.isFixed(b)) return false;
        // Reduce the wedge at a to the single triangle (a, b, p) by flipping interior edges.
        var guard: usize = 0;
        while (guard < 16) : (guard += 1) {
            t0 = self.frontTri(a, b) orelse return false;
            const ia0 = self.m.vertIndex(t0, a).?;
            const e = next3(ia0);
            if (self.m.tn.items[t0][e] == NONE) break;
            if (!self.m.canFlip(t0, e)) return false;
            _ = self.m.flip(t0, e);
            self.stats.swaps += 1;
        } else return false;
        t0 = self.frontTri(a, b) orelse return false;
        const ia = self.m.vertIndex(t0, a).?;
        if (self.m.tv.items[t0][prev3(ia)] != p) return false;
        if (self.m.isCons(t0, ia)) return false;
        const u = self.m.tn.items[t0][ia]; // across (b, p)
        if (u == NONE) return false;
        const ju = self.m.edgeIndex(u, p, b) orelse return false;
        const w = self.m.tv.items[u][ju];
        const x_tri = self.m.tn.items[u][next3(ju)]; // across (b, w)
        const y_tri = self.m.tn.items[u][prev3(ju)]; // across (w, p)
        if (x_tri == NONE and y_tri == NONE) return false;
        if (self.m.isCons(u, next3(ju)) or self.m.isCons(u, prev3(ju))) return false;
        const keep = if (self.m.isFixed(b)) b else p;
        const drop = if (keep == b) p else b;
        const newpos = if (self.m.isFixed(keep)) self.P(keep) else self.P(p).mid(self.P(b));
        // Link condition: p and b may share only the neighbors a and w.
        var nk: std.ArrayList(u32) = .empty;
        defer nk.deinit(self.gpa);
        var nd: std.ArrayList(u32) = .empty;
        defer nd.deinit(self.gpa);
        if (!try self.nodeNeighbors(keep, &nk)) return false;
        if (!try self.nodeNeighbors(drop, &nd)) return false;
        for (nd.items) |x| {
            if (x == keep or x == a or x == w) continue;
            if (std.mem.indexOfScalar(u32, nk.items, x) != null) return false;
        }
        // Elements around both nodes, excluding the two collapsing triangles.
        var tk: std.ArrayList(u32) = .empty;
        defer tk.deinit(self.gpa);
        var td: std.ArrayList(u32) = .empty;
        defer td.deinit(self.gpa);
        if (!try self.nodeTris(keep, &self.s_tris)) return false;
        for (self.s_tris.items) |t| if (t != t0 and t != u) try tk.append(self.gpa, t);
        if (!try self.nodeTris(drop, &self.s_tris)) return false;
        for (self.s_tris.items) |t| if (t != t0 and t != u) try td.append(self.gpa, t);
        for (self.node_quads.items[drop].items) |qi| {
            if (std.mem.indexOfScalar(u32, self.quads.items[qi][0..], keep) != null) return false;
        }
        // Validity with the merged node at newpos.
        const old_keep = self.P(keep);
        const old_drop = self.P(drop);
        self.m.pts.items[keep] = newpos;
        self.m.pts.items[drop] = newpos;
        var ok = true;
        for (tk.items) |t| if (self.m.orientTri(t) <= 0) {
            ok = false;
        };
        for (td.items) |t| if (self.m.orientTri(t) <= 0) {
            ok = false;
        };
        if (ok) for (self.node_quads.items[keep].items) |qi| {
            if (!self.quadValid(qi)) ok = false;
        };
        if (ok) for (self.node_quads.items[drop].items) |qi| {
            if (!self.quadValid(qi)) ok = false;
        };
        if (!ok) {
            self.m.pts.items[keep] = old_keep;
            self.m.pts.items[drop] = old_drop;
            return false;
        }
        // Front edges touching drop (other than those of t0 and u) are re-keyed.
        const Fe = struct { a: u32, b: u32, t: u32, level: u32 };
        var fes: std.ArrayList(Fe) = .empty;
        defer fes.deinit(self.gpa);
        for (td.items) |t| {
            const tv = self.m.tv.items[t];
            for (0..3) |i| {
                if (self.m.tn.items[t][i] != NONE) continue;
                const fa = tv[next3(i)];
                const fb = tv[prev3(i)];
                if (fa != drop and fb != drop) continue;
                const lv = if (self.front.get(dkey(fa, fb))) |fi| fi.level else 0;
                try fes.append(self.gpa, .{ .a = fa, .b = fb, .t = t, .level = lv });
            }
        }
        const lvl_ab = if (self.front.get(dkey(a, b))) |fi| fi.level else 0;
        const lvl_bw = if (self.front.get(dkey(b, w))) |fi| fi.level else lvl_ab;
        const lvl_wp = if (self.front.get(dkey(w, p))) |fi| fi.level else lvl_ab;
        for (fes.items) |f| self.removeFront(f.a, f.b);
        self.removeFront(a, b);
        self.removeFront(p, a);
        if (x_tri == NONE) self.removeFront(b, w);
        if (y_tri == NONE) self.removeFront(w, p);
        // Glue the neighbors of u across the merged edge (keep, w).
        var jx: usize = 0;
        var jy: usize = 0;
        if (x_tri != NONE) jx = self.m.edgeIndex(x_tri, w, b).?;
        if (y_tri != NONE) jy = self.m.edgeIndex(y_tri, p, w).?;
        try self.m.reserveKills(2);
        try self.m.killTri(t0);
        try self.m.killTri(u);
        if (x_tri != NONE) self.m.tn.items[x_tri][jx] = y_tri;
        if (y_tri != NONE) self.m.tn.items[y_tri][jy] = x_tri;
        // Substitute drop -> keep.
        for (td.items) |t| {
            for (&self.m.tv.items[t]) |*v| if (v.* == drop) {
                v.* = keep;
            };
            self.m.tgen.items[t] +%= 1;
        }
        for (self.node_quads.items[drop].items) |qi| {
            for (&self.quads.items[qi]) |*v| if (v.* == drop) {
                v.* = keep;
            };
            try self.node_quads.items[keep].append(self.gpa, qi);
        }
        self.node_quads.items[drop].clearRetainingCapacity();
        self.m.pts.items[keep] = newpos;
        self.m.nflags.items[drop] |= tm.NodeFlags.deleted;
        self.m.vtri.items[drop] = NONE;
        // Re-add front edges.
        for (fes.items) |f| {
            const fa = if (f.a == drop) keep else f.a;
            const fb = if (f.b == drop) keep else f.b;
            try self.addFront(fa, fb, f.t, f.level);
        }
        if (x_tri == NONE and y_tri != NONE) try self.addFront(keep, w, y_tri, lvl_bw);
        if (y_tri == NONE and x_tri != NONE) try self.addFront(w, keep, x_tri, lvl_wp);
        // Vertex seeds.
        for ([_]u32{ keep, a, w }) |v| {
            const s = self.m.vtri.items[v];
            if (s != NONE and self.m.talive.items[s] and self.m.vertIndex(s, v) != null) continue;
            self.m.vtri.items[v] = NONE;
            for (tk.items) |t| if (self.m.talive.items[t] and self.m.vertIndex(t, v) != null) {
                self.m.vtri.items[v] = t;
            };
            for (td.items) |t| if (self.m.talive.items[t] and self.m.vertIndex(t, v) != null) {
                self.m.vtri.items[v] = t;
            };
            if (x_tri != NONE and self.m.vertIndex(x_tri, v) != null) self.m.vtri.items[v] = x_tri;
            if (y_tri != NONE and self.m.vertIndex(y_tri, v) != null) self.m.vtri.items[v] = y_tri;
        }
        self.stats.seams += 1;
        if (self.opts.smooth and !self.m.isFixed(keep)) try self.smoothNode(keep);
        try self.touch(keep);
        try self.touch(a);
        try self.touch(w);
        return true;
    }

    // ------------------------------------------------------------------
    // Small loops

    /// Length of the front loop through a -> b, up to `cap` edges (null if longer).
    fn loopNodes(self: *QMorph, a: u32, b: u32, cap: usize, out: *[8]u32) ?usize {
        var t = self.frontTri(a, b) orelse return null;
        out[0] = a;
        var cur_a = a;
        var cur_b = b;
        var n: usize = 1;
        while (n <= cap) {
            out[n] = cur_b;
            const ne = self.nextFront(cur_b, t) orelse return null;
            cur_a = cur_b;
            cur_b = ne.v;
            t = ne.t;
            n += 1;
            if (cur_a == a and cur_b == b) return n - 1;
            if (n >= out.len) return null;
        }
        return null;
    }

    /// Closes front loops of 4 or 6 edges that bound a region with nothing else inside.
    fn tryClose(self: *QMorph, a: u32, b: u32, level: u32) !bool {
        var nodes: [8]u32 = undefined;
        const n = self.loopNodes(a, b, 6, &nodes) orelse return false;
        if (n != 4 and n != 6) return false;
        const poly = nodes[0..n];
        // A loop that visits a node twice (around a curve tip) is not a polygon to close.
        for (poly, 0..) |v, k| if (std.mem.indexOfScalar(u32, poly[k + 1 ..], v) != null) return false;
        var pts: [6]Vec2 = undefined;
        for (poly, 0..) |v, k| pts[k] = self.P(v);
        if (geom.polygonArea(pts[0..n]) <= 0) return false;
        const t0 = self.frontTri(a, b) orelse return false;
        var fill = Fill{};
        defer fill.deinit(self.gpa);
        if (!try self.floodPolygon(t0, poly, &fill, 600)) return false;
        if (n == 4) {
            const q = [4]u32{ poly[0], poly[1], poly[2], poly[3] };
            if (geom.quadConvex(.{ pts[0], pts[1], pts[2], pts[3] })) {
                try self.commit(&fill, &.{q}, level);
            } else {
                // Quad-in-quad template: four interior nodes.
                var inner: [4]u32 = undefined;
                const cen = pts[0].add(pts[1]).add(pts[2]).add(pts[3]).scale(0.25);
                for (0..4) |k| inner[k] = try self.m.addNode(pts[k].lerp(cen, 0.5), 0);
                try self.ensureNodes();
                const qs = [5][4]u32{
                    .{ poly[0], poly[1], inner[1], inner[0] },
                    .{ poly[1], poly[2], inner[2], inner[1] },
                    .{ poly[2], poly[3], inner[3], inner[2] },
                    .{ poly[3], poly[0], inner[0], inner[3] },
                    .{ inner[0], inner[1], inner[2], inner[3] },
                };
                for (qs) |qq| if (!geom.quadConvex(.{ self.P(qq[0]), self.P(qq[1]), self.P(qq[2]), self.P(qq[3]) })) {
                    for (inner) |v| self.m.nflags.items[v] |= tm.NodeFlags.deleted;
                    return false;
                };
                try self.commit(&fill, &qs, level);
            }
        } else {
            // Hexagon: best of three 2-quad splits and two 3-quad center templates.
            var best_q: f64 = -2;
            var best_kind: usize = 0;
            for (0..3) |k| {
                const q1 = [4]Vec2{ pts[k], pts[k + 1], pts[k + 2], pts[k + 3] };
                const q2 = [4]Vec2{ pts[k + 3], pts[(k + 4) % 6], pts[(k + 5) % 6], pts[k] };
                if (!geom.quadConvex(q1) or !geom.quadConvex(q2)) continue;
                const qq = @min(geom.quadScaledJacobian(q1), geom.quadScaledJacobian(q2));
                if (qq > best_q) {
                    best_q = qq;
                    best_kind = k;
                }
            }
            var cen = Vec2.init(0, 0);
            for (pts[0..6]) |x| cen = cen.add(x);
            cen = cen.scale(1.0 / 6.0);
            for (0..2) |k| {
                var worst: f64 = 1;
                var okc = true;
                for (0..3) |j| {
                    const s = k + 2 * j;
                    const q = [4]Vec2{ cen, pts[s % 6], pts[(s + 1) % 6], pts[(s + 2) % 6] };
                    if (!geom.quadConvex(q)) okc = false;
                    worst = @min(worst, geom.quadScaledJacobian(q));
                }
                // Prefer two quads unless the center template is clearly better.
                if (okc and worst > best_q + 0.15) {
                    best_q = worst;
                    best_kind = 3 + k;
                }
            }
            if (best_q <= 0) return false;
            if (best_kind < 3) {
                const k = best_kind;
                const qs = [2][4]u32{
                    .{ poly[k], poly[k + 1], poly[k + 2], poly[k + 3] },
                    .{ poly[k + 3], poly[(k + 4) % 6], poly[(k + 5) % 6], poly[k] },
                };
                try self.commit(&fill, &qs, level);
            } else {
                const k = best_kind - 3;
                const cn = try self.m.addNode(cen, 0);
                try self.ensureNodes();
                var qs: [3][4]u32 = undefined;
                for (0..3) |j| {
                    const s = k + 2 * j;
                    qs[j] = .{ cn, poly[s % 6], poly[(s + 1) % 6], poly[(s + 2) % 6] };
                }
                try self.commit(&fill, &qs, level);
            }
        }
        self.stats.closures += 1;
        for (poly) |v| try self.touch(v);
        return true;
    }

    // ------------------------------------------------------------------
    // Driver

    pub fn run(self: *QMorph) !void {
        self.m.on_new_tri = hook;
        self.m.hook_ctx = self;
        defer self.m.on_new_tri = null;
        try self.ensureNodes();
        self.split_budget = self.m.pts.items.len + 64;
        // Control-loop edges become front edges on both sides.
        for (self.m.tv.items, 0..) |_, ti| {
            const t: u32 = @intCast(ti);
            if (!self.m.talive.items[t]) continue;
            for (0..3) |i| {
                const u = self.m.tn.items[t][i];
                if (u == NONE or !self.m.isCons(t, i)) continue;
                const tv = self.m.tv.items[t];
                const j = self.m.edgeIndex(u, tv[prev3(i)], tv[next3(i)]).?;
                self.m.tn.items[t][i] = NONE;
                self.m.tn.items[u][j] = NONE;
            }
        }
        // Initial front: all NONE edges of alive triangles, level 0.
        for (self.m.tv.items, 0..) |tv, ti| {
            const t: u32 = @intCast(ti);
            if (!self.m.talive.items[t]) continue;
            for (0..3) |i| {
                if (self.m.tn.items[t][i] != NONE) continue;
                try self.addFront(tv[next3(i)], tv[prev3(i)], t, 0);
            }
        }
        // Classify in a deterministic order (triangle order).
        for (self.m.tv.items, 0..) |tv, ti| {
            const t: u32 = @intCast(ti);
            if (!self.m.talive.items[t]) continue;
            for (0..3) |i| {
                if (self.m.tn.items[t][i] != NONE) continue;
                try self.classify(tv[next3(i)], tv[prev3(i)]);
            }
        }
        var guard: usize = 0;
        const limit: usize = if (self.opts.max_steps > 0) self.opts.max_steps else 20_000_000;
        while (self.pq.pop()) |it| {
            guard += 1;
            if (guard > limit) break;
            const fi = self.front.getPtr(dkey(it.a, it.b)) orelse continue;
            if (fi.stamp != it.stamp) continue;
            const level = fi.level;
            if (try self.trySeam(it.a, it.b)) continue;
            if (try self.tryClose(it.a, it.b, level)) continue;
            if (try self.tryQuad(it.a, it.b, level)) continue;
            // Failed: retry later with a penalty.
            self.stats.failures += 1;
            if (self.front.getPtr(dkey(it.a, it.b))) |f2| {
                f2.fails += 1;
                try self.classify(it.a, it.b);
            }
        }
        self.stats.leftover_tris = self.m.alive_count;
    }
};
