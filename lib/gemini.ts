import { GoogleGenerativeAI } from "@google/generative-ai"
import sharp from "sharp"
import { getDownloadUrl, getAuthenticatedDownloadUrl, getDriveClient } from "@/lib/drive"

// Initialize Gemini AI client
function getGeminiClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY environment variable is required")
  }

  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
}

// Download image from Google Drive with retry logic and timeout protection
async function downloadWithRetry(fileId: string, maxRetries = 3, accessToken?: string): Promise<Buffer> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`⏬ Attempt ${attempt}/${maxRetries} downloading image: ${fileId}`)

      // Rate limit Google Drive requests
      await driveRateLimiter.waitIfNeeded()

      // If accessToken is provided, use authenticated download URL (always works if token valid)
      // Otherwise use public download URL
      const downloadUrl = accessToken ? getAuthenticatedDownloadUrl(fileId) : getDownloadUrl(fileId)

      // Create AbortController for timeout
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 30000) // 30 second timeout

      const headers: Record<string, string> = {
        "User-Agent": "Drive-Image-Searcher/1.0",
      }

      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`
      }

      const response = await fetch(downloadUrl, {
        headers,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)

      console.log(`✅ Successfully downloaded image: ${fileId} (${buffer.length} bytes)`)
      return buffer

    } catch (error: unknown) {
      const isLastAttempt = attempt === maxRetries
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'

      console.log(`❌ Download attempt ${attempt}/${maxRetries} failed for ${fileId}: ${errorMessage}`)

      if (isLastAttempt) {
        // Try alternative download URL on final attempt
        try {
          console.log(`🔄 Trying alternative download URL for ${fileId}`)

          // Rate limit the alternative request too
          await driveRateLimiter.waitIfNeeded()

          const alternativeUrl = getAuthenticatedDownloadUrl(fileId)

          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 30000)

          const headers: Record<string, string> = {
            "User-Agent": "Drive-Image-Searcher/1.0",
          }

          if (accessToken) {
            headers.Authorization = `Bearer ${accessToken}`
          }

          const response = await fetch(alternativeUrl, {
            headers,
            signal: controller.signal,
          })

          clearTimeout(timeoutId)

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`)
          }

          const arrayBuffer = await response.arrayBuffer()
          const buffer = Buffer.from(arrayBuffer)

          console.log(`✅ Alternative download successful for ${fileId} (${buffer.length} bytes)`)
          return buffer

        } catch (altError: unknown) {
          const altErrorMessage = altError instanceof Error ? altError.message : 'Unknown error'
          console.error(`💀 All download attempts failed for ${fileId}:`, altErrorMessage)
          throw new Error(`Failed to download image after ${maxRetries} attempts: ${errorMessage}`)
        }
      }

      // Exponential backoff: 2^attempt seconds + jitter
      const baseDelay = Math.pow(2, attempt) * 1000 // 2s, 4s, 8s
      const jitter = Math.random() * 1000 // 0-1s random jitter
      const delay = baseDelay + jitter

      console.log(`⏳ Waiting ${Math.round(delay)}ms before retry ${attempt + 1}/${maxRetries}`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  throw new Error(`Should never reach here`)
}

// Legacy function for backward compatibility
async function downloadImage(fileId: string, accessToken?: string): Promise<Buffer> {
  return downloadWithRetry(fileId, 3, accessToken)
}

// Resize image for AI processing to reduce token usage and improve speed
async function resizeImageForAI(imageBuffer: Buffer): Promise<Buffer> {
  try {
    const resizeStart = Date.now()
    
    // Use sharp to resize image to max 1024px on longest side while maintaining aspect ratio
    const resized = await sharp(imageBuffer)
      .resize(1024, 1024, {
        fit: 'inside', // Maintain aspect ratio, fit within 1024x1024
        withoutEnlargement: true // Don't upscale smaller images
      })
      .toFormat('jpeg', { quality: 80 }) // Use JPEG with 80% quality for best compression
      .toBuffer()
    
    const resizeTime = Date.now() - resizeStart
    const originalSize = imageBuffer.length
    const resizedSize = resized.length
    const savingsPercent = ((originalSize - resizedSize) / originalSize * 100).toFixed(1)
    
    console.log(`🖼️  Image resized in ${resizeTime}ms: ${originalSize} → ${resizedSize} bytes (${savingsPercent}% reduction)`)
    
    return resized
  } catch (error) {
    console.warn('Failed to resize image, using original:', error instanceof Error ? error.message : String(error))
    return imageBuffer
  }
}

