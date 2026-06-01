import * as path from 'path'
import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { RodzVpc } from './constructs/vpc'
import { LambdaFn } from './constructs/lambda-fn'
import { ApiGateway } from './constructs/api-gateway'

export class RodzApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    // VPC: Lambda in private subnets → NAT Gateway (static Elastic IP) → Azure MySQL
    const { vpc } = new RodzVpc(this, 'Vpc')

    // Output the NAT Gateway Elastic IP — whitelist this in Azure MySQL firewall
    const natEip = vpc.publicSubnets[0].node.findChild('EIP') as any
    new CfnOutput(this, 'NatGatewayElasticIp', {
      value: natEip?.ref ?? 'Check VPC → Elastic IPs in AWS console',
      description: 'Whitelist this IP in Azure MySQL firewall',
    })

    // Credentials injected from .env at deploy time — never committed to git
    const sharedEnv: Record<string, string> = {
      NODE_ENV:    'production',
      REGION:      'ap-southeast-2',
      DB_HOST:     process.env.DB_HOST     ?? '',
      DB_PORT:     process.env.DB_PORT     ?? '3306',
      DB_USER:     process.env.DB_USER     ?? '',
      DB_PASSWORD: process.env.DB_PASSWORD ?? '',
      DB_NAME:     process.env.DB_NAME     ?? 'rodz',
      JWT_SECRET:  process.env.JWT_SECRET  ?? '',
    }

    const src = (p: string) => path.join(__dirname, '../../src', p)

    // ── Lambda functions ────────────────────────────────────────────────────

    const authorizerFn = new LambdaFn(this, 'Authorizer', {
      entry: src('authorizer/handler.ts'), vpc, sharedEnv,
    }).fn

    // 512 MB so bcrypt.compare at cost factor 12 stays well under 1s
    const loginFn = new LambdaFn(this, 'AuthLogin', {
      entry: src('auth/login.ts'), vpc, sharedEnv, memorySize: 512,
    }).fn

    const logoutFn = new LambdaFn(this, 'AuthLogout', {
      entry: src('auth/logout.ts'), vpc, sharedEnv,
    }).fn

    const meFn = new LambdaFn(this, 'AuthMe', {
      entry: src('auth/me.ts'), vpc, sharedEnv,
    }).fn

    // ── API Gateway + JWT authorizer ────────────────────────────────────────

    const { httpApi, authorizer } = new ApiGateway(this, 'Api', { authorizerFn })

    // ── Routes ──────────────────────────────────────────────────────────────

    httpApi.addRoutes({
      path: '/auth/login',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('LoginInt', loginFn),
    })

    httpApi.addRoutes({
      path: '/auth/logout',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('LogoutInt', logoutFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/auth/me',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('MeInt', meFn),
      authorizer,
    })
  }
}
