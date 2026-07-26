# Slither cloud deployment

This fork is the hosted T3 Code UI for the `t3cloud` server. The editable development checkout
lives at `/home/dev/projects/t3code`. Production runs from a separate checkout at
`/home/dev/services/t3code-production` so agent work in the project does not disturb the live
service.

## Deployment model

- Pull requests run the upstream CI suite from `.github/workflows/ci.yml`.
- A merge to `main` triggers `.github/workflows/deploy-slither-cloud.yml`.
- The deploy workflow SSHes to `t3cloud`, fast-forwards the production checkout, installs
  dependencies with `corepack pnpm install --frozen-lockfile`, builds with `corepack pnpm build`,
  and restarts the `t3code` systemd service.

## Production service

The live service is a systemd unit on `t3cloud`:

```ini
[Unit]
Description=T3 Code server
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=dev
WorkingDirectory=/home/dev/services/t3code-production
Environment=PATH=/home/dev/.local/bin:/home/dev/.rokit/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/home/dev/.t3-env
ExecStart=/usr/bin/node /home/dev/services/t3code-production/apps/server/dist/bin.mjs serve --tailscale-serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

After changing the unit, reload and restart it:

```bash
sudo systemctl daemon-reload
sudo systemctl restart t3code
sudo systemctl status t3code --no-pager
```

## GitHub secrets

The deploy workflow expects these repository secrets:

- `T3CLOUD_DEPLOY_HOST`: public SSH host for `t3cloud`
- `T3CLOUD_DEPLOY_USER`: SSH user, currently `dev`
- `T3CLOUD_DEPLOY_SSH_KEY`: private deploy key for the GitHub Action
- `T3CLOUD_PRODUCTION_DIR`: production checkout path, currently `/home/dev/services/t3code-production`

## Using the hosted forked UI

After the service is running from this fork, the server serves the forked web client directly.
Use the Tailscale HTTPS URL for the backend itself, not `https://app.t3.codes`, when you want the
custom UI:

```text
https://t3cloud.taild7c97b.ts.net/
```

To pair a device, create a token on the server:

```bash
sudo -u dev t3 auth pairing create
```

Then open the pairing URL from the command output, or construct the direct server URL yourself:

```text
https://t3cloud.taild7c97b.ts.net/pair#token=TOKEN
```

Once paired, open `https://t3cloud.taild7c97b.ts.net/` on mobile or desktop to use the forked web
client.

## Upstream sync

Keep `origin` pointed at `slitherylemur/t3code` and `upstream` pointed at `pingdotgg/t3code`.
Pull upstream changes into `main` regularly so the fork stays shallow:

```bash
git fetch upstream
git checkout main
git merge upstream/main
git push origin main
```
