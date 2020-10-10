# Cross Account Plugin for AWS CDK

The [AWS CDK](https://docs.aws.amazon.com/cdk/index.html) is great. However, some complicated authentication schemes are not supported natively, but can be implemented using [plugins](https://docs.aws.amazon.com/cdk/api/latest/typescript/api/aws-cdk/plugin.html). For client work, I needed to be able to support multiple profiles, each with a different IAM role to assume, and MFA in one shot. 

There other community projects with CDK authentication plugins. Inexplicably they did not work, and in the course of studying the code for debugging, I ended up creating my own plugin that worked the way I wanted.

**Prior Art:** [CDK plugins on NPM](https://www.npmjs.com/search?q=cdk%20plugin)

## Background

So what does this do? I have my `$HOME/.aws/config` set up with profiles for client environments. Those profiles include assuming an IAM role in a given account, and an associated MFA challenge. At a basic level, using the AWS_PROFILE=**** environment variable for command line work in connection with the CLI works fine for simple tasks. For complex multi-account projects using the CDK, the AWS_PROFILE variable falls short.

In a CDK project, I may have several accounts set up as shown:

```python
# Define environments
env_development = core.Environment(
    account=context_group_dev.account_id,
    region=context_group_dev.region)

env_production = core.Environment(
    account=context_group_prod.account_id,
    region=context_group_prod.region)
```

When using this cross account plugin, the CDK will evaluate which accounts are being accessed depending which stacks I am requesting to deploy, and according to the plugin configuration will try to obtain credentials for each account using a matching profile from `$HOME/.aws/config`. IAM role assumption and MFA are all supported. The instructions below will show how to associate an account ID with a profile name.

An added bonus is that this plugin _will locally cache the session token for 1 hour_ so that you do not need to repeatedly enter the MFA challenge token. Great for CDK debugging and iterating on stacks.

One caveat is to be aware of _cross-account_ _cross-stack_ references are not supported with CloudFormation. The temptation is real thinking you can get away with it, but CDK will sort it out and throw an error. So if you have a resource in one account that supports sharing across boundaries to another account, consider moving those outputs to context variables instead of relying on CDK output autowiring.

## How to Use

### Step 1

Assuming you have already installed the CDK, the plugin can be installed with `npm i -g cdk-cross-account-plugin aws-sdk`. This also assumes that you have `config` and `credentials` configured the way you want in `$HOME/.aws`.

### Step 2

Update `cdk.json` by adding a `plugin` array property, and a `crossAccountConfig` block. Example:

```javascript
{
  "app": "python3 app.py",

  // Active the plugin
  "plugin": ["cdk-cross-account-plugin"],

  // Add the "crossAccountConfig" block to map to each AWS account number
  // that you will be deploying resources to
  "crossAccountConfig": {
    "account-id-1": {
      "profile": "dev" // The name of the profile for obtaining session credentials
    },
    "account-id-2": {
      "profile": "prod"
    }   
  },
  
  // Other stuff like existing context values
}
```

## Debugging

`export DEBUG=cdk-cross-account-plugin` to activate internal logging of plugin activity to the command line.

## Roadmap

* Will be looking into if AWS SSO can be supported