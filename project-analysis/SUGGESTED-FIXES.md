# Suggested Fixes

This document provides concrete code changes to address the identified issues.

---

## Fix 1: Store Access Token in Folder Record

### Schema Change
```prisma
// prisma/schema.prisma
model Folder {
  id              String   @id @default(cuid())
  folderId        String   @unique
  name            String?
  folderUrl       String
  status          String
  totalImages     Int      @default(0)
  processedImages Int      @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  images          Image[]
  userId          String?
  user            User?    @relation(fields: [userId], references: [id])
  
  // NEW: Store encrypted access token for background processing
  accessTokenEncrypted String?
  tokenExpiresAt       DateTime?

  @@index([userId])
  @@map("folders")
}
```

### Update Ingest Route
```typescript
// app/api/ingest/route.ts - After getting token

import { encrypt } from '@/lib/encryption'

// ... existing code ...

// When creating folder:
const folder = await prisma.folder.create({
  data: {
    folderId,
    name: result.folderName,
    folderUrl,
    status: "pending",
    totalImages: supportedImages.length,
    userId: dbUserId,
    // NEW: Store encrypted token
    accessTokenEncrypted: token ? encrypt(token) : null,
    tokenExpiresAt: token ? new Date(Date.now() + 55 * 60 * 1000) : null, // ~55 min
  },
})
```

### Create Encryption Helper
```typescript
// lib/encryption.ts
import crypto from 'crypto'

const ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex')
const IV_LENGTH = 16

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv)
  let encrypted = cipher.update(text)
  encrypted = Buffer.concat([encrypted, cipher.final()])
  return iv.toString('hex') + ':' + encrypted.toString('hex')
}

export function decrypt(text: string): string {
  const [ivHex, encryptedHex] = text.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const encrypted = Buffer.from(encryptedHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv)
  let decrypted = decipher.update(encrypted)
  decrypted = Buffer.concat([decrypted, decipher.final()])
  return decrypted.toString()
}
```

---

## Fix 2: Update Worker Recovery to Use Stored Token

```typescript
// scripts/start-workers.ts

import { decrypt } from '@/lib/encryption'

async function recoverPendingImages() {
  // ... existing code ...

  for (const folder of foldersWithPending) {
    if (folder.images.length === 0) continue

    // NEW: Get stored token
    let accessToken: string | undefined = undefined
    if (folder.accessTokenEncrypted && folder.tokenExpiresAt) {
      if (new Date() < folder.tokenExpiresAt) {
        try {
          accessToken = decrypt(folder.accessTokenEncrypted)
          console.log(`🔑 Using stored token for folder ${folder.folderId}`)
        } catch (e) {
          console.warn(`⚠️ Failed to decrypt token for folder ${folder.folderId}`)
        }
      } else {
        console.warn(`⚠️ Token expired for folder ${folder.folderId}`)
      }
    }

    // Queue with token
    await queueImageBatch({
      images: batchData,
      folderId: folder.id,
      accessToken  // Now properly set!
    })
  }
}
```

---

## Fix 3: Update Retry API to Get/Use Token

```typescript
// app/api/retry-image/route.ts

import { auth } from "@clerk/nextjs/server"
import { clerkClient } from "@clerk/nextjs/server"
import { decrypt } from '@/lib/encryption'

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth()
    
    // Try to get current user's token
    let accessToken: string | undefined = undefined
    if (userId) {
      try {
        const client = await clerkClient()
        const tokenResponse = await client.users.getUserOauthAccessToken(userId, 'google')
        if (tokenResponse?.data?.[0]?.token) {
          accessToken = tokenResponse.data[0].token
        }
      } catch (e) {
        console.log("No OAuth token from current user")
      }
    }

    // ... existing code for getting folder ...

    // If no token from current user, try stored token
    if (!accessToken && folder.accessTokenEncrypted && folder.tokenExpiresAt) {
      if (new Date() < folder.tokenExpiresAt) {
        try {
          accessToken = decrypt(folder.accessTokenEncrypted)
          console.log(`🔑 Using stored token for retry`)
        } catch (e) {
          console.warn(`⚠️ Failed to decrypt stored token`)
        }
      }
    }

    // Queue with token
    await queueImageBatch({
      images: batchData,
      folderId: folder.id,
      accessToken  // Now properly passed!
    })

    // ... rest of existing code ...
  }
}
```

