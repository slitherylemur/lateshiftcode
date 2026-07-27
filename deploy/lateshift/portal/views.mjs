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

// GitHub mark, inline so the hero button needs no extra asset.
const GITHUB_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" ' +
  'style="vertical-align:-2px;margin-right:7px" fill="currentColor">' +
  '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 ' +
  '0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 ' +
  '1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 ' +
  '0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 ' +
  '1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 ' +
  '3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 ' +
  '8.01 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>';

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

// "in 2h 14m" style countdown to a future epoch-ms instant.
function untilLabel(ms) {
  const diff = Number(ms) - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return "now";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const rm = mins % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function clockUtc(ms) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(11, 16)} UTC`;
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
    --info: #6ea8fe;
    --danger: #b3403f;
    --danger-strong: #cc5250;
    --nav-bg: rgba(11, 14, 20, 0.85);
    --btn-hover: #1d2434;
    --ring-track: rgba(255, 255, 255, 0.10);
    --sel: rgba(230, 162, 60, 0.14);
    --radius: 12px;
    --radius-sm: 8px;
  }
  html[data-theme="light"] {
    --bg: #f4f6f9;
    --surface: #ffffff;
    --surface-2: #eef1f6;
    --border: rgba(15, 23, 42, 0.10);
    --border-strong: rgba(15, 23, 42, 0.18);
    --text: #1a2130;
    --muted: #59637a;
    --accent: #c07d1c;
    --accent-strong: #a86a12;
    --accent-ink: #fff7ea;
    --green: #14834a;
    --red: #c23b3b;
    --info: #2563c9;
    --danger: #b3403f;
    --danger-strong: #99302f;
    --nav-bg: rgba(255, 255, 255, 0.9);
    --btn-hover: #e5e9f0;
    --ring-track: rgba(15, 23, 42, 0.10);
    --sel: rgba(192, 125, 28, 0.14);
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
  .container { width: 100%; max-width: 1120px; margin: 0 auto; padding: 0 24px; }
  main.container { flex: 1; padding-top: 32px; padding-bottom: 56px; }

  /* Nav */
  .nav { border-bottom: 1px solid var(--border); background: var(--nav-bg); backdrop-filter: blur(6px); position: sticky; top: 0; z-index: 5; }
  .nav-inner { display: flex; align-items: center; gap: 16px; height: 60px; }
  .brand { display: flex; align-items: center; gap: 10px; color: var(--text); font-weight: 600; letter-spacing: 0.01em; }
  .brand:hover { text-decoration: none; }
  .brand img { width: 28px; height: 28px; border-radius: 7px; display: block; }
  .nav-spacer { flex: 1; }
  .nav-link { color: var(--muted); font-weight: 500; padding: 6px 10px; border-radius: var(--radius-sm); }
  .nav-link:hover { color: var(--text); background: var(--btn-hover); text-decoration: none; }
  .theme-toggle {
    font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
    color: var(--muted); background: var(--surface); border: 1px solid var(--border);
    border-radius: 999px; padding: 6px 12px; display: inline-flex; align-items: center; gap: 6px;
  }
  .theme-toggle:hover { color: var(--text); border-color: var(--border-strong); }
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
  h3 { font-size: 14px; font-weight: 600; margin: 0 0 10px; }
  .muted { color: var(--muted); }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 22px 24px;
    margin-bottom: 20px;
  }
  .card.tight { padding: 16px 18px; }
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
  .btn:hover { background: var(--btn-hover); border-color: var(--border-strong); }
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

  /* Tags / badges */
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
  .badge-you {
    display: inline-block; font-size: 10.5px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--info); border: 1px solid rgba(110, 168, 254, 0.45);
    border-radius: 5px; padding: 1px 6px; margin-left: 7px; vertical-align: middle;
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

  /* ---- Subscription totals (rings + window bars) ---- */
  .sub-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .sub-card { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 18px; }
  .sub-head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .sub-head .name { font-weight: 650; font-size: 15px; }
  .sub-body { display: flex; align-items: center; gap: 18px; }
  .ring {
    position: relative; width: 96px; height: 96px; border-radius: 50%; flex: none;
    background: conic-gradient(var(--pc, var(--accent)) calc(var(--pct, 0) * 1%), var(--ring-track) 0);
  }
  .ring.over { background: conic-gradient(var(--red) calc(var(--pct, 0) * 1%), var(--ring-track) 0); }
  .ring::before { content: ""; position: absolute; inset: 11px; border-radius: 50%; background: var(--surface-2); }
  .ring .ring-pct { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px; }
  .sub-meta { flex: 1; min-width: 0; }
  .sub-meta .big { font-size: 20px; font-weight: 650; letter-spacing: -0.01em; }
  .sub-meta .cap { font-size: 12.5px; color: var(--muted); }
  .window { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
  .window .wrow { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 12.5px; }
  .window .wrow .amt { font-weight: 650; font-size: 13.5px; }
  .bar { height: 8px; border-radius: 999px; background: var(--ring-track); overflow: hidden; margin-top: 7px; }
  .bar > span { display: block; height: 100%; background: var(--pc, var(--accent)); }
  .bar.over > span { background: var(--red); }
  .approx { font-size: 11.5px; color: var(--muted); margin-top: 8px; }

  /* ---- Master / detail admin layout ---- */
  .admin-grid { display: grid; grid-template-columns: 300px 1fr; gap: 20px; align-items: start; }
  @media (max-width: 860px) { .admin-grid { grid-template-columns: 1fr; } }
  .userlist { list-style: none; margin: 0; padding: 0; }
  .userlist li { margin: 0; }
  .userlist a {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-sm);
    color: var(--text); border: 1px solid transparent;
  }
  .userlist a:hover { background: var(--surface-2); text-decoration: none; }
  .userlist a.active { background: var(--sel); border-color: var(--border-strong); }
  .userlist .u-name { flex: 1; min-width: 0; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .userlist .u-edit { font-size: 12px; color: var(--muted); flex: none; }
  .userlist a:hover .u-edit { color: var(--accent); }
  .sdot { width: 9px; height: 9px; border-radius: 50%; background: #6b7280; flex: none; }
  .sdot.ok { background: var(--green); box-shadow: 0 0 6px rgba(74,222,128,0.5); }
  .sdot.bad { background: var(--red); box-shadow: 0 0 6px rgba(248,113,113,0.5); }
  .sdot.self { background: var(--info); box-shadow: 0 0 6px rgba(110,168,254,0.5); }
  .detail-title { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
  .detail-title h2 { margin: 0; font-size: 20px; }
  .setting-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
  .setting { display: flex; flex-direction: column; gap: 6px; }
  .setting .k { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }

  /* Share manager switches */
  .share-list { list-style: none; margin: 0; padding: 0; }
  .share-list li { display: flex; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--border); }
  .share-list li:last-child { border-bottom: none; }
  .share-list .sp-name { flex: 1; min-width: 0; }
  .share-list .sp-name .sub { display: block; font-size: 11.5px; color: var(--muted); word-break: break-all; }
  .switch { display: inline-flex; align-items: center; gap: 8px; background: none; border: none; padding: 0; cursor: pointer; font: inherit; color: var(--muted); }
  .switch .track {
    width: 40px; height: 22px; border-radius: 999px; background: var(--ring-track);
    border: 1px solid var(--border-strong); position: relative; transition: background 120ms ease;
  }
  .switch .track::after {
    content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
    background: var(--muted); transition: transform 120ms ease, background 120ms ease;
  }
  .switch.on .track { background: var(--accent); border-color: var(--accent); }
  .switch.on .track::after { transform: translateX(18px); background: var(--accent-ink); }
  .switch .lbl { font-size: 12px; min-width: 26px; text-align: left; }
  .switch.on .lbl { color: var(--accent); }

  /* Leaderboard */
  .lb { list-style: none; margin: 0; padding: 0; }
  .lb li { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
  .lb li:last-child { border-bottom: none; }
  .lb .rank { width: 22px; text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; font-weight: 600; flex: none; }
  .lb .who { width: 130px; flex: none; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lb .lbar { flex: 1; min-width: 60px; height: 10px; border-radius: 999px; background: var(--ring-track); overflow: hidden; }
  .lb .lbar > span { display: block; height: 100%; background: var(--accent); }
  .lb .amt { flex: none; width: 92px; text-align: right; font-weight: 650; font-variant-numeric: tabular-nums; }
  .lb .brk { flex: none; font-size: 11.5px; color: var(--muted); width: 168px; text-align: right; }
  @media (max-width: 640px) { .lb .brk { display: none; } .lb .who { width: 90px; } }

  /* Pending access requests (admin) */
  .pend-list { display: flex; flex-direction: column; gap: 4px; }
  .pend-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 0; border-bottom: 1px solid var(--border); }
  .pend-row:last-child { border-bottom: none; }
  .pend-who { display: flex; align-items: center; gap: 10px; min-width: 200px; flex: 1; }
  .pend-av { width: 36px; height: 36px; border-radius: 50%; flex: none; object-fit: cover; }
  .pend-av-fb { display: inline-flex; align-items: center; justify-content: center; background: var(--surface-2); color: var(--muted); font-weight: 600; }
  .pend-login { font-weight: 600; }
  .pend-actions { display: flex; align-items: center; gap: 6px; }
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

function themeToggle() {
  // Pure client-side preference (no server mutation → no CSRF needed). The
  // <head> bootstrap script applies the cookie before first paint.
  return `<button type="button" class="theme-toggle" onclick="lscToggleTheme()" aria-label="Toggle light or dark theme">
    <span data-theme-icon>🌙</span><span data-theme-label>Dark</span>
  </button>`;
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
      ${themeToggle()}
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

// Bootstrap: apply the persisted theme before first paint (avoids a flash),
// and define the toggle used by the nav button.
const THEME_SCRIPT = `<script>
(function () {
  try {
    var m = document.cookie.match(/(?:^|; )lsc_theme=(dark|light)/);
    var t = m ? m[1] : "dark";
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}
})();
function lscToggleTheme() {
  var d = document.documentElement;
  var next = d.getAttribute("data-theme") === "light" ? "dark" : "light";
  d.setAttribute("data-theme", next);
  try { document.cookie = "lsc_theme=" + next + "; Path=/; Max-Age=31536000; SameSite=Strict"; } catch (e) {}
  lscSyncThemeLabel();
}
function lscSyncThemeLabel() {
  var light = document.documentElement.getAttribute("data-theme") === "light";
  document.querySelectorAll("[data-theme-icon]").forEach(function (el) { el.textContent = light ? "☀️" : "🌙"; });
  document.querySelectorAll("[data-theme-label]").forEach(function (el) { el.textContent = light ? "Light" : "Dark"; });
}
document.addEventListener("DOMContentLoaded", lscSyncThemeLabel);
</script>`;

function layout({ title, body, navHtml = "", extraScript = "" }) {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" type="image/png" href="/static/logo.png">
${THEME_SCRIPT}
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
export function renderHero({ identityLogin, githubEnabled } = {}) {
  const footnote =
    typeof identityLogin === "string"
      ? `Signed in as ${esc(identityLogin)} — this account has no workspace yet.`
      : "Access is invite-only.";
  const githubBtn = githubEnabled
    ? `<p style="margin:0 0 22px"><a class="btn btn-primary btn-big" href="/auth/github/login">${GITHUB_ICON}Sign in with GitHub</a></p>`
    : "";
  const body = `<main class="hero">
    <div>
      <img src="/static/logo.png" alt="LateShift Cloud logo">
      <h1>LateShift Cloud</h1>
      <p class="subhead">Your AI dev workspace</p>
      <p class="body">Access is invite-only. Sign in with GitHub to request a workspace, or contact your administrator.</p>
      ${githubBtn}
      <p class="footnote">${footnote}</p>
    </div>
  </main>`;
  return layout({ title: "LateShift Cloud", body, navHtml: nav() });
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

// ---- admin sub-renderers ------------------------------------------------

const PROVIDERS = [
  { key: "claude", label: "Claude", color: "var(--accent)" },
  { key: "codex", label: "Codex", color: "var(--info)" },
];

function ring(pct, color) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const over = Number(pct) > 100;
  const shown = pct == null ? "—" : `${Math.round(Number(pct))}%`;
  return `<div class="ring${over ? " over" : ""}" style="--pct:${clamped};--pc:${color}">
    <div class="ring-pct">${esc(shown)}</div>
  </div>`;
}

function renderSubscription(subscription) {
  const { totals, windows, limits } = subscription;
  const cards = PROVIDERS.map((p) => {
    const color = p.color;
    const monthCost = Number(totals[p.key] || 0);
    const monthCap = limits[p.key];
    const monthPct = monthCap ? (monthCost / monthCap) * 100 : null;

    const w = windows[p.key];
    const winCost = w ? Number(w.cost || 0) : 0;
    const winCap = limits[`${p.key}5h`];
    const winPct = winCap ? Math.min(100, (winCost / winCap) * 100) : winCost > 0 ? 100 : 0;
    const winOver = winCap ? winCost > winCap : false;
    const resetHtml = w
      ? `resets in ${esc(untilLabel(w.reset))} · ${esc(clockUtc(w.reset))}`
      : "no activity yet";

    const capLine = monthCap
      ? `<span class="cap">of ${esc(money(monthCap))} / mo cap</span>`
      : `<span class="cap">no monthly cap set</span>`;

    return `<div class="sub-card">
      <div class="sub-head">
        <span class="sdot" style="background:${color};box-shadow:none"></span>
        <span class="name">${esc(p.label)}</span>
      </div>
      <div class="sub-body">
        ${ring(monthPct, color)}
        <div class="sub-meta">
          <div class="big">${esc(money(monthCost))}</div>
          ${capLine}
          <div class="cap" style="margin-top:4px">month-to-date, all instances</div>
        </div>
      </div>
      <div class="window">
        <div class="wrow">
          <span>Current 5-hour window</span>
          <span class="amt">${esc(money(winCost))}${winCap ? ` <span class="muted">/ ${esc(money(winCap))}</span>` : ""}</span>
        </div>
        <div class="bar${winOver ? " over" : ""}" style="--pc:${color}"><span style="width:${winPct}%"></span></div>
        <div class="wrow" style="margin-top:6px"><span class="muted">${resetHtml}</span></div>
      </div>
      <div class="approx">Approximate — 5-hour windows are inferred from turn activity across all instances.</div>
    </div>`;
  }).join("");

  const otherTotal = Number(totals.other || 0);
  const otherLine =
    otherTotal > 0
      ? `<p class="muted" style="font-size:12.5px;margin:14px 0 0">Other providers this month: ${esc(money(otherTotal))}.</p>`
      : "";

  return `<div class="card">
    <h2>Subscription usage</h2>
    <div class="sub-grid">${cards}</div>
    ${otherLine}
  </div>`;
}

function userSdot(u) {
  if (u.isSelf) return "self";
  if (u.budgetPaused) return "bad";
  if (u.instanceStatus === "active") return "ok";
  if (u.instanceStatus === "failed") return "bad";
  return "";
}

function renderUserList(users, self, selectedKey, csrf) {
  const items = [];
  // Synthetic "you" entry when the admin has no registry user of their own.
  if (!self.present) {
    const active = selectedKey === "@self";
    items.push(`<li><a class="${active ? "active" : ""}" href="/admin?u=%40self">
      <span class="sdot self"></span>
      <span class="u-name">${esc(self.login || "You")}</span>
      <span class="u-edit">You</span>
    </a></li>`);
  }
  for (const u of users) {
    const active = selectedKey === u.name;
    const badge = u.isSelf
      ? '<span class="u-edit" style="color:var(--info)">You</span>'
      : '<span class="u-edit">Edit</span>';
    items.push(`<li><a class="${active ? "active" : ""}" href="/admin?u=${encodeURIComponent(u.name)}">
      <span class="sdot ${userSdot(u)}"></span>
      <span class="u-name">${esc(u.name)}${u.admin ? '<span class="badge-admin">admin</span>' : ""}</span>
      ${badge}
    </a></li>`);
  }
  return `<div class="card tight">
    <h3>Users <span class="muted" style="font-weight:500">(${users.length})</span></h3>
    <ul class="userlist">${items.join("")}</ul>
  </div>`;
}

function workspaceCard(self, csrf) {
  if (!self.workspaceConfigured) {
    return `<div class="card">
      <h2>Your workspace</h2>
      <p class="muted" style="margin:0">The shared production workspace URL is not configured.</p>
    </div>`;
  }
  return `<div class="card">
    <h2>Your workspace</h2>
    <p class="muted" style="margin:0 0 14px">Open your own LateShift workspace, or the shared production workspace. A one-time pairing link is minted and you are redirected into it.</p>
    <div class="actions-row">
      <form method="POST" action="/admin/open-workspace" class="inline">
        ${hiddenInput("csrf", csrf)}
        <button type="submit" class="btn btn-primary btn-big">Open my workspace</button>
      </form>
      <form method="POST" action="/admin/open-workspace" class="inline">
        ${hiddenInput("csrf", csrf)}
        ${hiddenInput("shared", "1")}
        <button type="submit" class="btn btn-big">Open production workspace</button>
      </form>
    </div>
  </div>`;
}

function shareManager(user, sharedDirs, csrf, { readOnly = false } = {}) {
  if (!sharedDirs.length) {
    return `<div class="card">
      <h2>Share manager</h2>
      <p class="muted" style="margin:0">No shareable projects — nothing under <code>/home/dev/shared/</code> yet.</p>
    </div>`;
  }
  const granted = new Set(user?.sharedProjects ?? []);
  const rows = sharedDirs
    .map((d) => {
      const on = readOnly ? true : granted.has(d.path);
      if (readOnly) {
        return `<li>
          <span class="sp-name">${esc(d.name)}<span class="sub mono">${esc(d.path)}</span></span>
          <span class="switch on" aria-hidden="true"><span class="track"></span><span class="lbl">all</span></span>
        </li>`;
      }
      const action = on ? "/admin/unshare-project" : "/admin/share-project";
      return `<li>
        <span class="sp-name">${esc(d.name)}<span class="sub mono">${esc(d.path)}</span></span>
        <form method="POST" action="${action}" class="inline">
          ${hiddenInput("name", user.name)}
          ${hiddenInput("path", d.path)}
          ${hiddenInput("csrf", csrf)}
          <button type="submit" class="switch ${on ? "on" : ""}" title="${on ? "Revoke access" : "Grant access"}">
            <span class="track"></span><span class="lbl">${on ? "on" : "off"}</span>
          </button>
        </form>
      </li>`;
    })
    .join("");
  const note = readOnly
    ? `<p class="muted" style="font-size:12.5px;margin:12px 0 0">As admin you have access to every shared project.</p>`
    : `<p class="muted" style="font-size:12.5px;margin:12px 0 0">Toggling grants or revokes the project in <code>${esc(user.name)}</code>'s workspace immediately (via <code>t3user share/unshare</code>).</p>`;
  return `<div class="card">
    <h2>Share manager</h2>
    <ul class="share-list">${rows}</ul>
    ${note}
  </div>`;
}

