// Does the unpacked-extension route actually work (no Tampermonkey, no pasting)?
// Chrome 158 ignores --load-extension, so the extension is installed through
// Puppeteer's CDP route (enableExtensions -> Extensions.loadUnpacked) instead.
// Nothing is submitted: the check only loads the login page and lets the extension fill the code.
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(here, '..', 'extension');

const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: false,
    enableExtensions: [ext],
    args: ['--no-first-run', '--no-default-browser-check']
});

const page = await browser.newPage();
await page.goto('https://online.umt.edu.pk/', { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction(() => /^[A-Z0-9]{5}$/.test(document.getElementById('SecurityCode')?.value || ''),
    { timeout: 15000, polling: 200 }).catch(() => {});

const state = await page.evaluate(() => ({
    // only visible from the page when the content script runs in the MAIN world
    mainWorld: !!(window.__umtlh && window.__umtlh.recognise),
    code: document.getElementById('SecurityCode')?.value || '',
    noBox: !document.querySelector('[id^="umtlh-"]'),
    pasteOpen: typeof document.getElementById('SecurityCode')?.onpaste === 'function'
        && document.getElementById('SecurityCode').onpaste() !== false,
    overlay: !!document.getElementById('portal-guard-overlay'),
    btnEnabled: !document.getElementById('loginbtn')?.disabled
}));

console.log('MAIN world:      ', state.mainWorld);
console.log('code filled:     ', state.code || '-');
console.log('no helper box:   ', state.noBox);
console.log('paste unblocked: ', state.pasteOpen);
console.log('guard overlay:   ', state.overlay);
console.log('button enabled:  ', state.btnEnabled);
await page.screenshot({ path: path.join(here, 'screenshot-extension.png'), fullPage: true });
await browser.close();

const ok = state.mainWorld && /^[A-Z0-9]{5}$/.test(state.code) && state.noBox && state.pasteOpen && state.btnEnabled;
console.log(ok ? 'EXTENSION ROUTE OK' : 'EXTENSION ROUTE FAILED');
process.exit(ok ? 0 : 1);
