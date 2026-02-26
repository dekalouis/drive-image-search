/**
 * Shared caption cleaning utility (ARCH-012)
 * Single source of truth — previously duplicated across search, images, and image-card.
 */

/**
 * Clean a raw caption string returned by Gemini.
 * Handles HTML-encoded JSON, markdown code blocks, and JSON objects.
 */
export function cleanCaption(caption?: string | null): string | null {
  if (!caption) return null

  let cleaned = caption

  // Decode HTML entities
  if (cleaned.includes('&quot;')) {
    cleaned = cleaned.replace(/&quot;/g, '"')
  }

  // Strip markdown code fences
  if (cleaned.startsWith('```json') && cleaned.endsWith('```')) {
    cleaned = cleaned.replace(/^```json\n/, '').replace(/\n```$/, '')
  }

  // Extract from JSON object if the model returned structured output
  if (cleaned.includes('"caption"')) {
    try {
      const parsed = JSON.parse(cleaned)
      return parsed.caption || caption
    } catch {
      return caption
    }
  }

  return cleaned
}
