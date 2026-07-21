import { Construct } from 'constructs'
import { Duration, Size, Stack } from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'

interface LambdaFnProps {
  entry: string
  vpc: ec2.IVpc
  sharedEnv: Record<string, string>
  environment?: Record<string, string>
  timeout?: Duration
  memorySize?: number
  needsSes?: boolean
  layers?: lambda.ILayerVersion[]
  ephemeralStorageSize?: number   // MB, 512 default, up to 10240
}

// One shared role + one shared security group per stack. Consolidating these
// keeps stacks under CloudFormation's 500-resource limit — each Lambda would
// otherwise get its own role + SG (2 extra resources).
function getOrCreateSharedRole(stack: Stack): iam.Role {
  const existing = stack.node.tryFindChild('SharedLambdaRole') as iam.Role | undefined
  if (existing) return existing
  return new iam.Role(stack, 'SharedLambdaRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    ],
    inlinePolicies: {
      SES: new iam.PolicyDocument({
        statements: [new iam.PolicyStatement({
          actions: ['ses:SendEmail', 'ses:SendRawEmail'],
          resources: ['*'],
        })],
      }),
      // Lambda-to-Lambda invocation with a wildcard resource. Using
      // grantInvoke() with a specific target Fn creates a circular dependency
      // because caller + callee share this role.
      LambdaInvoke: new iam.PolicyDocument({
        statements: [new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [`arn:aws:lambda:${stack.region}:${stack.account}:function:*`],
        })],
      }),
      // Data lake — full detail archive for events that grow unboundedly.
      // s3:ListBucket is needed on the bucket (not the objects) so that
      // GetObject on a non-existent key returns 404 rather than 403 —
      // required for the "does this session blob exist yet?" check.
      DataLake: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions:   ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'],
            resources: ['arn:aws:s3:::rodz-data-lake/*'],
          }),
          new iam.PolicyStatement({
            actions:   ['s3:ListBucket'],
            resources: ['arn:aws:s3:::rodz-data-lake'],
          }),
        ],
      }),
      // Polly — chat TTS for Gold-tier customers (Olivia neural en-AU).
      Polly: new iam.PolicyDocument({
        statements: [new iam.PolicyStatement({
          actions:   ['polly:SynthesizeSpeech'],
          resources: ['*'],
        })],
      }),
      // SNS — push notification fan-out via APNs + FCM platform apps.
      // CreatePlatformEndpoint is idempotent when called with the same
      // device token; Publish targets the resulting endpoint ARN.
      SNSPush: new iam.PolicyDocument({
        statements: [new iam.PolicyStatement({
          actions:   ['sns:CreatePlatformEndpoint', 'sns:Publish', 'sns:GetEndpointAttributes', 'sns:SetEndpointAttributes'],
          resources: ['*'],
        })],
      }),
    },
  })
}

function getOrCreateSharedSecurityGroup(stack: Stack, vpc: ec2.IVpc): ec2.SecurityGroup {
  const existing = stack.node.tryFindChild('SharedLambdaSg') as ec2.SecurityGroup | undefined
  if (existing) return existing
  return new ec2.SecurityGroup(stack, 'SharedLambdaSg', {
    vpc,
    description: 'Shared security group for all Lambdas in this stack',
    allowAllOutbound: true,
  })
}

export class LambdaFn extends Construct {
  public readonly fn: NodejsFunction

  constructor(scope: Construct, id: string, props: LambdaFnProps) {
    super(scope, id)

    const stack = Stack.of(this)
    const sharedRole = getOrCreateSharedRole(stack)
    const sharedSg   = getOrCreateSharedSecurityGroup(stack, props.vpc)

    this.fn = new NodejsFunction(this, 'Fn', {
      entry: props.entry,
      runtime: lambda.Runtime.NODEJS_20_X,
      role: sharedRole,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [sharedSg],
      timeout: props.timeout ?? Duration.seconds(10),
      memorySize: props.memorySize ?? 256,
      layers: props.layers,
      ephemeralStorageSize: props.ephemeralStorageSize
        ? Size.mebibytes(props.ephemeralStorageSize)
        : undefined,
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
    // props.needsSes is a no-op now — SES send is always in the shared role
  }
}
