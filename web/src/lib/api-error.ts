/**
 * The error type the HTTP client throws.
 *
 * It lives in its own module so screens can tell "the server refused" from "I
 * cannot reach it" without importing the client. That matters for the device
 * build: importing `api.ts` anywhere pulls in the whole fetch layer, and the APK
 * would carry code that can only ever fail.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
