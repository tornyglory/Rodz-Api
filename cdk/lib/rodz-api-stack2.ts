import * as path from 'path'
import { Stack, StackProps, Duration } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources'
import { HttpApi, HttpRoute, HttpRouteKey, HttpMethod, HttpAuthorizer, HttpAuthorizerType, AuthorizerPayloadVersion } from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { LambdaFn } from './constructs/lambda-fn'

interface RodzApiStack2Props extends StackProps {
  httpApi:      HttpApi
  authorizer:   HttpLambdaAuthorizer
  vpc:          ec2.IVpc
}

export class RodzApiStack2 extends Stack {
  constructor(scope: Construct, id: string, props: RodzApiStack2Props) {
    super(scope, id, props)

    const { httpApi, authorizer, vpc } = props

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
      WS_API_URL:            process.env.WS_API_URL            ?? '',
      ASSISTANT_CONTEXT_ENABLED: process.env.ASSISTANT_CONTEXT_ENABLED ?? 'false',
      CHAT_HINTS_ENABLED:        process.env.CHAT_HINTS_ENABLED        ?? 'false',
      REDIS_URL:                 process.env.REDIS_URL                 ?? '',
      RATE_LIMIT_ENABLED:        process.env.RATE_LIMIT_ENABLED        ?? 'false',
      VOICE_MODE_ENABLED:        process.env.VOICE_MODE_ENABLED        ?? 'false',
      CHAT_TTS_ENABLED:          process.env.CHAT_TTS_ENABLED          ?? 'false',
      VOICE_MODEL:               process.env.VOICE_MODEL               ?? 'gemini-2.5-flash-native-audio-preview-09-2025',
      VOICE_VOICE_NAME:          process.env.VOICE_VOICE_NAME          ?? 'Aoede',
      VOICE_SESSION_TTL_SECONDS: process.env.VOICE_SESSION_TTL_SECONDS ?? '900',
      VOICE_DAILY_LIMIT_SECONDS: process.env.VOICE_DAILY_LIMIT_SECONDS ?? '1800',
      // GEMINI_VOICE_API_KEY is set per-Lambda after deploy via
      // `aws lambda update-function-configuration` — it's a secret and
      // shouldn't live in the CDK env stanza.
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

    const publicBlocksFn = new LambdaFn(this, 'PublicBlocks', {
      entry: src('public/blocks.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'PublicBlocksRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('PublicBlocksInt', publicBlocksFn),
      routeKey: HttpRouteKey.with('/public/blocks', HttpMethod.GET),
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

    // Invoke permission comes from the shared role's wildcard policy.
    publicBookFn.addEnvironment('AI_RECOMMENDATION_FN_ARN', aiRecommendationFn.functionArn)

    // ── AI — Vehicle Profile Engine ─────────────────────────────────────────

    const vehicleProfileFn = new LambdaFn(this, 'VehicleProfileEngine', {
      entry: src('ai/vehicle-profile-engine.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(60),
    }).fn

    publicBookFn.addEnvironment('VEHICLE_PROFILE_FN_ARN', vehicleProfileFn.functionArn)

    // ── Vehicle Profile read endpoint ───────────────────────────────────────

    const vehicleProfileGetFn = new LambdaFn(this, 'VehicleProfileGet', {
      entry: src('customers/vehicles/profile.ts'), vpc, sharedEnv,
    }).fn

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

    // (Nightly chat-session archive job removed 2026-07-14 — messages now
    // live in S3 from the moment they're written; MySQL never accumulates
    // them, so nothing to archive.)

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

    const logbookVehicleFn = new LambdaFn(this, 'LogbookVehicle', {
      entry: src('vehicles/logbook-vehicle.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'LogbookVehicleRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('LogbookVehicleInt', logbookVehicleFn),
      routeKey: HttpRouteKey.with('/logbook/{token}/vehicle', HttpMethod.GET),
    })

    const logbookExpensesFn = new LambdaFn(this, 'LogbookExpenses', {
      entry: src('vehicles/logbook-expenses.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'LogbookExpensesRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('LogbookExpensesInt', logbookExpensesFn),
      routeKey: HttpRouteKey.with('/logbook/{token}/expenses', HttpMethod.GET),
    })

    const logbookChatFn = new LambdaFn(this, 'LogbookChat', {
      entry: src('vehicles/logbook-chat.ts'), vpc, sharedEnv, timeout: Duration.seconds(30), memorySize: 512,
    }).fn

    new HttpRoute(this, 'LogbookChatRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('LogbookChatInt', logbookChatFn),
      routeKey: HttpRouteKey.with('/logbook/{token}/chat', HttpMethod.POST),
    })

    const logbookRecommendationsFn = new LambdaFn(this, 'LogbookRecommendations', {
      entry: src('vehicles/logbook-recommendations.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'LogbookRecommendationsRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('LogbookRecommendationsInt', logbookRecommendationsFn),
      routeKey: HttpRouteKey.with('/logbook/{token}/recommendations', HttpMethod.GET),
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
      queueName:         'rodz-logbook-notify',
      deliveryDelay:     Duration.seconds(60),
      visibilityTimeout: Duration.seconds(60),
    })

    const logbookNotifyConsumerFn = new LambdaFn(this, 'LogbookNotifyConsumer', {
      entry: src('vehicles/logbook-notify-consumer.ts'), vpc, sharedEnv, needsSes: true,
    }).fn

    logbookNotifyConsumerFn.addEventSource(new SqsEventSource(logbookNotifyQueue, { batchSize: 1 }))

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

    // ── Customer tier + premium (staff) ────────────────────────────────────

    const customerTierFn = new LambdaFn(this, 'CustomerTier', {
      entry: src('customers/tier.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerTierRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerTierInt', customerTierFn),
      routeKey: HttpRouteKey.with('/customers/{id}/tier', HttpMethod.PATCH),
      authorizer,
    })

    const customerPremiumFn = new LambdaFn(this, 'CustomerPremium', {
      entry: src('customers/premium.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerPremiumRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerPremiumInt', customerPremiumFn),
      routeKey: HttpRouteKey.with('/customers/{id}/premium', HttpMethod.PATCH),
      authorizer,
    })

    // ── AI — Service Summary Engine ─────────────────────────────────────────

    const serviceSummaryFn = new LambdaFn(this, 'ServiceSummaryEngine', {
      entry: src('ai/service-summary-engine.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(60),
    }).fn

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

    // ── Reports (activity + P&L + GST) ─────────────────────────────────────

    const reportJobsFn = new LambdaFn(this, 'ReportJobs', {
      entry: src('reports/jobs.ts'), vpc, sharedEnv,
    }).fn

    const reportBookingsFn = new LambdaFn(this, 'ReportBookings', {
      entry: src('reports/bookings.ts'), vpc, sharedEnv,
    }).fn

    const reportHoistsFn = new LambdaFn(this, 'ReportHoists', {
      entry: src('reports/hoists.ts'), vpc, sharedEnv,
    }).fn

    const reportPlFn = new LambdaFn(this, 'ReportPL', {
      entry: src('reports/pl.ts'), vpc, sharedEnv,
    }).fn

    const reportGstFn = new LambdaFn(this, 'ReportGST', {
      entry: src('reports/gst.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'ReportJobsRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('ReportJobsInt', reportJobsFn),
      routeKey: HttpRouteKey.with('/reports/jobs', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'ReportBookingsRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('ReportBookingsInt', reportBookingsFn),
      routeKey: HttpRouteKey.with('/reports/bookings', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'ReportHoistsRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('ReportHoistsInt', reportHoistsFn),
      routeKey: HttpRouteKey.with('/reports/hoists', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'ReportPLRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('ReportPLInt', reportPlFn),
      routeKey: HttpRouteKey.with('/reports/pl', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'ReportGSTRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('ReportGSTInt', reportGstFn),
      routeKey: HttpRouteKey.with('/reports/gst', HttpMethod.GET),
      authorizer,
    })

    // ── Settings — Overheads ────────────────────────────────────────────────

    const overheadsListFn = new LambdaFn(this, 'OverheadsList', {
      entry: src('settings/overheads/list.ts'), vpc, sharedEnv,
    }).fn

    const overheadsCreateFn = new LambdaFn(this, 'OverheadsCreate', {
      entry: src('settings/overheads/create.ts'), vpc, sharedEnv,
    }).fn

    const overheadsUpdateFn = new LambdaFn(this, 'OverheadsUpdate', {
      entry: src('settings/overheads/update.ts'), vpc, sharedEnv,
    }).fn

    const overheadsDeleteFn = new LambdaFn(this, 'OverheadsDelete', {
      entry: src('settings/overheads/delete.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'OverheadsListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('OverheadsListInt', overheadsListFn),
      routeKey: HttpRouteKey.with('/settings/overheads', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'OverheadsCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('OverheadsCreateInt', overheadsCreateFn),
      routeKey: HttpRouteKey.with('/settings/overheads', HttpMethod.POST),
      authorizer,
    })

    new HttpRoute(this, 'OverheadsUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('OverheadsUpdateInt', overheadsUpdateFn),
      routeKey: HttpRouteKey.with('/settings/overheads/{id}', HttpMethod.PATCH),
      authorizer,
    })

    new HttpRoute(this, 'OverheadsDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('OverheadsDeleteInt', overheadsDeleteFn),
      routeKey: HttpRouteKey.with('/settings/overheads/{id}', HttpMethod.DELETE),
      authorizer,
    })

    // ── Settings — Courtesy Cars ────────────────────────────────────────────

    const courtesyCarsListFn = new LambdaFn(this, 'CourtesyCarsList', {
      entry: src('settings/courtesy-cars/list.ts'), vpc, sharedEnv,
    }).fn

    const courtesyCarsCreateFn = new LambdaFn(this, 'CourtesyCarsCreate', {
      entry: src('settings/courtesy-cars/create.ts'), vpc, sharedEnv,
    }).fn

    const courtesyCarsUpdateFn = new LambdaFn(this, 'CourtesyCarsUpdate', {
      entry: src('settings/courtesy-cars/update.ts'), vpc, sharedEnv,
    }).fn

    const courtesyCarsDeleteFn = new LambdaFn(this, 'CourtesyCarsDelete', {
      entry: src('settings/courtesy-cars/delete.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CourtesyCarsListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CourtesyCarsListInt', courtesyCarsListFn),
      routeKey: HttpRouteKey.with('/settings/courtesy-cars', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'CourtesyCarsCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CourtesyCarsCreateInt', courtesyCarsCreateFn),
      routeKey: HttpRouteKey.with('/settings/courtesy-cars', HttpMethod.POST),
      authorizer,
    })

    new HttpRoute(this, 'CourtesyCarsUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CourtesyCarsUpdateInt', courtesyCarsUpdateFn),
      routeKey: HttpRouteKey.with('/settings/courtesy-cars/{id}', HttpMethod.PATCH),
      authorizer,
    })

    new HttpRoute(this, 'CourtesyCarsDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CourtesyCarsDeleteInt', courtesyCarsDeleteFn),
      routeKey: HttpRouteKey.with('/settings/courtesy-cars/{id}', HttpMethod.DELETE),
      authorizer,
    })

    // ── Capacity ────────────────────────────────────────────────────────────

    const capacityFn = new LambdaFn(this, 'Capacity', {
      entry: src('capacity/get.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CapacityRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CapacityInt', capacityFn),
      routeKey: HttpRouteKey.with('/capacity', HttpMethod.GET),
      authorizer,
    })

    // ── Customer notes ──────────────────────────────────────────────────────

    const customerNotesListFn = new LambdaFn(this, 'CustomerNotesList', {
      entry: src('customers/notes/list.ts'), vpc, sharedEnv,
    }).fn

    const customerNotesCreateFn = new LambdaFn(this, 'CustomerNotesCreate', {
      entry: src('customers/notes/create.ts'), vpc, sharedEnv,
    }).fn

    const customerNotesDeleteFn = new LambdaFn(this, 'CustomerNotesDelete', {
      entry: src('customers/notes/delete.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerNotesListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerNotesListInt', customerNotesListFn),
      routeKey: HttpRouteKey.with('/customers/{id}/notes', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'CustomerNotesCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerNotesCreateInt', customerNotesCreateFn),
      routeKey: HttpRouteKey.with('/customers/{id}/notes', HttpMethod.POST),
      authorizer,
    })

    new HttpRoute(this, 'CustomerNotesDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerNotesDeleteInt', customerNotesDeleteFn),
      routeKey: HttpRouteKey.with('/customers/{id}/notes/{noteId}', HttpMethod.DELETE),
      authorizer,
    })

    // ── Vehicle notes ───────────────────────────────────────────────────────

    const vehicleNotesListFn = new LambdaFn(this, 'VehicleNotesList', {
      entry: src('vehicles/notes/list.ts'), vpc, sharedEnv,
    }).fn

    const vehicleNotesCreateFn = new LambdaFn(this, 'VehicleNotesCreate', {
      entry: src('vehicles/notes/create.ts'), vpc, sharedEnv,
    }).fn

    const vehicleNotesDeleteFn = new LambdaFn(this, 'VehicleNotesDelete', {
      entry: src('vehicles/notes/delete.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'VehicleNotesListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleNotesListInt', vehicleNotesListFn),
      routeKey: HttpRouteKey.with('/vehicles/{id}/notes', HttpMethod.GET),
      authorizer,
    })

    new HttpRoute(this, 'VehicleNotesCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleNotesCreateInt', vehicleNotesCreateFn),
      routeKey: HttpRouteKey.with('/vehicles/{id}/notes', HttpMethod.POST),
      authorizer,
    })

    new HttpRoute(this, 'VehicleNotesDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleNotesDeleteInt', vehicleNotesDeleteFn),
      routeKey: HttpRouteKey.with('/vehicles/{id}/notes/{noteId}', HttpMethod.DELETE),
      authorizer,
    })

    // ── Customer account — authorizer ───────────────────────────────────────

    const customerAuthorizerFn = new LambdaFn(this, 'CustomerAuthorizer', {
      entry: src('customer/authorizer/handler.ts'), vpc, sharedEnv,
    }).fn

    // Construct the HttpAuthorizer in this stack explicitly. Using
    // HttpLambdaAuthorizer places the CfnAuthorizer under httpApi's scope
    // (Stack 1), which forms a cycle with this Lambda in Stack 2.
    const customerAuthorizerUri = `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/functions/${customerAuthorizerFn.functionArn}/invocations`
    const customerAuthorizerResource = new HttpAuthorizer(this, 'CustomerJwtAuthorizer', {
      httpApi,
      identitySource: ['$request.header.Authorization'],
      type: HttpAuthorizerType.LAMBDA,
      authorizerName: 'CustomerJwtAuthorizer',
      enableSimpleResponses: true,
      payloadFormatVersion: AuthorizerPayloadVersion.VERSION_2_0,
      authorizerUri: customerAuthorizerUri,
      resultsCacheTtl: Duration.seconds(0),
    })

    customerAuthorizerFn.addPermission('ApiGatewayInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: Stack.of(this).formatArn({
        service: 'execute-api',
        resource: httpApi.apiId,
        resourceName: `authorizers/${customerAuthorizerResource.authorizerId}`,
      }),
    })

    const customerAuthorizer = HttpAuthorizer.fromHttpAuthorizerAttributes(this, 'CustomerJwtAuthorizerRef', {
      authorizerId: customerAuthorizerResource.authorizerId,
      authorizerType: 'CUSTOM',
    })

    // ── Customer auth (public — no authorizer) ──────────────────────────────

    const customerSignupFn = new LambdaFn(this, 'CustomerSignup', {
      entry: src('customer/auth/signup.ts'), vpc, sharedEnv,
    }).fn

    const customerLoginFn = new LambdaFn(this, 'CustomerLogin', {
      entry: src('customer/auth/login.ts'), vpc, sharedEnv,
    }).fn

    const customerLogoutFn = new LambdaFn(this, 'CustomerLogout', {
      entry: src('customer/auth/logout.ts'), vpc, sharedEnv,
    }).fn

    const customerMagicLinkRequestFn = new LambdaFn(this, 'CustomerMagicLinkRequest', {
      entry: src('customer/auth/magic-link-request.ts'), vpc, sharedEnv, needsSes: true,
    }).fn

    const customerMagicLinkRedeemFn = new LambdaFn(this, 'CustomerMagicLinkRedeem', {
      entry: src('customer/auth/magic-link-redeem.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerSignupRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerSignupInt', customerSignupFn),
      routeKey: HttpRouteKey.with('/c/auth/signup', HttpMethod.POST),
    })

    new HttpRoute(this, 'CustomerLoginRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerLoginInt', customerLoginFn),
      routeKey: HttpRouteKey.with('/c/auth/login', HttpMethod.POST),
    })

    new HttpRoute(this, 'CustomerLogoutRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerLogoutInt', customerLogoutFn),
      routeKey: HttpRouteKey.with('/c/auth/logout', HttpMethod.POST),
    })

    new HttpRoute(this, 'CustomerMagicLinkRequestRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerMagicLinkRequestInt', customerMagicLinkRequestFn),
      routeKey: HttpRouteKey.with('/c/auth/magic-link', HttpMethod.POST),
    })

    new HttpRoute(this, 'CustomerMagicLinkRedeemRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerMagicLinkRedeemInt', customerMagicLinkRedeemFn),
      routeKey: HttpRouteKey.with('/c/auth/magic-link/{token}', HttpMethod.GET),
    })

    // ── Customer me (authenticated) ─────────────────────────────────────────

    const customerMeGetFn = new LambdaFn(this, 'CustomerMe', {
      entry: src('customer/me/get.ts'), vpc, sharedEnv,
    }).fn

    const customerMeUpdateFn = new LambdaFn(this, 'CustomerMeUpdate', {
      entry: src('customer/me/update.ts'), vpc, sharedEnv,
    }).fn

    const customerMePasswordFn = new LambdaFn(this, 'CustomerMePassword', {
      entry: src('customer/me/password.ts'), vpc, sharedEnv,
    }).fn

    const customerAvatarUploadUrlFn = new LambdaFn(this, 'CustomerAvatarUploadUrl', {
      entry: src('customer/me/avatar-upload-url.ts'), vpc, sharedEnv,
    }).fn

    const customerAvatarUpdateFn = new LambdaFn(this, 'CustomerAvatarUpdate', {
      entry: src('customer/me/avatar-update.ts'), vpc, sharedEnv,
    }).fn

    const customerMeDescriptionEnhanceFn = new LambdaFn(this, 'CustomerMeDescriptionEnhance', {
      entry: src('customer/me/description-enhance.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(30), memorySize: 512,
    }).fn

    const customerMeOnboardingCompleteFn = new LambdaFn(this, 'CustomerMeOnboardingComplete', {
      entry: src('customer/me/onboarding-complete.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerMeGetRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerMeGetInt', customerMeGetFn),
      routeKey: HttpRouteKey.with('/c/me', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerMeUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerMeUpdateInt', customerMeUpdateFn),
      routeKey: HttpRouteKey.with('/c/me', HttpMethod.PATCH),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerMePasswordRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerMePasswordInt', customerMePasswordFn),
      routeKey: HttpRouteKey.with('/c/me/password', HttpMethod.PATCH),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerAvatarUploadUrlRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerAvatarUploadUrlInt', customerAvatarUploadUrlFn),
      routeKey: HttpRouteKey.with('/c/me/avatar-upload-url', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerAvatarUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerAvatarUpdateInt', customerAvatarUpdateFn),
      routeKey: HttpRouteKey.with('/c/me/avatar', HttpMethod.PATCH),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerMeDescriptionEnhanceRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerMeDescriptionEnhanceInt', customerMeDescriptionEnhanceFn),
      routeKey: HttpRouteKey.with('/c/me/description/enhance', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerMeOnboardingCompleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerMeOnboardingCompleteInt', customerMeOnboardingCompleteFn),
      routeKey: HttpRouteKey.with('/c/me/onboarding-complete', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    // ── Customer chat session greeting (proactive first message) ───────────

    const customerChatGreetingFn = new LambdaFn(this, 'CustomerChatGreeting', {
      entry: src('customer/vehicles/chats/greeting.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(30), memorySize: 512,
    }).fn

    new HttpRoute(this, 'CustomerChatGreetingRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerChatGreetingInt', customerChatGreetingFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/chats/{sessionId}/greeting', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    // ── Customer chat sessions (migrated from orphan Lambdas 2026-07-14) ───

    const customerChatCreateFn = new LambdaFn(this, 'CustomerChatCreateSession', {
      entry: src('customer/vehicles/chats/create-session.ts'), vpc, sharedEnv,
    }).fn
    const customerChatListFn = new LambdaFn(this, 'CustomerChatListSessions', {
      entry: src('customer/vehicles/chats/list-sessions.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(15),
    }).fn
    const customerChatSessionHistoryFn = new LambdaFn(this, 'CustomerChatSessionHistory', {
      entry: src('customer/vehicles/chats/session-history.ts'), vpc, sharedEnv,
    }).fn
    const customerChatSendFn = new LambdaFn(this, 'CustomerChatSessionSend', {
      entry: src('customer/vehicles/chats/session-send.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(60), memorySize: 512,
    }).fn
    const customerChatDeleteFn = new LambdaFn(this, 'CustomerChatSessionDelete', {
      entry: src('customer/vehicles/chats/session-delete.ts'), vpc, sharedEnv,
    }).fn
    const customerChatSessionUploadUrlFn = new LambdaFn(this, 'CustomerChatSessionUploadUrl', {
      entry: src('customer/vehicles/chats/session-upload-url.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerChatSessionCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerChatSessionCreateInt', customerChatCreateFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/chats', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })
    new HttpRoute(this, 'CustomerChatSessionListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerChatSessionListInt', customerChatListFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/chats', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })
    new HttpRoute(this, 'CustomerChatSessionHistoryRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerChatSessionHistoryInt', customerChatSessionHistoryFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/chats/{sessionId}', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })
    new HttpRoute(this, 'CustomerChatSessionSendRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerChatSessionSendInt', customerChatSendFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/chats/{sessionId}/messages', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })
    new HttpRoute(this, 'CustomerChatSessionDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerChatSessionDeleteInt', customerChatDeleteFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/chats/{sessionId}', HttpMethod.DELETE),
      authorizer: customerAuthorizer,
    })
    new HttpRoute(this, 'CustomerChatSessionUploadUrlRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerChatSessionUploadUrlInt', customerChatSessionUploadUrlFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/chats/{sessionId}/upload-url', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    // ── Voice mode — Gemini Live for Gold-tier customers (2026-07-14) ──────

    const voiceTokenFn = new LambdaFn(this, 'VoiceToken', {
      entry: src('customer/vehicles/voice/token.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(15),
    }).fn
    const voiceToolFn = new LambdaFn(this, 'VoiceTool', {
      entry: src('customer/vehicles/voice/tool.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(30), memorySize: 512,
    }).fn
    const voiceUsageFn = new LambdaFn(this, 'VoiceUsage', {
      entry: src('customer/vehicles/voice/usage.ts'), vpc, sharedEnv,
    }).fn
    const voiceTranscriptFn = new LambdaFn(this, 'VoiceTranscript', {
      entry: src('customer/vehicles/voice/transcript.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'VoiceTokenRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VoiceTokenInt', voiceTokenFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/voice/token', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })
    new HttpRoute(this, 'VoiceToolRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VoiceToolInt', voiceToolFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/voice/tool', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })
    new HttpRoute(this, 'VoiceUsageRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VoiceUsageInt', voiceUsageFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/voice/usage', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })
    new HttpRoute(this, 'VoiceTranscriptRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VoiceTranscriptInt', voiceTranscriptFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/voice/transcript', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    // ── Chat TTS — Amazon Polly (Olivia neural en-AU) — Gold tier ──────────

    const chatTtsFn = new LambdaFn(this, 'ChatTts', {
      entry: src('customer/chat/tts.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(30), memorySize: 512,
    }).fn

    new HttpRoute(this, 'ChatTtsRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('ChatTtsInt', chatTtsFn),
      routeKey: HttpRouteKey.with('/c/chat/tts', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    // ── Customer vehicles (authenticated) ───────────────────────────────────

    const customerVehicleListFn = new LambdaFn(this, 'CustomerVehicleList', {
      entry: src('customer/vehicles/list.ts'), vpc, sharedEnv,
    }).fn

    const customerVehicleCreateFn = new LambdaFn(this, 'CustomerVehicleCreate', {
      entry: src('customer/vehicles/create.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(30),
    }).fn

    const customerVehicleGetFn = new LambdaFn(this, 'CustomerVehicleGet', {
      entry: src('customer/vehicles/get.ts'), vpc, sharedEnv,
    }).fn

    const customerVehicleUpdateFn = new LambdaFn(this, 'CustomerVehicleUpdate', {
      entry: src('customer/vehicles/update.ts'), vpc, sharedEnv,
    }).fn

    const customerVehicleDescriptionEnhanceFn = new LambdaFn(this, 'CustomerVehicleDescriptionEnhance', {
      entry: src('customer/vehicles/description-enhance.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(30), memorySize: 512,
    }).fn

    const customerVehicleAvatarUploadUrlFn = new LambdaFn(this, 'CustomerVehicleAvatarUploadUrl', {
      entry: src('customer/vehicles/avatar-upload-url.ts'), vpc, sharedEnv,
    }).fn

    const customerVehicleAvatarUpdateFn = new LambdaFn(this, 'CustomerVehicleAvatarUpdate', {
      entry: src('customer/vehicles/avatar-update.ts'), vpc, sharedEnv,
    }).fn

    const customerVehicleCoverUploadUrlFn = new LambdaFn(this, 'CustomerVehicleCoverUploadUrl', {
      entry: src('customer/vehicles/cover-upload-url.ts'), vpc, sharedEnv,
    }).fn

    const customerVehicleCoverUpdateFn = new LambdaFn(this, 'CustomerVehicleCoverUpdate', {
      entry: src('customer/vehicles/cover-update.ts'), vpc, sharedEnv,
    }).fn

    const customerVehicleLogbookFn = new LambdaFn(this, 'CustomerVehicleLogbook', {
      entry: src('customer/vehicles/logbook.ts'), vpc, sharedEnv,
    }).fn

    customerVehicleCreateFn.addEnvironment('AI_RECOMMENDATION_FN_ARN', aiRecommendationFn.functionArn)
    customerVehicleCreateFn.addEnvironment('VEHICLE_PROFILE_FN_ARN', vehicleProfileFn.functionArn)

    new HttpRoute(this, 'CustomerVehicleListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleListInt', customerVehicleListFn),
      routeKey: HttpRouteKey.with('/c/vehicles', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerVehicleCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleCreateInt', customerVehicleCreateFn),
      routeKey: HttpRouteKey.with('/c/vehicles', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerVehicleGetRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleGetInt', customerVehicleGetFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerVehicleUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleUpdateInt', customerVehicleUpdateFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}', HttpMethod.PATCH),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerVehicleDescriptionEnhanceRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleDescriptionEnhanceInt', customerVehicleDescriptionEnhanceFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/description/enhance', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerVehicleAvatarUploadUrlRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleAvatarUploadUrlInt', customerVehicleAvatarUploadUrlFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/avatar-upload-url', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerVehicleAvatarUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleAvatarUpdateInt', customerVehicleAvatarUpdateFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/avatar', HttpMethod.PATCH),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerVehicleCoverUploadUrlRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleCoverUploadUrlInt', customerVehicleCoverUploadUrlFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/cover-upload-url', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerVehicleCoverUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleCoverUpdateInt', customerVehicleCoverUpdateFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/cover', HttpMethod.PATCH),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerVehicleLogbookRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleLogbookInt', customerVehicleLogbookFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/logbook', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    const customerVehicleRecommendationsFn = new LambdaFn(this, 'CustomerVehicleRecommendations', {
      entry: src('customer/vehicles/recommendations.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerVehicleRecommendationsRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleRecommendationsInt', customerVehicleRecommendationsFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/recommendations', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    // ── Customer AI chat + booking endpoints ──────────────────────────────

    const customerChatHistoryFn = new LambdaFn(this, 'CustomerChatHistory', {
      entry: src('customer/vehicles/chat-history.ts'), vpc, sharedEnv,
    }).fn

    const customerChatUploadUrlFn = new LambdaFn(this, 'CustomerChatUploadUrl', {
      entry: src('customer/vehicles/chat-upload-url.ts'), vpc, sharedEnv,
    }).fn

    const customerChatFn = new LambdaFn(this, 'CustomerChat', {
      entry: src('customer/vehicles/chat.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(60),
    }).fn

    const customerVehicleValueFn = new LambdaFn(this, 'CustomerVehicleValue', {
      entry: src('customer/vehicles/value.ts'), vpc, sharedEnv,
    }).fn

    const customerAvailabilityFn = new LambdaFn(this, 'CustomerAvailability', {
      entry: src('customer/availability.ts'), vpc, sharedEnv,
    }).fn

    const customerStoresFn = new LambdaFn(this, 'CustomerStores', {
      entry: src('customer/stores.ts'), vpc, sharedEnv,
    }).fn

    const customerServiceTypesFn = new LambdaFn(this, 'CustomerServiceTypes', {
      entry: src('customer/service-types.ts'), vpc, sharedEnv,
    }).fn

    const customerBookingListFn = new LambdaFn(this, 'CustomerBookingList', {
      entry: src('customer/bookings/list.ts'), vpc, sharedEnv,
    }).fn

    const customerBookingCreateFn = new LambdaFn(this, 'CustomerBookingCreate', {
      entry: src('customer/bookings/create.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerChatHistoryRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerChatHistoryInt', customerChatSessionHistoryFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/chat', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerChatUploadUrlRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerChatUploadUrlInt', customerChatUploadUrlFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/chat/upload-url', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerChatRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerChatInt', customerChatFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/chat', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerVehicleValueRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleValueInt', customerVehicleValueFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/value', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerAvailabilityRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerAvailabilityInt', customerAvailabilityFn),
      routeKey: HttpRouteKey.with('/c/availability', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerStoresRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoresInt', customerStoresFn),
      routeKey: HttpRouteKey.with('/c/stores', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerServiceTypesRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerServiceTypesInt', customerServiceTypesFn),
      routeKey: HttpRouteKey.with('/c/service-types', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerBookingListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerBookingListInt', customerBookingListFn),
      routeKey: HttpRouteKey.with('/c/bookings', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    new HttpRoute(this, 'CustomerBookingCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerBookingCreateInt', customerBookingCreateFn),
      routeKey: HttpRouteKey.with('/c/bookings', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    // ── Vehicle public profile ────────────────────────────────────────────────

    const customerVehicleProfileUpdateFn = new LambdaFn(this, 'CustomerVehicleProfileUpdate', {
      entry: src('customer/vehicles/profile-update.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerVehicleProfileUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleProfileUpdateInt', customerVehicleProfileUpdateFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/profile', HttpMethod.PATCH),
      authorizer: customerAuthorizer,
    })

    const customerVehicleGalleryUploadUrlFn = new LambdaFn(this, 'CustomerVehicleGalleryUploadUrl', {
      entry: src('customer/vehicles/gallery-upload-url.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerVehicleGalleryUploadUrlRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleGalleryUploadUrlInt', customerVehicleGalleryUploadUrlFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/gallery/upload-url', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    const customerVehicleGalleryCreateFn = new LambdaFn(this, 'CustomerVehicleGalleryCreate', {
      entry: src('customer/vehicles/gallery-create.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerVehicleGalleryCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleGalleryCreateInt', customerVehicleGalleryCreateFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/gallery', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    const customerVehicleGalleryDeleteFn = new LambdaFn(this, 'CustomerVehicleGalleryDelete', {
      entry: src('customer/vehicles/gallery-delete.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerVehicleGalleryDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleGalleryDeleteInt', customerVehicleGalleryDeleteFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/gallery/{imageId}', HttpMethod.DELETE),
      authorizer: customerAuthorizer,
    })

    const customerVehicleTransferFn = new LambdaFn(this, 'CustomerVehicleTransfer', {
      entry: src('customer/vehicles/transfer.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerVehicleTransferRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleTransferInt', customerVehicleTransferFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/transfer', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    const staffVehicleTransferFn = new LambdaFn(this, 'StaffVehicleTransfer', {
      entry: src('customers/vehicles/transfer.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'StaffVehicleTransferRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('StaffVehicleTransferInt', staffVehicleTransferFn),
      routeKey: HttpRouteKey.with('/customers/{customerId}/vehicles/{vehicleId}/transfer', HttpMethod.POST),
      authorizer,
    })
  }
}
