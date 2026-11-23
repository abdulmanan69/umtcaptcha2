// Diagnostics: how does Tesseract actually read these captchas, per variant?
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox']
});
const page = await browser.newPage();
page.on('requestfailed', r => console.log('REQFAIL', r.url(), r.failure()?.errorText));
page.on('pageerror', e => console.log('PAGEERR', String(e)));

await page.goto('https://online.umt.edu.pk/', { waitUntil: 'networkidle2', timeout: 60000 });
await page.addScriptTag({ path: path.join(here, '..', 'umt-login-helper.user.js') });

const out = await page.evaluate(async () => {
    const log = [];
    let engine;
    try {
        engine = await window.__umtlh.ensureWorker();
        log.push('worker ok');
    } catch (e) {
        log.push('worker FAILED: ' + e.message);
        return log;
    }
    const img = document.getElementById('captchaImg');

    const fresh = () => new Promise(res => {
        img.onload = res;
        img.src = '/Account/Captcha?t=' + Date.now();
        setTimeout(res, 4000);
    });

    const upscale = (src, factor, smooth) => {
        const c = document.createElement('canvas');
        c.width = src.width * factor;
        c.height = src.height * factor;
        const x = c.getContext('2d');
        x.imageSmoothingEnabled = smooth;
        x.drawImage(src, 0, 0, c.width, c.height);
        return c;
    };

    for (let round = 0; round < 6; round++) {
        await fresh();
        const base = document.createElement('canvas');
        base.width = img.naturalWidth;
        base.height = img.naturalHeight;
        base.getContext('2d').drawImage(img, 0, 0);

        const variants = window.__umtlh.analyse(img, 3) || [];
        const row = [];
        for (const v of variants) {
            const r = await engine.recognize(v.canvas);
            row.push(`${v.original ? 'orig' : 'clean'}:"${r.data.text.trim()}"@${Math.round(r.data.confidence)}`);
        }
        const smooth = upscale(base, 4, true);
        const r2 = await engine.recognize(smooth);
        row.push(`origSmooth:"${r2.data.text.trim()}"@${Math.round(r2.data.confidence)}`);

        // browser-side OCR of the raw image at native size, for reference
        const r3 = await engine.recognize(base);
        row.push(`native:"${r3.data.text.trim()}"@${Math.round(r3.data.confidence)}`);
        log.push(`round ${round + 1}: ` + row.join('  '));
    }
    return log;
});

out.forEach(l => console.log(l));
await browser.close();
