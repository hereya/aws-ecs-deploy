import * as crypto from "crypto";
import * as cdk from "aws-cdk-lib";
import { SecretValue } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import * as assets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsp from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { Construct } from "constructs";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";

export class AwsEcsDeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpcId: string | undefined = process.env["vpcId"];
    const healthCheckPath: string = process.env["healthCheckPath"] ?? "/";
    // Optional target-group health-check tuning. Left unset keeps AWS defaults
    // (interval 30s, timeout 5s, healthy/unhealthy threshold 5/2), which make a
    // fresh task take ~150s (30s × 5) to be marked healthy and so dominate the
    // rolling-deploy time. Lower them to reach steady-state faster.
    const healthCheckInterval: number | undefined = process.env[
      "healthCheckInterval"
    ]
      ? parseInt(process.env["healthCheckInterval"], 10)
      : undefined;
    const healthCheckTimeout: number | undefined = process.env[
      "healthCheckTimeout"
    ]
      ? parseInt(process.env["healthCheckTimeout"], 10)
      : undefined;
    const healthyThresholdCount: number | undefined = process.env[
      "healthyThresholdCount"
    ]
      ? parseInt(process.env["healthyThresholdCount"], 10)
      : undefined;
    const unhealthyThresholdCount: number | undefined = process.env[
      "unhealthyThresholdCount"
    ]
      ? parseInt(process.env["unhealthyThresholdCount"], 10)
      : undefined;
    // Optional ECS health-check grace period (seconds). Must comfortably exceed
    // container boot + first-healthy time, otherwise ECS deems a still-booting
    // task unhealthy and launches a replacement (churn) mid-deploy.
    const healthCheckGracePeriod: number | undefined = process.env[
      "healthCheckGracePeriod"
    ]
      ? parseInt(process.env["healthCheckGracePeriod"], 10)
      : undefined;
    const cpu: number | undefined = process.env["cpu"]
      ? parseInt(process.env["cpu"])
      : undefined;
    const memoryMiB: number | undefined = process.env["memoryMiB"]
      ? parseInt(process.env["memoryMiB"])
      : undefined;
    const desiredCount: number | undefined = process.env["desiredCount"]
      ? parseInt(process.env["desiredCount"])
      : undefined;
    const allDomains = parseDomains(process.env["customDomain"]);
    const primaryDomain: string | undefined = allDomains[0];
    const additionalDomains: string[] = allDomains.slice(1);
    // An already-issued certificate to use INSTEAD of provisioning one here.
    // Required when no domain we serve lives in a Route 53 zone of this
    // account (e.g. the whole deployment is on a customer-owned domain):
    // DNS validation can only be automated inside a zone we control.
    const customDomainCertificateArn: string | undefined =
      process.env["customDomainCertificateArn"];
    // Extra certificates attached to the HTTPS listener (SNI). This is how a
    // customer-owned domain is served alongside ours without re-issuing our
    // own certificate: the customer validates a certificate for their domain,
    // its ARN goes here, and they point the domain at the load balancer.
    const additionalCertificateArns = parseDomains(
      process.env["additionalCertificateArns"]
    );
    // The zone is auto-detected from the primary domain ONLY when we are
    // issuing the certificate ourselves. With a supplied certificate the
    // primary domain may well be one we do not host, and guessing its zone
    // would send `HostedZone.fromLookup` after a zone this account does not
    // own - which fails the whole deploy. Then, a zone must be explicit.
    const customDomainZone: string | undefined = customDomainCertificateArn
      ? process.env["customDomainZone"]
      : process.env["customDomainZone"] ?? extractDomainZone(primaryDomain);
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

    // Hash of all secret values. Included as a plain env var on the container
    // so that any change to a secret value forces a new task definition revision
    // and a new ECS deployment (otherwise ECS keeps the old values since the
    // secret ARN reference does not change).
    const secretValuesHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(nonPolicyEnv)
            .filter(([, value]) => (value as string).startsWith("secret://"))
            .sort(([a], [b]) => a.localeCompare(b))
        )
      )
      .digest("hex")
      .slice(0, 16);

    const clusterName: string | undefined = process.env["clusterName"];

    const asset = new assets.DockerImageAsset(this, "MyDockerImage", {
      directory: hereyaProjectRootDir,
    });

    const cluster = new ecs.Cluster(this, "MyCluster", {
      ...(clusterName ? { clusterName } : {}),
      vpc,
    });

    const hostedZone =
      customDomainZone && primaryDomain
        ? route53.HostedZone.fromLookup(this, "HostedZone", {
            domainName: customDomainZone,
          })
        : undefined;

    const certificate = customDomainCertificateArn
      ? acm.Certificate.fromCertificateArn(
          this,
          "Certificate",
          customDomainCertificateArn
        )
      : hostedZone && primaryDomain
      ? new acm.Certificate(this, "Certificate", {
          domainName: primaryDomain,
          subjectAlternativeNames:
            additionalDomains.length > 0 ? additionalDomains : undefined,
          validation: acm.CertificateValidation.fromDns(hostedZone),
        })
      : undefined;

    // A domain only gets a Route 53 record if it belongs to the zone we looked
    // up. A customer-owned domain is served all the same (the listener routes
    // on the certificate, not on the host) - its DNS simply lives with the
    // customer, who aliases it to the load balancer.
    const inOurZone = (domain: string) =>
      !!customDomainZone &&
      (domain === customDomainZone || domain.endsWith(`.${customDomainZone}`));
    const primaryDomainIsOurs = !!primaryDomain && inOurZone(primaryDomain);

    const service = new ecsp.ApplicationLoadBalancedFargateService(
      this,
      "MyWebServer",
      {
        cluster,
        desiredCount,
        assignPublicIp: true,
        memoryLimitMiB: memoryMiB ?? 1024,
        cpu: cpu ?? 512,
        taskImageOptions: {
          image: ecs.ContainerImage.fromDockerImageAsset(asset),
          containerPort: 8080,
          environment: {
            PORT: "8080",
            ...plainEnv,
            HEREYA_SECRET_VERSION: secretValuesHash,
          },
          secrets: secretEnv,
        },
        publicLoadBalancer: true,
        // Only let the pattern create the primary A-record when the primary
        // domain really is in our zone; otherwise the record would be written
        // into the wrong zone.
        domainName: primaryDomainIsOurs ? primaryDomain : undefined,
        domainZone: primaryDomainIsOurs ? hostedZone : undefined,
        certificate: certificate,
        redirectHTTP: !!certificate,
        deploymentController: {
          type: ecs.DeploymentControllerType.ECS,
        },
        minHealthyPercent: 50,
        maxHealthyPercent: 200,
        ...(healthCheckGracePeriod !== undefined
          ? {
              healthCheckGracePeriod:
                cdk.Duration.seconds(healthCheckGracePeriod),
            }
          : {}),
      }
    );

    // Optionally raise the ALB idle timeout (default 60s) so slow/large uploads
    // over poor connections aren't cut mid-request. Set `albIdleTimeout`
    // (seconds) to override; left unset keeps the AWS default.
    const albIdleTimeout = process.env["albIdleTimeout"];
    if (albIdleTimeout) {
      service.loadBalancer.setAttribute(
        "idle_timeout.timeout_seconds",
        String(parseInt(albIdleTimeout, 10))
      );
    }

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
      ...(healthCheckInterval !== undefined
        ? { interval: cdk.Duration.seconds(healthCheckInterval) }
        : {}),
      ...(healthCheckTimeout !== undefined
        ? { timeout: cdk.Duration.seconds(healthCheckTimeout) }
        : {}),
      ...(healthyThresholdCount !== undefined
        ? { healthyThresholdCount }
        : {}),
      ...(unhealthyThresholdCount !== undefined
        ? { unhealthyThresholdCount }
        : {}),
    });

    // Optionally shorten the target group deregistration delay (connection
    // draining). AWS default is 300s, which dominates rolling-deploy time:
    // ECS waits the full drain of old tasks before the service is "stable".
    // Set `deregistrationDelay` (seconds) to override; left unset keeps the
    // AWS default. Keep it comfortably above the longest expected request so
    // in-flight requests still finish during a deploy.
    const deregistrationDelay = process.env["deregistrationDelay"];
    if (deregistrationDelay) {
      service.targetGroup.setAttribute(
        "deregistration_delay.timeout_seconds",
        String(parseInt(deregistrationDelay, 10))
      );
    }

    // Certificates for domains we do not own are attached to the existing
    // HTTPS listener, which serves them by SNI. This replaces the manual
    // `aws elbv2 add-listener-certificates` step that used to be required for
    // every customer domain.
    if (additionalCertificateArns.length > 0) {
      if (!certificate) {
        throw new Error(
          "additionalCertificateArns requires HTTPS: set customDomain (+ a zone) or customDomainCertificateArn"
        );
      }
      service.listener.addCertificates("AdditionalCertificates", [
        ...additionalCertificateArns.map((arn) =>
          elbv2.ListenerCertificate.fromArn(arn)
        ),
      ]);
    }

    if (hostedZone && additionalDomains.length > 0) {
      // NOTE: the construct id keeps the domain's ORIGINAL index, so adding a
      // customer domain to the list never renumbers - and so never replaces -
      // the records of the domains already deployed.
      additionalDomains.forEach((domain, index) => {
        if (!inOurZone(domain)) {
          return;
        }
        new route53.ARecord(this, `AdditionalDNS${index}`, {
          zone: hostedZone,
          recordName: domain,
          target: route53.RecordTarget.fromAlias(
            new targets.LoadBalancerTarget(service.loadBalancer)
          ),
        });
      });
    }

    new cdk.CfnOutput(this, "ServiceUrl", {
      value:
        primaryDomain && certificate
          ? `https://${primaryDomain}`
          : `http://${service.loadBalancer.loadBalancerDnsName}`,
    });

    if (additionalDomains.length > 0 && certificate) {
      new cdk.CfnOutput(this, "AdditionalServiceUrls", {
        value: additionalDomains.map((d) => `https://${d}`).join(","),
      });
    }

    // The value a customer needs in order to point their own domain here.
    // Always emitted: without it, onboarding a domain we do not host means
    // digging the name out of the console.
    new cdk.CfnOutput(this, "LoadBalancerDnsName", {
      value: service.loadBalancer.loadBalancerDnsName,
    });
  }
}
function parseDomains(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

function extractDomainZone(
  customDomain: string | undefined
): string | undefined {
  if (!customDomain) {
    return undefined;
  }

  const parts = customDomain.split(".");
  if (parts.length < 2) {
    throw new Error("Invalid domain name: " + customDomain);
  }

  if (parts.length === 2) {
    return customDomain;
  }

  return parts.slice(1).join(".");
}
