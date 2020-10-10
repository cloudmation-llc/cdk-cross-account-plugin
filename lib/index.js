"use strict";
const aws_sdk_1 = require("aws-sdk");
const fs_1 = require("fs");
const dot_prop_1 = require("dot-prop");
const inquirer_1 = require("inquirer");
const conf_1 = require("conf");
const debug_1 = require("debug");
const log = debug_1.default('cdk-cross-account-plugin');
/**
 * Utility function to ask the user for an MFA code
 * @param mfaSerial
 * @param callback
 */
function getTokenCode(profileName, mfaSerial, callback) {
    // Prompt the user to enter an MFA token from a configured device
    inquirer_1.prompt([
        {
            type: 'string',
            name: 'tokenCode',
            message: `Enter the MFA code for ${mfaSerial} (profile: ${profileName})`
        }
    ])
        .then(answers => callback(null, answers.tokenCode))
        .catch(error => callback(error));
}
/**
 * The CredentialProviderSource is the core of the plugin, and contains behavior to resolve
 * AWS credentials based on an account ID.
 */
class CrossAccountCredentialProvider {
    constructor() {
        this.pluginConfig = new conf_1.default();
    }
    isAvailable() {
        return Promise.resolve(true);
    }
    canProvideCredentials(accountId) {
        // Load cdk.json if found
        let pathCdkConfig = `${process.cwd()}/cdk.json`;
        if (fs_1.existsSync('cdk.json')) {
            // Parse cdk.json
            this.cdkConfig = JSON.parse(fs_1.readFileSync(pathCdkConfig, { encoding: 'utf8' }));
            // Check that a cross account configuration exists in any form
            this.crossAccountConfig = dot_prop_1.get(this.cdkConfig, `crossAccountConfig`, undefined);
            if (this.crossAccountConfig === undefined) {
                // Bail out if there is no configuration
                return Promise.resolve(false);
            }
            log(`Found cross account plugin config %o`, this.crossAccountConfig);
            // Check if a config exists for the requested account
            if (dot_prop_1.has(this.crossAccountConfig, accountId)) {
                log(`Found config for account ${accountId}`);
                return Promise.resolve(true);
            }
        }
        return Promise.resolve(false);
    }
    getProvider(accountId, mode) {
        // Get the config by account ID
        let config = dot_prop_1.get(this.crossAccountConfig, accountId);
        // Determine how to resolve the credentials
        if (config.profile) {
            return this.resolveWithProfile(config.profile);
        }
    }
    resolveWithProfile(profileName) {
        log(`Resolving credentials with named profile ${profileName}`);
        // Check for cached credentials
        if (this.pluginConfig.has(`credentialCache.${profileName}`)) {
            // Check if cached credentials are expired
            let cachedCredentials = this.pluginConfig.get(`credentialCache.${profileName}`);
            let now = new Date().getTime();
            let expires = new Date(cachedCredentials.expireTime).getTime();
            if (now < expires) {
                log(`Using existing valid cached credentials`);
                return Promise.resolve(new aws_sdk_1.Credentials({
                    accessKeyId: cachedCredentials.accessKeyId,
                    secretAccessKey: cachedCredentials.secretAccessKey,
                    sessionToken: cachedCredentials.sessionToken
                }));
            }
            log(`Cached credentials have expired`);
        }
        // Create provider with defaults
        let provider = new aws_sdk_1.SharedIniFileCredentials({
            profile: profileName,
            tokenCodeFn: getTokenCode.bind(null, profileName)
        });
        // Resolve credentials
        return provider
            .getPromise()
            .then(() => {
            // Cache in local config
            this.pluginConfig.set(`credentialCache.${profileName}.accessKeyId`, provider.accessKeyId);
            this.pluginConfig.set(`credentialCache.${profileName}.secretAccessKey`, provider.secretAccessKey);
            this.pluginConfig.set(`credentialCache.${profileName}.sessionToken`, provider.sessionToken);
            this.pluginConfig.set(`credentialCache.${profileName}.expireTime`, provider.expireTime.toISOString());
            log(`Saved new credentials to local plugin cache ${this.pluginConfig.path}`);
            // Return credentials to the CDK
            return new aws_sdk_1.Credentials({
                accessKeyId: provider.accessKeyId,
                secretAccessKey: provider.secretAccessKey,
                sessionToken: provider.sessionToken
            });
        });
    }
}
/**
 * The CDK plugin.
 */
class CrossAccountCDKPlugin {
    constructor() {
        this.version = '1';
    }
    init(host) {
        log(`Loading cross account CDK plugin`);
        host.registerCredentialProviderSource(new CrossAccountCredentialProvider());
    }
}
module.exports = new CrossAccountCDKPlugin();
