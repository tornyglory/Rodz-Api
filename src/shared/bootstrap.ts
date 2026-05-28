import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

let initialized = false

const client = new SecretsManagerClient({ region: process.env.REGION ?? 'ap-southeast-2' })

export async function bootstrap(): Promise<void> {
  if (initialized) return

  const response = await client.send(new GetSecretValueCommand({
    SecretId: process.env.SECRET_ARN!,
  }))

  const secret = JSON.parse(response.SecretString ?? '{}') as Record<string, string>
  Object.assign(process.env, secret)
  initialized = true
}
