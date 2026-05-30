const socket = io()
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
  } else if (msg.type === 'file-announce') {
    renderFileAnnouncement(msg)
  } else if (msg.type === 'system') {
    addSystemMessage(msg.payload.text)
  }
})

socket.on('peer-auth-event', (event) => {
  handleAuthEvent(event)
})

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

function renderPeerList() {
  peerListEl.innerHTML = ''
  peerCountEl.textContent = peers.length

  const broadcastOption = targetSelect.querySelector('option[value="*broadcast*"]')
  targetSelect.innerHTML = ''
  targetSelect.appendChild(broadcastOption)

  for (const peer of peers) {
    const li = document.createElement('li')
    const isAuth = peer.sharedKey && peer.handshakeDone
    li.innerHTML = `
      <span class="peer-name">${escapeHtml(peer.name)}</span>
      <span class="peer-id">${escapeHtml(peer.id)}</span>
      <span class="peer-status ${isAuth ? 'status-secure' : 'status-pending'}">${isAuth ? 'SECURE' : 'PENDING'}</span>
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

function renderFileAnnouncement(msg) {
  const isSelf = msg.from === selfInfo.id
  if (isSelf) return

  const div = document.createElement('div')
  div.className = 'message other'

  const sender = msg.fromName || msg.from
  const nameEl = document.createElement('div')
  nameEl.className = 'msg-sender'
  nameEl.textContent = sender
  div.appendChild(nameEl)

  const fileInfo = document.createElement('div')
  fileInfo.className = 'file-info'
  fileInfo.innerHTML = `
    <span class="file-icon">&#128193;</span>
    <div class="file-details">
      <span class="file-name">${escapeHtml(msg.payload.fileName)}</span>
      <span class="file-size">${formatSize(msg.payload.fileSize)}</span>
    </div>
  `
  div.appendChild(fileInfo)

  const dlBtn = document.createElement('button')
  dlBtn.className = 'download-btn'
  dlBtn.textContent = 'Download'
  dlBtn.addEventListener('click', () => {
    downloadFile(msg.payload.fileData, msg.payload.fileName)
  })
  div.appendChild(dlBtn)

  const timeEl = document.createElement('div')
  timeEl.className = 'msg-time'
  timeEl.textContent = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : ''
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

  const reader = new FileReader()
  reader.onload = (e) => {
    const base64 = e.target.result.split(',')[1]
    socket.emit('send-file', {
      to: target,
      fileName: file.name,
      fileSize: file.size,
      fileData: base64,
    })
    addSystemMessage(`Sent file: ${file.name} (${formatSize(file.size)})`)
  }
  reader.readAsDataURL(file)
  fileInput.value = ''
})

function downloadFile(base64Data, fileName) {
  const byteCharacters = atob(base64Data)
  const byteNumbers = new Array(byteCharacters.length)
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i)
  }
  const byteArray = new Uint8Array(byteNumbers)
  const blob = new Blob([byteArray])
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

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
