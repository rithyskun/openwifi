const socket = io({ auth: { token: window.__WS_TOKEN__ } })
let selfInfo = null
let peers = []
let discoveredPeers = []

const messagesEl = document.getElementById('messages')
const peerListEl = document.getElementById('peer-list')
const discoveredListEl = document.getElementById('discovered-list')
const peerCountEl = document.getElementById('peer-count')
const targetSelect = document.getElementById('target-select')
const messageInput = document.getElementById('message-input')
const sendBtn = document.getElementById('send-btn')
const fileInput = document.getElementById('file-input')
const selfInfoEl = document.getElementById('self-info')
const pinModal = document.getElementById('pin-modal')
const pinModalBody = document.getElementById('pin-modal-body')

const aiMessagesEl = document.getElementById('ai-messages')
const aiInput = document.getElementById('ai-input')
const aiSendBtn = document.getElementById('ai-send-btn')
const aiTargetSelect = document.getElementById('ai-target-select')
const aiStatusEl = document.getElementById('ai-status')
const mainTabs = document.querySelectorAll('.main-tab')
const mainViews = document.querySelectorAll('.main-view')

let aiChatHistory = []
const pendingAIRequests = new Map()
const AI_MAX_HISTORY = 50
let aiStreamingContent = ''
let aiStreamingEl = null
let lmStudioAvailable = false

const CHUNK_SIZE = 1048576
const PIPELINE_DEPTH = 8
const activeSends = new Map()

socket.on('self-info', (info) => {
  selfInfo = info
  selfInfoEl.innerHTML = `<strong>${info.name}</strong> <span style="color:#667788">${info.id}</span>`
  addSystemMessage(`You joined as ${info.name}`)
})

socket.on('peer-list', (peerList) => {
  peers = peerList
  renderPeerList()
})

socket.on('discovered-peers', (list) => {
  discoveredPeers = list || []
  renderDiscoveredPeers()
})

socket.on('app-message', (msg) => {
  if (msg.type === 'chat') {
    renderChatMessage(msg)
  } else if (msg.type === 'system') {
    addSystemMessage(msg.payload.text)
  }
})

socket.on('file-transfer-event', (event) => {
  handleFileTransferEvent(event)
})

socket.on('peer-auth-event', (event) => {
  handleAuthEvent(event)
})

function handleFileTransferEvent(event) {
  if (event.action === 'announce') {
    renderIncomingFile(event)
  } else if (event.action === 'progress') {
    updateDownloadProgress(event)
  } else if (event.action === 'complete') {
    completeDownload(event)
  } else if (event.action === 'error') {
    addSystemMessage(`File transfer error: ${event.error}`)
  } else if (event.action === 'send-status') {
    updateSendStatus(event)
  } else if (event.action === 'send-progress') {
    updateSendProgress(event)
  }
}

function renderIncomingFile(event) {
  const div = document.createElement('div')
  div.className = 'message other'
  div.id = `file-incoming-${event.transferId}`

  const nameEl = document.createElement('div')
  nameEl.className = 'msg-sender'
  nameEl.textContent = event.fromName
  div.appendChild(nameEl)

  const fileInfo = document.createElement('div')
  fileInfo.className = 'file-info'
  fileInfo.innerHTML = `
    <span class="file-icon">&#128193;</span>
    <div class="file-details">
      <span class="file-name">${escapeHtml(event.fileName)}</span>
      <span class="file-size">${formatSize(event.fileSize)}</span>
    </div>
  `
  div.appendChild(fileInfo)

  const actions = document.createElement('div')
  actions.className = 'file-actions'
  actions.innerHTML = `
    <button class="download-btn accept-btn">Download</button>
    <button class="decline-btn">Decline</button>
  `
  div.appendChild(actions)

  const progressContainer = document.createElement('div')
  progressContainer.className = 'progress-container hidden'
  progressContainer.id = `progress-${event.transferId}`
  progressContainer.innerHTML = `
    <div class="progress-bar">
      <div class="progress-fill" id="progress-fill-${event.transferId}" style="width:0%"></div>
    </div>
    <span class="progress-text" id="progress-text-${event.transferId}">0%</span>
  `
  div.appendChild(progressContainer)

  const timeEl = document.createElement('div')
  timeEl.className = 'msg-time'
  timeEl.textContent = new Date().toLocaleTimeString()
  div.appendChild(timeEl)

  messagesEl.appendChild(div)
  messagesEl.scrollTop = messagesEl.scrollHeight

  const acceptBtn = actions.querySelector('.accept-btn')
  const declineBtn = actions.querySelector('.decline-btn')

  acceptBtn.addEventListener('click', () => {
    acceptBtn.disabled = true
    declineBtn.disabled = true
    acceptBtn.textContent = 'Downloading...'
    socket.emit('file-transfer-accept', { transferId: event.transferId })
    progressContainer.classList.remove('hidden')
  })

  declineBtn.addEventListener('click', () => {
    socket.emit('file-transfer-cancel', { transferId: event.transferId })
    div.querySelector('.file-actions').innerHTML = '<span style="color:#667788;font-size:12px">Declined</span>'
  })
}

