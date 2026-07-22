// Loaded before any test file. Populates process.env from .env so handlers
// that read DB creds via getPool() work in-process. Never overwrites an
// existing env var — a caller can inject a test-only override.

import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(__dirname, '../../.env') })

// Silence AWS SDK v3 deprecation notices in test output.
process.env.AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE = '1'
