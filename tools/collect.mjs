// Harvest labelled glyph masks: only from submissions the server ACCEPTED, only confident slots.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rounds = Number(process.argv[2] || 12);
const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new', args: ['--no-sandbox'], protocolTimeout: 1800000
});
const page = await browser.newPage();
await page.goto('https://online.umt.edu.pk/', { waitUntil: 'networkidle2', timeout: 60000 });
await page.addScriptTag({ path: path.join(here, '..', 'umt-login-helper.user.js') });

const data = await page.evaluate(async rounds => {
    const engine = await window.__umtlh.ensureWorker();
    await engine.setParameters({ tessedit_pageseg_mode: '10' });
    const tok = document.querySelector('input[name=__RequestVerificationToken]').value;
    const rows = [];

    const grab = async () => {
        const r = await fetch('/Account/Captcha?t=' + Date.now(), { cache: 'no-store' });
        const bmp = await createImageBitmap(await r.blob());
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        return c;
    };

    // read one cleaned strip; returns null when it looks like the line cluster
    const readStrip = async strip => {
        const w = strip.width, h = strip.height;
        const px = strip.getContext('2d').getImageData(0, 0, w, h).data;
        const ink = (x, y) => px[(y * w + x) * 4] < 128;
        let minX = w, maxX = -1, minY = h, maxY = -1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink(x, y)) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        if (maxX < 0) return null;
        const band = (maxX - minX + 1) / 5;
        const text = []; const confs = []; const masks = [];

        for (let k = 0; k < 5; k++) {
            const x0 = Math.max(0, Math.round(minX + k * band) - 3);
            const x1 = Math.min(w, Math.round(minX + (k + 1) * band) + 3);
            const cw = x1 - x0, ch = maxY - minY + 1;
            const c = document.createElement('canvas');
            c.width = cw; c.height = ch;
            c.getContext('2d').drawImage(strip, x0, minY, cw, ch, 0, 0, cw, ch);
            const f = Math.max(2, Math.round(90 / ch));
            const up = document.createElement('canvas');
            up.width = cw * f; up.height = ch * f;
            const uc = up.getContext('2d');
            uc.imageSmoothingEnabled = true;
            uc.drawImage(c, 0, 0, up.width, up.height);
            const res = (await engine.recognize(up)).data;
            text.push(window.__umtlh.normalise(res.text).slice(0, 1) || 'q');
            confs.push(Math.round(res.confidence || 0));

            const flat = [];
            for (let yy = 0; yy < 24; yy++) for (let xx = 0; xx < 24; xx++) {
                const sx = x0 + Math.floor(xx * cw / 24);
                const sy = minY + Math.floor(yy * ch / 24);
                flat.push(sx >= 0 && sy >= 0 && sx < w && sy < h && ink(sx, sy) ? 1 : 0);
            }
            masks.push(flat);
        }
        const empties = text.filter(t => t === 'q').length;
        const conf = confs.reduce((a, b) => a + b, 0) / 5;
        return { text: text.join(''), confs, masks, score: conf - empties * 2 };
    };

    for (let round = 0; round < rounds; round++) {
        const src = await grab();
        const variants = (window.__umtlh.analyse(src, 3) || []).filter(v => !v.original);
        if (!variants.length) continue;

        let best = null;
        for (const v of variants) {
            const r = await readStrip(v.canvas);
            if (r && (!best || r.score > best.score)) best = r;
        }
        if (!best) continue;

        const fd = new FormData();
        fd.append('__RequestVerificationToken', tok);
        fd.append('student_id', 'S2025000000');
        fd.append('Password', 'NotARealPassword1');
        fd.append('SecurityCode', best.text);
        fd.append('ClientCheck', '');
        const html = await (await fetch('/Account/Login', { method: 'POST', body: fd })).text();
        rows.push({ ok: !/Invalid Code/i.test(html), text: best.text, confs: best.confs, masks: best.masks });
        await new Promise(r => setTimeout(r, 100));
    }
    return rows;
}, rounds);

fs.writeFileSync(path.join(here, 'labelled.json'), JSON.stringify(data));
const accepted = data.filter(r => r.ok).length;
const usable = data.filter(r => r.ok).reduce((a, r) => a + r.confs.filter(c => c >= 45).length, 0);
console.log(`rounds ${data.length}, accepted ${accepted}, confident labelled glyphs ${usable}`);
await browser.close();

