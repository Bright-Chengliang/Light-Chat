import assert from 'node:assert/strict';
import test from 'node:test';
import { testing } from '../lib/app.mjs';

const { isAllowedHost } = testing;

test('wildcard host entry lifts the check for reverse-proxy access', () => {
  const hosts = new Set(['*']);
  assert.equal(isAllowedHost('127.0.0.1:3020', hosts, 3088), true);
  assert.equal(isAllowedHost('chat.brightcl.top', hosts, 3088), true);
  assert.equal(isAllowedHost('120.79.28.138:8080', hosts, 3088), true);
  assert.equal(isAllowedHost('bad host', hosts, 3088), false);
  assert.equal(isAllowedHost('user@evil.com', hosts, 3088), false);
});

test('exact host entries still reject unknown hosts by default', () => {
  const hosts = new Set(['127.0.0.1:3088', 'localhost:3088']);
  assert.equal(isAllowedHost('127.0.0.1:3088', hosts, 3088), true);
  assert.equal(isAllowedHost('localhost:3088', hosts, 3088), true);
  assert.equal(isAllowedHost('chat.brightcl.top', hosts, 3088), false);
});
