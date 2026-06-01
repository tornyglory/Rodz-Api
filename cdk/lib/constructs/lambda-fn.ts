import { Construct } from 'constructs'
import { Duration } from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'

interface LambdaFnProps {
  entry: string
  sharedEnv: Record<string, string>
  environment?: Record<string, string>
  timeout?: Duration
  memorySize?: number
}

export class LambdaFn extends Construct {
  public readonly fn: NodejsFunction

  constructor(scope: Construct, id: string, props: LambdaFnProps) {
    super(scope, id)

    this.fn = new NodejsFunction(this, 'Fn', {
      entry: props.entry,
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: props.timeout ?? Duration.seconds(10),
      memorySize: props.memorySize ?? 256,
      environment: {
        ...props.sharedEnv,
        ...props.environment,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],
      },
    })
  }
}
