// Smoke test: drive the real login page in Chrome and assert the userscript behaves.
// The last step submits a FAKE student ID once, to exercise the auto-retry path.
// Run: node smoke.mjs
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, '..', 'umt-login-helper.user.js');

const results = [];
const check = (name, ok, extra = '') => {
    results.push({ name, ok, extra });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/ERR_FAILED|chrome-extension/i.test(t)) errors.push(t);
});
await page.goto('https://online.umt.edu.pk/', { waitUntil: 'networkidle2', timeout: 60000 });
check('login form present', await page.$('#loginform') !== null);

// simulate the portal guard having fired: overlay + disabled button + spinner label
await page.evaluate(() => {
    const o = document.createElement('div');
    o.id = 'portal-guard-overlay';
    o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.5)';
    document.body.appendChild(o);
    const b = document.getElementById('loginbtn');
    b.disabled = true;
    b.innerHTML = 'Please wait....';
});
await page.addScriptTag({ path: scriptPath });
await sleep(400);
// from now on re-inject on every page load, like Tampermonkey / the extension would
page.on('load', () => { page.addScriptTag({ path: scriptPath }).catch(() => {}); });

check('guard overlay removed', await page.$('#portal-guard-overlay') === null);
check('sign-in button re-enabled', await page.$eval('#loginbtn', b => !b.disabled));
check('button label restored', await page.$eval('#loginbtn', b => b.textContent.trim()) === 'Sign in');
check('no helper box or other added elements', await page.evaluate(() =>
    !document.querySelector('[id^="umtlh-"]') && !document.getElementById('umtlh-panel')));

const first = await page.$eval('#SecurityCode', e => e.value);
check('code auto-filled on load', /^[A-Z0-9]{5}$/.test(first), first);

// clicking the captcha (the portal's own refresh) must refill the field for the new image
const srcBefore = await page.$eval('#captchaImg', i => i.src);
await page.click('#captchaImg');
await page.waitForFunction(s => document.getElementById('captchaImg').src !== s, { timeout: 5000 }, srcBefore).catch(() => {});
await sleep(1200);
const second = await page.$eval('#SecurityCode', e => e.value);
check('captcha refresh refills the code', /^[A-Z0-9]{5}$/.test(second) &&
    await page.$eval('#captchaImg', (i, s) => i.src !== s, srcBefore), `${first} -> ${second}`);

check('paste allowed', await page.$eval('#SecurityCode', e => e.onpaste && e.onpaste() === true));
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

// real submit with a fake account: the login page comes back, auto-retry loads + fills a fresh code
await page.type('#student_id', 'S2025000000');
await page.type('#Password', 'NotARealPassword1');
const codeSent = await page.$eval('#SecurityCode', e => e.value);
const navigated = await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).then(() => true).catch(() => false),
    page.click('#loginbtn')
]);
check('form submits', navigated && /Account\/Login/.test(page.url()), page.url());
await page.waitForFunction(() => window.__umtlh, { timeout: 10000 }).catch(() => {});
await sleep(1800);
const after = await page.evaluate(() => ({
    code: document.getElementById('SecurityCode').value,
    btn: !document.getElementById('loginbtn').disabled,
    src: document.getElementById('captchaImg').src
}));
check('after the round-trip: fresh captcha, code refilled, button alive',
    /t=\d+/.test(after.src) && /^[A-Z0-9]{5}$/.test(after.code) && after.btn, `${codeSent} -> ${after.code}`);

await page.screenshot({ path: path.join(here, 'screenshot.png'), fullPage: true });
await browser.close();

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
