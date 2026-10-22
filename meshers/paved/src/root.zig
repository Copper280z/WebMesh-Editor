//! Paved (Q-Morph) all-quad mesher for planar faces.

pub const geom = @import("geom.zig");
pub const predicates = @import("predicates.zig");
pub const sizefield = @import("sizefield.zig");
pub const boundary = @import("boundary.zig");
pub const trimesh = @import("trimesh.zig");
pub const cdt = @import("cdt.zig");
pub const faces = @import("faces.zig");
pub const svg = @import("svg.zig");
pub const qmorph = @import("qmorph.zig");
pub const mesher = @import("mesher.zig");
pub const fallback = @import("fallback.zig");
pub const polymesh = @import("polymesh.zig");
pub const smooth = @import("smooth.zig");
pub const cleanup = @import("cleanup.zig");
pub const quality = @import("quality.zig");
const fixtures = @import("fixtures.zig");

test {
    _ = @import("tests.zig");
    _ = geom;
    _ = predicates;
    _ = sizefield;
    _ = boundary;
    _ = trimesh;
    _ = cdt;
    _ = faces;
    _ = svg;
    _ = qmorph;
    _ = mesher;
    _ = quality;
}
