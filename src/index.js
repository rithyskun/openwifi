const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const { generateKeypair, generatePIN } = require('./crypto')
const { Vault } = require('./vault')
const { createDatabase } = require('./db')
const { createDiscovery } = require('./discovery')
const { createPeerManager } = require('./peer-manager')
const { createRouter } = require('./router')
const { createWebUI } = require('./web-ui')
const { FileTransferManager } = require('./file-transfer')
const { PIN_TIMEOUT, PIN_MAX_ATTEMPTS, RECONNECT_BASE_DELAY, RECONNECT_MAX_DELAY } = require('./config')

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
  }
  vault = Vault.fromPassphrase(secret, salt)
  dbRaw.close()
}

const vaultMode = vault ? 'encrypted' : 'plaintext'
const db = createDatabase(dbPath, vault)

function isValidKeypair(kp) {
  if (!kp || typeof kp.publicKey !== 'string' || typeof kp.privateKey !== 'string') return false
  try {
    crypto.createPrivateKey({ key: Buffer.from(kp.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
    crypto.createPublicKey({ key: Buffer.from(kp.publicKey, 'base64'), format: 'der', type: 'spki' })
    return true
  } catch {
    return false
  }
}

let keypair = db.getKeypair()
if (!isValidKeypair(keypair)) {
  keypair = generateKeypair()
  db.saveKeypair(keypair.publicKey, keypair.privateKey)
}

if (secret && !vault) {
  console.error('  Fatal: failed to unlock vault, wrong passphrase?')
  process.exit(1)
}

const pendingPINAuths = new Map()
const pinFailures = new Map()
const reconnectBackoff = new Map()
const MAX_BACKOFF_ENTRIES = 256
const discoveredPeers = new Map()

const wsToken = crypto.randomBytes(16).toString('hex')

setInterval(() => {
  const now = Date.now()
  for (const [id, entry] of reconnectBackoff) {
    if (entry.nextAttempt + RECONNECT_MAX_DELAY < now) {
      reconnectBackoff.delete(id)
    }
  }
  for (const [id, failures] of pinFailures) {
    if (failures >= PIN_MAX_ATTEMPTS) {
      pinFailures.delete(id)
    }
  }
}, 60000).unref()

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
})

fileTransfer.on('send-progress', (info) => {
  webUI.broadcastFileTransferEvent({ ...info, action: 'send-progress' })
})

const webUI = createWebUI({
  id: peerId,
  name: peerName,
  wsToken,
  getPeers: () => peerManager.getConnectedPeers(),
  getDiscoveredPeers: () => Array.from(discoveredPeers.values()),
  onConnectPeer,
  sendMessage: (to, payload) => router.sendMessage(to, payload),
  onPINSubmit,
  onFileTransferStart: ({ transferId, fileName, fileSize, to }) => {
    fileTransfer.startTransfer(transferId, fileName, fileSize, to)
  },
  onFileChunkUpload: ({ transferId, index, data }) => {
    return fileTransfer.sendChunk(transferId, index, data)
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
}

function onPeerFound(peer) {
  if (peerManager.isConnected(peer.id)) return
  if (discoveredPeers.has(peer.id)) return
  discoveredPeers.set(peer.id, peer)
  webUI.broadcastDiscoveredPeers(Array.from(discoveredPeers.values()))
}

function onConnectPeer(peerId) {
  const peer = discoveredPeers.get(peerId)
  if (!peer) return false
  if (peerManager.isConnected(peerId)) return false
  peerManager.connectToPeer(peer.host, peer.tcpPort)
  return true
}

function onHandshakeComplete(remoteId, remoteName, remotePublicKey, sharedKey) {
  discoveredPeers.delete(remoteId)
  webUI.broadcastDiscoveredPeers(Array.from(discoveredPeers.values()))
  webUI.broadcastPeers(peerManager.getConnectedPeers())

  const stored = db.getTrustedPeer(remoteId)
  if (stored) {
    if (stored.public_key && stored.public_key !== remotePublicKey) {
    } else {
      peerManager.markAuthenticated(remoteId)
      peerManager.sendToPeer(remoteId, { type: '_auth_result', payload: { success: true, skipPIN: true } }, { skipAuth: true })
      notifyAuthReady(remoteId, remoteName)
      resetBackoff(remoteId)
      return
    }
  }

  if (peerId.localeCompare(remoteId) < 0) {
    peerManager.sendToPeer(remoteId, { type: '_auth_request', payload: { fromName: peerName } }, { skipAuth: true })
  }
}

function onMessageReceived(msg, fromPeerId) {
  try {
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
      webUI.broadcastPeers(peerManager.getConnectedPeers())
      return
    }

    if (msg.type === '_auth_abort') {
      webUI.broadcastPeerAuthEvent({ peerId: fromPeerId, peerName: peer.name, type: 'aborted' })
      return
    }

    if (!peer.authenticated) {
      return
    }

    if (msg.type === 'file-transfer') {
      fileTransfer.handleP2PMessage(msg, fromPeerId)
      return
    }

    if (msg.type === 'ai-request') {
      handleAIRequest(msg, fromPeerId)
      return
    }

    if (msg.type === 'ai-response') {
      webUI.broadcastAIMessage({
        requestId: msg.requestId,
        response: msg.response,
        error: msg.error,
        from: msg.from,
        fromName: msg.fromName,
      })
      return
    }

    router.handleIncomingMessage(msg, fromPeerId)
  } catch {
    // ignore
  }
}

async function handleAIRequest(msg, fromPeerId) {
  const requestId = msg.requestId
  const messages = msg.messages
  if (!requestId || !Array.isArray(messages) || messages.length === 0) {
    peerManager.sendToPeer(fromPeerId, { type: 'ai-response', requestId, error: 'Invalid request' })
    return
  }
  try {
    const response = await fetch('http://localhost:1234/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5-coder-14b',
        messages,
        temperature: 0.7,
        max_tokens: 2048,
        stream: false,
      }),
    })
    if (!response.ok) {
      const text = await response.text()
      peerManager.sendToPeer(fromPeerId, { type: 'ai-response', requestId, error: `LM Studio error: ${text}` })
      return
    }
    const data = await response.json()
    const content = data.choices?.[0]?.message?.content || ''
    peerManager.sendToPeer(fromPeerId, {
      type: 'ai-response',
      requestId,
      response: content,
      from: peerId,
      fromName: peerName,
    })
  } catch (err) {
    peerManager.sendToPeer(fromPeerId, { type: 'ai-response', requestId, error: `LM Studio unreachable: ${err.message}` })
  }
}

