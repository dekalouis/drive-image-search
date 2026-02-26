"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { useEffect, useState } from "react"

export function Navbar() {
  const [clerkComponents, setClerkComponents] = useState<{
    SignInButton: any
    SignUpButton: any
    SignedIn: any
    SignedOut: any
    UserButton: any
  } | null>(null)

  useEffect(() => {
    const clerkKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    const hasValidClerkKey = clerkKey && 
      clerkKey !== 'pk_test_your_publishable_key_here' &&
      clerkKey.startsWith('pk_')
    
    if (hasValidClerkKey) {
      try {
        import("@clerk/nextjs").then((clerk) => {
          setClerkComponents({
            SignInButton: clerk.SignInButton,
            SignUpButton: clerk.SignUpButton,
            SignedIn: clerk.SignedIn,
            SignedOut: clerk.SignedOut,
            UserButton: clerk.UserButton,
          })
        }).catch(() => {
          // Clerk not available, continue without auth
        })
      } catch {
        // Clerk not available, continue without auth
      }
    }
  }, [])

  const hasClerk = clerkComponents !== null

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="max-w-7xl mx-auto flex h-14 items-center justify-between px-4">
        {/* Logo / Brand */}
        <Link href="/" className="font-bold text-lg">
          ImageSearch
        </Link>

        {/* Auth Section */}
        {hasClerk && clerkComponents && (
          <div className="flex items-center gap-3">
            <clerkComponents.SignedOut>
              <clerkComponents.SignInButton mode="modal">
                <Button variant="ghost" size="sm">
                  Login
                </Button>
              </clerkComponents.SignInButton>
              <clerkComponents.SignUpButton mode="modal">
                <Button size="sm">
                  Sign up for free
                </Button>
              </clerkComponents.SignUpButton>
            </clerkComponents.SignedOut>
            <clerkComponents.SignedIn>
              <clerkComponents.UserButton 
                afterSignOutUrl="/"
                appearance={{
                  elements: {
                    avatarBox: "h-8 w-8"
                  }
                }}
              />
            </clerkComponents.SignedIn>
          </div>
        )}
      </div>
    </header>
  )
}

