#!/bin/bash
# Railway deployment migration script
# Handles database migrations gracefully during deployment

set -e

if [ -z "$DATABASE_URL" ]; then
  echo "⚠️  DATABASE_URL environment variable is not set"
  echo "⚠️  Skipping database migration - DATABASE_URL not available"
  exit 0
fi

echo "🔄 Running database migrations..."
echo "📊 Database: $(echo $DATABASE_URL | sed -E 's/.*@([^/]+).*/\1/')"

# Use migrate deploy for production (applies pending migrations)
if npx prisma migrate deploy; then
  echo "✅ Database migrations completed successfully"
  exit 0
else
  echo "❌ Migration failed - deployment halted"
  exit 1
fi

