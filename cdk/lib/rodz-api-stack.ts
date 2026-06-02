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

    // ── Staff management ────────────────────────────────────────────────────

    const staffListFn = new LambdaFn(this, 'StaffList', {
      entry: src('settings/users/list.ts'), vpc, sharedEnv,
    }).fn

    // 512 MB — bcrypt.hash at cost 12
    const staffCreateFn = new LambdaFn(this, 'StaffCreate', {
      entry: src('settings/users/create.ts'), vpc, sharedEnv, memorySize: 512,
    }).fn

    const staffUpdateFn = new LambdaFn(this, 'StaffUpdate', {
      entry: src('settings/users/update.ts'), vpc, sharedEnv,
    }).fn

    const staffDeleteFn = new LambdaFn(this, 'StaffDelete', {
      entry: src('settings/users/delete.ts'), vpc, sharedEnv,
    }).fn

    const staffResetPasswordFn = new LambdaFn(this, 'StaffResetPassword', {
      entry: src('settings/users/resetPassword.ts'), vpc, sharedEnv, memorySize: 512,
    }).fn

    // ── Stores & hoists ─────────────────────────────────────────────────────

    const storeListFn = new LambdaFn(this, 'StoreList', {
      entry: src('settings/stores/list.ts'), vpc, sharedEnv,
    }).fn

    const storeCreateFn = new LambdaFn(this, 'StoreCreate', {
      entry: src('settings/stores/create.ts'), vpc, sharedEnv,
    }).fn

    const storeUpdateFn = new LambdaFn(this, 'StoreUpdate', {
      entry: src('settings/stores/update.ts'), vpc, sharedEnv,
    }).fn

    const storeDeleteFn = new LambdaFn(this, 'StoreDelete', {
      entry: src('settings/stores/delete.ts'), vpc, sharedEnv,
    }).fn

    const hoistCreateFn = new LambdaFn(this, 'HoistCreate', {
      entry: src('settings/stores/hoists/create.ts'), vpc, sharedEnv,
    }).fn

    const hoistUpdateFn = new LambdaFn(this, 'HoistUpdate', {
      entry: src('settings/stores/hoists/update.ts'), vpc, sharedEnv,
    }).fn

    const hoistDeleteFn = new LambdaFn(this, 'HoistDelete', {
      entry: src('settings/stores/hoists/delete.ts'), vpc, sharedEnv,
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

    httpApi.addRoutes({
      path: '/staff',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('StaffListInt', staffListFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/staff',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('StaffCreateInt', staffCreateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/staff/{id}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('StaffUpdateInt', staffUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/staff/{id}',
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('StaffDeleteInt', staffDeleteFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/staff/{id}/password',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('StaffResetPasswordInt', staffResetPasswordFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/stores',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('StoreListInt', storeListFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/stores',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('StoreCreateInt', storeCreateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/stores/{id}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('StoreUpdateInt', storeUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/stores/{id}',
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('StoreDeleteInt', storeDeleteFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/stores/{storeId}/hoists',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('HoistCreateInt', hoistCreateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/stores/{storeId}/hoists/{hoistId}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('HoistUpdateInt', hoistUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/stores/{storeId}/hoists/{hoistId}',
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('HoistDeleteInt', hoistDeleteFn),
      authorizer,
    })
  }
}
