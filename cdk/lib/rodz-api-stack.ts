import * as path from 'path'
import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { RodzVpc } from './constructs/vpc'
import { LambdaFn } from './constructs/lambda-fn'
import { ApiGateway } from './constructs/api-gateway'

export class RodzApiStack extends Stack {
  public readonly httpApi: HttpApi
  public readonly authorizer: HttpLambdaAuthorizer
  public readonly vpc: ec2.IVpc
  public readonly jobUpdateFn: import('aws-cdk-lib/aws-lambda-nodejs').NodejsFunction

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    // VPC: Lambda in private subnets → NAT Gateway (static Elastic IP) → Azure MySQL
    const { vpc } = new RodzVpc(this, 'Vpc')
    this.vpc = vpc

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
      DB_NAME:          process.env.DB_NAME          ?? 'rodz',
      JWT_SECRET:       process.env.JWT_SECRET       ?? '',
      FRONTEND_URL:     process.env.FRONTEND_URL     ?? '',
      CF_ACCOUNT_ID:    process.env.CF_ACCOUNT_ID    ?? '',
      CF_ACCOUNT_HASH:  process.env.CF_ACCOUNT_HASH  ?? '',
      CF_IMAGES_TOKEN:  process.env.CF_IMAGES_TOKEN  ?? '',
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

    // ── Customers & vehicles ────────────────────────────────────────────────

    const customerListFn = new LambdaFn(this, 'CustomerList', {
      entry: src('customers/list.ts'), vpc, sharedEnv,
    }).fn

    const customerGetFn = new LambdaFn(this, 'CustomerGet', {
      entry: src('customers/get.ts'), vpc, sharedEnv,
    }).fn

    const customerCreateFn = new LambdaFn(this, 'CustomerCreate', {
      entry: src('customers/create.ts'), vpc, sharedEnv,
    }).fn

    const customerUpdateFn = new LambdaFn(this, 'CustomerUpdate', {
      entry: src('customers/update.ts'), vpc, sharedEnv,
    }).fn

    const customerDeleteFn = new LambdaFn(this, 'CustomerDelete', {
      entry: src('customers/delete.ts'), vpc, sharedEnv,
    }).fn

    const vehicleCreateFn = new LambdaFn(this, 'VehicleCreate', {
      entry: src('customers/vehicles/create.ts'), vpc, sharedEnv,
    }).fn

    const vehicleUpdateFn = new LambdaFn(this, 'VehicleUpdate', {
      entry: src('customers/vehicles/update.ts'), vpc, sharedEnv,
    }).fn

    const vehicleDeleteFn = new LambdaFn(this, 'VehicleDelete', {
      entry: src('customers/vehicles/delete.ts'), vpc, sharedEnv,
    }).fn

    const vehicleListFn = new LambdaFn(this, 'VehicleList', {
      entry: src('vehicles/list.ts'), vpc, sharedEnv,
    }).fn

    // ── Bookings ────────────────────────────────────────────────────────────

    const bookingListFn = new LambdaFn(this, 'BookingList', {
      entry: src('bookings/list.ts'), vpc, sharedEnv,
    }).fn

    const bookingCreateFn = new LambdaFn(this, 'BookingCreate', {
      entry: src('bookings/create.ts'), vpc, sharedEnv, needsSes: true,
    }).fn

    const bookingUpdateFn = new LambdaFn(this, 'BookingUpdate', {
      entry: src('bookings/update.ts'), vpc, sharedEnv, needsSes: true,
    }).fn

    const bookingDeleteFn = new LambdaFn(this, 'BookingDelete', {
      entry: src('bookings/delete.ts'), vpc, sharedEnv,
    }).fn

    // ── Hoists (operational) ────────────────────────────────────────────────

    const hoistListFn = new LambdaFn(this, 'HoistList', {
      entry: src('hoists/list.ts'), vpc, sharedEnv,
    }).fn

    const hoistAssignTechFn = new LambdaFn(this, 'HoistAssignTech', {
      entry: src('hoists/assignTech.ts'), vpc, sharedEnv,
    }).fn

    // ── Jobs ────────────────────────────────────────────────────────────────

    const jobListFn = new LambdaFn(this, 'JobList', {
      entry: src('jobs/list.ts'), vpc, sharedEnv,
    }).fn

    this.jobUpdateFn = new LambdaFn(this, 'JobUpdate', {
      entry: src('jobs/update.ts'), vpc, sharedEnv, needsSes: true,
    }).fn
    const jobUpdateFn = this.jobUpdateFn

