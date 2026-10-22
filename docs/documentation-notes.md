# Notes for the documentation

A running log of things the eventual user documentation needs to cover: behaviour that is not written down yet, and places where `README.md` has fallen behind the code. Add to it as things come up; when an item makes it into the documentation, mark it done or delete it.

## Open

### Surface (Prepare): the first picked face sets the sheet's outline
*2026-10-21 · not documented*

With **Two faces**, **Midway** and **On first** copy the face picked first; **On second** copies the second. The other face only sets the distance, and so the thickness. Pick the side that is whole first. On the rover chassis, the outside face of each wall is whole, while the inside face is broken up where the braces attach. Picking an inside face first gives a sheet with the same gaps. The Surface card does not say this; the user chose to document it rather than change the card.

### Junctions that stop inside a face no longer need a split with Paved
*2026-10-21 · README out of date*

The paved mesher follows a junction that ends partway across a face as an open control curve: a brace standing on a floor. Its library must report ABI 0.3 or later. Recombined and Quadtree can't follow such a junction: that face fails, with a message pointing to **Split sheets along its plane**.

Two places in the README's "Sheets: midsurface and offset models" section are out of date:
- The **Split sheets along its plane** bullet says a split is always needed.
- The rover chassis paragraph includes the split step.

With Paved, the rover meshes without the split: 5,774 CQUAD4, min scaled Jacobian 0.35, one connected piece.

### Two different midsurface tools
*2026-10-21 · not explained*

**Surface → Midway** (Prepare) makes sheet geometry. You can extend it, join it and split it, mix it with solids, and it keeps its own thickness and offset.

**Shell → Place: Midsurface** (Mesh) meshes side A of a solid's wall and moves each node halfway to side B. It suits one plain sheet-metal part. Models where walls meet, such as junctions, braces and mixed thicknesses, need the Surface workflow.

The documentation should say when to use which.

### Reload after updating WebMesh
*2026-10-21 · not documented*

The browser caches WebMesh's scripts. After an update, reload with Cmd-Shift-R (Ctrl-Shift-R on Windows and Linux), or the page keeps running the old code. A server restart also ends every CAD session (see Sessions in the README), so export prepared geometry or save the project first.

### Gmsh becoming an optional plugin
*2026-10-21 · README rewritten on the port branch, not merged yet*

On the port branch (`worktree-agent-a7e11b498bf9ab91c`), OpenCASCADE (through OCP) does all the geometry. Gmsh is an optional plugin that adds tets, triangle (CTRIA3) shells, Gmsh's quad and hex methods and sweeps, and STL import. Without it, **Mesh → Other (Gmsh)** and triangle shells are disabled with a note.

The port's README already describes this. Review its wording when the branch is merged.

### Installing OCP on Homebrew's Python
*2026-10-21 · README may be wrong*

The port's README says `python3 -m pip install numpy cadquery-ocp`. Homebrew's Python refuses system-wide pip installs, so on a Mac this needs `--user` (and possibly `--break-system-packages`), or a virtual environment. The port's own install went to `~/Library/Python/3.14`. The install steps should give a command that works as written.

## Done
