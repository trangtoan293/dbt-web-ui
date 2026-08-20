import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

const PREFIX = 'v1:gcm:'

class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretCryptoError'
  }
}

function key(): Buffer {
  const material = process.env.APP_ENCRYPTION_KEY
  if (!material) throw new SecretCryptoError('APP_ENCRYPTION_KEY is required for encrypted secrets')
  return createHash('sha256').update(material, 'utf8').digest()
}

export function encryptSecret(secret: string): string {
  if (!secret) throw new SecretCryptoError('Cannot encrypt an empty secret')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64')}:${Buffer.concat([encrypted, tag]).toString('base64')}`
}

export function decryptSecret(value: string | null | undefined): string {
  if (!value) return ''
  if (!value.startsWith(PREFIX)) {
    return value
  }

  const [, , ivB64, payloadB64] = value.split(':')
  if (!ivB64 || !payloadB64) throw new SecretCryptoError('Encrypted secret has invalid format')

  const payload = Buffer.from(payloadB64, 'base64')
  if (payload.length < 17) throw new SecretCryptoError('Encrypted secret payload is invalid')

  const encrypted = payload.subarray(0, -16)
  const tag = payload.subarray(-16)
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}
