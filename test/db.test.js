const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')
const { createDatabase } = require('../src/db')
const { Vault } = require('../src/vault')

describe('createDatabase', () => {
  let dbPath
  let db

  before(() => {
    dbPath = path.join(__dirname, 'test_openwifi.db')
    db = createDatabase(dbPath)
  })

  after(() => {
    db.close()
    try { fs.unlinkSync(dbPath) } catch {}
    try { fs.unlinkSync(dbPath + '-wal') } catch {}
    try { fs.unlinkSync(dbPath + '-shm') } catch {}
  })

  it('returns null when no keypair exists', () => {
    const result = db.getKeypair()
    assert.equal(result, null)
  })

  it('saves and retrieves keypair', () => {
    const pub = 'test-public-key-base64'
    const priv = 'test-private-key-base64'
    db.saveKeypair(pub, priv)

    const result = db.getKeypair()
    assert.notEqual(result, null)
    assert.equal(result.publicKey, pub)
    assert.equal(result.privateKey, priv)
  })

  it('overwrites existing keypair on save', () => {
    db.saveKeypair('new-pub', 'new-priv')
    const result = db.getKeypair()
    assert.equal(result.publicKey, 'new-pub')
    assert.equal(result.privateKey, 'new-priv')
  })

  it('returns false for untrusted peer', () => {
    assert.equal(db.isTrustedPeer('nonexistent-id'), false)
  })

  it('adds and retrieves trusted peer', () => {
    db.addTrustedPeer('peer-1', 'Alice', 'alice-public-key')
    const peer = db.getTrustedPeer('peer-1')
    assert.notEqual(peer, undefined)
    assert.equal(peer.peer_id, 'peer-1')
    assert.equal(peer.peer_name, 'Alice')
    assert.equal(peer.public_key, 'alice-public-key')
  })

  it('returns true for trusted peer after adding', () => {
    assert.equal(db.isTrustedPeer('peer-1'), true)
  })

  it('updates existing peer on re-add', () => {
    db.addTrustedPeer('peer-1', 'Alice Updated', 'new-key')
    const peer = db.getTrustedPeer('peer-1')
    assert.equal(peer.peer_name, 'Alice Updated')
    assert.equal(peer.public_key, 'new-key')
  })

  it('returns undefined for non-existent peer', () => {
    const peer = db.getTrustedPeer('does-not-exist')
    assert.equal(peer, undefined)
  })

  it('lists all trusted peers', () => {
    db.addTrustedPeer('peer-2', 'Bob', 'bob-key')
    db.addTrustedPeer('peer-3', 'Carol', 'carol-key')
    const list = db.listTrustedPeers()
    assert(list.length >= 3)
    const ids = list.map((p) => p.peer_id)
    assert(ids.includes('peer-1'))
    assert(ids.includes('peer-2'))
    assert(ids.includes('peer-3'))
  })

  it('removes trusted peer', () => {
    db.removeTrustedPeer('peer-2')
    assert.equal(db.isTrustedPeer('peer-2'), false)
    assert.equal(db.getTrustedPeer('peer-2'), undefined)
  })

  it('remove does not affect other peers', () => {
    assert.equal(db.isTrustedPeer('peer-1'), true)
    assert.equal(db.isTrustedPeer('peer-3'), true)
  })

  it('handles multiple trusted peers independently', () => {
    db.addTrustedPeer('alpha', 'Alpha', 'alpha-key')
    db.addTrustedPeer('beta', 'Beta', 'beta-key')
    assert.equal(db.getTrustedPeer('alpha').peer_name, 'Alpha')
    assert.equal(db.getTrustedPeer('beta').peer_name, 'Beta')
    db.removeTrustedPeer('alpha')
    assert.equal(db.isTrustedPeer('alpha'), false)
    assert.equal(db.isTrustedPeer('beta'), true)
  })
})

describe('createDatabase with Vault encryption', () => {
  let dbPath
  let vault
  let db

  before(() => {
    dbPath = path.join(__dirname, 'test_vault_openwifi.db')
    const salt = Vault.generateSalt()
    vault = Vault.fromPassphrase('my-vault-passphrase', salt)
    db = createDatabase(dbPath, vault)
    db.saveVaultSalt(salt)
  })

  after(() => {
    db.close()
    try { fs.unlinkSync(dbPath) } catch {}
    try { fs.unlinkSync(dbPath + '-wal') } catch {}
    try { fs.unlinkSync(dbPath + '-shm') } catch {}
  })

  it('stores private key encrypted (not plaintext) in SQLite', () => {
    db.saveKeypair('pub-enc-test', 'priv-enc-test')
    const rawDb = new (require('better-sqlite3'))(dbPath)
    const row = rawDb.prepare("SELECT value FROM config WHERE key = 'private_key'").get()
    rawDb.close()
    assert(row.value.startsWith('{'), 'private_key should be JSON-encrypted in db')
  })

  it('retrieves keypair correctly through vault', () => {
    const result = db.getKeypair()
    assert.equal(result.publicKey, 'pub-enc-test')
    assert.equal(result.privateKey, 'priv-enc-test')
  })

  it('vault-decrypted keypair is unusable with wrong passphrase', () => {
    const wrongVault = Vault.fromPassphrase('wrong-passphrase-here', Vault.generateSalt())
    const wrongDb = createDatabase(dbPath, wrongVault)
    const result = wrongDb.getKeypair()
    assert.equal(result, null)
    wrongDb.close()
  })

  it('stores trusted peer public key encrypted in SQLite', () => {
    db.addTrustedPeer('v-peer-1', 'VaultAlice', 'vault-alice-pub-key')
    const rawDb = new (require('better-sqlite3'))(dbPath)
    const row = rawDb.prepare("SELECT public_key FROM trusted_peers WHERE peer_id = 'v-peer-1'").get()
    rawDb.close()
    assert(row.public_key.startsWith('{'), 'public_key should be JSON-encrypted in db')
  })

  it('retrieves trusted peer with decrypted public key', () => {
    const peer = db.getTrustedPeer('v-peer-1')
    assert.equal(peer.peer_name, 'VaultAlice')
    assert.equal(peer.public_key, 'vault-alice-pub-key')
  })

  it('lists vault peers with decrypted keys', () => {
    db.addTrustedPeer('v-peer-2', 'VaultBob', 'vault-bob-key')
    const list = db.listTrustedPeers()
    const bob = list.find((p) => p.peer_id === 'v-peer-2')
    assert(bob)
    assert.equal(bob.public_key, 'vault-bob-key')
  })

  it('isTrustedPeer works with vault', () => {
    assert.equal(db.isTrustedPeer('v-peer-1'), true)
    assert.equal(db.isTrustedPeer('nonexistent-vault'), false)
  })
})
