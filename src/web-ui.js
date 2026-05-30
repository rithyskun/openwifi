const express = require('express')
const path = require('path')
const http = require('http')
const fs = require('fs')
const { Server } = require('socket.io')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const crypto = require('crypto')
const { MAX_MESSAGE_LENGTH, MAX_FILE_NAME_LENGTH, MAX_FILE_SIZE, AI_URL, AI_MODEL, AI_TEMPERATURE, AI_MAX_TOKENS, AI_TIMEOUT, AI_MAX_MESSAGES, AI_MAX_MESSAGE_LENGTH, LM_STUDIO_ENABLED } = require('./config')

const WS_RATE_LIMIT_WINDOW = 60 * 1000
const WS_RATE_LIMIT_MAX = 60
const wsLimits = new Map()

function checkWsRateLimit(socketId) {
  const now = Date.now()
  let entry = wsLimits.get(socketId)
  if (!entry) {
    entry = { count: 1, resetAt: now + WS_RATE_LIMIT_WINDOW }
    wsLimits.set(socketId, entry)
    return true
  }
  if (now > entry.resetAt) {
    entry.count = 1
    entry.resetAt = now + WS_RATE_LIMIT_WINDOW
    return true
  }
  entry.count++
  return entry.count <= WS_RATE_LIMIT_MAX
}

const CHUNK_RATE_LIMIT_WINDOW = 60 * 1000
const CHUNK_RATE_LIMIT_MAX = 5000
const chunkRateLimits = new Map()

function checkChunkRateLimit(socketId) {
  const now = Date.now()
  let entry = chunkRateLimits.get(socketId)
  if (!entry) {
    entry = { count: 1, resetAt: now + CHUNK_RATE_LIMIT_WINDOW }
    chunkRateLimits.set(socketId, entry)
    return true
  }
  if (now > entry.resetAt) {
    entry.count = 1
    entry.resetAt = now + CHUNK_RATE_LIMIT_WINDOW
    return true
  }
  entry.count++
  return entry.count <= CHUNK_RATE_LIMIT_MAX
}

function isValidBase64(str) {
  if (typeof str !== 'string') return false
  return /^[A-Za-z0-9+/]*={0,2}$/.test(str) && (str.length % 4 === 0)
}

