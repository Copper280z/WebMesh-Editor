# Local server workflow

- Keep one user-facing WebMesh server on `http://127.0.0.1:8765`, running from this checkout.
- After making updates, restart that server so it uses the updated code, and verify `/api/health` before handing back the work.
- The user has authorized these restarts and confirmed that no work is in progress during updates. Do not keep old servers running to preserve sessions or ask again about losing drafts or undo history.
- For testing, start a separate temporary server on an available port. Stop it and its CAD workers when testing finishes, including after failures. Do not leave validation servers running.
- Preserve the configured MYSTRAN and Vibestran executables when restarting the user-facing server.

# Documentation and investigations

- `setup.md` is an end-user guide to dependencies, building, launching and troubleshooting. Keep agent instructions, local server management policy and development-session details in this file instead.
- Record suspected external solver defects separately under the ignored `solver-bug-reports/` directory and keep them untracked.
