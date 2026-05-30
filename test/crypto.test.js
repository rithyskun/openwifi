const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  generateKeypair,
  deriveSharedSecret,
  encrypt,
  decrypt,
  encryptBuffer,
  decryptBuffer,
  generatePIN,
} = require('../src/crypto')

describe('generateKeypair', () => {
  it('returns publicKey and privateKey as base64 strings', () => {
    const kp = generateKeypair()
    assert(typeof kp.publicKey === 'string')
    assert(typeof kp.privateKey === 'string')
    assert(kp.publicKey.length > 0)
    assert(kp.privateKey.length > 0)
  })

  it('produces different keys on each call', () => {
    const a = generateKeypair()
    const b = generateKeypair()
    assert.notEqual(a.publicKey, b.publicKey)
    assert.notEqual(a.privateKey, b.privateKey)
  })

  it('produces valid X25519 SPKI/DER public key', () => {
    const kp = generateKeypair()
    const buf = Buffer.from(kp.publicKey, 'base64')
    assert(buf[0] === 0x30, 'expected DER sequence tag')
  })

  it('produces valid X25519 PKCS8/DER private key', () => {
    const kp = generateKeypair()
    const buf = Buffer.from(kp.privateKey, 'base64')
    assert(buf[0] === 0x30, 'expected DER sequence tag')
  })
})

describe('deriveSharedSecret', () => {
  function toHex(secret) {
    return Buffer.from(secret).toString('hex')
  }

  it('derives identical secret for both peers', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()

    const aliceSecret = deriveSharedSecret(alice.privateKey, bob.publicKey)
    const bobSecret = deriveSharedSecret(bob.privateKey, alice.publicKey)

    assert.equal(Buffer.from(aliceSecret).length, 32)
    assert.equal(toHex(aliceSecret), toHex(bobSecret))
  })

  it('derives different secret with a different peer', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()
    const carol = generateKeypair()

    const aliceBob = deriveSharedSecret(alice.privateKey, bob.publicKey)
    const aliceCarol = deriveSharedSecret(alice.privateKey, carol.publicKey)

    assert.notEqual(toHex(aliceBob), toHex(aliceCarol))
  })

  it('derives deterministic secret for same keypair pair', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()

    const s1 = deriveSharedSecret(alice.privateKey, bob.publicKey)
    const s2 = deriveSharedSecret(alice.privateKey, bob.publicKey)

    assert.equal(toHex(s1), toHex(s2))
  })

  it('throws on invalid private key', () => {
    assert.throws(() => {
      deriveSharedSecret('invalid-base64!!', generateKeypair().publicKey)
    })
  })

  it('throws on invalid public key', () => {
    assert.throws(() => {
      deriveSharedSecret(generateKeypair().privateKey, 'invalid-base64!!')
    })
  })
})

