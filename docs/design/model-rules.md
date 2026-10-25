# Model rules: ownership, change propagation, overrides and recovery

*Revised after both reviews, 22 October 2026. A companion to [project-workspace.md](project-workspace.md), written after review of that document.*

The workspace design says what an analyst sees. This document says how the model behaves when the analyst changes it:
- who owns each card;
- what a change touches;
- how hand edits survive regeneration;
- how regions find their geometry again;
- what a solved run keeps;
- what failure leaves behind.

Each rule is numbered (R1, R2, …) so that tests and later documents can cite it. Sections 7 and 8 turn the rules into acceptance scenarios and a breakdown of the work.

## Terms

- **Definition:** an object's own data. Examples: a mesh's settings, a region's rule, a connection's parameters, a load's values.
- **Generator:** the code that turns a definition into cards.
- **Generated card:** a card a generator wrote. It has an **owner**, the object it belongs to, and a **role**, which card of that object it is ("rbe2", "pbush", "node 1,204 of instance FL").
- **Hand card:** a card no object owns. That means everything in an opened deck, plus anything made in the card editor.
- **Template:** a definition that other objects link to, such as the motor mount template. A **linked** object follows its template.
- **Override:** one value an object holds in place of what its template or generator would give.
- **Transaction:** one committed change. It covers the definition changes, the card changes they cause, and any CAD revision step.
- **Model revision:** a number that goes up by one with every transaction.

## 1. Ownership

**R1.** Every card either has exactly one owner (an object and a role), or none, in which case it is a hand card.

**R2.** Generators write only the cards they own. Regeneration never creates, changes or deletes a hand card.

**R3.** A card shared by several objects belongs to whatever holds the shared value, never to one of the objects using it.
- The PBUSH that four motor mounts share belongs to the motor mount *template*.
- Materials and sections own their MAT1 and PSHELL cards.
- A part's mesh owns the nodes and elements of every instance of the part.

**R4.** IDs are stable.
- Each object gets its own block of IDs when it is created.
- Regeneration keeps a card's ID while its role still exists. The template's PBUSH stays 4, and motor FL's RBE2 stays 8001.
- Mesh nodes and elements are numbered inside their instance's block by their position in the part's mesh, so a remesh does renumber them. Anything that refers to mesh entities therefore does so through a region (section 4), never by number.

**R5.** A hand card may refer to owned cards, for example a hand FORCE on a mesh node, or a hand SET listing elements.
- Before any transaction removes or renumbers an entity that a hand card refers to, the preview lists that hand card as **will dangle**.
- It offers three ways out: retarget the hand card through a region, delete it, or cancel the change.
- Nothing is committed with a dangling hand-card reference. Hand cards cannot be suspended: retargeting or deletion must be an explicit analyst edit in the transaction, never a generator side effect. Reusing an ID for a different entity counts as losing the reference even if the number still exists.

## 2. Definitions, cards and overrides

The workspace document said "the deck is the authority". Precisely, it works like this.

**R6.** Inside WebMesh, definitions are the authority for generated cards. The deck is always exactly what the definitions, their overrides and the hand cards produce: after every transaction, deck = generate(definitions + overrides) + hand cards. There is never a state in which a generated card silently differs from its definition.

**R7.** The deck is what gets solved and exported. Hand cards in it are kept verbatim.

**R8.** Editing a generated card means editing its owner, never a stand-alone card edit. When the analyst changes a field on a generated card, WebMesh asks where the change belongs before applying it. This applies wherever the edit is made: the card editor, the Table, or Modify entities. The choices are:
- **Change the template.** Every linked object follows. The preview lists them all.
- **Override for this object only.** This is stored on the object as an override (R9).
- **Detach this object from the template.** The object keeps its current values as its own definition and stops following the template.
- **Convert to plain cards.** The object gives up its cards, which become hand cards and are never regenerated. The object itself is removed.

Which choices appear depends on the field:
- A field that is a parameter of the definition, such as PBUSH K1, offers all four.
- A field the generator computes from geometry, such as an RBE2's list of dependent nodes, offers **Edit the region** and **Convert to plain cards** only. An override of a computed list would be wrong after the next remesh.

