//! WebAssembly entry: the C ABI plus malloc/free so JavaScript can pass buffers.
//! The module exports its memory as "memory".

const std = @import("std");

comptime {
    _ = @import("c_api.zig");
}

const gpa = std.heap.wasm_allocator;
const header = 16;

export fn malloc(size: usize) ?[*]u8 {
    const buf = gpa.alignedAlloc(u8, .@"16", size + header) catch return null;
    std.mem.writeInt(u64, buf[0..8], size, .little);
    return buf.ptr + header;
}

export fn free(ptr: ?[*]u8) void {
    const p = ptr orelse return;
    const base: [*]align(16) u8 = @alignCast(p - header);
    const size = std.mem.readInt(u64, base[0..8], .little);
    gpa.free(base[0 .. @as(usize, @intCast(size)) + header]);
}