function userSettingsCard(u, csrf) {
  return `<div class="card">
    <h2>Settings</h2>
    <div class="setting-grid">
      <div class="setting">
        <span class="k">Project limit</span>
        <form method="POST" action="/admin/set-limit" class="row" style="gap:8px">
          ${hiddenInput("name", u.name)}
          ${hiddenInput("csrf", csrf)}
          <input type="number" name="limit" min="0" max="999" value="${esc(u.projectLimit)}" class="narrow">
          <button type="submit" class="btn btn-sm">Set</button>
        </form>
      </div>
      <div class="setting">
        <span class="k">Monthly budget (USD)</span>
        <form method="POST" action="/admin/set-budget" class="row" style="gap:8px">
          ${hiddenInput("name", u.name)}
          ${hiddenInput("csrf", csrf)}
          <input type="number" name="budget" min="0" max="100000" step="0.01" value="${esc(u.monthlyBudgetUsd || 0)}" class="narrow" style="width:90px">
          <button type="submit" class="btn btn-sm">Set</button>
        </form>
        <span class="k" style="text-transform:none;font-weight:500;color:var(--muted)">${u.monthlyBudgetUsd > 0 ? `${esc(money(u.monthCostUsd ?? 0))} used this month` : "unlimited"}</span>
      </div>
      <div class="setting">
        <span class="k">Tailnet login</span>
        <form method="POST" action="/admin/set-tslogin" class="row" style="gap:8px">
          ${hiddenInput("name", u.name)}
          ${hiddenInput("csrf", csrf)}
          <input type="text" name="tsLogin" value="${esc(u.tsLogin ?? "")}" placeholder="user@example.com" style="flex:1;min-width:150px">
          <button type="submit" class="btn btn-sm">Set</button>
        </form>
      </div>
      <div class="setting">
        <span class="k">Flags</span>
        <div class="row" style="gap:8px">
          <span class="yesno">Shared access: <strong>${u.sharedAccess ? "yes" : "no"}</strong></span>
          <form method="POST" action="/admin/toggle-shared" class="inline">
            ${hiddenInput("name", u.name)}
            ${hiddenInput("csrf", csrf)}
            <button type="submit" class="btn btn-sm">Toggle</button>
          </form>
        </div>
        <div class="row" style="gap:8px">
          <span class="yesno">Admin: <strong>${u.admin ? "yes" : "no"}</strong></span>
          <form method="POST" action="/admin/toggle-admin" class="inline">
            ${hiddenInput("name", u.name)}
            ${hiddenInput("csrf", csrf)}
            <button type="submit" class="btn btn-sm">Toggle</button>
          </form>
        </div>
      </div>
    </div>
  </div>`;
}