function updateDownloadProgress(event) {
  const pct = Math.round((event.received / event.total) * 100)
  const fill = document.getElementById(`progress-fill-${event.transferId}`)
  const text = document.getElementById(`progress-text-${event.transferId}`)
  if (fill) fill.style.width = pct + '%'
  if (text) text.textContent = pct + '%'
}

function completeDownload(event) {
  const container = document.getElementById(`file-incoming-${event.transferId}`)
  if (!container) return

  const progressContainer = document.getElementById(`progress-${event.transferId}`)
  if (progressContainer) {
    progressContainer.querySelector('.progress-fill').style.width = '100%'
    progressContainer.querySelector('.progress-text').textContent = '100%'
  }

  const actions = container.querySelector('.file-actions')
  if (actions) {
    const verifiedBadge = event.verified
      ? '<span class="verified-badge" title="SHA-256 integrity verified">&#10003; Verified</span>'
      : ''
    actions.innerHTML = `<a href="/download/${event.transferId}" class="download-btn" style="text-decoration:none">Save File</a>${verifiedBadge}`
  }
}

function updateSendStatus(event) {
  if (event.status === 'waiting') {
    const div = document.getElementById(`file-sending-${event.transferId}`)
    if (div) {
      const statusEl = div.querySelector('.send-status')
      if (statusEl) statusEl.textContent = 'Waiting for peer to accept...'
    }
  } else if (event.status === 'sending') {
    const div = document.getElementById(`file-sending-${event.transferId}`)
    if (div) {
      const statusEl = div.querySelector('.send-status')
      if (statusEl) statusEl.textContent = 'Sending...'
    }
    const send = activeSends.get(event.transferId)
    if (send) {
      send.startTime = Date.now()
      send.bytesAcked = 0
    }
    startSendingChunks(event.transferId)
  } else if (event.status === 'complete') {
    const div = document.getElementById(`file-sending-${event.transferId}`)
    if (div) {
      const statusEl = div.querySelector('.send-status')
      if (statusEl) statusEl.textContent = 'Sent'
    }
    const send = activeSends.get(event.transferId)
    if (send) {
      const elapsedSec = (Date.now() - (send.startTime || Date.now())) / 1000
      const avgSpeed = elapsedSec > 0 ? send.file.size / elapsedSec : 0
      const speedEl = document.getElementById(`send-speed-${event.transferId}`)
      if (speedEl) speedEl.textContent = `Avg: ${formatSpeed(avgSpeed)}`
    }
    activeSends.delete(event.transferId)
  } else if (event.status === 'error') {
    const div = document.getElementById(`file-sending-${event.transferId}`)
    if (div) {
      const statusEl = div.querySelector('.send-status')
      if (statusEl) { statusEl.textContent = event.error; statusEl.style.color = '#e94560' }
    }
    activeSends.delete(event.transferId)
  } else if (event.status === 'cancelled') {
    const div = document.getElementById(`file-sending-${event.transferId}`)
    if (div) {
      const statusEl = div.querySelector('.send-status')
      if (statusEl) statusEl.textContent = 'Cancelled'
    }
    activeSends.delete(event.transferId)
  }
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec < 1) return ''
  if (bytesPerSec >= 1048576) return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
  return `${Math.round(bytesPerSec)} B/s`
}

