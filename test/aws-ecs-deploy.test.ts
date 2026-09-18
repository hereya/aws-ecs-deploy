import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { AwsEcsDeployStack } from "../lib/aws-ecs-deploy-stack";

// A directory containing a Dockerfile is required because the stack builds a
// DockerImageAsset from `hereyaProjectRootDir`. The asset is only hashed (not
// built) during synth, so a minimal Dockerfile is enough.
const DOCKER_CONTEXT = path.join(__dirname, "fixtures", "docker-context");

const BASE_ENV: Record<string, string> = {
  hereyaProjectRootDir: DOCKER_CONTEXT,
  hereyaProjectEnv: "{}",
};

function synth(extraEnv: Record<string, string> = {}): Template {
  process.env = { ...process.env, ...BASE_ENV, ...extraEnv };
  const app = new cdk.App();
  const stack = new AwsEcsDeployStack(app, "TestStack", {
    env: { account: "123456789012", region: "eu-west-1" },
  });
  return Template.fromStack(stack);
}

describe("AwsEcsDeployStack deployment tuning", () => {
  const savedEnv = process.env;
  afterEach(() => {
    process.env = savedEnv;
  });

  test("sets target group deregistration delay when deregistrationDelay is provided", () => {
    const template = synth({ deregistrationDelay: "60" });
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      TargetGroupAttributes: Match.arrayWith([
        Match.objectLike({
          Key: "deregistration_delay.timeout_seconds",
          Value: "60",
        }),
      ]),
    });
  });

  test("does not override deregistration delay when unset (AWS default preserved)", () => {
    const template = synth();
    const targetGroups = template.findResources(
      "AWS::ElasticLoadBalancingV2::TargetGroup"
    );
    for (const tg of Object.values(targetGroups)) {
      const attrs = (tg.Properties?.TargetGroupAttributes ?? []) as Array<{
        Key: string;
      }>;
      expect(
        attrs.some((a) => a.Key === "deregistration_delay.timeout_seconds")
      ).toBe(false);
    }
  });

  test("tunes target group health check when knobs are provided", () => {
    const template = synth({
      healthCheckInterval: "15",
      healthCheckTimeout: "5",
      healthyThresholdCount: "2",
      unhealthyThresholdCount: "2",
    });
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      HealthCheckIntervalSeconds: 15,
      HealthCheckTimeoutSeconds: 5,
      HealthyThresholdCount: 2,
      UnhealthyThresholdCount: 2,
    });
  });

  test("does not set health check overrides when unset (AWS defaults preserved)", () => {
    const template = synth();
    const targetGroups = template.findResources(
      "AWS::ElasticLoadBalancingV2::TargetGroup"
    );
    for (const tg of Object.values(targetGroups)) {
      const props = tg.Properties ?? {};
      expect(props.HealthCheckIntervalSeconds).toBeUndefined();
      expect(props.HealthCheckTimeoutSeconds).toBeUndefined();
      expect(props.HealthyThresholdCount).toBeUndefined();
      expect(props.UnhealthyThresholdCount).toBeUndefined();
    }
  });

  test("sets ECS health check grace period when provided", () => {
    const template = synth({ healthCheckGracePeriod: "120" });
    template.hasResourceProperties("AWS::ECS::Service", {
      HealthCheckGracePeriodSeconds: 120,
    });
  });
});

const CERT_ARN =
  "arn:aws:acm:eu-west-1:123456789012:certificate/11111111-2222-3333-4444-555555555555";
const CUSTOMER_CERT_ARN =
  "arn:aws:acm:eu-west-1:123456789012:certificate/99999999-8888-7777-6666-555555555555";

describe("AwsEcsDeployStack custom domains", () => {
  const savedEnv = process.env;
  afterEach(() => {
    process.env = savedEnv;
  });

  test("issues one certificate covering every domain and records them all (unchanged behaviour)", () => {
    const template = synth({
      customDomain: "app.curanet.dev,api.curanet.dev",
    });
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "app.curanet.dev",
      SubjectAlternativeNames: ["api.curanet.dev"],
    });
    const records = template.findResources("AWS::Route53::RecordSet");
    const names = Object.values(records).map((r) => r.Properties?.Name);
    expect(names).toEqual(
      expect.arrayContaining(["app.curanet.dev.", "api.curanet.dev."])
    );
  });

  test("a domain outside our zone is served but gets NO record in our zone", () => {
    const template = synth({
      customDomain: "app.curanet.dev,app.royalonyx.com",
    });
    const records = template.findResources("AWS::Route53::RecordSet");
    const names = Object.values(records).map((r) => r.Properties?.Name);
    expect(names).toEqual(expect.arrayContaining(["app.curanet.dev."]));
    expect(names).not.toEqual(
      expect.arrayContaining(["app.royalonyx.com."])
    );
  });

  test("attaches customer certificates to the HTTPS listener (no manual step)", () => {
    const template = synth({
      customDomain: "app.curanet.dev",
      additionalCertificateArns: CUSTOMER_CERT_ARN,
    });
    template.hasResourceProperties(
      "AWS::ElasticLoadBalancingV2::ListenerCertificate",
      {
        Certificates: [{ CertificateArn: CUSTOMER_CERT_ARN }],
      }
    );
  });

  test("no listener certificate resource when none is configured", () => {
    const template = synth({ customDomain: "app.curanet.dev" });
    expect(
      Object.keys(
        template.findResources(
          "AWS::ElasticLoadBalancingV2::ListenerCertificate"
        )
      )
    ).toHaveLength(0);
  });

  test("a supplied certificate is used as-is, and no zone is looked up for a domain we do not host", () => {
    const template = synth({
      customDomain: "app.royalonyx.com",
      customDomainCertificateArn: CERT_ARN,
    });
    expect(
      Object.keys(
        template.findResources("AWS::CertificateManager::Certificate")
      )
    ).toHaveLength(0);
    expect(
      Object.keys(template.findResources("AWS::Route53::RecordSet"))
    ).toHaveLength(0);
    template.hasResourceProperties(
      "AWS::ElasticLoadBalancingV2::Listener",
      {
        Certificates: [{ CertificateArn: CERT_ARN }],
        Port: 443,
      }
    );
  });

  test("customer certificates without HTTPS are refused rather than silently ignored", () => {
    expect(() => synth({ additionalCertificateArns: CUSTOMER_CERT_ARN })).toThrow(
      /requires HTTPS/
    );
  });

  test("always publishes the load balancer DNS name a customer must point at", () => {
    const template = synth({ customDomain: "app.curanet.dev" });
    const outputs = template.findOutputs("*");
    expect(Object.keys(outputs)).toEqual(
      expect.arrayContaining(["LoadBalancerDnsName"])
    );
  });
});
