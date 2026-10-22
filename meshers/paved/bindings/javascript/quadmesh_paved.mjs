// JavaScript binding for quadmesh_paved.wasm (no Emscripten needed).
//
//   import { loadModule, createMesher } from "./quadmesh_paved.mjs";
//   const module = await loadModule(await fetch("quadmesh_paved.wasm"));
//   const mesh = createMesher(module);
//   const out = mesh({ loops: [{ points: [[0, 0], [40, 0], [40, 20], [0, 20]] }], options: { targetSize: 4 } });
//
// loadModule returns an object with the Emscripten-style surface (_malloc, _free,
// HEAPU8/HEAPU32/HEAPF64, UTF8ToString and _mq_* functions), so the quadtree mesher's
// own createMesher(module) works with it unchanged. Results own their data.

export async function loadModule(source) {
  let bytes = source;
  if (typeof Response !== "undefined" && source instanceof Response) bytes = await source.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  const memory = ex.memory;
  const decoder = new TextDecoder();
  const module = {
    get HEAPU8() { return new Uint8Array(memory.buffer); },
    get HEAPU32() { return new Uint32Array(memory.buffer); },
    get HEAPF64() { return new Float64Array(memory.buffer); },
    UTF8ToString(ptr) {
      const heap = new Uint8Array(memory.buffer);
      let end = ptr;
      while (heap[end]) end++;
      return decoder.decode(heap.subarray(ptr, end));
    },
    _malloc: ex.malloc,
    _free: ex.free,
  };
  for (const [name, fn] of Object.entries(ex)) {
    if (name.startsWith("mq_")) module[`_${name}`] = fn;
  }
  return module;
}

const OPTION_KEYS = {
  targetSize: 0, maxRefinementLevel: 1, localSizingPromotion: 2,
  featureAngle: 3, chordTolerance: 4, finiteElementSizing: 5,
  elementsPerCircle: 6, enableSmoothing: 7, smoothingIterations: 8,
  absoluteTolerance: 9, relativeTolerance: 10,
  growthRate: 64, enableCleanup: 65,
};

