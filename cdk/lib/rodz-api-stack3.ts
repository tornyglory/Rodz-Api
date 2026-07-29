import * as path from 'path'
import { Stack, StackProps, Duration } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { HttpApi, HttpRoute, HttpRouteKey, HttpMethod, HttpAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import * as lambda from 'aws-cdk-lib/aws-lambda'
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

    // Notification centre — portal bell-icon feed. Backed by notification_events
    // (already written by pushToCustomer). Adds read_at tracking + pagination.
    const customerNotifListFn = new LambdaFn(this, 'CustomerNotifList', {
      entry: src('customer/notifications/list.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'CustomerNotifListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerNotifListInt', customerNotifListFn),
      routeKey: HttpRouteKey.with('/c/notifications', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    const customerNotifUnreadCountFn = new LambdaFn(this, 'CustomerNotifUnreadCount', {
      entry: src('customer/notifications/unread-count.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'CustomerNotifUnreadCountRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerNotifUnreadCountInt', customerNotifUnreadCountFn),
      routeKey: HttpRouteKey.with('/c/notifications/unread-count', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    const customerNotifMarkReadFn = new LambdaFn(this, 'CustomerNotifMarkRead', {
      entry: src('customer/notifications/mark-read.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'CustomerNotifMarkReadRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerNotifMarkReadInt', customerNotifMarkReadFn),
      routeKey: HttpRouteKey.with('/c/notifications/{id}/read', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    const customerNotifMarkAllReadFn = new LambdaFn(this, 'CustomerNotifMarkAllRead', {
      entry: src('customer/notifications/mark-all-read.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'CustomerNotifMarkAllReadRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerNotifMarkAllReadInt', customerNotifMarkAllReadFn),
      routeKey: HttpRouteKey.with('/c/notifications/read-all', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    // Staff-side rescue: unlock a customer who's hit the login-lockout.
    // Clears failed_login_attempts + locked_until. Password unchanged.
    // Managers + super admins only (guard inside the handler).
    const customerUnlockFn = new LambdaFn(this, 'CustomerUnlock', {
      entry: src('customers/unlock.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'CustomerUnlockRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerUnlockInt', customerUnlockFn),
      routeKey: HttpRouteKey.with('/customers/{id}/unlock', HttpMethod.POST),
      authorizer,   // staff JWT
    })

    // ── Booking slots + business hours + schedule exceptions ──────────────
    //
    // Consolidated to conserve API Gateway v2 integrations (hard cap 300).
    // Each Lambda uses ANY routes and dispatches internally on method +
    // path — reused `HttpLambdaIntegration` instances share one API
    // Gateway integration across multiple routes.

    // Customer availability check (per store + date):
    const customerBookingSlotsFn = new LambdaFn(this, 'CustomerBookingSlots', {
      entry: src('customer/stores/booking-slots.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'CustomerBookingSlotsRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerBookingSlotsInt', customerBookingSlotsFn),
      routeKey: HttpRouteKey.with('/c/stores/{id}/booking-slots', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    // Staff booking-slots CRUD — one Lambda, two ANY routes sharing one integration.
    //
    // ANY intercepts OPTIONS preflight, and a route-level authorizer would
    // 401 that preflight before the Lambda runs. So these routes are
    // registered WITHOUT an authorizer; the Lambda verifies the JWT and
    // handles the OPTIONS preflight itself (see src/shared/staffAuth.ts).
    const staffSlotsFn = new LambdaFn(this, 'StaffSlots', {
      entry: src('stores/booking-slots/router.ts'), vpc, sharedEnv,
    }).fn
    const staffSlotsInt = new HttpLambdaIntegration('StaffSlotsInt', staffSlotsFn)
    new HttpRoute(this, 'StaffSlotsCollectionRoute', {
      httpApi, integration: staffSlotsInt,
      routeKey: HttpRouteKey.with('/stores/{id}/booking-slots', HttpMethod.ANY),
    })
    new HttpRoute(this, 'StaffSlotsItemRoute', {
      httpApi, integration: staffSlotsInt,
      routeKey: HttpRouteKey.with('/stores/{id}/booking-slots/{slotId}', HttpMethod.ANY),
    })

    // Business hours — GET all 7 days + PATCH one day (dayOfWeek in body).
    // Same OPTIONS-preflight-handled-in-Lambda pattern as above.
    const staffHoursFn = new LambdaFn(this, 'StaffBusinessHours', {
      entry: src('stores/business-hours.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'StaffBusinessHoursRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('StaffBusinessHoursInt', staffHoursFn),
      routeKey: HttpRouteKey.with('/stores/{id}/business-hours', HttpMethod.ANY),
    })

    // Schedule exceptions — one Lambda, two ANY routes sharing one integration.
    const staffExceptionsFn = new LambdaFn(this, 'StaffScheduleExceptions', {
      entry: src('stores/schedule-exceptions.ts'), vpc, sharedEnv,
    }).fn
    const staffExceptionsInt = new HttpLambdaIntegration('StaffScheduleExceptionsInt', staffExceptionsFn)
    new HttpRoute(this, 'StaffScheduleExceptionsCollectionRoute', {
      httpApi, integration: staffExceptionsInt,
      routeKey: HttpRouteKey.with('/stores/{id}/schedule-exceptions', HttpMethod.ANY),
    })
    new HttpRoute(this, 'StaffScheduleExceptionsItemRoute', {
      httpApi, integration: staffExceptionsInt,
      routeKey: HttpRouteKey.with('/stores/{id}/schedule-exceptions/{excId}', HttpMethod.ANY),
    })

    // Cover photo — mirror of the existing avatar update. Uses the same
    // shared /c/me/avatar/upload-url endpoint for the CF direct-upload
    // URL; only the save-side handler is dedicated per field.
    const customerMeCoverUpdateFn = new LambdaFn(this, 'CustomerMeCoverUpdate', {
      entry: src('customer/me/cover-update.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerMeCoverUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerMeCoverUpdateInt', customerMeCoverUpdateFn),
      routeKey: HttpRouteKey.with('/c/me/cover', HttpMethod.POST),
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

    // Customer-portal profile regenerate — owner rewrites the voice-bearing
    // fields of the AI profile with a chosen tone. Per-vehicle override,
    // structured fields stay shared per (make, model, year).
    const customerVehicleProfileRegenerateFn = new LambdaFn(this, 'CustomerVehicleProfileRegenerate', {
      entry: src('customer/vehicles/profile-regenerate.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerVehicleProfileRegenerateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerVehicleProfileRegenerateInt', customerVehicleProfileRegenerateFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/profile/regenerate', HttpMethod.POST),
      authorizer: customerAuthorizer,
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

    // ── Quote videos — record / play back with thumbnails ──────────────────
    //
    // Storage: Cloudflare R2 via S3-compatible API (see src/shared/r2.ts).
    // ffmpeg + ffprobe live in a self-published Lambda layer built from
    // ../../layers/ffmpeg/ — Linux x86_64 static binaries from John Van
    // Sickle's builds (johnvansickle.com/ffmpeg). Self-owned so we don't
    // depend on cross-account resource policies from public layers.
    //
    // Layer content maps to /opt/ at runtime. `layers/ffmpeg/bin/ffmpeg`
    // becomes `/opt/bin/ffmpeg`, matching FFMPEG_PATH in post-process.ts.

    const ffmpegLayer = new lambda.LayerVersion(this, 'FfmpegLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../../layers/ffmpeg')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      compatibleArchitectures: [lambda.Architecture.X86_64],
      description: 'ffmpeg + ffprobe static binaries for video post-processing',
    })

    // Async post-process Lambda — extracts thumbnail, then bakes the Rodz
    // watermark into the video and replaces the R2 object. The watermark
    // step is a full h264 re-encode so the CPU/timeout budget is much
    // bigger than a thumbnail-only pass would need. 2 GB RAM roughly
    // doubles CPU allocation vs. 1 GB (Lambda scales linearly).
    const quoteVideoPostProcessFn = new LambdaFn(this, 'QuoteVideoPostProcess', {
      entry: src('quotes/videos/post-process.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(300), memorySize: 2048,
      ephemeralStorageSize: 2048,   // /tmp for original + watermarked + thumbnail scratch
      layers: [ffmpegLayer],
    }).fn

    // Create handler needs the post-process ARN to invoke it fire-and-forget.
    const videoEnv = { ...sharedEnv, QUOTE_VIDEO_POST_PROCESS_FN_ARN: quoteVideoPostProcessFn.functionArn }

    const quoteVideoUploadUrlFn = new LambdaFn(this, 'QuoteVideoUploadUrl', {
      entry: src('quotes/videos/upload-url.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'QuoteVideoUploadUrlRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('QuoteVideoUploadUrlInt', quoteVideoUploadUrlFn),
      routeKey: HttpRouteKey.with('/quotes/{id}/videos/upload-url', HttpMethod.GET),
      authorizer,
    })

    const quoteVideoCreateFn = new LambdaFn(this, 'QuoteVideoCreate', {
      entry: src('quotes/videos/create.ts'), vpc, sharedEnv: videoEnv,
    }).fn

    new HttpRoute(this, 'QuoteVideoCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('QuoteVideoCreateInt', quoteVideoCreateFn),
      routeKey: HttpRouteKey.with('/quotes/{id}/videos', HttpMethod.POST),
      authorizer,
    })

    const quoteVideoDeleteFn = new LambdaFn(this, 'QuoteVideoDelete', {
      entry: src('quotes/videos/delete.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'QuoteVideoDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('QuoteVideoDeleteInt', quoteVideoDeleteFn),
      routeKey: HttpRouteKey.with('/quotes/{id}/videos/{videoId}', HttpMethod.DELETE),
      authorizer,
    })

    const quoteVideoPlaybackUrlFn = new LambdaFn(this, 'QuoteVideoPlaybackUrl', {
      entry: src('quotes/videos/playback-url.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'QuoteVideoPlaybackUrlRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('QuoteVideoPlaybackUrlInt', quoteVideoPlaybackUrlFn),
      routeKey: HttpRouteKey.with('/quotes/{id}/videos/{videoId}/playback-url', HttpMethod.GET),
      authorizer,
    })

    // ── Customer stories — Facebook-style event posts per vehicle ─────────
    //
    // Reuses `videoEnv` (defined above with QUOTE_VIDEO_POST_PROCESS_FN_ARN)
    // so story video attaches fire the same post-process Lambda that handles
    // quote clips — one thumbnail/dimension pipeline for every video surface.

    const customerStoryCreateFn = new LambdaFn(this, 'CustomerStoryCreate', {
      entry: src('customer/vehicles/stories/create.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryCreateInt', customerStoryCreateFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{vehicleId}/stories', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    const customerStoryListFn = new LambdaFn(this, 'CustomerStoryList', {
      entry: src('customer/vehicles/stories/list.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryListInt', customerStoryListFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{vehicleId}/stories', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    const customerStoryGetFn = new LambdaFn(this, 'CustomerStoryGet', {
      entry: src('customer/vehicles/stories/get.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryGetRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryGetInt', customerStoryGetFn),
      routeKey: HttpRouteKey.with('/c/stories/{id}', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    const customerStoryUpdateFn = new LambdaFn(this, 'CustomerStoryUpdate', {
      entry: src('customer/vehicles/stories/update.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryUpdateInt', customerStoryUpdateFn),
      routeKey: HttpRouteKey.with('/c/stories/{id}', HttpMethod.PATCH),
      authorizer: customerAuthorizer,
    })

    const customerStoryPublishFn = new LambdaFn(this, 'CustomerStoryPublish', {
      entry: src('customer/vehicles/stories/publish.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryPublishRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryPublishInt', customerStoryPublishFn),
      routeKey: HttpRouteKey.with('/c/stories/{id}/publish', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    const customerStoryDeleteFn = new LambdaFn(this, 'CustomerStoryDelete', {
      entry: src('customer/vehicles/stories/delete.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryDeleteInt', customerStoryDeleteFn),
      routeKey: HttpRouteKey.with('/c/stories/{id}', HttpMethod.DELETE),
      authorizer: customerAuthorizer,
    })

    const customerStoryVideoUploadUrlFn = new LambdaFn(this, 'CustomerStoryVideoUploadUrl', {
      entry: src('customer/vehicles/stories/video-upload-url.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryVideoUploadUrlRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryVideoUploadUrlInt', customerStoryVideoUploadUrlFn),
      routeKey: HttpRouteKey.with('/c/stories/{id}/videos/upload-url', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    // The media-attach handler needs the video post-process ARN so it can
    // invoke it fire-and-forget for video attachments.
    const customerStoryMediaAttachFn = new LambdaFn(this, 'CustomerStoryMediaAttach', {
      entry: src('customer/vehicles/stories/media-attach.ts'), vpc, sharedEnv: videoEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryMediaAttachRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryMediaAttachInt', customerStoryMediaAttachFn),
      routeKey: HttpRouteKey.with('/c/stories/{id}/media', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    const customerStoryMediaReorderFn = new LambdaFn(this, 'CustomerStoryMediaReorder', {
      entry: src('customer/vehicles/stories/media-reorder.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryMediaReorderRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryMediaReorderInt', customerStoryMediaReorderFn),
      routeKey: HttpRouteKey.with('/c/stories/{id}/media/reorder', HttpMethod.PATCH),
      authorizer: customerAuthorizer,
    })

    const customerStoryMediaDeleteFn = new LambdaFn(this, 'CustomerStoryMediaDelete', {
      entry: src('customer/vehicles/stories/media-delete.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryMediaDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryMediaDeleteInt', customerStoryMediaDeleteFn),
      routeKey: HttpRouteKey.with('/c/stories/{id}/media/{mediaId}', HttpMethod.DELETE),
      authorizer: customerAuthorizer,
    })

    // ── Story comments + reactions (Sprint 2) ─────────────────────────────
    // Async notifier Lambda invoked (Event) from comment-create when a
    // non-owner leaves a comment. Wires push via pushToCustomer.
    const customerStoryNotifyCommentFn = new LambdaFn(this, 'CustomerStoryNotifyComment', {
      entry: src('customer/vehicles/stories/notify-comment.ts'), vpc, sharedEnv,
    }).fn

    const storyCommentEnv = {
      ...sharedEnv,
      STORY_COMMENT_NOTIFY_FN: customerStoryNotifyCommentFn.functionArn,
    }

    const customerStoryCommentCreateFn = new LambdaFn(this, 'CustomerStoryCommentCreate', {
      entry: src('customer/vehicles/stories/comment-create.ts'), vpc, sharedEnv: storyCommentEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryCommentCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryCommentCreateInt', customerStoryCommentCreateFn),
      routeKey: HttpRouteKey.with('/c/stories/{id}/comments', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    const customerStoryCommentListFn = new LambdaFn(this, 'CustomerStoryCommentList', {
      entry: src('customer/vehicles/stories/comment-list.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryCommentListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryCommentListInt', customerStoryCommentListFn),
      routeKey: HttpRouteKey.with('/c/stories/{id}/comments', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    const customerStoryCommentUpdateFn = new LambdaFn(this, 'CustomerStoryCommentUpdate', {
      entry: src('customer/vehicles/stories/comment-update.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryCommentUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryCommentUpdateInt', customerStoryCommentUpdateFn),
      routeKey: HttpRouteKey.with('/c/stories/{id}/comments/{commentId}', HttpMethod.PATCH),
      authorizer: customerAuthorizer,
    })

    const customerStoryCommentDeleteFn = new LambdaFn(this, 'CustomerStoryCommentDelete', {
      entry: src('customer/vehicles/stories/comment-delete.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryCommentDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryCommentDeleteInt', customerStoryCommentDeleteFn),
      routeKey: HttpRouteKey.with('/c/stories/{id}/comments/{commentId}', HttpMethod.DELETE),
      authorizer: customerAuthorizer,
    })

    const customerStoryReactionSetFn = new LambdaFn(this, 'CustomerStoryReactionSet', {
      entry: src('customer/vehicles/stories/reaction-set.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryReactionSetRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryReactionSetInt', customerStoryReactionSetFn),
      routeKey: HttpRouteKey.with('/c/stories/{id}/reactions', HttpMethod.PUT),
      authorizer: customerAuthorizer,
    })

    const customerStoryReactionRemoveFn = new LambdaFn(this, 'CustomerStoryReactionRemove', {
      entry: src('customer/vehicles/stories/reaction-remove.ts'), vpc, sharedEnv,
    }).fn

    new HttpRoute(this, 'CustomerStoryReactionRemoveRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerStoryReactionRemoveInt', customerStoryReactionRemoveFn),
      routeKey: HttpRouteKey.with('/c/stories/{id}/reactions', HttpMethod.DELETE),
      authorizer: customerAuthorizer,
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

    // ── Vehicle modifications — owner-declared aftermarket parts ─────────

    const customerModListFn = new LambdaFn(this, 'CustomerModList', {
      entry: src('customer/vehicles/modifications/list.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'CustomerModListRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerModListInt', customerModListFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/modifications', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    const customerModCreateFn = new LambdaFn(this, 'CustomerModCreate', {
      entry: src('customer/vehicles/modifications/create.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'CustomerModCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerModCreateInt', customerModCreateFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/modifications', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    const customerModGetFn = new LambdaFn(this, 'CustomerModGet', {
      entry: src('customer/vehicles/modifications/get.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'CustomerModGetRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerModGetInt', customerModGetFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/modifications/{modId}', HttpMethod.GET),
      authorizer: customerAuthorizer,
    })

    const customerModUpdateFn = new LambdaFn(this, 'CustomerModUpdate', {
      entry: src('customer/vehicles/modifications/update.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'CustomerModUpdateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerModUpdateInt', customerModUpdateFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/modifications/{modId}', HttpMethod.PATCH),
      authorizer: customerAuthorizer,
    })

    const customerModDeleteFn = new LambdaFn(this, 'CustomerModDelete', {
      entry: src('customer/vehicles/modifications/delete.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'CustomerModDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerModDeleteInt', customerModDeleteFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/modifications/{modId}', HttpMethod.DELETE),
      authorizer: customerAuthorizer,
    })

    const customerModMediaCreateFn = new LambdaFn(this, 'CustomerModMediaCreate', {
      entry: src('customer/vehicles/modifications/media-create.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'CustomerModMediaCreateRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerModMediaCreateInt', customerModMediaCreateFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/modifications/{modId}/media', HttpMethod.POST),
      authorizer: customerAuthorizer,
    })

    const customerModMediaDeleteFn = new LambdaFn(this, 'CustomerModMediaDelete', {
      entry: src('customer/vehicles/modifications/media-delete.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'CustomerModMediaDeleteRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CustomerModMediaDeleteInt', customerModMediaDeleteFn),
      routeKey: HttpRouteKey.with('/c/vehicles/{id}/modifications/{modId}/media/{mediaId}', HttpMethod.DELETE),
      authorizer: customerAuthorizer,
    })

    // Public modifications feed for the anonymous /logbook/{token} page.
    // No auth. Gated by `public_profile_settings.modifications` + per-row `is_public`.
    const logbookModificationsFn = new LambdaFn(this, 'LogbookModifications', {
      entry: src('vehicles/logbook-modifications.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'LogbookModificationsRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('LogbookModificationsInt', logbookModificationsFn),
      routeKey: HttpRouteKey.with('/logbook/{token}/modifications', HttpMethod.GET),
    })

    // Public stories feed + detail for the anonymous /logbook/{token} page.
    // No auth. Two-level gate: `public_profile_settings.stories` + per-row
    // `is_public = 1 AND status = 'published'`.
    const logbookStoriesFn = new LambdaFn(this, 'LogbookStories', {
      entry: src('vehicles/logbook-stories.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'LogbookStoriesRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('LogbookStoriesInt', logbookStoriesFn),
      routeKey: HttpRouteKey.with('/logbook/{token}/stories', HttpMethod.GET),
    })

    const logbookStoryDetailFn = new LambdaFn(this, 'LogbookStoryDetail', {
      entry: src('vehicles/logbook-story-detail.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'LogbookStoryDetailRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('LogbookStoryDetailInt', logbookStoryDetailFn),
      routeKey: HttpRouteKey.with('/logbook/{token}/stories/{id}', HttpMethod.GET),
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

    // Per-👎 suggest-fix — one Gemini call per exchange, fast enough for
    // the 30s API Gateway integration timeout unlike the batch review.
    const adminChatFeedbackSuggestFixFn = new LambdaFn(this, 'AdminChatFeedbackSuggestFix', {
      entry: src('admin/chat-feedback/suggest-fix.ts'), vpc, sharedEnv,
      timeout: Duration.seconds(29),
    }).fn

    new HttpRoute(this, 'AdminChatFeedbackSuggestFixRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('AdminChatFeedbackSuggestFixInt', adminChatFeedbackSuggestFixFn),
      routeKey: HttpRouteKey.with('/admin/chat-feedback/{feedbackId}/suggest-fix', HttpMethod.POST),
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

    // ── SEO prerender payload — consolidated read for the Cloudflare
    //    Pages Function that server-renders /vehicle/{token} for search
    //    engines. Public (token-gated). Full payload when searchIndex=true,
    //    minimal (noindex-ready) when searchIndex=false.
    const logbookSeoPayloadFn = new LambdaFn(this, 'LogbookSeoPayload', {
      entry: src('vehicles/logbook-seo-payload.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'LogbookSeoPayloadRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('LogbookSeoPayloadInt', logbookSeoPayloadFn),
      routeKey: HttpRouteKey.with('/logbook/{token}/seo-payload', HttpMethod.GET),
    })

    // Story-scoped SEO prerender payload — mirrors the vehicle version but
    // for individual /vehicle/{token}/stories/{storyId} pages. Enables the
    // Worker to SSR any published story, not just the top 3 from the
    // vehicle-scoped storiesPreview.
    const logbookStorySeoPayloadFn = new LambdaFn(this, 'LogbookStorySeoPayload', {
      entry: src('vehicles/logbook-story-seo-payload.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'LogbookStorySeoPayloadRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('LogbookStorySeoPayloadInt', logbookStorySeoPayloadFn),
      routeKey: HttpRouteKey.with('/logbook/{token}/stories/{storyId}/seo-payload', HttpMethod.GET),
    })

    // ── Sitemap index — feed for the Cloudflare Pages Function that emits
    //    /sitemap.xml. Only vehicles opted in for search indexing.
    const vehiclesPublicIndexFn = new LambdaFn(this, 'VehiclesPublicIndex', {
      entry: src('vehicles/public-index.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'VehiclesPublicIndexRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('VehiclesPublicIndexInt', vehiclesPublicIndexFn),
      routeKey: HttpRouteKey.with('/vehicles/public-index', HttpMethod.GET),
    })

    // ── Public vehicle catalog — year → make → model → series cascade
    //    for the guest booking flow. Consolidated onto ONE HttpApi route
    //    (/public/vehicle-catalog/{action}) because the shared HttpApi
    //    is at the 300-route cap; a separate route per endpoint would
    //    exceed it. The Lambda dispatches internally to the five
    //    handlers by inspecting {action}.

    const catalogDispatchFn = new LambdaFn(this, 'CatalogDispatch', {
      entry: src('public/vehicle-catalog/dispatch.ts'), vpc, sharedEnv,
    }).fn
    new HttpRoute(this, 'CatalogDispatchRoute', {
      httpApi,
      integration: new HttpLambdaIntegration('CatalogDispatchInt', catalogDispatchFn),
      routeKey: HttpRouteKey.with('/public/vehicle-catalog/{action}', HttpMethod.GET),
    })

    // The admin catalog CRUD + Gemini regenerate route lives on the
    // separate admin HttpApi (RodzApiStack4) — the shared HttpApi is
    // at the 300-route cap.

  }
}