function updateSendProgress(event) {
  const send = activeSends.get(event.transferId)
  if (!send) return
  if (!send.startTime) {
    send.startTime = Date.now()
    send.bytesAcked = 0
  }
  const chunkSize = send.chunkSize || CHUNK_SIZE
  send.bytesAcked = (event.index + 1) * chunkSize
  if (send.bytesAcked > send.file.size) send.bytesAcked = send.file.size

  const elapsedSec = (Date.now() - send.startTime) / 1000
  const speed = elapsedSec > 0 ? send.bytesAcked / elapsedSec : 0

  const pct = Math.round((send.bytesAcked / send.file.size) * 100)
  const fill = document.getElementById(`send-fill-${event.transferId}`)
  const text = document.getElementById(`send-text-${event.transferId}`)
  const speedEl = document.getElementById(`send-speed-${event.transferId}`)
  if (fill) fill.style.width = pct + '%'
  if (text) text.textContent = pct + '%'
  if (speedEl) speedEl.textContent = formatSpeed(speed)
}

const pendingChunks = new Map()
const sendQueues = new Map()
const CHUNK_TIMEOUT_MS = 15000
const MAX_CHUNK_RETRIES = 3

socket.on('chunk-ack', ({ transferId, index }) => {
  const pending = pendingChunks.get(transferId)
  if (!pending) return
  const chunk = pending.get(index)
  if (chunk) {
    clearTimeout(chunk.timer)
    pending.delete(index)
    sendNextBatch(transferId)
  }
})

socket.on('chunk-error', ({ transferId, index, error }) => {
  const pending = pendingChunks.get(transferId)
  if (!pending) return
  const chunk = pending.get(index)
  if (!chunk) return
  clearTimeout(chunk.timer)
  if (chunk.retries < MAX_CHUNK_RETRIES) {
    chunk.retries++
    pending.delete(index)
    sendChunkToServer(transferId, index)
    const newPending = pendingChunks.get(transferId)
    if (newPending) {
      const newChunk = newPending.get(index)
      if (newChunk) newChunk.retries = chunk.retries
    }
  } else {
    abortSend(transferId, `Chunk ${index} failed: ${error || 'max retries'}`)
  }
})

function abortSend(transferId, reason) {
  const pending = pendingChunks.get(transferId)
  if (pending) {
    for (const [, chunk] of pending) clearTimeout(chunk.timer)
    pendingChunks.delete(transferId)
  }
  sendQueues.delete(transferId)
  activeSends.delete(transferId)
  socket.emit('file-transfer-cancel', { transferId })
  addSystemMessage(`Send failed: ${reason}`)
}

function startSendingChunks(transferId) {
  const send = activeSends.get(transferId)
  if (!send) return

  const { file, chunkSize } = send
  const totalChunks = Math.ceil(file.size / chunkSize)
  sendQueues.set(transferId, { file, chunkSize, totalChunks, nextIndex: 0 })
  pendingChunks.set(transferId, new Map())

  sendNextBatch(transferId)
}

function sendNextBatch(transferId) {
  const queue = sendQueues.get(transferId)
  const pending = pendingChunks.get(transferId)
  if (!queue || !pending) return

  while (pending.size < PIPELINE_DEPTH && queue.nextIndex < queue.totalChunks) {
    const index = queue.nextIndex++
    sendChunkToServer(transferId, index)
  }

  if (queue.nextIndex >= queue.totalChunks && pending.size === 0) {
    pendingChunks.delete(transferId)
    sendQueues.delete(transferId)
    socket.emit('file-transfer-end', { transferId })
  }
}

function sendChunkToServer(transferId, index) {
  const queue = sendQueues.get(transferId)
  const pending = pendingChunks.get(transferId)
  if (!queue || !pending) return

  const { file, chunkSize } = queue
  const start = index * chunkSize
  const end = Math.min(start + chunkSize, file.size)
  const blob = file.slice(start, end)
  const reader = new FileReader()

  reader.onload = (e) => {
    socket.emit('file-chunk-upload', {
      transferId, index, data: e.target.result,
    })
  }

  reader.readAsArrayBuffer(blob)

  const timer = setTimeout(() => {
    const p = pendingChunks.get(transferId)
    if (!p) return
    const chunk = p.get(index)
    if (!chunk) return
    if (chunk.retries < MAX_CHUNK_RETRIES) {
      chunk.retries++
      p.delete(index)
      sendChunkToServer(transferId, index)
      const newPending = pendingChunks.get(transferId)
      if (newPending) {
        const newChunk = newPending.get(index)
        if (newChunk) newChunk.retries = chunk.retries
      }
    } else {
      abortSend(transferId, `Chunk ${index} timed out after ${MAX_CHUNK_RETRIES} retries`)
    }
  }, CHUNK_TIMEOUT_MS)

  pending.set(index, { retries: 0, timer })
}

