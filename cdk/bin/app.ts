import 'source-map-support/register'
import * as dotenv from 'dotenv'
import * as cdk from 'aws-cdk-lib'
import { RodzApiStack } from '../lib/rodz-api-stack'
import { RodzApiStack2 } from '../lib/rodz-api-stack2'

// Load .env from project root so DB/JWT credentials flow into Lambda env vars
dotenv.config()

const app = new cdk.App()

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-2',
}

const coreStack = new RodzApiStack(app, 'RodzApiStack', { env })

new RodzApiStack2(app, 'RodzApiStack2', {
  env,
  httpApi:     coreStack.httpApi,
  authorizer:  coreStack.authorizer,
  vpc:         coreStack.vpc,
  jobUpdateFn: coreStack.jobUpdateFn,
})
