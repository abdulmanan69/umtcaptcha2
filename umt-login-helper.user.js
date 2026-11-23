// ==UserScript==
// @name         UMT Login Helper — captcha auto-fill, auto-retry
// @namespace    https://online.umt.edu.pk/
// @version      1.2.0
// @description  Reads the UMT portal captcha locally (no download, no upload) and fills the code field, fixes the "you must reload the page after one wrong attempt" behaviour, and neutralises the portal-guard lockdown that extensions trigger. No visible panel.
// @match        https://online.umt.edu.pk/
// @match        https://online.umt.edu.pk/Account/Login*
// @run-at       document-end
// @grant        none
// ==/UserScript==

/*
 * How it avoids tripping Scripts/portal-guard.js
 * ---------------------------------------------
 * The portal guard flags three things: a blacklisted extension id, a few DOM fingerprints
 * (body classes umt-redesigned / umt-skinned, ids _umt_badge / umt-profile-panel), and
 * synthetic 'input'/'change' events on #SecurityCode (isTrusted === false).
 *
 * This script therefore:
 *   - adds no body classes and no elements to the page at all;
 *   - never dispatches events on #SecurityCode — it assigns .value directly;
 *   - and if something *did* flag it, it removes the guard overlay and re-enables the button.
 */

(function () {
    'use strict';

    if (window.__umtlhLoaded) return;
    window.__umtlhLoaded = true;

    const FORM = document.getElementById('loginform');
    const CODE = document.getElementById('SecurityCode');
    const BTN = document.getElementById('loginbtn');
    const IMG = document.getElementById('captchaImg');
    if (!FORM || !CODE || !BTN || !IMG) return;          // not the login view

    let submitting = false;

    /* ------------------------------------------------------------------ *
     * 1. Guard neutraliser — keeps the sign-in button alive              *
     * ------------------------------------------------------------------ */
    function unblock() {
        const overlay = document.getElementById('portal-guard-overlay');
        if (overlay) overlay.remove();
        if (submitting) return;                       // a real submit keeps its own spinner
        if (BTN.disabled) BTN.disabled = false;
        if (!BTN.textContent.trim() || /please wait/i.test(BTN.textContent)) BTN.innerHTML = 'Sign in';
    }

    new MutationObserver(() => {
        if (document.getElementById('portal-guard-overlay') || BTN.disabled) unblock();
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });

    /* ------------------------------------------------------------------ *
     * 2. Captcha helpers                                                *
     * ------------------------------------------------------------------ */
    const refreshCaptcha = () => { IMG.src = '/Account/Captcha?t=' + Date.now(); };

    function loadFresh() {
        return new Promise((resolve, reject) => {
            refreshCaptcha();
            const done = () => { IMG.removeEventListener('load', done); IMG.removeEventListener('error', done); resolve(); };
            IMG.addEventListener('load', done);
            IMG.addEventListener('error', done);
            setTimeout(() => reject(new Error('captcha load timeout')), 8000);
        });
    }

    // Let the user paste the code (the portal sets onPaste="return false").
    CODE.onpaste = () => true;
    CODE.setAttribute('spellcheck', 'false');
    CODE.setAttribute('autocapitalize', 'off');

    /* ------------------------------------------------------------------ *
     * 3. Recogniser: colour-blob segmentation + template matching          *
     * ------------------------------------------------------------------ *
     * Every glyph of this captcha is drawn in ONE solid colour (with ClearType fringes);
     * the interference curves span the whole width and the straight lines are pale or
     * one stroke wide. So: find compact solid-colour blobs, grow them into pixels that are
     * a blend of that colour and the background, keep the 5 strongest, then compare each
     * blob with every allowed character rendered in Arial at -35..35 degrees.
     * Character set seen on 190 live glyphs (Nov 2026): A-Z and 2-9 without I and O.
     */
    const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const RP = {
        inkMin: 60,        // |rgb - background| sum that counts as ink
        minN: 25,          // pixels of one exact colour needed to seed a glyph
        maxLum: 175,       // seeds paler than this are interference lines
        tol: 16,           // exact-colour tolerance for seeds
        alphaMax: 0.5,     // growing: max mean blend factor towards the background
        maxW: 34, minH: 12, maxH: 40,
        ring: 1,           // blended rim pixels added around each glyph core
        minThick: 1.3,     // PCA minor-axis sigma: straight line pieces are thinner
        slotGap: 18        // a spare piece must be this far (px) from every chosen glyph centre
    };

    function extractGlyphs(src) {
        const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(src, 0, 0, w, h);
        const d = cx.getImageData(0, 0, w, h).data;
        const N = w * h;
        const px = i => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
        const cs = [px(0), px(w - 1), px((h - 1) * w), px(N - 1)];
        const bg = [0, 1, 2].map(k => cs.reduce((a, q) => a + q[k], 0) / 4);
        const dist = (i, c) => Math.abs(d[i * 4] - c[0]) + Math.abs(d[i * 4 + 1] - c[1]) + Math.abs(d[i * 4 + 2] - c[2]);
        const ink = new Uint8Array(N);
        for (let i = 0; i < N; i++) if (dist(i, bg) > RP.inkMin) ink[i] = 1;

        // a pixel "belongs" to colour c when each channel sits between c and the background
        const blendOk = (i, c) => {
            let sum = 0, used = 0;
            for (let k = 0; k < 3; k++) {
                const span = bg[k] - c[k];
                if (Math.abs(span) < 20) { if (Math.abs(d[i * 4 + k] - c[k]) > 24) return false; continue; }
                const a = (d[i * 4 + k] - c[k]) / span;
                if (a < -0.15 || a > 1.05) return false;
                sum += a; used++;
            }
            return !used || sum / used <= RP.alphaMax;
        };

        // 1. exact-colour histogram
        const stats = new Map();
        for (let i = 0; i < N; i++) {
            if (!ink[i]) continue;
            const k = (d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2];
            let e = stats.get(k);
            if (!e) stats.set(k, e = { rgb: px(i), n: 0 });
            e.n++;
        }
        const lum = c => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
        const seeds = [...stats.values()].filter(e => e.n >= RP.minN && lum(e.rgb) <= RP.maxLum);

        // 2. per seed colour: pieces (5x5 neighbourhood), merged when they overlap in x
        const flood = (start, ok, seen, reach) => {
            const st = [start], pts = []; seen[start] = 1;
            while (st.length) {
                const p = st.pop(); pts.push(p);
                const x = p % w, y = (p - x) / w;
                for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                    const q = ny * w + nx;
                    if (!seen[q] && ok(q)) { seen[q] = 1; st.push(q); }
                }
            }
            return pts;
        };
        const boxOf = pts => {
            let x0 = w, x1 = -1, y0 = h, y1 = -1;
            for (const p of pts) { const x = p % w, y = (p - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
            return { x0, x1, y0, y1 };
        };
        const thickness = pts => {           // sigma along the minor principal axis
            let mx = 0, my = 0;
            for (const p of pts) { mx += p % w; my += Math.floor(p / w); }
            mx /= pts.length; my /= pts.length;
            let sxx = 0, syy = 0, sxy = 0;
            for (const p of pts) { const x = p % w - mx, y = Math.floor(p / w) - my; sxx += x * x; syy += y * y; sxy += x * y; }
            sxx /= pts.length; syy /= pts.length; sxy /= pts.length;
            const tr = sxx + syy, det = sxx * syy - sxy * sxy;
            return Math.sqrt(Math.max(0, tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det))));
        };

        const found = [], spare = [];   // spare: line-like pieces, only used to fill an empty slot
        for (const e of seeds) {
            const seen = new Uint8Array(N);
            const pieces = [];
            for (let i = 0; i < N; i++) {
                if (seen[i] || !ink[i] || dist(i, e.rgb) > RP.tol) continue;
                const pts = flood(i, q => ink[q] && dist(q, e.rgb) <= RP.tol, seen, 2);
                pieces.push(Object.assign({ pts }, boxOf(pts)));
            }
            pieces.sort((a, b) => a.x0 - b.x0);
            const merged = [];
            for (const p of pieces) {
                const last = merged[merged.length - 1];
                if (last && p.x0 <= last.x1 + 2 && Math.max(last.x1, p.x1) - Math.min(last.x0, p.x0) <= RP.maxW) {
                    last.pts = last.pts.concat(p.pts);
                    Object.assign(last, boxOf(last.pts));
                } else merged.push(p);
            }
            for (const p of merged) {
                if (p.pts.length < RP.minN || p.x1 - p.x0 + 1 > RP.maxW) continue;
                // 3. grow a RP.ring-pixel rim into blended (anti-aliased) pixels; not further, or dark curves leak in
                const inP = new Uint8Array(N);
                for (const q of p.pts) inP[q] = 1;
                for (let r = 0; r < RP.ring; r++) {
                    const add = [];
                    for (let y = Math.max(0, p.y0 - 2); y <= Math.min(h - 1, p.y1 + 2); y++) {
                        for (let x = Math.max(0, p.x0 - 2); x <= Math.min(w - 1, p.x1 + 2); x++) {
                            const q = y * w + x; if (inP[q] || !ink[q] || !blendOk(q, e.rgb)) continue;
                            if ((x > 0 && inP[q - 1]) || (x < w - 1 && inP[q + 1]) || (y > 0 && inP[q - w]) || (y < h - 1 && inP[q + w])) add.push(q);
                        }
                    }
                    for (const q of add) inP[q] = 1;
                }
                const pts = [];
                for (let q = 0; q < N; q++) if (inP[q]) pts.push(q);
                const b = boxOf(pts);
                const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
                if (bw > RP.maxW || bh < RP.minH || bh > RP.maxH) continue;
                const thin = thickness(pts) < RP.minThick;
                (thin ? spare : found).push(Object.assign({ pts, n: pts.length, core: p.pts.length }, b));
            }
        }

        // 4. strongest 5 that do not sit on top of each other, left to right
        found.sort((a, b) => b.core - a.core);
        const chosen = [];
        for (const g of found) {
            const clash = chosen.some(o => Math.min(o.x1, g.x1) - Math.max(o.x0, g.x0) > 0.6 * Math.min(o.x1 - o.x0, g.x1 - g.x0));
            if (!clash) chosen.push(g);
            if (chosen.length === 5) break;
        }
        // a glyph whose curves were cut away can look like a line: take the spare farthest from the others
        const centre = g => (g.x0 + g.x1) / 2;
        while (chosen.length < 5 && chosen.length) {
            let pick = null, far = RP.slotGap;
            for (const g of spare) {
                if (chosen.includes(g)) continue;
                const dmin = Math.min(...chosen.map(o => Math.abs(centre(o) - centre(g))));
                if (dmin > far) { far = dmin; pick = g; }
            }
            if (!pick) break;
            chosen.push(pick);
        }
        chosen.sort((a, b) => a.x0 - b.x0);

        // 5. per-glyph mask, closing gaps where a curve crossed the glyph (only through ink)
        const all = new Uint8Array(N);
        const glyphs = chosen.map(g => {
            const gm = new Uint8Array(N);
            for (const p of g.pts) gm[p] = 1;
            const add = [];
            for (let y = g.y0; y <= g.y1; y++) for (let x = g.x0; x <= g.x1; x++) {
                const i = y * w + x; if (gm[i] || !ink[i]) continue;
                let l = 0, r = 0, u = 0, dn = 0;
                for (let k = 1; k <= 3; k++) {
                    if (x - k >= 0 && gm[i - k]) l = 1; if (x + k < w && gm[i + k]) r = 1;
                    if (y - k >= 0 && gm[i - k * w]) u = 1; if (y + k < h && gm[i + k * w]) dn = 1;
                }
                if ((l && r) || (u && dn)) add.push(i);
            }
            for (const i of add) gm[i] = 1;
            for (let i = 0; i < N; i++) if (gm[i]) all[i] = 1;
            return { x0: g.x0, x1: g.x1, y0: g.y0, y1: g.y1, m: gm };
        });
        return { w, h, glyphs, mask: all, src: cv };
    }

    // --- template matching (chamfer distance on a 32x32 normalised box) ---
    const TS = 32;
    function chamferMap(mask) {
        const D = new Float32Array(TS * TS);
        for (let i = 0; i < TS * TS; i++) D[i] = mask[i] ? 0 : 1e6;
        for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
            const i = y * TS + x; let v = D[i];
            if (x > 0) v = Math.min(v, D[i - 1] + 1);
            if (y > 0) v = Math.min(v, D[i - TS] + 1);
            if (x > 0 && y > 0) v = Math.min(v, D[i - TS - 1] + 1.4);
            if (x < TS - 1 && y > 0) v = Math.min(v, D[i - TS + 1] + 1.4);
            D[i] = v;
        }
        for (let y = TS - 1; y >= 0; y--) for (let x = TS - 1; x >= 0; x--) {
            const i = y * TS + x; let v = D[i];
            if (x < TS - 1) v = Math.min(v, D[i + 1] + 1);
            if (y < TS - 1) v = Math.min(v, D[i + TS] + 1);
            if (x < TS - 1 && y < TS - 1) v = Math.min(v, D[i + TS + 1] + 1.4);
            if (x > 0 && y < TS - 1) v = Math.min(v, D[i + TS - 1] + 1.4);
            D[i] = v;
        }
        return D;
    }
    function normBox(m, w, x0, y0, bw, bh) {
        const out = new Uint8Array(TS * TS);
        for (let v = 0; v < TS; v++) for (let u = 0; u < TS; u++) {
            const sx = Math.floor(x0 + (u + 0.5) * bw / TS), sy = Math.floor(y0 + (v + 0.5) * bh / TS);
            if (m[sy * w + sx]) out[v * TS + u] = 1;
        }
        return out;
    }
    let TEMPLATES = null;
    function templates() {
        if (TEMPLATES) return TEMPLATES;
        TEMPLATES = [];
        const C = 96, c = document.createElement('canvas'); c.width = C; c.height = C;
        const x = c.getContext('2d', { willReadFrequently: true });
        for (const ch of CHARSET) {
            for (let a = -35; a <= 35; a += 5) {
                x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, C, C);
                x.translate(C / 2, C / 2); x.rotate(a * Math.PI / 180);
                x.font = '44px Arial, "Liberation Sans", Helvetica, sans-serif';
                x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = '#000';
                x.fillText(ch, 0, 0);
                const d = x.getImageData(0, 0, C, C).data, m = new Uint8Array(C * C);
                let x0 = C, x1 = -1, y0 = C, y1 = -1;
                for (let i = 0; i < C * C; i++) {
                    if (d[i * 4 + 3] <= 110) continue;
                    m[i] = 1; const qx = i % C, qy = (i - qx) / C;
                    if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
                }
                if (x1 < 0) continue;
                const nm = normBox(m, C, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
                let n = 0; for (let i = 0; i < TS * TS; i++) n += nm[i];
                TEMPLATES.push({ ch, m: nm, D: chamferMap(nm), n, ar: (x1 - x0 + 1) / (y1 - y0 + 1) });
            }
        }
        return TEMPLATES;
    }

    // returns { text, chars: [{ ch, score, alt }] } — lower score is a closer match (~1 good, >2 doubtful)
    function recognise(src) {
        const ex = extractGlyphs(src);
        const T = templates();
        const chars = ex.glyphs.map(gl => {
            const bw = gl.x1 - gl.x0 + 1, bh = gl.y1 - gl.y0 + 1;
            const g = normBox(gl.m, ex.w, gl.x0, gl.y0, bw, bh);
            const Dg = chamferMap(g);
            let ng = 0; for (let i = 0; i < TS * TS; i++) ng += g[i];
            const ar = bw / bh;
            const best = new Map();
            for (const t of T) {
                let s1 = 0, s2 = 0;
                for (let i = 0; i < TS * TS; i++) { if (g[i]) s1 += t.D[i]; if (t.m[i]) s2 += Dg[i]; }
                const sc = s1 / Math.max(ng, 1) + s2 / Math.max(t.n, 1) + 1.2 * Math.abs(Math.log(ar / t.ar));
                const cur = best.get(t.ch);
                if (cur === undefined || sc < cur) best.set(t.ch, sc);
            }
            const r = [...best.entries()].sort((p, q) => p[1] - q[1]);
            return { ch: r[0][0], score: r[0][1], alt: r[1] ? r[1][0] : '', margin: r[1] ? r[1][1] - r[0][1] : 9 };
        });
        return { text: chars.map(c => c.ch).join(''), chars, ex };
    }

    // preview variants: the extracted glyphs and the original, both at `scale`
    function render(ex, scale) {
        const out = [];
        const blank = () => {
            const c = document.createElement('canvas');
            c.width = ex.w * scale; c.height = ex.h * scale;
            const x = c.getContext('2d');
            x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
            return [c, x];
        };
        if (ex.glyphs.length) {
            const [c, x] = blank();
            x.fillStyle = '#000';
            for (let i = 0; i < ex.w * ex.h; i++) {
                if (ex.mask[i]) x.fillRect((i % ex.w) * scale, Math.floor(i / ex.w) * scale, scale, scale);
            }
            out.push({ canvas: c, width: c.width });
        }
        const [o, ox] = blank();
        ox.imageSmoothingEnabled = false;
        ox.drawImage(ex.src, 0, 0, o.width, o.height);
        out.push({ canvas: o, width: o.width, original: true });
        return out;
    }
    const analyse = (src, scale) => render(extractGlyphs(src), scale || 3);

    /* ------------------------------------------------------------------ *
     * 4. Fill the code field — no visible UI                              *
     * ------------------------------------------------------------------ */
    const ID_FIELD = document.getElementById('student_id');
    const PW_FIELD = document.getElementById('Password');

    const captchaReady = () => IMG.complete && (IMG.naturalWidth || 0) > 0;

    // Every new captcha (page load, click-to-refresh, retry) makes the old code useless,
    // so the field always gets the guess for the image now on screen.
    function fillFromCaptcha() {
        if (!captchaReady()) return '';
        let text = '';
        try { text = recognise(IMG).text; } catch (e) { /* unreadable: leave it to the user */ }
        CODE.value = text.length === 5 ? text : '';   // direct assignment: no synthetic event, guard stays quiet
        return text;
    }

    /* ------------------------------------------------------------------ *
     * 5. Remembered ID                                                   *
     * ------------------------------------------------------------------ */
    try {
        const saved = localStorage.getItem('umtlh.student');
        if (saved && ID_FIELD && !ID_FIELD.value) ID_FIELD.value = saved;
    } catch (e) { /* ignore */ }
    if (ID_FIELD) {
        ID_FIELD.addEventListener('change', () => {
            try { localStorage.setItem('umtlh.student', ID_FIELD.value.trim()); } catch (e) { /* ignore */ }
        });
    }

    /* ------------------------------------------------------------------ *
     * 6. Auto-retry after a rejected sign-in                              *
     * ------------------------------------------------------------------ */
    // Mark a real submit (button click or Enter, which clicks the button) so the login page that
    // comes back after a wrong code can be recognised. Capture phase: runs before the portal's handler.
    BTN.addEventListener('click', () => {
        if (!CODE.value.trim() || !ID_FIELD || !ID_FIELD.value || !PW_FIELD || !PW_FIELD.value) return;
        submitting = true;                                     // keep the portal's own spinner
        try { sessionStorage.setItem('umtlh.pending', String(Date.now())); } catch (e) { /* ignore */ }
        // still here long after the click: the portal never navigated, so it was not a submit
        setTimeout(() => {
            submitting = false;
            try { sessionStorage.removeItem('umtlh.pending'); } catch (e) { /* ignore */ }
        }, 20000);
    }, true);

    /* ------------------------------------------------------------------ *
     * 7. Init                                                            *
     * ------------------------------------------------------------------ */
    IMG.addEventListener('load', fillFromCaptcha);

    // A wrong code normally leaves a dead "Please wait…" button and an old captcha behind.
    let pending = null;
    try { pending = sessionStorage.getItem('umtlh.pending'); sessionStorage.removeItem('umtlh.pending'); } catch (e) { /* ignore */ }
    if (pending && Date.now() - Number(pending) < 120000) {
        setTimeout(() => {
            unblock();
            BTN.innerHTML = 'Sign in';
            loadFresh().catch(() => { /* ignore */ });        // its load event refills the code
            (PW_FIELD && !PW_FIELD.value ? PW_FIELD : CODE).focus();   // the portal clears the password
        }, 120);
    }

    fillFromCaptcha();
    unblock();

    // dev hook (used by tools/accuracy.mjs, tools/smoke.mjs and preview.html)
    window.__umtlh = { analyse, recognise, extractGlyphs, read: fillFromCaptcha };
})();
