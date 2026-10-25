# WebMesh Studio setup and build requirements

WebMesh has three separately deployable pieces: the browser application, a local Python CAD/solver service, and two native face-meshing libraries. The JavaScript is served directly from this checkout. There is no frontend compilation, npm dependency installation, database, or separate web framework.

## Requirements by capability

| Capability | Requirements |
| --- | --- |
| Edit Nastran decks, create primitives, display meshes and results | A modern browser with WebGL and JavaScript; the bundled `vendor/three-runtime.js` is included |
| Serve the application locally | Python 3; the HTTP service uses the standard library |
| Import STEP/IGES/BREP, prepare geometry, generate mapped HEX8/HEX20 | Python packages `cadquery-ocp` (OpenCASCADE bindings) and `numpy`; the local service |
| Recombined or quadtree quad shells | The CAD requirements above plus the `quadmesh` shared library |
| Paved quad shells and its control-curve support | The CAD requirements above plus the `quadmesh_paved` shared library |
| Gmsh triangle/tetrahedral, Gmsh quad/sweep/layered meshing, STL import | Optional Gmsh executable and Python module available to the service |
| Run an analysis from the workspace | A separately built MYSTRAN or Vibestran executable configured on the service |
| Run JavaScript tests | Node.js; npm is optional shorthand for the commands below |
| Build the native meshers | Zig **0.17.0**, including its C/C++ toolchain; platform development headers/SDK as needed |

The environment used to validate this setup is macOS with Python **3.14.7**, `cadquery-ocp` **8.0.1.1.0**, NumPy **2.4.3**, Node **24.10.0**, and Zig **0.17.0**. These are tested versions, not a claim that every other version is incompatible. The repository does not currently declare or test a minimum Python version. Choose a Python version for which your platform has a `cadquery-ocp` wheel. The Zig build files explicitly require 0.17.0 and use its newer build API; older Zig releases are not interchangeable.

## 1. Prepare Python

Run commands from the repository root, the directory containing `server.py` and `WebMeshEditor.html`:

```sh
cd /path/to/WebMesh-Editor
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install numpy cadquery-ocp
python -c "import sys, numpy, OCP; print(sys.executable); print(numpy.__version__); print(OCP.__version__)"
```

For the exact package versions validated here, substitute:

```sh
python -m pip install numpy==2.4.3 cadquery-ocp==8.0.1.1.0
```

If pip cannot find a compatible binary wheel, use a supported Python/platform combination before attempting a source build of OpenCASCADE. Installing the full CadQuery application is not required; WebMesh imports `OCP` directly.

Activate the virtual environment in every terminal used to start the service or run Python tests. CAD workers use the service's Python interpreter, so installing packages in a different interpreter will not enable them. `npm start` invokes `python3`, which also follows the active environment's `PATH`.

On Windows, virtual environment activation is `.venv\Scripts\Activate.ps1` in PowerShell. The examples below otherwise use POSIX shell syntax. These setup and build commands were verified on macOS; Windows and Linux have not been verified to the same extent.

## 2. Build both native face meshers

Install Zig 0.17.0 and put `zig` on `PATH`. On macOS, install the Xcode command-line tools if the compiler reports a missing platform SDK (`xcode-select --install`). On Linux, a working system C development environment may be needed. Zig compiles the C++20 mesher itself; a separate CMake build is not used here.

```sh
zig version
zig build
```

Run this at the repository root. `build.zig` builds both local dependencies, `meshers/quadmesh` and `meshers/paved`, and installs their shared libraries:

| Platform | Expected outputs |
| --- | --- |
| macOS | `zig-out/lib/libquadmesh_capi.dylib`, `zig-out/lib/libquadmesh_paved.dylib` |
| Linux | `zig-out/lib/libquadmesh_capi.so`, `zig-out/lib/libquadmesh_paved.so` |
| Windows | `quadmesh_capi.dll`, `quadmesh_paved.dll` under `zig-out/bin` or `zig-out/lib` |

The default optimization is `fast`. A debug build is `zig build -Doptimize=debug`. Build for the architecture of the Python process that will load the libraries. A library compiled for another CPU/OS cannot be loaded just because the filename is correct. The standard Zig `-Dtarget=...` option is available for explicit cross builds, but the resulting libraries must run on the target system.

No native build is needed for the browser's mapped hex mesher. Without the quad libraries, those shell meshing choices are unavailable while core CAD preparation and mapped hex meshing remain usable.

`quadmesh_bridge.py` searches the root `zig-out/lib` and `zig-out/bin` directories. To use libraries built elsewhere:

```sh
export WEBMESH_QUADMESH_LIB=/absolute/path/to/libquadmesh_capi.dylib
export WEBMESH_PAVED_LIB=/absolute/path/to/libquadmesh_paved.dylib
```

Use `.so` or `.dll` on the appropriate platform. `WEBMESH_QUADMESH_BINDING` can override the Python binding file; normally it is loaded directly from `meshers/quadmesh/bindings/python/quadmesh.py`. Keep bindings and libraries compatible. The loader checks ABI support; control curves require ABI 0.3 support, which the paved library provides in this checkout.

## 3. Optional Gmsh plugin

Core CAD preparation does **not** require Gmsh. For its optional operations, install a Gmsh distribution that supplies both the executable and Python API. One package-based route is:

```sh
python -m pip install gmsh
gmsh --version
python -c "import gmsh; print(gmsh.__version__)"
```

