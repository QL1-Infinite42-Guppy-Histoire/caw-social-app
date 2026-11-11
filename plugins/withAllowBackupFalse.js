/**
 * Config plugin (v0.5.0-fix, audit S1): pin
 * android:allowBackup="false" in the generated
 * AndroidManifest.xml.
 *
 * expo-secure-store keeps the wallet secret and the X
 * tokens device-bound (WHEN_UNLOCKED_THIS_DEVICE_ONLY), so
 * a cloud/device-transfer backup could never restore them —
 * but Android backup could still carry the app's plain
 * storage (flow state, settings) to another device or
 * account. Backups are OFF, explicitly, both here and via
 * expo.android.allowBackup in app.json: whichever mechanism
 * a given build path honours, the manifest ends up the
 * same.
 */
const { withAndroidManifest } = require('expo/config-plugins');

function withAllowBackupFalse(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application[0];
    app.$['android:allowBackup'] = 'false';
    return config;
  });
}

module.exports = withAllowBackupFalse;
