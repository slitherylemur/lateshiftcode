# LateShift Cloud — admin portal

Zero-dependency, server-rendered Node ESM app. Runs on `127.0.0.1:$PORT`
(default 3790) behind Tailscale Serve, which injects the caller's tailnet
identity via `Tailscale-User-*` headers. See the top of `server.mjs` for the
security model (CSRF on every POST, `execFile`-only shell-outs, `assertSafeUnit`).

## Files

- `server.mjs`    — HTTP routing, request context, admin/dashboard data assembly.
- `views.mjs`     — all HTML (every dynamic value passes through `esc()`).
- `lib/registry.mjs` — read-only registry + `portal.config.json` loader.
- `lib/actions.mjs`  — validated shell-outs (`t3user`, `systemctl`, pairing).
- `lib/history.mjs`  — read-only usage/history readers over each instance's
  `state.sqlite` (`turn_usage`), including provider bucketing and the fleet-wide
  5-hour session-window math.

## Admin portal

Master/detail: left = every registered user plus the admin's own account
(status dot + Edit affordance); selecting one (`/admin?u=<name>` or `?u=@self`)
shows settings (project limit, budget, tailnet login, admin/shared flags),
pairing link, remove, and a **share manager** listing every directory under the
single share root `/home/dev/shared/` with an on/off switch reflecting the
user's registry `sharedProjects` grant. Toggling calls the existing
`share` / `unshare` actions. The admin's own detail always shows a "workspace"
card that mints a shared production-workspace pairing, and their share list is
read-only (admins implicitly see every shared project).

Light/dark theme toggle is a pure client-side preference persisted in the
`lsc_theme` cookie (no server mutation, so no CSRF needed); dark is the default.

## portal.config.json

All fields optional. Read-only to the portal; edit the file directly.

```jsonc
{
  "adminLogins": ["you@example.com"],          // tailnet logins that are admins
  "sharedWorkspaceUrl": "https://…/",          // shared production workspace origin
  "sharedStateDb": "/home/dev/.t3/userdata/state.sqlite",
  "subscriptionLimits": {                       // OPTIONAL — tolerated if absent
    "claude":   200,   // USD/month cap for Claude-backed usage
    "codex":    100,   // USD/month cap for Codex/OpenAI usage
    "claude5h":  20,   // USD cap per 5-hour session window (Claude)
    "codex5h":   10    // USD cap per 5-hour session window (Codex)
  }
}
```

The admin **Subscription usage** panel sums `turn_usage.total_cost_usd`
(bucketed by `provider_name` into claude / codex / other) across every user
instance and shows, per provider:

- **Month-to-date** total as a percentage ring against `subscriptionLimits.<provider>`.
- **Current 5-hour window** usage as a bar against `subscriptionLimits.<provider>5h>`,
  with the window reset time.

5-hour windows are **approximate**: fixed 5-hour blocks re-anchored at the
first turn following ≥5 hours of provider inactivity across all instances
combined; usage = cost since the current block start; reset = block start + 5h.
When a cap is absent the ring/bar renders without a percentage.

A **Usage leaderboard** ranks users by month-to-date total cost with an inline
per-provider (Claude / Codex / other) breakdown.
