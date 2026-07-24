import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '../lib/session-manager.mjs';

function request(userAgent, cookie = '') {
  return {
    headers: { 'user-agent': userAgent, ...(cookie ? { cookie } : {}) },
    socket: { encrypted: true, remoteAddress: '127.0.0.1' },
  };
}

test('Android and explicitly remembered web sessions persist for 30 days without changing the default web duration', () => {
  const manager = new SessionManager({ secret: 'test-session-secret-that-is-long-enough' });
  try {
    const android = manager.create(request('Mozilla/5.0 light-chat-android/1.0'), {
      authenticated: true, username: 'mobile-user', uid: '0000000',
    });
    const web = manager.create(request('Mozilla/5.0 Chrome/126.0'), {
      authenticated: true, username: 'web-user', uid: '0000001',
    });
    const rememberedWeb = manager.create(request('Mozilla/5.0 Chrome/126.0'), {
      authenticated: true, username: 'remembered-user', uid: '0000002', remember: true,
    });
    assert.match(android.cookie, /Max-Age=2592000(?:;|$)/);
    assert.match(web.cookie, /Max-Age=43200(?:;|$)/);
    assert.match(rememberedWeb.cookie, /Max-Age=2592000(?:;|$)/);
    assert.match(android.cookie, /HttpOnly; Secure; SameSite=Strict/);
    assert.doesNotMatch(rememberedWeb.cookie, /Domain=/i);
  } finally {
    manager.close();
  }
});

test('remembered web sessions survive a service restart using only a server-side token hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'light-chat-sessions-'));
  const storagePath = join(root, 'sessions.json');
  const secret = 'test-session-secret-that-is-long-enough';
  const browserRequest = request('Mozilla/5.0 Chrome/126.0');
  const first = new SessionManager({ secret, storagePath });
  try {
    await first.initialize();
    const remembered = first.create(browserRequest, {
      authenticated: true, username: 'remembered-user', uid: '0000002', remember: true,
    });
    const ordinary = first.create(browserRequest, {
      authenticated: true, username: 'ordinary-user', uid: '0000003', remember: false,
    });
    await first.close();

    const persisted = await readFile(storagePath, 'utf8');
    assert.equal(persisted.includes(remembered.token), false);
    assert.equal(persisted.includes(ordinary.token), false);
    assert.match(persisted, /"tokenHash": "[a-f0-9]{64}"/);

    const second = new SessionManager({ secret, storagePath });
    await second.initialize();
    try {
      const restored = second.find(request('Mozilla/5.0 Chrome/126.0', `chat_session=${remembered.token}`));
      assert.equal(restored?.session.uid, '0000002');
      assert.equal(second.find(request('Mozilla/5.0 Chrome/126.0', `chat_session=${ordinary.token}`)), null);
      second.invalidateUid('0000002');
    } finally {
      await second.close();
    }

    const third = new SessionManager({ secret, storagePath });
    await third.initialize();
    try {
      assert.equal(third.find(request('Mozilla/5.0 Chrome/126.0', `chat_session=${remembered.token}`)), null);
    } finally {
      await third.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
