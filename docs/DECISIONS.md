# cogspect.ai — DECISIONS

Permission and architecture decisions, newest last. Each entry: date — change — reason.

## Permissions

- **2026-08-06 — `.claude/settings.local.json` `permissions.allow` += `Bash(git push*)`** —
  the CEO ships from this session and was approving every push by hand. Scope is
  this project only; force-push variants stay blocked by the global deny list.
  Note: `Bash(git push*)` is also in the **user-scope `ask`** list, and ask rules
  are evaluated before allow rules, so the prompt keeps appearing until that entry
  is removed from `~/.claude/settings.json` — a CEO-only file.
  Undo: drop the rule, or restore `.claude/settings.local.json.bak`.

- **2026-08-06 — removed 4 over-broad allow rules** (`Bash(python3 -)`,
  `Read(//Users/minhyeok/**)`, `Bash(git rm *)`, `Bash(rmdir assets *)`) —
  they had accumulated from one-off approvals. The first pre-approved arbitrary
  Python on stdin; the second granted read access to the whole home directory,
  which contradicts the constitution's project-scope rule.
