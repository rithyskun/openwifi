const path = require('path')
const os = require('os')
const { v4: uuidv4 } = require('uuid')
const { generateKeypair } = require('./crypto')
const { Vault } = require('./vault')
const { createDatabase } = require('./db')
const { createDiscovery } = require('./discovery')
const { createPeerManager } = require('./peer-manager')
const { createRouter } = require('./router')
const { createWebUI } = require('./web-ui')
const { FileTransferManager } = require('./file-transfer')

const args = process.argv.slice(2)
let nameIndex = args.indexOf('--name')
const peerName = nameIndex !== -1 ? args[nameIndex + 1] : os.hostname()
let portIndex = args.indexOf('--web-port')
const webPort = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 0
let tcpPortIndex = args.indexOf('--tcp-port')
const tcpPort = tcpPortIndex !== -1 ? parseInt(args[tcpPortIndex + 1], 10) : 0
let dbPathIndex = args.indexOf('--db')
const dbPath = dbPathIndex !== -1 ? args[dbPathIndex + 1] : path.join(__dirname, '..', 'openwifi.db')
let secretIndex = args.indexOf('--secret')
const secretArg = secretIndex !== -1 ? args[secretIndex + 1] : null
const secret = secretArg || process.env.OPENWIFI_SECRET || null

const peerId = uuidv4().slice(0, 8)

let vault = null
if (secret) {
  const dbRaw = createDatabase(dbPath)
  let salt = dbRaw.getVaultSalt()
  if (!salt) {
    salt = Vault.generateSalt()
    dbRaw.saveVaultSalt(salt)
    console.log(`  Vault: initialized with new salt`)
  }
  vault = Vault.fromPassphrase(secret, salt)
  dbRaw.close()
}

const vaultMode = vault ? 'encrypted' : 'plaintext'
const db = createDatabase(dbPath, vault)

let keypair = db.getKeypair()
if (!keypair) {
  keypair = generateKeypair()
  db.saveKeypair(keypair.publicKey, keypair.privateKey)
}

if (secret && !vault) {
  console.error('  Fatal: failed to unlock vault, wrong passphrase?')
  process.exit(1)
}

const pendingPINAuths = new Map()

const discoveryInfo = { id: peerId, name: peerName, tcpPort, webPort, onPeerFound }
const discovery = createDiscovery(discoveryInfo)

const peerManager = createPeerManager({
  id: peerId,
  name: peerName,
  publicKey: keypair.publicKey,
  privateKey: keypair.privateKey,
  onMessageReceived,
  onPeerConnected: () => {},
  onPeerDisconnected,
  onHandshakeComplete,
})

const router = createRouter(
  { id: peerId, name: peerName, onAppMessage },
  peerManager
)

const fileTransfer = new FileTransferManager(peerManager)

fileTransfer.on('download-announce', (info) => {
  webUI.broadcastFileTransferEvent({ ...info, action: 'announce' })
})

fileTransfer.on('download-progress', (info) => {
  webUI.broadcastFileTransferEvent({ ...info, action: 'progress' })
})

fileTransfer.on('download-complete', (info) => {
  webUI.broadcastFileTransferEvent({ ...info, action: 'complete' })
})

fileTransfer.on('download-error', (info) => {
  webUI.broadcastFileTransferEvent({ ...info, action: 'error' })
})

fileTransfer.on('send-status', (info) => {
  webUI.broadcastFileTransferEvent({ ...info, action: 'send-status' })
  if (info.status === 'error') {
    console.log(`  File transfer error: ${info.error}`)
  }
})

fileTransfer.on('send-progress', (info) => {
  webUI.broadcastFileTransferEvent({ ...info, action: 'send-progress' })
})

const webUI = createWebUI({
  id: peerId,
  name: peerName,
  getPeers: () => peerManager.getConnectedPeers(),
  sendMessage: (to, payload) => router.sendMessage(to, payload),
  onPINSubmit,
  onFileTransferStart: ({ transferId, fileName, fileSize, to }) => {
    fileTransfer.startTransfer(transferId, fileName, fileSize, to)
  },
  onFileChunkUpload: ({ transferId, index, data }) => {
    fileTransfer.sendChunk(transferId, index, data)
  },
  onFileTransferEnd: ({ transferId }) => {
    fileTransfer.endTransfer(transferId)
  },
  onFileTransferAccept: ({ transferId }) => {
    fileTransfer.acceptDownload(transferId)
  },
  onFileTransferCancel: ({ transferId }) => {
    fileTransfer.cancelTransfer(transferId)
  },
  getFileDownloadPath: (transferId) => fileTransfer.getDownloadPath(transferId),
  getFileDownloadInfo: (transferId) => fileTransfer.getDownloadInfo(transferId),
})

