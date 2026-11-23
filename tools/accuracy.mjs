// Offline accuracy of the shipped recogniser on hand-labelled captchas (no network, no login).
// Each file in samples/labelled/ is named after the code it shows, e.g. KYNSZ.png.
// Usage: node accuracy.mjs [--verbose]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'samples', 'labelled');
const verbose = process.argv.includes('--verbose');
const items = fs.readdirSync(dir).filter(f => /^[A-Z0-9]{5}\.png$/.test(f)).map(f => ({
    label: f.slice(0, 5),
    src: 'data:image/png;base64,' + fs.readFileSync(path.join(dir, f)).toString('base64')
}));

const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new'
});
const page = await browser.newPage();
// minimal stand-in for the portal's login markup, so the userscript initialises offline
await page.setContent(`<form id="loginform"><input id="student_id"><input id="Password">
  <div class="row"><div class="x"><div class="col-md-6"><input id="SecurityCode"></div>
  <div class="col-md-6"><img id="captchaImg" width="170" height="56"></div></div></div>
  <button id="loginbtn" type="button">Sign in</button></form>`);
await page.addScriptTag({ path: path.join(here, '..', 'umt-login-helper.user.js') });

const res = await page.evaluate(async items => {
    const out = [];
    const t0 = performance.now();
    for (const it of items) {
        const im = new Image();
        im.src = it.src;
        await im.decode();
        const r = window.__umtlh.recognise(im);
        out.push({ label: it.label, text: r.text, chars: r.chars.map(c => ({ ch: c.ch, score: c.score, alt: c.alt })) });
    }
    return { out, ms: (performance.now() - t0) / items.length };
}, items);
await browser.close();

const DOUBT = 1.5;
let whole = 0, chars = 0, flaggedWrong = 0, wrong = 0, flaggedRight = 0;
for (const r of res.out) {
    let ok = 0;
    r.chars.forEach((c, i) => {
        const right = c.ch === r.label[i];
        if (right) ok++; else wrong++;
        if (c.score > DOUBT) { if (right) flaggedRight++; else flaggedWrong++; }
    });
    wrong += 5 - r.chars.length;
    chars += ok;
    if (r.text === r.label) whole++;
    if (verbose || r.text !== r.label) {
        console.log(`${r.label}  ${r.text.padEnd(5)}  ${ok}/5  ` + r.chars.map(c => `${c.ch}:${c.score.toFixed(2)}`).join(' '));
    }
}
const n = res.out.length;
console.log(`\nwhole codes: ${whole}/${n} (${Math.round(100 * whole / n)}%)   characters: ${chars}/${n * 5} (${Math.round(100 * chars / (n * 5))}%)`);
console.log(`unsure flag (score > ${DOUBT}): caught ${flaggedWrong}/${wrong} wrong characters, flagged ${flaggedRight} right ones`);
console.log(`time per captcha: ${res.ms.toFixed(1)} ms`);
