// Runs after electron-packager: closes Electron's "run my code as this app" doors and re-seals the bundle,
// so no other process can borrow Vaultfill's identity (Keychain access to the safeStorage key).
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const { execFileSync } = require('node:child_process');

const app = process.argv[2] || 'dist/Vaultfill-darwin-arm64/Vaultfill.app';
flipFuses(app, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,                         // ELECTRON_RUN_AS_NODE
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, // NODE_OPTIONS
  [FuseV1Options.EnableNodeCliInspectArguments]: false,     // --inspect
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
}).then(() => {
  // shortcut: ad-hoc signature (seals all resources incl. app.asar); a Developer ID + notarization is better for distribution
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log('hardened', app);
});
