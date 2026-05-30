const MAX_TTL = 10
const DUPLICATE_CACHE_SIZE = 1000

function createRouter(peerInfo, peerManager) {
  const seenMessages = new Set()
  const seenQueue = []

  function isDuplicate(msgId) {
    return seenMessages.has(msgId)
  }

  function markSeen(msgId) {
    seenMessages.add(msgId)
    seenQueue.push(msgId)
    if (seenQueue.length > DUPLICATE_CACHE_SIZE) {
      const oldest = seenQueue.shift()
      seenMessages.delete(oldest)
    }
  }

  function handleIncomingMessage(msg, fromPeerId) {
    const msgId = msg.id
    if (!msgId || isDuplicate(msgId)) return
    markSeen(msgId)

    const ttl = msg.ttl !== undefined ? msg.ttl : MAX_TTL
    if (ttl <= 0) return

    const isBroadcast = msg.to === '*broadcast*'
    const isForUs = msg.to === peerInfo.id || isBroadcast

    if (isForUs) {
      peerInfo.onAppMessage(msg)
    }

    const newTtl = ttl - 1
    if (newTtl > 0 && (isBroadcast || msg.to !== peerInfo.id)) {
      const forwardMsg = { ...msg, ttl: newTtl }
      peerManager.broadcastToPeers(forwardMsg, fromPeerId)
    }

    if (!isBroadcast && !isForUs && newTtl > 0) {
      const delivered = peerManager.sendToPeer(msg.to, { ...msg, ttl: newTtl })
      if (delivered) return
      peerManager.broadcastToPeers({ ...msg, ttl: newTtl }, fromPeerId)
    }
  }

  function sendMessage(to, payload) {
    const msg = {
      id: generateId(),
      type: payload.type || 'chat',
      from: peerInfo.id,
      fromName: peerInfo.name,
      to,
      payload,
      ttl: MAX_TTL,
      timestamp: new Date().toISOString(),
    }

    if (to === '*broadcast*') {
      peerManager.broadcastToPeers(msg)
    } else {
      const delivered = peerManager.sendToPeer(to, msg)
      if (!delivered) {
        peerManager.broadcastToPeers(msg)
      }
    }

    if (to === peerInfo.id || to === '*broadcast*') {
      peerInfo.onAppMessage(msg)
    }
    return msg
  }

  function generateId() {
    return `${peerInfo.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  return { handleIncomingMessage, sendMessage }
}

module.exports = { createRouter }
