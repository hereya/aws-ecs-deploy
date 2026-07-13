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
