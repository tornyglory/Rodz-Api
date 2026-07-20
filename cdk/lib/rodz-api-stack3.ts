import * as path from 'path'
import { Stack, StackProps, Duration } from 'aws-cdk-lib'
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

    // ── Quote voice notes — record, playback, transcribe ───────────────────

    // Async transcription Lambda. Fire-and-forget invoked by the create +
    // retry handlers. Longer timeout because Gemini audio calls can take
    // a few seconds; larger memory to hold the audio buffer.
    const quoteVoiceTranscribeFn = new LambdaFn(this, 'QuoteVoiceTranscribe', {
      entry: src('quotes/voice-notes/transcribe.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(60), memorySize: 512,
    }).fn

    // Create handler needs the transcribe ARN to invoke it fire-and-forget.
    // Same pattern as SERVICE_SUMMARY_FN_ARN in invoices/send.ts.
    const voiceNoteEnv = { ...sharedEnv, QUOTE_VOICE_TRANSCRIBE_FN_ARN: quoteVoiceTranscribeFn.functionArn }

    const quoteVoiceUploadUrlFn = new LambdaFn(this, 'QuoteVoiceUploadUrl', {
      entry: src('quotes/voice-notes/upload-url.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'QuoteVoiceUploadUrlRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('QuoteVoiceUploadUrlInt', quoteVoiceUploadUrlFn),
      routeKey: HttpRouteKey.with('/quotes/{id}/voice-notes/upload-url', HttpMethod.GET),
      authorizer,
    })

    const quoteVoiceCreateFn = new LambdaFn(this, 'QuoteVoiceCreate', {
      entry: src('quotes/voice-notes/create.ts'), vpc, sharedEnv: voiceNoteEnv,
    }).fn

    new HttpRoute(this, 'QuoteVoiceCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('QuoteVoiceCreateInt', quoteVoiceCreateFn),
      routeKey: HttpRouteKey.with('/quotes/{id}/voice-notes', HttpMethod.POST),
      authorizer,
    })

    const quoteVoiceDeleteFn = new LambdaFn(this, 'QuoteVoiceDelete', {
      entry: src('quotes/voice-notes/delete.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'QuoteVoiceDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('QuoteVoiceDeleteInt', quoteVoiceDeleteFn),
      routeKey: HttpRouteKey.with('/quotes/{id}/voice-notes/{noteId}', HttpMethod.DELETE),
      authorizer,
    })

    const quoteVoicePlaybackUrlFn = new LambdaFn(this, 'QuoteVoicePlaybackUrl', {
      entry: src('quotes/voice-notes/playback-url.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'QuoteVoicePlaybackUrlRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('QuoteVoicePlaybackUrlInt', quoteVoicePlaybackUrlFn),
      routeKey: HttpRouteKey.with('/quotes/{id}/voice-notes/{noteId}/playback-url', HttpMethod.GET),
      authorizer,
    })

    const quoteVoiceRetryFn = new LambdaFn(this, 'QuoteVoiceRetryTranscribe', {
      entry: src('quotes/voice-notes/retry-transcribe.ts'), vpc, sharedEnv: voiceNoteEnv,
    }).fn

    new HttpRoute(this, 'QuoteVoiceRetryTranscribeRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('QuoteVoiceRetryTranscribeInt', quoteVoiceRetryFn),
      routeKey: HttpRouteKey.with('/quotes/{id}/voice-notes/{noteId}/retry-transcribe', HttpMethod.POST),
      authorizer,
    })

    // ── Customer vehicle policies — rego / WoF / insurance / roadside ──────

    const customerPolicyListFn = new LambdaFn(this, 'CustomerPolicyList', {
      entry: src('customer/vehicles/policies/list.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerPolicyListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerPolicyListInt', customerPolicyListFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/policies', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    const customerPolicyCreateFn = new LambdaFn(this, 'CustomerPolicyCreate', {
      entry: src('customer/vehicles/policies/create.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerPolicyCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerPolicyCreateInt', customerPolicyCreateFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/policies', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    const customerPolicyUpdateFn = new LambdaFn(this, 'CustomerPolicyUpdate', {
      entry: src('customer/vehicles/policies/update.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerPolicyUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerPolicyUpdateInt', customerPolicyUpdateFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/policies/{policyId}', HttpMethod.PATCH),
      authorizer: customerAuthorizer,
    })

    const customerPolicyDeleteFn = new LambdaFn(this, 'CustomerPolicyDelete', {
      entry: src('customer/vehicles/policies/delete.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerPolicyDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerPolicyDeleteInt', customerPolicyDeleteFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/policies/{policyId}', HttpMethod.DELETE),
      authorizer: customerAuthorizer,
    })

    const customerPolicyUploadUrlFn = new LambdaFn(this, 'CustomerPolicyUploadUrl', {
      entry: src('customer/vehicles/policies/upload-url.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerPolicyUploadUrlRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerPolicyUploadUrlInt', customerPolicyUploadUrlFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/policies/upload-url', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    // Policy document scan — same "upload → scan → confirm" pattern as
    // expense receipts. Returns a draft; does NOT persist. Frontend
    // prefills the policy edit sheet with the extracted fields.
    const customerPolicyScanFn = new LambdaFn(this, 'CustomerPolicyScan', {
      entry: src('customer/vehicles/policies/scan.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerPolicyScanRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerPolicyScanInt', customerPolicyScanFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/policies/scan', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    // ── Chat message feedback — 👍 / 👎 on individual AI replies ───────────

    const customerChatFeedbackFn = new LambdaFn(this, 'CustomerChatFeedback', {
      entry: src('customer/vehicles/chats/feedback.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerChatFeedbackRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerChatFeedbackInt', customerChatFeedbackFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/chats/{sessionId}/messages/{messageId}/feedback', HttpMethod.PUT),
      authorizer: customerAuthorizer,
    })

    // ── Admin chat feedback review — aggregated 👎 with reasons ────────────

    const adminChatFeedbackFn = new LambdaFn(this, 'AdminChatFeedback', {
      entry: src('admin/chat-feedback/list.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'AdminChatFeedbackRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('AdminChatFeedbackInt', adminChatFeedbackFn),
      routeKey: HttpRouteKey.with('/admin/chat-feedback', HttpMethod.GET),
      authorizer,
    })

    // Gemini reviewer — reads 👎'd replies + returns themes / edits.
    // Longer timeout because of the LLM call; 25s Lambda default is tight.
    const adminChatFeedbackReviewFn = new LambdaFn(this, 'AdminChatFeedbackReview', {
      entry: src('admin/chat-feedback/review.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(60),
    }).fn

    new HttpRoute(this, 'AdminChatFeedbackReviewRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('AdminChatFeedbackReviewInt', adminChatFeedbackReviewFn),
      routeKey: HttpRouteKey.with('/admin/chat-feedback/review', HttpMethod.POST),
      authorizer,
    })

    // ── Prompt versioning — closes the loop from review → live prompt ─────

    const adminPromptsListFn = new LambdaFn(this, 'AdminPromptsList', {
      entry: src('admin/prompts/list.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'AdminPromptsListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('AdminPromptsListInt', adminPromptsListFn),
      routeKey: HttpRouteKey.with('/admin/prompts', HttpMethod.GET),
      authorizer,
    })

    const adminPromptsSaveFn = new LambdaFn(this, 'AdminPromptsSave', {
      entry: src('admin/prompts/save.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(30),
    }).fn
    new HttpRoute(this, 'AdminPromptsSaveRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('AdminPromptsSaveInt', adminPromptsSaveFn),
      routeKey: HttpRouteKey.with('/admin/prompts', HttpMethod.POST),
      authorizer,
    })

    const adminPromptsApplyEditsFn = new LambdaFn(this, 'AdminPromptsApplyEdits', {
      entry: src('admin/prompts/apply-edits.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(30),
    }).fn
    new HttpRoute(this, 'AdminPromptsApplyEditsRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('AdminPromptsApplyEditsInt', adminPromptsApplyEditsFn),
      routeKey: HttpRouteKey.with('/admin/prompts/apply-edits', HttpMethod.POST),
      authorizer,
    })

    const adminPromptsGetFn = new LambdaFn(this, 'AdminPromptsGet', {
      entry: src('admin/prompts/get.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'AdminPromptsGetRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('AdminPromptsGetInt', adminPromptsGetFn),
      routeKey: HttpRouteKey.with('/admin/prompts/{id}', HttpMethod.GET),
      authorizer,
    })

    const adminPromptsActivateFn = new LambdaFn(this, 'AdminPromptsActivate', {
      entry: src('admin/prompts/activate.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(30),
    }).fn
    new HttpRoute(this, 'AdminPromptsActivateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('AdminPromptsActivateInt', adminPromptsActivateFn),
      routeKey: HttpRouteKey.with('/admin/prompts/{id}/activate', HttpMethod.POST),
      authorizer,
    })

  }
}
