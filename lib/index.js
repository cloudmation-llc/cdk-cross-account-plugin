"use strict";
const aws_sdk_1 = require("aws-sdk");
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const dot_prop_1 = require("dot-prop");
const inquirer_1 = require("inquirer");
const fs_jetpack_1 = require("fs-jetpack");
const date_fns_1 = require("date-fns");
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
        // Determine the method to use for resolving credentials
        if (config.profile) {
            // Use a named profile
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
                let timeRemaining = date_fns_1.formatDistance(now, expires);
                log(`Using existing valid cached credentials (expires in ${timeRemaining})`);
                return Promise.resolve(new aws_sdk_1.Credentials({
                    accessKeyId: cachedCredentials.accessKeyId,
                    secretAccessKey: cachedCredentials.secretAccessKey,
                    sessionToken: cachedCredentials.sessionToken
                }));
            }
            log(`Cached credentials have expired`);
        }
        // Load locally defined AWS profiles
        let profileLoader = new aws_sdk_1.IniLoader();
        let profiles = profileLoader.loadFrom({ isConfig: true });
        let profile = profiles[profileName];
        // Validate
        if (profile === undefined) {
            return Promise.reject(new Error(`Unable to find AWS named config profile ${profileName}`));
        }
        // Determine if SSO is used for authentication
        if (profile.sso_start_url) {
            // Resolve and validate SSO cache directory created by v2 CLI
            let ssoCacheDirectory = path_1.resolve(os_1.homedir(), '.aws', 'sso', 'cache');
            log(`Checking SSO cache directory ${ssoCacheDirectory}`);
            if (!(fs_1.existsSync(ssoCacheDirectory))) {
                return Promise.reject(new Error(`SSO cache directory not found - have you logged into AWS SSO first?`));
            }
            log(`SSO cache directory found (possibly logged in)`);
            // Search .json files that contain cached tokens (ignoring botocore files)
            let ssoToken = fs_jetpack_1.find(ssoCacheDirectory, { matching: ['*.json', '!botocore*'], recursive: false })
                .map(path => fs_jetpack_1.read(path, 'json'))
                .find(cachedToken => {
                // Parse expiration date
                cachedToken.expiresAtNative = new Date(cachedToken.expiresAt.replace('UTC', '+00:00'));
                cachedToken.now = new Date();
                // Match for SSO start URL and token is not expired
                return cachedToken.startUrl === profile.sso_start_url
                    && cachedToken.region === profile.sso_region
                    && cachedToken.now < cachedToken.expiresAtNative;
            });
            // Validate
            if (ssoToken === undefined) {
                return Promise.reject(new Error(`SSO session for ${profile.sso_start_url} is expired - have you logged into AWS SSO first?`));
            }
            // Create SSO client
            let ssoClient = new aws_sdk_1.SSO({
                region: profile.sso_region
            });
            // Resolve STS credentials from SSO service
            return ssoClient
                .getRoleCredentials({
                roleName: profile.sso_role_name,
                accountId: profile.sso_account_id,
                accessToken: ssoToken.accessToken
            })
                .promise()
                .then(response => {
                // Cache in local config
                this.pluginConfig.set(`credentialCache.${profileName}.accessKeyId`, response.roleCredentials.accessKeyId);
                this.pluginConfig.set(`credentialCache.${profileName}.secretAccessKey`, response.roleCredentials.secretAccessKey);
                this.pluginConfig.set(`credentialCache.${profileName}.sessionToken`, response.roleCredentials.sessionToken);
                this.pluginConfig.set(`credentialCache.${profileName}.expireTime`, ssoToken.expiresAtNative.toISOString());
                log(`Saved new credentials to local plugin cache ${this.pluginConfig.path}`);
                return new aws_sdk_1.Credentials({
                    accessKeyId: response.roleCredentials.accessKeyId,
                    secretAccessKey: response.roleCredentials.secretAccessKey,
                    sessionToken: response.roleCredentials.sessionToken
                });
            });
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
