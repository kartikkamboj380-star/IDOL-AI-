/**
 * Build-time constants substituted by Vite (`define` in vite.config.ts).
 *
 * Declared once here rather than per-file: `tsc -p web/tsconfig.json` is run on
 * its own in CI, and a `declare const` inside a module is not visible to the
 * files that import it.
 */

/** True in the offline device build (the Android APK), false otherwise. */
declare const __IDOL_DEVICE__: boolean | undefined;