// Optimized dense prompt for faster processing and better embeddings - targets 100-150 tokens output
const DENSE_CAPTION_PROMPT = `Describe this image in a single dense paragraph for search indexing.
Include: all subjects/objects with counts and colors, actions and interactions,
setting (indoor/outdoor, environment, lighting), visual style (photo/illustration/screenshot),
any readable text or logos exactly as written, and notable details.
End with a comma-separated keyword list of 10-15 search terms.
Be exhaustive but concise. 100-150 tokens max. Neutral language. Say "uncertain" if unsure.`

// Caption an image using Gemini 2.5 Flash with comprehensive analysis
export async function captionImage(
  fileId: string,
  mimeType: string,
  accessToken?: string
): Promise<{
  caption: string
}> {
  const genAI = getGeminiClient()
  // Use gemini-2.5-flash for best captioning quality
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" })

  try {
    // Download the image (prefer thumbnail for speed)
    const downloadStart = Date.now()
    // Download full image (best quality for detailed captions)
    const imageBuffer = await downloadImage(fileId, accessToken)
    const downloadTime = Date.now() - downloadStart
    console.log(`⏱️  Download time for ${fileId}: ${downloadTime}ms`)

    // Resize image for AI processing to reduce token usage and improve speed
    const resizedBuffer = await resizeImageForAI(imageBuffer)

    // Generate content with dense prompt
    const aiStart = Date.now()
    const result = await model.generateContent([
      DENSE_CAPTION_PROMPT,
      {
        inlineData: {
          data: resizedBuffer.toString("base64"),
          mimeType: "image/jpeg", // Always use JPEG after resize
        },
      },
    ])
    const aiTime = Date.now() - aiStart
    console.log(`⏱️  AI analysis time for ${fileId}: ${aiTime}ms`)

    const response = await result.response
    const text = response.text()

    // Parse flat text response and extract caption only
    try {
      const cleanedText = text.trim()
      const lines = cleanedText.split('\n').filter(line => line.trim().length > 0)

      if (lines.length === 0) {
        throw new Error("Empty response from AI")
      }

      // Entire response is the caption (including the last line which now just has keywords we'll ignore)
      const caption = cleanedText
        .split('\n')
        .slice(0, -1) // Remove last line (keyword list)
        .join(' ')
        .trim()

      // Ensure we have non-empty caption
      const finalCaption = caption.substring(0, 1500) || cleanedText.substring(0, 1500)

      console.log(`📝 Generated caption for ${fileId}: ${finalCaption.substring(0, 100)}...`)

      return { caption: finalCaption }
    } catch (parseError) {
      // Fallback: use raw text as caption
      console.warn("Failed to parse response, using fallback:", parseError)
      console.warn("Raw response (first 500 chars):", text.substring(0, 500))

      const fallbackCaption = text
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 500)

      return {
        caption: fallbackCaption || "Image content",
      }
    }
  } catch (error) {
    console.error("Gemini captioning error:", error)
    throw new Error(`Failed to caption image: ${error instanceof Error ? error.message : "Unknown error"}`)
  }
}

// Normalize text for consistent embedding and search matching
// This ensures case-insensitive matching and consistent whitespace handling
export function normalizeTextForEmbedding(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

// Embedding model: gemini-embedding-001 (text-embedding-004/005 deprecated). Output 768 to match DB column.
const EMBEDDING_MODEL = "gemini-embedding-001"
const EMBEDDING_OUTPUT_DIMENSION = 768

// Generate text embedding for search
export async function generateTextEmbedding(text: string, normalize: boolean = true): Promise<number[]> {
  const genAI = getGeminiClient()
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL })

  try {
    // Normalize text for consistent embedding matching
    const processedText = normalize ? normalizeTextForEmbedding(text) : text

    // outputDimensionality supported by gemini-embedding-001 (768 matches DB captionVec)
    const result = await model.embedContent(
      {
        content: { role: "user", parts: [{ text: processedText }] },
        outputDimensionality: EMBEDDING_OUTPUT_DIMENSION,
      } as unknown as Parameters<typeof model.embedContent>[0]
    )
    const embedding = result.embedding

    if (!embedding.values || embedding.values.length === 0) {
      throw new Error("Empty embedding returned")
    }

    return embedding.values
  } catch (error) {
    console.error("Embedding generation error:", error)
    throw new Error(`Failed to generate embedding: ${error instanceof Error ? error.message : "Unknown error"}`)
  }
}

