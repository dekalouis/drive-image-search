import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Navbar } from "@/components/navbar";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Drive Image Searcher",
  description: "Search and organize your Google Drive images",
};

// Make layout dynamic to avoid static generation issues with Clerk
export const dynamic = 'force-dynamic';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Check if Clerk publishable key is available and valid
  const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const hasValidClerkKey = clerkPublishableKey && 
    clerkPublishableKey !== 'pk_test_your_publishable_key_here' &&
    clerkPublishableKey.startsWith('pk_');
  
  // In production, Clerk keys are required (SEC-012)
  if (!hasValidClerkKey && process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is missing or invalid. ' +
      'Authentication cannot be configured. Set the environment variable and redeploy.'
    )
  }

  // Always render ClerkProvider if we have a valid key
  if (hasValidClerkKey) {
    return (
      <ClerkProvider publishableKey={clerkPublishableKey}>
        <html lang="en">
          <body
            className={`${geistSans.variable} ${geistMono.variable} antialiased`}
          >
            <Navbar />
            {children}
          </body>
        </html>
      </ClerkProvider>
    );
  }

  // No Clerk key in development - render without ClerkProvider
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <Navbar />
        {children}
      </body>
    </html>
  );
}