function pairAndDangerCard(u, csrf) {
  return `<div class="card">
    <h2>Access &amp; lifecycle</h2>
    <div class="row" style="gap:12px">
      <form method="POST" action="/admin/pair" class="inline">
        ${hiddenInput("name", u.name)}
        ${hiddenInput("csrf", csrf)}
        <button type="submit" class="btn">Generate pairing link</button>
      </form>
      <form method="POST" action="/admin/remove-user" class="inline">
        ${hiddenInput("name", u.name)}
        ${hiddenInput("csrf", csrf)}
        <button type="submit" class="btn btn-danger">Remove user…</button>
      </form>
    </div>
    <p class="muted" style="font-size:12.5px;margin:12px 0 0">Ports <code>${esc(u.localPort)}</code> / <code>${esc(u.tsPort)}</code> · 30-day spend ${u.cost30dUsd != null ? esc(money(u.cost30dUsd)) : "—"}.</p>
  </div>`;
}

function renderDetail(props) {
  const { users, self, selectedKey, sharedDirs, csrf } = props;

  // Admin's own account with no registry user of their own.
  if (selectedKey === "@self" && !self.present) {
    return `<div>
      <div class="detail-title"><h2>${esc(self.login || "Your account")}</h2><span class="badge-you">you · admin</span></div>
      <p class="muted" style="margin:0 0 20px">Your admin account has no separate LateShift workspace of its own — you work in the shared production workspace.</p>
      ${workspaceCard(self, csrf)}
      ${shareManager(null, sharedDirs, csrf, { readOnly: true })}
    </div>`;
  }

  const u = users.find((x) => x.name === selectedKey) || users.find((x) => x.isSelf) || users[0];
  if (!u) {
    return `<div class="card"><p class="muted" style="margin:0">No users yet. Add one below.</p></div>`;
  }

  const selfBadge = u.isSelf ? '<span class="badge-you">you</span>' : "";
  const adminBadge = u.admin ? '<span class="badge-admin">admin</span>' : "";
  const statusHtml = statusChip(u.budgetPaused ? "paused (budget)" : u.instanceStatus);
  const selfWorkspace = u.isSelf ? workspaceCard(self, csrf) : "";
  const share = u.isSelf
    ? shareManager(u, sharedDirs, csrf, { readOnly: true })
    : shareManager(u, sharedDirs, csrf);

  return `<div>
    <div class="detail-title">
      <h2>${esc(u.name)}</h2>${adminBadge}${selfBadge}${statusHtml}
    </div>
    <p class="muted" style="margin:0 0 20px">${u.tsLogin ? `Tailnet: ${esc(u.tsLogin)}` : "No tailnet login mapped."}</p>
    ${selfWorkspace}
    ${userSettingsCard(u, csrf)}
    ${pairAndDangerCard(u, csrf)}
    ${share}
  </div>`;
}

