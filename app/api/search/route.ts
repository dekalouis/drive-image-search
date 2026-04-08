import { type NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { ensurePgvectorExtension } from "@/lib/db-init"
import { generateTextEmbedding, normalizeTextForEmbedding } from "@/lib/gemini"
import { searchRateLimiter, getClientIdentifier, checkRateLimit, getRateLimitHeaders } from "@/lib/rate-limit"
import { validateFolderAccess } from "@/lib/folder-auth"
import { cleanCaption } from "@/lib/caption-utils"

const MAX_QUERY_LENGTH = 500

// Convert embedding array to pgvector format string
function toVectorString(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

// Search result type from raw SQL query
interface SearchResult {
  id: string
  fileId: string
  name: string
  thumbnailLink: string
  webViewLink: string
  caption: string | null
  similarity: number
}

export async function POST(request: NextRequest) {
  try {
    // Rate limiting
    const identifier = getClientIdentifier(request)
    const rateLimitResult = await checkRateLimit(searchRateLimiter, identifier)
    
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { 
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)
        },
        { 
          status: 429,
          headers: {
            ...getRateLimitHeaders(rateLimitResult, 60),
            'Retry-After': Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000).toString(),
          }
        }
      )
    }

    const { folderId, query, topK = 12, searchType } = await request.json()

    if (!folderId || !query) {
      return NextResponse.json({ error: "folderId and query are required" }, { status: 400 })
    }

    // Validate folder access (SEC-002)
    const { folder: folderRecord, hasAccess } = await validateFolderAccess(folderId)
    if (!folderRecord) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 })
    }
    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    if (typeof query !== "string" || query.trim().length === 0) {
      return NextResponse.json({ error: "Query must be a non-empty string" }, { status: 400 })
    }

    // Enforce maximum query length (ARCH-009)
    if (query.length > MAX_QUERY_LENGTH) {
      return NextResponse.json(
        { error: `Query must not exceed ${MAX_QUERY_LENGTH} characters` },
        { status: 400 }
      )
    }

    // Validate topK
    const maxResults = Math.min(Math.max(1, Number.parseInt(topK) || 12), 50)

    const trimmedQuery = query.trim()
    
    // Determine search type: use provided searchType or fallback to auto-detection
    let isFilenameSearch: boolean
    if (searchType === 'semantic') {
      isFilenameSearch = false
    } else if (searchType === 'filename') {
      isFilenameSearch = true
    } else {
      // Auto-detection: check if query looks like a filename search (contains file extension or is short)
      isFilenameSearch = trimmedQuery.includes('.') || trimmedQuery.length < 3
    }
    
    let results: SearchResult[] = []
    let searchTime = 0
    let embeddingTime = 0
    let fallbackMode = false
    
    if (isFilenameSearch) {
      // Filename search using SQL LIKE
      console.log(`🔍 Filename search: "${trimmedQuery}"`)
      const searchStart = Date.now()
      
      const searchPattern = `%${trimmedQuery}%`
      const startsWithPattern = `${trimmedQuery}%`
      
      results = await prisma.$queryRaw<SearchResult[]>`
        SELECT 
          id,
          "fileId",
          name,
          "thumbnailLink",
          "webViewLink",
          caption,
          CASE 
            WHEN LOWER(name) = LOWER(${trimmedQuery}) THEN 1.0
            WHEN LOWER(name) LIKE LOWER(${startsWithPattern}) THEN 0.8
            WHEN LOWER(name) LIKE LOWER(${searchPattern}) THEN 0.6
            ELSE 0.5
          END as similarity
        FROM images
        WHERE "folderId" = ${folderId}
          AND status = 'completed'
          AND LOWER(name) LIKE LOWER(${searchPattern})
        ORDER BY 
          CASE 
            WHEN LOWER(name) = LOWER(${trimmedQuery}) THEN 1
            WHEN LOWER(name) LIKE LOWER(${startsWithPattern}) THEN 2
            ELSE 3
          END,
          name
        LIMIT ${maxResults}
      `
      
      searchTime = Date.now() - searchStart
      console.log(`⏱️ Filename search: ${searchTime}ms (found ${results.length} results)`)
    } else {
      // Try semantic search, fallback to filename search if pgvector unavailable
      try {
        await ensurePgvectorExtension()
        
      // Semantic search using embeddings
      const normalizedQuery = normalizeTextForEmbedding(trimmedQuery)
      console.log(`🔍 Semantic search query: "${trimmedQuery}" -> normalized: "${normalizedQuery}"`)
      
      const startTime = Date.now()
      const queryEmbedding = await generateTextEmbedding(normalizedQuery, false, "RETRIEVAL_QUERY")
      embeddingTime = Date.now() - startTime
      console.log(`⏱️ Embedding generation: ${embeddingTime}ms`)

      // Convert embedding to pgvector format
      const vectorString = toVectorString(queryEmbedding)

      // Use pgvector SQL for fast similarity search
      // The <=> operator computes cosine distance (0 = identical, 2 = opposite)
      // We use 1 - distance to get similarity score (1 = identical, -1 = opposite)
      const searchStart = Date.now()
      results = await prisma.$queryRaw<SearchResult[]>`
        SELECT 
          id,
          "fileId",
          name,
          "thumbnailLink",
          "webViewLink",
          caption,
          1 - ("captionVec" <=> ${vectorString}::vector) as similarity
        FROM images
        WHERE "folderId" = ${folderId}
          AND status = 'completed'
          AND "captionVec" IS NOT NULL
        ORDER BY "captionVec" <=> ${vectorString}::vector
        LIMIT ${maxResults}
      `
      searchTime = Date.now() - searchStart
      console.log(`⏱️ pgvector search: ${searchTime}ms (found ${results.length} results)`)
      } catch (error) {
        // If pgvector is not available, fallback to filename search
        const errorMessage = error instanceof Error ? error.message : String(error)
        if (errorMessage.includes('pgvector') || errorMessage.includes('vector') || errorMessage.includes('extension')) {
          console.warn(`⚠️  pgvector not available, falling back to filename search: ${errorMessage}`)
          fallbackMode = true  // Set fallback flag
          
          // Fallback to filename search
          const searchPattern = `%${trimmedQuery}%`
          const startsWithPattern = `${trimmedQuery}%`
          const searchStart = Date.now()
          
          results = await prisma.$queryRaw<SearchResult[]>`
            SELECT 
              id,
              "fileId",
              name,
              "thumbnailLink",
              "webViewLink",
              caption,
              CASE 
                WHEN LOWER(name) = LOWER(${trimmedQuery}) THEN 1.0
                WHEN LOWER(name) LIKE LOWER(${startsWithPattern}) THEN 0.8
                WHEN LOWER(name) LIKE LOWER(${searchPattern}) THEN 0.6
                ELSE 0.5
              END as similarity
            FROM images
            WHERE "folderId" = ${folderId}
              AND status = 'completed'
              AND LOWER(name) LIKE LOWER(${searchPattern})
            ORDER BY 
              CASE 
                WHEN LOWER(name) = LOWER(${trimmedQuery}) THEN 1
                WHEN LOWER(name) LIKE LOWER(${startsWithPattern}) THEN 2
                ELSE 3
              END,
              name
            LIMIT ${maxResults}
          `
          searchTime = Date.now() - searchStart
          console.log(`⏱️ Filename search (fallback): ${searchTime}ms (found ${results.length} results)`)
        } else {
          // Re-throw non-pgvector errors
          throw error
        }
      }
    }

    // Format results with cleaned captions
    const formattedResults = results.map((result) => ({
      id: result.id,
      fileId: result.fileId,
      name: result.name,
      thumbnailLink: result.thumbnailLink,
      webViewLink: result.webViewLink,
      caption: cleanCaption(result.caption),
      similarity: Math.round(Number(result.similarity) * 1000) / 1000,
    }))

    // Get total count for stats
    const totalCount = await prisma.image.count({
      where: {
        folderId,
        status: "completed",
      },
    })

    return NextResponse.json({
      results: formattedResults,
      query: trimmedQuery,
      searchType: isFilenameSearch ? "filename" : "semantic",
      fallbackMode,
      totalCandidates: totalCount,
      timing: {
        embedding: embeddingTime,
        search: searchTime,
      },
    })
  } catch (error) {
    console.error("Search API error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
