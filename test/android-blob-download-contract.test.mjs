import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [activity, payload, appSource, navigation, appHtml] = await Promise.all([
  readFile(new URL('../android/app/src/main/java/top/brightcl/lightchat/MainActivity.java', import.meta.url), 'utf8'),
  readFile(new URL('../android/app/src/main/java/top/brightcl/lightchat/DownloadPayload.java', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../android/app/src/main/java/top/brightcl/lightchat/TrustedNavigation.java', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.html', import.meta.url), 'utf8'),
]);

test('Android saves trusted page-generated conversation exports without trusting arbitrary blob navigation', () => {
  assert.match(appSource, /globalThis\.LightChatDownloads/);
  assert.match(appSource, /nativeDownloads\.saveBase64File\(fileName, blob\.type/);
  assert.match(activity, /addJavascriptInterface\(new SecureDownloadBridge\(\), "LightChatDownloads"\)/);
  assert.match(activity, /TrustedNavigation\.isTrusted/);
  assert.match(activity, /MediaStore\.Downloads\.EXTERNAL_CONTENT_URI/);
  assert.match(activity, /DownloadPayload\.decode\(base64Data\)/);
  assert.match(payload, /MAX_BYTES = 64 \* 1024 \* 1024/);
  assert.doesNotMatch(navigation, /blob/i);
});

test('Android imports learning materials through a document content URI, not a device path', () => {
  assert.doesNotMatch(appHtml, /id="openLearning"[^>]+target=/);
  assert.match(activity, /new Intent\(Intent\.ACTION_OPEN_DOCUMENT\)/);
  assert.match(activity, /Intent\.CATEGORY_OPENABLE/);
  assert.match(activity, /Intent\.FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(activity, /appendMimeTypesForExtension/);
  assert.match(activity, /text\/plain/);
  assert.match(activity, /application\/octet-stream/);
  assert.match(activity, /application\/pdf/);
  assert.match(activity, /application\/epub\+zip/);
  assert.match(activity, /application\/msword/);
  assert.match(activity, /application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/);
  assert.match(activity, /application\/vnd\.ms-powerpoint/);
  assert.match(activity, /application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation/);
  assert.match(activity, /Intent\.EXTRA_MIME_TYPES/);
  assert.match(activity, /settings\.setAllowFileAccess\(false\)/);
  assert.match(activity, /settings\.setAllowContentAccess\(true\)/);
});

test('Android supports dynamic endpoint switching, history management, and Native JSBridge', () => {
  assert.match(activity, /addJavascriptInterface\(new NativeAppBridge\(this\), "LightChatApp"\)/);
  assert.match(activity, /public static final class NativeAppBridge/);
  assert.match(activity, /public void openEndpointConfig\(\)/);
  assert.match(activity, /public void switchEndpoint\(String/);
  assert.match(activity, /onJsPrompt/);
  assert.match(activity, /SERVICE_URL_HISTORY_KEY/);
  assert.match(activity, /saveServiceUrlToHistory/);
  assert.match(activity, /cancelServiceConfig/);
  assert.match(activity, /renderServiceUrlHistory/);
  assert.match(activity, /onKeyLongPress/);
  assert.match(appSource, /window\.LightChatApp/);
  assert.match(appHtml, /id="nativeAppEndpointSettings"/);
  assert.match(appHtml, /id="switchNativeAppEndpointButton"/);
});
