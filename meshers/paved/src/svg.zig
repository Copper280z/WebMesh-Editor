//! SVG rendering of quad (and leftover triangle) meshes.

const std = @import("std");
const geom = @import("geom.zig");
const Vec2 = geom.Vec2;
const Allocator = std.mem.Allocator;

pub const Input = struct {
    pts: []const Vec2,
    quads: []const [4]u32 = &.{},
    tris: []const [3]u32 = &.{},
    boundary_edges: []const [2]u32 = &.{},
    /// Nodes drawn as dots: valence-3 and valence-5+ interior nodes.
    marks3: []const u32 = &.{},
    marks5: []const u32 = &.{},
    title: []const u8 = "",
    width_px: f64 = 1400,
    /// Optional region of interest (x0, y0, x1, y1); elements outside it are skipped.
    view: ?[4]f64 = null,
};

fn inView(in: Input, q: Vec2) bool {
    const v = in.view orelse return true;
    return q.x >= v[0] and q.x <= v[2] and q.y >= v[1] and q.y <= v[3];
}

pub fn write(gpa: Allocator, out: *std.ArrayList(u8), in: Input) !void {
    var lo = Vec2.init(std.math.inf(f64), std.math.inf(f64));
    var hi = Vec2.init(-std.math.inf(f64), -std.math.inf(f64));
    const Touch = struct {
        fn f(l: *Vec2, h: *Vec2, q: Vec2) void {
            l.x = @min(l.x, q.x);
            l.y = @min(l.y, q.y);
            h.x = @max(h.x, q.x);
            h.y = @max(h.y, q.y);
        }
    };
    if (in.view) |v| {
        lo = .init(v[0], v[1]);
        hi = .init(v[2], v[3]);
    } else {
        for (in.quads) |q| for (q) |v| Touch.f(&lo, &hi, in.pts[v]);
        for (in.tris) |t| for (t) |v| Touch.f(&lo, &hi, in.pts[v]);
        for (in.boundary_edges) |e| for (e) |v| Touch.f(&lo, &hi, in.pts[v]);
    }
    if (!(hi.x > lo.x)) {
        lo = .init(0, 0);
        hi = .init(1, 1);
    }
    const ext = @max(hi.x - lo.x, hi.y - lo.y);
    const margin = 0.02 * ext;
    const w = hi.x - lo.x + 2 * margin;
    const h = hi.y - lo.y + 2 * margin;
    const scale = in.width_px / w;
    const height_px = h * scale;
    const title_h: f64 = if (in.title.len > 0) 28 else 0;
    try out.print(gpa,
        \\<svg xmlns="http://www.w3.org/2000/svg" width="{d:.0}" height="{d:.0}" viewBox="0 0 {d:.1} {d:.1}">
        \\<rect width="100%" height="100%" fill="white"/>
        \\
    , .{ in.width_px, height_px + title_h, in.width_px, height_px + title_h });
    if (in.title.len > 0) {
        try out.print(gpa, "<text x=\"8\" y=\"20\" font-family=\"sans-serif\" font-size=\"16\">", .{});
        try escape(gpa, out, in.title);
        try out.print(gpa, "</text>\n", .{});
    }
    const sw: f64 = if (in.view != null) 1.0 else @max(0.35, @min(1.0, in.width_px / 2000.0));
    const X = struct {
        lo: Vec2,
        margin: f64,
        scale: f64,
        height: f64,
        top: f64,
        fn x(s: @This(), q: Vec2) f64 {
            return (q.x - s.lo.x + s.margin) * s.scale;
        }
        fn y(s: @This(), q: Vec2) f64 {
            return s.top + s.height - (q.y - s.lo.y + s.margin) * s.scale;
        }
    };
    const tr = X{ .lo = lo, .margin = margin, .scale = scale, .height = height_px, .top = title_h };
    // Quads grouped by fill color.
    const fills = [_][]const u8{ "#dfe9f5", "#ffe08a", "#f28b82" };
    for (fills, 0..) |fill, band| {
        try out.print(gpa, "<g fill=\"{s}\" stroke=\"#2b3a55\" stroke-width=\"{d:.2}\" stroke-linejoin=\"round\">\n", .{ fill, sw });
        for (in.quads) |q| {
            const pq = [4]Vec2{ in.pts[q[0]], in.pts[q[1]], in.pts[q[2]], in.pts[q[3]] };
            if (!(inView(in, pq[0]) or inView(in, pq[1]) or inView(in, pq[2]) or inView(in, pq[3]))) continue;
            const sj = geom.quadScaledJacobian(pq);
            const b: usize = if (sj >= 0.5) 0 else if (sj >= 0.3) 1 else 2;
            if (b != band) continue;
            try out.print(gpa, "<path d=\"M{d:.2} {d:.2}L{d:.2} {d:.2}L{d:.2} {d:.2}L{d:.2} {d:.2}Z\"/>\n", .{
                tr.x(pq[0]), tr.y(pq[0]), tr.x(pq[1]), tr.y(pq[1]), tr.x(pq[2]), tr.y(pq[2]), tr.x(pq[3]), tr.y(pq[3]),
            });
        }
        try out.print(gpa, "</g>\n", .{});
    }
    if (in.tris.len > 0) {
        try out.print(gpa, "<g fill=\"#c9f2c7\" stroke=\"#2e7d32\" stroke-width=\"{d:.2}\">\n", .{sw * 0.8});
        for (in.tris) |t| {
            const a = in.pts[t[0]];
            const b = in.pts[t[1]];
            const c = in.pts[t[2]];
            if (!(inView(in, a) or inView(in, b) or inView(in, c))) continue;
            try out.print(gpa, "<path d=\"M{d:.2} {d:.2}L{d:.2} {d:.2}L{d:.2} {d:.2}Z\"/>\n", .{ tr.x(a), tr.y(a), tr.x(b), tr.y(b), tr.x(c), tr.y(c) });
        }
        try out.print(gpa, "</g>\n", .{});
    }
    if (in.boundary_edges.len > 0) {
        try out.print(gpa, "<g stroke=\"#000\" stroke-width=\"{d:.2}\" stroke-linecap=\"round\">\n", .{sw * 2.2});
        for (in.boundary_edges) |e| {
            const a = in.pts[e[0]];
            const b = in.pts[e[1]];
            if (!(inView(in, a) or inView(in, b))) continue;
            try out.print(gpa, "<line x1=\"{d:.2}\" y1=\"{d:.2}\" x2=\"{d:.2}\" y2=\"{d:.2}\"/>\n", .{ tr.x(a), tr.y(a), tr.x(b), tr.y(b) });
        }
        try out.print(gpa, "</g>\n", .{});
    }
    const r = @max(1.2, sw * 2.5);
    if (in.marks3.len > 0) {
        try out.print(gpa, "<g fill=\"#1565c0\">\n", .{});
        for (in.marks3) |v| try out.print(gpa, "<circle cx=\"{d:.2}\" cy=\"{d:.2}\" r=\"{d:.2}\"/>\n", .{ tr.x(in.pts[v]), tr.y(in.pts[v]), r });
        try out.print(gpa, "</g>\n", .{});
    }
    if (in.marks5.len > 0) {
        try out.print(gpa, "<g fill=\"#e65100\">\n", .{});
        for (in.marks5) |v| try out.print(gpa, "<circle cx=\"{d:.2}\" cy=\"{d:.2}\" r=\"{d:.2}\"/>\n", .{ tr.x(in.pts[v]), tr.y(in.pts[v]), r });
        try out.print(gpa, "</g>\n", .{});
    }
    try out.print(gpa, "</svg>\n", .{});
}

fn escape(gpa: Allocator, out: *std.ArrayList(u8), s: []const u8) !void {
    for (s) |c| switch (c) {
        '<' => try out.appendSlice(gpa, "&lt;"),
        '>' => try out.appendSlice(gpa, "&gt;"),
        '&' => try out.appendSlice(gpa, "&amp;"),
        else => try out.append(gpa, c),
    };
}