describe('encrypt / decrypt', () => {
  const alice = generateKeypair()
  const bob = generateKeypair()
  const sharedKey = deriveSharedSecret(alice.privateKey, bob.publicKey)

  it('encrypt returns iv, tag, and ciphertext as base64 strings', () => {
    const result = encrypt('hello', sharedKey)
    assert(typeof result.iv === 'string')
    assert(typeof result.tag === 'string')
    assert(typeof result.ciphertext === 'string')
    assert(result.iv.length > 0)
    assert(result.tag.length > 0)
    assert(result.ciphertext.length > 0)
  })

  it('encrypt then decrypt returns original plaintext', () => {
    const plaintext = 'Hello, OpenWiFi!'
    const encrypted = encrypt(plaintext, sharedKey)
    const decrypted = decrypt(encrypted, sharedKey)
    assert.equal(decrypted, plaintext)
  })

  it('handles empty string', () => {
    const encrypted = encrypt('', sharedKey)
    const decrypted = decrypt(encrypted, sharedKey)
    assert.equal(decrypted, '')
  })

  it('handles long messages', () => {
    const plaintext = 'A'.repeat(10000)
    const encrypted = encrypt(plaintext, sharedKey)
    const decrypted = decrypt(encrypted, sharedKey)
    assert.equal(decrypted, plaintext)
  })

  it('handles unicode characters', () => {
    const plaintext = 'Hello 你好 ñoño 🎉🔥'
    const encrypted = encrypt(plaintext, sharedKey)
    const decrypted = decrypt(encrypted, sharedKey)
    assert.equal(decrypted, plaintext)
  })

  it('handles JSON strings', () => {
    const obj = { type: 'chat', payload: { text: 'hello' }, ttl: 5 }
    const plaintext = JSON.stringify(obj)
    const encrypted = encrypt(plaintext, sharedKey)
    const decrypted = decrypt(encrypted, sharedKey)
    assert.equal(decrypted, plaintext)
    assert.deepEqual(JSON.parse(decrypted), obj)
  })

  it('produces different ciphertext for same plaintext (no IV reuse)', () => {
    const plaintext = 'same message'
    const e1 = encrypt(plaintext, sharedKey)
    const e2 = encrypt(plaintext, sharedKey)
    assert.notEqual(e1.iv, e2.iv)
    assert.notEqual(e1.ciphertext, e2.ciphertext)
  })

  it('fails decryption with wrong key', () => {
    const eavesdropper = generateKeypair()
    const wrongKey = deriveSharedSecret(eavesdropper.privateKey, generateKeypair().publicKey)
    const encrypted = encrypt('secret message', sharedKey)
    assert.throws(() => decrypt(encrypted, wrongKey))
  })

  it('fails decryption with tampered ciphertext', () => {
    const encrypted = encrypt('tamper test', sharedKey)
    const tampered = {
      ...encrypted,
      ciphertext: Buffer.from(
        Buffer.from(encrypted.ciphertext, 'base64').map((b) => b ^ 0xff).toString('base64')
      ).toString('base64'),
    }
    assert.throws(() => decrypt(tampered, sharedKey))
  })

  it('fails decryption with tampered IV', () => {
    const encrypted = encrypt('tamper iv test', sharedKey)
    const tampered = {
      ...encrypted,
      iv: Buffer.from(
        Buffer.from(encrypted.iv, 'base64').map((b) => b ^ 0x01)
      ).toString('base64'),
    }
    assert.throws(() => decrypt(tampered, sharedKey))
  })

  it('fails decryption with tampered auth tag', () => {
    const encrypted = encrypt('tamper tag test', sharedKey)
    const tampered = {
      ...encrypted,
      tag: Buffer.from(
        Buffer.from(encrypted.tag, 'base64').map((b) => b ^ 0x01)
      ).toString('base64'),
    }
    assert.throws(() => decrypt(tampered, sharedKey))
  })

  it('fails decryption with truncated ciphertext', () => {
    const encrypted = encrypt('truncation test', sharedKey)
    const ct = Buffer.from(encrypted.ciphertext, 'base64').slice(0, -4)
    const tampered = { ...encrypted, ciphertext: ct.toString('base64') }
    assert.throws(() => decrypt(tampered, sharedKey))
  })

  it('fails decryption with empty ciphertext', () => {
    const tampered = { iv: 'AAAAAAAAAAAAAAAAAAAAAA==', tag: 'AAAAAAAAAAAAAAAAAAAAAA==', ciphertext: '' }
    assert.throws(() => decrypt(tampered, sharedKey))
  })

  it('produces unique IV for every encryption call', () => {
    const ivs = new Set()
    for (let i = 0; i < 100; i++) {
      const encrypted = encrypt(`msg-${i}`, sharedKey)
      ivs.add(encrypted.iv)
    }
    assert.equal(ivs.size, 100)
  })
})

describe('encrypt / decrypt with multiple keypairs', () => {
  it('alice-bob and alice-carol use different encryption keys', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()
    const carol = generateKeypair()

    const abKey = deriveSharedSecret(alice.privateKey, bob.publicKey)
    const acKey = deriveSharedSecret(alice.privateKey, carol.publicKey)

    const msg = 'private message'
    const abEnc = encrypt(msg, abKey)
    const acEnc = encrypt(msg, acKey)

    assert.equal(decrypt(abEnc, abKey), msg)
    assert.equal(decrypt(acEnc, acKey), msg)

    assert.throws(() => decrypt(abEnc, acKey))
    assert.throws(() => decrypt(acEnc, abKey))
  })
})

describe('Bidirectional encryption', () => {
  it('both directions produce identical shared keys', () => {
    const alice = generateKeypair()
    const bob = generateKeypair()

    const aliceToBob = deriveSharedSecret(alice.privateKey, bob.publicKey)
    const bobToAlice = deriveSharedSecret(bob.privateKey, alice.publicKey)

    assert.equal(Buffer.from(aliceToBob).toString('hex'), Buffer.from(bobToAlice).toString('hex'))

    const msg = 'bidirectional test'
    const encrypted = encrypt(msg, aliceToBob)
    assert.equal(decrypt(encrypted, bobToAlice), msg)
  })
})

