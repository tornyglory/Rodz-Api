// Runs once after all tests have completed. Closes the shared mysql
// pool so the test process exits instead of hanging on keepalive.

export default async function teardown() {
  // Load env for the teardown process (globalTeardown runs in its own scope).
  const { config } = await import('dotenv')
  const { resolve } = await import('node:path')
  config({ path: resolve(__dirname, '../../.env') })

  const { getPool } = await import('../../src/shared/db')
  const pool = getPool()
  try {
    await pool.end()
  } catch {
    // Already closed, or never opened — either way, harmless.
  }
}
