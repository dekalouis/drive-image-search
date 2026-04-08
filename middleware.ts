import { clerkMiddleware } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import type { NextRequest, NextFetchEvent } from 'next/server'

// Only use Clerk middleware if keys are available (for build-time compatibility)
const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
const clerkSecretKey = process.env.CLERK_SECRET_KEY

// Create Clerk middleware handler only if keys are available
const clerkHandler = (clerkPublishableKey && clerkSecretKey) 
  ? clerkMiddleware()
  : null

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  // If Clerk keys are not available, fail closed (SEC-006)
  if (!clerkHandler) {
    // Allow health checks through even without Clerk
    if (request.nextUrl.pathname === '/api/health') {
      return NextResponse.next()
    }
    return NextResponse.json(
      { error: 'Service unavailable: authentication not configured' },
      { status: 503 }
    )
  }
  
  // Use Clerk middleware when keys are available
  return clerkHandler(request, event)
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
}