---

## Fix 4: Add Folder Ownership Validation

```typescript
// lib/auth.ts (new file)

import { prisma } from '@/lib/prisma'
import { auth } from '@clerk/nextjs/server'

export async function validateFolderAccess(folderId: string): Promise<{
  folder: any
  userId: string | null
  hasAccess: boolean
}> {
  const { userId: clerkUserId } = await auth()
  
  // Get user's DB id
  let dbUserId: string | null = null
  if (clerkUserId) {
    const user = await prisma.user.findUnique({
      where: { clerkId: clerkUserId }
    })
    dbUserId = user?.id || null
  }

  const folder = await prisma.folder.findUnique({
    where: { id: folderId }
  })

  if (!folder) {
    return { folder: null, userId: dbUserId, hasAccess: false }
  }

  // Allow access if:
  // 1. Folder has no owner (public/anonymous)
  // 2. Current user is the owner
  const hasAccess = !folder.userId || folder.userId === dbUserId

  return { folder, userId: dbUserId, hasAccess }
}
```

### Usage in Sync Route
```typescript
// app/api/sync/route.ts

import { validateFolderAccess } from '@/lib/auth'

export async function POST(request: NextRequest) {
  try {
    const { folderId } = await request.json()

    const { folder, hasAccess } = await validateFolderAccess(folderId)

    if (!folder) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 })
    }

    if (!hasAccess) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 })
    }

    // ... rest of existing code ...
  }
}
```

---

## Fix 5: Fix Completion Status Logic

```typescript
// lib/workers.ts - Update updateFolderProgress function

async function updateFolderProgress(folderId: string) {
  const [totalImages, processedImages, failedImages] = await Promise.all([
    prisma.image.count({
      where: { folderId },
    }),
    prisma.image.count({
      where: { folderId, status: "completed" },
    }),
    prisma.image.count({
      where: { folderId, status: "failed" },
    }),
  ])

  // Determine status based on processed + failed vs total
  let status: string
  if (processedImages + failedImages === totalImages) {
    // All images have been attempted
    status = failedImages > 0 ? "completed_with_errors" : "completed"
  } else {
    status = "processing"
  }

  await prisma.folder.update({
    where: { id: folderId },
    data: {
      processedImages,
      status,
    },
  })
}
```

---

## Fix 6: Add Status Constants

```typescript
// lib/constants.ts (new file)

export const FolderStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  COMPLETED_WITH_ERRORS: 'completed_with_errors',
  FAILED: 'failed',
} as const

export type FolderStatusType = typeof FolderStatus[keyof typeof FolderStatus]

export const ImageStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const

export type ImageStatusType = typeof ImageStatus[keyof typeof ImageStatus]

export const SUPPORTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml'
] as const
```

---

## Fix 7: Environment Variable for Image Limit

```typescript
// components/url-form.tsx - Update the hardcoded limit

// Replace:
<p>
  <span className="font-semibold text-foreground">Image limit:</span> Folders with up to 1,000 images are supported.
</p>

// With:
<p>
  <span className="font-semibold text-foreground">Image limit:</span> Folders with up to {process.env.NEXT_PUBLIC_MAX_IMAGES_PER_FOLDER || '200'} images are supported.
</p>
```

And add to `.env.example`:
```env
NEXT_PUBLIC_MAX_IMAGES_PER_FOLDER=200
```

---

## Migration Required

After implementing Fix 1, run:
```bash
npx prisma migrate dev --name add_token_storage
```

Add to `.env`:
```env
# Generate with: openssl rand -hex 32
TOKEN_ENCRYPTION_KEY=your-32-byte-hex-key-here
```
