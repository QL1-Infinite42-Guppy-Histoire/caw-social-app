import Constants from 'expo-constants';

/**
 * The running app's version, read from app.json (expo.version) via
 * expo-constants at runtime. Never hardcode a version string in the
 * UI: v0.1.3 still showed a stale "v0.1.0" in Settings because the
 * string was written literally there (fixed in v0.1.4).
 *
 * This lives in its own UI-layer module because config.ts must stay
 * loadable by the plain-Node verification harness, which cannot
 * resolve Expo runtime packages.
 */
export const APP_VERSION: string =
  Constants.expoConfig?.version ?? Constants.nativeAppVersion ?? '';
