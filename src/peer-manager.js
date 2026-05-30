const net = require('net')
const { encrypt, decrypt, deriveSharedSecret } = require('./crypto')
const { KEEPALIVE_INTERVAL } = require('./config')

const MAX_MESSAGE_SIZE = 16 * 1024 * 1024
const MAX_BUFFER_SIZE = MAX_MESSAGE_SIZE + 4

function createPeerManager(peerInfo) {
  const peers = new Map()
  const pendingConnections = new Set()
  let server = null

  function encodeMessage(msg) {
    const data = Buffer.from(JSON.stringify(msg), 'utf-8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(data.length, 0)
    return Buffer.concat([header, data])
  }

  function parseMessage(buffer) {
    try {
      return JSON.parse(buffer.toString('utf-8'))
    } catch {
      return null
    }
  }

  function sendRaw(socket, msg) {
    if (socket && !socket.destroyed) {
      socket.write(encodeMessage(msg))
    }
  }

  function encryptOutgoing(rawMsg, sharedKey) {
    const plaintext = JSON.stringify(rawMsg)
    const encrypted = encrypt(plaintext, sharedKey)
    return {
      type: '_encrypted_',
      iv: encrypted.iv,
      tag: encrypted.tag,
      ciphertext: encrypted.ciphertext,
    }
  }

  function decryptIncoming(wireMsg, sharedKey) {
    if (wireMsg.type !== '_encrypted_') return null
    try {
      const plaintext = decrypt(wireMsg, sharedKey)
      return parseMessage(Buffer.from(plaintext, 'utf-8'))
    } catch {
      return null
    }
  }

  function sendToPeer(peerId, message, opts = {}) {
    const peer = peers.get(peerId)
    if (!peer || !peer.socket || peer.socket.destroyed) return false
    if (!opts.skipAuth && !peer.authenticated) return false

    if (peer.sharedKey && peer.handshakeDone) {
      sendRaw(peer.socket, encryptOutgoing(message, peer.sharedKey))
    } else {
      sendRaw(peer.socket, message)
    }
    return true
  }

  function broadcastToPeers(message, excludeId, opts = {}) {
    for (const [id, peer] of peers) {
      if (id === excludeId) continue
      if (!peer.socket || peer.socket.destroyed) continue
      if (!opts.skipAuth && !peer.authenticated) continue

      if (peer.sharedKey && peer.handshakeDone) {
        sendRaw(peer.socket, encryptOutgoing(message, peer.sharedKey))
      } else {
        sendRaw(peer.socket, message)
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
    let messageLength = null
    let handshakeDone = false
    let remotePeerId = null
    let remoteName = null
    let remotePublicKey = null
    let sharedKey = null

    function processBuffer() {
      while (true) {
        if (messageLength === null) {
          if (buffer.length < 4) break
          const declaredLen = buffer.readUInt32BE(0)
          if (declaredLen > MAX_MESSAGE_SIZE) {
            socket.destroy()
            return
          }
          messageLength = declaredLen
          buffer = buffer.slice(4)
        }
        if (buffer.length < messageLength) break
        const msgData = buffer.slice(0, messageLength)
        buffer = buffer.slice(messageLength)
        messageLength = null

        const wireMsg = parseMessage(msgData)
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
            sendRaw(socket, {
              type: 'handshake',
              from: peerInfo.id,
              fromName: peerInfo.name,
              publicKey: peerInfo.publicKey || '',
            })
          }

          if (sharedKey) {
            peerInfo.onHandshakeComplete(remotePeerId, remoteName, remotePublicKey, sharedKey)
          }
          continue
        }

        if (!handshakeDone) continue

        let finalMsg = wireMsg
        if (sharedKey) {
          const decrypted = decryptIncoming(wireMsg, sharedKey)
          if (!decrypted) continue
          finalMsg = decrypted
        }

        peerInfo.onMessageReceived(finalMsg, remotePeerId)
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
      sendRaw(socket, {
        type: 'handshake',
        from: peerInfo.id,
        fromName: peerInfo.name,
        publicKey: peerInfo.publicKey || '',
      })
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
