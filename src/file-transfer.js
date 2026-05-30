const EventEmitter = require('events')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const { CHUNK_SIZE, CLEANUP_DELAY, MAX_FILE_NAME_LENGTH, MAX_FILE_SIZE } = require('./config')

const VALID_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const MAX_CONCURRENT_DOWNLOADS = 8

function isValidTransferId(id) {
  return typeof id === 'string' && VALID_ID_RE.test(id)
}

function sanitizeFilename(name) {
  if (typeof name !== 'string') return 'file'
  return name.replace(/[/\\:*?"<>|]/g, '_').slice(0, MAX_FILE_NAME_LENGTH) || 'file'
}

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
    if (!isValidTransferId(transferId)) {
      this.emit('send-status', { transferId, status: 'error', error: 'Invalid transfer ID' })
      return
    }

    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE)

    if (!this.peerManager.isConnected(toPeerId)) {
      this.emit('send-status', {
        transferId, status: 'error',
        error: 'Peer is not directly connected. File transfers require a direct connection.',
      })
      return
    }

    this.sends.set(transferId, {
      transferId, fileName: sanitizeFilename(fileName), fileSize, totalChunks,
      toPeerId, status: 'announcing',
      hash: crypto.createHash('sha256'),
      hashNextIndex: 0,
      hashPending: new Map(),
      sha256: null,
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
    if (!isValidTransferId(transferId)) return false
    const send = this.sends.get(transferId)
    if (!send) return false

    const ok = this.peerManager.sendToPeer(send.toPeerId, {
      type: 'file-transfer',
      payload: { action: 'chunk', transferId, index, data },
    })
    if (!ok) return false

    this._updateSendHash(send, index, data)

    this.emit('send-progress', { transferId, index, total: send.totalChunks })
    return true
  }

  _updateSendHash(send, index, data) {
    if (!send.hash) return
    send.hashPending.set(index, data)
    while (send.hashPending.has(send.hashNextIndex)) {
      const d = send.hashPending.get(send.hashNextIndex)
      send.hashPending.delete(send.hashNextIndex)
      try {
        send.hash.update(Buffer.from(d, 'base64'))
      } catch {
        send.hash = null
        return
      }
      send.hashNextIndex++
    }
  }

  endTransfer(transferId) {
    if (!isValidTransferId(transferId)) return
    const send = this.sends.get(transferId)
    if (!send) return
    send.status = 'complete'

    if (send.hash && send.hashNextIndex === send.totalChunks) {
      send.sha256 = send.hash.digest('hex')
    }

    this.peerManager.sendToPeer(send.toPeerId, {
      type: 'file-transfer',
      payload: { action: 'done', transferId, sha256: send.sha256 },
    })

    this.emit('send-status', { transferId, status: 'complete' })
    setTimeout(() => this.sends.delete(transferId), 60000).unref()
  }

  acceptDownload(transferId) {
    if (!isValidTransferId(transferId)) return
    const dl = this.downloads.get(transferId)
    if (!dl) return
    dl.status = 'downloading'

    this.peerManager.sendToPeer(dl.fromPeerId, {
      type: 'file-transfer',
      payload: { action: 'accept', transferId },
    })
  }

  cancelTransfer(transferId) {
    if (!isValidTransferId(transferId)) return
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
    if (!isValidTransferId(transferId)) return null
    const dl = this.downloads.get(transferId)
    return dl ? dl.tempPath : null
  }

  getDownloadInfo(transferId) {
    if (!isValidTransferId(transferId)) return null
    return this.downloads.get(transferId) || null
  }

  _handleAnnounce(msg, fromPeerId) {
    const { transferId, fileName, fileSize, totalChunks } = msg.payload
    if (!isValidTransferId(transferId)) return
    if (this.downloads.has(transferId)) return
    if (this.downloads.size >= MAX_CONCURRENT_DOWNLOADS) {
      this.emit('download-error', { transferId, error: 'Too many concurrent downloads' })
      return
    }
    if (typeof fileSize !== 'number' || fileSize <= 0 || fileSize > MAX_FILE_SIZE) return

    const safeName = sanitizeFilename(fileName)
    const tempPath = path.join(this.tempDir, transferId)
    const chunkSize = (typeof msg.payload.chunkSize === 'number' && msg.payload.chunkSize > 0)
      ? msg.payload.chunkSize
      : CHUNK_SIZE

    let fd
    try {
      fd = fs.openSync(tempPath, 'w')
    } catch (err) {
      this.emit('download-error', { transferId, error: err.message })
      return
    }

    this.downloads.set(transferId, {
      transferId, fileName: safeName, fileSize, totalChunks, chunkSize,
      fromPeerId, fromName: msg.fromName || 'Unknown',
      tempPath, receivedChunks: 0, receivedBytes: 0, status: 'announced',
      fd, expectedHash: null, verified: false,
    })

    this.emit('download-announce', {
      transferId, from: msg.from, fromName: msg.fromName,
      fileName: safeName, fileSize, totalChunks,
    })
  }

  _handleAccept(msg, fromPeerId) {
    const { transferId } = msg.payload
    if (!isValidTransferId(transferId)) return
    const send = this.sends.get(transferId)
    if (!send) return
    send.status = 'sending'
    this.emit('send-status', { transferId, status: 'sending' })
  }

  _handleChunk(msg, fromPeerId) {
    const { transferId, index, data } = msg.payload
    if (!isValidTransferId(transferId)) return
    const dl = this.downloads.get(transferId)
    if (!dl || dl.fromPeerId !== fromPeerId) return
    if (dl.fd === null || dl.fd === undefined) return
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= dl.totalChunks) return

    try {
      const buf = Buffer.from(data, 'base64')
      const position = index * dl.chunkSize
      if (position + buf.length > dl.fileSize) {
        this.emit('download-error', { transferId, error: 'Chunk exceeds announced file size' })
        this._cleanupDownload(transferId)
        return
      }
      fs.writeSync(dl.fd, buf, 0, buf.length, position)
      dl.receivedChunks++
      dl.receivedBytes += buf.length

      this.emit('download-progress', {
        transferId, received: dl.receivedChunks, total: dl.totalChunks,
      })

      return true
    } catch (err) {
      this.emit('download-error', { transferId, error: err.message })
    }
  }

  _handleDone(msg, fromPeerId) {
    const { transferId, sha256 } = msg.payload
    if (!isValidTransferId(transferId)) return
    const dl = this.downloads.get(transferId)
    if (!dl || dl.fromPeerId !== fromPeerId) return

    dl.expectedHash = typeof sha256 === 'string' && sha256 ? sha256 : null

    if (dl.fd !== null && dl.fd !== undefined) {
      try { fs.closeSync(dl.fd) } catch {}
      dl.fd = null
    }

    if (!dl.expectedHash) {
      this._finishDownload(dl, false)
      return
    }

    dl.status = 'verifying'
    const hash = crypto.createHash('sha256')
    const rs = fs.createReadStream(dl.tempPath)
    rs.on('error', (err) => {
      dl.status = 'error'
      this.emit('download-error', { transferId, error: err.message })
      this._cleanupDownload(transferId)
    })
    rs.on('data', (d) => hash.update(d))
    rs.on('end', () => {
      if (!this.downloads.has(transferId)) return
      const digest = hash.digest('hex')
      if (digest !== dl.expectedHash) {
        dl.status = 'error'
        this._cleanupDownload(transferId)
        this.emit('download-error', {
          transferId, error: 'Integrity check failed: file hash does not match sender',
        })
        return
      }
      this._finishDownload(dl, true)
    })
  }

  _finishDownload(dl, verified) {
    const transferId = dl.transferId
    dl.status = 'complete'
    dl.verified = verified

    this.emit('download-complete', {
      transferId, fileName: dl.fileName, fileSize: dl.fileSize, verified,
    })

    setTimeout(() => this._cleanupDownload(transferId), CLEANUP_DELAY).unref()
  }

  _handleCancel(msg, fromPeerId) {
    const { transferId } = msg.payload
    if (!isValidTransferId(transferId)) return
    this._cleanupDownload(transferId)
    this.sends.delete(transferId)
    this.emit('transfer-cancelled', { transferId })
  }

  _cleanupDownload(transferId) {
    const dl = this.downloads.get(transferId)
    if (!dl) return
    try {
      if (dl.fd !== null && dl.fd !== undefined) {
        try { fs.closeSync(dl.fd) } catch {}
        dl.fd = null
      }
      if (fs.existsSync(dl.tempPath)) fs.unlinkSync(dl.tempPath)
    } catch {}
    this.downloads.delete(transferId)
  }
}

module.exports = { FileTransferManager, CHUNK_SIZE }