async function main() {
  const actualTcpPort = await peerManager.startServer(tcpPort || 0)
  const actualWebPort = await webUI.start(webPort || 0)

  discoveryInfo.tcpPort = actualTcpPort
  discoveryInfo.webPort = actualWebPort
  discovery.start()

  const localIP = discovery.getLocalIP()
  console.log(`\n  OpenWiFi Mesh Node`)
  console.log(`  ─────────────────`)
  console.log(`  ID:     ${peerId}`)
  console.log(`  Name:   ${peerName}`)
  console.log(`  TCP:    ${localIP}:${actualTcpPort}`)
  console.log(`  Web UI: http://localhost:${actualWebPort}`)
  console.log(`  DB:     ${dbPath}`)
  console.log(`  Vault:  ${vaultMode}`)
  console.log(`  E2E:    X25519 + AES-256-GCM\n`)

  if (!secret) {
    console.log('  ⚠  No --secret provided. Database is NOT encrypted.')
    console.log('  ⚠  Use --secret "<passphrase>" or OPENWIFI_SECRET to secure your data.\n')
  }
}

function onPeerFound(peer) {
  if (peerManager.isConnected(peer.id)) return
  console.log(`  Found peer: ${peer.name} (${peer.id}) at ${peer.host}:${peer.tcpPort}`)
  if (peerId.localeCompare(peer.id) < 0) {
    console.log(`  Initiating connection to ${peer.name}`)
    peerManager.connectToPeer(peer.host, peer.tcpPort)
  }
}

function onHandshakeComplete(remoteId, remoteName, remotePublicKey, sharedKey) {
  console.log(`  Handshake complete: ${remoteName} (${remoteId})`)
  webUI.broadcastPeers(peerManager.getConnectedPeers())

  if (db.isTrustedPeer(remoteId)) {
    console.log(`  ${remoteName} is trusted, skipping PIN auth`)
    peerManager.sendToPeer(remoteId, { type: '_auth_result', payload: { success: true, skipPIN: true } })
    notifyAuthReady(remoteId, remoteName)
    return
  }

  if (peerId.localeCompare(remoteId) < 0) {
    console.log(`  Requesting PIN auth from ${remoteName}...`)
    peerManager.sendToPeer(remoteId, { type: '_auth_request', payload: { fromName: peerName } })
  }
}

function onMessageReceived(msg, fromPeerId) {
  const peer = peerManager.getPeerInfo(fromPeerId)
  if (!peer) return

  if (msg.type === '_auth_request') {
    handleIncomingAuthRequest(fromPeerId, peer.name)
    return
  }

  if (msg.type === '_auth_challenge') {
    handleIncomingAuthChallenge(msg, fromPeerId)
    return
  }

  if (msg.type === '_auth_response') {
    handleIncomingAuthResponse(msg, fromPeerId)
    return
  }

  if (msg.type === '_auth_result') {
    handleIncomingAuthResult(msg, fromPeerId, peer.name)
    return
  }

  if (msg.type === '_auth_ready') {
    console.log(`  ${peer.name} authenticated, encrypted channel ready`)
    webUI.broadcastPeers(peerManager.getConnectedPeers())
    return
  }

  if (msg.type === '_auth_abort') {
    console.log(`  Auth aborted by ${peer.name}`)
    webUI.broadcastPeerAuthEvent({ peerId: fromPeerId, peerName: peer.name, type: 'aborted' })
    return
  }

  if (msg.type === 'file-transfer') {
    fileTransfer.handleP2PMessage(msg, fromPeerId)
    return
  }

  router.handleIncomingMessage(msg, fromPeerId)
}