function handleIncomingAuthRequest(fromPeerId, fromName) {
  const failures = pinFailures.get(fromPeerId) || 0
  if (failures >= PIN_MAX_ATTEMPTS) {
    peerManager.disconnectPeer(fromPeerId)
    return
  }

  const pin = generatePIN()
  const peer = peerManager.getPeerInfo(fromPeerId)
  const remotePubKey = peer ? peer.remotePublicKey || '' : ''

  pendingPINAuths.set(fromPeerId, { pin, peerName: fromName, createdAt: Date.now(), remotePublicKey: remotePubKey })

  webUI.broadcastPeerAuthEvent({
    type: 'pin_required',
    peerId: fromPeerId,
    peerName: fromName,
    pin,
  })

  peerManager.sendToPeer(fromPeerId, {
    type: '_auth_challenge',
    payload: { fromName: peerName },
  }, { skipAuth: true })

  setTimeout(() => {
    if (pendingPINAuths.has(fromPeerId)) {
      pendingPINAuths.delete(fromPeerId)
      peerManager.sendToPeer(fromPeerId, { type: '_auth_abort', payload: {} }, { skipAuth: true })
    }
  }, PIN_TIMEOUT).unref()
}

function handleIncomingAuthChallenge(msg, fromPeerId) {
  const peer = peerManager.getPeerInfo(fromPeerId)
  if (!peer) {
    return
  }

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
    }, { skipAuth: true })
    return
  }

  const submittedPIN = msg.payload.pin

  if (submittedPIN === pending.pin) {
    const peer = peerManager.getPeerInfo(fromPeerId)
    if (!peer) {
      return
    }

    pendingPINAuths.delete(fromPeerId)
    pinFailures.delete(fromPeerId)
    db.addTrustedPeer(fromPeerId, pending.peerName, pending.remotePublicKey || '')
    peerManager.markAuthenticated(fromPeerId)

    peerManager.sendToPeer(fromPeerId, {
      type: '_auth_result',
      payload: { success: true, message: 'Authenticated' },
    })

    notifyAuthReady(fromPeerId, pending.peerName)
  } else {
    const failures = (pinFailures.get(fromPeerId) || 0) + 1
    pinFailures.set(fromPeerId, failures)

    if (failures >= PIN_MAX_ATTEMPTS) {
      pendingPINAuths.delete(fromPeerId)
      peerManager.sendToPeer(fromPeerId, {
        type: '_auth_result',
        payload: { success: false, message: 'Too many attempts' },
      }, { skipAuth: true })
      peerManager.disconnectPeer(fromPeerId)
      webUI.broadcastPeerAuthEvent({
        type: 'auth_failed',
        peerId: fromPeerId,
        peerName: pending.peerName,
        message: 'Too many failed attempts',
      })
      return
    }

    peerManager.sendToPeer(fromPeerId, {
      type: '_auth_result',
      payload: { success: false, message: 'Wrong PIN' },
    }, { skipAuth: true })
    webUI.broadcastPeerAuthEvent({
      type: 'auth_failed',
      peerId: fromPeerId,
      peerName: pending.peerName,
    })
  }
}