function handleAuthEvent(event) {
  if (event.type === 'pin_required') {
    showPINRequired(event.peerId, event.peerName, event.pin)
  } else if (event.type === 'awaiting_pin') {
    showPINInput(event.peerId, event.peerName)
  } else if (event.type === 'authenticated') {
    hideModal()
    addSystemMessage(`Authenticated with ${event.peerName}`)
    renderPeerList()
  } else if (event.type === 'auth_failed') {
    hideModal()
    addSystemMessage(`Authentication failed for ${event.peerName}`)
    renderPeerList()
  } else if (event.type === 'aborted') {
    hideModal()
    addSystemMessage(`Authentication cancelled by ${event.peerName}`)
  }
}

function showPINRequired(peerId, peerName, pin) {
  pinModalBody.innerHTML = `
    <div class="pin-icon">&#128274;</div>
    <h2>Connection Request</h2>
    <p class="pin-peer">${escapeHtml(peerName)}</p>
    <p class="pin-label">Share this PIN with the remote user:</p>
    <div class="pin-display">${pin}</div>
    <p class="pin-hint">They will enter this code on their device</p>
  `
  pinModal.classList.remove('hidden')
}

function showPINInput(peerId, peerName) {
  pinModalBody.innerHTML = `
    <div class="pin-icon">&#128273;</div>
    <h2>Enter PIN</h2>
    <p class="pin-peer">${escapeHtml(peerName)}</p>
    <p class="pin-label">Enter the 6-digit PIN shown on their screen:</p>
    <input type="text" id="pin-input" class="pin-input" maxlength="6" inputmode="numeric" pattern="[0-9]*" autocomplete="off">
    <div id="pin-error" class="pin-error hidden">PIN must be 6 digits</div>
    <button id="pin-submit-btn" class="pin-submit-btn">Verify</button>
  `
  pinModal.classList.remove('hidden')

  const pinInput = document.getElementById('pin-input')
  const pinSubmit = document.getElementById('pin-submit-btn')
  const pinError = document.getElementById('pin-error')

  pinInput.focus()

  function submitPIN() {
    const value = pinInput.value.trim()
    if (value.length !== 6 || !/^\d{6}$/.test(value)) {
      pinError.classList.remove('hidden')
      return
    }
    pinError.classList.add('hidden')
    socket.emit('pin-submit', { peerId, pin: value })
    pinModalBody.innerHTML = `
      <div class="pin-icon">&#128295;</div>
      <h2>Verifying...</h2>
      <p class="pin-label">Waiting for peer to confirm...</p>
    `
  }

  pinSubmit.addEventListener('click', submitPIN)
  pinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitPIN()
  })
}

function hideModal() {
  pinModal.classList.add('hidden')
}

pinModal.addEventListener('click', (e) => {
  if (e.target === pinModal) hideModal()
})

function renderDiscoveredPeers() {
  discoveredListEl.innerHTML = ''
  if (discoveredPeers.length === 0) {
    discoveredListEl.innerHTML = '<li class="discovered-empty">No devices found</li>'
    return
  }
  for (const peer of discoveredPeers) {
    const li = document.createElement('li')
    li.className = 'discovered-peer'
    li.innerHTML = `
      <span class="peer-name">${escapeHtml(peer.name)}</span>
      <span class="peer-id">${escapeHtml(peer.id)}</span>
      <button class="connect-btn" data-peer-id="${escapeHtml(peer.id)}">Connect</button>
    `
    li.querySelector('.connect-btn').addEventListener('click', (e) => {
      e.stopPropagation()
      socket.emit('connect-peer', { peerId: peer.id })
      e.target.textContent = 'Connecting...'
      e.target.disabled = true
    })
    discoveredListEl.appendChild(li)
  }
}

