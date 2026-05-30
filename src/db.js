const Database = require('better-sqlite3')
const path = require('path')

function createDatabase(dbPath, vault) {
  const resolvedPath = dbPath || path.join(__dirname, '..', 'openwifi.db')
  const db = new Database(resolvedPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS trusted_peers (
      peer_id    TEXT PRIMARY KEY,
      peer_name  TEXT NOT NULL,
      public_key TEXT NOT NULL,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const hasVault = vault && vault.isUnlocked()

  function getKeypair() {
    const pub = db.prepare("SELECT value FROM config WHERE key = 'public_key'").get()
    const priv = db.prepare("SELECT value FROM config WHERE key = 'private_key'").get()
    if (pub && priv) {
      if (hasVault) {
        try {
          const privateKey = vault.decrypt(priv.value)
          return { publicKey: pub.value, privateKey }
        } catch { return null }
      }
      return { publicKey: pub.value, privateKey: priv.value }
    }
    return null
  }

  function saveKeypair(publicKey, privateKey) {
    const privVal = hasVault ? vault.encrypt(privateKey) : privateKey
    const upsert = db.prepare(
      'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)'
    )
    upsert.run('public_key', publicKey)
    upsert.run('private_key', privVal)
  }

  function addTrustedPeer(peerId, peerName, publicKey) {
    const encKey = hasVault && publicKey ? vault.encrypt(publicKey) : (publicKey || '')
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO trusted_peers (peer_id, peer_name, public_key, last_seen)
      VALUES (?, ?, ?, datetime('now'))
    `)
    stmt.run(peerId, peerName, encKey)
  }

  function getTrustedPeer(peerId) {
    const row = db.prepare('SELECT * FROM trusted_peers WHERE peer_id = ?').get(peerId)
    if (!row) return undefined
    let publicKey = row.public_key
    if (hasVault && publicKey && publicKey.startsWith('{')) {
      try { publicKey = vault.decrypt(publicKey) } catch { publicKey = '' }
    }
    return { ...row, public_key: publicKey }
  }

  function isTrustedPeer(peerId) {
    const row = db.prepare('SELECT 1 FROM trusted_peers WHERE peer_id = ?').get(peerId)
    return !!row
  }

  function removeTrustedPeer(peerId) {
    db.prepare('DELETE FROM trusted_peers WHERE peer_id = ?').run(peerId)
  }

  function listTrustedPeers() {
    const rows = db.prepare('SELECT * FROM trusted_peers ORDER BY last_seen DESC').all()
    return rows.map((row) => {
      let publicKey = row.public_key
      if (hasVault && publicKey && publicKey.startsWith('{')) {
        try { publicKey = vault.decrypt(publicKey) } catch { publicKey = '' }
      }
      return { ...row, public_key: publicKey }
    })
  }

  function getVaultSalt() {
    const row = db.prepare("SELECT value FROM config WHERE key = 'vault_salt'").get()
    return row ? row.value : null
  }

  function saveVaultSalt(salt) {
    const upsert = db.prepare(
      'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)'
    )
    upsert.run('vault_salt', salt)
  }

  function close() {
    db.close()
  }

  return {
    getKeypair,
    saveKeypair,
    addTrustedPeer,
    getTrustedPeer,
    isTrustedPeer,
    removeTrustedPeer,
    listTrustedPeers,
    getVaultSalt,
    saveVaultSalt,
    close,
  }
}

module.exports = { createDatabase }
