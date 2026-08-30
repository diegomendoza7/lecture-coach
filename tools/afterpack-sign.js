'use strict';
/*
 * Ad-hoc code signing.
 *
 * arm64 macOS refuses to launch a binary with no signature at all, and
 * electron-builder skips signing when there is no Developer ID in the keychain.
 * So sign with the ad-hoc identity ("-") and the real entitlements: the app runs
 * locally, and the entitlement/hardened-runtime setup is identical to what a
 * notarized build will use.
 *
 * Caveat worth knowing: TCC ties Screen Recording / Camera / Microphone grants to
 * the code signature. An ad-hoc signature changes on every rebuild, so macOS may
 * ask for those permissions again after each build. A Developer ID signature is
 * stable and the grants persist.
 */
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_NAME || process.env.CSC_LINK) return;   // a real cert is in play

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlements = path.join(context.packager.projectDir, 'build', 'entitlements.mac.plist');

  execFileSync('codesign', [
    '--force', '--deep', '--sign', '-',
    '--options', 'runtime',
    '--entitlements', entitlements,
    appPath,
  ], { stdio: 'inherit' });

  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed  ${appPath}`);
};
