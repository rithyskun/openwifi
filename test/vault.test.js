const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Vault } = require('../src/vault')

describe('Vault.generateSalt', () => {
  it('returns a base64 string', () => {
    const salt = Vault.generateSalt()
    assert(typeof salt === 'string')
    assert(salt.length > 0)
  })

  it('produces different salts on each call', () => {
    const a = Vault.generateSalt()
    const b = Vault.generateSalt()
    assert.notEqual(a, b)
  })
})

describe('Vault.fromPassphrase', () => {
  it('creates a Vault with a valid passphrase and salt', () => {
    const salt = Vault.generateSalt()
    const vault = Vault.fromPassphrase('my-secure-passphrase', salt)
    assert(vault instanceof Vault)
    assert(vault.isUnlocked())
  })

  it('throws on passphrase shorter than 8 chars', () => {
    const salt = Vault.generateSalt()
    assert.throws(() => Vault.fromPassphrase('short', salt))
  })

  it('throws on missing salt', () => {
    assert.throws(() => Vault.fromPassphrase('my-secure-passphrase'))
  })

  it('throws on empty passphrase', () => {
    const salt = Vault.generateSalt()
    assert.throws(() => Vault.fromPassphrase('', salt))
  })

  it('throws on invalid salt base64', () => {
    assert.throws(() => Vault.fromPassphrase('my-secure-passphrase', 'not-valid-base64!!'))
  })

  it('produces compatible keys from same passphrase and salt', () => {
    const salt = Vault.generateSalt()
    const a = Vault.fromPassphrase('my-strong-passphrase', salt)
    const b = Vault.fromPassphrase('my-strong-passphrase', salt)
    const encrypted = a.encrypt('test message')
    assert.equal(b.decrypt(encrypted), 'test message')
  })

  it('produces different keys from different passphrases', () => {
    const salt = Vault.generateSalt()
    const a = Vault.fromPassphrase('passphrase-one-123', salt)
    const b = Vault.fromPassphrase('passphrase-two-456', salt)
    const msg = 'test'
    assert.notEqual(a.encrypt(msg), b.encrypt(msg))
  })
})

describe('Vault.encrypt / decrypt', () => {
  it('encrypt returns a JSON string with iv, tag, ct', () => {
    const vault = Vault.fromPassphrase('my-test-passphrase-ok', Vault.generateSalt())
    const result = vault.encrypt('hello')
    assert(typeof result === 'string')
    const parsed = JSON.parse(result)
    assert(typeof parsed.iv === 'string')
    assert(typeof parsed.tag === 'string')
    assert(typeof parsed.ct === 'string')
  })

  it('encrypt then decrypt returns original', () => {
    const vault = Vault.fromPassphrase('my-test-passphrase-ok', Vault.generateSalt())
    const original = 'Hello, OpenWiFi Vault!'
    const encrypted = vault.encrypt(original)
    const decrypted = vault.decrypt(encrypted)
    assert.equal(decrypted, original)
  })

  it('handles empty string', () => {
    const vault = Vault.fromPassphrase('my-test-passphrase-ok', Vault.generateSalt())
    assert.equal(vault.decrypt(vault.encrypt('')), '')
  })

  it('handles long strings', () => {
    const vault = Vault.fromPassphrase('my-test-passphrase-ok', Vault.generateSalt())
    const original = 'A'.repeat(50000)
    assert.equal(vault.decrypt(vault.encrypt(original)), original)
  })

  it('handles unicode', () => {
    const vault = Vault.fromPassphrase('my-test-passphrase-ok', Vault.generateSalt())
    const original = 'Hello 你好 ñoño 🎉🔐'
    assert.equal(vault.decrypt(vault.encrypt(original)), original)
  })

  it('throws decrypting with wrong passphrase', () => {
    const salt = Vault.generateSalt()
    const a = Vault.fromPassphrase('correct-passphrase-here', salt)
    const b = Vault.fromPassphrase('wrong-passphrase-there', salt)
    const encrypted = a.encrypt('secret data')
    assert.throws(() => b.decrypt(encrypted))
  })

  it('fails on tampered ciphertext', () => {
    const vault = Vault.fromPassphrase('my-test-passphrase-ok', Vault.generateSalt())
    const encrypted = JSON.parse(vault.encrypt('tamper test'))
    encrypted.ct = Buffer.from(
      Buffer.from(encrypted.ct, 'base64').map((b) => b ^ 0xff)
    ).toString('base64')
    assert.throws(() => vault.decrypt(JSON.stringify(encrypted)))
  })

  it('fails on tampered IV', () => {
    const vault = Vault.fromPassphrase('my-test-passphrase-ok', Vault.generateSalt())
    const encrypted = JSON.parse(vault.encrypt('tamper iv'))
    encrypted.iv = Buffer.from(
      Buffer.from(encrypted.iv, 'base64').map((b) => b ^ 0x01)
    ).toString('base64')
    assert.throws(() => vault.decrypt(JSON.stringify(encrypted)))
  })

  it('fails on tampered auth tag', () => {
    const vault = Vault.fromPassphrase('my-test-passphrase-ok', Vault.generateSalt())
    const encrypted = JSON.parse(vault.encrypt('tamper tag'))
    encrypted.tag = Buffer.from(
      Buffer.from(encrypted.tag, 'base64').map((b) => b ^ 0x01)
    ).toString('base64')
    assert.throws(() => vault.decrypt(JSON.stringify(encrypted)))
  })

  it('produces different ciphertext each call (unique IV)', () => {
    const vault = Vault.fromPassphrase('my-test-passphrase-ok', Vault.generateSalt())
    const results = new Set()
    for (let i = 0; i < 50; i++) {
      results.add(vault.encrypt('same message'))
    }
    assert.equal(results.size, 50)
  })
})

