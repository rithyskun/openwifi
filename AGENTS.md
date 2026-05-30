# OpenCode Agent Instructions

This file helps OpenCode understand the OpenWiFi project structure, conventions, and how to work effectively with this codebase.

## Project Overview

OpenWiFi is a peer-to-peer mesh network application with:
- **Backend**: Node.js with Express, Socket.IO, and native TCP sockets
- **Frontend**: Vanilla JavaScript (no framework) with dark theme UI
- **Encryption**: X25519 ECDH + AES-256-GCM for messages, PBKDF2 + AES-256-GCM for database
- **Discovery**: mDNS/Zeroconf for automatic peer detection
- **Routing**: Controlled flooding with TTL and duplicate suppression

## Code Conventions

### Backend (Node.js)
- **Async/await** preferred over callbacks
- **Event-driven** architecture using EventEmitter
- **Modular design**: Each file has a single responsibility (crypto, db, discovery, router, etc.)
- **Error handling**: Use try/catch blocks, emit error events, log with console.error
- **No TypeScript**: Plain JavaScript with JSDoc comments for complex functions

### Frontend (Vanilla JS)
- **No framework**: Direct DOM manipulation with `document.getElementById/querySelector`
- **Event listeners**: Attached after element creation, not inline HTML
- **CSS classes**: Toggle via `classList.add/remove/toggle` for state changes
- **No build step**: ES6 modules not used; single `app.js` file

### Testing
- **Framework**: Node.js built-in test runner (`node --test`)
- **Location**: `test/` directory with `*.test.js` files
- **Run tests**: `npm test`
- **Coverage**: Crypto, vault, database, and file transfer modules

### File Structure
```
src/           # Backend modules
public/        # Frontend static files (HTML, CSS, JS)
test/          # Test files
```

## Common Tasks

### Adding a New Feature
1. Identify which module owns the functionality
2. Add backend logic in `src/` (emit events, handle Socket.IO messages)
3. Add frontend UI in `public/app.js` (DOM elements, event listeners)
4. Add styling in `public/style.css` (follow dark theme palette)
5. Add tests in `test/` if logic is complex
6. Run `npm test` to verify no regressions

### Modifying the UI
- **Layout**: `public/index.html` (semantic HTML, flexbox layout)
- **Behavior**: `public/app.js` (event handlers, DOM updates)
- **Styling**: `public/style.css` (dark theme: #1a1a2e, #16213e, #0f3460, #e94560)
- **No build tools**: Changes take effect on browser refresh

### Working with Encryption
- **Never log keys or plaintext secrets**
- Crypto functions in `src/crypto.js` are pure and testable
- Vault encryption in `src/vault.js` handles database encryption at rest
- All peer communication goes through `src/peer-manager.js` which handles encryption/decryption

### Mesh Routing
- Messages flood through the network via `src/router.js`
- Each message has a unique ID to prevent duplicate processing
- TTL (time-to-live) prevents infinite loops
- AI requests can be relayed through the mesh to remote peers

## Practical Use Cases for OpenCode

### Add Features
```
Add streaming responses to the AI chat so users see tokens as they're generated
Add message encryption indicators showing which messages are end-to-end encrypted
Add a peer statistics dashboard showing connection quality and message counts
```

### Refactor
```
Extract the file transfer logic from src/file-transfer.js into smaller modules
Refactor the peer authentication flow to use async/await instead of nested callbacks
Extract common UI rendering functions into a separate utils module
```

### Debug
```
Why do chunk retries sometimes fail silently in file transfers?
Why does the mDNS discovery sometimes not find peers on the same network?
Why is the AI mesh relay not forwarding responses back to the requester?
```

### Write Tests
```
Add tests for the AI mesh relay in src/router.js
Add tests for the PIN authentication flow
Add tests for edge cases in the chunked file transfer system
```

### Explain Code
```
How does the X25519 key exchange work in src/crypto.js?
What is the flow when a new peer connects and authenticates?
How does the mesh flooding algorithm prevent message duplication?
```

## OpenCode Features

### Plan Mode (Tab Key)
Use Plan mode to design complex features before implementing:
1. Switch to Plan mode with Tab
2. Describe the feature in detail
3. Review and iterate on the plan
4. Switch back to Build mode with Tab
5. Ask OpenCode to implement the changes

### File References (@ Symbol)
Use `@` to fuzzy-search and reference files:
```
How does authentication work in @src/index.js?
Refactor the UI component in @public/app.js that handles peer list rendering
```

### Undo/Redo
- `/undo` - Revert the last change
- `/redo` - Reapply the reverted change
- Can be used multiple times to navigate change history

### Share Sessions
- `/share` - Generate a shareable link to the current conversation
- Useful for collaborating with team members or documenting decisions

### MCP Servers
Connect external tools via Model Context Protocol:
- Database explorers for inspecting SQLite schema
- API clients for testing AI model endpoints
- Custom tools for project-specific workflows

### Custom Skills and Agents
Create project-specific workflows:
- Custom skills for repetitive tasks (e.g., "add new message type")
- Subagents for specialized work (e.g., "security review agent")
- Custom commands for common operations

## Testing Commands

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run dev

# Start development server with auto-reload
npm run dev

# Manual multi-node testing
node src/index.js --name "A" --db /tmp/a.db &
node src/index.js --name "B" --db /tmp/b.db &
```

## Common Issues

### Port Conflicts
If ports are in use, specify custom ports:
```bash
npm start -- --web-port 8080 --tcp-port 9000
```

### Database Locked
SQLite can lock if multiple processes access it. Use separate `--db` paths for testing.

### Peer Discovery Issues
- Ensure both nodes are on the same network/subnet
- Check firewall settings for mDNS (port 5353 UDP)
- Verify TCP ports are accessible between nodes

## Security Reminders

- **Never commit secrets** (API keys, passphrases) to the repository
- **Never log encryption keys** or sensitive plaintext data
- **Always use the crypto module** for encryption (don't implement your own)
- **Test with vault encryption enabled** when modifying database operations
