-- pgvector Setup Script for Drive Image Searcher
-- Run this after database reset to enable vector search

-- 1. Enable pgvector extension (required for vector operations)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Verify extension is installed
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';

-- 3. Create HNSW index for fast approximate nearest neighbor search
-- This index significantly speeds up similarity queries (10-100x faster)
-- Run this AFTER you have some data in the images table
CREATE INDEX IF NOT EXISTS images_caption_vec_idx 
ON images USING hnsw ("captionVec" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Index parameters:
-- m = 16: Number of connections per layer (higher = more accurate, slower build)
-- ef_construction = 64: Size of dynamic candidate list during construction

-- 4. Example similarity search query (for reference):
-- SELECT id, name, caption, 
--        1 - ("captionVec" <=> query_vector::vector) as similarity
-- FROM images
-- WHERE "folderId" = 'your_folder_id' 
--   AND status = 'completed'
--   AND "captionVec" IS NOT NULL
-- ORDER BY "captionVec" <=> query_vector::vector
-- LIMIT 10;

-- Note: The <=> operator computes cosine distance (0 = identical, 2 = opposite)
-- We use 1 - distance to get similarity (1 = identical, -1 = opposite)


