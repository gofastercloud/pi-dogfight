<!-- groundhog-agency:start -->
## Groundhog Agency Workflow (Vendor-Agnostic)

This repository uses **groundhog-agency** with Groundhog's `agent-git` / `agent-gh` broker. Works identically in **Claude Code**, **Antigravity**, and **Codex**:

- **Skills:** `/spec <idea>` (grill → spec + tickets), `/next [N]` (dispatch up to 3 tickets → `implementer` → fresh-context `reviewer` → ship PR), `/next-all [max]` (drain backlog batch-by-batch until blocked, human-review cap, or context limit), `/handoff` (update `STATUS.md` ≤40 lines → start fresh).
- **Roles:** canonical contracts live in `.agents/roles/{implementer,reviewer,scout}.md` (and `.claude/agents/` for Claude Code).
  - **Claude Code:** uses `.claude/agents/*.md`, `.claude/hooks/gtq.py`, and `.claude/settings.json`.
  - **Antigravity:** delegates via `invoke_subagent` (`implementer` in `Workspace: "share"`, `reviewer` read-only, `scout` on `flash`/`flash_lite`).
  - **Codex:** runs in `workspace-write` sandbox with isolated git worktrees per ticket.
- **Git & GitHub:** always use `agent-git` and `agent-gh` on `agent/<persona>/t-<N>-<slug>` branches, label PRs `agent-authored`, and respect `groundhog agent-git status` (`autonomous` vs `human-review`). Never push directly to `main`/`master`.
- **Offline verification (`agent-box`):** by default, run tests and verify commands inside Groundhog's offline `agent-box` (`agent-box -- <verify-cmd>`) for zero-network, zero-credential execution (auto-starts OrbStack; falls back to host only for macOS-only tooling).
- **Compact instructions:** when compacting, keep ticket numbers and branches in flight, PR numbers, decisions and reasons, open questions for the maintainer, and the next action. Drop tool output, file contents, diffs, and anything already in an issue or `STATUS.md`.
<!-- groundhog-agency:end -->
