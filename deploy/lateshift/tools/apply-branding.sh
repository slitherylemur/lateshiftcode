#!/usr/bin/env bash
# apply-branding.sh <dist-client-dir> — swap T3 branding for LateShift Cloud in a
# built web client directory (tab title + favicons/touch icons). Static files
# only; originals are kept as *.lsc-orig the first time. Safe to re-run, and
# meant to run after every rebuild (update-from-upstream.sh calls it).
#
# Scope note: this brands ONLY what this server serves. app.t3.codes and the
# desktop app keep upstream branding, as do strings inside the JS bundle.
set -euo pipefail

CLIENT_DIR="${1:?usage: apply-branding.sh <dist-client-dir>}"
LOGO=/home/dev/services/lateshift/assets/lateshift-logo.png
BRAND="LateShift Cloud"

[[ -d "${CLIENT_DIR}" ]] || { echo "no such dir: ${CLIENT_DIR}" >&2; exit 1; }
[[ -f "${LOGO}" ]] || { echo "logo missing: ${LOGO}" >&2; exit 1; }

# Tab title in every top-level html file.
for html in "${CLIENT_DIR}"/*.html; do
    [[ -f "${html}" ]] || continue
    [[ -f "${html}.lsc-orig" ]] || cp "${html}" "${html}.lsc-orig"
    sed -i -E "s|<title>[^<]*</title>|<title>${BRAND}</title>|" "${html}"
done

# Icons: modern browsers happily use PNG data for all of these link rels.
for icon in favicon-16x16.png favicon-32x32.png apple-touch-icon.png favicon.ico; do
    target="${CLIENT_DIR}/${icon}"
    [[ -f "${target}" ]] || continue
    [[ -f "${target}.lsc-orig" ]] || cp "${target}" "${target}.lsc-orig"
    cp "${LOGO}" "${target}"
done

echo "branded ${CLIENT_DIR} as '${BRAND}' (originals: *.lsc-orig)"
