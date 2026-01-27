import crypto from 'crypto'

const ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY
const IV_LENGTH = 16

/**
 * Encrypt a string using AES-256-CBC
 * @param text The text to encrypt
 * @returns Encrypted string in format: iv:encryptedData (both as hex)
 */
export function encrypt(text: string): string {
  if (!ENCRYPTION_KEY) {
    throw new Error('TOKEN_ENCRYPTION_KEY environment variable is not set')
  }

  // Validate key is 32 bytes (64 hex characters)
  if (ENCRYPTION_KEY.length !== 64) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex characters)')
  }

  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv)
  let encrypted = cipher.update(text)
  encrypted = Buffer.concat([encrypted, cipher.final()])
  return iv.toString('hex') + ':' + encrypted.toString('hex')
}

/**
 * Decrypt a string encrypted with AES-256-CBC
 * @param encryptedText The encrypted string in format: iv:encryptedData (both as hex)
 * @returns The decrypted text
 */
export function decrypt(encryptedText: string): string {
  if (!ENCRYPTION_KEY) {
    throw new Error('TOKEN_ENCRYPTION_KEY environment variable is not set')
  }

  // Validate key is 32 bytes (64 hex characters)
  if (ENCRYPTION_KEY.length !== 64) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex characters)')
  }

  const [ivHex, encryptedHex] = encryptedText.split(':')
  if (!ivHex || !encryptedHex) {
    throw new Error('Invalid encrypted text format. Expected: iv:encryptedData')
  }

  const iv = Buffer.from(ivHex, 'hex')
  const encrypted = Buffer.from(encryptedHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv)
  let decrypted = decipher.update(encrypted)
  decrypted = Buffer.concat([decrypted, decipher.final()])
  return decrypted.toString()
}
