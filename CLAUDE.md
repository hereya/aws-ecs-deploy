# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Essential Commands

### Development
- `npm run build` - Compile TypeScript to JavaScript
- `npm run watch` - Watch mode for TypeScript compilation
- `npm run test` - Run Jest unit tests (note: tests are currently commented out)

### CDK Operations
- `npx cdk deploy` - Deploy the stack to AWS
- `npx cdk diff` - Compare deployed stack with current state
- `npx cdk synth` - Generate CloudFormation template
- `npx cdk destroy` - Remove the stack from AWS

## Architecture Overview

This is an AWS CDK TypeScript project that deploys containerized applications to AWS ECS Fargate. The architecture follows a simple but extensible pattern:

### Core Components
- **Entry Point**: `bin/aws-ecs-deploy.ts` - Initializes CDK app and creates stack instance
- **Stack Definition**: `lib/aws-ecs-deploy-stack.ts` - Contains all infrastructure resources
- **Key Resources**: VPC, ECS Cluster, ALB Fargate Service, Route 53, ACM Certificate, Secrets Manager

### Environment Variable Processing

The stack processes environment variables in three distinct ways:
1. **Plain Variables**: Direct key-value pairs passed to container
2. **Secret Variables**: Prefixed with `secret://` - automatically stored in AWS Secrets Manager
3. **IAM Policy Variables**: Prefixed with `IAM_POLICY_` - parsed as JSON and attached as IAM policies to the task role

### Key Configuration Points

All configuration is driven by environment variables:
- `STACK_NAME` - CDK stack name (required)
- `IMAGE_URI` - Docker image URI (required)
- `LOAD_BALANCER_NAME` - ALB name
- `CERTIFICATE_ARN` - ACM certificate for HTTPS
- `CONTAINER_PORT` - Container port (default: 8080)
- `CPU` - Fargate CPU units (default: 256)
- `MEMORY_LIMIT_MIB` - Memory in MiB (default: 512)
- `HEALTH_CHECK_PATH` - ALB health check endpoint
- `DOMAIN_NAME` - Custom domain for Route 53
- `ZONE_NAME` - Route 53 hosted zone
- `VPC_ID` - Custom VPC ID (uses default if not specified)

### Testing Approach

Tests use Jest with TypeScript support. Run a single test with:
- `npm test -- --testNamePattern="test name"`
- `npm test -- path/to/test.test.ts`

Note: Current test file needs updating to match the ECS/Fargate implementation.