export function createMesher(module) {
  return function mesh({ loops, options = {} }) {
    const allocations = [];
    let context = 0, domain = 0, config = 0, result = 0, report = 0;
    const alloc = bytes => {
      const ptr = module._malloc(Math.max(bytes, 8));
      if (!ptr) throw new Error("quadmesh allocation failed");
      allocations.push(ptr);
      return ptr;
    };
    const u32 = ptr => module.HEAPU32[ptr >>> 2];
    const check = status => {
      if (status) {
        const error = new Error(module.UTF8ToString(module._mq_context_last_error(context)));
        error.status = status;
        throw error;
      }
    };
    const doubles = data => {
      const ptr = alloc(data.length * 8);
      module.HEAPF64.set(data, ptr >>> 3);
      return ptr;
    };
    const copy = (fn, count, width, Type) => {
      const ptr = alloc(count * width * Type.BYTES_PER_ELEMENT);
      check(fn(context, result, ptr, count));
      return new Type(module.HEAPU8.buffer, ptr, count * width).slice();
    };
    try {
      const out = alloc(8);
      check(module._mq_context_create(out)); context = u32(out);
      check(module._mq_domain_create(context, out)); domain = u32(out);
      check(module._mq_options_create(context, out)); config = u32(out);
      for (const [name, value] of Object.entries(options)) {
        if (!(name in OPTION_KEYS)) throw new Error(`Unknown meshing option: ${name}`);
        check(module._mq_options_set(context, config, OPTION_KEYS[name], Number(value)));
      }
      for (const [index, loop] of loops.entries()) {
        const role = { outer: 0, hole: 1, control: 2, curve: 3 }[loop.role ?? (index === 0 ? "outer" : "hole")];
        if (role === undefined) throw new Error("Unknown loop role");
        check(module._mq_domain_add_loop(context, domain, role, doubles(loop.points.flat()), loop.points.length, out));
        const id = u32(out);
        if (loop.targetSize !== undefined || loop.sizingSamples) {
          const samples = loop.sizingSamples ?? [];
          check(module._mq_domain_set_loop_sizing(context, domain, id, loop.targetSize ?? 0,
            doubles(samples.flat()), samples.length));
        }
        if (loop.vertexKinds) {
          const kinds = alloc(loop.vertexKinds.length);
          module.HEAPU8.set(loop.vertexKinds, kinds);
          check(module._mq_domain_set_vertex_kinds(context, domain, id, kinds, loop.vertexKinds.length));
        }
        for (const run of loop.fixedRuns ?? []) {
          const start = run.start ?? [0, 0], end = run.end ?? [0, 0];
          check(module._mq_domain_add_fixed_run(context, domain, id, start[0], start[1], end[0], end[1],
            doubles(run.nodes.flat()), run.nodes.length, Number(Boolean(run.closed)), 0));
        }
      }
      const outReport = alloc(8);
      check(module._mq_mesh_generate_with_options(context, domain, config, out, outReport));
      result = u32(out); report = u32(outReport);
      const nodeCount = module._mq_mesh_node_count(result), quadCount = module._mq_mesh_quad_count(result);
      const nodes = copy(module._mq_mesh_copy_nodes, nodeCount, 2, Float64Array);
      const quads = copy(module._mq_mesh_copy_quads, quadCount, 4, Uint32Array);
      const quality = copy(module._mq_mesh_copy_quad_quality, quadCount, 2, Float64Array);
      const readRecords = (countFn, copyFn, stride, decode) => {
        const count = countFn(result);
        const buffer = alloc(count * stride);
        check(copyFn(context, result, buffer, count));
        const view = new DataView(module.HEAPU8.buffer);
        return Array.from({ length: count }, (_, i) => decode(view, buffer + i * stride));
      };
      const boundaryNodes = readRecords(module._mq_mesh_boundary_node_count, module._mq_mesh_copy_boundary_nodes, 32,
        (v, p) => ({
          node: v.getUint32(p, true), loop: v.getUint32(p + 4, true), segment: v.getUint32(p + 8, true),
          fixedRun: v.getInt32(p + 12, true), fixedNode: v.getInt32(p + 16, true), parameter: v.getFloat64(p + 24, true),
        }));
      const boundaryEdges = readRecords(module._mq_mesh_boundary_edge_count, module._mq_mesh_copy_boundary_edges, 40,
        (v, p) => ({
          nodes: [v.getUint32(p, true), v.getUint32(p + 4, true)], loop: v.getUint32(p + 8, true),
          segment: v.getUint32(p + 12, true), fixedRun: v.getInt32(p + 16, true), fixedEdge: v.getInt32(p + 20, true),
          parameters: [v.getFloat64(p + 24, true), v.getFloat64(p + 32, true)],
        }));
      const summaryPtr = alloc(40);
      check(module._mq_validation_report_quality(report, summaryPtr));
      const s = new Float64Array(module.HEAPU8.buffer, summaryPtr, 5).slice();
      const summary = { minAngle: s[0], maxAngle: s[1], minScaledJacobian: s[2], minEdgeRatio: s[3], maxBoundaryDeviation: s[4] };
      let paved;
      if (module._mq_validation_report_paved_quality) {
        const p = alloc(88);
        check(module._mq_validation_report_paved_quality(report, p));
        const v = new DataView(module.HEAPU8.buffer);
        const f = k => v.getFloat64(p + 8 * k, true);
        paved = {
          minAngle: f(0), maxAngle: f(1), minScaledJacobian: f(2), p5ScaledJacobian: f(3),
          shareScaledJacobian05: f(4), irregularShare: f(5), minEdgeRatio: f(6), maxBoundaryDeviation: f(7),
          quadCount: v.getUint32(p + 64, true), nodeCount: v.getUint32(p + 68, true),
          interiorNodes: v.getUint32(p + 72, true), irregularNodes: v.getUint32(p + 76, true),
          inverted: v.getUint32(p + 80, true), allQuads: v.getUint8(p + 84) === 1,
          conforming: v.getUint8(p + 85) === 1, coversDomain: v.getUint8(p + 86) === 1, fixedKept: v.getUint8(p + 87) === 1,
        };
      }
      const issues = Array.from({ length: module._mq_validation_report_issue_count(report) },
        (_, i) => module.UTF8ToString(module._mq_validation_report_issue(report, i)));
      return { nodes, quads, quality, boundaryNodes, boundaryEdges, summary, report: paved,
        valid: Boolean(module._mq_validation_report_ok(report)), issues };
    } finally {
      if (report) module._mq_validation_report_destroy(report);
      if (result) module._mq_mesh_destroy(result);
      if (config) module._mq_options_destroy(config);
      if (domain) module._mq_domain_destroy(domain);
      if (context) module._mq_context_destroy(context);
      for (const ptr of allocations) module._free(ptr);
    }
  };
}