If the executable is not on `PATH`, pass its absolute path using `--gmsh`. The plugin also checks the Homebrew binding directories listed in `cad_gmsh_plugin.py` when the module is not on Python's path. For another SDK installation, make its `gmsh.py` importable in the service's Python environment. A Gmsh installation may require platform graphics/system libraries even when invoked without a window; resolve missing-library errors for that distribution.

WebMesh isolates Gmsh operations in their own processes. Do not combine direct Gmsh imports and the OCP kernel in one ad hoc test process: their bundled native OpenCASCADE builds can conflict. `WEBMESH_BLOCK_GMSH=1` deliberately disables the plugin and is useful for checking the core-only configuration.

Gmsh **4.15.2-git** was used for validation. Check the executable and Python API with the commands above to verify your installation.

## 4. Start the local service

```sh
python3 server.py
```

Open **http://127.0.0.1:8765/WebMeshEditor.html**. The default port is 8765 and the server binds to `127.0.0.1`. To choose another port or Gmsh binary:

```sh
python3 server.py --port 8798 --gmsh /absolute/path/to/gmsh
```

Equivalent npm shorthand is `npm start -- --port 8798`. No `npm install` is required: `package.json` declares scripts but no dependencies. Keep the terminal running; Ctrl+C stops that service.

Check the actual runtime configuration:

```sh
curl http://127.0.0.1:8765/api/health
```

The response separately reports `cad`, `plugins.gmsh`, `quadmesh.libraries`, meshing choices, limits and configured `solvers`. Check this endpoint instead of assuming that successful HTML loading means CAD, native shells, or solvers are available. The UI also displays service/plugin failures.

Opening `WebMeshEditor.html` directly can be useful for standalone FE editing, but local CAD and solver calls need the HTTP service. For development and complete workspace workflows, use the served URL.

## 5. Configure MYSTRAN or Vibestran

Solvers are not downloaded or built by WebMesh. Build the desired solver in its own repository using that project's toolchain and build instructions, then supply a runnable executable. WebMesh does not require a Fortran compiler or CMake unless you also choose to build a solver yourself.

```sh
python3 server.py --port 8765 \
  --solver mystran=/absolute/path/to/mystran \
  --solver vibestran=/absolute/path/to/vibestran
```

You can instead set `WEBMESH_MYSTRAN` and/or `WEBMESH_VIBESTRAN`. Discovery order is the explicit `--solver` configuration, the corresponding environment variable, then a same-named executable on `PATH`.

Replace the example paths with your installed solver executables. Each executable must have execute permission, match the host architecture and find any of its own runtime libraries. Verify `available: true` in `/api/health`, then use the workspace's named SOL 101 case and Run controls. Solver jobs run in temporary working directories; save the project to retain the deck, run record and imported results.

## 6. Verify the build (optional)

Use Node 24 for the tested JavaScript environment. There is no browser automation package to install for the repository test suite.

```sh
npm test
npm run test:cad
npm run test:meshers
```

The direct commands are:

```sh
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
zig build test
```

JavaScript CAD integration tests start their own loopback servers and use the installed Python kernel. They skip kernel-specific workflows if OCP is unavailable. `PYTHON=/absolute/path/to/python` selects the interpreter used by those JavaScript integration helpers. Python tests requiring optional Gmsh functionality skip when the plugin is absent. Read the test summary for skips; a green run without CAD dependencies is not full CAD coverage.

`zig build test` runs the C++ mesher's GoogleTest/Python binding suites and the paved mesher's unit, Python and WebAssembly binding suites. It needs Python and Node in addition to Zig. The first C++ test build downloads **GoogleTest v1.17.0** using the URL and hash in `meshers/quadmesh/build.zig.zon`; an ordinary `zig build` does not fetch it. Allow access to that dependency or populate the Zig cache before testing offline. Zig needs writable local/global cache directories.

## Persistence, rebuilding and troubleshooting

- **Save before stopping a service with active work.** Runtime CAD sessions belong to that service process. Project saves include portable CAD checkpoints, drafts and executable CAD undo/redo. A browser refresh alone is not a substitute for saving.
- **Use the same port while editing a project.** Another server has a different session store. Saved projects can restore to it, but in-memory session IDs cannot simply migrate.
- **Restart for backend or native-library changes.** A service may retain imported modules or loaded libraries. Save drafts first; do not terminate a service that another active workspace still needs. Frontend changes normally require a page reload after saving.
- **CAD unavailable:** verify OCP/NumPy imports with the exact Python executable that started the service. Check the health response and terminal error.
- **Quad mesher unavailable:** run `zig build` at the root; inspect the library paths and ABI errors in the health response. Check architecture and binding/library compatibility.
- **Zig cache permission denied:** use a writable compiler cache. In a restricted development environment, grant the build access to its cache or set `ZIG_GLOBAL_CACHE_DIR` to a writable directory. This is separate from a source compilation failure.
- **Port already in use:** retain the existing server if it has active drafts, or choose a free `--port`. Do not start a second server on the same port.
- **Restore fails:** keep the saved project and inspect the error. Failed candidates are aborted transactionally; the current project/draft should remain available. An older running server may need an upgrade before it understands portable checkpoints.
- **Solver unavailable or fails:** check its configured executable and native runtime dependencies, then inspect the saved run log.

Generated `.venv/`, `node_modules/`, `.zig-cache/`, `zig-out/`, Python caches and `test-results/` are local build/runtime artifacts. `WEBMESH_CAD_CACHE=0` disables the geometry cache for diagnosis. It does not turn off saved project history or server-session ownership.
