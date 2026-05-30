# OpenWiFi — P2P Mesh Network

A cross-platform peer-to-peer mesh network over WiFi with end-to-end encryption and PIN-based authentication. Devices on the same LAN discover each other automatically and establish secure encrypted tunnels for chat and file transfer.

## Features

- **Zero-config discovery** — mDNS/Zeroconf automatically finds peers on the local network
- **End-to-end encryption** — X25519 ECDH key exchange + AES-256-GCM on every message
- **PIN authentication** — 6-digit PIN verification prevents unauthorized access
- **Mesh routing** — Messages are flooded through the mesh with TTL and duplicate suppression
- **File sharing** — Drag-and-drop file transfers through the encrypted channel
- **Web UI** — Clean dark-theme interface accessible from any browser
- **Persistent trust** — Authenticated peers stored in SQLite, skip PIN on reconnection
- **Cross-platform** — Works on macOS, Windows, and Linux

## Architecture

```
┌──────────┐     Socket.IO     ┌──────────────────┐     Encrypted TCP     ┌──────────┐
│  Browser  │◄────────────────►│  index.js         │◄────────────────────►│  Peers   │
│  (Web UI) │                  │  (orchestrator)   │                       │          │
└──────────┘                   │                   │                       └──────────┘
                               │  ┌─ crypto.js ──┐ │
                               │  │ X25519 + AES │ │
                               │  └──────────────┘ │
                               │  ┌─── db.js ────┐ │
                               │  │   SQLite     │ │
                               │  └──────────────┘ │
                               │  ┌─ discovery ──┐ │
                               │  │    mDNS      │ │
                               │  └──────────────┘ │
                               │  ┌─ router ─────┐ │
                               │  │ mesh flood   │ │
                               │  └──────────────┘ │
                               └──────────────────┘
```

### How it works

1. Each node advertises itself via **mDNS** and browses for other `_openwifi` services on the LAN
2. When two nodes find each other, the lower-ID peer initiates a **TCP connection**
3. Both sides exchange **X25519 public keys** and derive a shared AES-256-GCM key via ECDH
4. If the peer isn't in the trusted database, a **6-digit PIN** is shown on one screen and must be entered on the other
5. After PIN verification, the peer is stored in **SQLite** and all messages are **encrypted end-to-end**
6. Messages propagate through the mesh via **controlled flooding** (TTL + duplicate suppression)

## Installation

### Prerequisites

- **Node.js** v18 or later ([download](https://nodejs.org))

### Quick start

```bash
# Clone or download the project
cd openwifi

# macOS / Linux
bash install.sh

# Windows (PowerShell)
.\install.ps1
```

Or manually:

```bash
npm install
```

## Usage

```bash
# Start with your computer's hostname as the node name
npm start

# Start with a custom name
npm start -- --name "MyNode"

# Start on specific ports
npm start -- --name "MyNode" --web-port 8080 --tcp-port 9000

# Use a custom database path
npm start -- --db /path/to/mesh.db
```

Open the Web UI URL printed in the terminal (`http://localhost:<port>`) in any browser.

### Testing with multiple nodes

Open two terminal windows:

```bash
# Terminal 1
npm start -- --name "Alpha"

# Terminal 2
npm start -- --name "Beta"
```

Both nodes will discover each other automatically. The Web UI will guide you through the PIN authentication flow.

## Security

### Encryption

| Layer | Algorithm |
|---|---|
| Key exchange | X25519 ECDH |
| Key derivation | HKDF-SHA256 |
| Encryption | AES-256-GCM |
| Per-message IV | Random 16 bytes |
| Auth tag | 16 bytes (verified on decrypt) |

### Authentication flow

1. Requester sends `_auth_request` (encrypted)
2. Responder generates 6-digit PIN, displays on screen
3. Requester's UI shows PIN input dialog
4. PIN is sent encrypted and verified server-side
5. On success: peer added to SQLite trusted store
6. Future reconnections skip PIN for trusted peers

### PIN timeout

Pending PIN challenges expire after **120 seconds**.

## Project structure

```
openwifi/
├── install.sh          # macOS/Linux installer
├── install.ps1         # Windows installer
├── package.json
├── src/
│   ├── crypto.js       # X25519, AES-256-GCM, key derivation
│   ├── db.js            # SQLite trusted peer storage
│   ├── discovery.js     # mDNS/Zeroconf peer discovery
│   ├── index.js         # Main entry point, auth orchestrator
│   ├── peer-manager.js  # TCP connections, encryption layer
│   ├── router.js        # Mesh message flooding
│   └── web-ui.js        # Express + Socket.IO server
└── public/
    ├── index.html       # Web UI layout
    ├── app.js           # Frontend logic
    └── style.css        # Dark theme styling
```

## Command-line options

| Flag | Default | Description |
|---|---|---|
| `--name <name>` | Hostname | Display name for this node |
| `--web-port <port>` | Random | Web UI HTTP port |
| `--tcp-port <port>` | Random | P2P TCP port |
| `--db <path>` | `./openwifi.db` | SQLite database path |

## Development

```bash
# Watch mode (restarts on file changes)
npm run dev

# Manual test with two nodes
node src/index.js --name "A" --db /tmp/a.db &
node src/index.js --name "B" --db /tmp/b.db &
```

## License

MIT
