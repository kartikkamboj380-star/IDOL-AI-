/**
 * Optional extra CA support for outbound HTTPS (GitHub, inference providers).
 *
 * `NODE_EXTRA_CA_CERTS` only takes effect at process start; this module lets
 * the running process trust the same bundle. Verification is never disabled:
 * certificates are *added* to the trust store.
 *
 * Security notes:
 *  - Only PEM file paths from trusted environment variables are read.
 *  - Nothing here is reachable from the browser or the API.
 */
import fs from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import type { Logger } from '../logger.js';

let installed = false;

export function installExtraCaCerts(logger: Logger): void {
  if (installed) return;
  installed = true;

  const candidates = new Set<string>();
  for (const name of ['NODE_EXTRA_CA_CERTS', 'IDOL_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE']) {
    const value = process.env[name];
    if (value && value.trim()) candidates.add(value.trim());
  }
  if (candidates.size === 0) return;

  const extra: string[] = [];
  for (const file of candidates) {
    try {
      const pem = fs.readFileSync(file, 'utf8');
      if (pem.includes('BEGIN CERTIFICATE')) {
        extra.push(pem);
        logger.info('trusting additional CA certificate bundle', { file });
      }
    } catch (error) {
      logger.warn('could not read extra CA bundle', { file, error });
    }
  }
  if (extra.length === 0) return;

  const bundle = [tls.rootCertificates.join('\n'), ...extra].join('\n');
  const previous = https.globalAgent as https.Agent;
  https.globalAgent = new https.Agent({
    ca: bundle,
    keepAlive: true,
    maxSockets: 16,
  });
  if (typeof previous?.destroy === 'function') {
    // Let in-flight requests finish; the new agent takes over for new ones.
    setTimeout(() => previous.destroy(), 30_000).unref?.();
  }
  logger.info('outbound HTTPS now trusts the additional CA bundle', { certificates: extra.length });
}
