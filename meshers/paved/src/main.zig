const std = @import("std");
const paved = @import("paved");
const Io = std.Io;

fn usage(out: *Io.Writer, prog: []const u8) !void {
    try out.print(
        \\usage: {s} face.txt|face.json size [out.svg] [options]
        \\  (size 0 uses the target size stored in a JSON face)
        \\  --growth G        size growth rate (default 1.2)
        \\  --per-circle N    elements per full circle (default 12)
        \\  -v                print pipeline statistics and the worst quads
        \\  --marks           mark irregular interior nodes in the SVG
        \\  --hash            print a hash of the mesh (determinism checks)
        \\  --no-smooth       skip smoothing
        \\  --no-cleanup      skip topological cleanup
        \\  --steps N         stop Q-Morph after N front steps (debugging)
        \\  --repeat N        mesh N times and report the best time
        \\  --view x0 y0 x1 y1  draw only this region in the SVG
        \\
    , .{prog});
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;
    const arena = init.arena.allocator();
    const args = try init.minimal.args.toSlice(arena);
    var stdout_buffer: [4096]u8 = undefined;
    var stdout_file_writer: Io.File.Writer = .initStreaming(.stdout(), io, &stdout_buffer);
    const out = &stdout_file_writer.interface;
    defer out.flush() catch {};
    if (args.len < 3) return usage(out, args[0]);

    var opts = paved.mesher.Options{};
    opts.target_size = std.fmt.parseFloat(f64, args[2]) catch return usage(out, args[0]);
    var svg_path: ?[]const u8 = null;
    var steps: usize = 0;
    var repeat: usize = 1;
    var view: ?[4]f64 = null;
    var verbose = false;
    var marks = false;
    var per_circle_set = false;
    var hash = false;
    var qopts = paved.qmorph.Options{};
    var i: usize = 3;
    while (i < args.len) : (i += 1) {
        const a = args[i];
        if (std.mem.eql(u8, a, "-v")) {
            verbose = true;
        } else if (std.mem.eql(u8, a, "--hash")) {
            hash = true;
        } else if (std.mem.eql(u8, a, "--marks")) {
            marks = true;
        } else if (std.mem.startsWith(u8, a, "--qm-") and i + 1 < args.len) {
            // --qm-<field> value: set a numeric Q-Morph option (angles in degrees).
            i += 1;
            const v = try std.fmt.parseFloat(f64, args[i]);
            const name = a[5..];
            var found = false;
            const info = @typeInfo(paved.qmorph.Options).@"struct";
            inline for (info.field_names, info.field_types) |fname, ftype| {
                if (std.mem.eql(u8, fname, name)) {
                    found = true;
                    switch (@typeInfo(ftype)) {
                        .float => @field(qopts, fname) = if (std.mem.endsWith(u8, fname, "angle") or std.mem.endsWith(u8, fname, "tol")) v * std.math.pi / 180.0 else v,
                        .int => @field(qopts, fname) = @intFromFloat(v),
                        .bool => @field(qopts, fname) = v != 0,
                        else => {},
                    }
                }
            }
            if (!found) return usage(out, args[0]);
        } else if (std.mem.eql(u8, a, "--no-smooth")) {
            opts.enable_smoothing = false;
        } else if (std.mem.eql(u8, a, "--no-cleanup")) {
            opts.enable_cleanup = false;
        } else if (std.mem.eql(u8, a, "--growth") and i + 1 < args.len) {
            i += 1;
            opts.growth_rate = try std.fmt.parseFloat(f64, args[i]);
        } else if (std.mem.eql(u8, a, "--per-circle") and i + 1 < args.len) {
            i += 1;
            per_circle_set = true;
            opts.elements_per_circle = try std.fmt.parseInt(u32, args[i], 10);
        } else if (std.mem.eql(u8, a, "--steps") and i + 1 < args.len) {
            i += 1;
            steps = try std.fmt.parseInt(usize, args[i], 10);
        } else if (std.mem.eql(u8, a, "--repeat") and i + 1 < args.len) {
            i += 1;
            repeat = try std.fmt.parseInt(usize, args[i], 10);
        } else if (std.mem.eql(u8, a, "--view") and i + 4 < args.len) {
            var v: [4]f64 = undefined;
            for (0..4) |k| v[k] = try std.fmt.parseFloat(f64, args[i + 1 + k]);
            view = v;
            i += 4;
        } else if (a.len > 0 and a[0] != '-') {
            svg_path = a;
        } else return usage(out, args[0]);
    }

    const text = try Io.Dir.cwd().readFileAlloc(io, args[1], gpa, .limited(1 << 28));
    defer gpa.free(text);
    var face = if (std.mem.endsWith(u8, args[1], ".json")) try paved.faces.parseJson(gpa, text) else try paved.faces.parse(gpa, text);
    // JSON faces carry their own size settings; a size of 0 on the command line uses them.
    if (opts.target_size == 0) {
        if (face.target_size) |t| opts.target_size = t;
    }
    if (face.elements_per_circle) |e| {
        if (!per_circle_set) opts.elements_per_circle = e;
    }
    defer face.deinit(gpa);

    var diag = paved.boundary.Diag{};
    var best_ms: f64 = std.math.inf(f64);
    var res: paved.mesher.Result = undefined;
    for (0..repeat) |r| {
        const t0 = Io.Clock.Timestamp.now(io, .awake);
        var qo = qopts;
        qo.max_steps = steps;
        const cur = paved.mesher.generateTuned(gpa, face.loops, opts, &diag, qo) catch |e| {
            try out.print("error: {s}: {s}\n", .{ @errorName(e), diag.message() });
            return;
        };
        const t1 = Io.Clock.Timestamp.now(io, .awake);
        best_ms = @min(best_ms, @as(f64, @floatFromInt(t0.durationTo(t1).raw.nanoseconds)) / 1e6);
        if (r > 0) res.deinit(gpa);
        res = cur;
    }
    defer res.deinit(gpa);

    const rp = &res.report;
    try out.print("{s}: {s}; {d} quads, {d} nodes; angles [{d:.1}, {d:.1}] deg; scaled Jacobian min {d:.3}, p5 {d:.3}, >=0.5 {d:.1}%; irregular {d}/{d} = {d:.1}%; {d:.1} ms\n", .{
        args[1],                if (rp.valid) "valid" else "INVALID", rp.quad_count,          rp.node_count,
        rp.min_angle_deg,       rp.max_angle_deg,                     rp.min_scaled_jacobian, rp.p5_scaled_jacobian,
        100.0 * rp.share_sj_05, rp.irregular_nodes,                   rp.interior_nodes,      100.0 * rp.irregular_share,
        best_ms,
    });
    try out.print("  all quads {}, conforming {}, covers domain {}, inverted {d}, fixed boundary kept {}, boundary edges {d}, max boundary deviation {e:.2}\n", .{
        rp.all_quads, rp.conforming, rp.covers_domain, rp.inverted, rp.fixed_kept, rp.boundary_edge_count, rp.max_boundary_deviation,
    });
    for (rp.issues.items) |iss| try out.print("  issue: {s}\n", .{iss});
    if (hash) try out.print("  hash: {x:0>16}\n", .{paved.mesher.meshHash(res.nodes, res.quads)});
    if (verbose) {
        var shown: usize = 0;
        for (res.quads, 0..) |q, qi| {
            if (res.quality[qi].min_scaled_jacobian < 0.5 and shown < 8) {
                const pq = [4]paved.geom.Vec2{ res.nodes[q[0]], res.nodes[q[1]], res.nodes[q[2]], res.nodes[q[3]] };
                const c = pq[0].add(pq[1]).add(pq[2]).add(pq[3]).scale(0.25);
                try out.print("  poor quad SJ {d:.3} at ({d:.2}, {d:.2})\n", .{ res.quality[qi].min_scaled_jacobian, c.x, c.y });
                shown += 1;
            }
        }
        const st = res.stats;
        try out.print("  qmorph: quads {d} seams {d} closures {d} closes {d} inserts {d} removed {d} splits {d} swaps {d} failures {d} (side {d} tips {d} shape {d} parity {d} top {d} fill {d}) leftover triangles {d}\n", .{
            st.quads, st.seams, st.closures, st.closes, st.inserts, st.removed, st.splits, st.swaps, st.failures, st.fail_side, st.fail_tips, st.fail_shape, st.fail_parity, st.fail_top, st.fail_fill, st.leftover_tris,
        });
        const fs = res.fallback;
        try out.print("  fallback: matched quads {d}, flip rounds {d}, unmatched {d}, carried triangles {d}\n", .{ fs.matched_quads, fs.flip_rounds, fs.unmatched, fs.repaired });
        const cs = res.cleanup;
        try out.print("  cleanup: doublets {d} swaps {d} collapses {d} rejected {d}\n", .{ cs.doublets, cs.swaps, cs.collapses, cs.rejected });
    }
    if (svg_path) |path| {
        var buf: std.ArrayList(u8) = .empty;
        defer buf.deinit(gpa);
        const base = std.fs.path.basename(args[1]);
        const title = try std.fmt.allocPrint(arena, "{s} at size {d}: {d} quads, min angle {d:.1}, scaled Jacobian min {d:.2} / p5 {d:.2}, irregular {d:.1}% (blue: 3 quads, orange: 5+)", .{
            base[0 .. std.mem.lastIndexOfScalar(u8, base, '.') orelse base.len], opts.target_size, rp.quad_count, rp.min_angle_deg, rp.min_scaled_jacobian, rp.p5_scaled_jacobian, 100.0 * rp.irregular_share,
        });
        // Mark irregular interior nodes: 3 quads (blue) and 5 or more (orange).
        const val = try gpa.alloc(u16, res.nodes.len);
        defer gpa.free(val);
        @memset(val, 0);
        for (res.quads) |q| for (q) |v| {
            val[v] += 1;
        };
        const on_b = try gpa.alloc(bool, res.nodes.len);
        defer gpa.free(on_b);
        @memset(on_b, false);
        for (res.boundary_pairs) |e| {
            on_b[e[0]] = true;
            on_b[e[1]] = true;
        }
        var m3: std.ArrayList(u32) = .empty;
        defer m3.deinit(gpa);
        var m5: std.ArrayList(u32) = .empty;
        defer m5.deinit(gpa);
        if (marks) for (val, 0..) |c, v| {
            if (on_b[v] or c == 0 or c == 4) continue;
            if (c < 4) try m3.append(gpa, @intCast(v)) else try m5.append(gpa, @intCast(v));
        };
        try paved.svg.write(gpa, &buf, .{ .pts = res.nodes, .quads = res.quads, .tris = res.tris, .boundary_edges = res.boundary_pairs, .title = title, .view = view, .width_px = if (view != null) 1000 else 1400, .marks3 = m3.items, .marks5 = m5.items });
        try Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = buf.items });
    }
}
