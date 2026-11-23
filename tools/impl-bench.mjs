// End-to-end accuracy of the shipped Auto-read path.
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rounds = Number(process.argv[2] || 10);
const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new', args: ['--no-sandbox'], protocolTimeout: 900000
});
const page = await browser.newPage();
await page.goto('https://online.umt.edu.pk/', { waitUntil: 'networkidle2', timeout: 60000 });
await page.addScriptTag({ path: path.join(here, '..', 'umt-login-helper.user.js') });

const out = await page.evaluate(async rounds => {
    const tok = document.querySelector('input[name=__RequestVerificationToken]').value;
    const log = [];
    for (let i = 0; i < rounds; i++) {
        await window.__umtlh.read();
        const code = document.getElementById('SecurityCode').value;
        const status = document.getElementById('umtlh-status').textContent;
        if (code.length !== 5) { log.push({ code, ok: false, note: 'short: ' + status }); continue; }
        const fd = new FormData();
        fd.append('__RequestVerificationToken', tok);
        fd.append('student_id', 'S2025000000');
        fd.append('Password', 'NotARealPassword1');
        fd.append('SecurityCode', code);
        fd.append('ClientCheck', '');
        const html = await (await fetch('/Account/Login', { method: 'POST', body: fd })).text();
        log.push({ code, ok: !/Invalid Code/i.test(html) });
    }
    return log;
}, rounds);

const ok = out.filter(r => r.ok).length;
console.log(out.map(r => `${r.code}${r.ok ? '✓' : '✗'}`).join('  '));
console.log(`\nshipped path: ${ok}/${out.length} accepted`);
await browser.close();
