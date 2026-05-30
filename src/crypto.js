const crypto = require('crypto')

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const TAG_LENGTH = 16

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  return {
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64'),
  }
}

function deriveSharedSecret(myPrivateKeyB64, peerPublicKeyB64) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(myPrivateKeyB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(peerPublicKeyB64, 'base64'),
    format: 'der',
    type: 'spki',
  })
  const raw = crypto.diffieHellman({ privateKey, publicKey })

  return crypto.hkdfSync('sha256', raw, Buffer.alloc(32, 'openwifi'), 'openwifi-e2e', 32)
}

function encrypt(plaintext, sharedKey) {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, sharedKey, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  }
}

function decrypt(packet, sharedKey) {
  const iv = Buffer.from(packet.iv, 'base64')
  const tag = Buffer.from(packet.tag, 'base64')
  const ciphertext = Buffer.from(packet.ciphertext, 'base64')
  const decipher = crypto.createDecipheriv(ALGORITHM, sharedKey, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf-8')
}

function encryptBuffer(plaintextBuffer, sharedKey) {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, sharedKey, iv)
  const encrypted = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()])
  const tag = cipher.getAuthTag()
  return { iv, tag, ciphertext: encrypted }
}

function decryptBuffer(iv, tag, ciphertext, sharedKey) {
  const decipher = crypto.createDecipheriv(ALGORITHM, sharedKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function generatePIN() {
  return String(crypto.randomInt(100000, 1000000))
}

module.exports = { generateKeypair, deriveSharedSecret, encrypt, decrypt, encryptBuffer, decryptBuffer, generatePIN }
