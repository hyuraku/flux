# flux

> Fast, secure peer-to-peer file transfer

[![Deploy to GitHub Pages](https://github.com/hyuraku/flux/actions/workflows/deploy.yml/badge.svg)](https://github.com/hyuraku/flux/actions/workflows/deploy.yml)

## Overview

flux is a web-based file transfer tool that sends files directly between devices using WebRTC peer-to-peer technology. No server storage, no upload limits.

## Features

- **Encrypted in transit** - Secured by WebRTC (DTLS) between browsers
- **Direct P2P** - Files transfer directly, device to device
- **No Server Storage** - File data never passes through our servers
- **Up to 2GB** - Per transfer
- **Cross-Platform** - Works on any modern browser

## How It Works

1. Open flux on both devices
2. Click "Receive" on the receiving device to get a 6-digit code
3. Click "Send" on the sending device, enter the code, and select files
4. Files transfer directly between devices

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite 6 + Tailwind CSS 4
- **Signaling**: PartyKit
- **P2P**: WebRTC

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Start PartyKit signaling server
npm run party:dev

# Run tests
npm test
```

### Production build

`vite.config.ts` intentionally fails the build if `VITE_PARTYKIT_HOST` is not
set, so a build can't silently fall back to `localhost` and ship broken.
Set it to your deployed PartyKit host before building:

```bash
# Local production build (signaling server on localhost)
VITE_PARTYKIT_HOST=localhost:1999 npm run build

# GitHub Pages build (served under /flux/, signaling on the deployed host)
GITHUB_PAGES=true VITE_PARTYKIT_HOST=flux.<your-partykit-user>.partykit.dev npm run build
```

- `VITE_PARTYKIT_HOST` - the PartyKit host that handles WebRTC signaling (required for every production build).
- `GITHUB_PAGES` - set to `true` when building for GitHub Pages so Vite serves the app from the `/flux/` base path instead of `/`.

## Deployment

### 1. Deploy the PartyKit signaling server

```bash
npx partykit deploy
```

This deploys `src/party/server.ts` (see `partykit.json`) and prints the
resulting host name, typically `<project-name>.<partykit-user>.partykit.dev`.
Use that host as `VITE_PARTYKIT_HOST` below. You can also find it any time
by running `npx partykit list` or checking the PartyKit dashboard.

### 2. Build and deploy the frontend to GitHub Pages

The `.github/workflows/deploy.yml` workflow builds and publishes `dist/` to
GitHub Pages on every push to `main`. It reads the PartyKit host from the
repository variable `vars.VITE_PARTYKIT_HOST` (Settings → Secrets and
variables → Actions → Variables), so set that to the host from step 1 before
merging. Locally, the equivalent build is:

```bash
GITHUB_PAGES=true VITE_PARTYKIT_HOST=<host-from-step-1> npm run build
```

### 3. Verify the deployment

1. Open the deployed site (`https://<user>.github.io/flux/`) in two
   separate browser windows (or two devices).
2. In one window, click "Receive" and note the 6-digit code.
3. In the other window, click "Send", enter the code, and pick a file.
4. In DevTools → Network (filter: WS), confirm both windows open a
   WebSocket connection to your PartyKit host, and that the file transfer
   completes.

### Rollback

- **GitHub Pages**: open the failed/bad deploy in the Actions tab and
  `Re-run` the previous successful `Deploy to GitHub Pages` run, or revert
  the offending commit on `main` and let the workflow redeploy.
- **PartyKit**: redeploy the previous known-good revision of
  `src/party/server.ts` with `npx partykit deploy` (e.g. after
  `git checkout <previous-commit> -- src/party/server.ts`).

## License

MIT
