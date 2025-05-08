#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsEcsDeployStack } from '../lib/aws-ecs-deploy-stack';

const app = new cdk.App();
new AwsEcsDeployStack(app, process.env.STACK_NAME!, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});