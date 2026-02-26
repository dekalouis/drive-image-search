import { google, drive_v3 } from "googleapis"

// Type for Drive file metadata
export type DriveFile = drive_v3.Schema$File

// Initialize Google Drive API client
export function getDriveClient(oauthToken?: string) {
  // If OAuth token is provided, use it for authenticated access (private folders)
  if (oauthToken) {
    // For OAuth tokens from Clerk, we can use them directly
    // The token should already have the necessary scopes (drive.readonly or drive)
    const oauth2Client = new google.auth.OAuth2()
    oauth2Client.setCredentials({ 
      access_token: oauthToken,
      // Note: We don't need client_id/secret for token-only auth
      // The token from Clerk should already be valid
    })
    
    // Set token expiry to prevent refresh attempts (Clerk manages token lifecycle)
    oauth2Client.on('tokens', (tokens) => {
      if (tokens.refresh_token) {
        // Store refresh token if provided (though Clerk usually handles this)
        oauth2Client.setCredentials({
          ...oauth2Client.credentials,
          refresh_token: tokens.refresh_token,
        })
      }
    })
    
    return google.drive({
      version: "v3",
      auth: oauth2Client,
    })
  }

  // Otherwise, use API key for public folder access
  if (!process.env.GOOGLE_DRIVE_API_KEY) {
    throw new Error("GOOGLE_DRIVE_API_KEY environment variable is required")
  }

  return google.drive({
    version: "v3",
    auth: process.env.GOOGLE_DRIVE_API_KEY,
  })
}

/**
 * Extract folder ID from various Google Drive URL formats
 */
export function extractFolderId(folderUrl: string): string | null {
  try {
    const url = new URL(folderUrl)

    // Handle different URL formats:
    // https://drive.google.com/drive/folders/FOLDER_ID
    // https://drive.google.com/drive/u/0/folders/FOLDER_ID
    // https://drive.google.com/open?id=FOLDER_ID

    if (url.pathname.includes("/folders/")) {
      const match = url.pathname.match(/\/folders\/([a-zA-Z0-9-_]+)/)
      return match ? match[1] : null
    }

    if (url.searchParams.has("id")) {
      return url.searchParams.get("id")
    }

    return null
  } catch {
    return null
  }
}

/**
 * Validate that a folder is publicly accessible and list its images
 */
export async function validateAndListImages(folderId: string) {
  const drive = getDriveClient()

  try {
    // First, try to get folder metadata to validate access
    const folderResponse = await drive.files.get({
      fileId: folderId,
      fields: "id,name,mimeType",
    })

    const folderName = folderResponse.data.name || null

    // List all images in the folder
    const response = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: "files(id,name,mimeType,thumbnailLink,webViewLink,size,md5Checksum,modifiedTime,version)",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: 1000,
    })

    return {
      success: true,
      folderName,
      images: response.data.files || [],
      count: response.data.files?.length || 0,
    }
  } catch (error: unknown) {
    console.error("Drive API error:", error)

    if (error && typeof error === 'object' && 'code' in error) {
      const driveError = error as { code: number; message?: string }
      if (driveError.code === 403 || driveError.code === 404) {
        return {
          success: false,
          folderName: null,
          error: "The folder isn't publicly accessible. Please set sharing to 'Anyone with the link' (viewer) and try again.",
          images: [],
          count: 0,
        }
      }
    }

    return {
      success: false,
      folderName: null,
      error: "Failed to access the folder. Please check the URL and try again.",
      images: [],
      count: 0,
    }
  }
}

/**
 * Get download URL for a Drive file
 */
export function getDownloadUrl(fileId: string): string {
  return `https://drive.google.com/uc?export=download&id=${fileId}`
}

/**
 * Get alternative download URL with authentication
 */
