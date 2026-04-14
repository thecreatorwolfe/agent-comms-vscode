# src/persona — Owner: Codex

Per `docs/AGENT_ORCHESTRATION_CODEX_BRIEF.md` §2.

Files to implement:
- `naming.ts` — `<project>-<kind>-<N>` logic + custom_name overrides per protocol §3
- `icons.ts` — `V = ((N - 1) mod 4) + 1`; returns full icon URL per protocol §5. Custom-named personas default to `V=1`.

Icon URL format during dev (while extension repo isn't on GitHub Pages yet): read from local filesystem and serve via the extension's localhost port — helper to be agreed with Alfred at integration time.

Do not add new files here without asking Alfred.
