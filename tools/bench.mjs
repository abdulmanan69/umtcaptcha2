// Measure real OCR accuracy against the live server (a wrong captcha answers "Invalid Code").
// Run: node bench.mjs [rounds]
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rounds = Number(process.argv[2] || 10);
const here = path.dirname(fileURLToPath(import.meta.url));

const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox'], protocolTimeout: 1800000
});
const page = await browser.newPage();
await page.goto('https://online.umt.edu.pk/', { waitUntil: 'networkidle2', timeout: 60000 });
await page.addScriptTag({ path: path.join(here, '..', 'umt-login-helper.user.js') });

const out = await page.evaluate(async (rounds) => {
    const engine = await window.__umtlh.ensureWorker();
    const tok = document.querySelector('input[name=__RequestVerificationToken]').value;
    const results = { slots: [], deskew: [] };

    const smoothUpscale = canvas => {
        const base = document.createElement('canvas');
        base.width = canvas.width; base.height = canvas.height;
        base.getContext('2d').drawImage(canvas, 0, 0);
        const big = document.createElement('canvas');
        big.width = canvas.width * 2; big.height = canvas.height * 2;
        const c = big.getContext('2d');
        c.imageSmoothingEnabled = true;
        c.drawImage(base, 0, 0, big.width, big.height);
        return big;
    };

    // grayscale anti-aliased version: down to 1x, then up to 4x with smoothing
    const antiAlias = canvas => {
        const small = document.createElement('canvas');
        small.width = Math.round(canvas.width / 3); small.height = Math.round(canvas.height / 3);
        const sc = small.getContext('2d');
        sc.imageSmoothingEnabled = true;
        sc.drawImage(canvas, 0, 0, small.width, small.height);
        const big = document.createElement('canvas');
        big.width = small.width * 4; big.height = small.height * 4;
        const bc = big.getContext('2d');
        bc.imageSmoothingEnabled = true;
        bc.drawImage(small, 0, 0, big.width, big.height);
        return big;
    };

    // rotate a slot upright along its principal ink axis
    const deskew = canvas => {
        const w = canvas.width, h = canvas.height;
        const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
        let n = 0, sx = 0, sy = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4] < 128) { n++; sx += x; sy += y; }
        if (n < 20) return canvas;
        const mx = sx / n, my = sy / n;
        let cxx = 0, cyy = 0, cxy = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            if (d[(y * w + x) * 4] >= 128) continue;
            const dx = x - mx, dy = y - my;
            cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
        }
        cxx /= n; cyy /= n; cxy /= n;
        let angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
        // keep glyphs horizontal-ish: only correct small tilts
        while (angle > Math.PI / 4) angle -= Math.PI / 2;
        while (angle < -Math.PI / 4) angle += Math.PI / 2;
        const side = Math.ceil(Math.hypot(w, h));
        const out = document.createElement('canvas');
        out.width = side; out.height = side;
        const c = out.getContext('2d');
        c.imageSmoothingEnabled = true;
        c.fillStyle = '#fff';
        c.fillRect(0, 0, side, side);
        c.translate(side / 2, side / 2);
        c.rotate(-angle);
        c.drawImage(canvas, -w / 2, -h / 2);
        // re-crop to ink
        const od = c.getImageData(0, 0, side, side).data;
        let x0 = side, x1 = -1, y0 = side, y1 = -1;
        for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
            if (od[(y * side + x) * 4] < 128) {
                if (x < x0) x0 = x; if (x > x1) x1 = x;
                if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
        }
        if (x1 < 0) return canvas;
        const crop = document.createElement('canvas');
        crop.width = x1 - x0 + 1; crop.height = y1 - y0 + 1;
        crop.getContext('2d').drawImage(out, x0, y0, crop.width, crop.height, 0, 0, crop.width, crop.height);
        return crop;
    };

    // split the cleaned strip into 5 equal slots and classify each glyph on its own
    const slots = canvas => {
        const w = canvas.width, h = canvas.height;
        const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
        const colInk = new Array(w).fill(0);
        let minX = w, maxX = -1, minY = h, maxY = -1;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (d[(y * w + x) * 4] < 128) {
                    colInk[x]++;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return [];
        const band = (maxX - minX + 1) / 5;
        const out = [];
        for (let k = 0; k < 5; k++) {
            const x0 = Math.max(0, Math.round(minX + k * band) - 3);
            const x1 = Math.min(w, Math.round(minX + (k + 1) * band) + 3);
            const cw = x1 - x0, ch = maxY - minY + 1;
            if (cw <= 1 || ch <= 1) continue;
            const c = document.createElement('canvas');
            c.width = cw; c.height = ch;
            c.getContext('2d').drawImage(canvas, x0, minY, cw, ch, 0, 0, cw, ch);
            const up = document.createElement('canvas');
            const f = Math.max(2, Math.round(90 / ch));
            up.width = cw * f; up.height = ch * f;
            const uc = up.getContext('2d');
            uc.imageSmoothingEnabled = true;
            uc.drawImage(c, 0, 0, up.width, up.height);
            out.push(up);
        }
        return out;
    };

    for (let i = 0; i < rounds; i++) {
        for (const cfg of ['slots', 'deskew']) {
            const r = await fetch('/Account/Captcha?t=' + Date.now(), { cache: 'no-store' });
            const bitmap = await createImageBitmap(await r.blob());
            const src = document.createElement('canvas');
            src.width = bitmap.width; src.height = bitmap.height;
            src.getContext('2d').drawImage(bitmap, 0, 0);

            const variants = (window.__umtlh.analyse(src, 3) || []).filter(v => !v.original);
            const cands = [];

            if (cfg === 'clean7') {
                await engine.setParameters({ tessedit_pageseg_mode: '7' });
                for (const v of variants) {
                    const data = (await engine.recognize(v.canvas)).data;
                    cands.push({ text: window.__umtlh.normalise(data.text), conf: data.confidence });
                }
            } else {
                await engine.setParameters({ tessedit_pageseg_mode: '10' });
                const pieces = [];
                for (const v of variants) {
                    const parts = slots(v.canvas).map(p => cfg === 'deskew' ? deskew(p) : p);
                    let text = '';
                    let conf = 0;
                    for (const p of parts) {
                        const data = (await engine.recognize(p)).data;
                        const one = window.__umtlh.normalise(data.text);
                        text += one.slice(0, 1) || '?';
                        conf += data.confidence || 0;
                    }
                    if (parts.length) pieces.push({ text, conf: conf / parts.length });
                }
                const bestPiece = pieces.sort((a, b) => b.conf - a.conf)[0];
                if (bestPiece) cands.push(bestPiece);
            }

            const five = cands.filter(c => c.text.length === 5).sort((a, b) => b.conf - a.conf);
            const best = five[0] || cands.sort((a, b) => b.text.length - a.text.length || b.conf - a.conf)[0];

            if (!best || best.text.length !== 5) {
                results[cfg].push({ ok: false, text: best ? best.text : '', why: 'length' });
                continue;
            }

            // no captcha GET in between: the code on screen is the code the session holds
            const fd = new FormData();
            fd.append('__RequestVerificationToken', tok);
            fd.append('student_id', 'S2025000000');
            fd.append('Password', 'NotARealPassword1');
            fd.append('SecurityCode', best.text);
            fd.append('ClientCheck', '');
            const html = await (await fetch('/Account/Login', { method: 'POST', body: fd })).text();
            const ok = !/Invalid Code/i.test(html);
            results[cfg].push({ ok, text: best.text, conf: Math.round(best.conf) });
        }
        results[i] = i;   // harmless marker
    }
    return results;
}, rounds);

for (const cfg of ['slots', 'deskew']) {
    const rows = out[cfg];
    const ok = rows.filter(r => r.ok).length;
    console.log(`${cfg}: ${ok}/${rows.length} accepted`);
    console.log('   ' + rows.map(r => `${r.text || '-'}${r.conf !== undefined ? '@' + r.conf : ''}${r.ok ? '' : '✗'}`).join('  '));
}
await browser.close();
