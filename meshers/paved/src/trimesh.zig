//! Triangle mesh with adjacency, used for the constrained Delaunay
//! triangulation and as the unmeshed region during Q-Morph.
//!
//! Triangles are counterclockwise. Edge i of a triangle is the edge opposite
//! vertex i, running from v[i+1] to v[i+2]; nbr[i] is the triangle across it
//! or NONE (domain boundary or, during Q-Morph, a quad / front edge).
//! Freed triangle slots are reused last-in first-out, which keeps every run
//! deterministic.

const std = @import("std");
const geom = @import("geom.zig");
const Vec2 = geom.Vec2;
const Allocator = std.mem.Allocator;

pub const NONE: u32 = std.math.maxInt(u32);

pub const NodeFlags = struct {
    pub const fixed: u8 = 1; // boundary node: never moved or removed
    pub const deleted: u8 = 2;
};

pub inline fn next3(i: usize) usize {
    return if (i == 2) 0 else i + 1;
}
pub inline fn prev3(i: usize) usize {
    return if (i == 0) 2 else i - 1;
}

pub const Mesh = struct {
    gpa: Allocator,
    pts: std.ArrayList(Vec2) = .empty,
    nflags: std.ArrayList(u8) = .empty,
    /// One alive triangle incident to each node (NONE if none known).
    vtri: std.ArrayList(u32) = .empty,

    tv: std.ArrayList([3]u32) = .empty,
    tn: std.ArrayList([3]u32) = .empty,
    /// Bit i set: edge i is constrained (never flipped).
    tcons: std.ArrayList(u8) = .empty,
    talive: std.ArrayList(bool) = .empty,
    /// Incremented whenever a slot is (re)used or changed; lets queues detect stale entries.
    tgen: std.ArrayList(u32) = .empty,
    tmark: std.ArrayList(u32) = .empty,
    mark_stamp: u32 = 0,
    free_slots: std.ArrayList(u32) = .empty,
    alive_count: usize = 0,

    /// Optional hook called when a triangle is created (used by Q-Morph to track front edges).
    on_new_tri: ?*const fn (ctx: *anyopaque, t: u32) void = null,
    hook_ctx: *anyopaque = undefined,

    pub fn init(gpa: Allocator) Mesh {
        return .{ .gpa = gpa };
    }

    pub fn deinit(self: *Mesh) void {
        const g = self.gpa;
        self.pts.deinit(g);
        self.nflags.deinit(g);
        self.vtri.deinit(g);
        self.tv.deinit(g);
        self.tn.deinit(g);
        self.tcons.deinit(g);
        self.talive.deinit(g);
        self.tgen.deinit(g);
        self.tmark.deinit(g);
        self.free_slots.deinit(g);
    }

    pub fn addNode(self: *Mesh, pos: Vec2, flags: u8) !u32 {
        const id: u32 = @intCast(self.pts.items.len);
        try self.pts.append(self.gpa, pos);
        try self.nflags.append(self.gpa, flags);
        try self.vtri.append(self.gpa, NONE);
        return id;
    }

    pub inline fn isFixed(self: *const Mesh, v: u32) bool {
        return self.nflags.items[v] & NodeFlags.fixed != 0;
    }

    pub inline fn p(self: *const Mesh, v: u32) Vec2 {
        return self.pts.items[v];
    }

    pub fn newTri(self: *Mesh, a: u32, b: u32, c: u32) !u32 {
        var t: u32 = undefined;
        if (self.free_slots.items.len > 0) {
            t = self.free_slots.pop().?;
            self.tv.items[t] = .{ a, b, c };
            self.tn.items[t] = .{ NONE, NONE, NONE };
            self.tcons.items[t] = 0;
            self.talive.items[t] = true;
            self.tgen.items[t] +%= 1;
        } else {
            t = @intCast(self.tv.items.len);
            try self.tv.append(self.gpa, .{ a, b, c });
            try self.tn.append(self.gpa, .{ NONE, NONE, NONE });
            try self.tcons.append(self.gpa, 0);
            try self.talive.append(self.gpa, true);
            try self.tgen.append(self.gpa, 0);
            try self.tmark.append(self.gpa, 0);
        }
        self.vtri.items[a] = t;
        self.vtri.items[b] = t;
        self.vtri.items[c] = t;
        self.alive_count += 1;
        return t;
    }

    pub fn killTri(self: *Mesh, t: u32) !void {
        std.debug.assert(self.talive.items[t]);
        self.talive.items[t] = false;
        self.tgen.items[t] +%= 1;
        self.alive_count -= 1;
        try self.free_slots.append(self.gpa, t);
    }

    /// Ensures capacity for `n` more triangles in the free list, so killTri cannot fail afterwards.
    pub fn reserveKills(self: *Mesh, n: usize) !void {
        try self.free_slots.ensureUnusedCapacity(self.gpa, n);
    }

    pub fn notifyNew(self: *Mesh, t: u32) void {
        if (self.on_new_tri) |f| f(self.hook_ctx, t);
    }

    pub inline fn vertIndex(self: *const Mesh, t: u32, v: u32) ?usize {
        const tv = self.tv.items[t];
        if (tv[0] == v) return 0;
        if (tv[1] == v) return 1;
        if (tv[2] == v) return 2;
        return null;
    }

    /// Index i of the directed edge a -> b in t (v[i+1] == a and v[i+2] == b).
    pub inline fn edgeIndex(self: *const Mesh, t: u32, a: u32, b: u32) ?usize {
        const tv = self.tv.items[t];
        inline for (0..3) |i| {
            if (tv[(i + 1) % 3] == a and tv[(i + 2) % 3] == b) return i;
        }
        return null;
    }

    pub inline fn isCons(self: *const Mesh, t: u32, i: usize) bool {
        return (self.tcons.items[t] >> @intCast(i)) & 1 != 0;
    }

    pub inline fn setCons(self: *Mesh, t: u32, i: usize, on: bool) void {
        const bit: u8 = @as(u8, 1) << @intCast(i);
        if (on) self.tcons.items[t] |= bit else self.tcons.items[t] &= ~bit;
    }

    /// Neighbor slot j in u that points across the edge (a, b) (either direction).
    fn slotFor(self: *const Mesh, u: u32, a: u32, b: u32) ?usize {
        if (self.edgeIndex(u, b, a)) |j| return j;
        if (self.edgeIndex(u, a, b)) |j| return j;
        return null;
    }

    /// Sets t's neighbor across edge i to u and the matching back pointer in u.
    pub fn link(self: *Mesh, t: u32, i: usize, u: u32) void {
        self.tn.items[t][i] = u;
        if (u != NONE) {
            const tv = self.tv.items[t];
            const a = tv[next3(i)];
            const b = tv[prev3(i)];
            if (self.edgeIndex(u, b, a)) |j| self.tn.items[u][j] = t;
        }
    }

    pub fn triPoints(self: *const Mesh, t: u32) [3]Vec2 {
        const tv = self.tv.items[t];
        return .{ self.pts.items[tv[0]], self.pts.items[tv[1]], self.pts.items[tv[2]] };
    }

    pub fn orientTri(self: *const Mesh, t: u32) f64 {
        const q = self.triPoints(t);
        return geom.orient(q[0], q[1], q[2]);
    }

    pub fn newMark(self: *Mesh) u32 {
        self.mark_stamp +%= 1;
        if (self.mark_stamp == 0) {
            @memset(self.tmark.items, 0);
            self.mark_stamp = 1;
        }
        return self.mark_stamp;
    }

    /// True if the edge i of t can be flipped (interior, unconstrained, convex quad).
    pub fn canFlip(self: *const Mesh, t: u32, i: usize) bool {
        const u = self.tn.items[t][i];
        if (u == NONE or self.isCons(t, i)) return false;
        const tv = self.tv.items[t];
        const c = tv[i];
        const a = tv[next3(i)];
        const b = tv[prev3(i)];
        const j = self.edgeIndex(u, b, a) orelse return false;
        const d = self.tv.items[u][j];
        const pa = self.p(a);
        const pb = self.p(b);
        const pc = self.p(c);
        const pd = self.p(d);
        return geom.orient(pc, pa, pd) > 0 and geom.orient(pd, pb, pc) > 0;
    }

    /// Flips edge i of t. Returns the two triangles (t, u) now holding (c, a, d) and (c, d, b),
    /// where c is t's apex, d is u's apex and the old edge ran a -> b in t.
    pub fn flip(self: *Mesh, t: u32, i: usize) [2]u32 {
        const u = self.tn.items[t][i];
        const tv = self.tv.items[t];
        const c = tv[i];
        const a = tv[next3(i)];
        const b = tv[prev3(i)];
        const j = self.edgeIndex(u, b, a).?;
        const d = self.tv.items[u][j];
        // Outer neighbors and constraint bits.
        const n_bc = self.tn.items[t][next3(i)]; // edge opposite a: (b, c)
        const c_bc = self.isCons(t, next3(i));
        const n_ca = self.tn.items[t][prev3(i)]; // edge opposite b: (c, a)
        const c_ca = self.isCons(t, prev3(i));
        // In u = (d, b, a) rotated so that j is d: edges (b, a) [j], (a, d) [j+1], (d, b) [j+2].
        const n_ad = self.tn.items[u][next3(j)];
        const c_ad = self.isCons(u, next3(j));
        const n_db = self.tn.items[u][prev3(j)];
        const c_db = self.isCons(u, prev3(j));
        // t' = (c, a, d): edge 0 (a,d), edge 1 (d,c), edge 2 (c,a)
        self.tv.items[t] = .{ c, a, d };
        self.tcons.items[t] = 0;
        self.setCons(t, 0, c_ad);
        self.setCons(t, 2, c_ca);
        // u' = (c, d, b): edge 0 (d,b), edge 1 (b,c), edge 2 (c,d)
        self.tv.items[u] = .{ c, d, b };
        self.tcons.items[u] = 0;
        self.setCons(u, 0, c_db);
        self.setCons(u, 1, c_bc);
        self.tn.items[t] = .{ NONE, u, NONE };
        self.tn.items[u] = .{ NONE, NONE, t };
        self.link(t, 0, n_ad);
        self.link(t, 2, n_ca);
        self.link(u, 0, n_db);
        self.link(u, 1, n_bc);
        self.tgen.items[t] +%= 1;
        self.tgen.items[u] +%= 1;
        self.vtri.items[a] = t;
        self.vtri.items[c] = t;
        self.vtri.items[d] = t;
        self.vtri.items[b] = u;
        self.notifyNew(t);
        self.notifyNew(u);
        return .{ t, u };
    }

    /// Splits the interior edge i of t at point q (which must lie strictly inside the
    /// quadrilateral of the two triangles, near the edge). Returns the new node.
    /// The four new triangles are valid if the caller checked orientation.
    pub fn splitEdge(self: *Mesh, t: u32, i: usize, q: Vec2) !u32 {
        const u = self.tn.items[t][i];
        std.debug.assert(u != NONE);
        const tv = self.tv.items[t];
        const c = tv[i];
        const a = tv[next3(i)];
        const b = tv[prev3(i)];
        const j = self.edgeIndex(u, b, a).?;
        const d = self.tv.items[u][j];
        const cons = self.isCons(t, i);
        const n_bc = self.tn.items[t][next3(i)];
        const c_bc = self.isCons(t, next3(i));
        const n_ca = self.tn.items[t][prev3(i)];
        const c_ca = self.isCons(t, prev3(i));
        const n_ad = self.tn.items[u][next3(j)];
        const c_ad = self.isCons(u, next3(j));
        const n_db = self.tn.items[u][prev3(j)];
        const c_db = self.isCons(u, prev3(j));
        const m = try self.addNode(q, 0);
        try self.reserveKills(2);
        try self.killTri(t);
        try self.killTri(u);
        // (c, a, m), (c, m, b), (d, b, m), (d, m, a)
        const t1 = try self.newTri(c, a, m);
        const t2 = try self.newTri(c, m, b);
        const t3 = try self.newTri(d, b, m);
        const t4 = try self.newTri(d, m, a);
        // t1 = (c,a,m): e0 (a,m) | t4, e1 (m,c) | t2, e2 (c,a) | n_ca
        // t2 = (c,m,b): e0 (m,b) | t3, e1 (b,c) | n_bc, e2 (c,m) | t1
        // t3 = (d,b,m): e0 (b,m) | t2, e1 (m,d) | t4, e2 (d,b) | n_db
        // t4 = (d,m,a): e0 (m,a) | t1, e1 (a,d) | n_ad, e2 (d,m) | t3
        self.tn.items[t1] = .{ t4, t2, NONE };
        self.tn.items[t2] = .{ t3, NONE, t1 };
        self.tn.items[t3] = .{ t2, t4, NONE };
        self.tn.items[t4] = .{ t1, NONE, t3 };
        self.link(t1, 2, n_ca);
        self.link(t2, 1, n_bc);
        self.link(t3, 2, n_db);
        self.link(t4, 1, n_ad);
        self.setCons(t1, 2, c_ca);
        self.setCons(t2, 1, c_bc);
        self.setCons(t3, 2, c_db);
        self.setCons(t4, 1, c_ad);
        if (cons) {
            self.setCons(t1, 0, true);
            self.setCons(t4, 0, true);
            self.setCons(t2, 0, true);
            self.setCons(t3, 0, true);
        }
        self.notifyNew(t1);
        self.notifyNew(t2);
        self.notifyNew(t3);
        self.notifyNew(t4);
        return m;
    }

    pub const Located = struct {
        t: u32,
        /// Edge index if the point lies exactly on that edge's line inside t.
        on_edge: ?usize = null,
        /// The walk left the triangulated region through a NONE edge.
        outside: bool = false,
    };

    /// Visibility walk from `start` to the triangle containing q.
    pub fn locate(self: *const Mesh, q: Vec2, start: u32) Located {
        var t = start;
        var steps: usize = 0;
        const max_steps = 4 * self.tv.items.len + 100;
        outer: while (steps < max_steps) : (steps += 1) {
            const tv = self.tv.items[t];
            const k0 = steps % 3;
            var on: ?usize = null;
            for (0..3) |kk| {
                const i = (k0 + kk) % 3;
                const a = self.pts.items[tv[next3(i)]];
                const b = self.pts.items[tv[prev3(i)]];
                const o = geom.orient(a, b, q);
                if (o < 0) {
                    const u = self.tn.items[t][i];
                    if (u == NONE) return .{ .t = t, .outside = true, .on_edge = i };
                    t = u;
                    continue :outer;
                }
                if (o == 0) on = i;
            }
            return .{ .t = t, .on_edge = on };
        }
        return .{ .t = t, .outside = true };
    }

    /// Bowyer-Watson insertion of q, starting from triangle t0 that contains q.
    /// The cavity never crosses constrained edges. Returns the new node, or null if the
    /// cavity is not star-shaped (insertion refused, mesh unchanged).
    pub fn insertBW(self: *Mesh, q: Vec2, t0: u32, flags: u8, cavity: *std.ArrayList(u32), bnd: *std.ArrayList(BEdge)) !?u32 {
        cavity.clearRetainingCapacity();
        bnd.clearRetainingCapacity();
        const mark = self.newMark();
        self.tmark.items[t0] = mark;
        try cavity.append(self.gpa, t0);
        var k: usize = 0;
        while (k < cavity.items.len) : (k += 1) {
            const t = cavity.items[k];
            for (0..3) |i| {
                const u = self.tn.items[t][i];
                if (u == NONE or self.isCons(t, i)) continue;
                if (self.tmark.items[u] == mark) continue;
                const pp = self.triPoints(u);
                if (geom.inCircle(pp[0], pp[1], pp[2], q) > 0) {
                    self.tmark.items[u] = mark;
                    try cavity.append(self.gpa, u);
                }
            }
        }
        // Boundary edges of the cavity.
        for (cavity.items) |t| {
            const tv = self.tv.items[t];
            for (0..3) |i| {
                const u = self.tn.items[t][i];
                if (u != NONE and self.tmark.items[u] == mark) continue;
                const a = tv[next3(i)];
                const b = tv[prev3(i)];
                if (geom.orient(self.p(a), self.p(b), q) <= 0) return null;
                try bnd.append(self.gpa, .{ .a = a, .b = b, .outside = u, .cons = self.isCons(t, i) });
            }
        }
        // Every cavity vertex must be on its boundary (no vertex is swallowed).
        for (cavity.items) |t| {
            for (self.tv.items[t]) |v| {
                var found = false;
                for (bnd.items) |e| if (e.a == v) {
                    found = true;
                    break;
                };
                if (!found) return null;
            }
        }
        const m = try self.addNode(q, flags);
        try self.reserveKills(cavity.items.len);
        for (cavity.items) |t| try self.killTri(t);
        const first_new = bnd.items.len;
        _ = first_new;
        for (bnd.items) |*e| {
            const nt = try self.newTri(m, e.a, e.b);
            e.tri = nt;
            self.tn.items[nt][0] = NONE;
            self.link(nt, 0, e.outside);
            self.setCons(nt, 0, e.cons);
        }
        // Link the fan around m: tri (m, a, b) edge 1 is (b, m), edge 2 is (m, a).
        for (bnd.items) |e| {
            for (bnd.items) |f| {
                if (f.a == e.b) {
                    self.tn.items[e.tri][1] = f.tri;
                    self.tn.items[f.tri][2] = e.tri;
                    break;
                }
            }
        }
        for (bnd.items) |e| self.notifyNew(e.tri);
        return m;
    }

    /// Removes an interior node whose triangle fan is closed and retriangulates its star
    /// polygon by ear clipping (best-shaped ears first). Returns false (mesh unchanged) if
    /// the node is not removable.
    pub fn removeVertex(self: *Mesh, v: u32, scratch: *std.ArrayList(u32)) !bool {
        if (self.isFixed(v)) return false;
        const t0 = self.vtri.items[v];
        if (t0 == NONE or !self.talive.items[t0] or self.vertIndex(t0, v) == null) return false;
        const closed = try self.fan(v, t0, self.gpa, scratch);
        if (!closed) return false;
        const k = scratch.items.len;
        if (k < 3 or k > 32) return false;
        // Star polygon in CCW order, with outer neighbors and constraint flags of its edges.
        var poly: [32]u32 = undefined;
        var outer: [32]u32 = undefined;
        var ocons: [32]bool = undefined;
        // fan() collected triangles CCW around v starting at t0.
        for (scratch.items, 0..) |t, i| {
            const iv = self.vertIndex(t, v).?;
            poly[i] = self.tv.items[t][next3(iv)];
            outer[i] = self.tn.items[t][iv];
            ocons[i] = self.isCons(t, iv);
            if (self.isCons(t, next3(iv)) or self.isCons(t, prev3(iv))) return false;
        }
        // Consistency: consecutive triangles share edges (v, poly[i+1]).
        for (0..k) |i| {
            const t = scratch.items[i];
            const iv = self.vertIndex(t, v).?;
            if (self.tv.items[t][prev3(iv)] != poly[(i + 1) % k]) return false;
        }
        // Ear clipping on index lists.
        var idx: [32]usize = undefined;
        for (0..k) |i| idx[i] = i;
        var n = k;
        const Tri = struct { a: usize, b: usize, c: usize };
        var tris: [32]Tri = undefined;
        var nt: usize = 0;
        while (n > 3) {
            var best: ?usize = null;
            var best_q: f64 = -1;
            for (0..n) |j| {
                const ia = idx[(j + n - 1) % n];
                const ib = idx[j];
                const ic = idx[(j + 1) % n];
                const pa = self.p(poly[ia]);
                const pb = self.p(poly[ib]);
                const pc = self.p(poly[ic]);
                if (geom.orient(pa, pb, pc) <= 0) continue;
                var inside = false;
                for (0..n) |m| {
                    const im = idx[m];
                    if (im == ia or im == ib or im == ic) continue;
                    const q = self.p(poly[im]);
                    if (geom.orient(pa, pb, q) >= 0 and geom.orient(pb, pc, q) >= 0 and geom.orient(pc, pa, q) >= 0) {
                        inside = true;
                        break;
                    }
                }
                if (inside) continue;
                const qq = geom.triQuality(pa, pb, pc);
                if (qq > best_q) {
                    best_q = qq;
                    best = j;
                }
            }
            const j = best orelse return false;
            tris[nt] = .{ .a = idx[(j + n - 1) % n], .b = idx[j], .c = idx[(j + 1) % n] };
            nt += 1;
            var m = j;
            while (m + 1 < n) : (m += 1) idx[m] = idx[m + 1];
            n -= 1;
        }
        if (geom.orient(self.p(poly[idx[0]]), self.p(poly[idx[1]]), self.p(poly[idx[2]])) <= 0) return false;
        tris[nt] = .{ .a = idx[0], .b = idx[1], .c = idx[2] };
        nt += 1;
        // Replace the fan.
        try self.reserveKills(k);
        for (scratch.items) |t| try self.killTri(t);
        self.nflags.items[v] |= NodeFlags.deleted;
        self.vtri.items[v] = NONE;
        var ids: [32]u32 = undefined;
        for (tris[0..nt], 0..) |tr, i| ids[i] = try self.newTri(poly[tr.a], poly[tr.b], poly[tr.c]);
        // Link: polygon edges to the outside, diagonals between new triangles.
        for (tris[0..nt], 0..) |_, i| {
            const t = ids[i];
            const tv = self.tv.items[t];
            for (0..3) |e| {
                const x = tv[next3(e)];
                const y = tv[prev3(e)];
                // Polygon edge x -> y?
                var linked = false;
                for (0..k) |pi_| {
                    if (poly[pi_] == x and poly[(pi_ + 1) % k] == y) {
                        self.tn.items[t][e] = NONE;
                        self.link(t, e, outer[pi_]);
                        self.setCons(t, e, ocons[pi_]);
                        linked = true;
                        break;
                    }
                }
                if (linked) continue;
                for (tris[0..nt], 0..) |_, jj| {
                    if (jj == i) continue;
                    if (self.edgeIndex(ids[jj], y, x)) |e2| {
                        self.tn.items[t][e] = ids[jj];
                        self.tn.items[ids[jj]][e2] = t;
                        break;
                    }
                }
            }
        }
        for (ids[0..nt]) |t| self.notifyNew(t);
        return true;
    }

    pub const BEdge = struct {
        a: u32,
        b: u32,
        outside: u32,
        cons: bool,
        tri: u32 = NONE,
    };

    /// Collects the triangles around node v by rotating from triangle t (which contains v)
    /// counterclockwise and then clockwise until NONE edges; returns them in out.
    pub fn fan(self: *const Mesh, v: u32, t: u32, gpa: Allocator, out: *std.ArrayList(u32)) !bool {
        out.clearRetainingCapacity();
        // CCW around v: from t, cross the edge (v, next) ... the edge from v to tv[i+1] is edge prev3(i)? Let
        // i = index of v. Edge from v to v[i+1] is edge (i+2)%3; edge from v[i+2] to v is edge (i+1)%3.
        var cur = t;
        var closed = false;
        var guard: usize = 0;
        while (guard < 1000) : (guard += 1) {
            try out.append(gpa, cur);
            const i = self.vertIndex(cur, v) orelse return false;
            const nxt = self.tn.items[cur][next3(i)]; // across edge (v[i+2], v): CCW neighbor around v
            if (nxt == NONE) break;
            if (nxt == t) {
                closed = true;
                break;
            }
            cur = nxt;
        }
        if (closed) return true;
        // Clockwise from t.
        cur = t;
        guard = 0;
        while (guard < 1000) : (guard += 1) {
            const i = self.vertIndex(cur, v) orelse return false;
            const nxt = self.tn.items[cur][prev3(i)]; // across edge (v, v[i+1])
            if (nxt == NONE) break;
            cur = nxt;
            try out.append(gpa, cur);
        }
        return false;
    }

    /// Checks adjacency symmetry and orientation of all alive triangles (debugging aid).
    pub fn checkConsistency(self: *const Mesh) bool {
        for (self.tv.items, 0..) |tv, ti| {
            const t: u32 = @intCast(ti);
            if (!self.talive.items[t]) continue;
            if (self.orientTri(t) <= 0) {
                std.debug.print("tri {d} not ccw: {any}\n", .{ t, tv });
                return false;
            }
            for (0..3) |i| {
                const u = self.tn.items[t][i];
                if (u == NONE) continue;
                if (!self.talive.items[u]) {
                    std.debug.print("tri {d} nbr {d} dead\n", .{ t, u });
                    return false;
                }
                const a = tv[next3(i)];
                const b = tv[prev3(i)];
                const j = self.edgeIndex(u, b, a) orelse {
                    std.debug.print("tri {d} nbr {d} lacks edge\n", .{ t, u });
                    return false;
                };
                if (self.tn.items[u][j] != t) {
                    std.debug.print("tri {d} nbr {d} back link wrong\n", .{ t, u });
                    return false;
                }
                if (self.isCons(u, j) != self.isCons(t, i)) {
                    std.debug.print("tri {d} nbr {d} constraint mismatch\n", .{ t, u });
                    return false;
                }
            }
        }
        return true;
    }
};
