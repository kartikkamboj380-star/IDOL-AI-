/**
 * Chooses where answers come from, once, at startup.
 *
 * Two builds consume this file and the app never asks which one it is running in:
 *
 *   - server build (`npm run dev`, Docker, Fly, Render): fetch `/api/*`.
 *   - device build (the Android APK, offline): run the engines in the page.
 *
 * The switch is the build flag `__IDOL_DEVICE__`, defined in vite.config.ts, not a
 * runtime probe. A probe would be a silent failure mode: if /api/status timed out
 * for any reason the app would quietly switch brains and start answering from an
 * empty corpus. A build-time constant cannot be wrong at runtime.
 */
import { api, streamChat, type ChatStreamHandlers, type ChatRequestBody } from './api.js';
import { LocalApi, type ApiSurface } from './local-api.js';

declare const __IDOL_DEVICE__: boolean | undefined;

/** True when this bundle is the offline device build. */
export const IS_DEVICE_BUILD = typeof __IDOL_DEVICE__ !== 'undefined' && __IDOL_DEVICE__ === true;

let local: LocalApi | null = null;

/** The backend the UI should talk to. */
export function backend(): ApiSurface {
  if (!IS_DEVICE_BUILD) return api as unknown as ApiSurface;
  local ??= new LocalApi();
  return local;
}

/** The on-device implementation, or null in a server build. */
export function localBackend(): LocalApi | null {
  return IS_DEVICE_BUILD ? (local ??= new LocalApi()) : null;
}

export function streamAnswer(body: ChatRequestBody, handlers: ChatStreamHandlers): Promise<void> {
  if (!IS_DEVICE_BUILD) return streamChat(body, handlers);
  return (local ??= new LocalApi()).streamChat(body, handlers);
}