function renderPeerList() {
  peerListEl.innerHTML = ''
  peerCountEl.textContent = peers.length

  const broadcastOption = targetSelect.querySelector('option[value="*broadcast*"]')
  const prevValue = targetSelect.value
  targetSelect.innerHTML = ''
  targetSelect.appendChild(broadcastOption)

  const localOption = aiTargetSelect.querySelector('option[value="__local__"]')
  const aiPrevValue = aiTargetSelect.value
  aiTargetSelect.innerHTML = ''
  aiTargetSelect.appendChild(localOption)

  if (peers.length === 0) {
    peerListEl.innerHTML = '<li class="discovered-empty">None connected</li>'
  }

  for (const peer of peers) {
    const li = document.createElement('li')
    const isAuth = peer.authenticated && peer.sharedKey && peer.handshakeDone
    li.innerHTML = `
      <span class="peer-name">${escapeHtml(peer.name)}</span>
      <span class="peer-id">${escapeHtml(peer.id)}</span>
      <span class="peer-status ${isAuth ? 'status-secure' : 'status-pending'}">${isAuth ? 'AUTHENTICATED' : 'PENDING'}</span>
    `
    li.addEventListener('click', () => {
      targetSelect.value = peer.id
    })
    peerListEl.appendChild(li)

    const option = document.createElement('option')
    option.value = peer.id
    option.textContent = `${peer.name} (direct)`
    targetSelect.appendChild(option)

    const aiOption = document.createElement('option')
    aiOption.value = peer.id
    aiOption.textContent = `${peer.name} (mesh)`
    aiTargetSelect.appendChild(aiOption)
  }
  if (prevValue) targetSelect.value = prevValue
  if (aiPrevValue) aiTargetSelect.value = aiPrevValue
}

function renderChatMessage(msg) {
  const isSelf = msg.from === selfInfo.id
  const isBroadcast = msg.to === '*broadcast*'

  const div = document.createElement('div')
  div.className = `message ${isSelf ? 'self' : 'other'}`

  const sender = isSelf ? 'You' : (msg.fromName || msg.from)
  const time = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : ''

  if (!isSelf) {
    const nameEl = document.createElement('div')
    nameEl.className = 'msg-sender'
    nameEl.textContent = isBroadcast ? sender : `${sender} (direct)`
    div.appendChild(nameEl)
  }

  if (isSelf) {
    const lockEl = document.createElement('span')
    lockEl.className = 'msg-lock'
    lockEl.textContent = String.fromCharCode(0x1F512)
    div.appendChild(lockEl)
  }

  const textEl = document.createElement('div')
  textEl.textContent = msg.payload.text
  div.appendChild(textEl)

  if (time) {
    const timeEl = document.createElement('div')
    timeEl.className = 'msg-time'
    timeEl.textContent = time
    div.appendChild(timeEl)
  }

  messagesEl.appendChild(div)
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function renderOutgoingFile(transferId, fileName, fileSize) {
  const div = document.createElement('div')
  div.className = 'message self'
  div.id = `file-sending-${transferId}`

  const lockEl = document.createElement('span')
  lockEl.className = 'msg-lock'
  lockEl.textContent = String.fromCharCode(0x1F512)
  div.appendChild(lockEl)

  const fileInfo = document.createElement('div')
  fileInfo.className = 'file-info'
  fileInfo.innerHTML = `
    <span class="file-icon">&#128193;</span>
    <div class="file-details">
      <span class="file-name">${escapeHtml(fileName)}</span>
      <span class="file-size">${formatSize(fileSize)}</span>
    </div>
  `
  div.appendChild(fileInfo)

  const progressContainer = document.createElement('div')
  progressContainer.className = 'progress-container'
  progressContainer.innerHTML = `
    <div class="progress-bar">
      <div class="progress-fill" id="send-fill-${transferId}" style="width:0%"></div>
    </div>
    <span class="progress-text" id="send-text-${transferId}">0%</span>
    <span class="speed-text" id="send-speed-${transferId}"></span>
  `
  div.appendChild(progressContainer)

  const statusEl = document.createElement('div')
  statusEl.className = 'send-status'
  statusEl.textContent = 'Waiting for peer to accept...'
  div.appendChild(statusEl)

  const timeEl = document.createElement('div')
  timeEl.className = 'msg-time'
  timeEl.textContent = new Date().toLocaleTimeString()
  div.appendChild(timeEl)

  messagesEl.appendChild(div)
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function addSystemMessage(text) {
  const div = document.createElement('div')
  div.className = 'message system'
  div.textContent = text
  messagesEl.appendChild(div)
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function sendMessage() {
  const text = messageInput.value.trim()
  if (!text) return

  const target = targetSelect.value
  socket.emit('send-message', { to: target, text })
  messageInput.value = ''
  messageInput.focus()
}

sendBtn.addEventListener('click', sendMessage)
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage()
})

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0]
  if (!file) return

  const target = targetSelect.value
  if (target === '*broadcast*') {
    addSystemMessage('Cannot send files in broadcast mode. Select a specific peer.')
    fileInput.value = ''
    return
  }

  const transferId = `${selfInfo.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  activeSends.set(transferId, { file, chunkSize: CHUNK_SIZE })

  renderOutgoingFile(transferId, file.name, file.size)

  socket.emit('file-transfer-start', {
    transferId,
    fileName: file.name,
    fileSize: file.size,
    to: target,
  })

  fileInput.value = ''
})

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

function switchMainView(viewName) {
  for (const tab of mainTabs) {
    tab.classList.toggle('active', tab.dataset.view === viewName)
  }
  for (const view of mainViews) {
    view.classList.toggle('active', view.id === `${viewName}-view`)
  }
  if (viewName === 'ai') {
    aiInput.focus()
  } else {
    messageInput.focus()
  }
}

for (const tab of mainTabs) {
  tab.addEventListener('click', () => switchMainView(tab.dataset.view))
}

function appendAIMessage(role, text) {
  const div = document.createElement('div')
  div.className = `ai-message ${role}`
  const content = document.createElement('div')
  content.className = 'ai-message-content'
  content.textContent = text
  div.appendChild(content)
  aiMessagesEl.appendChild(div)
  aiMessagesEl.scrollTop = aiMessagesEl.scrollHeight
}

function appendAILoading() {
  const div = document.createElement('div')
  div.className = 'ai-message assistant loading'
  div.id = 'ai-loading'
  div.innerHTML = '<div class="ai-message-content"><span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span></div>'
  aiMessagesEl.appendChild(div)
  aiMessagesEl.scrollTop = aiMessagesEl.scrollHeight
}

function removeAILoading() {
  const el = document.getElementById('ai-loading')
  if (el) el.remove()
}

function appendAIStreamingMessage() {
  const div = document.createElement('div')
  div.className = 'ai-message assistant'
  div.id = 'ai-streaming'
  const content = document.createElement('div')
  content.className = 'ai-message-content'
  content.id = 'ai-streaming-content'
  div.appendChild(content)
  aiMessagesEl.appendChild(div)
  aiStreamingEl = content
  aiStreamingContent = ''
  aiMessagesEl.scrollTop = aiMessagesEl.scrollHeight
}

function appendAIToolIndicator(toolName, args) {
  const div = document.createElement('div')
  div.className = 'ai-tool-indicator'
  div.innerHTML = `<span class="ai-tool-icon">&#9881;</span> <span class="ai-tool-name">${escapeHtml(toolName)}</span>`
  if (args && Object.keys(args).length > 0) {
    const argsEl = document.createElement('div')
    argsEl.className = 'ai-tool-args'
    argsEl.textContent = JSON.stringify(args, null, 2)
    div.appendChild(argsEl)
  }
  aiMessagesEl.appendChild(div)
  aiMessagesEl.scrollTop = aiMessagesEl.scrollHeight
}