// Generate embeddings for caption only
export async function generateCaptionEmbedding(caption: string): Promise<number[]> {
  // Use caption only for embedding
  return generateTextEmbedding(caption, true)
}

// Generate batch embeddings for multiple texts in a single API call
export async function generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return []
  }

  const genAI = getGeminiClient()
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL })

  try {
    const batchStart = Date.now()
    console.log(`📦 Generating batch embeddings for ${texts.length} texts`)

    // Check if SDK supports batchEmbedContents
    const modelWithBatch = model as unknown as { batchEmbedContents?: (config: unknown) => Promise<{ embeddings: Array<{ values: number[] }> }> }
    if (modelWithBatch.batchEmbedContents) {
      // Use batchEmbedContents if available (with outputDimensionality for gemini-embedding-001)
      const requests = texts.map(text => ({
        content: { role: "user", parts: [{ text: normalizeTextForEmbedding(text) }] },
        outputDimensionality: EMBEDDING_OUTPUT_DIMENSION,
      }))

      const batchResult = await modelWithBatch.batchEmbedContents({
        requests
      })

      const batchTime = Date.now() - batchStart
      console.log(`⏱️  Batch embedding time for ${texts.length} texts: ${batchTime}ms`)

      return batchResult.embeddings.map((embedding) => embedding.values)
    } else {
      // Fallback to Promise.all with individual calls if batch API not available
      console.log(`⚠️  Batch API not available, using Promise.all with individual calls`)
      const embeddings = await Promise.all(
        texts.map(text => generateTextEmbedding(text, true))
      )

      const batchTime = Date.now() - batchStart
      console.log(`⏱️  Promise.all embedding time for ${texts.length} texts: ${batchTime}ms`)

      return embeddings
    }
  } catch (error) {
    console.error("Batch embedding generation error:", error)
    throw new Error(`Failed to generate batch embeddings: ${error instanceof Error ? error.message : "Unknown error"}`)
  }
}

// Fast tags-only image analysis using Gemini (optimized for quick processing)
export async function extractImageTags(
  fileId: string,
  mimeType: string,
  useThumbnail: boolean = true
): Promise<{
  tags: string[]
  quickDescription?: string
}> {
  const genAI = getGeminiClient()
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" })

  // Retry configuration for network failures
  const maxRetries = 3
  const baseDelay = 2000 // 2 seconds

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🏷️  Extracting tags for ${fileId} (thumbnail: ${useThumbnail}) - Attempt ${attempt}/${maxRetries}`)

      // Rate limiting
      await geminiRateLimiter.waitIfNeeded()

      // Download image (thumbnail or full) with timeout
      const downloadStart = Date.now()
      const imageBuffer = useThumbnail
        ? await downloadThumbnail(fileId, 3)
        : await downloadWithRetry(fileId, 3)
      const downloadTime = Date.now() - downloadStart
      console.log(`⏱️  Download time for ${fileId}: ${downloadTime}ms`)

      // Convert buffer to base64 for Gemini
      const base64Image = imageBuffer.toString('base64')

      const prompt = `Analyze this image and extract 8-12 key visual tags for search indexing. Focus on:

- Main subjects (people, animals, objects)
- Actions and activities
- Setting and environment (indoor/outdoor, location type)
- Colors and visual style
- Any visible text, logos, or signs (OCR)
- Mood and atmosphere

Return ONLY a JSON object with this exact format:
{
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8"],
  "quickDescription": "Brief one-sentence description of the image"
}`

      const aiStart = Date.now()
      const result = await model.generateContent([
        {
          inlineData: {
            data: base64Image,
            mimeType: mimeType,
          },
        },
        prompt,
      ])
      const aiTime = Date.now() - aiStart

      const response = await result.response
      const text = response.text()
      console.log(`⏱️  AI processing time: ${aiTime}ms`)

      try {
        // Parse JSON response
        const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim())

        const tags = Array.isArray(parsed.tags) ? parsed.tags : []
        const quickDescription = parsed.quickDescription || `Image with tags: ${tags.slice(0, 3).join(', ')}`

        console.log(`🏷️  Generated tags for ${fileId}: [${tags.join(', ')}]`)

        return {
          tags,
          quickDescription
        }
      } catch {
        console.warn(`Failed to parse JSON response: ${text}`)
        // Fallback: extract tags from text
        const fallbackTags = text
          .split(',')
          .map(tag => tag.trim().replace(/[^\w\s]/g, ''))
          .filter(tag => tag.length > 0)
          .slice(0, 8)

        return {
          tags: fallbackTags.length > 0 ? fallbackTags : ['image', 'content'],
          quickDescription: `Image with content: ${fallbackTags.slice(0, 3).join(', ')}`
        }
      }
    } catch (error) {
      const isLastAttempt = attempt === maxRetries
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'

      console.error(`Fast tagging error (attempt ${attempt}/${maxRetries}):`, errorMessage)

      if (isLastAttempt) {
        console.error(`💀 All tagging attempts failed for ${fileId}:`, errorMessage)
        throw new Error(`Failed to extract tags: ${errorMessage}`)
      } else {
        // Exponential backoff with jitter
        const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000
        console.log(`⏳ Retrying in ${Math.round(delay)}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  }

  // This should never be reached due to the throw in the catch block
  throw new Error(`Failed to extract tags after ${maxRetries} attempts`)
}

