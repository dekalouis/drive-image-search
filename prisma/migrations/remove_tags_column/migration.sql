-- Remove tags column from images table
-- This column is no longer used in the application
ALTER TABLE "images" DROP COLUMN IF EXISTS "tags";
