const express = require('express')
const path = require('path')
const http = require('http')
const fs = require('fs')
const { Server } = require('socket.io')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const { MAX_MESSAGE_LENGTH, MAX_FILE_NAME_LENGTH, MAX_FILE_SIZE } = require('./config')

function createWebUI(peerInfo) {
  const app = express()
  const server = http.createServer(app)
  const io = new Server(server, {
    maxHttpBufferSize: MAX_FILE_SIZE + 1024 * 1024,
  })
  let port = null

  app.disable('x-powered-by')

  app.use(helmet({
    contentSecurityPolicy: false,
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

    socket.on('send-message', (data) => {
      if (!data || typeof data.text !== 'string' || data.text.length > MAX_MESSAGE_LENGTH) return
      if (typeof data.to !== 'undefined' && typeof data.to !== 'string') return
      const target = data.to || '*broadcast*'
      peerInfo.sendMessage(target, {
        type: 'chat',
        text: data.text,
      })
    })

    socket.on('file-transfer-start', (data) => {
      if (!data || typeof data.fileName !== 'string' || !data.fileName) return
      if (data.fileName.length > MAX_FILE_NAME_LENGTH) return
      if (typeof data.fileSize !== 'number' || data.fileSize <= 0 || data.fileSize > MAX_FILE_SIZE) return
      if (typeof data.to !== 'string' || !data.to) return
      if (typeof data.transferId !== 'string' || !data.transferId) return
      peerInfo.onFileTransferStart(data)
    })

    socket.on('file-chunk-upload', (data) => {
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

      peerInfo.onFileChunkUpload({
        transferId: data.transferId,
        index: data.index,
        data: b64,
      })

      socket.emit('chunk-ack', { transferId: data.transferId })
    })

    socket.on('file-transfer-end', (data) => {
      if (!data || typeof data.transferId !== 'string' || !data.transferId) return
      peerInfo.onFileTransferEnd(data)
    })

    socket.on('file-transfer-accept', (data) => {
      if (!data || typeof data.transferId !== 'string' || !data.transferId) return
      peerInfo.onFileTransferAccept(data)
    })

    socket.on('file-transfer-cancel', (data) => {
      if (!data || typeof data.transferId !== 'string' || !data.transferId) return
      peerInfo.onFileTransferCancel(data)
    })

    socket.on('pin-submit', (data) => {
      if (!data || typeof data.peerId !== 'string' || typeof data.pin !== 'string') return
      if (peerInfo.onPINSubmit) {
        peerInfo.onPINSubmit(data)
      }
    })
  })

  function start(portToUse) {
    return new Promise((resolve, reject) => {
      server.on('error', reject)
      server.listen(portToUse || 0, () => {
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

  function broadcastPeerAuthEvent(event) {
    io.emit('peer-auth-event', event)
  }

  function broadcastFileTransferEvent(event) {
    io.emit('file-transfer-event', event)
  }

  function stop() {
    io.close()
    server.close()
  }

  return {
    start, stop, getPort: () => port,
    broadcastAppMessage, broadcastPeers, broadcastPeerAuthEvent,
    broadcastFileTransferEvent,
  }
}

module.exports = { createWebUI }
