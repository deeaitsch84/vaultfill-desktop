// Runs after electron-packager: closes Electron's "run my code as this app" doors, then signs.
//   default:                ad-hoc signature (local use)
//   VF_SIGN_IDENTITY="Developer ID Application: Name (TEAMID)"  → hardened runtime signature
//   + VF_NOTARY_PROFILE=<notarytool keychain profile>           → notarize, staple, zip for distribution
//   + or VF_NOTARY_KEY=<AuthKey.p8 path>, VF_NOTARY_KEY_ID, VF_NOTARY_ISSUER (App Store Connect API key, for CI)
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const { sign } = require('@electron/osx-sign');
const { notarize } = require('@electron/notarize');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const app = process.argv[2] || 'dist/Vaultfill-darwin-arm64/Vaultfill.app';
const identity = process.env.VF_SIGN_IDENTITY;
const { VF_NOTARY_PROFILE: profile, VF_NOTARY_KEY: apiKey, VF_NOTARY_KEY_ID: apiKeyId, VF_NOTARY_ISSUER: apiIssuer } = process.env;
const notaryAuth = profile ? { keychainProfile: profile }
  : apiKey ? { appleApiKey: apiKey, appleApiKeyId: apiKeyId, appleApiIssuer: apiIssuer } : null;

(async () => {
  // fuses first: flipping rewrites the Electron binary, which would break a signature made before
  await flipFuses(app, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,                            // ELECTRON_RUN_AS_NODE
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, // NODE_OPTIONS
    [FuseV1Options.EnableNodeCliInspectArguments]: false,        // --inspect
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  if (!identity) {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    return console.log('ad-hoc signed', app);
  }
  const entitlements = join(__dirname, '../build/entitlements.plist');
  await sign({ app, identity, optionsForFile: () => ({ hardenedRuntime: true, entitlements }) });
  console.log('signed with', identity);
  if (!notaryAuth) return;
  await notarize({ appPath: app, ...notaryAuth }); // also staples the ticket
  const zip = `${app.replace(/\.app$/, '')}.zip`;
  execFileSync('ditto', ['-c', '-k', '--keepParent', app, zip]);
  console.log('notarized →', zip);
})().catch((e) => { console.error(e); process.exit(1); });
