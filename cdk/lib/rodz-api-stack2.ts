import * as path from 'path'
import { Stack, StackProps, Duration } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import { HttpApi, HttpRoute, HttpRouteKey, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { LambdaFn } from './constructs/lambda-fn'

interface RodzApiStack2Props extends StackProps {
  httpApi: HttpApi
  authorizer: HttpLambdaAuthorizer
  vpc: ec2.IVpc
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
      GEMINI_API_KEY:   process.env.GEMINI_API_KEY   ?? '',
      BOOKING_API_KEY:  process.env.BOOKING_API_KEY  ?? '',
    }

    const src = (p: string) => path.join(__dirname, '../../src', p)

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
  }
}
