const crypto = require('crypto')

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const PBKDF2_ITERATIONS = 200000
const PBKDF2_DIGEST = 'sha512'
const KEY_LENGTH = 32
const SALT_LENGTH = 32

class Vault {
  #key = null

  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
      throw new Error(`Vault key must be a ${KEY_LENGTH}-byte Buffer`)
    }
    this.#key = key
  }

  static generateSalt() {
    return crypto.randomBytes(SALT_LENGTH).toString('base64')
  }

  static fromPassphrase(passphrase, saltB64) {
    if (!passphrase || passphrase.length < 8) {
      throw new Error('Passphrase must be at least 8 characters')
    }
    if (!saltB64 || typeof saltB64 !== 'string') {
      throw new Error('Salt is required')
    }
    const salt = Buffer.from(saltB64, 'base64')
    if (salt.length !== SALT_LENGTH) {
      throw new Error(`Salt must be ${SALT_LENGTH} bytes`)
    }
    const key = crypto.pbkdf2Sync(
      passphrase,
      salt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      PBKDF2_DIGEST
    )
    return new Vault(key)
  }

  encrypt(plaintext) {
    if (typeof plaintext !== 'string') {
      throw new Error('Plaintext must be a string')
    }
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, this.#key, iv)
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return JSON.stringify({
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ct: encrypted.toString('base64'),
    })
  }

  decrypt(packet) {
    let parsed
    if (typeof packet === 'string') {
      parsed = JSON.parse(packet)
    } else if (packet && typeof packet === 'object') {
      parsed = packet
    } else {
      throw new Error('Invalid encrypted packet')
    }
    const iv = Buffer.from(parsed.iv, 'base64')
    const tag = Buffer.from(parsed.tag, 'base64')
    const ciphertext = Buffer.from(parsed.ct, 'base64')
    const decipher = crypto.createDecipheriv(ALGORITHM, this.#key, iv)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return decrypted.toString('utf-8')
  }

  seal(value) {
    return this.encrypt(JSON.stringify(value))
  }

  unseal(packet) {
    return JSON.parse(this.decrypt(packet))
  }

  isUnlocked() {
    return this.#key !== null
  }
}

module.exports = { Vault }
