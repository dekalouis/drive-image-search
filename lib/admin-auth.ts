import { NextRequest, NextResponse } from 'next/server'

/**
 * Check if the request carries a valid admin token (SEC-007)
 * Token must match ADMIN_SECRET_TOKEN environment variable.
 * Returns a 401 response if invalid, or null if valid (caller should proceed).
 */
export function checkAdminAuth(request: NextRequest): NextResponse | null {
  const adminToken = process.env.ADMIN_SECRET_TOKEN
  if (!adminToken) {
    return NextResponse.json({ error: 'Admin access not configured' }, { status: 503 })
  }

  const provided = request.headers.get('x-admin-token')
  if (!provided || provided !== adminToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return null
}