export function getAuthenticatedDownloadUrl(fileId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${process.env.GOOGLE_DRIVE_API_KEY}`
}

/**
 * Get fresh thumbnail URL for a file from Google Drive API
 * @param fileId - The Google Drive file ID
 * @param size - Optional thumbnail size (default 220px)
 * @param oauthToken - Optional OAuth token for accessing private files
 * @returns Fresh thumbnail URL or null if not available
 */
export async function getFreshThumbnailUrl(
  fileId: string, 
  size: number = 220,
  oauthToken?: string
): Promise<string | null> {
  const drive = getDriveClient(oauthToken)
  
  if (oauthToken) {
    console.log(`🔑 Using OAuth token to get thumbnail for file ${fileId.substring(0, 10)}...`)
  } else {
    console.log(`🔑 Using API key to get thumbnail for file ${fileId.substring(0, 10)}...`)
  }

  try {
    const response = await drive.files.get({
      fileId,
      fields: "thumbnailLink",
    })

    const thumbnailLink = response.data.thumbnailLink
    if (!thumbnailLink) {
      return null
    }

    // Modify the thumbnail size if needed (default is s220)
    // Google Drive thumbnail URLs end with =sXXX where XXX is the size
    if (size !== 220) {
      return thumbnailLink.replace(/=s\d+$/, `=s${size}`)
    }

    return thumbnailLink
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorCode = (error as any)?.code || (error as any)?.status || 'unknown'
    console.error(`❌ Failed to get thumbnail for file ${fileId.substring(0, 10)}...: ${errorMessage} (code: ${errorCode})`)
    if (oauthToken) {
      console.error(`   Note: OAuth token was provided but request still failed`)
    }
    return null
  }
}

/**
 * Recursively list all images in a folder and its subfolders
 * @param folderId - The Google Drive folder ID
 * @param oauthToken - Optional OAuth token for accessing private folders
 */
export async function listImagesRecursively(
  folderId: string,
  oauthToken?: string
): Promise<{
  success: boolean
  folderName: string | null
  images: DriveFile[]
  count: number
  error?: string
}> {
  const allImages: DriveFile[] = []

  try {
    // If an OAuth token is provided but is missing Drive scopes / belongs to a different Google user,
    // Google Drive can return 403 even for PUBLIC folders. For public folders, API key access should work.
    //
    // Strategy:
    // - Try OAuth if provided
    // - On 403, retry once using API key (public access)
    const tryList = async (mode: "oauth" | "apiKey") => {
      const drive = mode === "oauth" ? getDriveClient(oauthToken) : getDriveClient()

      // Get folder metadata
      const folderResponse = await drive.files.get({
        fileId: folderId,
        fields: "id,name,mimeType",
      })
      const folderName = folderResponse.data.name || null

      // Depth and file limits for recursive scan (ARCH-005)
      const MAX_DEPTH = 10
      const MAX_FILES = 1000

      // Helper function to recursively scan folders
      async function scanFolder(currentFolderId: string, depth = 0, nextPageToken?: string): Promise<void> {
        // Enforce depth limit
        if (depth > MAX_DEPTH) {
          console.warn(`⚠️  Max folder depth (${MAX_DEPTH}) reached, stopping recursion`)
          return
        }

        // Enforce file count limit
        if (allImages.length >= MAX_FILES) {
          console.warn(`⚠️  Max file limit (${MAX_FILES}) reached, stopping scan`)
          return
        }

        // Only process Gemini-supported image MIME types
        // Gemini 2.5 Flash supports: JPEG, PNG, GIF, WebP, BMP, SVG
        // Does NOT support: AVIF, HEIC, HEIF, TIFF, etc.
        const supportedImageTypes = [
          "image/jpeg",
          "image/png",
          "image/gif",
          "image/webp",
          "image/bmp",
          "image/svg+xml",
        ]

        // List all files (images and folders) in current folder
        // Filter for supported image types OR folders
        const response = await drive.files.list({
          q: `'${currentFolderId}' in parents and trashed=false and (mimeType = 'application/vnd.google-apps.folder' or ${supportedImageTypes.map((type) => `mimeType='${type}'`).join(" or ")})`,
          fields:
            "nextPageToken,files(id,name,mimeType,thumbnailLink,webViewLink,size,md5Checksum,modifiedTime,version)",
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          pageSize: 1000,
          pageToken: nextPageToken,
        })

        const files = response.data.files || []

        for (const file of files) {
          // Stop if we've hit the file limit
          if (allImages.length >= MAX_FILES) {
            console.warn(`⚠️  Max file limit (${MAX_FILES}) reached mid-scan, stopping`)
            return
          }

          // Only add supported image types (already filtered by query, but double-check)
          if (file.mimeType && supportedImageTypes.includes(file.mimeType)) {
            allImages.push(file)
          } else if (file.mimeType === "application/vnd.google-apps.folder" && file.id) {
            // It's a subfolder - recursively scan it
            console.log(`📂 Scanning subfolder: ${file.name} (depth: ${depth + 1})`)
            await scanFolder(file.id, depth + 1)
          }
        }

        // Handle pagination (only if under limits)
        if (response.data.nextPageToken && allImages.length < MAX_FILES) {
          await scanFolder(currentFolderId, depth, response.data.nextPageToken)
        }
      }

      // Start recursive scan from root folder
      console.log(
        `🔍 Starting recursive scan of folder: ${folderName}${mode === "oauth" ? " (oauth)" : " (apiKey)"}`
      )
      await scanFolder(folderId)
      console.log(`✅ Found ${allImages.length} total images (including subfolders)`)

      return { folderName }
    }

    let folderName: string | null = null

    try {
      const result = await tryList(oauthToken ? "oauth" : "apiKey")
      folderName = result.folderName
    } catch (error: unknown) {
      // If OAuth failed with 403, retry once using API key for public access.
      const code = (error as { code?: number; status?: number } | null)?.code ?? (error as { status?: number } | null)?.status
      if (oauthToken && (code === 403 || code === 401)) {
        console.warn(
          `⚠️ Drive access failed with OAuth (code ${code}). Retrying with API key for public folder access...`
        )
        // Reset collected images before retry
        allImages.length = 0
        const result = await tryList("apiKey")
        folderName = result.folderName
      } else {
        throw error
      }
    }

    // Get folder metadata
    return {
      success: true,
      folderName,
      images: allImages,
      count: allImages.length,
    }
  } catch (error: unknown) {
    console.error("Drive API error during recursive listing:", error)

    if (error && typeof error === "object" && "code" in error) {
      const driveError = error as { code: number }
      if (driveError.code === 403 || driveError.code === 404) {
        let errorMessage: string
        if (oauthToken) {
          // OAuth was used (and may have been missing scopes). For a truly public folder, API key access should work.
          // If we reach this point, both OAuth and API key failed, or OAuth was the only mode attempted.
          errorMessage =
            "Google Drive returned 'Insufficient Permission'. If this folder is public, please ensure sharing is set to 'Anyone with the link' (viewer). If it is already public, your Google connection may be missing Drive scopes; reconnect Google and grant Drive access."
        } else {
          // User is logged in but doesn't have OAuth token
          errorMessage = "This folder is private. To access private folders, you need to connect your Google account. Please check your account settings to connect Google, or make the folder public by setting it to 'Anyone with the link' (viewer)."
        }
        return {
          success: false,
          folderName: null,
          error: errorMessage,
          images: [],
          count: 0,
        }
      }
    }

    return {
      success: false,
      folderName: null,
      error: "Failed to access the folder. Please check the URL and try again.",
      images: [],
      count: 0,
    }
  }
}

/**
 * Validate folder URL format
 */
export function isValidDriveUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url)
    return (
      parsedUrl.hostname === "drive.google.com" &&
      (parsedUrl.pathname.includes("/folders/") || parsedUrl.searchParams.has("id"))
    )
  } catch {
    return false
  }
}
