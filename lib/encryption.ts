import crypto from 'crypto'

const ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY
const IV_LENGTH = 12 // 12 bytes is standard for AES-256-GCM

/**
 * Encrypt a string using AES-256-GCM (SEC-003)
 * @param text The text to encrypt
 * @returns Encrypted string in format: iv_hex:authTag_hex:ciphertext_hex (3 parts)
 */
export function encrypt(text: string): string {
  if (!ENCRYPTION_KEY) {
    throw new Error('TOKEN_ENCRYPTION_KEY environment variable is not set')
  }

  if (ENCRYPTION_KEY.length !== 64) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex characters)')
  }

  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv)
  let encrypted = cipher.update(text, 'utf8')
  encrypted = Buffer.concat([encrypted, cipher.final()])
  const authTag = cipher.getAuthTag()

  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex')
}

/**
 * Decrypt a string encrypted with AES-256-GCM (SEC-003)
 * @param encryptedText The encrypted string in format: iv_hex:authTag_hex:ciphertext_hex
 * @returns The decrypted text
 */
export function decrypt(encryptedText: string): string {
  if (!ENCRYPTION_KEY) {
    throw new Error('TOKEN_ENCRYPTION_KEY environment variable is not set')
  }

  if (ENCRYPTION_KEY.length !== 64) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex characters)')
  }

  const parts = encryptedText.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format. Expected: iv:authTag:ciphertext')
  }

  const [ivHex, authTagHex, encryptedHex] = parts
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const encrypted = Buffer.from(encryptedHex, 'hex')

  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), iv)
  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(encrypted)
  decrypted = Buffer.concat([decrypted, decipher.final()])
  return decrypted.toString('utf8')
}

/**
 * Check if a token has expired or is about to expire
 * @param expiresAt Token expiration timestamp
 * @param bufferMinutes Buffer time before expiry to consider token expired (default: 5 minutes)
 * @returns true if token is expired or about to expire
 */
export function isTokenExpired(expiresAt: Date | null, bufferMinutes: number = 5): boolean {
  if (!expiresAt) return true
  const bufferMs = bufferMinutes * 60 * 1000
  return new Date() >= new Date(expiresAt.getTime() - bufferMs)
}
