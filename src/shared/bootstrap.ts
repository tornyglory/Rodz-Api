// Credentials are injected directly as Lambda environment variables at deploy time.
// This file is kept as a no-op so handlers don't need to change when credentials
// move between sources.
export async function bootstrap(): Promise<void> {}