    const jobGetFn = new LambdaFn(this, 'JobGet', {
      entry: src('jobs/get.ts'), vpc, sharedEnv,
    }).fn

    const jobReorderFn = new LambdaFn(this, 'JobReorder', {
      entry: src('jobs/reorder.ts'), vpc, sharedEnv,
    }).fn

    // ── Service types ───────────────────────────────────────────────────────

    const serviceTypeListFn = new LambdaFn(this, 'ServiceTypeList', {
      entry: src('service-types/list.ts'), vpc, sharedEnv,
    }).fn

    const serviceTypeCreateFn = new LambdaFn(this, 'ServiceTypeCreate', {
      entry: src('service-types/create.ts'), vpc, sharedEnv,
    }).fn

    const serviceTypeUpdateFn = new LambdaFn(this, 'ServiceTypeUpdate', {
      entry: src('service-types/update.ts'), vpc, sharedEnv,
    }).fn

    const serviceTypeDeleteFn = new LambdaFn(this, 'ServiceTypeDelete', {
      entry: src('service-types/delete.ts'), vpc, sharedEnv,
    }).fn

    // ── Suppliers ───────────────────────────────────────────────────────────

    const supplierListFn = new LambdaFn(this, 'SupplierList', {
      entry: src('suppliers/list.ts'), vpc, sharedEnv,
    }).fn

    const supplierCreateFn = new LambdaFn(this, 'SupplierCreate', {
      entry: src('suppliers/create.ts'), vpc, sharedEnv,
    }).fn

    const supplierUpdateFn = new LambdaFn(this, 'SupplierUpdate', {
      entry: src('suppliers/update.ts'), vpc, sharedEnv,
    }).fn

    const supplierDeleteFn = new LambdaFn(this, 'SupplierDelete', {
      entry: src('suppliers/delete.ts'), vpc, sharedEnv,
    }).fn

    // ── Parts ────────────────────────────────────────────────────────────────

    const partListFn = new LambdaFn(this, 'PartList', {
      entry: src('parts/list.ts'), vpc, sharedEnv,
    }).fn

    const partCreateFn = new LambdaFn(this, 'PartCreate', {
      entry: src('parts/create.ts'), vpc, sharedEnv,
    }).fn

    const partUpdateFn = new LambdaFn(this, 'PartUpdate', {
      entry: src('parts/update.ts'), vpc, sharedEnv,
    }).fn

    const partDeleteFn = new LambdaFn(this, 'PartDelete', {
      entry: src('parts/delete.ts'), vpc, sharedEnv,
    }).fn

    // ── Part names ───────────────────────────────────────────────────────────

    const partNameListFn = new LambdaFn(this, 'PartNameList', {
      entry: src('part-names/list.ts'), vpc, sharedEnv,
    }).fn

    const partNameCreateFn = new LambdaFn(this, 'PartNameCreate', {
      entry: src('part-names/create.ts'), vpc, sharedEnv,
    }).fn

    const partNameUpdateFn = new LambdaFn(this, 'PartNameUpdate', {
      entry: src('part-names/update.ts'), vpc, sharedEnv,
    }).fn

    const partNameDeleteFn = new LambdaFn(this, 'PartNameDelete', {
      entry: src('part-names/delete.ts'), vpc, sharedEnv,
    }).fn

    // ── Purchase orders ─────────────────────────────────────────────────────

    const poListFn = new LambdaFn(this, 'POList', {
      entry: src('purchase-orders/list.ts'), vpc, sharedEnv,
    }).fn

    const poGetFn = new LambdaFn(this, 'POGet', {
      entry: src('purchase-orders/get.ts'), vpc, sharedEnv,
    }).fn

    const poCreateFn = new LambdaFn(this, 'POCreate', {
      entry: src('purchase-orders/create.ts'), vpc, sharedEnv,
    }).fn

    const poUpdateFn = new LambdaFn(this, 'POUpdate', {
      entry: src('purchase-orders/update.ts'), vpc, sharedEnv,
    }).fn

    const poDeleteFn = new LambdaFn(this, 'PODelete', {
      entry: src('purchase-orders/delete.ts'), vpc, sharedEnv,
    }).fn

    const poItemCreateFn = new LambdaFn(this, 'POItemCreate', {
      entry: src('purchase-orders/items/create.ts'), vpc, sharedEnv,
    }).fn

    const poItemUpdateFn = new LambdaFn(this, 'POItemUpdate', {
      entry: src('purchase-orders/items/update.ts'), vpc, sharedEnv,
    }).fn

