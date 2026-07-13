# hereya/aws-ecs-deploy

Deploys a containerized application to AWS ECS Fargate with an Application Load Balancer, optional HTTPS, custom domain, secret management, and IAM policy attachment.

## Installation

```bash
hereya add hereya/aws-ecs-deploy
```

## Configuration

| Parameter | Description | Default |
|---|---|---|
| `vpcId` | VPC ID to deploy into | Default VPC |
| `healthCheckPath` | ALB health check endpoint | `/` |
| `cpu` | Fargate CPU units | `512` |
| `memoryMiB` | Memory in MiB | `1024` |
| `desiredCount` | Number of tasks | `1` |
| `customDomain` | Custom domain(s), comma-separated | — |
| `customDomainZone` | Route 53 hosted zone name | Auto-detected from domain |
| `clusterName` | ECS cluster name | Auto-generated |
| `albIdleTimeout` | ALB idle timeout in seconds (raise for slow/large uploads) | AWS default (60) |
| `deregistrationDelay` | Target group connection-draining delay in seconds | AWS default (300) |
| `healthCheckInterval` | Seconds between target-group health checks | AWS default (30) |
| `healthCheckTimeout` | Health-check response timeout in seconds (must be < interval) | AWS default (5) |
| `healthyThresholdCount` | Consecutive successes to mark a task healthy | AWS default (5) |
| `unhealthyThresholdCount` | Consecutive failures to mark a task unhealthy | AWS default (2) |
| `healthCheckGracePeriod` | ECS grace period (seconds) before health checks can fail a task | AWS default (60) |

## Features

### Deployment tuning

`deregistrationDelay` controls how long the load balancer keeps draining connections to an old task before it is fully removed during a rolling deploy. The AWS default is **300s**, and because ECS waits for old tasks to finish draining before reporting the service as stable, that default dominates deploy time. Lowering it (e.g. `60`–`120`) makes deploys finish faster. Keep it comfortably above your longest expected request so in-flight requests still complete during a deploy. Left unset, the AWS default is preserved.

The **health-check** knobs govern how fast a fresh task reaches steady-state. With the AWS defaults (interval `30s` × healthy threshold `5`) a new task takes ~150s to be marked healthy, and ECS waits for that before the service is stable — so this usually dominates rolling-deploy time. Lowering `healthCheckInterval` (e.g. `15`) and `healthyThresholdCount` (e.g. `2`) marks tasks healthy in ~30s. `healthCheckTimeout` must stay below `healthCheckInterval`. Set `healthCheckGracePeriod` comfortably above container boot + first-healthy time (e.g. `120`) so ECS doesn't kill a still-booting task and churn a replacement mid-deploy. All are left at AWS defaults when unset.

### Custom Domain & HTTPS

Set `customDomain` to automatically provision an ACM certificate validated via Route 53 DNS, with HTTP-to-HTTPS redirect. Supports multiple domains (comma-separated), with the first used as the primary.

### Secret Management

Environment variables prefixed with `secret://` are automatically stored in AWS Secrets Manager and injected securely into the container.

### IAM Policies

Environment variables prefixed with `IAM_POLICY_` or `iamPolicy` are parsed as JSON IAM policy documents and attached to the ECS task role.
