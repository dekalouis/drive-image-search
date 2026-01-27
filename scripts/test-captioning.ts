import { captionImage, generateCaptionEmbedding } from "../lib/gemini"

async function main() {
  const fileId = process.argv[2]
  const mimeType = process.argv[3] || "image/jpeg"

  if (!fileId) {
    console.error("Usage: tsx scripts/test-captioning.ts <fileId> [mimeType]")
    process.exit(1)
  }

  try {
    console.log(`Testing captioning for file: ${fileId}`)
    console.log(`MIME type: ${mimeType}`)

    const result = await captionImage(fileId, mimeType)
    console.log("\nCaption:", result.caption)

    console.log("\nGenerating embedding...")
    const embedding = await generateCaptionEmbedding(result.caption)
    console.log(`Embedding dimensions: ${embedding.length}`)
    console.log(`First 5 values: [${embedding.slice(0, 5).join(", ")}]`)

    console.log("\nTest completed successfully!")
  } catch (error) {
    console.error("Test failed:", error)
    process.exit(1)
  }
}

main()
