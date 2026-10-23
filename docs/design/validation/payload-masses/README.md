# Payload and mass validation

Browser-authored fixtures and solver evidence for [Implementation 08](../../implementation-08-payload-masses.md), 23 October 2026.

## Saved projects

- `payloads-initial.webmesh`: STEP-based mixed mesh, two-row shared-node embedded interface, a 500 g battery and a 1 kg payload with a 200 mm COM offset. The payload uses two disjoint named regions with relative influences 1 and 2.
- `payloads.webmesh`: the same project after independently remeshing the web from 54 recombined quads to 50 paved quads. Solid and embedded-strip cards, COM positions, masses and connection IDs are preserved. This is the solver fixture.
- `direct-actions.webmesh`: additionally contains the browser-authored standalone point GRID 857, 350 g CONM2 389 and RBE3 390. It demonstrates the public tools separately; it is not the model used for the solver checks.

Open these with **Open → Open project**. They include source CAD and editable ownership definitions. The small steel block/web model is a workflow fixture, not the rover or an engineering acceptance model.

## Reproduce the analysis

From the repository root:

```sh
python3 docs/design/validation/payload-masses/verify.py \
  --solver ~/Documents/vibe-tran/MYSTRAN/Binaries/mystran \
  --output /tmp/webmesh-payload-mystran
```

The harness starts with the browser-exported deck, fixes translations at X=0 and adds static gravity (−Z, 1 g) and lateral acceleration (+Y, 0.5 g) cases. Structural density and intentional overlapping shell mass remain active. It independently integrates structural mass and computes six resultant reactions, including moments about the basic origin and payload offsets. Shell mass uses the solver's equal nodal lumping convention. Tolerance is 0.02 N or N·mm; the solver accuracy indicator must be below 1e−8.

The installed MYSTRAN binary needs a compatibility projection: float tokens limited to 11 significant digits, empty continuations removed and HEX8 `PSOLID IN=2`. The harness records the actual projected deck. These transformations are explicit test setup; the application does not yet offer solver profiles or immutable run snapshots.

The `mystran/` folder retains its exact input, F06, console log and `results.json`. Only trailing output padding has been removed. **MYSTRAN passes both cases.** No changes were made to the external solver repository.

## Browser postprocessing

Restore `payloads.webmesh`, choose **Post-process → Import MYSTRAN results**, and select `mystran/payloads.F06`. Open result controls. Both subcases, deformation, displacement magnitude and stress contours were manually exercised. Subcase 1 displacement magnitude reaches `6.70230e-4` mm; subcase 2 reaches `2.13714e-4` mm. The saved [screenshot](../../images/payload-results.png) shows subcase 2 von Mises stress with an amplified deformed shape.

The solver harness supplies the case control, supports and acceleration loads; those are not authored analysis-case objects in the saved project. Results currently attach by node/element IDs. Detecting stale model/result pairs and retaining run identity are explicitly the next milestone.

## Automated validation

The isolated intended commit passed **428 tests, zero failures/skips** in 42.9 s using `npm test` and the repository's existing quadmesh/paved dynamic libraries. This excludes unrelated pre-existing viewport and result-reset changes. New coverage exercises public actions, mass/inertia validation, weighted groups, remeshing, ownership/dependent DOFs, export/parser formats, history, persistence and combined structural/rigid previews.
