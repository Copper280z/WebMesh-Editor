# Getting started with WebMesh Studio

WebMesh Studio runs in your browser and uses a local server to import CAD, generate meshes, and run analyses. This guide takes you from a downloaded copy of the project to your first mesh.

## What you need

- A desktop browser with WebGL enabled.
- Python 3 with `pip` and `venv`.
- Zig **0.17.0** to build the included quad meshers. Add the Zig executable to your system's `PATH` so you can run `zig` from a terminal.
- A downloaded or cloned copy of this repository, including its `app`, `styles`, `vendor`, and `meshers` folders.

On macOS, the native build also needs the Xcode command-line tools. Install them if needed with:

```sh
xcode-select --install
```

On Linux, install your distribution's C/C++ development tools and system headers before building.

Gmsh and a solver are optional. You can add them after completing the basic setup below.

## 1. Install the Python dependencies

Open a terminal in the WebMesh project folder—the folder containing `server.py` and `WebMeshEditor.html`. Create a virtual environment and install NumPy and the OpenCASCADE Python bindings.

**macOS or Linux**

```sh
cd /path/to/WebMesh-Editor
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install numpy cadquery-ocp
```

**Windows PowerShell**

```powershell
cd C:\path\to\WebMesh-Editor
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install numpy cadquery-ocp
```

Keep this terminal open for the next steps. The virtual environment keeps WebMesh's Python packages separate from other applications.

## 2. Build the meshers

From the same project folder, run:

```sh
zig version
zig build
```

The version command should report `0.17.0`. The build creates the native libraries used by the Paved, Recombined, and Quadtree shell meshers in `zig-out`. WebMesh finds these libraries automatically; leave that folder inside the project.

## 3. Launch WebMesh

With the virtual environment still active, run:

```sh
python server.py
```

Open [WebMesh Studio at http://127.0.0.1:8765/WebMeshEditor.html](http://127.0.0.1:8765/WebMeshEditor.html).

Keep the terminal running while you use WebMesh. To stop the server, save your project and press **Ctrl+C** in the terminal.

The next time you launch WebMesh, open a terminal in the project folder, activate the environment, and start the server:

```sh
source .venv/bin/activate
python server.py
```

On Windows, use `.\.venv\Scripts\Activate.ps1` instead of the `source` command.

## 4. Make your first mesh

The included [block example](examples/block.step) is a simple starting point for solid meshing.

1. In **Parts**, choose **Add CAD part** and open `examples/block.step`.
2. Open the part's **Prepare / mesh** controls. The block is ready for mapped hex meshing without geometry preparation.
3. In **Size**, set an element size of `10`.
4. In **Mesh**, choose **Mapped hex**, preview the mesh, then review and apply it to the model.
5. Choose **Save project** to download a `.webmesh` file you can reopen later.

Use **Open → Open project** to resume a saved project. To work with an existing Nastran model, choose **Open → Open Nastran deck** and select its `.bdf` or `.dat` file.

**Save project** preserves your editable workspace. **Export deck** produces solver input. Before solving your own model, check its material, sections, loads, supports, and units.

## Add optional features

### Gmsh meshing

Install Gmsh to enable tetrahedral meshes, triangle shells, additional sweep methods, and STL import. Stop the server, then run these commands with the virtual environment active:

```sh
python -m pip install gmsh
gmsh --version
python -c "import gmsh; print(gmsh.__version__)"
python server.py
```

If you installed Gmsh elsewhere, you can specify the executable when launching WebMesh:

```sh
python server.py --gmsh "/path/to/gmsh"
```

The Gmsh Python package must also be available in the environment used to launch WebMesh.

### MYSTRAN or Vibestran

To run analyses from WebMesh, install or build MYSTRAN or Vibestran using that solver's installation instructions. Then stop WebMesh and restart it with the path to your solver executable:

```sh
python server.py --solver mystran="/path/to/mystran"
```

For Vibestran, use `--solver vibestran="/path/to/vibestran"`. You can supply both `--solver` options to make both solvers available.

In WebMesh, use **Solve** to prepare and run a static analysis, then **Results** to inspect its output. Save the project afterward to retain the run and results. You can also import an existing MYSTRAN `.F06` file from **Results → Import F06** after opening its matching model.

## Troubleshooting

| Problem | What to try |
| --- | --- |
| `python`, `py`, or `zig` is not found | Check that the program is installed and on `PATH`, then open a new terminal. |
| Python packages will not install | Activate `.venv` and upgrade `pip`. If `cadquery-ocp` has no compatible package for your Python version or platform, choose a Python version for which a prebuilt package is available and recreate the environment. |
| CAD import is unavailable | Activate `.venv`, run `python -m pip install numpy cadquery-ocp`, and restart the server from that terminal. |
| A quad mesher is unavailable | Run `zig build` from the project folder and restart the server. The libraries must be built for the same operating system and CPU architecture as Python. |
| The browser cannot connect | Check that `python server.py` is still running and use the URL printed in its terminal. |
| Port 8765 is already in use | Open the existing WebMesh server, or launch with `python server.py --port 8766` and use port 8766 in the browser URL. |
| A solver is unavailable | Check the executable path supplied with `--solver` and confirm that the solver runs from a terminal. |

For more detail about missing components, open the [local service status page](http://127.0.0.1:8765/api/health). It lists CAD, meshers, Gmsh, and solvers with their availability and any loading errors.

After updating WebMesh, save your project, stop the server, run `zig build`, and launch the server again. Refresh the browser to load the updated application.