describe('Vault.seal / unseal', () => {
  it('seals and unseals an object', () => {
    const vault = Vault.fromPassphrase('my-test-passphrase-ok', Vault.generateSalt())
    const obj = { id: 'abc123', name: 'Alice', roles: ['admin', 'user'] }
    const sealed = vault.seal(obj)
    assert(typeof sealed === 'string')
    const unsealed = vault.unseal(sealed)
    assert.deepEqual(unsealed, obj)
  })

  it('seals and unseals an array', () => {
    const vault = Vault.fromPassphrase('my-test-passphrase-ok', Vault.generateSalt())
    const arr = [1, 'two', { three: 3 }]
    assert.deepEqual(vault.unseal(vault.seal(arr)), arr)
  })

  it('seals and unseals a number', () => {
    const vault = Vault.fromPassphrase('my-test-passphrase-ok', Vault.generateSalt())
    assert.equal(vault.unseal(vault.seal(42)), 42)
  })

  it('seals and unseals null', () => {
    const vault = Vault.fromPassphrase('my-test-passphrase-ok', Vault.generateSalt())
    assert.equal(vault.unseal(vault.seal(null)), null)
  })
})

describe('Vault.isUnlocked', () => {
  it('returns true after construction', () => {
    const vault = Vault.fromPassphrase('my-test-passphrase-ok', Vault.generateSalt())
    assert(vault.isUnlocked())
  })
})

describe('Vault cross-session compatibility', () => {
  it('same passphrase + salt produces decryptable data across instances', () => {
    const salt = Vault.generateSalt()

    const v1 = Vault.fromPassphrase('cross-session-key', salt)
    const encrypted = v1.encrypt('persistent data')

    const v2 = Vault.fromPassphrase('cross-session-key', salt)
    assert.equal(v2.decrypt(encrypted), 'persistent data')
  })

  it('decrypt fails with different passphrase (same salt)', () => {
    const salt = Vault.generateSalt()
    const v1 = Vault.fromPassphrase('real-passphrase-long', salt)
    const v2 = Vault.fromPassphrase('wrong-passphrase-yep', salt)
    assert.throws(() => v2.decrypt(v1.encrypt('secret')))
  })
})
