# flux

> Fast, secure peer-to-peer file transfer

[![Deploy to GitHub Pages](https://github.com/hyuraku/flux/actions/workflows/deploy.yml/badge.svg)](https://github.com/hyuraku/flux/actions/workflows/deploy.yml)

## Overview

flux is a web-based file transfer tool that sends files directly between devices using WebRTC peer-to-peer technology. No server storage, no upload limits.

## Features

- **End-to-End Encrypted** - Your files stay private
- **Blazingly Fast** - Direct P2P transfer
- **No Server Storage** - Data never touches our servers
- **No File Size Limits** - Up to 2GB per transfer
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

# Build for production
npm run build
```

## License

MIT
