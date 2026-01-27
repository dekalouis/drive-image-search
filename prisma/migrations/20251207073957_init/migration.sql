-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "clerkId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folders" (
    "id" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "name" TEXT,
    "folderUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "totalImages" INTEGER NOT NULL DEFAULT 0,
    "processedImages" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "images" (
    "id" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "thumbnailLink" TEXT NOT NULL,
    "webViewLink" TEXT NOT NULL,
    "downloadUrl" TEXT,
    "size" INTEGER,
    "md5Checksum" TEXT,
    "modifiedTime" TIMESTAMP(3),
    "etag" TEXT,
    "status" TEXT NOT NULL,
    "caption" TEXT,
    "tags" TEXT,
    "captionVec" vector(768),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drive_folders" (
    "id" TEXT NOT NULL,
    "driveFolderId" TEXT NOT NULL,
    "folderName" TEXT NOT NULL,
    "driveUrl" TEXT NOT NULL,
    "referenceCount" INTEGER NOT NULL DEFAULT 0,
    "lastScanned" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drive_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folder_scans" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "driveFolderId" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "folder_scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_clerkId_key" ON "users"("clerkId");

-- CreateIndex
CREATE UNIQUE INDEX "folders_folderId_key" ON "folders"("folderId");

-- CreateIndex
CREATE INDEX "folders_userId_idx" ON "folders"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "images_fileId_key" ON "images"("fileId");

-- CreateIndex
CREATE INDEX "images_folderId_idx" ON "images"("folderId");

-- CreateIndex
CREATE UNIQUE INDEX "drive_folders_driveFolderId_key" ON "drive_folders"("driveFolderId");

-- CreateIndex
CREATE INDEX "drive_folders_driveFolderId_idx" ON "drive_folders"("driveFolderId");

-- CreateIndex
CREATE INDEX "folder_scans_userId_idx" ON "folder_scans"("userId");

-- CreateIndex
CREATE INDEX "folder_scans_driveFolderId_idx" ON "folder_scans"("driveFolderId");

-- CreateIndex
CREATE INDEX "folder_scans_deletedAt_idx" ON "folder_scans"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "folder_scans_userId_driveFolderId_key" ON "folder_scans"("userId", "driveFolderId");

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "images" ADD CONSTRAINT "images_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folder_scans" ADD CONSTRAINT "folder_scans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folder_scans" ADD CONSTRAINT "folder_scans_driveFolderId_fkey" FOREIGN KEY ("driveFolderId") REFERENCES "drive_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX IF NOT EXISTS images_caption_vec_idx ON "images" USING hnsw ("captionVec" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
