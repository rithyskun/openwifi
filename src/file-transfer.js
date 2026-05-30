const EventEmitter = require('events')
const fs = require('fs')
const path = require('path')
const os = require('os')

const CHUNK_SIZE = 65536

class FileTransferManager extends EventEmitter {
  constructor(peerManager) {
    super()
    this.peerManager = peerManager
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwifi-'))
    this.sends = new Map()
    this.downloads = new Map()
  }

  handleP2PMessage(msg, fromPeerId) {
    const { action } = msg.payload
    if (action === 'announce') return this._handleAnnounce(msg, fromPeerId)
    if (action === 'accept') return this._handleAccept(msg, fromPeerId)
    if (action === 'chunk') return this._handleChunk(msg, fromPeerId)
    if (action === 'done') return this._handleDone(msg, fromPeerId)
    if (action === 'cancel') return this._handleCancel(msg, fromPeerId)
  }

  startTransfer(transferId, fileName, fileSize, toPeerId) {
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE)

    if (!this.peerManager.isConnected(toPeerId)) {
      this.emit('send-status', {
        transferId, status: 'error',
        error: 'Peer is not directly connected. File transfers require a direct connection.',
      })
      return
    }

    this.sends.set(transferId, {
      transferId, fileName, fileSize, totalChunks,
      toPeerId, status: 'announcing',
    })

    this.peerManager.sendToPeer(toPeerId, {
      type: 'file-transfer',
      payload: {
        action: 'announce',
        transferId, fileName, fileSize, totalChunks,
        chunkSize: CHUNK_SIZE,
        fromName: this.peerManager.getPeerInfo(toPeerId)?.name || '',
      },
    })

    this.emit('send-status', { transferId, status: 'waiting', fileName, fileSize, totalChunks })
  }

  sendChunk(transferId, index, data) {
    const send = this.sends.get(transferId)
    if (!send) return

    this.peerManager.sendToPeer(send.toPeerId, {
      type: 'file-transfer',
      payload: { action: 'chunk', transferId, index, data },
    })

    this.emit('send-progress', { transferId, index, total: send.totalChunks })
  }

  endTransfer(transferId) {
    const send = this.sends.get(transferId)
    if (!send) return
    send.status = 'complete'

    this.peerManager.sendToPeer(send.toPeerId, {
      type: 'file-transfer',
      payload: { action: 'done', transferId },
    })

    this.emit('send-status', { transferId, status: 'complete' })
    setTimeout(() => this.sends.delete(transferId), 60000).unref()
  }

  acceptDownload(transferId) {
    const dl = this.downloads.get(transferId)
    if (!dl) return
    dl.status = 'downloading'

    this.peerManager.sendToPeer(dl.fromPeerId, {
      type: 'file-transfer',
      payload: { action: 'accept', transferId },
    })
  }

  cancelTransfer(transferId) {
    const send = this.sends.get(transferId)
    if (send) {
      this.peerManager.sendToPeer(send.toPeerId, {
        type: 'file-transfer', payload: { action: 'cancel', transferId },
      })
      this.sends.delete(transferId)
      this.emit('send-status', { transferId, status: 'cancelled' })
    }

    const dl = this.downloads.get(transferId)
    if (dl) {
      this.peerManager.sendToPeer(dl.fromPeerId, {
        type: 'file-transfer', payload: { action: 'cancel', transferId },
      })
      this._cleanupDownload(transferId)
      this.emit('download-status', { transferId, status: 'cancelled' })
    }
  }

  getDownloadPath(transferId) {
    const dl = this.downloads.get(transferId)
    return dl ? dl.tempPath : null
  }

  getDownloadInfo(transferId) {
    return this.downloads.get(transferId) || null
  }

  _handleAnnounce(msg, fromPeerId) {
    const { transferId, fileName, fileSize, totalChunks } = msg.payload
    if (this.downloads.has(transferId)) return

    const tempPath = path.join(this.tempDir, transferId)
    this.downloads.set(transferId, {
      transferId, fileName, fileSize, totalChunks,
      fromPeerId, fromName: msg.fromName,
      tempPath, receivedChunks: 0, status: 'announced',
    })

    this.emit('download-announce', {
      transferId, from: msg.from, fromName: msg.fromName,
      fileName, fileSize, totalChunks,
    })
  }

  _handleAccept(msg, fromPeerId) {
    const { transferId } = msg.payload
    const send = this.sends.get(transferId)
    if (!send) return
    send.status = 'sending'
    this.emit('send-status', { transferId, status: 'sending' })
  }

  _handleChunk(msg, fromPeerId) {
    const { transferId, index, data } = msg.payload
    const dl = this.downloads.get(transferId)
    if (!dl || dl.fromPeerId !== fromPeerId) return

    try {
      fs.appendFileSync(dl.tempPath, Buffer.from(data, 'base64'))
      dl.receivedChunks++
      this.emit('download-progress', {
        transferId, received: dl.receivedChunks, total: dl.totalChunks,
      })
    } catch (err) {
      this.emit('download-error', { transferId, error: err.message })
    }
  }

  _handleDone(msg, fromPeerId) {
    const { transferId } = msg.payload
    const dl = this.downloads.get(transferId)
    if (!dl || dl.fromPeerId !== fromPeerId) return

    dl.status = 'complete'
    this.emit('download-complete', {
      transferId, fileName: dl.fileName, fileSize: dl.fileSize,
    })

    setTimeout(() => this._cleanupDownload(transferId), 300000).unref()
  }

  _handleCancel(msg, fromPeerId) {
    const { transferId } = msg.payload
    this._cleanupDownload(transferId)
    this.sends.delete(transferId)
    this.emit('transfer-cancelled', { transferId })
  }

  _cleanupDownload(transferId) {
    const dl = this.downloads.get(transferId)
    if (!dl) return
    try { if (fs.existsSync(dl.tempPath)) fs.unlinkSync(dl.tempPath) } catch {}
    this.downloads.delete(transferId)
  }
}

module.exports = { FileTransferManager, CHUNK_SIZE }