function handleIncomingAuthResult(msg, fromPeerId, fromName) {
  if (msg.payload.success) {
    peerManager.markAuthenticated(fromPeerId)
    resetBackoff(fromPeerId)
    notifyAuthReady(fromPeerId, fromName)
  } else {
    webUI.broadcastPeerAuthEvent({
      type: 'auth_failed',
      peerId: fromPeerId,
      peerName: fromName,
      message: msg.payload.message,
    })
    if (msg.payload.message === 'Too many attempts') {
      pinFailures.delete(fromPeerId)
    }
  }
}

function notifyAuthReady(peerId, peerName) {
  peerManager.sendToPeer(peerId, { type: '_auth_ready', payload: {} }, { skipAuth: true })
  webUI.broadcastPeers(peerManager.getConnectedPeers())
  webUI.broadcastPeerAuthEvent({
    type: 'authenticated',
    peerId,
    peerName,
  })
}

function resetBackoff(peerId) {
  reconnectBackoff.delete(peerId)
}

function onPINSubmit(data) {
  const peerId = data.peerId
  const pin = data.pin
  const peer = peerManager.getPeerInfo(peerId)
  if (!peer) return

  peerManager.sendToPeer(peerId, {
    type: '_auth_response',
    payload: { pin },
  }, { skipAuth: true })
}

function onPeerDisconnected(peerId) {
  pendingPINAuths.delete(peerId)
  discoveredPeers.delete(peerId)
  webUI.broadcastDiscoveredPeers(Array.from(discoveredPeers.values()))

  const backoff = reconnectBackoff.get(peerId)
  let delay = RECONNECT_BASE_DELAY
  if (backoff) {
    delay = Math.min(backoff.delay * 2, RECONNECT_MAX_DELAY)
  }
  if (reconnectBackoff.size >= MAX_BACKOFF_ENTRIES) {
    const first = reconnectBackoff.keys().next().value
    reconnectBackoff.delete(first)
  }
  reconnectBackoff.set(peerId, { delay, nextAttempt: Date.now() + delay })

  webUI.broadcastPeers(peerManager.getConnectedPeers())
}

function onAppMessage(msg) {
  webUI.broadcastAppMessage(msg)
}

process.on('SIGINT', () => {
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

main().catch(() => {
  process.exit(1)
})
