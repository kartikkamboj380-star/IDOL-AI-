import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSse } from '../src/sse.mjs';

test('buffers incomplete SSE frames across network chunks', () => {
  const first = splitSse('data: {"type":"del');
  assert.deepEqual(first.events, []);
  const second = splitSse(`${first.rest}ta","content":"hi"}\n\n`);
  assert.deepEqual(second.events, ['data: {"type":"delta","content":"hi"}']);
  assert.equal(second.rest, '');
});

test('accepts CRLF SSE frame boundaries', () => {
  const result = splitSse('data: {"type":"done"}\r\n\r\n');
  assert.deepEqual(result.events, ['data: {"type":"done"}']);
});
