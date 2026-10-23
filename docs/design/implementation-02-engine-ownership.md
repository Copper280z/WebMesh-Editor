# Implementation 02: engine ownership

22 October 2026 · branch `codex/project-core-foundation`

## Outcome

Connect the project core to the real editor's card mutations, history and project files. This milestone implements the ownership boundary required before adding the redesigned authoring interface. It does not yet turn the existing CAD meshing buttons into project-object generators.

The engine now loads `app/project.js` and `app/engine-ownership.js`. Explicit project objects can generate supported cards through a preview/commit API. Definitions, owner/role metadata, cards and ID reservations commit together. Existing imports and legacy modeling tools continue to create hand cards; legacy CAD element tags are not project ownership and cannot adopt project-owned cards.

## Work completed

1. **Own cards explicitly.** Each generated card has an object, role and namespace-qualified identity. A mesh/point owns GRID cards; a mesh/connection owns elements; a section/template owns properties; a material owns MAT1. A shared PBUSH can therefore belong to its template rather than being copied into each connection. Definitions contain the exact semantic card specifications for this adapter. Future geometry and connection generators will produce these specifications from their higher-level definitions.
2. **Preview a detached candidate.** Validate definitions, references, dependencies, ownership collisions and ID reservations without changing the live model. A role cannot move to another numeric ID or change element type. Another owner's card or a hand card cannot be adopted. Removed IDs remain reserved. A stale candidate rejects after intervening hand edits, loads, undo or redo. The preview includes old/new card values and metadata-only ownership changes. Empty regeneration creates no history entry or engine revision.
3. **Commit at the engine boundary.** Apply the complete semantic card diff and project snapshot through one real history entry. Serialization warnings fail the transaction. Undo and redo restore cards and ownership together. Rejected owned-card edits restore semantic state, worker data, revision, selection and redo history. Worker transaction messages are deferred until the guarded action succeeds.
4. **Guard existing authoring paths.** Existing schema editors, mesh replacement, node operations and deletion use the history boundary. They cannot silently change an owned card. The rejection identifies the owner and role. Explicit conversion to plain cards removes ownership while retaining the cards; dependency removal must be resolved in the same candidate. Export also detects ownership drift, including changes outside normal editor commands. Direct mutation of the public debugging `window.model` is not an authoring API.
5. **Check references conservatively.** Index references into node, element, property, material and coordinate namespaces from supported semantic cards, including rigid elements, masses, loads, constraints and temperatures. Supplement PLOAD4's face-node and coordinate references from retained source because compact hydration omits them. Unsupported card names block project generation and destructive guarded edits rather than being guessed from numeric tokens. Standard analysis case-control headers, GRAV coordinate references and a small explicit set of non-reference PARAM cards are handled; case-control SETs and unrecognized parameters remain blocked. This is a closed coverage boundary, not a claim to support every Nastran card. Load/constraint/set ownership and their full cross-reference graph are not enabled in this milestone.
6. **Persist explicitly.** Save projects with ownership as `webmesh-project` version 2, retaining the deck, CAD data and explicit ownership snapshot. A SHA-256 checksum binds the deck and ownership together; mismatches reject before replacing the current model. Restoring retains exact authored numeric precision. Version 1 projects remain hand-authored even if they contain legacy CAD tags. Plain BDF import never reconstructs ownership. The existing writer controls output formatting; this milestone preserves hand-card semantic data rather than promising byte-identical original deck formatting.
7. **Gate runnable output.** The shared writer checks project readiness for export and solver consumers. Invalid/suspended objects block runnable output. Saving an editable project is still allowed. An explicitly acknowledged incomplete-deck exporter and omission manifest remain future work.

## API and supported generation

`WebMeshAPI.previewProjectChange(request)` returns a candidate with `preview()`, `commit()` and `discard()`. Requests contain `label`, `objects`, `removeObjects` and/or `convertToPlain`. Each object follows the project-core contract; `definition.cards` contains records with `family`, `id`, `role`, `value` and, for elements, `bucket`. The adapter requires declared dependencies for references between different owners. A caller updating an upstream definition must also supply the affected downstream definitions for re-evaluation, or leave them Invalid and blocked from runnable export.

