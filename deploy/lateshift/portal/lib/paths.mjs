// paths.mjs — the portal's reserved URL root under the v2 single-origin design.
//
// architecture-v2.md §6 originally reserved /auth/*, /account, /admin and
// /api/lsc/*. Spike W0-C showed that is unsafe: the T3 server has a catch-all
// `GET *` that never 404s, and the web app's TanStack route
// /$environmentId/$threadId claims EVERY two-segment path. So a future upstream
// /account (or a matcher typo) would silently render the chat SPA instead of a
// portal page. W0-C's recommendation, adopted here: ONE reserved root that
// upstream will never use.
//
//   LSC_PREFIX = "/~lsc"
//
// Every portal-owned URL is `${LSC_PREFIX}/...`. `normalizePath()` strips the
// prefix so the route table stays written in bare form, and unprefixed paths
// keep working for the CURRENTLY DEPLOYED gateway and for the GitHub OAuth app's
// registered redirect_uri (https://lateshiftcloud.com/auth/github/callback),
// which cannot be changed from this repo. Those bare aliases are transitional:
// delete them once W7's gateway and the GitHub OAuth app both point at
// `${LSC_PREFIX}`.

export const LSC_PREFIX = "/~lsc";

/** Absolute portal URL for a bare, leading-slash path. p("/account"). */
export function p(bare) {
  const s = String(bare ?? "/");
  if (s === "/") return `${LSC_PREFIX}/`;
  return `${LSC_PREFIX}${s.startsWith("/") ? s : `/${s}`}`;
}

/**
 * Strip the reserved root from a request pathname, tolerating the percent-
 * encoded form of '~' and a missing trailing slash.
 * Returns { path, prefixed }.
 *   "/~lsc/account" -> { path: "/account", prefixed: true }
 *   "/~lsc"         -> { path: "/",        prefixed: true }
 *   "/account"      -> { path: "/account", prefixed: false }
 */
export function normalizePath(pathname) {
  let s = String(pathname ?? "/");
  // Only the '~' may plausibly arrive percent-encoded; do not decode anything
  // else here (decoding the whole path would let %2F smuggle a segment).
  const lowered = s.slice(0, 7).toLowerCase();
  if (lowered.startsWith("/%7e")) s = `/~${s.slice(4)}`;
  if (s === LSC_PREFIX) return { path: "/", prefixed: true };
  if (s.startsWith(`${LSC_PREFIX}/`)) {
    return { path: s.slice(LSC_PREFIX.length) || "/", prefixed: true };
  }
  return { path: s, prefixed: false };
}
