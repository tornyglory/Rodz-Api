import 'source-map-support/register'
import * as dotenv from 'dotenv'
import * as cdk from 'aws-cdk-lib'
import { RodzApiStack } from '../lib/rodz-api-stack'
import { RodzApiStack2 } from '../lib/rodz-api-stack2'
import { RodzApiStack3 } from '../lib/rodz-api-stack3'
import { RodzApiStack4 } from '../lib/rodz-api-stack4'

// Load .env from project root so DB/JWT credentials flow into Lambda env vars
dotenv.config()

const app = new cdk.App()

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-2',
}

const coreStack = new RodzApiStack(app, 'RodzApiStack', { env })

const stack2 = new RodzApiStack2(app, 'RodzApiStack2', {
  env,
  httpApi:     coreStack.httpApi,
  authorizer:  coreStack.authorizer,
  vpc:         coreStack.vpc,
})

new RodzApiStack3(app, 'RodzApiStack3', {
  env,
  httpApi:              coreStack.httpApi,
  authorizer:           coreStack.authorizer,
  vpc:                  coreStack.vpc,
  sharedEnv:            stack2.sharedEnv,
  customerAuthorizerId: stack2.customerAuthorizerId,
})

new RodzApiStack4(app, 'RodzApiStack4', {
  env,
  authorizerFn: coreStack.authorizerFn,
  vpc:          coreStack.vpc,
  sharedEnv:    stack2.sharedEnv,
})