function renderLeaderboard(leaderboard) {
  if (!leaderboard.length) {
    return `<div class="card"><h2>Usage leaderboard</h2><p class="muted" style="margin:0">No users yet.</p></div>`;
  }
  const max = Math.max(1e-9, ...leaderboard.map((l) => l.total));
  const rows = leaderboard
    .map((l, i) => {
      const pct = Math.max(2, (l.total / max) * 100);
      const brk = `C ${esc(money(l.claude))} · X ${esc(money(l.codex))}${l.other > 0 ? ` · o ${esc(money(l.other))}` : ""}`;
      return `<li>
        <span class="rank">${i + 1}</span>
        <span class="who">${esc(l.name)}</span>
        <span class="lbar"><span style="width:${pct}%"></span></span>
        <span class="amt">${esc(money(l.total))}</span>
        <span class="brk" title="Claude / Codex breakdown">${brk}</span>
      </li>`;
    })
    .join("");
  return `<div class="card">
    <h2>Usage leaderboard <span class="muted" style="font-size:13px;font-weight:500">· month-to-date</span></h2>
    <ul class="lb">${rows}</ul>
    <p class="muted" style="font-size:12px;margin:12px 0 0">C = Claude, X = Codex, o = other.</p>
  </div>`;
}

function addUserCard(csrf) {
  return `<div class="card">
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
  </div>`;
}