describe('encryptBuffer / decryptBuffer', () => {
  const alice = generateKeypair()
  const bob = generateKeypair()
  const sharedKey = deriveSharedSecret(alice.privateKey, bob.publicKey)

  it('encryptBuffer returns raw Buffer iv, tag, and ciphertext', () => {
    const result = encryptBuffer(Buffer.from('hello binary'), sharedKey)
    assert(Buffer.isBuffer(result.iv))
    assert(Buffer.isBuffer(result.tag))
    assert(Buffer.isBuffer(result.ciphertext))
    assert.equal(result.iv.length, 16)
    assert.equal(result.tag.length, 16)
    assert(result.ciphertext.length > 0)
  })

  it('encryptBuffer then decryptBuffer returns original plaintext Buffer', () => {
    const plaintext = Buffer.from('Hello, Binary OpenWiFi!')
    const encrypted = encryptBuffer(plaintext, sharedKey)
    const decrypted = decryptBuffer(encrypted.iv, encrypted.tag, encrypted.ciphertext, sharedKey)
    assert.equal(decrypted.toString('utf-8'), plaintext.toString('utf-8'))
  })

  it('handles large binary payload', () => {
    const plaintext = Buffer.from('A'.repeat(500000))
    const encrypted = encryptBuffer(plaintext, sharedKey)
    const decrypted = decryptBuffer(encrypted.iv, encrypted.tag, encrypted.ciphertext, sharedKey)
    assert.equal(decrypted.length, plaintext.length)
    assert.equal(decrypted.toString('utf-8'), plaintext.toString('utf-8'))
  })

  it('fails decryption with wrong key', () => {
    const eavesdropper = generateKeypair()
    const wrongKey = deriveSharedSecret(eavesdropper.privateKey, generateKeypair().publicKey)
    const encrypted = encryptBuffer(Buffer.from('secret'), sharedKey)
    assert.throws(() => decryptBuffer(encrypted.iv, encrypted.tag, encrypted.ciphertext, wrongKey))
  })

  it('fails decryption with tampered ciphertext', () => {
    const encrypted = encryptBuffer(Buffer.from('tamper test'), sharedKey)
    const tampered = Buffer.from(encrypted.ciphertext.map((b) => b ^ 0xff))
    assert.throws(() => decryptBuffer(encrypted.iv, encrypted.tag, tampered, sharedKey))
  })

  it('produces different ciphertext for same plaintext (no IV reuse)', () => {
    const plaintext = Buffer.from('same binary message')
    const e1 = encryptBuffer(plaintext, sharedKey)
    const e2 = encryptBuffer(plaintext, sharedKey)
    assert.notEqual(e1.iv.toString('hex'), e2.iv.toString('hex'))
    assert.notEqual(e1.ciphertext.toString('hex'), e2.ciphertext.toString('hex'))
  })

  it('interoperates with encrypt/decrypt base64 format', () => {
    const plaintext = 'json message here'
    const b64Enc = encrypt(plaintext, sharedKey)
    const b64Dec = decrypt(b64Enc, sharedKey)
    assert.equal(b64Dec, plaintext)

    const binEnc = encryptBuffer(Buffer.from(plaintext, 'utf-8'), sharedKey)
    const binDec = decryptBuffer(binEnc.iv, binEnc.tag, binEnc.ciphertext, sharedKey)
    assert.equal(binDec.toString('utf-8'), plaintext)
  })
})

describe('generatePIN', () => {
  it('returns a 6-digit string', () => {
    const pin = generatePIN()
    assert(typeof pin === 'string')
    assert.equal(pin.length, 6)
    assert(/^\d{6}$/.test(pin))
  })

  it('produces varied PINs across calls', () => {
    const pins = new Set()
    for (let i = 0; i < 100; i++) {
      pins.add(generatePIN())
    }
    assert(pins.size > 90)
  })

  it('produces PINs in range 100000-999999', () => {
    for (let i = 0; i < 50; i++) {
      const pin = parseInt(generatePIN(), 10)
      assert(pin >= 100000 && pin <= 999999)
    }
  })
})
