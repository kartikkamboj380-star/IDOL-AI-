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
 *
 * The HTTP client is loaded with `await import()` rather than a static import.
 * Both are reachable from one file, so a static import would put the API client
 * and its server-side assumptions into the APK — the Android build would carry
 * code that can only ever fail. Kept dynamic, the device bundle contains the
 * engines and nothing about HTTP, which the build asserts before packaging.
 */
import type { ChatStreamHandlers, ChatRequestBody } from './api.js';
import { LocalApi, type ApiSurface } from './local-api.js';

export type { ApiSurface };

declare const __IDOL_DEVICE__: boolean | undefined;

/** True when this bundle is the offline device build. */
export const IS_DEVICE_BUILD = typeof __IDOL_DEVICE__ !== 'undefined' && __IDOL_DEVICE__ === true;

let local: LocalApi | null = null;
let resolved: ApiSurface | null = null;

/**
 * Resolves the backend once and returns it synchronously from then on.
 *
 * Call this during boot, before the first render that reads status. It is async
 * only on the server build, where it waits for the HTTP client chunk; the device
 * build has nothing to load and resolves immediately.
 */
export async function initBackend(): Promise<ApiSurface> {
  if (resolved) return resolved;
  if (IS_DEVICE_BUILD) {
    local ??= new LocalApi();
    resolved = local;
    return resolved;
  }
  const { api } = await import('./api.js');
  resolved = api as unknown as ApiSurface;
  return resolved;
}

/** The backend chosen by {@link initBackend}. Throws if boot skipped that call. */
export function backend(): ApiSurface {
  if (!resolved) throw new Error('backend() called before initBackend()');
  return resolved;
}

/** The on-device implementation, or null in a server build. */
export function localBackend(): LocalApi | null {
  return IS_DEVICE_BUILD ? (local ??= new LocalApi()) : null;
}

export async function streamAnswer(body: ChatRequestBody, handlers: ChatStreamHandlers): Promise<void> {
  if (IS_DEVICE_BUILD) {
    await (local ??= new LocalApi()).streamChat(body, handlers);
    return;
  }
  const { streamChat } = await import('./api.js');
  await streamChat(body, handlers);
}
