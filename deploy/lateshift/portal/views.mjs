// LateShift Cloud — server-rendered HTML views.
// Plain ESM, zero dependencies, Node 24+.
// Every render* function returns a complete HTML document string.
//
// Escaping contract:
//   - All dynamic values are passed through esc() before interpolation.
//   - Props explicitly named *Html (detailHtml, bodyHtml) are treated as
//     PRE-ESCAPED by the caller (callers must run their own values through
//     esc() before assembling that HTML).

export function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso ?? "");
  const diff = Date.now() - t;
  const s = Math.round(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

function money(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  const abs = Math.abs(num);
  let decimals = 2;
  if (abs > 0 && abs < 0.1) decimals = 4;
  else if (abs < 10) decimals = 3;
  let out = num.toFixed(decimals);
  // Trim to at least 2 decimals without losing significant cents.
  out = out.replace(/(\.\d{2}\d*?)0+$/, "$1");
  return `$${out}`;
}

function intFmt(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString("en-US");
}

const CSS = `
  :root {
    --bg: #0b0e14;
    --surface: #121722;
    --surface-2: #171d2b;
    --border: rgba(255, 255, 255, 0.08);
    --border-strong: rgba(255, 255, 255, 0.14);
    --text: #e8ebf1;
    --muted: #8a92a6;
    --accent: #e6a23c;
    --accent-strong: #f0b45a;
    --accent-ink: #14100a;
    --green: #4ade80;
    --red: #f87171;
    --danger: #b3403f;
    --danger-strong: #cc5250;
    --radius: 12px;
    --radius-sm: 8px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 0.9em;
  }
  .container { width: 100%; max-width: 960px; margin: 0 auto; padding: 0 24px; }
  main.container { flex: 1; padding-top: 32px; padding-bottom: 56px; }

  /* Nav */
  .nav { border-bottom: 1px solid var(--border); background: rgba(11, 14, 20, 0.85); }
  .nav-inner { display: flex; align-items: center; gap: 16px; height: 60px; }
  .brand { display: flex; align-items: center; gap: 10px; color: var(--text); font-weight: 600; letter-spacing: 0.01em; }
  .brand:hover { text-decoration: none; }
  .brand img { width: 28px; height: 28px; border-radius: 7px; display: block; }
  .nav-spacer { flex: 1; }
  .nav-link { color: var(--muted); font-weight: 500; padding: 6px 10px; border-radius: var(--radius-sm); }
  .nav-link:hover { color: var(--text); background: rgba(255, 255, 255, 0.05); text-decoration: none; }
  .identity-chip {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 12px 5px 6px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--muted);
    font-size: 13px;
  }
  .identity-chip img { width: 24px; height: 24px; border-radius: 50%; display: block; }
  .identity-chip .avatar-fallback {
    width: 24px; height: 24px; border-radius: 50%;
    background: var(--surface-2); border: 1px solid var(--border);
    display: inline-flex; align-items: center; justify-content: center;
    color: var(--muted); font-size: 11px; font-weight: 600;
  }

  /* Footer */
  footer { border-top: 1px solid var(--border); padding: 20px 0; }
  footer .container { display: flex; align-items: baseline; gap: 10px; }
  footer .name { font-weight: 600; font-size: 13px; }
  footer .muted { font-size: 13px; }

  /* Cards, headings, text */
  h1 { font-size: 26px; font-weight: 650; letter-spacing: -0.01em; margin: 0 0 6px; }
  h2 { font-size: 17px; font-weight: 600; margin: 0 0 14px; }
  .muted { color: var(--muted); }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 22px 24px;
    margin-bottom: 20px;
  }
  .section-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 30px 0 14px; }

  /* Buttons */
  .btn {
    display: inline-block;
    font: inherit;
    font-weight: 600;
    font-size: 14px;
    padding: 10px 20px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .btn:hover { background: #1d2434; border-color: rgba(255, 255, 255, 0.22); }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .btn-primary:hover { background: var(--accent-strong); border-color: var(--accent-strong); }
  .btn-danger { background: transparent; border-color: var(--danger); color: var(--danger-strong); }
  .btn-danger:hover { background: rgba(179, 64, 63, 0.15); border-color: var(--danger-strong); }
  .btn-big { font-size: 15px; padding: 12px 26px; }
  .btn-sm { font-size: 12.5px; padding: 5px 12px; font-weight: 500; }
  form.inline { display: inline; margin: 0; }

  /* Inputs */
  input[type="text"], input[type="number"] {
    font: inherit;
    font-size: 14px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 8px 11px;
  }
  input[type="text"]:focus, input[type="number"]:focus {
    outline: none;
    border-color: var(--accent);
  }
  input.narrow { width: 64px; padding: 4px 7px; font-size: 13px; }
  label { font-size: 13px; color: var(--muted); font-weight: 500; }
  .field { display: flex; flex-direction: column; gap: 5px; }

  /* Status chip */
  .chip {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 3px 11px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
    font-size: 12.5px;
    color: var(--muted);
    white-space: nowrap;
  }
  .chip .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; flex: none; }
  .chip.ok .dot { background: var(--green); box-shadow: 0 0 6px rgba(74, 222, 128, 0.5); }
  .chip.bad .dot { background: var(--red); box-shadow: 0 0 6px rgba(248, 113, 113, 0.5); }
  .chip.ok { color: var(--green); }
  .chip.bad { color: var(--red); }

  /* Tags */
  .tag {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    padding: 1px 6px;
    vertical-align: middle;
  }
  .badge-admin {
    display: inline-block;
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent);
    border: 1px solid rgba(230, 162, 60, 0.45);
    border-radius: 5px;
    padding: 1px 6px;
    margin-left: 7px;
    vertical-align: middle;
  }

  /* Stat tiles */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; }
  .stat {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 14px 16px;
  }
  .stat .label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 4px; }
  .stat .value { font-size: 21px; font-weight: 650; letter-spacing: -0.01em; }

  /* Projects / threads */
  .project.deleted { opacity: 0.5; }
  .project-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .project-head .title { font-size: 16px; font-weight: 600; }
  .project-head .cost { margin-left: auto; font-size: 13px; color: var(--muted); }
  .project .root { font-size: 12.5px; color: var(--muted); margin-top: 2px; word-break: break-all; }
  .threads { margin-top: 14px; border-top: 1px solid var(--border); }
  .thread { display: flex; align-items: center; gap: 10px; padding: 9px 2px; border-bottom: 1px solid var(--border); }
  .thread:last-child { border-bottom: none; }
  .thread.dim { opacity: 0.5; }
  .thread .t-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .thread .t-time { font-size: 12.5px; color: var(--muted); flex: none; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th {
    text-align: left; font-size: 11.5px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted);
    padding: 8px 10px; border-bottom: 1px solid var(--border-strong);
    white-space: nowrap;
  }
  td { padding: 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  .table-wrap { overflow-x: auto; }
  td .cell-forms { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

  /* Banners */
  .banner {
    border-radius: var(--radius-sm);
    padding: 12px 16px;
    margin-bottom: 20px;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .banner-success {
    background: rgba(74, 222, 128, 0.08);
    border: 1px solid rgba(74, 222, 128, 0.3);
    color: var(--green);
  }
  .banner-warn {
    background: rgba(248, 113, 113, 0.08);
    border: 1px solid rgba(248, 113, 113, 0.35);
    color: var(--red);
  }
  .shared-list { list-style: none; margin: 0; padding: 0; }
  .shared-list li { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--border); }
  .shared-list li:last-child { border-bottom: none; }
  .shared-list .path { flex: 1; min-width: 0; word-break: break-all; }

  /* Hero */
  .hero { flex: 1; display: flex; align-items: center; justify-content: center; text-align: center; padding: 60px 24px; }
  .hero img { width: 96px; height: 96px; border-radius: 22px; margin-bottom: 26px; }
  .hero h1 { font-size: 34px; margin-bottom: 8px; }
  .hero .subhead { font-size: 18px; color: var(--muted); margin: 0 0 22px; }
  .hero .body { max-width: 420px; margin: 0 auto 26px; }
  .hero .footnote { font-size: 13.5px; color: var(--muted); }

  /* Misc */
  .row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .greeting { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 24px; }
  .actions-row { display: flex; gap: 12px; flex-wrap: wrap; }
  .paste-box {
    display: block;
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 14px 16px;
    word-break: break-all;
    user-select: all;
    -webkit-user-select: all;
    margin: 14px 0;
  }
  .center-page { max-width: 520px; margin: 40px auto 0; }
  .yesno { font-size: 13px; }
`;

function statusChip(status) {
  const s = String(status ?? "");
  const cls = s === "active" ? "chip ok" : s === "failed" ? "chip bad" : "chip";
  return `<span class="${cls}"><span class="dot"></span>${esc(s || "unknown")}</span>`;
}

function hiddenInput(name, value) {
  return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

function identityChip(identity) {
  if (!identity) return "";
  const login = esc(identity.login);
  const avatar = identity.profilePic
    ? `<img src="${esc(identity.profilePic)}" alt="">`
    : `<span class="avatar-fallback">${esc(
        String(identity.login || "?")
          .slice(0, 1)
          .toUpperCase(),
      )}</span>`;
  return `<span class="identity-chip">${avatar}<span>${login}</span></span>`;
}

function nav({ identity = null, links = [] } = {}) {
  const linkHtml = links
    .map((l) => `<a class="nav-link" href="${esc(l.href)}">${esc(l.label)}</a>`)
    .join("");
  return `<header class="nav">
    <div class="container nav-inner">
      <a class="brand" href="/"><img src="/static/logo.png" alt="">LateShift Cloud</a>
      <span class="nav-spacer"></span>
      ${linkHtml}
      ${identityChip(identity)}
    </div>
  </header>`;
}

function footer() {
  return `<footer>
    <div class="container">
      <span class="name">LateShift Cloud</span>
      <span class="muted">Your AI dev workspace</span>
    </div>
  </footer>`;
}

function layout({ title, body, navHtml = "", extraScript = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" type="image/png" href="/static/logo.png">
<style>${CSS}</style>
</head>
<body>
${navHtml}
${body}
${footer()}${extraScript}
</body>
</html>`;
}

// 1) Marketing hero for unknown visitors.
export function renderHero({ identityLogin } = {}) {
  const footnote =
    typeof identityLogin === "string"
      ? `Signed in to the tailnet as ${esc(identityLogin)} — this account has no workspace yet.`
      : "Sign in via your tailnet to continue.";
  const body = `<main class="hero">
    <div>
      <img src="/static/logo.png" alt="LateShift Cloud logo">
      <h1>LateShift Cloud</h1>
      <p class="subhead">Your AI dev workspace</p>
      <p class="body">Access is invite-only. Contact your administrator to get a workspace.</p>
      <p class="footnote">${footnote}</p>
    </div>
  </main>`;
  return layout({ title: "LateShift Cloud", body });
}

// 2) User dashboard.
export function renderDashboard(props) {
  const {
    csrf,
    identity,
    user,
    instanceStatus,
    projects,
    usage,
    isAdmin,
    budgetPaused,
    monthCostUsd,
  } = props;

  const navHtml = nav({
    identity,
    links: isAdmin ? [{ href: "/admin", label: "Admin" }] : [],
  });

  const pausedBanner = budgetPaused
    ? `<div class="banner banner-warn">Your workspace is paused: this month's usage
       (${esc(money(budgetPaused.monthCostUsd))}) reached your
       ${esc(money(budgetPaused.monthlyBudgetUsd))} budget. It resumes automatically
       next month, or ask your admin to raise the budget.</div>`
    : "";

  const budgetLine =
    user.monthlyBudgetUsd > 0
      ? `<p class="muted" style="margin:10px 0 0;font-size:13px">This month:
         ${esc(money(monthCostUsd ?? 0))} of ${esc(money(user.monthlyBudgetUsd))} budget.</p>`
      : "";

  const sharedProjectsHtml = user.sharedProjects?.length
    ? `<div class="card">
        <h2>Shared projects</h2>
        <ul class="shared-list">
          ${user.sharedProjects
            .map((p) => `<li><span class="path mono">${esc(p)}</span></li>`)
            .join("")}
        </ul>
        <p class="muted" style="font-size:13px;margin:12px 0 0">These appear inside your workspace. Work in worktree mode to avoid clashing with teammates in the same project.</p>
      </div>`
    : "";

  const openForms = `<div class="actions-row">
    <form method="POST" action="/open" class="inline">
      ${hiddenInput("csrf", csrf)}
      <button type="submit" class="btn btn-primary btn-big">Open my workspace</button>
    </form>
    ${
      user.sharedAccess
        ? `<form method="POST" action="/open-shared" class="inline">
      ${hiddenInput("csrf", csrf)}
      <button type="submit" class="btn btn-big">Open shared Roblox workspace</button>
    </form>`
        : ""
    }
  </div>`;

  const usageHtml = usage
    ? `<div class="stats">
        <div class="stat"><div class="label">Total cost</div><div class="value">${esc(money(usage.totalCostUsd))}</div></div>
        <div class="stat"><div class="label">Turns</div><div class="value">${esc(intFmt(usage.turns))}</div></div>
        <div class="stat"><div class="label">Input tokens</div><div class="value">${esc(intFmt(usage.inputTokens))}</div></div>
        <div class="stat"><div class="label">Output tokens</div><div class="value">${esc(intFmt(usage.outputTokens))}</div></div>
      </div>`
    : `<p class="muted" style="margin:0">No usage recorded yet.</p>`;

  const projectsHtml =
    projects.length === 0
      ? `<div class="card"><p class="muted" style="margin:0">No projects yet — open your workspace to create one.</p></div>`
      : projects
          .map((p) => {
            const deleted = Boolean(p.deletedAt);
            const threads = (p.threads || [])
              .map((t) => {
                const dim = Boolean(t.deletedAt || t.archivedAt);
                const tag = t.deletedAt
                  ? `<span class="tag">deleted</span>`
                  : t.archivedAt
                    ? `<span class="tag">archived</span>`
                    : "";
                return `<div class="thread${dim ? " dim" : ""}">
                  <span class="t-title">${esc(t.title)}</span>
                  ${tag}
                  <span class="t-time">${esc(relTime(t.updatedAt))}</span>
                </div>`;
              })
              .join("");
            return `<div class="card project${deleted ? " deleted" : ""}">
              <div class="project-head">
                <span class="title">${esc(p.title)}</span>
                ${deleted ? `<span class="tag">deleted</span>` : ""}
                ${p.costUsd != null ? `<span class="cost">${esc(money(p.costUsd))} spent</span>` : ""}
              </div>
              <div class="root mono">${esc(p.workspaceRoot)}</div>
              ${threads ? `<div class="threads">${threads}</div>` : ""}
            </div>`;
          })
          .join("\n");

  const body = `<main class="container">
    <div class="greeting">
      <h1 style="margin:0">Welcome back, ${esc(user.name)}</h1>
      ${statusChip(budgetPaused ? "paused (budget)" : instanceStatus)}
    </div>
    ${pausedBanner}

    <div class="card">
      <h2>Workspace</h2>
      ${openForms}
    </div>

    ${sharedProjectsHtml}

    <div class="card">
      <h2>Usage</h2>
      ${usageHtml}
      ${budgetLine}
    </div>

    <div class="section-title">Work history</div>
    ${projectsHtml}
  </main>`;

  return layout({ title: "Dashboard — LateShift Cloud", body, navHtml });
}

// 3) Admin page.
export function renderAdmin(props) {
  const { csrf, identity, users, aggregate, flash } = props;

  const navHtml = nav({ identity, links: [{ href: "/", label: "Dashboard" }] });

  const rows = users
    .map((u) => {
      const name = esc(u.name);
      return `<tr>
        <td>${name}${u.admin ? '<span class="badge-admin">admin</span>' : ""}</td>
        <td>${u.tsLogin ? esc(u.tsLogin) : '<span class="muted">—</span>'}</td>
        <td class="mono">${esc(u.localPort)} / ${esc(u.tsPort)}</td>
        <td>
          <form method="POST" action="/admin/set-limit" class="inline">
            ${hiddenInput("name", u.name)}
            ${hiddenInput("csrf", csrf)}
            <input type="number" name="limit" min="0" max="999" value="${esc(u.projectLimit)}" class="narrow">
            <button type="submit" class="btn btn-sm">Set</button>
          </form>
        </td>
        <td>
          <span class="yesno">${u.sharedAccess ? "yes" : "no"}</span>
          <form method="POST" action="/admin/toggle-shared" class="inline">
            ${hiddenInput("name", u.name)}
            ${hiddenInput("csrf", csrf)}
            <button type="submit" class="btn btn-sm">Toggle</button>
          </form>
        </td>
        <td>${statusChip(u.budgetPaused ? "paused (budget)" : u.instanceStatus)}</td>
        <td>
          <form method="POST" action="/admin/set-budget" class="inline">
            ${hiddenInput("name", u.name)}
            ${hiddenInput("csrf", csrf)}
            <input type="number" name="budget" min="0" max="100000" step="0.01" value="${esc(u.monthlyBudgetUsd || 0)}" class="narrow" style="width:80px">
            <button type="submit" class="btn btn-sm">Set</button>
          </form>
          ${
            u.monthlyBudgetUsd > 0
              ? `<div class="muted" style="font-size:11.5px;margin-top:3px">${esc(money(u.monthCostUsd ?? 0))} used</div>`
              : ""
          }
        </td>
        <td>${u.cost30dUsd != null ? esc(money(u.cost30dUsd)) : '<span class="muted">—</span>'}</td>
        <td>
          <div class="cell-forms">
            <form method="POST" action="/admin/pair" class="inline">
              ${hiddenInput("name", u.name)}
              ${hiddenInput("csrf", csrf)}
              <button type="submit" class="btn btn-sm">Pair link</button>
            </form>
            <form method="POST" action="/admin/remove-user" class="inline">
              ${hiddenInput("name", u.name)}
              ${hiddenInput("csrf", csrf)}
              <button type="submit" class="btn btn-sm btn-danger">Remove</button>
            </form>
          </div>
        </td>
      </tr>`;
    })
    .join("\n");

  const body = `<main class="container">
    <h1>Admin</h1>
    ${flash ? `<div class="banner banner-success">${esc(flash)}</div>` : ""}

    <div class="stats" style="margin-bottom:20px">
      <div class="stat"><div class="label">Users</div><div class="value">${esc(intFmt(aggregate.userCount))}</div></div>
      <div class="stat"><div class="label">Active instances</div><div class="value">${esc(intFmt(aggregate.activeCount))}</div></div>
      <div class="stat"><div class="label">Total cost (30d)</div><div class="value">${esc(money(aggregate.totalCost30dUsd))}</div></div>
    </div>

    <div class="card">
      <h2>Users</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Tailnet login</th><th>Ports</th><th>Limit</th>
              <th>Shared</th><th>Status</th><th>Budget/mo</th><th>Cost 30d</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="9" class="muted">No users yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Shared projects</h2>
      ${
        users.some((u) => u.sharedProjects?.length)
          ? `<ul class="shared-list">${users
              .flatMap((u) =>
                (u.sharedProjects ?? []).map(
                  (p) => `<li>
                    <span class="path mono">${esc(p)}</span>
                    <span class="tag">${esc(u.name)}</span>
                    <form method="POST" action="/admin/unshare-project" class="inline">
                      ${hiddenInput("name", u.name)}
                      ${hiddenInput("path", p)}
                      ${hiddenInput("csrf", csrf)}
                      <button type="submit" class="btn btn-sm btn-danger">Unshare</button>
                    </form>
                  </li>`,
                ),
              )
              .join("")}</ul>`
          : `<p class="muted" style="margin:0 0 14px">No shared project grants yet.</p>`
      }
      <form method="POST" action="/admin/share-project" style="margin-top:14px">
        ${hiddenInput("csrf", csrf)}
        <div class="row" style="align-items:flex-end">
          <div class="field">
            <label for="sp-name">User</label>
            <input type="text" id="sp-name" name="name" pattern="[a-z0-9-]{2,20}" required>
          </div>
          <div class="field" style="flex:1;min-width:260px">
            <label for="sp-path">Absolute project path</label>
            <input type="text" id="sp-path" name="path" placeholder="/home/dev/shared/ronopoly" required style="width:100%">
          </div>
          <button type="submit" class="btn btn-primary">Share</button>
        </div>
      </form>
      <p class="muted" style="font-size:13px;margin:12px 0 0">Paths must live under <code>/home/dev/shared/</code> or <code>/home/dev/projects/</code>. The project appears in the user's workspace immediately.</p>
    </div>

    <div class="card">
      <h2>Add user</h2>
      <form method="POST" action="/admin/add-user">
        ${hiddenInput("csrf", csrf)}
        <div class="row" style="align-items:flex-end">
          <div class="field">
            <label for="au-name">Name</label>
            <input type="text" id="au-name" name="name" pattern="[a-z0-9-]{2,20}" required>
          </div>
          <div class="field">
            <label for="au-tslogin">Tailnet login</label>
            <input type="text" id="au-tslogin" name="tsLogin" placeholder="user@github or email">
          </div>
          <div class="field">
            <label for="au-limit">Project limit</label>
            <input type="number" id="au-limit" name="projectLimit" value="3" min="0" max="999" class="narrow">
          </div>
          <div class="field" style="flex-direction:row;align-items:center;gap:7px;padding-bottom:9px">
            <input type="checkbox" id="au-shared" name="sharedAccess">
            <label for="au-shared">Shared access</label>
          </div>
          <button type="submit" class="btn btn-primary">Create user</button>
        </div>
      </form>
      <p class="muted" style="font-size:13px;margin:12px 0 0">Provisioning starts the instance and can take up to a minute.</p>
    </div>
  </main>`;

  return layout({ title: "Admin — LateShift Cloud", body, navHtml });
}

// 4) Generic confirmation page.
// NOTE: detailHtml is treated as pre-escaped HTML — callers must esc() their
// own dynamic values before building it (it may contain markup like <br>).
export function renderConfirm({
  csrf,
  title,
  heading,
  detailHtml,
  action,
  fields,
  confirmLabel,
  danger,
}) {
  const hidden = (fields || []).map((f) => hiddenInput(f.name, f.value)).join("\n        ");
  const body = `<main class="container">
    <div class="card center-page">
      <h1>${esc(heading)}</h1>
      <p class="muted">${detailHtml ?? ""}</p>
      <form method="POST" action="${esc(action)}" class="row">
        ${hidden}
        ${hiddenInput("csrf", csrf)}
        ${hiddenInput("confirm", "1")}
        <button type="submit" class="btn ${danger ? "btn-danger" : "btn-primary"}">${esc(confirmLabel)}</button>
        <a class="nav-link" href="/admin">Cancel</a>
      </form>
    </div>
  </main>`;
  return layout({ title: `${title} — LateShift Cloud`, body, navHtml: nav() });
}

// 5) Pairing-link result page.
export function renderPairResult({ name, url, backHref }) {
  const body = `<main class="container">
    <div class="card center-page">
      <h1>Pairing link for ${esc(name)}</h1>
      <code class="paste-box" id="pair-url">${esc(url)}</code>
      <p class="muted" style="font-size:13.5px">This link is one-time and expires soon. Send it to the user over a trusted channel.</p>
      <div class="row">
        <button type="button" class="btn" id="copy-btn">Copy</button>
        <a class="nav-link" href="${esc(backHref)}">Back</a>
      </div>
    </div>
  </main>`;
  const extraScript = `
<script>
(function () {
  var btn = document.getElementById('copy-btn');
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    btn.style.display = 'none';
    return;
  }
  btn.addEventListener('click', function () {
    navigator.clipboard.writeText(document.getElementById('pair-url').textContent).then(function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
    }).catch(function () {});
  });
})();
</script>`;
  return layout({ title: "Pairing link — LateShift Cloud", body, navHtml: nav(), extraScript });
}

// 6) Generic message/result page.
// NOTE: bodyHtml is treated as pre-escaped HTML supplied by the caller.
export function renderMessage({ title, heading, bodyHtml, backHref, error }) {
  const body = `<main class="container">
    <div class="card center-page">
      <h1${error ? ' style="color:var(--red)"' : ""}>${esc(heading)}</h1>
      <div>${bodyHtml ?? ""}</div>
      ${backHref ? `<p style="margin-top:20px"><a href="${esc(backHref)}">Back</a></p>` : ""}
    </div>
  </main>`;
  return layout({ title: `${title} — LateShift Cloud`, body, navHtml: nav() });
}

// 7) 403 page.
export function renderForbidden({ identity }) {
  const body = `<main class="container">
    <div class="card center-page">
      <h1>403 — Admins only</h1>
      ${identity && identity.login ? `<p class="muted">Signed in as ${esc(identity.login)}</p>` : ""}
      <p style="margin-top:20px"><a href="/">Back to LateShift Cloud</a></p>
    </div>
  </main>`;
  return layout({ title: "403 — LateShift Cloud", body, navHtml: nav({ identity }) });
}
