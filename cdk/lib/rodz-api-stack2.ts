import * as path from 'path'
import { Stack, StackProps, Duration } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources'
import { HttpApi, HttpRoute, HttpRouteKey, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { LambdaFn } from './constructs/lambda-fn'

interface RodzApiStack2Props extends StackProps {
  httpApi:      HttpApi
  authorizer:   HttpLambdaAuthorizer
  vpc:          ec2.IVpc
  jobUpdateFn:  NodejsFunction
}

export class RodzApiStack2 extends Stack {
  constructor(scope: Construct, id: string, props: RodzApiStack2Props) {
    super(scope, id, props)

    const { httpApi, authorizer, vpc, jobUpdateFn } = props

    const sharedEnv: Record<string, string> = {
      NODE_ENV:        'production',
      REGION:          'ap-southeast-2',
      DB_HOST:         process.env.DB_HOST         ?? '',
      DB_PORT:         process.env.DB_PORT         ?? '3306',
      DB_USER:         process.env.DB_USER         ?? '',
      DB_PASSWORD:     process.env.DB_PASSWORD     ?? '',
      DB_NAME:         process.env.DB_NAME         ?? 'rodz',
      JWT_SECRET:      process.env.JWT_SECRET      ?? '',
      FRONTEND_URL:    process.env.FRONTEND_URL    ?? '',
      CF_ACCOUNT_ID:   process.env.CF_ACCOUNT_ID   ?? '',
      CF_ACCOUNT_HASH: process.env.CF_ACCOUNT_HASH ?? '',
      CF_IMAGES_TOKEN: process.env.CF_IMAGES_TOKEN ?? '',
      GEMINI_API_KEY:        process.env.GEMINI_API_KEY        ?? '',
      BOOKING_API_KEY:       process.env.BOOKING_API_KEY       ?? '',
      ZELLER_API_KEY:        process.env.ZELLER_API_KEY        ?? '',
      ZELLER_WEBHOOK_SECRET: process.env.ZELLER_WEBHOOK_SECRET ?? '',
    }

    const src = (p: string) => path.join(__dirname, '../../src', p)

    // ── Dashboard ───────────────────────────────────────────────────────────

    const dashboardFn = new LambdaFn(this, 'Dashboard', {
      entry: src('dashboard/summary.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'DashboardRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('DashboardInt', dashboardFn),
      routeKey: HttpRouteKey.with('/dashboard', HttpMethod.GET),
      authorizer,
    })

    // ── Vehicle get ─────────────────────────────────────────────────────────

    const vehicleGetFn = new LambdaFn(this, 'VehicleGet', {
      entry: src('customers/vehicles/get.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'VehicleGetRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleGetInt', vehicleGetFn),
      routeKey: HttpRouteKey.with('/customers/{customerId}/vehicles/{vehicleId}', HttpMethod.GET),
      authorizer,
    })

    // ── Public booking ──────────────────────────────────────────────────────

    const publicStoresFn = new LambdaFn(this, 'PublicStores', {
      entry: src('public/stores.ts'), vpc, sharedEnv,
    }).fn

    const publicBookFn = new LambdaFn(this, 'PublicBook', {
      entry: src('public/book.ts'), vpc, sharedEnv, needsSes: true,
      timeout: Duration.seconds(30),
    }).fn

    new HttpRoute(this, 'PublicStoresRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('PublicStoresInt', publicStoresFn),
      routeKey: HttpRouteKey.with('/public/stores', HttpMethod.GET),
    })

    new HttpRoute(this, 'PublicBookRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('PublicBookInt', publicBookFn),
      routeKey: HttpRouteKey.with('/book', HttpMethod.POST),
    })

    const publicAvailabilityFn = new LambdaFn(this, 'PublicAvailability', {
      entry: src('public/availability.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'PublicAvailabilityRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('PublicAvailabilityInt', publicAvailabilityFn),
      routeKey: HttpRouteKey.with('/public/availability', HttpMethod.GET),
    })

    const publicServicesFn = new LambdaFn(this, 'PublicServices', {
      entry: src('public/services.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'PublicServicesRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('PublicServicesInt', publicServicesFn),
      routeKey: HttpRouteKey.with('/public/services', HttpMethod.GET),
    })

    // ── Vehicle recommendations ─────────────────────────────────────────────

    const vehicleRecommendationsFn = new LambdaFn(this, 'VehicleRecommendations', {
      entry: src('customers/vehicles/recommendations.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'VehicleRecommendationsRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleRecommendationsInt', vehicleRecommendationsFn),
      routeKey: HttpRouteKey.with('/customers/{customerId}/vehicles/{vehicleId}/recommendations', HttpMethod.GET),
      authorizer,
    })

    // ── AI — Recommendation Engine ──────────────────────────────────────────

    const aiRecommendationFn = new LambdaFn(this, 'AIRecommendationEngine', {
      entry: src('ai/recommendation-engine.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(120),
    }).fn

    // Allow the public booking Lambda to invoke it async
    aiRecommendationFn.grantInvoke(publicBookFn)
    publicBookFn.addEnvironment('AI_RECOMMENDATION_FN_ARN', aiRecommendationFn.functionArn)

    // ── AI — Vehicle Profile Engine ─────────────────────────────────────────

    const vehicleProfileFn = new LambdaFn(this, 'VehicleProfileEngine', {
      entry: src('ai/vehicle-profile-engine.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(60),
    }).fn

    // Invoke from public booking + from profile GET (lazy generation)
    vehicleProfileFn.grantInvoke(publicBookFn)
    publicBookFn.addEnvironment('VEHICLE_PROFILE_FN_ARN', vehicleProfileFn.functionArn)

    // ── Vehicle Profile read endpoint ───────────────────────────────────────

    const vehicleProfileGetFn = new LambdaFn(this, 'VehicleProfileGet', {
      entry: src('customers/vehicles/profile.ts'), vpc, sharedEnv,
    }).fn

    // Allow the profile GET to trigger generation if profile is missing
    vehicleProfileFn.grantInvoke(vehicleProfileGetFn)
    vehicleProfileGetFn.addEnvironment('VEHICLE_PROFILE_FN_ARN', vehicleProfileFn.functionArn)

    new HttpRoute(this, 'VehicleProfileGetRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleProfileGetInt', vehicleProfileGetFn),
      routeKey: HttpRouteKey.with('/customers/{customerId}/vehicles/{vehicleId}/profile', HttpMethod.GET),
      authorizer,
    })

    // ── AI — Reminder Dispatcher (daily EventBridge) ────────────────────────

    const reminderDispatcherFn = new LambdaFn(this, 'ReminderDispatcher', {
      entry: src('ai/reminder-dispatcher.ts'), vpc, sharedEnv,
      needsSes: true,
      timeout: Duration.seconds(300),
    }).fn

    // 3 PM AEST daily (05:00 UTC — shifts to 4 PM during AEDT daylight saving)
    const dailyReminderRule = new events.Rule(this, 'DailyReminderRule', {
      schedule: events.Schedule.cron({ hour: '5', minute: '0' }),
    })
    dailyReminderRule.addTarget(new targets.LambdaFunction(reminderDispatcherFn))

    // ── Job card ────────────────────────────────────────────────────────────

    const jobCardGetFn = new LambdaFn(this, 'JobCardGet', {
      entry: src('jobs/card-get.ts'), vpc, sharedEnv,
    }).fn

    const jobCardUpdateFn = new LambdaFn(this, 'JobCardUpdate', {
      entry: src('jobs/card-update.ts'), vpc, sharedEnv, needsSes: true,
    }).fn

    const jobNotifyPickupFn = new LambdaFn(this, 'JobNotifyPickup', {
      entry: src('jobs/notify-pickup.ts'), vpc, sharedEnv, needsSes: true,
    }).fn

    new HttpRoute(this, 'JobCardGetRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('JobCardGetInt', jobCardGetFn),
      routeKey: HttpRouteKey.with('/jobs/{id}/card', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'JobCardUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('JobCardUpdateInt', jobCardUpdateFn),
      routeKey: HttpRouteKey.with('/jobs/{id}/card/{itemId}', HttpMethod.PATCH),
      authorizer,
    })

    new HttpRoute(this, 'JobNotifyPickupRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('JobNotifyPickupInt', jobNotifyPickupFn),
      routeKey: HttpRouteKey.with('/jobs/{id}/notify-pickup', HttpMethod.POST),
      authorizer,
    })

    // ── Invoices ────────────────────────────────────────────────────────────

    const invoiceListFn = new LambdaFn(this, 'InvoiceList', {
      entry: src('invoices/list.ts'), vpc, sharedEnv,
    }).fn

    const invoiceGetFn = new LambdaFn(this, 'InvoiceGet', {
      entry: src('invoices/get.ts'), vpc, sharedEnv,
    }).fn

    const invoiceCreateFn = new LambdaFn(this, 'InvoiceCreate', {
      entry: src('invoices/create.ts'), vpc, sharedEnv,
    }).fn

    const invoiceCreateFromJobFn = new LambdaFn(this, 'InvoiceCreateFromJob', {
      entry: src('invoices/create-from-job.ts'), vpc, sharedEnv,
    }).fn

    const invoiceUpdateFn = new LambdaFn(this, 'InvoiceUpdate', {
      entry: src('invoices/update.ts'), vpc, sharedEnv,
    }).fn

    const invoiceDeleteFn = new LambdaFn(this, 'InvoiceDelete', {
      entry: src('invoices/delete.ts'), vpc, sharedEnv,
    }).fn

    const invoiceSendFn = new LambdaFn(this, 'InvoiceSend', {
      entry: src('invoices/send.ts'), vpc, sharedEnv, needsSes: true,
      timeout: Duration.seconds(30),
    }).fn

    const invoiceMarkPaidFn = new LambdaFn(this, 'InvoiceMarkPaid', {
      entry: src('invoices/mark-paid.ts'), vpc, sharedEnv,
    }).fn

    const invoicePublicGetFn = new LambdaFn(this, 'InvoicePublicGet', {
      entry: src('invoices/public-get.ts'), vpc, sharedEnv,
    }).fn

    const invoiceWebhookZellerFn = new LambdaFn(this, 'InvoiceWebhookZeller', {
      entry: src('invoices/webhook-zeller.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'InvoiceListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('InvoiceListInt', invoiceListFn),
      routeKey: HttpRouteKey.with('/invoices', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'InvoiceGetRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('InvoiceGetInt', invoiceGetFn),
      routeKey: HttpRouteKey.with('/invoices/{id}', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'InvoiceCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('InvoiceCreateInt', invoiceCreateFn),
      routeKey: HttpRouteKey.with('/invoices', HttpMethod.POST),
      authorizer,
    })

    new HttpRoute(this, 'InvoiceCreateFromJobRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('InvoiceCreateFromJobInt', invoiceCreateFromJobFn),
      routeKey: HttpRouteKey.with('/jobs/{id}/invoice', HttpMethod.POST),
      authorizer,
    })

    new HttpRoute(this, 'InvoiceUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('InvoiceUpdateInt', invoiceUpdateFn),
      routeKey: HttpRouteKey.with('/invoices/{id}', HttpMethod.PATCH),
      authorizer,
    })

    new HttpRoute(this, 'InvoiceDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('InvoiceDeleteInt', invoiceDeleteFn),
      routeKey: HttpRouteKey.with('/invoices/{id}', HttpMethod.DELETE),
      authorizer,
    })

    new HttpRoute(this, 'InvoiceSendRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('InvoiceSendInt', invoiceSendFn),
      routeKey: HttpRouteKey.with('/invoices/{id}/send', HttpMethod.POST),
      authorizer,
    })

    new HttpRoute(this, 'InvoiceMarkPaidRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('InvoiceMarkPaidInt', invoiceMarkPaidFn),
      routeKey: HttpRouteKey.with('/invoices/{id}/mark-paid', HttpMethod.POST),
      authorizer,
    })

    new HttpRoute(this, 'InvoicePublicGetRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('InvoicePublicGetInt', invoicePublicGetFn),
      routeKey: HttpRouteKey.with('/i/{token}', HttpMethod.GET),
    })

    new HttpRoute(this, 'InvoiceWebhookZellerRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('InvoiceWebhookZellerInt', invoiceWebhookZellerFn),
      routeKey: HttpRouteKey.with('/webhooks/zeller', HttpMethod.POST),
    })

    // ── Vehicle digital logbook ─────────────────────────────────────────────

    const logbookTokenFn = new LambdaFn(this, 'LogbookToken', {
      entry: src('vehicles/logbook-token.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'LogbookTokenRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('LogbookTokenInt', logbookTokenFn),
      routeKey: HttpRouteKey.with('/vehicles/{rego}/logbook-token', HttpMethod.POST),
      authorizer,
    })

    const logbookPublicFn = new LambdaFn(this, 'LogbookPublic', {
      entry: src('vehicles/logbook-public.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'LogbookPublicRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('LogbookPublicInt', logbookPublicFn),
      routeKey: HttpRouteKey.with('/logbook/{token}', HttpMethod.GET),
    })

    const logbookProfileFn = new LambdaFn(this, 'LogbookProfile', {
      entry: src('vehicles/logbook-profile.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'LogbookProfileRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('LogbookProfileInt', logbookProfileFn),
      routeKey: HttpRouteKey.with('/logbook/{token}/profile', HttpMethod.GET),
    })

    // ── Vehicle send logbook ────────────────────────────────────────────────

    const vehicleSendLogbookFn = new LambdaFn(this, 'VehicleSendLogbook', {
      entry: src('vehicles/send-logbook.ts'), vpc, sharedEnv, needsSes: true,
    }).fn

    new HttpRoute(this, 'VehicleSendLogbookRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleSendLogbookInt', vehicleSendLogbookFn),
      routeKey: HttpRouteKey.with('/vehicles/{rego}/send-logbook', HttpMethod.POST),
      authorizer,
    })

    // ── Logbook notify queue (1-minute delay after job completion) ──────────

    const logbookNotifyQueue = new sqs.Queue(this, 'LogbookNotifyQueue', {
      deliveryDelay:     Duration.seconds(60),
      visibilityTimeout: Duration.seconds(60),
    })

    const logbookNotifyConsumerFn = new LambdaFn(this, 'LogbookNotifyConsumer', {
      entry: src('vehicles/logbook-notify-consumer.ts'), vpc, sharedEnv, needsSes: true,
    }).fn

    logbookNotifyConsumerFn.addEventSource(new SqsEventSource(logbookNotifyQueue, { batchSize: 1 }))
    logbookNotifyQueue.grantSendMessages(jobUpdateFn)
    jobUpdateFn.addEnvironment('LOGBOOK_NOTIFY_QUEUE_URL', logbookNotifyQueue.queueUrl)

    // ── Vehicle service history ─────────────────────────────────────────────

    const vehicleServiceHistoryFn = new LambdaFn(this, 'VehicleServiceHistory', {
      entry: src('vehicles/service-history.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'VehicleServiceHistoryRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleServiceHistoryInt', vehicleServiceHistoryFn),
      routeKey: HttpRouteKey.with('/vehicles/{rego}/service-history', HttpMethod.GET),
      authorizer,
    })

    // ── Customer purge (hard delete all data) ──────────────────────────────

    const customerPurgeFn = new LambdaFn(this, 'CustomerPurge', {
      entry: src('customers/purge.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(30),
    }).fn

    new HttpRoute(this, 'CustomerPurgeRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerPurgeInt', customerPurgeFn),
      routeKey: HttpRouteKey.with('/customers/{id}/purge', HttpMethod.DELETE),
      authorizer,
    })

    // ── AI — Service Summary Engine ─────────────────────────────────────────

    const serviceSummaryFn = new LambdaFn(this, 'ServiceSummaryEngine', {
      entry: src('ai/service-summary-engine.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(60),
    }).fn

    serviceSummaryFn.grantInvoke(invoiceSendFn)
    invoiceSendFn.addEnvironment('SERVICE_SUMMARY_FN_ARN', serviceSummaryFn.functionArn)

    // ── Settings — Bank details ─────────────────────────────────────────────

    const bankDetailsGetFn = new LambdaFn(this, 'BankDetailsGet', {
      entry: src('settings/bank-details/get.ts'), vpc, sharedEnv,
    }).fn

    const bankDetailsUpdateFn = new LambdaFn(this, 'BankDetailsUpdate', {
      entry: src('settings/bank-details/update.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'BankDetailsGetRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('BankDetailsGetInt', bankDetailsGetFn),
      routeKey: HttpRouteKey.with('/settings/bank-details', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'BankDetailsUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('BankDetailsUpdateInt', bankDetailsUpdateFn),
      routeKey: HttpRouteKey.with('/settings/bank-details', HttpMethod.PATCH),
      authorizer,
    })

    // ── Vehicle chats ───────────────────────────────────────────────────────

    const vehicleChatCreateFn = new LambdaFn(this, 'VehicleChatCreate', {
      entry: src('customers/vehicles/chats/create.ts'), vpc, sharedEnv,
    }).fn

    const vehicleChatListFn = new LambdaFn(this, 'VehicleChatList', {
      entry: src('customers/vehicles/chats/list.ts'), vpc, sharedEnv,
    }).fn

    const vehicleChatMessagesListFn = new LambdaFn(this, 'VehicleChatMessagesList', {
      entry: src('customers/vehicles/chats/messages-list.ts'), vpc, sharedEnv,
    }).fn

    const vehicleChatMessagesSendFn = new LambdaFn(this, 'VehicleChatMessagesSend', {
      entry: src('customers/vehicles/chats/messages-send.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(60),
    }).fn

    new HttpRoute(this, 'VehicleChatCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleChatCreateInt', vehicleChatCreateFn),
      routeKey: HttpRouteKey.with('/customers/{customerId}/vehicles/{vehicleId}/chats', HttpMethod.POST),
      authorizer,
    })

    new HttpRoute(this, 'VehicleChatListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleChatListInt', vehicleChatListFn),
      routeKey: HttpRouteKey.with('/customers/{customerId}/vehicles/{vehicleId}/chats', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'VehicleChatMessagesListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleChatMessagesListInt', vehicleChatMessagesListFn),
      routeKey: HttpRouteKey.with('/customers/{customerId}/vehicles/{vehicleId}/chats/{chatId}/messages', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'VehicleChatMessagesSendRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleChatMessagesSendInt', vehicleChatMessagesSendFn),
      routeKey: HttpRouteKey.with('/customers/{customerId}/vehicles/{vehicleId}/chats/{chatId}/messages', HttpMethod.POST),
      authorizer,
    })

    // ── Staff notifications ─────────────────────────────────────────────────

    const notificationsListFn = new LambdaFn(this, 'NotificationsList', {
      entry: src('notifications/list.ts'), vpc, sharedEnv,
    }).fn

    const notificationsMarkReadFn = new LambdaFn(this, 'NotificationsMarkRead', {
      entry: src('notifications/markRead.ts'), vpc, sharedEnv,
    }).fn

    const notificationsMarkAllReadFn = new LambdaFn(this, 'NotificationsMarkAllRead', {
      entry: src('notifications/markAllRead.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'NotificationsListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('NotificationsListInt', notificationsListFn),
      routeKey: HttpRouteKey.with('/notifications', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'NotificationsMarkReadRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('NotificationsMarkReadInt', notificationsMarkReadFn),
      routeKey: HttpRouteKey.with('/notifications/{id}/read', HttpMethod.PATCH),
      authorizer,
    })

    new HttpRoute(this, 'NotificationsMarkAllReadRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('NotificationsMarkAllReadInt', notificationsMarkAllReadFn),
      routeKey: HttpRouteKey.with('/notifications/read-all', HttpMethod.PATCH),
      authorizer,
    })

    // ── Reports ─────────────────────────────────────────────────────────────

    const reportPartsFn = new LambdaFn(this, 'ReportParts', {
      entry: src('reports/parts.ts'), vpc, sharedEnv,
    }).fn

    const reportServicesFn = new LambdaFn(this, 'ReportServices', {
      entry: src('reports/services.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'ReportPartsRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('ReportPartsInt', reportPartsFn),
      routeKey: HttpRouteKey.with('/reports/parts', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'ReportServicesRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('ReportServicesInt', reportServicesFn),
      routeKey: HttpRouteKey.with('/reports/services', HttpMethod.GET),
      authorizer,
    })

    const reportRevenueFn = new LambdaFn(this, 'ReportRevenue', {
      entry: src('reports/revenue.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'ReportRevenueRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('ReportRevenueInt', reportRevenueFn),
      routeKey: HttpRouteKey.with('/reports/revenue', HttpMethod.GET),
      authorizer,
    })

    // ── Technicians ─────────────────────────────────────────────────────────

    const technicianListFn = new LambdaFn(this, 'TechnicianList', {
      entry: src('technicians/list.ts'), vpc, sharedEnv,
    }).fn

    const technicianJobsFn = new LambdaFn(this, 'TechnicianJobs', {
      entry: src('technicians/get.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'TechnicianListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('TechnicianListInt', technicianListFn),
      routeKey: HttpRouteKey.with('/technicians', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'TechnicianJobsRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('TechnicianJobsInt', technicianJobsFn),
      routeKey: HttpRouteKey.with('/technicians/{id}/jobs', HttpMethod.GET),
      authorizer,
    })
  }
}
