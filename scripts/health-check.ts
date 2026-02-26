/**
 * Health check script — checks DB, Redis, and queue status.
 * Run with: npm run health-check
 *
 * Requires ADMIN_SECRET_TOKEN env var to be set (matches /api/health endpoint auth).
 */

const BASE_URL = process.env.HEALTH_CHECK_URL || 'http://localhost:3000'
const ADMIN_TOKEN = process.env.ADMIN_SECRET_TOKEN

async function main() {
  console.log(`🔍 Health check — ${BASE_URL}`)

  if (!ADMIN_TOKEN) {
    console.error('❌ ADMIN_SECRET_TOKEN env var is not set. Cannot authenticate with /api/health.')
    process.exit(1)
  }

  try {
    const res = await fetch(`${BASE_URL}/api/health`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
    })

    const data = await res.json()

    if (res.ok && data.status === 'healthy') {
      console.log('✅ System is healthy')
      console.log(`   Response time : ${data.responseTime}`)
      console.log(`   Database      : ${data.services?.database?.healthy ? '✅' : '❌'}`)
      console.log(`   Queue/Redis   : ${data.services?.queue?.healthy ? '✅' : '❌'}`)
      if (data.services?.queue?.stats) {
        const { folders, images } = data.services.queue.stats
        console.log(`   Folder queue  : waiting=${folders?.waiting ?? 0} active=${folders?.active ?? 0} failed=${folders?.failed ?? 0}`)
        console.log(`   Image queue   : waiting=${images?.waiting ?? 0} active=${images?.active ?? 0} failed=${images?.failed ?? 0}`)
      }
    } else {
      console.error('❌ System is unhealthy')
      console.error(JSON.stringify(data, null, 2))
      process.exit(1)
    }
  } catch (err) {
    console.error('❌ Failed to reach health endpoint:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
