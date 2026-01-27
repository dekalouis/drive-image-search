import { prisma } from "@/lib/prisma"

let pgvectorReady: Promise<void> | null = null
let captionVecIndexReady: Promise<void> | null = null
let pgvectorCheckDone = false
let pgvectorAvailable = false

/**
 * Checks if pgvector extension is available in the database.
 * Returns true if available, false otherwise.
 */
async function checkPgvectorAvailability(): Promise<boolean> {
  try {
    const result = await prisma.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `
    return result.length > 0
  } catch (error: any) {
    // If the query fails, pgvector is likely not installed
    if (error?.code === 'P2010' || error?.message?.includes('vector')) {
      return false
    }
    throw error
  }
}

/**
 * Ensures the pgvector extension is available. We memoize the promise so the
 * extension check only runs once per process even if multiple callers request it.
 * 
 * For Railway: If pgvector is not available, you need to either:
 * 1. Use Railway's pgvector-enabled PostgreSQL template: https://railway.com/deploy/pgvector-pg18
 * 2. Or enable it manually via Railway's SQL console: CREATE EXTENSION vector;
 */
export function ensurePgvectorExtension() {
  if (!pgvectorReady) {
    pgvectorReady = (async () => {
      // First check if extension already exists
      if (!pgvectorCheckDone) {
        pgvectorAvailable = await checkPgvectorAvailability()
        pgvectorCheckDone = true
      }

      if (pgvectorAvailable) {
        console.log("✅ pgvector extension already enabled")
        return
      }

      // Try to create the extension
      try {
        await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`)
        pgvectorAvailable = true
        console.log("✅ pgvector extension enabled successfully")
      } catch (error: any) {
        const errorMessage = error?.message || String(error)
        
        // Check if it's the "extension not available" error
        if (errorMessage.includes('extension "vector" is not available') || 
            errorMessage.includes('Could not open extension control file')) {
          const railwayGuide = `
╔═══════════════════════════════════════════════════════════════════════════╗
║                    pgvector Extension Not Available                       ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  Your PostgreSQL database does not have pgvector installed.              ║
║                                                                           ║
║  For Railway PostgreSQL:                                                  ║
║                                                                           ║
║  Option 1 (Recommended): Use Railway's pgvector template                 ║
║  → Deploy: https://railway.com/deploy/pgvector-pg18                       ║
║  → Or: https://railway.com/deploy/pgvector-pg17                          ║
║                                                                           ║
║  Option 2: Enable manually via Railway SQL Console                       ║
║  1. Go to your Railway PostgreSQL service                                 ║
║  2. Open the "Query" tab                                                  ║
║  3. Run: CREATE EXTENSION vector;                                        ║
║                                                                           ║
║  Option 3: Reset database with pgvector template                        ║
║  → Create new PostgreSQL service using pgvector template                ║
║  → Update DATABASE_URL                                                    ║
║  → Run migrations: npx prisma migrate deploy                              ║
║                                                                           ║
╚═══════════════════════════════════════════════════════════════════════════╝
          `
          console.error(railwayGuide)
          throw new Error(
            `pgvector extension is not available on this PostgreSQL instance. ` +
            `Please enable it using one of the methods above. ` +
            `See error details: ${errorMessage}`
          )
        }
        
        // Re-throw other errors
        console.error("❌ Failed to enable pgvector extension:", error)
        throw error
      }
    })()
  }

  return pgvectorReady
}

/**
 * Ensures the caption vector index exists before we start writing embeddings.
 */
export async function ensureCaptionVectorIndex() {
  await ensurePgvectorExtension()

  if (!captionVecIndexReady) {
    captionVecIndexReady = prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS images_caption_vec_idx 
      ON "images" USING hnsw ("captionVec" vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `)
      .then(() => {
        console.log("✅ images_caption_vec_idx ready")
      })
      .catch((error) => {
        console.error("❌ Failed to ensure caption vector index:", error)
        throw error
      })
  }

  return captionVecIndexReady
}
