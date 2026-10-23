import test from 'node:test';
import assert from 'node:assert/strict';
import { isInAppBrowser, isIosSafari } from '../src/mobile/login/inAppBrowser';

const WECHAT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.47';
const QQ_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 QQ/8.9.50';
const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_SAFARI_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const CHROME_IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1';
const QQBROWSER_UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/113.0.0.0 Mobile Safari/537.36 QQBrowser/13.1';
const DESKTOP_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

test('isInAppBrowser detects the WeChat MicroMessenger webview', () => {
  assert.equal(isInAppBrowser(WECHAT_UA), true);
});

test('isInAppBrowser detects the QQ in-app browser', () => {
  assert.equal(isInAppBrowser(QQ_UA), true);
});

test('isInAppBrowser stays false for system browsers', () => {
  assert.equal(isInAppBrowser(IPHONE_SAFARI_UA), false);
  assert.equal(isInAppBrowser(IPAD_SAFARI_UA), false);
  assert.equal(isInAppBrowser(DESKTOP_SAFARI_UA), false);
  assert.equal(isInAppBrowser(DESKTOP_CHROME_UA), false);
  // QQBrowser (a standalone browser app) is not the QQ in-app webview.
  assert.equal(isInAppBrowser(QQBROWSER_UA), false);
});

test('isIosSafari matches iPhone and iPad Safari only', () => {
  assert.equal(isIosSafari(IPHONE_SAFARI_UA), true);
  assert.equal(isIosSafari(IPAD_SAFARI_UA), true);
  assert.equal(isIosSafari(CHROME_IOS_UA), false);
  assert.equal(isIosSafari(WECHAT_UA), false);
  assert.equal(isIosSafari(QQ_UA), false);
  assert.equal(isIosSafari(DESKTOP_SAFARI_UA), false);
  assert.equal(isIosSafari(DESKTOP_CHROME_UA), false);
});
