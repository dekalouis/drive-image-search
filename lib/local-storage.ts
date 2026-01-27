export interface LocalFolder {
  id: string // database ID
  folderId: string // Google Drive folder ID
  name: string | null
  folderUrl: string
  status: string
  totalImages: number
  processedImages: number
  createdAt: string
  updatedAt?: string
}

const STORAGE_KEY = 'driveImageFolders'

/**
 * Get all folders from localStorage
 */
export function getFolders(): LocalFolder[] {
  if (typeof window === 'undefined') {
    return []
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return []
    return JSON.parse(stored) as LocalFolder[]
  } catch (error) {
    console.error('Error reading folders from localStorage:', error)
    return []
  }
}

/**
 * Save a folder to localStorage
 */
export function saveFolder(folder: LocalFolder): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    const folders = getFolders()
    const existingIndex = folders.findIndex(f => f.id === folder.id)
    
    if (existingIndex >= 0) {
      // Update existing folder
      folders[existingIndex] = { ...folder, updatedAt: new Date().toISOString() }
    } else {
      // Add new folder
      folders.push({ ...folder, createdAt: folder.createdAt || new Date().toISOString() })
    }
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(folders))
  } catch (error) {
    console.error('Error saving folder to localStorage:', error)
  }
}

/**
 * Update folder status and processed images count
 */
export function updateFolderStatus(
  folderId: string,
  status: string,
  processedImages: number
): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    const folders = getFolders()
    const folder = folders.find(f => f.id === folderId)
    
    if (folder) {
      folder.status = status
      folder.processedImages = processedImages
      folder.updatedAt = new Date().toISOString()
      localStorage.setItem(STORAGE_KEY, JSON.stringify(folders))
    }
  } catch (error) {
    console.error('Error updating folder status in localStorage:', error)
  }
}

/**
 * Remove a folder from localStorage
 */
export function removeFolder(folderId: string): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    const folders = getFolders()
    const filtered = folders.filter(f => f.id !== folderId)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
  } catch (error) {
    console.error('Error removing folder from localStorage:', error)
  }
}

/**
 * Clear all folders from localStorage
 */
export function clearFolders(): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch (error) {
    console.error('Error clearing folders from localStorage:', error)
  }
}


