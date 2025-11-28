import * as cdk from "aws-cdk-lib";
import { SecretValue } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import * as assets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsp from "aws-cdk-lib/aws-ecs-patterns";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";

export class AwsEcsDeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpcId: string | undefined = process.env["vpcId"];
    const healthCheckPath: string = process.env["healthCheckPath"] ?? "/";
    const cpu: number | undefined = process.env["cpu"]
      ? parseInt(process.env["cpu"])
      : undefined;
    const memoryMiB: number | undefined = process.env["memoryMiB"]
      ? parseInt(process.env["memoryMiB"])
      : undefined;
    const customDomain: string | undefined = process.env["customDomain"];
    const customDomainZone: string | undefined =
      process.env["customDomainZone"] ?? extractDomainZone(customDomain);
    const env = JSON.parse(process.env["hereyaProjectEnv"] ?? ("{}" as string));
    const hereyaProjectRootDir: string = process.env[
      "hereyaProjectRootDir"
    ] as string;
    if (!hereyaProjectRootDir) {
      throw new Error("hereyaProjectRootDir context variable is required");
    }

    // Look up the VPC using the parameter value
    const vpc = vpcId
      ? Vpc.fromLookup(this, "MyVpc", {
          vpcId,
        })
      : Vpc.fromLookup(this, "MyVpc", {
          isDefault: true,
        });

    const policyEnv = Object.fromEntries(
      Object.entries(env).filter(([key]) =>
        key.startsWith("IAM_POLICY_") || key.startsWith("iamPolicy")
      )
    );

    const nonPolicyEnv = Object.fromEntries(
      Object.entries(env).filter(([key]) => !key.startsWith("IAM_POLICY_") && !key.startsWith("iamPolicy"))
    );

    const secretEnv = Object.fromEntries(
      Object.entries(nonPolicyEnv)
        .filter(([, value]) => (value as string).startsWith("secret://"))
        .map(([key, value]) => {
          const plainValue = (value as string).split("secret://")[1];

          const secret = new secrets.Secret(this, key, {
            secretName: `/${this.stackName}/${key}`,
            secretStringValue: SecretValue.unsafePlainText(plainValue),
          });
          return [key, ecs.Secret.fromSecretsManager(secret)];
        })
    );
    const plainEnv = Object.fromEntries(
      Object.entries(nonPolicyEnv).filter(
        ([, value]) => !(value as string).startsWith("secret://")
      )
    );

    const asset = new assets.DockerImageAsset(this, "MyDockerImage", {
      directory: hereyaProjectRootDir,
    });

    const cluster = new ecs.Cluster(this, "MyCluster", {
      clusterName: "my-cluster",
      vpc,
    });

    const hostedZone =
      customDomainZone && customDomain
        ? route53.HostedZone.fromLookup(this, "HostedZone", {
            domainName: customDomainZone,
          })
        : undefined;

    const certificate =
      hostedZone && customDomain
        ? new acm.Certificate(this, "Certificate", {
            domainName: customDomain,
            validation: acm.CertificateValidation.fromDns(hostedZone),
          })
        : undefined;

    const service = new ecsp.ApplicationLoadBalancedFargateService(
      this,
      "MyWebServer",
      {
        cluster,
        assignPublicIp: true,
        memoryLimitMiB: memoryMiB ?? 1024,
        cpu: cpu ?? 512,
        taskImageOptions: {
          image: ecs.ContainerImage.fromDockerImageAsset(asset),
          containerPort: 8080,
          environment: {
            PORT: "8080",
            ...plainEnv,
          },
          secrets: secretEnv,
        },
        publicLoadBalancer: true,
        domainName: customDomain,
        domainZone: hostedZone,
        certificate: certificate,
        deploymentController: {
          type: ecs.DeploymentControllerType.ECS,
        },
        minHealthyPercent: 50,
        maxHealthyPercent: 200,
      }
    );

    Object.entries(policyEnv).forEach(([, value]) => {
      const policy = JSON.parse(value as string);
      for (const statement of policy.Statement) {
        service.taskDefinition.taskRole.addToPrincipalPolicy(
          iam.PolicyStatement.fromJson(statement)
        );
      }
    });

    service.targetGroup.configureHealthCheck({
      path: healthCheckPath,
    });

    new cdk.CfnOutput(this, "ServiceUrl", {
      value:
        customDomain && hostedZone
          ? `https://${customDomain}`
          : `http://${service.loadBalancer.loadBalancerDnsName}`,
    });
  }
}
function extractDomainZone(
  customDomain: string | undefined
): string | undefined {
  if (!customDomain) {
    return undefined;
  }

  const parts = customDomain.split(".");
  if (parts.length <= 2) {
    throw new Error("Apex domain is not supported: " + customDomain);
  }

  return parts.slice(1).join(".");
}
