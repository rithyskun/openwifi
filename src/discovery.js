const MulticastDNS = require('multicast-dns')
const os = require('os')

const SERVICE_NAME = '_openwifi._tcp.local'

function getLocalIP() {
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address
      }
    }
  }
  return '127.0.0.1'
}

function createDiscovery(peerInfo) {
  const mdns = MulticastDNS()
  let announcing = false
  let browseInterval = null

  function extractPeerInfo(answers, additionals) {
    const srvRecord = answers.find(
      (a) => a.type === 'SRV' && a.name.includes(SERVICE_NAME)
    )
    if (!srvRecord) return null

    const allRecords = [...answers, ...additionals]
    const txtRecord = allRecords.find((a) => a.type === 'TXT')
    const aRecord = allRecords.find((a) => a.type === 'A')

    if (!txtRecord) return null

    const data = parseTXTRecord(txtRecord.data)
    const peerId = data.id
    if (!peerId || peerId === peerInfo.id) return null

    const host = aRecord ? aRecord.data : srvRecord.name
    const name = data.name || 'Unknown'
    const tcpPort = parseInt(data.tcp, 10)
    const webPort = parseInt(data.web, 10)

    if (!tcpPort) return null

    return { id: peerId, name, host, tcpPort, webPort }
  }

  mdns.on('response', (response) => {
    const peer = extractPeerInfo(response.answers || [], response.additionals || [])
    if (peer) {
      peerInfo.onPeerFound(peer)
    }
  })

  mdns.on('query', (query) => {
    const hasQuestion = (query.questions || []).some(
      (q) => q.name === SERVICE_NAME && q.type === 'PTR'
    )
    if (hasQuestion) {
      announce()
    }
  })

  function parseTXTRecord(data) {
    const result = {}
    if (Array.isArray(data)) {
      for (const entry of data) {
        const str = Buffer.isBuffer(entry) ? entry.toString() : entry
        const idx = str.indexOf('=')
        if (idx > 0) {
          result[str.slice(0, idx)] = str.slice(idx + 1)
        }
      }
    }
    return result
  }

  function announce() {
    const ip = getLocalIP()
    mdns.respond({
      answers: [
        {
          name: SERVICE_NAME,
          type: 'PTR',
          class: 'IN',
          ttl: 120,
          data: `${peerInfo.id}.${SERVICE_NAME}`,
        },
        {
          name: `${peerInfo.id}.${SERVICE_NAME}`,
          type: 'SRV',
          class: 'IN',
          ttl: 120,
          data: {
            priority: 10,
            weight: 1,
            port: peerInfo.tcpPort,
            target: ip,
          },
        },
        {
          name: `${peerInfo.id}.${SERVICE_NAME}`,
          type: 'TXT',
          class: 'IN',
          ttl: 120,
          data: [
            `id=${peerInfo.id}`,
            `name=${peerInfo.name}`,
            `tcp=${peerInfo.tcpPort}`,
            `web=${peerInfo.webPort || ''}`,
          ],
        },
      ],
      additionals: [
        {
          name: ip,
          type: 'A',
          class: 'IN',
          ttl: 120,
          data: ip,
        },
      ],
    })
  }

  function browse() {
    mdns.query({
      questions: [
        {
          name: SERVICE_NAME,
          type: 'PTR',
        },
      ],
    })
  }

  function start() {
    announcing = true
    announce()
    browse()
    browseInterval = setInterval(browse, 5000)
  }

  function stop() {
    announcing = false
    if (browseInterval) {
      clearInterval(browseInterval)
      browseInterval = null
    }
    mdns.destroy()
  }

  return { start, stop, getLocalIP }
}

module.exports = { createDiscovery }
