const socket = io({ auth: { token: window.__WS_TOKEN__ } })
let selfInfo = null
let peers = []

const messagesEl = document.getElementById('messages')
const peerListEl = document.getElementById('peer-list')
const peerCountEl = document.getElementById('peer-count')
const targetSelect = document.getElementById('target-select')
const messageInput = document.getElementById('message-input')
const sendBtn = document.getElementById('send-btn')
const fileInput = document.getElementById('file-input')
const selfInfoEl = document.getElementById('self-info')
const pinModal = document.getElementById('pin-modal')
const pinModalBody = document.getElementById('pin-modal-body')

const CHUNK_SIZE = 262144
const PIPELINE_DEPTH = 4
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
    actions.innerHTML = `<a href="/download/${event.transferId}" class="download-btn" style="text-decoration:none">Save File</a>`
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
    startSendingChunks(event.transferId)
  } else if (event.status === 'complete') {
    const div = document.getElementById(`file-sending-${event.transferId}`)
    if (div) {
      const statusEl = div.querySelector('.send-status')
      if (statusEl) statusEl.textContent = 'Sent'
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

function updateSendProgress(event) {
  const pct = Math.round(((event.index + 1) / event.total) * 100)
  const fill = document.getElementById(`send-fill-${event.transferId}`)
  const text = document.getElementById(`send-text-${event.transferId}`)
  if (fill) fill.style.width = pct + '%'
  if (text) text.textContent = pct + '%'
}

const chunkAcks = {}

socket.on('chunk-ack', ({ transferId }) => {
  const cb = chunkAcks[transferId]
  if (cb) cb()
})

function startSendingChunks(transferId) {
  const send = activeSends.get(transferId)
  if (!send) return

  const { file, chunkSize } = send
  const totalChunks = Math.ceil(file.size / chunkSize)
  let nextIndex = 0
  let inFlight = 0
  let done = false

  function sendNextBatch() {
    if (done) return
    while (inFlight < PIPELINE_DEPTH && nextIndex < totalChunks) {
      const index = nextIndex++
      inFlight++
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
    }

    if (nextIndex >= totalChunks && inFlight === 0) {
      done = true
      delete chunkAcks[transferId]
      socket.emit('file-transfer-end', { transferId })
    }
  }

  chunkAcks[transferId] = () => {
    inFlight--
    sendNextBatch()
  }

  sendNextBatch()
}

function handleAuthEvent(event) {
  console.log('[auth]', event.type, event.peerId, event.peerName)
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

function renderPeerList() {
  peerListEl.innerHTML = ''
  peerCountEl.textContent = peers.length

  const broadcastOption = targetSelect.querySelector('option[value="*broadcast*"]')
  const prevValue = targetSelect.value
  targetSelect.innerHTML = ''
  targetSelect.appendChild(broadcastOption)

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
  }
  if (prevValue) targetSelect.value = prevValue
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