    const poItemDeleteFn = new LambdaFn(this, 'POItemDelete', {
      entry: src('purchase-orders/items/delete.ts'), vpc, sharedEnv,
    }).fn

    // ── Email templates ─────────────────────────────────────────────────────

    const emailTemplatesGetFn = new LambdaFn(this, 'EmailTemplatesGet', {
      entry: src('settings/email-templates/get.ts'), vpc, sharedEnv,
    }).fn

    const emailTemplatesUpdateFn = new LambdaFn(this, 'EmailTemplatesUpdate', {
      entry: src('settings/email-templates/update.ts'), vpc, sharedEnv,
      needsSes: true,
    }).fn

    // ── Photos ──────────────────────────────────────────────────────────────

    const photoUploadUrlFn = new LambdaFn(this, 'PhotoUploadUrl', {
      entry: src('photos/uploadUrl.ts'), vpc, sharedEnv,
    }).fn

    const photoCreateFn = new LambdaFn(this, 'PhotoCreate', {
      entry: src('photos/create.ts'), vpc, sharedEnv,
    }).fn

    const photoListFn = new LambdaFn(this, 'PhotoList', {
      entry: src('photos/list.ts'), vpc, sharedEnv,
    }).fn

    const photoDeleteFn = new LambdaFn(this, 'PhotoDelete', {
      entry: src('photos/delete.ts'), vpc, sharedEnv,
    }).fn

    // ── Catalog ─────────────────────────────────────────────────────────────

    const catalogListFn = new LambdaFn(this, 'CatalogList', {
      entry: src('catalog/list.ts'), vpc, sharedEnv,
    }).fn

    const catalogCreateFn = new LambdaFn(this, 'CatalogCreate', {
      entry: src('catalog/create.ts'), vpc, sharedEnv,
    }).fn

    const catalogUpdateFn = new LambdaFn(this, 'CatalogUpdate', {
      entry: src('catalog/update.ts'), vpc, sharedEnv,
    }).fn

    const catalogDeleteFn = new LambdaFn(this, 'CatalogDelete', {
      entry: src('catalog/delete.ts'), vpc, sharedEnv,
    }).fn

    // ── Quotes ──────────────────────────────────────────────────────────────

    const quoteListFn = new LambdaFn(this, 'QuoteList', {
      entry: src('quotes/list.ts'), vpc, sharedEnv,
    }).fn

    const quoteGetFn = new LambdaFn(this, 'QuoteGet', {
      entry: src('quotes/get.ts'), vpc, sharedEnv,
    }).fn

    const quoteCreateFn = new LambdaFn(this, 'QuoteCreate', {
      entry: src('quotes/create.ts'), vpc, sharedEnv,
    }).fn

    const quoteUpdateFn = new LambdaFn(this, 'QuoteUpdate', {
      entry: src('quotes/update.ts'), vpc, sharedEnv,
    }).fn

    const quoteDeleteFn = new LambdaFn(this, 'QuoteDelete', {
      entry: src('quotes/delete.ts'), vpc, sharedEnv,
    }).fn

    const quoteSendFn = new LambdaFn(this, 'QuoteSend', {
      entry: src('quotes/send.ts'), vpc, sharedEnv, needsSes: true,
    }).fn

    const quotePublicGetFn = new LambdaFn(this, 'QuotePublicGet', {
      entry: src('quotes/public/get.ts'), vpc, sharedEnv,
    }).fn

    const quotePublicApproveFn = new LambdaFn(this, 'QuotePublicApprove', {
      entry: src('quotes/public/approve.ts'), vpc, sharedEnv,
    }).fn

    const quotePublicPhotosFn = new LambdaFn(this, 'QuotePublicPhotos', {
      entry: src('quotes/public/photos.ts'), vpc, sharedEnv,
    }).fn

    // ── API Gateway + JWT authorizer ────────────────────────────────────────

    const { httpApi, authorizer } = new ApiGateway(this, 'Api', { authorizerFn })
    this.httpApi = httpApi
    this.authorizer = authorizer

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

