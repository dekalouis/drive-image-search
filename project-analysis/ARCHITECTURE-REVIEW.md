# Architecture Review

## Overview

The application is a Google Drive image searcher with AI-powered captioning using:
- **Frontend:** Next.js 15 with App Router
- **Backend:** Next.js API Routes
- **Database:** PostgreSQL with pgvector
- **Queue:** BullMQ with Redis
- **AI:** Google Gemini for captioning and embeddings
- **Auth:** Clerk for authentication

---

## Component Diagram

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Next.js App   │────▶│  API Routes      │────▶│   PostgreSQL    │
│   (Frontend)    │     │  /api/*          │     │   + pgvector    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │                          ▲
                               ▼                          │
                        ┌──────────────────┐              │
                        │     Redis        │              │
                        │   (BullMQ)       │              │
                        └──────────────────┘              │
                               │                          │
                               ▼                          │
                        ┌──────────────────┐              │
                        │  Workers         │──────────────┘
                        │  (Background)    │
                        └──────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │  Google APIs     │
                        │  Drive + Gemini  │
                        └──────────────────┘
```

---

## Data Flow

### 1. Folder Ingestion
```
User submits URL
       │
       ▼
/api/ingest extracts folder ID
       │
       ▼
Get OAuth token from Clerk (if logged in)
       │
       ▼
List images from Google Drive (with token or API key)
       │
       ▼
Create Folder + Image records in DB
       │
       ▼
Queue folder processing job (FolderJobData includes accessToken)
```

### 2. Image Processing
```
Folder Worker picks up job
       │
       ▼
Query DB for pending images
       │
       ▼
Create batches of 5 images
       │
       ▼
Queue batch jobs (ImageBatchJobData includes accessToken)
       │
       ▼
Image Worker picks up batch
       │
       ▼
For each image:
  - Download from Drive (using accessToken or API key)
  - Send to Gemini for captioning
  - Generate embedding
  - Store in DB with vector
```

---

## Authentication Flow

```
┌─────────────────────────────────────────────────────────┐
│                     Clerk Auth Flow                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. User signs in with Google (Clerk SSO)               │
│                      │                                  │
│                      ▼                                  │
│  2. Clerk stores OAuth tokens                           │
│                      │                                  │
│                      ▼                                  │
│  3. API calls getUserOauthAccessToken()                 │
│                      │                                  │
│                      ▼                                  │
│  4. Token used for Drive API calls                      │
│                                                         │
│  ⚠️ PROBLEM: Workers can't call Clerk APIs!             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Database Schema

### Core Tables

| Table | Purpose |
|-------|---------|
| `users` | Clerk user mapping |
| `folders` | Google Drive folder metadata |
| `images` | Image metadata + captions + vectors |
| `drive_folders` | Deduplication (not fully implemented) |
| `folder_scans` | User-folder relationships |

### Key Fields on `images`

| Field | Type | Purpose |
|-------|------|---------|
| `captionVec` | `vector(768)` | Gemini embedding for semantic search |
| `caption` | `text` | AI-generated description |
| `tags` | `text` | Comma-separated keywords |
| `status` | `text` | pending/processing/completed/failed |

---

## Queue Architecture

### Queues

| Queue | Jobs | Concurrency |
|-------|------|-------------|
| `folders` | `process` | 2 |
| `images` | `caption`, `batch-caption` | 3 |

### Job Data Structures

```typescript
interface FolderJobData {
  folderId: string        // DB ID
  googleFolderId: string  // Drive folder ID
  accessToken?: string    // OAuth token (may be undefined!)
}

interface ImageBatchJobData {
  images: Array<{
    imageId: string
    fileId: string
    etag: string
    folderId: string
    mimeType: string
    name: string
  }>
  folderId: string
  accessToken?: string    // OAuth token (may be undefined!)
}
```

---

## Identified Architecture Issues

### 1. Token Persistence Gap

**Problem:** OAuth tokens are passed through job queue but not persisted.

```
Request Time          Queue Time           Processing Time
     │                    │                      │
     ▼                    ▼                      ▼
[Get Token] ────▶ [Store in Job] ────▶ [Use Token]
                          │
                    ┌─────┴─────┐
                    │  PROBLEM  │
                    │ Worker    │
                    │ Restart   │
                    │ = Token   │
                    │ Lost!     │
                    └───────────┘
```

### 2. No Token Refresh

**Current Flow:**
```
Token obtained (expires in ~1 hour)
       │
       ▼
Jobs queued (could take hours for large folders)
       │
       ▼
Token expires mid-processing ─────▶ Jobs fail!
```

### 3. Worker-API Isolation

**Problem:** Workers run as separate processes without HTTP context.

```
┌─────────────────┐          ┌─────────────────┐
│  Next.js API    │          │  Worker Process │
│                 │          │                 │
│  - Has Clerk    │          │  - No Clerk     │
│    session      │          │    session      │
│  - Can get      │          │  - Cannot get   │
│    OAuth token  │          │    OAuth token  │
└─────────────────┘          └─────────────────┘
```

---

## Recommendations

### Short-term Fixes

1. **Store tokens in database** (encrypted)
   ```prisma
   model Folder {
     // ... existing fields
     oauthToken      String?   // Encrypted token
     tokenExpiresAt  DateTime?
   }
   ```

2. **Token in retry API**
   - Get current user's token before retry
   - Only allow retry if user is folder owner

3. **Validate folder ownership**
   - Check `userId` on folder before operations

### Long-term Architecture

1. **Service Account Approach**
   - Use Google service account for Drive access
   - User grants service account access to folders
   - Eliminates token refresh issues

2. **Separate Auth Service**
   - Dedicated service for token management
   - Background token refresh
   - Encrypted token storage

3. **Event-Driven Processing**
   - Replace polling with webhooks/SSE
   - Real-time progress updates
   - Better error handling
