# Implementation 13: reusable assembly connections and rover analysis

23 October 2026 · branch `codex/project-core-foundation`

## Actionable plan

1. Compose the existing point, RBE2/CBUSH attachment and concentrated-mass actions into a reusable connection recipe. Add a direct RBE2 action for the driven region. Bind each repeat to named mounting/driven regions and either a reusable coordinate frame or a live part placement. Local point positions and mass offsets follow that placement.
2. Provide a recipe/repeat editor, explicit per-repeat overrides, revert, repeat, detach and reviewed removal. Preserve point and connector identities through recipe edits and compatible remeshing. Regenerate all affected repeats in the same atomic review; reject overlapping dependent DOFs and missing regions. Validate saved generated cards against their recipes at the engine boundary.
3. Complete the existing two-part rover fixture: restore the previously browser-prepared chassis sheets, generate its owned shell mesh, bind four motors to the live wheels, add 500 g battery and 1 kg payload with its COM 200 mm above the floor, support the wheel contact patches, and define gravity and lateral cases. Use provisional isotropic PLA and 350 g locked motors.
4. Test composition, local transforms/reflections, overrides/revert, recipe propagation, stable IDs, remeshing, detached edits, failure atomicity, persistence and exported references. Run the full JavaScript suite.
5. Use the browser to inspect/edit the assembly and launch MYSTRAN. Verify mass, connected components, displacement coverage, reactions and solver diagnostics. Exercise named postprocessing fields and saved-run reopening. Save the runnable project, solver evidence, verifier and limitations in the repository. Keep external solver defects separately under ignored `solver-bug-reports/`.

## Scope

This milestone implements a reusable two-region connection recipe: mounting-region RBE2, spring to a shaft/reference point, optional point mass and optional driven-region RBE2. It is a composition of public actions, not a general scripting language. Part placements transform local point coordinates; rectangular stiffness directions remain explicitly represented by CORD2R. A reflected placement produces a right-handed stiffness frame while reflected point/mass positions retain their physical locations.

Explicit node regions still require repair when their source mesh identities change. CAD edge regions and instance-scoped regions re-resolve through compatible remeshing. This milestone does not add CAD topology matching or automatic contact.

## Outcome and validation

Implemented on the existing branch. `app/assembly-project.js` composes the public attachment, point-mass and rigid actions; `app/assembly-workspace.js` provides recipe/repeat editing, reviewed overrides and removal. A shared recipe owns one PBUSH; a stiffness override owns a separate PBUSH. Placement changes update points, mass offsets and a right-handed CORD2R. Recipe changes and compatible remeshing regenerate dependent connections atomically, preserving IDs. Saved generated cards are checked against the recipe at the ownership boundary. Direct RBE2 actions participate in selection repair.

The browser-meshed chassis and four live wheels now form one connected, runnable model. The [validation report and artifacts](validation/assembly-connections/README.md) retain the project, exact deck, solver output, screenshots, reproducible public-action builder and independent verifier. MYSTRAN completed gravity and gravity-plus-payload-lateral cases. Both pass numerical-indicator and normalized reaction-balance checks; the report preserves raw residuals and the stricter net-resultant comparison. Every active GRID has displacement output, every shell has stress output, and all four CBUSH elements have force output. Saving, reopening, named-case selection, contours and deformation animation were exercised in the browser.

Validation: 494 JavaScript tests pass in an isolated checkout containing this milestone, with unrelated working-tree edits excluded. The rover verifier checks ownership and run hashes, source exclusions, all card counts, connectivity, independent mass integration, AUTOSPC translations, equilibrium and parsed results. The public-action builder reproduces all 21,627 owned card values and every saved object definition; browser override/revert exercises retain the same final model.

Acceptance testing also fixed:

- Quadratic-time owned-card restoration: snapshots now replace cards in batches while preserving ordinary cards.
- `FORCE = ALL` case control being misread as a bulk FORCE entry.
- MYSTRAN free-field width, mixed SPC1 ranges and redundant CBUSH orientation with explicit CID.
- CBUSH recovery components being incorrectly reported as von Mises stress; the shell contour now has the correct 4.20160 MPa maximum.
- A contour legend offset that placed it over the model.
- Reference geometry appearing in the solved assembly without an explicit display choice. **Show analysis-excluded mesh** is now an analyst-controlled results option. It preserves manual visibility and solver participation, and can show or hide the source wheel. Rendering, edges, labels and picking use the temporary display mask; shared active nodes remain available.

## Remaining scope

Recipes are stored in the project; there is no external recipe library, general recipe-language editor, automatic mating, contact, bolt preload or nonlinear solver setup. The motor recipe is a two-point linear connection with diagonal stiffness and translational dependent RBE2 DOFs. Making it independent copies a recipe; it does not flatten the connection to anonymous cards.

CAD topology replacement still requires explicit repair. Contact patch node selections require repair after a wheel remesh. The rover's LOAD combination uses the ordinary card workflow. SPC reactions are retained in the F06 and balance report; dedicated SPC reaction contours and richer result probes remain future work. The full stage/tree/dock redesign, general selection replay and the other unimplemented original design rules remain separate milestones.
