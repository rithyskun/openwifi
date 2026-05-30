const express = require('express')
const path = require('path')
const http = require('http')
const { Server } = require('socket.io')

function createWebUI(peerInfo) {
  const app = express()
  const server = http.createServer(app)
  const io = new Server(server)
  let port = null

  app.use(express.static(path.join(__dirname, '..', 'public')))

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

    socket.on('send-file', (data) => {
      const target = data.to || '*broadcast*'
      peerInfo.sendMessage(target, {
        type: 'file-announce',
        fileName: data.fileName,
        fileSize: data.fileSize,
        fileData: data.fileData,
      })
    })

    socket.on('request-file', (data) => {
      peerInfo.sendMessage(data.from, {
        type: 'file-request',
        fileName: data.fileName,
        messageId: data.messageId,
      })
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

  function stop() {
    io.close()
    server.close()
  }

  return { start, stop, broadcastAppMessage, broadcastPeers, broadcastPeerAuthEvent, getPort: () => port }
}

module.exports = { createWebUI }
