import * as path from 'path'
import { Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { HttpApi, HttpRoute, HttpRouteKey, HttpMethod, HttpAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import { LambdaFn } from './constructs/lambda-fn'

interface RodzApiStack3Props extends StackProps {
  httpApi:              HttpApi
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

    const { httpApi, vpc, sharedEnv, customerAuthorizerId } = props

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
  }
}