function appendAIToolResult(toolName, result) {
  const div = document.createElement('div')
  div.className = 'ai-tool-result'
  const header = document.createElement('div')
  header.className = 'ai-tool-result-header'
  header.textContent = `Result: ${escapeHtml(toolName)}`
  div.appendChild(header)
  const content = document.createElement('div')
  content.className = 'ai-tool-result-content'
  content.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  div.appendChild(content)
  aiMessagesEl.appendChild(div)
  aiMessagesEl.scrollTop = aiMessagesEl.scrollHeight
}

function finalizeAIStreaming() {
  if (aiStreamingEl) {
    aiStreamingEl.removeAttribute('id')
    aiStreamingEl = null
  }
  if (aiStreamingContent) {
    aiChatHistory.push({ role: 'assistant', content: aiStreamingContent })
    if (aiChatHistory.length > AI_MAX_HISTORY) {
      aiChatHistory = aiChatHistory.slice(-AI_MAX_HISTORY)
    }
  }
  aiStreamingContent = ''
}

function checkAIStatus() {
  fetch('/api/ai/status').then(r => r.json()).then(data => {
    if (data.lmStudio) {
      fetch('/api/ai/lmstudio/status').then(r => r.json()).then(lmData => {
        lmStudioAvailable = lmData.available
        if (lmData.available) {
          aiStatusEl.textContent = `AI: ${lmData.model} (Agentic)`
          aiStatusEl.className = 'ai-status online'
        } else {
          aiStatusEl.textContent = `AI: ${data.model} (LM Studio offline)`
          aiStatusEl.className = 'ai-status online'
        }
      }).catch(() => {
        lmStudioAvailable = false
        aiStatusEl.textContent = `AI: ${data.model}`
        aiStatusEl.className = 'ai-status online'
      })
    } else {
      lmStudioAvailable = false
      aiStatusEl.textContent = `AI: ${data.model}`
      aiStatusEl.className = 'ai-status online'
    }
  }).catch(() => {
    aiStatusEl.textContent = 'AI: Offline'
    aiStatusEl.className = 'ai-status offline'
  })
}