    httpApi.addRoutes({
      path: '/customers',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('CustomerListInt', customerListFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/customers',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('CustomerCreateInt', customerCreateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/customers/{id}',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('CustomerGetInt', customerGetFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/customers/{id}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('CustomerUpdateInt', customerUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/customers/{id}',
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('CustomerDeleteInt', customerDeleteFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/customers/{id}/vehicles',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('VehicleCreateInt', vehicleCreateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/customers/{customerId}/vehicles/{vehicleId}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('VehicleUpdateInt', vehicleUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/customers/{customerId}/vehicles/{vehicleId}',
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('VehicleDeleteInt', vehicleDeleteFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/vehicles',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('VehicleListInt', vehicleListFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/bookings',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('BookingListInt', bookingListFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/bookings',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('BookingCreateInt', bookingCreateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/bookings/{id}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('BookingUpdateInt', bookingUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/bookings/{id}',
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('BookingDeleteInt', bookingDeleteFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/hoists',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('HoistListInt', hoistListFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/hoists/{id}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('HoistAssignTechInt', hoistAssignTechFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/hoists/{id}/jobs/reorder',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('JobReorderInt', jobReorderFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/jobs',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('JobListInt', jobListFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/jobs/{id}',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('JobGetInt', jobGetFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/jobs/{id}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('JobUpdateInt', jobUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/service-types',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('ServiceTypeListInt', serviceTypeListFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/service-types',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('ServiceTypeCreateInt', serviceTypeCreateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/service-types/{id}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('ServiceTypeUpdateInt', serviceTypeUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/service-types/{id}',
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('ServiceTypeDeleteInt', serviceTypeDeleteFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/suppliers',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('SupplierListInt', supplierListFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/suppliers',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('SupplierCreateInt', supplierCreateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/suppliers/{id}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('SupplierUpdateInt', supplierUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/suppliers/{id}',
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('SupplierDeleteInt', supplierDeleteFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/parts',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('PartListInt', partListFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/parts',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('PartCreateInt', partCreateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/parts/{id}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('PartUpdateInt', partUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/parts/{id}',
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('PartDeleteInt', partDeleteFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/part-names',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('PartNameListInt', partNameListFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/part-names',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('PartNameCreateInt', partNameCreateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/part-names/{id}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('PartNameUpdateInt', partNameUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/part-names/{id}',
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('PartNameDeleteInt', partNameDeleteFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/settings/email-templates',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('EmailTemplatesGetInt', emailTemplatesGetFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/settings/email-templates',
      methods: [HttpMethod.PUT],
      integration: new HttpLambdaIntegration('EmailTemplatesUpdateInt', emailTemplatesUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/photos/upload-url',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('PhotoUploadUrlInt', photoUploadUrlFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/photos',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('PhotoCreateInt', photoCreateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/vehicles/{rego}/photos',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('PhotoListInt', photoListFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/photos/{id}',
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('PhotoDeleteInt', photoDeleteFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/catalog',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('CatalogListInt', catalogListFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/catalog',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('CatalogCreateInt', catalogCreateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/catalog/{id}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('CatalogUpdateInt', catalogUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/catalog/{id}',
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('CatalogDeleteInt', catalogDeleteFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/quotes',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('QuoteListInt', quoteListFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/quotes',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('QuoteCreateInt', quoteCreateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/quotes/{id}',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('QuoteGetInt', quoteGetFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/quotes/{id}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('QuoteUpdateInt', quoteUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/quotes/{id}',
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('QuoteDeleteInt', quoteDeleteFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/quotes/{id}/send',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('QuoteSendInt', quoteSendFn),
      authorizer,
    })

    // ── Purchase order routes ───────────────────────────────────────────────

    httpApi.addRoutes({
      path: '/purchase-orders',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('POListInt', poListFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/purchase-orders',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('POCreateInt', poCreateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/purchase-orders/{id}',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('POGetInt', poGetFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/purchase-orders/{id}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('POUpdateInt', poUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/purchase-orders/{id}',
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('PODeleteInt', poDeleteFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/purchase-orders/{id}/items',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('POItemCreateInt', poItemCreateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/purchase-orders/{id}/items/{itemId}',
      methods: [HttpMethod.PATCH],
      integration: new HttpLambdaIntegration('POItemUpdateInt', poItemUpdateFn),
      authorizer,
    })

    httpApi.addRoutes({
      path: '/purchase-orders/{id}/items/{itemId}',
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('POItemDeleteInt', poItemDeleteFn),
      authorizer,
    })

    // Public quote routes — no JWT authorizer
    httpApi.addRoutes({
      path: '/q/{token}',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('QuotePublicGetInt', quotePublicGetFn),
    })

    httpApi.addRoutes({
      path: '/q/{token}/approve',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('QuotePublicApproveInt', quotePublicApproveFn),
    })

    httpApi.addRoutes({
      path: '/q/{token}/photos',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('QuotePublicPhotosInt', quotePublicPhotosFn),
    })
  }
}
