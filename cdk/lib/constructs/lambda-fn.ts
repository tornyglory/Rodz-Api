import { Construct } from 'constructs'
import { Duration } from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'

interface LambdaFnProps {
  entry: string
  vpc: ec2.IVpc
  secret: secretsmanager.ISecret
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
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      timeout: props.timeout ?? Duration.seconds(10),
      memorySize: props.memorySize ?? 256,
      environment: {
        NODE_ENV: 'production',
        REGION: 'ap-southeast-2',
        SECRET_ARN: props.secret.secretArn,
        ...props.environment,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: [],
      },
    })

    props.secret.grantRead(this.fn)
  }
}
