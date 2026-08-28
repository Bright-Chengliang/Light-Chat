import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [activity, payload, appSource, navigation] = await Promise.all([
  readFile(new URL('../android/app/src/main/java/top/brightcl/lightchat/MainActivity.java', import.meta.url), 'utf8'),
  readFile(new URL('../android/app/src/main/java/top/brightcl/lightchat/DownloadPayload.java', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../android/app/src/main/java/top/brightcl/lightchat/TrustedNavigation.java', import.meta.url), 'utf8'),
]);

test('Android saves trusted page-generated conversation exports without trusting arbitrary blob navigation', () => {
  assert.match(appSource, /globalThis\.LightChatDownloads/);
  assert.match(appSource, /nativeDownloads\.saveBase64File\(fileName, blob\.type/);
  assert.match(activity, /addJavascriptInterface\(new SecureDownloadBridge\(\), "LightChatDownloads"\)/);
  assert.match(activity, /TrustedNavigation\.isTrusted\(Uri\.parse\(current\), trustedHost\)/);
  assert.match(activity, /MediaStore\.Downloads\.EXTERNAL_CONTENT_URI/);
  assert.match(activity, /DownloadPayload\.decode\(base64Data\)/);
  assert.match(payload, /MAX_BYTES = 64 \* 1024 \* 1024/);
  assert.doesNotMatch(navigation, /blob/i);
});
