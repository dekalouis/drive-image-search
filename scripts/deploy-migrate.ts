#!/usr/bin/env tsx
/**
 * Railway deployment migration script
 * Handles database migrations gracefully during deployment
 */

import { execSync } from "child_process"

async function deployMigrate() {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl) {
    console.error("❌ DATABASE_URL environment variable is not set")
    console.log("⚠️  Skipping database migration - DATABASE_URL not available")
    process.exit(0) // Exit successfully to not block deployment
  }

  try {
    console.log("🔄 Running database migrations...")
    console.log(`📊 Database: ${databaseUrl.split("@")[1]?.split("/")[0] || "unknown"}`)
    
    // Use migrate deploy for production (applies pending migrations)
    execSync("npx prisma migrate deploy", {
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
      },
    })

    console.log("✅ Database migrations completed successfully")
  } catch (error) {
    console.error("❌ Migration failed:", error)
    console.log("⚠️  Continuing deployment - migrations can be run manually if needed")
    // Don't exit with error code to allow deployment to continue
    // Railway will retry migrations on next deploy if needed
    process.exit(0)
  }
}

deployMigrate()