// Download thumbnail image from Google Drive
async function downloadThumbnail(fileId: string, maxRetries = 3): Promise<Buffer> {
  // First, get the thumbnail URL from the API
  const drive = getDriveClient()

  try {
    const fileResponse = await drive.files.get({
      fileId: fileId,
      fields: "thumbnailLink"
    })

    // Request a large thumbnail (1024px)
    let thumbnailUrl = fileResponse.data.thumbnailLink
    if (thumbnailUrl) {
      // Modify URL to get a larger version if possible (s220 is default, change to s1024)
      thumbnailUrl = thumbnailUrl.replace(/=s\d+/, '=s1024')
    }

    if (!thumbnailUrl) {
      throw new Error("No thumbnail available, falling back to full image")
    }

    console.log(`📸 Downloading thumbnail: ${fileId}`)

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Rate limit Google Drive requests
        await driveRateLimiter.waitIfNeeded()

        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 15000) // Shorter timeout for thumbnails

        const response = await fetch(thumbnailUrl, {
          headers: {
            "User-Agent": "Drive-Image-Searcher/1.0",
          },
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        const arrayBuffer = await response.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)

        console.log(`✅ Successfully downloaded thumbnail: ${fileId} (${buffer.length} bytes)`)
        return buffer

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error'
        console.log(`❌ Thumbnail download attempt ${attempt}/${maxRetries} failed: ${errorMessage}`)

        if (attempt === maxRetries) {
          throw new Error(`Failed to download thumbnail after ${maxRetries} attempts`)
        }

        // Short backoff for thumbnails
        const delay = Math.pow(1.5, attempt) * 500 // 750ms, 1.1s, 1.7s
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }

    throw new Error("Should never reach here")

  } catch {
    console.warn(`Thumbnail not available for ${fileId}, falling back to full image`)
    return downloadWithRetry(fileId, maxRetries)
  }
}

// Rate limiting helper
class RateLimiter {
  private requests: number[] = []
  private readonly maxRequests: number
  private readonly windowMs: number

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests
    this.windowMs = windowMs
  }

  async waitIfNeeded(): Promise<void> {
    const now = Date.now()

    // Remove old requests outside the window
    this.requests = this.requests.filter((time) => now - time < this.windowMs)

    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = Math.min(...this.requests)
      const waitTime = this.windowMs - (now - oldestRequest)

      if (waitTime > 0) {
        console.log(`Rate limit reached, waiting ${waitTime}ms`)
        await new Promise((resolve) => setTimeout(resolve, waitTime))
      }
    }

    this.requests.push(now)
  }
}

// Rate limiters
// Global rate limiter: 4,000 requests per minute for Gemini
export const geminiRateLimiter = new RateLimiter(4000, 60 * 1000)

// Google Drive rate limiter: 10,000 requests per minute (buffer for 12,000 quota)
export const driveRateLimiter = new RateLimiter(10000, 60 * 1000)
