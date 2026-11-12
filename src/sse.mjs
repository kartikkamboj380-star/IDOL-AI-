export function splitSse(buffer) {
  const normalized = buffer.replaceAll('\r\n', '\n');
  const parts = normalized.split('\n\n');
  return { events: parts.slice(0, -1), rest: parts.at(-1) ?? '' };
}