Example of an isolated generated point:

```js
const candidate = await WebMeshAPI.previewProjectChange({
  label: 'Create motor shaft point',
  objects: [{
    id: 'motor-fl-shaft', kind: 'point', name: 'Front-left shaft',
    definition: { cards: [{
      family: 'nodes', id: 1001, role: 'shaft-center',
      value: { x: 25, y: 40, z: 10, cp: 0, cd: 0, ps: '' }
    }] }
  }]
});
const report = candidate.preview();
// Present report to the analyst; commit only their selected candidate.
candidate.commit();
```

Generated types are deliberately limited to validated fields of GRID, MAT1, PSHELL, PSOLID, PROD, PBUSH, CTRIA3/6, CQUAD4/8, CTETRA, CHEXA, CROD, CBUSH and RBE2. Unsupported fields reject rather than being silently dropped. This adapter is not a general-purpose solver validity checker. Existing mesh quality, coordinate and solver checks still apply; additional high-level connection validation belongs to its generator.

`getProjectOwnership()` returns detached metadata. `saveProjectModel()` and `loadProjectModel(data, name)` are used by the actual Save/Open project actions. The owning inspector, override/detach actions and analyst-facing card-diff dialog are not added yet. Until those exist, existing tool buttons do not create project-owned cards automatically.

## Acceptance and validation

- 26 ownership tests in `tests/engine-ownership.test.cjs`: hand-card preservation, stable reservations, collisions, shared template properties, unsupported references, rigid/mass/load/support/temperature references, conversion, no-op generation, failure rollback, stale candidates, corrupt persistence and real engine history.
- Real engine synchronization and real worker writer/parser round trip: generated GRID/MAT1/PSHELL/CTRIA3 and the existing hand FORCE survive with their intended values.
- Browser harness at `tests/browser/engine-ownership.html`: runs against a fresh embedded instance of the actual editor. It checks preview, commit, hand-load export, undo, redo, stale rejection, save/reopen and empty regeneration. All checks passed.
- Manual browser property-edit check: changing owned PSHELL thickness from 2 to 3 is rejected with the owner/role explanation; thickness remains 2.
- Isolated staged milestone: full suite **335 passed, 0 failed, 0 skipped**, using the existing local quadmesh/paved libraries. This excludes the pre-existing unstaged review changes.
- After the final legacy-project invalid-deck safeguard: all **26 ownership tests passed** again in that isolated copy.
- JavaScript syntax and `git diff --check`: passed. The pre-existing review changes were checked against their starting diff and retained outside this milestone.
- [Browser evidence](engine-ownership-browser.png) shows the rejected direct edit with the original thickness restored.

## Next milestone: an analyst-facing owned primitive

1. Add a project-object tree and owner inspector for one primitive mesh, its material and section. Keep the existing tools available for hand cards.
2. Adapt primitive generation to produce the supported specifications, allocating stable role blocks and retaining the original geometric parameters. Preview the card diff before commit. Reopening and regenerating an unchanged primitive must produce an empty diff.
3. Route an owned-card selection to its inspector. Offer **Edit owner** and **Convert to plain cards**, with affected dependencies shown. Do not imply overrides/detachment exist until implemented.
4. Show project checks and blocked-export explanations in that inspector and the export flow. Separate editable project saving from runnable analysis export.
5. Expand the fixture to a shell with a motor connection and a shared PBUSH template, including dependent-DOF checks. Add further card/reference adapters explicitly, with tests, rather than opening an unchecked generic path.
6. Only then wire CAD mesh regeneration and region identity. General attachment templates, live instances, assembly/multi-body authoring, broad CAD reattachment, run provenance, incomplete export and unified CAD/FE undo remain separate milestones.
