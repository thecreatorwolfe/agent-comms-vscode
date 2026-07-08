# Releasing Agent Comms

**NO INSTALL FROM UNCOMMITTED/UNPUSHED SOURCE.** On 2026-07-08 we discovered releases 0.2.21–0.2.45 had been built and installed from uncommitted working-copy changes while the repo sat at 0.2.20 — the source for 25 live releases existed only in one stray working copy and was nearly lost. Never again.

Release steps, in order:

1. Bump `version` in `package.json`.
2. Commit all changes.
3. **Push** (`git push origin main`).
4. `npm run package` (compiles + produces the `.vsix`).
5. `code --install-extension agent-comms-vscode-<version>.vsix`
6. Run the VS Code command "Agent Comms: Install Global Bridges" (repoints `~/.agent-comms/bin/` launchers at the new extension dir).
7. Reload the hub's VS Code window (drops live agent connections — schedule around live calls/deploys).
