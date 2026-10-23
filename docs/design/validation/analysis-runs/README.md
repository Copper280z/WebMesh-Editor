# Browser-authored analysis cases and retained run

23 October 2026. Open `analysis.webmesh` through **Open → Open project**, then **Post-process → Analysis cases & runs → Battery and payload validation → Show run results**. The saved project contains the model, owned supports/accelerations/cases, exact solver input, solver identity, F06, log, diagnostics and input/model/result digests. No running solver is needed to reopen its completed results.

The underlying model is the preceding mixed shell/solid battery/payload fixture: 24 HEX8 solids, 50 shell-web quads, 12 embedded shared-node shell quads, a 1 kg offset payload and a 500 g battery. It is a workflow test, not the PLA rover or a mesh-converged prediction. Material and overlap mass are retained; total modeled mass is 2.6304 kg.

In the browser, the following were authored using reviewed project transactions:

- Root translations: SPC1 SID 1, DOFs 123 on the 21 GRIDs at X=0.
- Gravity: GRAV SID 1, basic acceleration (0, 0, −9806.65) mm/s².
- Lateral 0.5g: GRAV SID 2, basic acceleration (0, 4903.325, 0) mm/s².
- Two named SOL 101 cases referencing those sets, with DISPLACEMENT, SPCFORCES, STRESS and OLOAD.
- A MYSTRAN run with explicit AUTOSPC=YES and the displayed compatibility projection. The browser submitted the deck directly to the local solver service; no external script authored its supports or case control.

Both cases completed. Epsilon estimates were −4.13537e−13 and −1.866994e−14. The product's basic-coordinate OLOAD/SPC force-and-moment check passed. A separate integration of solid, shell and CONM2 mass also agrees with all six reaction resultants within 0.02 N or N mm; see `equilibrium.json`. Expected vertical reaction is 25.79541216 N and lateral reaction is −12.89770608 N.

Run `python3 docs/design/validation/analysis-runs/verify.py` to repeat the independent check against the retained browser results. `model.bdf`, `model.F06` and `solver.log` are exact copies of the archived run fields. The check uses the preceding fixture's geometric mass integration, not the solver's OLOAD table.

Manual verification also covers case selection, stress contours and deformation, project save/reopen, a changed gravity definition, undo, and explicit opening of the captured run model. Regressions cover malformed saved runs, missing or unknown subcases, manual-import provenance, cancellation/failure, motor-shaft support references, named-region remeshing, duplicate GRAV SIDs and all four writer formats. Browser-discovered exporter ordering and indented case-control issues were fixed before completion.

External solver investigations remain in the ignored local `solver-bug-reports/` directory. They are not part of this fixture.