checkAIStatus()
setInterval(checkAIStatus, 30000)

async function sendAIMessage() {
  const text = aiInput.value.trim()
  if (!text) return
  aiInput.value = ''
  aiInput.disabled = true
  aiSendBtn.disabled = true

  aiChatHistory.push({ role: 'user', content: text })
  if (aiChatHistory.length > AI_MAX_HISTORY) {
    aiChatHistory = aiChatHistory.slice(-AI_MAX_HISTORY)
  }
  appendAIMessage('user', text)

  const target = aiTargetSelect.value

  if (target === '__local__' && lmStudioAvailable) {
    appendAIStreamingMessage()
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    socket.emit('ai-agent-chat', { requestId, messages: aiChatHistory })
  } else if (target === '__local__') {
    appendAILoading()
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${window.__WS_TOKEN__}`,
        },
        body: JSON.stringify({ messages: aiChatHistory }),
      })
      removeAILoading()
      if (res.status === 401) {
        appendAIMessage('error', 'Authentication error')
      } else if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }))
        appendAIMessage('error', err.error || 'Error')
      } else {
        const data = await res.json()
        const reply = data.response || '(no response)'
        aiChatHistory.push({ role: 'assistant', content: reply })
        if (aiChatHistory.length > AI_MAX_HISTORY) {
          aiChatHistory = aiChatHistory.slice(-AI_MAX_HISTORY)
        }
        appendAIMessage('assistant', reply)
      }
    } catch (err) {
      removeAILoading()
      appendAIMessage('error', `AI service unreachable: ${err.message}`)
    }
  } else {
    appendAILoading()
    const requestId = `${selfInfo.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    pendingAIRequests.set(requestId, { messages: [...aiChatHistory] })
    socket.emit('ai-request', { to: target, requestId, messages: aiChatHistory })
  }

  aiInput.disabled = false
  aiSendBtn.disabled = false
  aiInput.focus()
}

socket.on('ai-message', (data) => {
  if (!data || typeof data.requestId !== 'string') return
  const pending = pendingAIRequests.get(data.requestId)
  if (!pending) return
  pendingAIRequests.delete(data.requestId)
  removeAILoading()
  if (data.error) {
    appendAIMessage('error', data.error)
  } else {
    const reply = data.response || '(no response)'
    aiChatHistory.push({ role: 'assistant', content: reply })
    appendAIMessage('assistant', reply)
  }
})

socket.on('ai-agent-stream', (data) => {
  if (!data || typeof data.content !== 'string') return
  if (!aiStreamingEl) return
  aiStreamingContent += data.content
  aiStreamingEl.textContent = aiStreamingContent
  aiMessagesEl.scrollTop = aiMessagesEl.scrollHeight
})

socket.on('ai-agent-message', (data) => {
  if (!data || typeof data.content !== 'string') return
})

socket.on('ai-agent-tool-call', (data) => {
  if (!data || typeof data.tool !== 'string') return
  appendAIToolIndicator(data.tool, data.args)
})

socket.on('ai-agent-tool-result', (data) => {
  if (!data || typeof data.tool !== 'string') return
  appendAIToolResult(data.tool, data.result)
})

socket.on('ai-agent-complete', (data) => {
  if (!data) return
  finalizeAIStreaming()
  aiInput.disabled = false
  aiSendBtn.disabled = false
  aiInput.focus()
})

socket.on('ai-agent-error', (data) => {
  if (!data) return
  if (aiStreamingEl) {
    aiStreamingEl.parentElement.remove()
    aiStreamingEl = null
    aiStreamingContent = ''
  }
  appendAIMessage('error', data.error || 'AI agent error')
  aiInput.disabled = false
  aiSendBtn.disabled = false
  aiInput.focus()
})

aiSendBtn.addEventListener('click', sendAIMessage)
aiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendAIMessage()
  }
})