**R9.** Overrides are stored per object and per parameter (spring K1 on Motor mount FL), never per card ID. That way they survive regeneration, renumbering, and saving and reopening. A card field that isn't a parameter of the definition, such as a CBUSH's OCID or an RBE3's ALPHA, can be overridden the same way, keyed by role and field.

**R10.** When an override changes a value that lives on a shared card (R3), the overriding object gets a card of its own. Motor mount FL with a stiffness override gets its own PBUSH 9, while FR, RL and RR go on sharing PBUSH 4.

**R11.** The inspector marks every overridden value.
- It shows the value being overridden ("template: 100,000").
- Each override offers two actions: **Keep** (the default) and **Revert to template**.
- An object's header says whether it is *Linked*, *Linked, N overrides*, or *Detached*.

**R12.** Every regeneration is previewed as a card diff, grouped by object, before it commits. The diff shows cards that are:
- added;
- removed;
- changed (field: old value → new value);
- renumbered.

It also shows the overrides being applied, and **orphaned overrides**: overrides whose parameter or role no longer exists, for example after the template drops its CONM2. An orphaned override needs a decision before the transaction commits: drop it, or detach the object to keep it.

**R13.** Importing a deck, or a version 1 project, produces hand cards only. Turning hand cards into definitions ("adopt these RBE2s as a connection") is an explicit later feature, never something WebMesh infers.

### Worked example: overriding one motor's stiffness

1. The template "Motor mount" has K1–K3 = 100,000 N/mm. Four linked mounts share PBUSH 4.
2. From Motor mount FL, the analyst opens PBUSH 4 and sets K1 to 150,000. WebMesh asks where the change belongs (R8). They choose *Override for this object only*.
3. The preview shows a new PBUSH 9 (K1 150,000, with K2–K6 from the template) and CBUSH 8031's PID changing from 4 to 9. They commit.
4. The inspector for FL shows "K1 150,000 ● override (template: 100,000) · Revert". FR, RL and RR are unchanged and still use PBUSH 4.
5. Repeating the template onto a fifth pattern makes a new linked mount with no overrides, using PBUSH 4.
6. Remeshing the chassis makes each mount regenerate its RBE2 from its re-resolved region (section 4).
   - FL's override is part of its definition, so it survives.
   - PBUSH 9 keeps its ID (R4).
7. Changing the template's K4–K6 to 2,000,000 previews two changes:
   - PBUSH 4 changes, for FR, RL, RR and the fifth mount.
   - PBUSH 9 changes in K4–K6 only, with the note "FL overrides K1".
8. After saving and reopening, step 4's display is unchanged, and regenerating produces an empty diff.

## 3. Change propagation and status

**R14.** Objects form a dependency graph:
- part geometry → mesh → instances → regions → points → connections, loads and supports → analyses → runs;
- materials and sections → meshes and connections;
- templates → linked objects.

**R15.** Every change is a transaction in two phases.
1. Compute the change's effect on everything downstream and show it as a candidate: the diff of R12 plus the region outcomes of section 4.
2. Commit it, or discard it.

Long work, such as meshing and CAD operations, happens against a captured base revision in the first phase. The model is untouched until commit (R34). A candidate may commit only while its base revision is still current. If another edit commits first, reject the old candidate and recompute its effects against the new state; never overwrite newer edits. Discarded, failed and outdated candidates consume no live IDs.

A solve captures its deck, units, model revision and export options when launched, rather than holding a model transaction open. Its eventual run record belongs to that launch snapshot, even if the analyst edits the model while it runs.

**R16.** When re-evaluating a downstream object is deterministic, it happens inside the same transaction. Examples:
- an instance's nodes move with its transform;
- a region with an exact or confident match re-resolves;
- a connection regenerates from its regions.

The analyst sees these effects in the preview, not afterwards.

