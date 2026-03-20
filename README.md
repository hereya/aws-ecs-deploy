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

## Features

### Custom Domain & HTTPS

Set `customDomain` to automatically provision an ACM certificate validated via Route 53 DNS, with HTTP-to-HTTPS redirect. Supports multiple domains (comma-separated), with the first used as the primary.

### Secret Management

Environment variables prefixed with `secret://` are automatically stored in AWS Secrets Manager and injected securely into the container.

### IAM Policies

Environment variables prefixed with `IAM_POLICY_` or `iamPolicy` are parsed as JSON IAM policy documents and attached to the ECS task role.
