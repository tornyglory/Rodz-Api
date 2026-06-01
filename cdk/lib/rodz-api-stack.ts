import * as path from 'path'
import { Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import { LambdaFn } from './constructs/lambda-fn'
import { ApiGateway } from './constructs/api-gateway'

export class RodzApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

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

    // Helper: resolve src/ paths from this file's location (cdk/lib/)
    const src = (p: string) => path.join(__dirname, '../../src', p)

    // Helper: create a Lambda function with shared credentials
    const fn = (constructId: string, entry: string): NodejsFunction =>
      new LambdaFn(this, constructId, { entry: src(entry), sharedEnv }).fn

    // ── Lambda functions ────────────────────────────────────────────────────

    const authorizerFn     = fn('Authorizer',              'authorizer/handler.ts')

    // 512 MB so bcrypt.compare at cost factor 12 stays well under 1s
    const loginFn = new LambdaFn(this, 'AuthLogin', {
      entry: src('auth/login.ts'), sharedEnv, memorySize: 512,
    }).fn
    const logoutFn         = fn('AuthLogout',              'auth/logout.ts')
    const meFn             = fn('AuthMe',                  'auth/me.ts')

    const dashboardFn      = fn('DashboardSummary',        'dashboard/summary.ts')

    const bookingsListFn   = fn('BookingsList',            'bookings/list.ts')
    const bookingsGetFn    = fn('BookingsGet',             'bookings/get.ts')
    const bookingsCreateFn = fn('BookingsCreate',          'bookings/create.ts')
    const bookingsUpdateFn = fn('BookingsUpdate',          'bookings/update.ts')
    const bookingsDeleteFn = fn('BookingsDelete',          'bookings/delete.ts')

    const customersListFn   = fn('CustomersList',          'customers/list.ts')
    const customersGetFn    = fn('CustomersGet',           'customers/get.ts')
    const customersCreateFn = fn('CustomersCreate',        'customers/create.ts')
    const customersUpdateFn = fn('CustomersUpdate',        'customers/update.ts')

    const quotesListFn     = fn('QuotesList',              'quotes/list.ts')
    const quotesGetFn      = fn('QuotesGet',               'quotes/get.ts')
    const quotesCreateFn   = fn('QuotesCreate',            'quotes/create.ts')
    const quotesUpdateFn   = fn('QuotesUpdate',            'quotes/update.ts')
    const quotesSendFn     = fn('QuotesSend',              'quotes/send.ts')
    const quotesApproveFn  = fn('QuotesApprove',           'quotes/approve.ts')

    const jobsListFn        = fn('JobsList',               'jobs/list.ts')
    const jobsGetFn         = fn('JobsGet',                'jobs/get.ts')
    const jobsUpdateFn      = fn('JobsUpdate',             'jobs/update.ts')
    const jobsPartsListFn   = fn('JobsPartsList',          'jobs/parts/list.ts')
    const jobsPartsUpdateFn = fn('JobsPartsUpdate',        'jobs/parts/update.ts')

    const hoistsListFn     = fn('HoistsList',              'hoists/list.ts')

    const techsListFn      = fn('TechniciansList',         'technicians/list.ts')
    const techsGetFn       = fn('TechniciansGet',          'technicians/get.ts')

    const notifsListFn     = fn('NotificationsList',       'notifications/list.ts')
    const notifsReadFn     = fn('NotificationsMarkRead',   'notifications/markRead.ts')
    const notifsReadAllFn  = fn('NotificationsMarkAllRead','notifications/markAllRead.ts')

    const settingsUsersListFn    = fn('SettingsUsersList',       'settings/users/list.ts')
    const settingsUsersCreateFn  = fn('SettingsUsersCreate',     'settings/users/create.ts')
    const settingsUsersUpdateFn  = fn('SettingsUsersUpdate',     'settings/users/update.ts')
    const settingsStoresListFn   = fn('SettingsStoresList',      'settings/stores/list.ts')
    const settingsStoresUpdateFn = fn('SettingsStoresUpdate',    'settings/stores/update.ts')
    const emailTmplGetFn         = fn('SettingsEmailTmplGet',    'settings/email-templates/get.ts')
    const emailTmplUpdateFn      = fn('SettingsEmailTmplUpdate', 'settings/email-templates/update.ts')

    const catalogListFn    = fn('CatalogList',             'catalog/list.ts')
    const catalogCreateFn  = fn('CatalogCreate',           'catalog/create.ts')
    const catalogUpdateFn  = fn('CatalogUpdate',           'catalog/update.ts')

    // ── API Gateway + JWT authorizer ────────────────────────────────────────

    const { httpApi, authorizer } = new ApiGateway(this, 'Api', { authorizerFn })

    // Helper: add a route. auth=false only for login.
    const route = (
      routePath: string,
      method: HttpMethod,
      handlerFn: NodejsFunction,
      auth = true,
    ) => {
      const routeId = `${method}${routePath.replace(/[/{}.]/g, '_')}`
      httpApi.addRoutes({
        path: routePath,
        methods: [method],
        integration: new HttpLambdaIntegration(`${routeId}Int`, handlerFn),
        authorizer: auth ? authorizer : undefined,
      })
    }

    // ── Routes ──────────────────────────────────────────────────────────────

    route('/auth/login',    HttpMethod.POST,   loginFn,  false)
    route('/auth/logout',   HttpMethod.POST,   logoutFn)
    route('/auth/me',       HttpMethod.GET,    meFn)

    route('/dashboard/summary', HttpMethod.GET, dashboardFn)

    route('/bookings',          HttpMethod.GET,    bookingsListFn)
    route('/bookings/{id}',     HttpMethod.GET,    bookingsGetFn)
    route('/bookings',          HttpMethod.POST,   bookingsCreateFn)
    route('/bookings/{id}',     HttpMethod.PATCH,  bookingsUpdateFn)
    route('/bookings/{id}',     HttpMethod.DELETE, bookingsDeleteFn)

    route('/customers',         HttpMethod.GET,   customersListFn)
    route('/customers/{id}',    HttpMethod.GET,   customersGetFn)
    route('/customers',         HttpMethod.POST,  customersCreateFn)
    route('/customers/{id}',    HttpMethod.PATCH, customersUpdateFn)

    route('/quotes',              HttpMethod.GET,   quotesListFn)
    route('/quotes/{id}',         HttpMethod.GET,   quotesGetFn)
    route('/quotes',              HttpMethod.POST,  quotesCreateFn)
    route('/quotes/{id}',         HttpMethod.PATCH, quotesUpdateFn)
    route('/quotes/{id}/send',    HttpMethod.POST,  quotesSendFn)
    route('/quotes/{id}/approve', HttpMethod.POST,  quotesApproveFn)

    route('/jobs',                       HttpMethod.GET,   jobsListFn)
    route('/jobs/{id}',                  HttpMethod.GET,   jobsGetFn)
    route('/jobs/{id}',                  HttpMethod.PATCH, jobsUpdateFn)
    route('/jobs/{id}/parts',            HttpMethod.GET,   jobsPartsListFn)
    route('/jobs/{id}/parts/{partId}',   HttpMethod.PATCH, jobsPartsUpdateFn)

    route('/hoists',            HttpMethod.GET, hoistsListFn)

    route('/technicians',       HttpMethod.GET, techsListFn)
    route('/technicians/{id}',  HttpMethod.GET, techsGetFn)

    route('/notifications',             HttpMethod.GET,   notifsListFn)
    route('/notifications/{id}/read',   HttpMethod.PATCH, notifsReadFn)
    route('/notifications/read-all',    HttpMethod.POST,  notifsReadAllFn)

    route('/settings/users',           HttpMethod.GET,   settingsUsersListFn)
    route('/settings/users',           HttpMethod.POST,  settingsUsersCreateFn)
    route('/settings/users/{id}',      HttpMethod.PATCH, settingsUsersUpdateFn)
    route('/settings/stores',          HttpMethod.GET,   settingsStoresListFn)
    route('/settings/stores/{id}',     HttpMethod.PATCH, settingsStoresUpdateFn)
    route('/settings/email-templates', HttpMethod.GET,   emailTmplGetFn)
    route('/settings/email-templates', HttpMethod.PUT,   emailTmplUpdateFn)

    route('/catalog',       HttpMethod.GET,   catalogListFn)
    route('/catalog',       HttpMethod.POST,  catalogCreateFn)
    route('/catalog/{id}',  HttpMethod.PATCH, catalogUpdateFn)
  }
}