function createWebUI(peerInfo) {
  const app = express()
  const server = http.createServer(app)
  const io = new Server(server, {
    maxHttpBufferSize: MAX_FILE_SIZE + 1024 * 1024,
  })
  let port = null
  const pendingAuthByPeer = new Map()

  app.disable('x-powered-by')

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false,
  }))

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
    res.set('Surrogate-Control', 'no-store')
    next()
  })

  const downloadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  })

  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: false, limit: '1mb' }))

  const htmlPath = path.join(__dirname, '..', 'public', 'index.html')
  app.get('/', (req, res) => {
    let html = fs.readFileSync(htmlPath, 'utf8')
    html = html.replace('</head>', `<script>window.__WS_TOKEN__="${peerInfo.wsToken}"</script></head>`)
    res.type('html').send(html)
  })

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }))

  const AI_RATE_LIMIT_WINDOW = 60 * 1000
  const AI_RATE_LIMIT_MAX = 30
  const aiLimits = new Map()

  function checkAIRateLimit(clientId) {
    const now = Date.now()
    let entry = aiLimits.get(clientId)
    if (!entry) {
      entry = { count: 1, resetAt: now + AI_RATE_LIMIT_WINDOW }
      aiLimits.set(clientId, entry)
      return true
    }
    if (now > entry.resetAt) {
      entry.count = 1
      entry.resetAt = now + AI_RATE_LIMIT_WINDOW
      return true
    }
    entry.count++
    return entry.count <= AI_RATE_LIMIT_MAX
  }

  function validateAIMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > AI_MAX_MESSAGES) return false
    for (const m of messages) {
      if (!m || typeof m.role !== 'string' || typeof m.content !== 'string') return false
      if (!['system', 'user', 'assistant'].includes(m.role)) return false
      if (m.content.length > AI_MAX_MESSAGE_LENGTH) return false
    }
    return true
  }

  app.get('/api/ai/status', (req, res) => {
    res.json({ url: AI_URL, model: AI_MODEL, lmStudio: LM_STUDIO_ENABLED })
  })

  app.get('/api/ai/lmstudio/status', async (req, res) => {
    if (!LM_STUDIO_ENABLED) {
      res.json({ available: false, error: 'LM Studio disabled' })
      return
    }
    if (peerInfo.lmStudio) {
      const status = await peerInfo.lmStudio.checkStatus()
      res.json(status)
    } else {
      res.json({ available: false, error: 'LM Studio not initialized' })
    }
  })

  app.post('/api/ai/chat', express.json({ limit: '256kb' }), async (req, res) => {
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token || token !== peerInfo.wsToken) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    if (!checkAIRateLimit(req.ip || 'unknown')) {
      res.status(429).json({ error: 'Rate limit exceeded' })
      return
    }
    const body = req.body
    if (!body || !validateAIMessages(body.messages)) {
      res.status(400).json({ error: 'Invalid request' })
      return
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), AI_TIMEOUT)
      const response = await fetch(AI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: body.model || AI_MODEL,
          messages: body.messages,
          temperature: typeof body.temperature === 'number' ? body.temperature : AI_TEMPERATURE,
          max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : AI_MAX_TOKENS,
          stream: false,
        }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!response.ok) {
        const text = await response.text()
        res.status(502).json({ error: `AI service error: ${text}` })
        return
      }
      const data = await response.json()
      const content = data.choices?.[0]?.message?.content || ''
      res.json({ response: content })
    } catch (err) {
      if (err.name === 'AbortError') {
        res.status(504).json({ error: 'AI service request timed out' })
      } else {
        res.status(503).json({ error: `AI service unreachable: ${err.message}` })
      }
    }
  })

  app.get('/download/:transferId', downloadLimiter, (req, res) => {
    const dl = peerInfo.getFileDownloadInfo(req.params.transferId)
    if (!dl || dl.status !== 'complete') {
      res.status(404).json({ error: 'Download not found' })
      return
    }
    const filePath = peerInfo.getFileDownloadPath(req.params.transferId)
    if (!filePath) {
      res.status(404).json({ error: 'File not found on disk' })
      return
    }
    const safeName = dl.fileName.replace(/[/\\:*?"<>|]/g, '_').slice(0, 255) || 'download'
    res.download(filePath, safeName)
  })

  io.use((socket, next) => {
    if (socket.handshake.auth && socket.handshake.auth.token === peerInfo.wsToken) {
      next()
    } else {
      next(new Error('Authentication error'))
    }
  })

  io.on('connection', (socket) => {
    socket.emit('self-info', {
      id: peerInfo.id,
      name: peerInfo.name,
    })

    socket.emit('peer-list', peerInfo.getPeers())
    if (peerInfo.getDiscoveredPeers) {
      socket.emit('discovered-peers', peerInfo.getDiscoveredPeers())
    }

    for (const [, event] of pendingAuthByPeer) {
      socket.emit('peer-auth-event', event)
    }

    socket.on('disconnect', () => {
      wsLimits.delete(socket.id)
    })

    socket.on('send-message', (data) => {
      if (!checkWsRateLimit(socket.id)) return
      if (!data || typeof data.text !== 'string' || data.text.length > MAX_MESSAGE_LENGTH) return
      if (typeof data.to !== 'undefined' && typeof data.to !== 'string') return
      const target = data.to || '*broadcast*'
      peerInfo.sendMessage(target, {
        type: 'chat',
        text: data.text,
      })
    })

    socket.on('file-transfer-start', (data) => {
      if (!checkWsRateLimit(socket.id)) return
      if (!data || typeof data.fileName !== 'string' || !data.fileName) return
      if (data.fileName.length > MAX_FILE_NAME_LENGTH) return
      if (typeof data.fileSize !== 'number' || data.fileSize <= 0 || data.fileSize > MAX_FILE_SIZE) return
      if (typeof data.to !== 'string' || !data.to) return
      if (typeof data.transferId !== 'string' || !data.transferId) return
      peerInfo.onFileTransferStart(data)
    })

    socket.on('file-chunk-upload', (data) => {
      if (!checkChunkRateLimit(socket.id)) {
        socket.emit('chunk-error', { transferId: data?.transferId, index: data?.index, error: 'Rate limit exceeded' })
        return
      }
      if (!data || typeof data.transferId !== 'string' || !data.transferId) return
      if (typeof data.index !== 'number' || data.index < 0) return
      if (!data.data) return

      let b64
      if (Buffer.isBuffer(data.data)) {
        b64 = data.data.toString('base64')
      } else if (typeof data.data === 'string') {
        b64 = data.data
      } else if (data.data instanceof Uint8Array) {
        b64 = Buffer.from(data.data).toString('base64')
      } else {
        return
      }

      if (!isValidBase64(b64)) return

      const ok = peerInfo.onFileChunkUpload({
        transferId: data.transferId,
        index: data.index,
        data: b64,
      })

      if (ok) {
        socket.emit('chunk-ack', { transferId: data.transferId, index: data.index })
      } else {
        socket.emit('chunk-error', { transferId: data.transferId, index: data.index, error: 'Peer not connected' })
      }
    })

    socket.on('file-transfer-end', (data) => {
      if (!checkWsRateLimit(socket.id)) return
      if (!data || typeof data.transferId !== 'string' || !data.transferId) return
      peerInfo.onFileTransferEnd(data)
    })

    socket.on('file-transfer-accept', (data) => {
      if (!checkWsRateLimit(socket.id)) return
      if (!data || typeof data.transferId !== 'string' || !data.transferId) return
      peerInfo.onFileTransferAccept(data)
    })

    socket.on('file-transfer-cancel', (data) => {
      if (!checkWsRateLimit(socket.id)) return
      if (!data || typeof data.transferId !== 'string' || !data.transferId) return
      peerInfo.onFileTransferCancel(data)
    })

    socket.on('pin-submit', (data) => {
      if (!checkWsRateLimit(socket.id)) return
      if (!data || typeof data.peerId !== 'string' || typeof data.pin !== 'string') return
      if (peerInfo.onPINSubmit) {
        peerInfo.onPINSubmit(data)
      }
    })

    socket.on('connect-peer', (data) => {
      if (!checkWsRateLimit(socket.id)) return
      if (!data || typeof data.peerId !== 'string' || !data.peerId) return
      if (peerInfo.onConnectPeer) {
        peerInfo.onConnectPeer(data.peerId)
      }
    })

    socket.on('ai-request', (data) => {
      if (!checkWsRateLimit(socket.id)) return
      if (!data || !data.to || typeof data.to !== 'string') return
      if (typeof data.requestId !== 'string' || !data.requestId) return
      if (!validateAIMessages(data.messages)) return
      peerInfo.sendMessage(data.to, {
        type: 'ai-request',
        requestId: data.requestId,
        messages: data.messages,
      })
    })

    socket.on('ai-agent-chat', async (data) => {
      if (!checkWsRateLimit(socket.id)) return
      if (!LM_STUDIO_ENABLED) {
        socket.emit('ai-agent-error', { requestId: data?.requestId, error: 'LM Studio disabled' })
        return
      }
      if (!data || typeof data.requestId !== 'string' || !data.requestId) return
      if (!validateAIMessages(data.messages)) return
      if (!peerInfo.lmStudio) {
        socket.emit('ai-agent-error', { requestId: data.requestId, error: 'LM Studio not initialized' })
        return
      }

      try {
        await peerInfo.lmStudio.chat(data.messages, {
          onStream: (content) => {
            socket.emit('ai-agent-stream', { requestId: data.requestId, content })
          },
          onMessage: (message) => {
            socket.emit('ai-agent-message', { requestId: data.requestId, content: message })
          },
          onToolCall: (name, args) => {
            socket.emit('ai-agent-tool-call', { requestId: data.requestId, tool: name, args })
          },
          onToolResult: (name, result) => {
            socket.emit('ai-agent-tool-result', { requestId: data.requestId, tool: name, result })
          },
        })
        socket.emit('ai-agent-complete', { requestId: data.requestId })
      } catch (err) {
        socket.emit('ai-agent-error', { requestId: data.requestId, error: err.message })
      }
    })
  })

  function start(portToUse) {
    return new Promise((resolve, reject) => {
      server.on('error', reject)
      server.listen(portToUse || 0, '127.0.0.1', () => {
        port = server.address().port
        resolve(port)
      })
    })
  }

  function broadcastAppMessage(msg) {
    io.emit('app-message', msg)
  }

  function broadcastPeers(peers) {
    io.emit('peer-list', peers)
  }

  function broadcastDiscoveredPeers(peers) {
    io.emit('discovered-peers', peers)
  }

  function broadcastPeerAuthEvent(event) {
    if (event.type === 'pin_required' || event.type === 'awaiting_pin') {
      pendingAuthByPeer.set(event.peerId, event)
    } else if (event.type === 'authenticated' || event.type === 'auth_failed' || event.type === 'aborted') {
      pendingAuthByPeer.delete(event.peerId)
    }
    io.emit('peer-auth-event', event)
  }

  function broadcastFileTransferEvent(event) {
    io.emit('file-transfer-event', event)
  }

  function broadcastAIMessage(data) {
    io.emit('ai-message', data)
  }

  function broadcastAIAgentStream(data) {
    io.emit('ai-agent-stream', data)
  }

  function broadcastAIAgentToolCall(data) {
    io.emit('ai-agent-tool-call', data)
  }

  function broadcastAIAgentToolResult(data) {
    io.emit('ai-agent-tool-result', data)
  }

  function stop() {
    io.close()
    server.close()
  }

  return {
    start, stop, getPort: () => port,
    broadcastAppMessage, broadcastPeers, broadcastDiscoveredPeers, broadcastPeerAuthEvent,
    broadcastFileTransferEvent, broadcastAIMessage,
    broadcastAIAgentStream, broadcastAIAgentToolCall, broadcastAIAgentToolResult,
  }
}

module.exports = { createWebUI }
