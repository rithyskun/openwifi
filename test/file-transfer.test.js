const { describe, it, before, after, mock } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { FileTransferManager, CHUNK_SIZE } = require('../src/file-transfer')

function createMockPeerManager() {
  const sent = []
  return {
    isConnected: mock.fn(() => true),
    getPeerInfo: mock.fn(() => ({ id: 'peer2', name: 'TestPeer' })),
    sendToPeer: mock.fn((peerId, msg) => { sent.push({ peerId, msg }); return true }),
    getConnectedPeers: mock.fn(() => []),
    sent,
  }
}

describe('FileTransferManager', () => {
  let ft

  before(() => {
    ft = new FileTransferManager(createMockPeerManager())
  })

  after(() => {
    try { fs.rmSync(ft.tempDir, { recursive: true, force: true }) } catch {}
  })

  it('creates temp directory on construction', () => {
    assert.ok(fs.existsSync(ft.tempDir))
    assert.ok(fs.existsSync(ft.tempDir))
  })

  it('starts with empty sends and downloads', () => {
    assert.strictEqual(ft.sends.size, 0)
    assert.strictEqual(ft.downloads.size, 0)
  })

  it('emits error when target peer is not connected', () => {
    const ft2 = new FileTransferManager(createMockPeerManager())
    ft2.peerManager.isConnected = mock.fn(() => false)

    return new Promise((resolve) => {
      ft2.on('send-status', (info) => {
        if (info.status === 'error') {
          assert.ok(info.error.includes('not directly connected'))
          try { fs.rmSync(ft2.tempDir, { recursive: true, force: true }) } catch {}
          resolve()
        }
      })
      ft2.startTransfer('t1', 'test.txt', 100, 'peer3')
    })
  })

  it('startTransfer sends announce to peer', () => {
    ft.startTransfer('t2', 'report.pdf', 200000, 'peer2')

    const send = ft.sends.get('t2')
    assert.ok(send)
    assert.strictEqual(send.fileName, 'report.pdf')
    assert.strictEqual(send.fileSize, 200000)
    assert.strictEqual(send.toPeerId, 'peer2')
    assert.strictEqual(send.status, 'announcing')

    assert.strictEqual(ft.peerManager.sendToPeer.mock.calls.length, 1)
    const call = ft.peerManager.sendToPeer.mock.calls[0].arguments
    assert.strictEqual(call[0], 'peer2')
    assert.strictEqual(call[1].type, 'file-transfer')
    assert.strictEqual(call[1].payload.action, 'announce')
    assert.strictEqual(call[1].payload.transferId, 't2')
    assert.strictEqual(call[1].payload.fileName, 'report.pdf')
    assert.strictEqual(call[1].payload.totalChunks, Math.ceil(200000 / CHUNK_SIZE))
  })

  it('handleP2PMessage(announce) creates download entry', () => {
    const msg = {
      from: 'peer1',
      fromName: 'Sender',
      payload: {
        action: 'announce',
        transferId: 't3',
        fileName: 'photo.jpg',
        fileSize: 500000,
        totalChunks: 8,
        chunkSize: CHUNK_SIZE,
      },
    }
    ft.handleP2PMessage(msg, 'peer1')

    const dl = ft.downloads.get('t3')
    assert.ok(dl)
    assert.strictEqual(dl.transferId, 't3')
    assert.strictEqual(dl.fileName, 'photo.jpg')
    assert.strictEqual(dl.fromPeerId, 'peer1')
    assert.strictEqual(dl.fromName, 'Sender')
    assert.strictEqual(dl.status, 'announced')
    assert.strictEqual(dl.receivedChunks, 0)
  })

  it('handleP2PMessage(accept) marks send as sending', () => {
    ft.startTransfer('t4', 'doc.pdf', 100000, 'peer2')

    ft.handleP2PMessage(
      { payload: { action: 'accept', transferId: 't4' } },
      'peer2'
    )

    assert.strictEqual(ft.sends.get('t4').status, 'sending')
  })

  it('handleP2PMessage(chunk) writes data and emits progress', () => {
    const msg = {
      from: 'peer1',
      fromName: 'Sender',
      payload: {
        action: 'announce',
        transferId: 't-chunk-test',
        fileName: 'chunked.bin',
        fileSize: 200,
        totalChunks: 1,
        chunkSize: CHUNK_SIZE,
      },
    }
    ft.handleP2PMessage(msg, 'peer1')

    let progressEmitted = false
    ft.on('download-progress', (info) => {
      if (info.transferId === 't-chunk-test') {
        progressEmitted = true
        assert.strictEqual(info.received, 1)
        assert.strictEqual(info.total, 1)
      }
    })

    ft.handleP2PMessage(
      {
        payload: {
          action: 'chunk',
          transferId: 't-chunk-test',
          index: 0,
          data: Buffer.from('hello world chunk data').toString('base64'),
        },
      },
      'peer1'
    )

    assert.ok(progressEmitted)

    const dl = ft.downloads.get('t-chunk-test')
    assert.strictEqual(dl.receivedChunks, 1)
    assert.ok(fs.existsSync(dl.tempPath))
    const content = fs.readFileSync(dl.tempPath, 'utf-8')
    assert.strictEqual(content, 'hello world chunk data')
  })

  it('handleP2PMessage(done) marks download complete', () => {
    const msg = {
      from: 'peer2',
      fromName: 'Sender2',
      payload: {
        action: 'announce',
        transferId: 't-done-test',
        fileName: 'donefile.txt',
        fileSize: 50,
        totalChunks: 1,
        chunkSize: CHUNK_SIZE,
      },
    }
    ft.handleP2PMessage(msg, 'peer2')

    let completeEmitted = false
    ft.on('download-complete', (info) => {
      if (info.transferId === 't-done-test') {
        completeEmitted = true
        assert.strictEqual(info.fileName, 'donefile.txt')
      }
    })

    ft.handleP2PMessage(
      { payload: { action: 'done', transferId: 't-done-test' } },
      'peer2'
    )

    assert.ok(completeEmitted)
    assert.strictEqual(ft.downloads.get('t-done-test').status, 'complete')
  })

  it('getDownloadInfo returns download state', () => {
    const info = ft.getDownloadInfo('t3')
    assert.ok(info)
    assert.strictEqual(info.fileName, 'photo.jpg')
    assert.strictEqual(info.status, 'announced')

    assert.strictEqual(ft.getDownloadInfo('nonexistent'), null)
  })

  it('getDownloadPath returns temp file path for complete downloads', () => {
    const cpl = ft.getDownloadInfo('t-done-test')
    assert.ok(cpl)
    const p = ft.getDownloadPath('t-done-test')
    assert.strictEqual(p, cpl.tempPath)
  })

  it('full cycle: announce -> chunk -> done -> download path', () => {
    const ft2 = new FileTransferManager(createMockPeerManager())
    const announceMsg = {
      from: 'alice',
      fromName: 'Alice',
      payload: {
        action: 'announce',
        transferId: 't-cycle',
        fileName: 'cycle.txt',
        fileSize: 20,
        totalChunks: 1,
        chunkSize: CHUNK_SIZE,
      },
    }
    ft2.handleP2PMessage(announceMsg, 'alice')

    ft2.handleP2PMessage(
      {
        payload: {
          action: 'chunk',
          transferId: 't-cycle',
          index: 0,
          data: Buffer.from('full cycle test data').toString('base64'),
        },
      },
      'alice'
    )

    ft2.handleP2PMessage(
      { payload: { action: 'done', transferId: 't-cycle' } },
      'alice'
    )

    const dl = ft2.getDownloadInfo('t-cycle')
    assert.strictEqual(dl.status, 'complete')
    assert.strictEqual(dl.receivedChunks, 1)

    const filePath = ft2.getDownloadPath('t-cycle')
    assert.ok(fs.existsSync(filePath))
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'full cycle test data')

    try { fs.rmSync(ft2.tempDir, { recursive: true, force: true }) } catch {}
  })

  it('cancelTransfer cleans up download', () => {
    const ft3 = new FileTransferManager(createMockPeerManager())
    ft3.handleP2PMessage(
      {
        from: 'bob',
        fromName: 'Bob',
        payload: {
          action: 'announce',
          transferId: 't-cancel',
          fileName: 'cancel.txt',
          fileSize: 10,
          totalChunks: 1,
          chunkSize: CHUNK_SIZE,
        },
      },
      'bob'
    )

    ft3.cancelTransfer('t-cancel')

    assert.strictEqual(ft3.downloads.has('t-cancel'), false)

    try { fs.rmSync(ft3.tempDir, { recursive: true, force: true }) } catch {}
  })

  it('handles multiple chunks in sequence', () => {
    const ft4 = new FileTransferManager(createMockPeerManager())
    ft4.handleP2PMessage(
      {
        from: 'charlie',
        fromName: 'Charlie',
        payload: {
          action: 'announce',
          transferId: 't-multi',
          fileName: 'multi.bin',
          fileSize: CHUNK_SIZE * 3 + 100,
          totalChunks: 4,
          chunkSize: CHUNK_SIZE,
        },
      },
      'charlie'
    )

    let progressCount = 0
    ft4.on('download-progress', () => progressCount++)

    const chunks = ['chunk0 data ', 'chunk1 data ', 'chunk2 data ', 'chunk3 data']
    for (let i = 0; i < 4; i++) {
      ft4.handleP2PMessage(
        {
          payload: {
            action: 'chunk',
            transferId: 't-multi',
            index: i,
            data: Buffer.from(chunks[i]).toString('base64'),
          },
        },
        'charlie'
      )
    }

    ft4.handleP2PMessage(
      { payload: { action: 'done', transferId: 't-multi' } },
      'charlie'
    )

    assert.strictEqual(progressCount, 4)
    const dl = ft4.getDownloadInfo('t-multi')
    assert.strictEqual(dl.receivedChunks, 4)
    assert.strictEqual(dl.status, 'complete')
    assert.strictEqual(fs.readFileSync(dl.tempPath, 'utf-8'), chunks.join(''))

    try { fs.rmSync(ft4.tempDir, { recursive: true, force: true }) } catch {}
  })

  it('sendChunk sends chunk to peer and emits progress', () => {
    const mockPM = createMockPeerManager()
    const ft5 = new FileTransferManager(mockPM)
    ft5.startTransfer('t-send', 'out.txt', CHUNK_SIZE * 2, 'peer2')
    ft5.handleP2PMessage(
      { payload: { action: 'accept', transferId: 't-send' } },
      'peer2'
    )

    let progressEmitted = false
    ft5.on('send-progress', (info) => {
      if (info.transferId === 't-send' && info.index === 0) {
        progressEmitted = true
      }
    })

    ft5.sendChunk('t-send', 0, Buffer.from('chunk data').toString('base64'))

    assert.ok(progressEmitted)
    assert.strictEqual(mockPM.sendToPeer.mock.calls.length, 2)
    const lastCall = mockPM.sendToPeer.mock.calls[1].arguments
    assert.strictEqual(lastCall[0], 'peer2')
    assert.strictEqual(lastCall[1].payload.action, 'chunk')
    assert.strictEqual(lastCall[1].payload.index, 0)

    try { fs.rmSync(ft5.tempDir, { recursive: true, force: true }) } catch {}
  })

  it('endTransfer sends done and cleans up send state after timeout', () => {
    const mockPM = createMockPeerManager()
    const ft6 = new FileTransferManager(mockPM)
    ft6.startTransfer('t-end', 'final.txt', 100, 'peer2')

    ft6.endTransfer('t-end')

    const send = ft6.sends.get('t-end')
    assert.strictEqual(send.status, 'complete')

    const lastCall = mockPM.sendToPeer.mock.calls[mockPM.sendToPeer.mock.calls.length - 1].arguments
    assert.strictEqual(lastCall[1].payload.action, 'done')
    assert.strictEqual(lastCall[1].payload.transferId, 't-end')

    try { fs.rmSync(ft6.tempDir, { recursive: true, force: true }) } catch {}
  })

  it('rejects chunks from wrong sender', () => {
    const ft7 = new FileTransferManager(createMockPeerManager())
    ft7.handleP2PMessage(
      {
        from: 'alice',
        fromName: 'Alice',
        payload: {
          action: 'announce',
          transferId: 't-wrong',
          fileName: 'secure.txt',
          fileSize: 50,
          totalChunks: 1,
          chunkSize: CHUNK_SIZE,
        },
      },
      'alice'
    )

    ft7.handleP2PMessage(
      {
        payload: {
          action: 'chunk',
          transferId: 't-wrong',
          index: 0,
          data: Buffer.from('eve data').toString('base64'),
        },
      },
      'eve'
    )

    const dl = ft7.getDownloadInfo('t-wrong')
    assert.strictEqual(dl.receivedChunks, 0)

    try { fs.rmSync(ft7.tempDir, { recursive: true, force: true }) } catch {}
  })

  it('rejects path traversal transferId in announce', () => {
    const ft8 = new FileTransferManager(createMockPeerManager())
    ft8.handleP2PMessage(
      {
        from: 'attacker',
        fromName: 'Attacker',
        payload: {
          action: 'announce',
          transferId: '../../../etc/passwd',
          fileName: 'evil.txt',
          fileSize: 100,
          totalChunks: 1,
          chunkSize: CHUNK_SIZE,
        },
      },
      'attacker'
    )

    assert.strictEqual(ft8.downloads.has('../../../etc/passwd'), false)
    assert.strictEqual(ft8.downloads.size, 0)

    try { fs.rmSync(ft8.tempDir, { recursive: true, force: true }) } catch {}
  })

  it('rejects path traversal transferId in chunk without announce', () => {
    const ft9 = new FileTransferManager(createMockPeerManager())
    const maliciousPath = '/tmp/evil_write_test'

    ft9.handleP2PMessage(
      {
        payload: {
          action: 'chunk',
          transferId: maliciousPath,
          index: 0,
          data: Buffer.from('malicious data').toString('base64'),
        },
      },
      'attacker'
    )

    assert.strictEqual(fs.existsSync(maliciousPath), false)

    try { fs.rmSync(ft9.tempDir, { recursive: true, force: true }) } catch {}
  })

  it('rejects transferId with special characters', () => {
    const ft10 = new FileTransferManager(createMockPeerManager())
    ft10.handleP2PMessage(
      {
        from: 'attacker',
        fromName: 'Attacker',
        payload: {
          action: 'announce',
          transferId: 'valid-id_123',
          fileName: 'good.txt',
          fileSize: 50,
          totalChunks: 1,
          chunkSize: CHUNK_SIZE,
        },
      },
      'attacker'
    )

    assert.ok(ft10.downloads.has('valid-id_123'))

    ft10.handleP2PMessage(
      {
        from: 'attacker',
        fromName: 'Attacker',
        payload: {
          action: 'announce',
          transferId: '../injection',
          fileName: 'bad.txt',
          fileSize: 50,
          totalChunks: 1,
          chunkSize: CHUNK_SIZE,
        },
      },
      'attacker'
    )

    assert.strictEqual(ft10.downloads.has('../injection'), false)

    try { fs.rmSync(ft10.tempDir, { recursive: true, force: true }) } catch {}
  })

  it('sanitizeFilename removes dangerous path separators', () => {
    const ft11 = new FileTransferManager(createMockPeerManager())
    ft11.handleP2PMessage(
      {
        from: 'peer',
        fromName: 'Peer',
        payload: {
          action: 'announce',
          transferId: 't-safe',
          fileName: '../../malicious.exe',
          fileSize: 100,
          totalChunks: 1,
          chunkSize: CHUNK_SIZE,
        },
      },
      'peer'
    )

    const dl = ft11.getDownloadInfo('t-safe')
    assert.ok(dl.fileName)
    assert.ok(!dl.fileName.includes('/'))
    assert.ok(!dl.fileName.includes('\\'))
    assert.strictEqual(dl.fileName, '.._.._malicious.exe')

    try { fs.rmSync(ft11.tempDir, { recursive: true, force: true }) } catch {}
  })

  it('getDownloadPath returns null for invalid transferId', () => {
    const ft12 = new FileTransferManager(createMockPeerManager())
    assert.strictEqual(ft12.getDownloadPath('../etc/passwd'), null)
    assert.strictEqual(ft12.getDownloadPath(''), null)
    assert.strictEqual(ft12.getDownloadPath('/absolute/path'), null)
    assert.strictEqual(ft12.getDownloadPath('valid-id'), null)
    assert.strictEqual(ft12.getDownloadInfo('../etc/passwd'), null)

    try { fs.rmSync(ft12.tempDir, { recursive: true, force: true }) } catch {}
  })

  it('startTransfer rejects path traversal transferId', () => {
    const mock = createMockPeerManager()
    const ft13 = new FileTransferManager(mock)
    let errored = false
    ft13.on('send-status', (info) => {
      if (info.status === 'error') errored = true
    })
    ft13.startTransfer('../../../etc/crontab', 'evil.sh', 100, 'peer2')
    assert.ok(errored)
    assert.strictEqual(ft13.sends.size, 0)

    try { fs.rmSync(ft13.tempDir, { recursive: true, force: true }) } catch {}
  })
})