// 3) Admin page — master/detail with subscription totals and leaderboard.
// Awaiting-approval page shown to an unknown GitHub user after OAuth.
export function renderAwaitingApproval({ login, name, avatar, denied } = {}) {
  const who = name ? `${esc(name)} (@${esc(login)})` : `@${esc(login)}`;
  const avatarHtml = avatar
    ? `<img src="${esc(avatar)}" alt="" style="width:72px;height:72px;border-radius:50%;margin-bottom:16px">`
    : "";
  const inner = denied
    ? `<h1>Access unavailable</h1>
       <p class="muted">Sorry ${who}, access for this account is not available.</p>`
    : `<h1>Request received</h1>
       <p class="muted">Thanks ${who} — your request for a LateShift Cloud workspace is
       awaiting admin approval. You can sign in here once it has been approved.</p>`;
  const body = `<main class="container">
    <div class="card center-page">
      ${avatarHtml}
      ${inner}
      <p style="margin-top:20px"><a href="/auth/logout">Sign out</a></p>
    </div>
  </main>`;
  return layout({ title: "Awaiting approval — LateShift Cloud", body, navHtml: nav() });
}

// Admin card: pending GitHub access requests with Approve / Deny actions.
function renderPending(pending, csrf) {
  const list = Array.isArray(pending) ? pending : [];
  if (!list.length) return "";
  const rows = list
    .map((pReq) => {
      const login = esc(pReq.login);
      const suggested =
        String(pReq.login || "")
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 20) || "user";
      const avatar = pReq.avatar
        ? `<img src="${esc(pReq.avatar)}" alt="" class="pend-av">`
        : `<span class="pend-av pend-av-fb">${esc(String(pReq.login || "?").slice(0, 1).toUpperCase())}</span>`;
      return `<div class="pend-row">
      <div class="pend-who">${avatar}<div>
        <div class="pend-login">@${login}</div>
        <div class="muted" style="font-size:12.5px">${pReq.name ? esc(pReq.name) + " · " : ""}${esc(relTime(pReq.requestedAt))}</div>
      </div></div>
      <form method="POST" action="/admin/approve" class="pend-actions">
        ${hiddenInput("csrf", csrf)}${hiddenInput("login", pReq.login)}
        <input type="text" name="name" value="${esc(suggested)}" pattern="[a-z0-9-]{2,20}" required class="narrow" aria-label="workspace name">
        <input type="number" name="projectLimit" value="3" min="0" max="999" class="narrow" aria-label="project limit">
        <button type="submit" class="btn btn-sm btn-primary">Approve</button>
      </form>
      <form method="POST" action="/admin/deny" class="pend-actions">
        ${hiddenInput("csrf", csrf)}${hiddenInput("login", pReq.login)}
        <button type="submit" class="btn btn-sm btn-danger">Deny</button>
      </form>
    </div>`;
    })
    .join("");
  return `<div class="card">
    <h2>Pending requests <span class="muted" style="font-weight:400;font-size:15px">(${list.length})</span></h2>
    <div class="pend-list">${rows}</div>
  </div>`;
}

