# Processing Speed & Semantic Search Improvement Guide

## Current Architecture Summary

Each image goes through this pipeline:

```
Download full image (Google Drive) -> Gemini 2.0 Flash Lite (caption) -> text-embedding-004 (768-dim vector) -> PostgreSQL + pgvector
```

**Per-image processing consists of 3 serial API calls:**

| Step | What happens | Typical latency |
|------|-------------|-----------------|
| 1. Download | Full-resolution image fetched from Google Drive via HTTP | 500-3000ms (size-dependent) |
| 2. Caption | Image bytes base64-encoded, sent to `gemini-2.0-flash-lite` with structured markdown prompt | 1500-4000ms |
| 3. Embed | Combined caption+tags string sent to `text-embedding-004` | 200-500ms |
| 4. DB write | Raw SQL UPDATE with `::vector` cast | 10-50ms |

**Total per image: ~2.5-7.5 seconds.** With batch-of-5 parallelism and worker concurrency of 3, effective throughput is roughly 12-30 images/minute depending on image sizes and API latency.

---

## Bottleneck Analysis

### 1. Image Download (the biggest variable)

Full-resolution images are downloaded every time (`downloadImage` -> `downloadWithRetry` in `gemini.ts:14-117`). A 4000x3000 JPEG from Google Drive can be 5-15 MB. This is the single most variable cost.

**Why we can't just use thumbnails (per project constraint):** Thumbnails are only used for display/storage links, not for the captioning pipeline. The project requires full images for storage and display. However, this does NOT mean the AI model needs the full-resolution bytes for captioning.

**Key insight:** Gemini 2.0 Flash Lite internally resizes images before processing. Sending a 12 MB photo vs a 1024px-wide version produces near-identical captions, but the 12 MB version costs 10x more download bandwidth and base64 encoding overhead.

### 2. The Structured Prompt (moderate impact)

The current `STRUCTURED_CAPTION_PROMPT` (`gemini.ts:125-140`) asks for 7 markdown sections targeting 120-200 output tokens. This is actually well-designed for token economy. The issue is NOT the output token count -- it's the structural overhead:

- **Markdown formatting wastes tokens.** Bold markers (`**`), numbered lists, and section headers consume ~30-40 tokens of the 120-200 budget on formatting alone, not semantic content.
- **Redundant extraction.** The prompt asks for "Search Keywords" as section 7, but then the code *also* extracts subjects from section 1 for tags (`gemini.ts:196-204`). The embedding model doesn't care about this separation -- it receives `caption + tags.join(" ")` as a flat string anyway (`gemini.ts:289`).
- **Post-processing overhead.** The response goes through regex parsing to strip markdown, extract keywords, deduplicate tags, and rebuild a clean string (`gemini.ts:186-221`). This is CPU work caused entirely by requesting markdown format.

**Does removing description/tags make it faster?** No, not meaningfully. The prompt already targets 120-200 output tokens. The generation time is dominated by:
1. Input processing (image understanding) -- fixed cost regardless of prompt
2. First-token latency -- fixed cost
3. Output token generation -- already minimal at 120-200 tokens

Removing sections would save maybe 30-50 output tokens (~50-100ms). Negligible.

### 3. The Embedding Step (small but serialized)

`generateCaptionEmbedding` (`gemini.ts:287-292`) concatenates caption + tags and sends to `text-embedding-004`. This is a separate API call per image, adding 200-500ms. This is sequential after captioning.

### 4. Batch Parallelism (well-configured but limited)

Current setup: batches of 5 images processed via `Promise.all` (`workers.ts:438`), with worker concurrency of 3. This means up to 15 images in-flight simultaneously. This is reasonable for Railway's memory constraints.

---

## Recommendations (Ordered by Impact)

### HIGH IMPACT: Resize Before Sending to Gemini

**Problem:** Full-resolution images (5-15 MB) are base64-encoded and sent to the API. Base64 encoding inflates size by ~33%. A 10 MB image becomes a 13.3 MB string in the API payload.

