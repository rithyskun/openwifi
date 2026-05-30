const net = require('net')
const { encryptBuffer, decryptBuffer, deriveSharedSecret } = require('./crypto')
const { KEEPALIVE_INTERVAL } = require('./config')

const MAX_MESSAGE_SIZE = 16 * 1024 * 1024
const MAX_BUFFER_SIZE = MAX_MESSAGE_SIZE + 5

const FRAME_JSON = 0x00
const FRAME_ENCRYPTED = 0x01
const IV_LENGTH = 16
const TAG_LENGTH = 16

function createPeerManager(peerInfo) {
  const peers = new Map()
  const pendingConnections = new Set()
  let server = null

  function parseMessage(buffer) {
    try {
      return JSON.parse(buffer.toString('utf-8'))
    } catch {
      return null
    }
  }

  function sendRaw(socket, buffer) {
    if (socket && !socket.destroyed) {
      socket.write(buffer)
    }
  }

  function encodePlaintext(msg) {
    const data = Buffer.from(JSON.stringify(msg), 'utf-8')
    const header = Buffer.alloc(5)
    header.writeUInt32BE(1 + data.length, 0)
    header[4] = FRAME_JSON
    return Buffer.concat([header, data])
  }

  function buildEncryptedFrame(rawMsg, sharedKey) {
    const plaintext = Buffer.from(JSON.stringify(rawMsg), 'utf-8')
    const encrypted = encryptBuffer(plaintext, sharedKey)
    const payload = Buffer.concat([encrypted.iv, encrypted.tag, encrypted.ciphertext])
    const header = Buffer.alloc(5)
    header.writeUInt32BE(1 + payload.length, 0)
    header[4] = FRAME_ENCRYPTED
    return Buffer.concat([header, payload])
  }

  function decryptIncoming(framePayload, sharedKey) {
    if (framePayload.length < IV_LENGTH + TAG_LENGTH) return null
    try {
      const iv = framePayload.slice(0, IV_LENGTH)
      const tag = framePayload.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
      const ciphertext = framePayload.slice(IV_LENGTH + TAG_LENGTH)
      const plaintext = decryptBuffer(iv, tag, ciphertext, sharedKey)
      return parseMessage(plaintext)
    } catch {
      return null
    }
  }

  function sendToPeer(peerId, message, opts = {}) {
    const peer = peers.get(peerId)
    if (!peer || !peer.socket || peer.socket.destroyed) return false
    if (!opts.skipAuth && !peer.authenticated) return false

    if (peer.sharedKey && peer.handshakeDone) {
      sendRaw(peer.socket, buildEncryptedFrame(message, peer.sharedKey))
    } else {
      sendRaw(peer.socket, encodePlaintext(message))
    }
    return true
  }

  function broadcastToPeers(message, excludeId, opts = {}) {
    for (const [id, peer] of peers) {
      if (id === excludeId) continue
      if (!peer.socket || peer.socket.destroyed) continue
      if (!opts.skipAuth && !peer.authenticated) continue

      if (peer.sharedKey && peer.handshakeDone) {
        sendRaw(peer.socket, buildEncryptedFrame(message, peer.sharedKey))
      } else {
        sendRaw(peer.socket, encodePlaintext(message))
      }
    }
  }

  function markAuthenticated(peerId) {
    const peer = peers.get(peerId)
    if (peer) peer.authenticated = true
  }

  function isAuthenticated(peerId) {
    const peer = peers.get(peerId)
    return peer ? peer.authenticated : false
  }

  function attachSocketHandlers(socket, isOutgoing) {
    socket.setKeepAlive(true, KEEPALIVE_INTERVAL)
    let buffer = Buffer.alloc(0)
    let handshakeDone = false
    let remotePeerId = null
    let remoteName = null
    let remotePublicKey = null
    let sharedKey = null

    function processBuffer() {
      while (true) {
        if (buffer.length < 4) break
        const declaredLen = buffer.readUInt32BE(0)
        if (declaredLen > MAX_MESSAGE_SIZE) {
          socket.destroy()
          return
        }
        if (buffer.length < 4 + declaredLen) break
        const frameData = buffer.slice(4, 4 + declaredLen)
        buffer = buffer.slice(4 + declaredLen)

        if (frameData.length < 1) continue
        const frameType = frameData[0]
        const payload = frameData.slice(1)

        if (frameType === FRAME_JSON) {
          const wireMsg = parseMessage(payload)
          if (!wireMsg) continue

          if (wireMsg.type === 'handshake') {
            if (!wireMsg.from || !/^[a-f0-9]{8}$/i.test(wireMsg.from)) {
              socket.destroy()
              return
            }
            remotePeerId = wireMsg.from
            remoteName = wireMsg.fromName || remotePeerId
            remotePublicKey = wireMsg.publicKey || null

            if (peerInfo.privateKey && remotePublicKey) {
              sharedKey = deriveSharedSecret(peerInfo.privateKey, remotePublicKey)
            }

            const existing = peers.get(remotePeerId)
            if (existing) {
              socket.destroy()
              return
            }

            peers.set(remotePeerId, {
              id: remotePeerId,
              name: remoteName,
              socket,
              sharedKey,
              remotePublicKey,
              handshakeDone: true,
              authenticated: false,
            })

            handshakeDone = true

            if (!isOutgoing) {
              sendRaw(socket, encodePlaintext({
                type: 'handshake',
                from: peerInfo.id,
                fromName: peerInfo.name,
                publicKey: peerInfo.publicKey || '',
              }))
            }

            if (sharedKey) {
              peerInfo.onHandshakeComplete(remotePeerId, remoteName, remotePublicKey, sharedKey)
            }
            continue
          }

          if (!handshakeDone) continue
          peerInfo.onMessageReceived(wireMsg, remotePeerId)
        } else if (frameType === FRAME_ENCRYPTED) {
          if (!handshakeDone || !sharedKey) continue
          const decrypted = decryptIncoming(payload, sharedKey)
          if (!decrypted) continue
          peerInfo.onMessageReceived(decrypted, remotePeerId)
        }
      }
    }

    socket.on('data', (chunk) => {
      if (buffer.length + chunk.length > MAX_BUFFER_SIZE) {
        socket.destroy()
        return
      }
      buffer = Buffer.concat([buffer, chunk])
      processBuffer()
    })

    socket.on('close', () => {
      if (remotePeerId) {
        peers.delete(remotePeerId)
        peerInfo.onPeerDisconnected(remotePeerId)
      }
    })

    socket.on('error', () => {})

    if (isOutgoing) {
      sendRaw(socket, encodePlaintext({
        type: 'handshake',
        from: peerInfo.id,
        fromName: peerInfo.name,
        publicKey: peerInfo.publicKey || '',
      }))
    }

    return socket
  }

  function startServer(port) {
    return new Promise((resolve, reject) => {
      server = net.createServer((socket) => {
        attachSocketHandlers(socket, false)
      })
      server.on('error', reject)
      server.listen(port, () => {
        resolve(server.address().port)
      })
    })
  }

  function connectToPeer(host, tcpPort) {
    const key = `${host}:${tcpPort}`
    if (pendingConnections.has(key)) return Promise.resolve()
    pendingConnections.add(key)

    return new Promise((resolve) => {
      const socket = new net.Socket()
      socket.on('error', () => {
        pendingConnections.delete(key)
        resolve()
      })
      socket.connect(tcpPort, host, () => {
        pendingConnections.delete(key)
        attachSocketHandlers(socket, true)
        resolve()
      })
    })
  }

  function getConnectedPeers() {
    const result = []
    for (const [, peer] of peers) {
      result.push({
        id: peer.id,
        name: peer.name,
        sharedKey: !!peer.sharedKey,
        handshakeDone: !!peer.handshakeDone,
        authenticated: !!peer.authenticated,
      })
    }
    return result
  }

  function isConnected(peerId) {
    return peers.has(peerId)
  }

  function getPeerInfo(peerId) {
    return peers.get(peerId) || null
  }

  function disconnectPeer(peerId) {
    const peer = peers.get(peerId)
    if (peer && peer.socket && !peer.socket.destroyed) {
      peer.socket.destroy()
    }
    peers.delete(peerId)
  }

  function stop() {
    pendingConnections.clear()
    for (const [, peer] of peers) {
      if (peer.socket && !peer.socket.destroyed) {
        peer.socket.destroy()
      }
    }
    peers.clear()
    if (server) {
      server.close()
      server = null
    }
  }

  return {
    startServer,
    connectToPeer,
    sendToPeer,
    broadcastToPeers,
    getConnectedPeers,
    getPeerInfo,
    isConnected,
    disconnectPeer,
    markAuthenticated,
    isAuthenticated,
    stop,
  }
}

module.exports = { createPeerManager }
