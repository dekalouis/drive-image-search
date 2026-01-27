-- AlterTable
ALTER TABLE "folders" ADD COLUMN "accessTokenEncrypted" TEXT,
ADD COLUMN "tokenExpiresAt" TIMESTAMP(3);
