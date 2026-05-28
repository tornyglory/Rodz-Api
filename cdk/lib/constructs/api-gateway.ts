import { Construct } from 'constructs'
import { Duration, CfnOutput } from 'aws-cdk-lib'
import { HttpApi, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'

interface ApiGatewayProps {
  authorizerFn: NodejsFunction
}

export class ApiGateway extends Construct {
  public readonly httpApi: HttpApi
  public readonly authorizer: HttpLambdaAuthorizer

  constructor(scope: Construct, id: string, props: ApiGatewayProps) {
    super(scope, id)

    this.httpApi = new HttpApi(this, 'HttpApi', {
      apiName: 'RodzAPI',
      description: 'Rodz staff portal API',
      corsPreflight: {
        allowOrigins: ['https://rodz-staff.azurewebsites.net'],
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization'],
        maxAge: Duration.days(1),
      },
    })

    this.authorizer = new HttpLambdaAuthorizer('JwtAuthorizer', props.authorizerFn, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      identitySource: ['$request.header.Authorization'],
      resultsCacheTtl: Duration.seconds(300),
    })

    new CfnOutput(scope, 'ApiUrl', {
      value: this.httpApi.url ?? '',
      description: 'HTTP API base URL',
    })
  }
}