function handleIncomingAuthRequest(fromPeerId, fromName) {
  const pin = String(Math.floor(100000 + Math.random() * 900000))

  pendingPINAuths.set(fromPeerId, { pin, peerName: fromName, createdAt: Date.now() })

  console.log(`  PIN for ${fromName}: ${pin}`)

  webUI.broadcastPeerAuthEvent({
    type: 'pin_required',
    peerId: fromPeerId,
    peerName: fromName,
    pin,
  })

  peerManager.sendToPeer(fromPeerId, {
    type: '_auth_challenge',
    payload: { fromName: peerName },
  })

  setTimeout(() => {
    if (pendingPINAuths.has(fromPeerId)) {
      pendingPINAuths.delete(fromPeerId)
      peerManager.sendToPeer(fromPeerId, { type: '_auth_abort', payload: {} })
      console.log(`  PIN auth timed out for ${fromName}`)
    }
  }, 120000)
}

function handleIncomingAuthChallenge(msg, fromPeerId) {
  const peer = peerManager.getPeerInfo(fromPeerId)
  if (!peer) return

  webUI.broadcastPeerAuthEvent({
    type: 'awaiting_pin',
    peerId: fromPeerId,
    peerName: peer.name,
  })
}

function handleIncomingAuthResponse(msg, fromPeerId) {
  const pending = pendingPINAuths.get(fromPeerId)
  if (!pending) {
    peerManager.sendToPeer(fromPeerId, {
      type: '_auth_result',
      payload: { success: false, message: 'No pending auth' },
    })
    return
  }

  const submittedPIN = msg.payload.pin

  if (submittedPIN === pending.pin) {
    const peer = peerManager.getPeerInfo(fromPeerId)
    if (!peer) return

    pendingPINAuths.delete(fromPeerId)
    db.addTrustedPeer(fromPeerId, pending.peerName, '')

    peerManager.sendToPeer(fromPeerId, {
      type: '_auth_result',
      payload: { success: true, message: 'Authenticated' },
    })

    console.log(`  PIN verified for ${pending.peerName}`)
    notifyAuthReady(fromPeerId, pending.peerName)
  } else {
    console.log(`  Wrong PIN from ${pending.peerName}`)
    peerManager.sendToPeer(fromPeerId, {
      type: '_auth_result',
      payload: { success: false, message: 'Wrong PIN' },
    })
    pendingPINAuths.delete(fromPeerId)
    webUI.broadcastPeerAuthEvent({
      type: 'auth_failed',
      peerId: fromPeerId,
      peerName: pending.peerName,
    })
  }
}

function handleIncomingAuthResult(msg, fromPeerId, fromName) {
  if (msg.payload.success) {
    console.log(`  ${fromName} authenticated us`)
    notifyAuthReady(fromPeerId, fromName)
  } else {
    console.log(`  Auth rejected by ${fromName}: ${msg.payload.message || ''}`)
    webUI.broadcastPeerAuthEvent({
      type: 'auth_failed',
      peerId: fromPeerId,
      peerName: fromName,
      message: msg.payload.message,
    })
  }
}

function notifyAuthReady(peerId, peerName) {
  peerManager.sendToPeer(peerId, { type: '_auth_ready', payload: {} })
  webUI.broadcastPeers(peerManager.getConnectedPeers())
  webUI.broadcastPeerAuthEvent({
    type: 'authenticated',
    peerId,
    peerName,
  })
}

function onPINSubmit(data) {
  const peerId = data.peerId
  const pin = data.pin
  const peer = peerManager.getPeerInfo(peerId)
  if (!peer) return

  peerManager.sendToPeer(peerId, {
    type: '_auth_response',
    payload: { pin },
  })
}

function onPeerDisconnected(peerId) {
  console.log(`  Disconnected: ${peerId}`)
  pendingPINAuths.delete(peerId)
  webUI.broadcastPeers(peerManager.getConnectedPeers())
}

function onAppMessage(msg) {
  webUI.broadcastAppMessage(msg)
}

process.on('SIGINT', () => {
  console.log('\n  Shutting down...')
  discovery.stop()
  peerManager.stop()
  webUI.stop()
  db.close()
  process.exit(0)
})

process.on('SIGTERM', () => {
  discovery.stop()
  peerManager.stop()
  webUI.stop()
  db.close()
  process.exit(0)
})

main().catch((err) => {
  console.error('Failed to start:', err)
  process.exit(1)
})
