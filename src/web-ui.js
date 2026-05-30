const express = require('express')
const path = require('path')
const http = require('http')
const { Server } = require('socket.io')

function createWebUI(peerInfo) {
  const app = express()
  const server = http.createServer(app)
  const io = new Server(server, {
    maxHttpBufferSize: 10 * 1024 * 1024,
  })
  let port = null

  app.use(express.static(path.join(__dirname, '..', 'public')))

  app.get('/download/:transferId', (req, res) => {
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
    res.download(filePath, dl.fileName)
  })

  io.on('connection', (socket) => {
    socket.emit('self-info', {
      id: peerInfo.id,
      name: peerInfo.name,
    })

    socket.emit('peer-list', peerInfo.getPeers())

    socket.on('send-message', (data) => {
      const target = data.to || '*broadcast*'
      peerInfo.sendMessage(target, {
        type: 'chat',
        text: data.text,
      })
    })

    socket.on('file-transfer-start', (data) => {
      peerInfo.onFileTransferStart(data)
    })

    socket.on('file-chunk-upload', (data) => {
      peerInfo.onFileChunkUpload(data)
    })

    socket.on('file-transfer-end', (data) => {
      peerInfo.onFileTransferEnd(data)
    })

    socket.on('file-transfer-accept', (data) => {
      peerInfo.onFileTransferAccept(data)
    })

    socket.on('file-transfer-cancel', (data) => {
      peerInfo.onFileTransferCancel(data)
    })

    socket.on('pin-submit', (data) => {
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
