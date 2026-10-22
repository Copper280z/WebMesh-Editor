// Pass an initialized Emscripten module. Results own their data and remain
// valid after another call grows the module's memory.
export function createMesher(module) {
  if (module._mq_abi_version() < (2 << 12)) throw new Error("quadmesh ABI 0.2 or newer is required");
  const keys = {
    targetSize: 0, maxRefinementLevel: 1, localSizingPromotion: 2,
    featureAngle: 3, chordTolerance: 4, finiteElementSizing: 5,
    elementsPerCircle: 6, enableSmoothing: 7, smoothingIterations: 8,
    absoluteTolerance: 9, relativeTolerance: 10,
  };
  return function mesh({ loops, options = {} }) {
    const pairs = (values, label) => {
      if (!Array.isArray(values) || values.some(p => !Array.isArray(p) || p.length !== 2
          || p.some(v => typeof v !== "number" || !Number.isFinite(v))))
        throw new Error(`${label} must contain finite numeric pairs`);
      return values.flat();
    };
    const allocations = [];
    let context = 0, domain = 0, config = 0, result = 0, report = 0;
    const alloc = bytes => {
      const ptr = module._malloc(Math.max(bytes, 8));
      if (!ptr) throw new Error("quadmesh allocation failed");
      allocations.push(ptr);
      return ptr;
    };
    const pointer = ptr => module.HEAPU32[ptr / 4];
    const check = status => {
      if (status) throw new Error(module.UTF8ToString(module._mq_context_last_error(context)));
    };
    const doubles = data => {
      const ptr = alloc(data.length * 8);
      module.HEAPF64.set(data, ptr / 8);
      return ptr;
    };
    const copy = (fn, count, width, Type) => {
      const ptr = alloc(count * width * Type.BYTES_PER_ELEMENT);
      check(fn(context, result, ptr, count));
      return new Type(module.HEAPU8.buffer, ptr, count * width).slice();
    };
    try {
      const out = alloc(8);
      check(module._mq_context_create(out)); context = pointer(out);
      check(module._mq_domain_create(context, out)); domain = pointer(out);
      check(module._mq_options_create(context, out)); config = pointer(out);
      for (const [name, value] of Object.entries(options)) {
        if (!Object.hasOwn(keys, name)) throw new Error(`Unknown meshing option: ${name}`);
        check(module._mq_options_set(context, config, keys[name], Number(value)));
      }
      for (const [index, loop] of loops.entries()) {
        const role = { outer: 0, hole: 1, control: 2 }[loop.role ?? (index === 0 ? "outer" : "hole")];
        if (role === undefined) throw new Error("Unknown loop role");
        const points = doubles(pairs(loop.points, "Loop points"));
        check(module._mq_domain_add_loop(context, domain, role, points, loop.points.length, out));
        const id = pointer(out);
        if (loop.targetSize !== undefined || loop.sizingSamples) {
          const samples = loop.sizingSamples ?? [];
          check(module._mq_domain_set_loop_sizing(context, domain, id, loop.targetSize ?? 0,
            doubles(pairs(samples, "Sizing samples")), samples.length));
        }
        if (loop.vertexKinds) {
          if (loop.vertexKinds.some(k => !Number.isInteger(k) || k < 0 || k > 2))
            throw new Error("Vertex kinds must be 0, 1, or 2");
          const kinds = alloc(loop.vertexKinds.length);
          module.HEAPU8.set(loop.vertexKinds, kinds);
          check(module._mq_domain_set_vertex_kinds(context, domain, id, kinds, loop.vertexKinds.length));
        }
        for (const run of loop.fixedRuns ?? []) {
          const start = run.start ?? [0, 0], end = run.end ?? [0, 0];
          pairs([start, end], "Run positions");
          if (![start, end].every(p => Number.isInteger(p[0]) && p[0] >= 0
              && p[0] < loop.points.length && p[1] >= 0 && p[1] <= 1))
            throw new Error("Run position is outside its source loop");
          check(module._mq_domain_add_fixed_run(context, domain, id, start[0], start[1], end[0], end[1],
            doubles(pairs(run.nodes, "Fixed nodes")), run.nodes.length, Number(Boolean(run.closed)), 0));
        }
      }
      const outReport = alloc(8);
      check(module._mq_mesh_generate_with_options(context, domain, config, out, outReport));
      result = pointer(out); report = pointer(outReport);
      const nodeCount = module._mq_mesh_node_count(result), quadCount = module._mq_mesh_quad_count(result);
      const nodes = copy(module._mq_mesh_copy_nodes, nodeCount, 2, Float64Array);
      const quads = copy(module._mq_mesh_copy_quads, quadCount, 4, Uint32Array);
      const quality = copy(module._mq_mesh_copy_quad_quality, quadCount, 2, Float64Array);
      const boundaryNodes = [], boundaryEdges = [];
      let count = module._mq_mesh_boundary_node_count(result);
      let buffer = alloc(count * 32);
      check(module._mq_mesh_copy_boundary_nodes(context, result, buffer, count));
      let view = new DataView(module.HEAPU8.buffer);
      for (let i = 0; i < count; ++i) {
        const p = buffer + i * 32;
        boundaryNodes.push({
          node: view.getUint32(p, true), loop: view.getUint32(p + 4, true),
          segment: view.getUint32(p + 8, true), parameter: view.getFloat64(p + 24, true),
          fixedRun: view.getInt32(p + 12, true), fixedNode: view.getInt32(p + 16, true),
        });
      }
      count = module._mq_mesh_boundary_edge_count(result);
      buffer = alloc(count * 40);
      check(module._mq_mesh_copy_boundary_edges(context, result, buffer, count));
      view = new DataView(module.HEAPU8.buffer);
      for (let i = 0; i < count; ++i) {
        const p = buffer + i * 40;
        boundaryEdges.push({
          nodes: [view.getUint32(p, true), view.getUint32(p + 4, true)],
          loop: view.getUint32(p + 8, true), segment: view.getUint32(p + 12, true),
          fixedRun: view.getInt32(p + 16, true), fixedEdge: view.getInt32(p + 20, true),
          parameters: [view.getFloat64(p + 24, true), view.getFloat64(p + 32, true)],
        });
      }
      const summaryPointer = alloc(40);
      check(module._mq_validation_report_quality(report, summaryPointer));
      const summaryValues = new Float64Array(module.HEAPU8.buffer, summaryPointer, 5).slice();
      const summary = Object.fromEntries(
        ["minAngle", "maxAngle", "minScaledJacobian", "minEdgeRatio", "maxBoundaryDeviation"]
          .map((name, i) => [name, summaryValues[i]]));
      const issues = Array.from({ length: module._mq_validation_report_issue_count(report) },
        (_, i) => module.UTF8ToString(module._mq_validation_report_issue(report, i)));
      return { nodes, quads, quality, boundaryNodes, boundaryEdges, summary,
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
