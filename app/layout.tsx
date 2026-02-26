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
  title: "ImageSearch",
  description: "Search through your Google Drive images using AI-powered semantic search",
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
  
  // Always render ClerkProvider if we have a valid key, even if it might fail at runtime
  // This ensures Clerk components can be used
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

  // No Clerk key - render without ClerkProvider
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
