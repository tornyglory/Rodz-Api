import 'source-map-support/register'
import * as dotenv from 'dotenv'
import * as cdk from 'aws-cdk-lib'
import { RodzApiStack } from '../lib/rodz-api-stack'

// Load .env from project root so DB/JWT credentials flow into Lambda env vars
dotenv.config()

const app = new cdk.App()

new RodzApiStack(app, 'RodzApiStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region:  process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-2',
  },
})
