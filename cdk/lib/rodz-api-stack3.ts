import * as path from 'path'
import { Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { HttpApi, HttpRoute, HttpRouteKey, HttpMethod, HttpAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { LambdaFn } from './constructs/lambda-fn'

interface RodzApiStack3Props extends StackProps {
  httpApi:              HttpApi
  authorizer:           HttpLambdaAuthorizer
  vpc:                  ec2.IVpc
  sharedEnv:            Record<string, string>
  customerAuthorizerId: string
}

/**
 * Stack 3 — customer-facing (`/c/…`) endpoints that overflowed Stack 2.
 *
 * Stack 2 is at CloudFormation's 500-resource cap. New customer endpoints
 * land here so we don't have to unpick the Stack-2 dependency graph. Uses
 * the same HttpApi, VPC, and customer JWT authorizer created upstream.
 */
export class RodzApiStack3 extends Stack {
  constructor(scope: Construct, id: string, props: RodzApiStack3Props) {
    super(scope, id, props)

    const { httpApi, authorizer, vpc, sharedEnv, customerAuthorizerId } = props

    const src = (p: string) => path.join(__dirname, '../../src', p)

    // Rebuild the authorizer reference from its id — matches the pattern
    // used in Stack 2 to avoid cross-stack construct references.
    const customerAuthorizer = HttpAuthorizer.fromHttpAuthorizerAttributes(this, 'CustomerJwtAuthorizerRef', {
      authorizerId:   customerAuthorizerId,
      authorizerType: 'CUSTOM',
    })

    // ── Customer paperwork — combined quote/invoice list feeds ─────────────

    const customerQuotesListFn = new LambdaFn(this, 'CustomerQuotesList', {
      entry: src('customer/quotes/list.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerQuotesListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerQuotesListInt', customerQuotesListFn),
      routeKey: HttpRouteKey.with('/c/quotes', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    const customerInvoicesListFn = new LambdaFn(this, 'CustomerInvoicesList', {
      entry: src('customer/invoices/list.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerInvoicesListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerInvoicesListInt', customerInvoicesListFn),
      routeKey: HttpRouteKey.with('/c/invoices', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    // ── Vehicle health dashboard — one-shot aggregate for /account/vehicles/:id/health ──

    const customerVehicleHealthFn = new LambdaFn(this, 'CustomerVehicleHealth', {
      entry: src('customer/vehicles/health.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerVehicleHealthRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleHealthInt', customerVehicleHealthFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/health', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    // ── Push notifications — Phase 1.1 device-token registration ────────────

    const customerPushRegisterFn = new LambdaFn(this, 'CustomerPushRegister', {
      entry: src('customer/push/register.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerPushRegisterRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerPushRegisterInt', customerPushRegisterFn),
      routeKey: HttpRouteKey.with('/c/push/register', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    const customerPushUnregisterFn = new LambdaFn(this, 'CustomerPushUnregister', {
      entry: src('customer/push/unregister.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerPushUnregisterRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerPushUnregisterInt', customerPushUnregisterFn),
      routeKey: HttpRouteKey.with('/c/push/register', HttpMethod.DELETE),
      authorizer: customerAuthorizer,
    })

    // Test-push endpoint — support/debug utility. Bypasses gating.
    const customerPushTestFn = new LambdaFn(this, 'CustomerPushTest', {
      entry: src('customer/push/test.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerPushTestRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerPushTestInt', customerPushTestFn),
      routeKey: HttpRouteKey.with('/c/push/test', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    // Notification preferences — per-topic opt-outs + quiet hours
    const customerNotifPrefsGetFn = new LambdaFn(this, 'CustomerNotifPrefsGet', {
      entry: src('customer/me/notification-prefs-get.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerNotifPrefsGetRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerNotifPrefsGetInt', customerNotifPrefsGetFn),
      routeKey: HttpRouteKey.with('/c/me/notification-prefs', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    const customerNotifPrefsUpdateFn = new LambdaFn(this, 'CustomerNotifPrefsUpdate', {
      entry: src('customer/me/notification-prefs-update.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerNotifPrefsUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerNotifPrefsUpdateInt', customerNotifPrefsUpdateFn),
      routeKey: HttpRouteKey.with('/c/me/notification-prefs', HttpMethod.PATCH),
      authorizer: customerAuthorizer,
    })

    // ── Staff vehicle profile — upload URL + AI description enhance ────────

    const vehicleUploadUrlFn = new LambdaFn(this, 'VehicleUploadUrl', {
      entry: src('customers/vehicles/upload-url.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'VehicleUploadUrlRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleUploadUrlInt', vehicleUploadUrlFn),
      routeKey: HttpRouteKey.with('/customers/{customerId}/vehicles/{vehicleId}/upload-url', HttpMethod.GET),
      authorizer,
    })

    const vehicleDescriptionEnhanceFn = new LambdaFn(this, 'VehicleDescriptionEnhance', {
      entry: src('customers/vehicles/description-enhance.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'VehicleDescriptionEnhanceRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleDescriptionEnhanceInt', vehicleDescriptionEnhanceFn),
      routeKey: HttpRouteKey.with('/customers/{customerId}/vehicles/{vehicleId}/description/enhance', HttpMethod.POST),
      authorizer,
    })

    // ── Feature flags — v1 global on/off, super_admin-managed ──────────────

    const featureFlagsListFn = new LambdaFn(this, 'FeatureFlagsList', {
      entry: src('settings/feature-flags/list.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'FeatureFlagsListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('FeatureFlagsListInt', featureFlagsListFn),
      routeKey: HttpRouteKey.with('/admin/feature-flags', HttpMethod.GET),
      authorizer,
    })

    const featureFlagsUpdateFn = new LambdaFn(this, 'FeatureFlagsUpdate', {
      entry: src('settings/feature-flags/update.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'FeatureFlagsUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('FeatureFlagsUpdateInt', featureFlagsUpdateFn),
      routeKey: HttpRouteKey.with('/admin/feature-flags/{key}', HttpMethod.PATCH),
      authorizer,
    })

    // Customer-facing hydrate endpoint. Small payload, no cache.
    const customerFeatureFlagsFn = new LambdaFn(this, 'CustomerFeatureFlags', {
      entry: src('customer/feature-flags/list.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerFeatureFlagsRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerFeatureFlagsInt', customerFeatureFlagsFn),
      routeKey: HttpRouteKey.with('/c/feature-flags', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    // ── Staff vehicle gallery — /vehicles/{id}/gallery* ────────────────────

    const vehicleGalleryListFn = new LambdaFn(this, 'VehicleGalleryList', {
      entry: src('vehicles/gallery-list.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'VehicleGalleryListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleGalleryListInt', vehicleGalleryListFn),
      routeKey: HttpRouteKey.with('/vehicles/{id}/gallery', HttpMethod.GET),
      authorizer,
    })

    const vehicleGalleryUploadUrlFn = new LambdaFn(this, 'VehicleGalleryUploadUrl', {
      entry: src('vehicles/gallery-upload-url.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'VehicleGalleryUploadUrlRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleGalleryUploadUrlInt', vehicleGalleryUploadUrlFn),
      routeKey: HttpRouteKey.with('/vehicles/{id}/gallery/upload-url', HttpMethod.GET),
      authorizer,
    })

    const vehicleGalleryCreateFn = new LambdaFn(this, 'VehicleGalleryCreate', {
      entry: src('vehicles/gallery-create.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'VehicleGalleryCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleGalleryCreateInt', vehicleGalleryCreateFn),
      routeKey: HttpRouteKey.with('/vehicles/{id}/gallery', HttpMethod.POST),
      authorizer,
    })

    const vehicleGalleryDeleteFn = new LambdaFn(this, 'VehicleGalleryDelete', {
      entry: src('vehicles/gallery-delete.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'VehicleGalleryDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehicleGalleryDeleteInt', vehicleGalleryDeleteFn),
      routeKey: HttpRouteKey.with('/vehicles/{id}/gallery/{imageId}', HttpMethod.DELETE),
      authorizer,
    })

  }
}
