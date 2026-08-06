import * as path from 'path'
import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { HttpApi, HttpRoute, HttpRouteKey, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import { LambdaFn } from './constructs/lambda-fn'

interface RodzApiStack4Props extends StackProps {
  authorizerFn: NodejsFunction
  vpc:          ec2.IVpc
  sharedEnv:    Record<string, string>
}

/**
 * Stack 4 — admin API surface on a **separate HttpApi**.
 *
 * The shared HttpApi (Stacks 1-3) hit AWS's 300-route quota. Rather
 * than requesting a quota bump or consolidating existing routes, admin
 * surfaces get their own API Gateway with its own 300-route budget
 * and stricter CORS (locked to the workshop app origins).
 *
 * Reuses the staff `authorizerFn` Lambda from Stack 1 via a fresh
 * HttpLambdaAuthorizer bound to this API (authorizers are per-API in
 * HTTP API v2).
 *
 * Base URL is emitted as a CfnOutput (AdminApiUrl) — no custom domain
 * for v1; add later via Route 53 + ACM if a prettier URL is wanted.
 */
export class RodzApiStack4 extends Stack {
  public readonly adminApi: HttpApi
  public readonly adminAuthorizer: HttpLambdaAuthorizer

  constructor(scope: Construct, id: string, props: RodzApiStack4Props) {
    super(scope, id, props)

    const { authorizerFn, vpc, sharedEnv } = props

    const src = (p: string) => path.join(__dirname, '../../src', p)

    // Separate HttpApi for admin surfaces — locked-down CORS (no wildcard).
    this.adminApi = new HttpApi(this, 'AdminHttpApi', {
      apiName:     'RodzAdminAPI',
      description: 'Rodz staff/admin API (separate HttpApi to avoid the shared 300-route cap)',
      corsPreflight: {
        allowOrigins: [
          'https://workshop.rodz.com.au',
          'http://localhost:5173',
          'http://localhost:5177',
          'http://localhost:3000',
        ],
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PUT,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
        maxAge: Duration.days(1),
      },
    })

    // Fresh authorizer instance bound to this API, wrapping the same
    // underlying Lambda from Stack 1.
    this.adminAuthorizer = new HttpLambdaAuthorizer('AdminJwtAuthorizer', authorizerFn, {
      responseTypes:   [HttpLambdaResponseType.SIMPLE],
      identitySource:  ['$request.header.Authorization'],
      resultsCacheTtl: Duration.seconds(0),
    })

    new CfnOutput(this, 'AdminApiUrl', {
      value: this.adminApi.url ?? '',
      description: 'Admin API base URL — put in the workshop app env as ADMIN_API_BASE',
    })

    // ── Admin catalog CRUD + Gemini regenerate ──────────────────────────────
    // Single ANY route (proxy path) that dispatches internally by
    // method + path segments to makes/models/series/regenerate handlers.
    // Timeout 60s to accommodate the Gemini call in regenerate.

    const adminCatalogDispatchFn = new LambdaFn(this, 'AdminCatalogDispatch', {
      entry: src('admin/vehicle-catalog/dispatch.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(60),
    }).fn
    const adminCatalogIntegration = new HttpLambdaIntegration('AdminCatalogDispatchInt', adminCatalogDispatchFn)

    // Explicit per-method routes (rather than HttpMethod.ANY) so
    // OPTIONS preflight falls through to the API Gateway's built-in
    // CORS handler instead of hitting the authorizer and 401-ing.
    for (const method of [HttpMethod.GET, HttpMethod.POST, HttpMethod.PATCH, HttpMethod.DELETE]) {
      new HttpRoute(this, `AdminCatalogDispatchRoute${method}`, {
        httpApi:     this.adminApi,
        integration: adminCatalogIntegration,
        routeKey:    HttpRouteKey.with('/admin/vehicle-catalog/{proxy+}', method),
        authorizer:  this.adminAuthorizer,
      })
    }

    // ── Public booking-flow reads — /public/stores, /public/service-types ──
    // No authorizer — these are the anonymous funnel path for the
    // guest booking flow at workshop.rodz.com.au/book. Land on this
    // HttpApi rather than the shared one (which is at the 300-route
    // cap) — same CORS config applies, no separate stack needed.

    const publicStoresFn = new LambdaFn(this, 'PublicBookingStores', {
      entry: src('public/booking-flow/stores.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'PublicBookingStoresRoute', {
      httpApi:     this.adminApi,
      integration: new HttpLambdaIntegration('PublicBookingStoresInt', publicStoresFn),
      routeKey:    HttpRouteKey.with('/public/stores', HttpMethod.GET),
    })

    const publicServiceTypesFn = new LambdaFn(this, 'PublicBookingServiceTypes', {
      entry: src('public/booking-flow/service-types.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'PublicBookingServiceTypesRoute', {
      httpApi:     this.adminApi,
      integration: new HttpLambdaIntegration('PublicBookingServiceTypesInt', publicServiceTypesFn),
      routeKey:    HttpRouteKey.with('/public/service-types', HttpMethod.GET),
    })

    // ── /public/stores/{id}/business-hours ────────────────────────────────
    const publicBusinessHoursFn = new LambdaFn(this, 'PublicBookingBusinessHours', {
      entry: src('public/booking-flow/business-hours.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'PublicBookingBusinessHoursRoute', {
      httpApi:     this.adminApi,
      integration: new HttpLambdaIntegration('PublicBookingBusinessHoursInt', publicBusinessHoursFn),
      routeKey:    HttpRouteKey.with('/public/stores/{id}/business-hours', HttpMethod.GET),
    })

    // ── /public/stores/{id}/schedule-exceptions ───────────────────────────
    const publicScheduleExceptionsFn = new LambdaFn(this, 'PublicBookingScheduleExceptions', {
      entry: src('public/booking-flow/schedule-exceptions.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'PublicBookingScheduleExceptionsRoute', {
      httpApi:     this.adminApi,
      integration: new HttpLambdaIntegration('PublicBookingScheduleExceptionsInt', publicScheduleExceptionsFn),
      routeKey:    HttpRouteKey.with('/public/stores/{id}/schedule-exceptions', HttpMethod.GET),
    })

    // ── /public/stores/{id}/booking-slots ─────────────────────────────────
    // Per-day slot availability: joins business_hours, schedule
    // exceptions, active booking-slot definitions, existing bookings,
    // and hoist capacity to compute an available/reason per slot.
    const publicBookingSlotsFn = new LambdaFn(this, 'PublicBookingSlots', {
      entry: src('public/booking-flow/booking-slots.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'PublicBookingSlotsRoute', {
      httpApi:     this.adminApi,
      integration: new HttpLambdaIntegration('PublicBookingSlotsInt', publicBookingSlotsFn),
      routeKey:    HttpRouteKey.with('/public/stores/{id}/booking-slots', HttpMethod.GET),
    })

    // ── POST /public/bookings ─────────────────────────────────────────────
    // Guest booking creation for the 11-step flow at
    // workshop.rodz.com.au/book. Turnstile-gated (when TURNSTILE_SECRET
    // is set), idempotent via meta.sessionId, emails confirmation +
    // notifies store. Bumped timeout because customer/vehicle upsert +
    // engine invokes can push past the 3s default.
    const publicBookingsCreateFn = new LambdaFn(this, 'PublicBookingsCreate', {
      entry: src('public/booking-flow/bookings-create.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(30), needsSes: true,
    }).fn
    new HttpRoute(this, 'PublicBookingsCreateRoute', {
      httpApi:     this.adminApi,
      integration: new HttpLambdaIntegration('PublicBookingsCreateInt', publicBookingsCreateFn),
      routeKey:    HttpRouteKey.with('/public/bookings', HttpMethod.POST),
    })

    // ── GET /public/bookings/claim?token=... ──────────────────────────────
    // Magic-link handler for the confirmation email. Read-only: returns
    // the booking summary + claim state + hasAccount flag on the
    // customer so the workshop app can decide whether to prompt for
    // login or password creation.
    const publicBookingsClaimFn = new LambdaFn(this, 'PublicBookingsClaim', {
      entry: src('public/booking-flow/bookings-claim.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'PublicBookingsClaimRoute', {
      httpApi:     this.adminApi,
      integration: new HttpLambdaIntegration('PublicBookingsClaimInt', publicBookingsClaimFn),
      routeKey:    HttpRouteKey.with('/public/bookings/claim', HttpMethod.GET),
    })

    // ── GET /reports/attribution — marketing / operations report ──────────
    // Staff-authed. Aggregates bookings by utm_source / medium / campaign
    // OR by geo / device dimensions extracted from submission_context.
    // Lands here (not on the shared HttpApi with the other /reports/*)
    // because that API is at the 300-route cap.
    const reportsAttributionFn = new LambdaFn(this, 'ReportsAttribution', {
      entry: src('reports/attribution.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'ReportsAttributionRoute', {
      httpApi:     this.adminApi,
      integration: new HttpLambdaIntegration('ReportsAttributionInt', reportsAttributionFn),
      routeKey:    HttpRouteKey.with('/reports/attribution', HttpMethod.GET),
      authorizer:  this.adminAuthorizer,
    })

    // ── Odometer audit trail + weekly-bump observability ──────────────────
    // Feeds the workshop "Odometer" tab on the vehicle drawer + a super-admin
    // widget answering "did the weekly-bump cron run?" Both land here (not
    // on the shared HttpApi) because that API is at the 300-route cap.

    const vehicleOdometerHistoryFn = new LambdaFn(this, 'VehicleOdometerHistory', {
      entry: src('customers/vehicles/odometer-history.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'VehicleOdometerHistoryRoute', {
      httpApi:     this.adminApi,
      integration: new HttpLambdaIntegration('VehicleOdometerHistoryInt', vehicleOdometerHistoryFn),
      routeKey:    HttpRouteKey.with('/customers/{customerId}/vehicles/{vehicleId}/odometer-history', HttpMethod.GET),
      authorizer:  this.adminAuthorizer,
    })

    const adminOdometerBumpRunsFn = new LambdaFn(this, 'AdminOdometerBumpRuns', {
      entry: src('admin/odometer-bump-runs.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'AdminOdometerBumpRunsRoute', {
      httpApi:     this.adminApi,
      integration: new HttpLambdaIntegration('AdminOdometerBumpRunsInt', adminOdometerBumpRunsFn),
      routeKey:    HttpRouteKey.with('/admin/odometer-bump-runs', HttpMethod.GET),
      authorizer:  this.adminAuthorizer,
    })
  }
}
