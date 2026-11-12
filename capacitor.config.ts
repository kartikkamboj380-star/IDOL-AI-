import type { CapacitorConfig } from '@capacitor/cli';

const serverUrl = process.env.KAVRON_ANDROID_SERVER_URL?.trim();
if (serverUrl) {
  const parsed = new URL(serverUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new Error('KAVRON_ANDROID_SERVER_URL must be a bare HTTPS origin without credentials, path, query, or fragment.');
  }
}

const config: CapacitorConfig = {
  appId: 'ai.kavron.workspace',
  appName: 'KAVRON AI',
  webDir: 'dist',
  ...(serverUrl ? { server: { url: serverUrl, cleartext: false } } : {}),
};

export default config;