**Solution:** Resize the image to a max dimension of 1024px (or 1536px if higher fidelity is needed) BEFORE base64-encoding and sending to Gemini. Gemini's vision models internally resize anyway -- you're paying network and encoding cost for pixels the model discards.

**Expected gains:**
- Download time: reduced 60-80% (1024px JPEG is typically 100-300 KB vs 5-15 MB)
- Base64 encoding: reduced proportionally
- API upload: reduced proportionally
- Caption quality: negligible difference -- Gemini's image understanding operates on resized inputs internally

**Implementation notes:**
- Use `sharp` (already a common Node dependency) to resize the buffer in-memory before base64 encoding
- This does NOT affect the stored/displayed image -- only the bytes sent to the AI
- Maintain aspect ratio, target max 1024px on the longest side
- Apply JPEG compression at quality 80 for further size reduction

**This alone could cut per-image processing time by 40-60%.**

### HIGH IMPACT: Switch Prompt from Markdown to Plain Dense Text

**Problem:** The structured markdown prompt produces output the code immediately strips back to plain text. The markdown formatting (bold markers, numbered lists, section headers) wastes ~30-40 output tokens on syntax, and the regex post-processing (`gemini.ts:207-213`) is needed only because of the format choice.

**Solution:** Replace the 7-section markdown prompt with a single flat-text prompt optimized for embedding quality. The embedding model (`text-embedding-004`) doesn't benefit from markdown structure -- it benefits from dense, keyword-rich natural language.

**Proposed prompt direction:**

Instead of 7 labeled sections, ask for a single dense paragraph that covers the same ground:

```
Describe this image in a single dense paragraph for search indexing.
Include: all subjects/objects with counts and colors, actions and interactions,
setting (indoor/outdoor, environment, lighting), visual style (photo/illustration/screenshot),
any readable text or logos exactly as written, and notable details.
End with a comma-separated keyword list of 10-15 search terms.
Be exhaustive but concise. 100-150 tokens max. Neutral language. Say "uncertain" if unsure.
```

**Why this is better for search:**
- Every output token carries semantic content, not formatting
- The embedding model receives a denser signal per token
- No post-processing regex needed -- the output IS the caption
- Keywords at the end are easily split off by the last line
- Fewer output tokens requested = faster generation

**Expected gains:**
- 10-20% faster captioning (fewer output tokens, simpler generation)
- Better embedding quality (denser semantic signal per token)
- Simpler, more maintainable parsing code

### MEDIUM IMPACT: Batch Embedding Calls

**Problem:** Each image gets its own `text-embedding-004` API call (`workers.ts:320`). With 5 images per batch, that's 5 sequential embedding calls (the captioning is parallel via `Promise.all`, but each `processImage` awaits captioning then embedding sequentially).

**Solution:** The `text-embedding-004` API supports batch embedding (multiple texts in a single request). After all 5 captions in a batch are generated, collect them and make ONE embedding call for the batch.

**Expected gains:**
- Eliminate 4 out of 5 API round-trips per batch (save ~800-2000ms per batch)
- Reduced rate limiter pressure

**Implementation notes:**
- Split `processImage` into two phases: caption phase (parallel) and embed phase (batched)
- Use `model.batchEmbedContents()` from the Gemini SDK
- This requires restructuring the worker to collect caption results before embedding

### MEDIUM IMPACT: Stream Captioning + Embedding in Pipeline

