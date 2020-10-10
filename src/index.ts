import { CredentialProviderSource, Mode, Plugin, PluginHost } from 'aws-cdk';
import { Credentials, SharedIniFileCredentials } from 'aws-sdk';
import { existsSync, readFileSync } from 'fs';
import { get, has } from 'dot-prop';
import { prompt } from 'inquirer';
import Conf from 'conf';
import Debug from 'debug';

const log = Debug('cdk-cross-account-plugin');

/**
 * Utility function to ask the user for an MFA code
 * @param mfaSerial
 * @param callback 
 */
function getTokenCode(profileName: string, mfaSerial: string, callback: (err?: Error, token?: string) => void) {
    // Prompt the user to enter an MFA token from a configured device
    prompt([
        {
            type: 'string',
            name: 'tokenCode',
            message: `Enter the MFA code for ${mfaSerial} (profile: ${profileName})`
        }     
    ])
    .then(answers => callback(null, answers.tokenCode))
    .catch(error => callback(error))
}

/**
 * The CredentialProviderSource is the core of the plugin, and contains behavior to resolve
 * AWS credentials based on an account ID.
 */
class CrossAccountCredentialProvider implements CredentialProviderSource {
    
    name: string;
    cdkConfig: object;
    crossAccountConfig: object;
    pluginConfig: Conf;

    constructor() {
        this.pluginConfig = new Conf();
    }

    isAvailable(): Promise<boolean> {
        return Promise.resolve(true);
    }

    canProvideCredentials(accountId: string): Promise<boolean> {
        // Load cdk.json if found
        let pathCdkConfig: string = `${process.cwd()}/cdk.json`;
        if(existsSync('cdk.json')) {            
            // Parse cdk.json
            this.cdkConfig = JSON.parse(readFileSync(pathCdkConfig, { encoding: 'utf8' }));

            // Check that a cross account configuration exists in any form
            this.crossAccountConfig = get(this.cdkConfig, `crossAccountConfig`, undefined);
            if(this.crossAccountConfig === undefined) {
                // Bail out if there is no configuration
                return Promise.resolve(false);        
            }
            log(`Found cross account plugin config %o`, this.crossAccountConfig);

            // Check if a config exists for the requested account
            if(has(this.crossAccountConfig, accountId)) {
                log(`Found config for account ${accountId}`);
                return Promise.resolve(true);
            }            
        }
        
        return Promise.resolve(false);
    }

    getProvider(accountId: string, mode: Mode): Promise<Credentials> {
        // Get the config by account ID
        let config: Record<string, any> = get(this.crossAccountConfig, accountId);

        // Determine the method to use for resolving credentials
        if(config.profile) {
            // Use a named profile
            return this.resolveWithProfile(config.profile);
        }    
    }

    resolveWithProfile(profileName: string): Promise<Credentials> {
        log(`Resolving credentials with named profile ${profileName}`);

        // Check for cached credentials
        if(this.pluginConfig.has(`credentialCache.${profileName}`)) {
            // Check if cached credentials are expired
            let cachedCredentials: Record<string, any> = this.pluginConfig.get(`credentialCache.${profileName}`);
            let now: number = new Date().getTime();
            let expires: number = new Date(<string>cachedCredentials.expireTime).getTime();
            if(now < expires) {
                log(`Using existing valid cached credentials`);
                return Promise.resolve(new Credentials({
                    accessKeyId: cachedCredentials.accessKeyId,
                    secretAccessKey: cachedCredentials.secretAccessKey,
                    sessionToken: cachedCredentials.sessionToken
                }));
            }

            log(`Cached credentials have expired`);
        }

        // Create provider with defaults
        let provider: SharedIniFileCredentials = new SharedIniFileCredentials({
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
                return new Credentials({
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
class CrossAccountCDKPlugin implements Plugin { 

    public readonly version = '1';

    init(host: PluginHost) { 
        log(`Loading cross account CDK plugin`);

        host.registerCredentialProviderSource(
            new CrossAccountCredentialProvider());
    }

}

export = new CrossAccountCDKPlugin();