export function renderAdmin(props) {
  const {
    csrf,
    identity,
    users,
    self,
    selectedKey,
    sharedDirs,
    subscription,
    leaderboard,
    aggregate,
    flash,
    pending,
  } = props;

  const navHtml = nav({ identity, links: [{ href: "/", label: "Dashboard" }] });

  const body = `<main class="container">
    <h1>Admin</h1>
    ${flash ? `<div class="banner banner-success">${esc(flash)}</div>` : ""}

    <div class="stats" style="margin-bottom:20px">
      <div class="stat"><div class="label">Users</div><div class="value">${esc(intFmt(aggregate.userCount))}</div></div>
      <div class="stat"><div class="label">Active instances</div><div class="value">${esc(intFmt(aggregate.activeCount))}</div></div>
      <div class="stat"><div class="label">Total cost (30d)</div><div class="value">${esc(money(aggregate.totalCost30dUsd))}</div></div>
    </div>

    ${renderSubscription(subscription)}

    ${renderPending(pending, csrf)}

    <div class="admin-grid">
      ${renderUserList(users, self, selectedKey, csrf)}
      ${renderDetail({ users, self, selectedKey, sharedDirs, csrf })}
    </div>

    ${renderLeaderboard(leaderboard)}

    ${addUserCard(csrf)}
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