**Problem:** Currently each image goes through Download -> Caption -> Embed -> DB Write sequentially. The next image in the batch starts only after all are done (via `Promise.all` at the batch level, but within each image it's sequential).

**Solution:** For each image, start the embedding call as soon as the caption is ready, while the next image's caption is still generating. This can be done by restructuring the batch processing as a pipeline:

```
Image 1: [Download] [Caption] [Embed]
Image 2:    [Download] [Caption] [Embed]
Image 3:       [Download] [Caption] [Embed]
```

Instead of:

```
Image 1: [Download] [Caption] [Embed]
Image 2: [Download] [Caption] [Embed]  (all start together, all end together)
Image 3: [Download] [Caption] [Embed]
```

The current `Promise.all` approach already parallelizes well. But combining this with batch embeddings (above) creates the real improvement.

### MEDIUM IMPACT: Pre-filter by Checksum/ETag

**Problem:** If a folder is re-synced, images that haven't changed still get re-processed. The code checks for `status: "pending"` (`workers.ts:162`), but if an image was already completed and gets reset, it goes through the full pipeline again.

**Solution:** Before processing, check `md5Checksum` and `etag` fields against stored values. Skip images that haven't changed since last successful processing.

**Expected gains:** Eliminates redundant processing on re-sync. Could save 100% of time for unchanged images.

### LOW IMPACT: Remove Separate Tag Extraction

**Problem:** The code extracts tags from two places: the "Search Keywords" section AND the "Subjects & Objects" section (`gemini.ts:186-204`). These tags are then joined with the caption for embedding (`gemini.ts:289`). But the caption already contains all this information.

**Solution:** With the flat-text prompt (recommended above), tags are the comma-separated keywords at the end. No separate extraction from other sections needed. The `tags` field in the database becomes the keyword list only, and the `caption` field holds the dense description.

**Why this doesn't hurt search:** The embedding is generated from `caption + tags` concatenated. If the caption already contains "two golden retrievers on a red sofa" and the tags include "golden-retriever, sofa, red", the embedding gets slightly redundant signal -- which doesn't improve cosine similarity matching. Dense, non-redundant text produces sharper embeddings.

### LOW IMPACT: Increase Batch Size (with caution)

**Problem:** Current batch size is 5 (`workers.ts:184`). With worker concurrency of 3, that's 15 concurrent images max.

**Solution:** Increase batch size to 8-10 if memory allows. The Gemini rate limit is 4000 req/min, so there's headroom.

**Caution:** Railway memory limits may not support this. Profile memory usage first.

---

## What NOT to Do

### Do NOT remove the caption entirely
The caption is the primary input for embedding generation. Without it, you'd need to embed raw image pixels directly (requires a different model like CLIP), and you'd lose the OCR/text-awareness that makes the current search powerful.

### Do NOT remove tags entirely
Tags provide focused keyword signal that improves embedding quality for specific-term searches. A search for "golden retriever" matches better when "golden-retriever" is in the embedded text explicitly.

### Do NOT use thumbnail-only processing
Per project constraint. But also: thumbnails may lose readable text (OCR), fine details, and small objects that make search results accurate.

### Do NOT switch to a larger model for "better captions"
`gemini-2.0-flash-lite` is the right choice. Larger models (Flash, Pro) would 3-10x the captioning latency for marginal quality improvement that the 768-dim embedding can't even represent.

### Do NOT add more output sections to the prompt
More sections = more formatting overhead = slower generation = worse embedding signal density. Go in the opposite direction.

---

## Projected Impact Summary

| Change | Speed Improvement | Search Quality Impact | Effort |
|--------|------------------|-----------------------|--------|
| Resize images before Gemini | 40-60% faster | Negligible loss | Low |
| Flat-text prompt (replace markdown) | 10-20% faster | Moderate improvement | Low |
| Batch embedding calls | 15-25% faster per batch | No change | Medium |
| Pipeline processing | 10-15% faster | No change | Medium |
| ETag-based skip on re-sync | 100% skip for unchanged | No change | Low |
| Remove redundant tag extraction | <5% faster | Slight improvement | Low |

**Combined realistic improvement: 50-70% reduction in per-image processing time**, bringing throughput from ~12-30 images/minute to ~30-70 images/minute with the same infrastructure.

---

## Priority Execution Order

1. **Resize images before sending to Gemini** -- highest ROI, lowest risk
2. **Switch to flat-text prompt** -- improves both speed and search quality
3. **Batch embedding API calls** -- eliminates redundant network round-trips
4. **ETag-based deduplication** -- prevents wasted reprocessing
5. **Pipeline restructuring** -- architectural improvement for sustained throughput