**R17.** Some re-evaluations need a decision: an ambiguous or missing region match, an orphaned override, or an explicit-ID region whose entity identity was lost. These are shown in the preview, and the analyst has two options:
- **Decide there**, in the preview.
- **Commit with those objects suspended.** A suspended object keeps its definition and overrides. It and its dependent generated objects produce no cards, so the deck never refers to geometry that has gone. They block both **Solve** and **Export runnable analysis** until repaired or explicitly removed from that analysis.

**Export incomplete working deck** is a separate action. Its preview names every omitted object and the reason, requires explicit acknowledgement, and writes the omission list into deck comments and an accompanying manifest. It must not present the deck as ready to run. Hand cards remain governed by R5; suspension is never a way to bypass a dangling hand-card reference.

**R18.** Every object has one of five statuses:
- **Not defined yet.** Expected unfinished work, such as no supports or no analysis yet. It is neutral. It shows where the thing gets defined (the Load stage, and Solve's readiness list), never as a warning in other stages.
- **OK.**
- **Changed since verified.** The object was re-evaluated automatically after an upstream change, and the analyst hasn't looked at it yet. Example: a region re-resolved from 48 to 80 nodes after the mesh was refined. One click acknowledges it, and the acknowledgement is recorded with the revision.
- **Unverified.** An association WebMesh can't prove, such as results imported without provenance (R30).
- **Invalid.** The object can't produce valid cards: it is suspended, its mesh failed, it has a dependent-DOF conflict, or it has a dangling reference.

**R19.** Checks are ordered by relevance to what the analyst is doing. While committing a mesh, that mesh's own checks come first. Before a solve or runnable export, everything that would block that analysis comes first. Both actions use the same checks and the same analysis scope. A required input that is missing makes the analysis Invalid, while the unfinished input itself can remain neutral elsewhere. How much each status counts:
- **Invalid** blocks.
- **Changed since verified** and **Unverified** warn.
- **Not defined yet** only informs.

**R20.** Statuses are computed from the graph and the revision, not stored as flags that can drift. A test rebuilds every status from a saved project and must get the same result.

## 4. Region identity and reattachment

A node count is the wrong test of whether a region still means what it did:
- Refining a mesh can legitimately turn 48 nodes into 80.
- Four wrong holes can still give 48.

A region keeps its meaning only if it knows which geometry it meant and can find that geometry again, and if it says honestly when it can't.

**R21.** A region has four parts:
- **Scope:** a part, resolved on each of the part's instances, or named instances.
- **Rule:** what was meant, in geometric terms where possible:
  - hole loops;
  - all holes of a recognized pattern;
  - faces or edges;
  - a box, stored with what was visible at the time;
  - or, failing those, explicit IDs.
- **Anchor:** the evidence for finding that geometry again, captured when the rule is made. For each CAD entity it records:
  - its kind;
  - its signature: centre, area or length, bounding box, normal or axis, and radius;
  - its context: the face it lies on, and that face's signature;
  - its feature membership: which pattern, its index in the pattern, and the spacing;
  - its lineage key, where the CAD kernel provides one.

  The anchor also keeps a small outline of the original geometry, so the original intent can still be drawn after that geometry has gone.
- **Resolution:** the node or element IDs on each instance. It is always derived, never edited.

**R22.** After a geometry change, a region is matched again in this order:
1. **Lineage.** The CAD operations WebMesh runs are OpenCASCADE algorithms, which report what each input face and edge became. The CAD facade already reads this history to renumber bodies after Boolean operations. Lineage is evidence, not an automatic Exact outcome. A unique one-to-one continuation can be Exact only if it preserves the region rule. For splits, the rule must explicitly allow the complete descendant union and preserve its intended boundary and membership; otherwise require a choice. Merges involving geometry outside the original region require a choice. Missing or conflicting history falls back to matching, never to guessed entity numbers.
2. **Geometric matching.** Candidates of the same kind are scored by how far their signatures differ, relative to the part's size. Each candidate is also checked against its context: a pattern of four holes must still be four holes with the same spacing and radius.
3. **Outcome.** This is decided for each anchored entity, and for the region as a whole:
   - **Exact** (unique, rule-preserving lineage, or a unique identical signature with matching context): re-resolve. Duplicate signatures are Ambiguous. Node membership changes are still reported in the transaction, even when geometric identity is Exact.
   - **Confident** (one candidate within tolerance, clearly ahead of the next): re-resolve, with status *Changed since verified*.
   - **Ambiguous** (two or more candidates too close to call): the analyst chooses.
   - **Missing** (no candidate) or **partial** (three of the four holes found): the analyst chooses.

**R23.** Node and element counts are reported ("48 → 80, mesh refined") but never decide an outcome.

**R24.** A region is resolved through the mesh, not through coordinates.
- Every mesh node records the CAD entity it lies on (vertex, edge or face) in the geometry revision it was meshed from.
- The shell mesher already meshes edges first and shares each edge's nodes between faces, and the hex mapper knows every block face and edge. Returning this classification with each mesh is therefore the small part of the work.
- R21 and R22 are the large part, and get their own corpus of test cases (piece 4 in section 8).

**R25.** An explicit-ID region is bound to the mesh revision and entity identities on which it was created. When remeshing loses that identity, suspend the region and its generated dependents, even if the same numeric IDs exist. Its status is *Invalid*, not a warning.
- Repair by choosing a geometric rule, explicitly remapping the selection, or explicitly accepting the displayed new membership. Acknowledging a general warning cannot reactivate it.
- Acceptance creates a new binding to the current mesh revision and shows the old and new locations.
- Preserve a binding automatically only when a one-to-one entity-identity mapping is actually available, not because counts, IDs or coordinates happen to agree.

**R26.** Repair is done one region at a time.
- The region's inspector shows the old outline (from the anchor), the candidates and the current geometry, and the analyst picks.
- Only that region and what depends on it are re-evaluated.

## 5. Runs and results

**R27.** A run is immutable once written. It keeps:
- the exact deck that was solved, compressed. The rover's deck is about 1 MB of text. Keeping it means the solved geometry and connectivity can always be shown, even after the model changes.
- the solver plugin, its version, and the executable that ran;
- the export profile and its options;
- the model revision and model hash the run came from, plus a separate hash of the exact solver-input bytes;
- the unit interpretation at launch, including result display dimensions. These are immutable even if an imported project later corrects its unit interpretation;
- the log, the diagnostics and the exit status. Failed runs are kept too.
- its result files, either referenced by name, size and hash, or embedded.

**R28.** Results are always drawn on their run's own solved model.
- A run is current only if its model hash and unit interpretation match the current model. The exact solver-input hash is kept separately because an export profile can change numeric formatting.
- If not, opening the run shows its solved model in a read-only **run view**. The run view has its own frame and the caption "Run 1 · solved model · not the current model".
- Results are never drawn on the current model by matching IDs, because a node can keep its ID and move.

**R29.** The current view never shows a stale run's results. Instead it says "Run 1 is from an earlier model", with **Open run** and **Run again**.

**R30.** An F06 imported without a run is *Unverified*.
- Its badge says "IDs match · origin unverified", never "matches model".
- If the deck the F06 came from is supplied as well, the import is treated like a run made outside WebMesh. It is recorded as in R27, minus the solver details WebMesh can't know.

## 6. Units, transactions, failures and instances

**R31.** Units are chosen when a project is created or a deck is imported, and are then locked.
- Inputs accept other units with an explicit suffix ("0.35 kg") and show the stored value beside them ("= 3.5e-4 t").
- A separate action, **Correct unit interpretation**, exists only for an imported deck. Its name makes clear it is a correction, and it states that no number will change.
- Converting a model between unit systems is a later feature.

**R32.** Every numeric physical-value field has a dimension, taken from the schema; IDs, flags and text are not physical quantities. Dimensions include length, force, stress, density, mass, inertia, stiffness, rotational stiffness or acceleration. Inputs, labels and sanity checks (such as a density off by a factor of 10¹²) all work in the project's units.

**R33.** Undo and redo work transaction by transaction, across CAD and FE together.
- A transaction that included a CAD step, such as Replace source or a Prepare operation, records the part's session revision.
- Undoing it returns the session to that revision, and restores every definition and card the transaction changed.

**R34.** Cancelling or failing leaves the last committed model untouched.
- A failed or cancelled mesh, CAD operation or solve produces no transaction.
- Diagnostics stay in the Log, with links to the entities involved.
- A failed solve still writes a run record (R27), so its deck and log can be inspected.

**R35.** Instances share their part's mesh exactly: one mesh definition and one set of overrides.
- An instance's generated nodes and elements are the part's mesh, transformed.
- A reflection reverses element connectivity so normals still point outward. Offsets (ZOFFS) keep the material on the same physical side. Both are tested explicitly.

**R36.** Instances hold only a transform and a name.
- Editing a generated element of one instance offers two choices: apply the change to the part (all instances), or **Make unique**, which turns the instance into its own part with a copy of the mesh definition.
- Differences between instances live in regions and connections, which can be scoped to particular instances (R21).

**R37.** Deletion is a reviewed composition of removal and independent authoring actions.
- Right-click **Delete…** opens a dependency inspector. The analyst can keep or delete dependents together or individually; keeping is the default.
- Kept dependents become independently authored objects with names, card identities and current resolved values preserved. They no longer follow deleted parents. A retained live placement becomes an independent part through **Make independent**, preserving its mesh owner and GRID/element identities.
- Required geometry is never silently invented. A kept definition with missing inputs is suspended, emits no solver cards and blocks analysis until explicitly repaired or deleted. Hand-card conflicts follow R5 and cannot be silently suspended or removed.
- Shared resources remain while referenced. Optional cleanup applies only to unused materials/sections of removed meshes.
- Apply is one undoable transaction. CAD drafts needed for undo remain recoverable; saved live projects must not resurrect removed parts.

## 7. Acceptance scenarios

Each scenario is a test on the rover project:
- automated where the behaviour lives in `project.js` or the engine;
- scripted in the browser for the rest.

"Checks" means the statuses of R18 and the previews of R12.

**S1. The base path.**
- *Build:*
  - the chassis as shells;
  - a wheel part with four instances;
  - region "Motor FL pattern" (four hole loops), with the motor mount template on it, repeated to FR, RL and RR;
  - wheel hub RBE2s on a wheel bolt-hole region scoped to the wheel part;
  - a 1 kg payload at a named point 200 mm above its mounting plane, connected to its mounting region by RBE3;
  - PLA, gravity, contact supports and an analysis;
  - a MYSTRAN run.
- *Expect:*
  - no Invalid statuses;
  - the vertical reaction equals the weight to within 1e-4 N;
  - results shown by element family;
  - after saving and reopening, the same deck hash and the same result maxima.

**S2. Remesh one wheel.**
- *Change* the wheel's mesh size from 2 to 1.5.
- *Expect in the preview:*
  - all four instances' elements change;
  - the wheel bolt-hole region matches Exact on every instance, with the higher node count reported;
  - all four hub RBE2s regenerate;
  - no override is orphaned, and no hand card dangles.
- *Then commit and solve:* MYSTRAN accepts the deck, and S1's checks still hold.

**S3. Replace the chassis geometry, with one pattern moved.**
- *Replace* the source with a chassis whose rear-right motor holes have moved 30 mm along the wall.
- *Expect in the preview:*
  - Motor FL, FR and RL patterns match Exact or Confident;
  - Motor RR pattern has no match: its old outline is drawn, with the moved holes offered as a candidate.
- *Commit without choosing:*
  - Motor mount RR is suspended;
  - Solve is blocked by one Invalid check, naming it.
- *Repair* only that region, by picking:
  - the mount regenerates with its overrides intact;
  - the diff shows only RR's cards.

Implementation note (milestone 18): S3's identity/repair workflow is exercised using a real revision of the prepared chassis sheets. Eleven unchanged faces remain committed; two changed faces form a pending patch, so the intermediate checks name the patch, RR region and RR connection. After patch meshing, repairing the named RR pattern restores only its four connection cards. The reference solid, shaft opening and explicit wheel/motor points remain fixed in this fixture. General CAD preparation replay and one-click arbitrary feature recognition remain open. The MYSTRAN run completes but retains a small strict moment-balance warning; this is not an all-green numerical acceptance claim.

**S4. Edit a generated card.** Run the worked example of section 2, steps 1–8, saving and reopening between steps 4 and 5.
- *Expect:*
  - nothing is silently lost at any step;
  - regenerating after reopening produces an empty diff.

**S5. Change the model after solving.**
- *Change:* after S1, raise the payload point by 50 mm and run again.
- *Expect:*
  - run 1 and run 2 are both listed;
  - the current view shows run 2;
  - opening run 1 shows run 1's solved model, with the payload at its old height, and its results;
  - run 1 is marked as from an earlier model;
  - no result is ever drawn on a model it wasn't solved on.

**S6. Cancel and fail.**
- *Do:* cancel a shell mesh partway, then exercise a deterministic solver-failure fixture (a controlled nonzero-exit process for the job runner, and a deliberately rejected solver input for the plugin). Missing required supports should be caught before Run, not used as a reliable solver-failure trigger.
- *Expect:*
  - the model revision is unchanged both times;
  - the Log holds the mesher's report and the solver's fatal message, each linked to entities;
  - the failed run is listed, with its deck.

**S7. Undo across CAD and FE.**
- *Do:* after S3's repair, undo twice: first the repair, then the Replace source.
- *Expect:*
  - the original chassis session revision is back;
  - all four patterns match Exact;
  - every card is as in S1, with the same deck hash.

**S8. A new project starts clean.**
- *Do:* choose New, then build the plate.
- *Expect:* no regions, overrides, statuses or results from the rover remain. These are the review's F01 and F07.

**S9. Reflection.**
- *Do:* reflect a wheel instance that has an offset sheet.
- *Expect:*
  - element normals point outward;
  - the offset is on the same physical side as in the source;
  - the mass is identical.

**S10. Unit assistance.**
- *Do:* enter values with units in a mm·N·s·t project.
- *Expect:*
  - "0.35 kg" stores 3.5e-4;
  - a density of 1240 (kg/m³ entered by mistake) warns that it implies a mass 10¹² times too large.

**S11. Numeric IDs survive, identities do not.** Remesh an explicit-ID attachment so its old numbers now identify unrelated nodes. The region and dependent attachment are suspended; Solve and runnable export are blocked. An ordinary acknowledgement cannot clear it. Explicitly bind the displayed new membership or repair geometrically before regenerating.

**S12. Non-bijective and ambiguous geometry.** Test a face split with an allowed descendant-union rule, a split with a single-face rule, a merge that includes outside geometry, and two candidates with identical signatures. Only the explicitly rule-preserving union may resolve automatically; the other cases require a choice.

**S13. Export a suspended model.** Suspend Motor RR. Solve and runnable export give the same blocker. Incomplete working-deck export requires acknowledgement and lists RR and every omitted dependent in both its preview and output manifest. A dangling hand card still prevents commit; it cannot be suspended.

**S14. Edit while a candidate or solve is running.** Start a wheel-mesh candidate at revision N, then commit a material edit. Committing the old candidate is rejected, preserving the material edit, IDs and revision. Recompute at the new revision and commit once. A solve started at N keeps N's deck and units even if it completes later.

**S15. Correct units after an external run.** Import a deck and run with declared units, then correct the current project's interpretation without changing its numbers. The old run retains its original units and opens in its own run view; equal deck bytes do not make it current.

## 8. Work breakdown

The first user-facing deliverable is a narrow vertical slice: S1, then S2. These rules are part of it from the start. It runs inside the current shell with as little new layout as possible. The rest of the workspace design follows once the slice holds.

These are engineering milestones, not session estimates. Each has acceptance tests. The first actionable foundation plan is [implementation-01-project-core.md](implementation-01-project-core.md); it implements piece 1 in isolation before engine integration. This does not claim that S1–S15 or the complete rover slice are implemented.

| # | Piece | Contents | Done when |
| --- | --- | --- | --- |
| 1 | **Project core** | `app/project.js`, pure and tested in Node: objects; the dependency graph; two-phase transactions; statuses (R14–R20); ID blocks (R4) | statuses rebuild identically from a saved state; a transaction's preview lists everything downstream; discarding leaves no trace |
| 2 | **Card ownership** | In the engine: an owner and role on every generated card (today only elements carry an owner tag); applying a card diff atomically; catching edits to owned cards (R8); checking for dangling references (R5) | no regeneration ever touches a hand card (property test); no edit to an owned card applies without a choice |
| 3 | **Overrides** | the override store; forking shared cards (R10); detecting orphaned overrides (R12); inspector markers (R11) | S4 passes |
| 4 | **Geometry identity** | node-to-CAD classification from `cad_shell.py` and `hex-mapping.js` (R24); anchors and signatures (R21); lineage keys from the facade's OpenCASCADE history; the matcher and its outcomes (R22) | a corpus of geometry edits gives the expected outcome for every case: refinement, rule-preserving and ambiguous splits, merges, duplicate signatures, moved, added and missing holes, a mirrored instance |
| 5 | **Parts and instances** | Add part; Replace source; generating instances, including reflections (R35); Make unique (R36); CAD workspace state kept per part | S9 passes; four wheels come from one mesh; Replace source previews its effects |
| 6 | **Regions and points** | hole loop, pattern, face and ID rules; resolution on each instance; the repair inspector (R26) | S2's region outcomes are right; S3's repair works |
| 7 | **Connections** | generators for RBE2, RBE3, CBUSH/PBUSH and CONM2; the motor mount template; Repeat for | S1's connections build; in S3 the regeneration diff touches only RR |
| 8 | **Units** | project units, locked (R31); field dimensions (R32); unit-aware inputs | S10 passes |
| 9 | **Loads, supports, analysis** | GRAV; supports on regions; subcases; case control; export profiles, which also covers the plan's F05 | MYSTRAN accepts the exported deck with no fatal errors and no warnings |
| 10 | **Solver plugins and runs** | the MYSTRAN adapter first; a shared plugin registry and Gmsh migration follow later; `/api/solve`; immutable run records (R27); the run view (R28–R29) | S5 and S6 pass |
| 11 | **Results** | element families (the plan's F04); reactions and balance; the caption; unverified imports (R30) | S1's result checks pass; S5's display rules hold |
| 12 | **Save version 2** | everything above; run decks stored compressed; version 1 projects imported as hand cards (R13) | saving and reopening gives the same deck hash, statuses and override display (S1, S4) |
| 13 | **Unified undo** | transactions spanning CAD sessions and cards (R33) | S7 passes |
| 14 | **Minimal workspace UI** | the project tree and inspector inside today's shell; the stage bar; Checks per R18–R19 | the slice can be done without the card editor, except where the analyst chooses it |

**Order:**
- Pieces 1 and 2 come first.
- Pieces 3, 4 and 8 can then run in parallel.
- Piece 5 needs 4.
- Piece 6 needs 4 and 5.
- Piece 7 needs 3 and 6.
- Piece 9 needs 7 and 8.
- Piece 10 needs 9, and piece 11 needs 10.
- Pieces 12 and 13 grow alongside the others from piece 2 onwards, and close with S4 and S7.
- Piece 14 grows a little with each piece.

The plan's Phase 1 integrity fixes remain prerequisites for enabling the redesigned workflow. The isolated core and its tests can be built independently; they do not enable a new authoring or solver path. Explicit hole selections are sufficient for the first slice; general pattern recognition is later work.

## Open questions

1. **ID block sizes.** For example, 100,000 per part and 10,000 per connection. Should export offer to renumber compactly?
2. **Shared materials.** When one part overrides a shared material, should WebMesh fork it (R10), or require a new, named material?
3. **Lineage for Prepare steps.** Which steps should record lineage first? Booleans already do; sewing, defeaturing and offsets can.
4. **What the project file embeds.** Always the run decks, since they are small, and result files only on request?
5. **Hand cards on region nodes.** When a hand card refers to a region's nodes (R5), should "retarget through a region" build the region automatically from the CAD entities those nodes lie on?
