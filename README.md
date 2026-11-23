# UMT Login Helper (userscript + extension)

A small Tampermonkey/Violentmonkey userscript (also packaged as an unpacked Chrome extension) for
`https://online.umt.edu.pk/` that attacks three concrete annoyances in the portal's login page:

| Pain | What the script does |
|------|---------------------|
| The captcha is 5 small rotated characters under curves, lines and speckle | Reads it **locally in ~25 ms** and fills the code field — on page load and every time the captcha changes. No panel or box is added to the page; nothing is downloaded or uploaded |
| One wrong code dead-ends the page until a full reload | On a rejected sign-in it loads a **fresh captcha in place**, fills it, re-enables the button and puts the cursor in the password field |
| `Scripts/portal-guard.js` disables the sign-in button when it thinks an extension is present | Observer removes the guard overlay and re-enables `#loginbtn` immediately |

---

## Install

Three ways, easiest first. **Nothing has to be pasted if you use route 2 or 3.**

### 1. Tampermonkey — paste (one time, ~20 s)

1. Install **Tampermonkey** (Chrome / Edge / Firefox) or Violentmonkey.
2. Tampermonkey dashboard → **+** (new script) → delete the boilerplate.
3. Paste the whole of `umt-login-helper.user.js` → **Ctrl+S**.
4. Open <https://online.umt.edu.pk/> — the code field is filled automatically.

<details>
<summary>Skips the paste: install straight from the file</summary>

With Tampermonkey installed, `chrome://extensions` → Tampermonkey → **Details** → enable **Allow access to file URLs**.
Then Ctrl+O / drag `umt-login-helper.user.js` into a tab: Tampermonkey shows its install screen, press **Install**.
</details>

### 2. No extension manager at all — DevTools console

Open the portal, press **F12** → **Console** (if Chrome complains, type `allow pasting` and Enter), paste the contents of
`umt-login-helper.user.js`, Enter. Works immediately, but must be re-pasted on every page load.

### 3. As a real extension — "Load unpacked" (no Tampermonkey, no paste)

1. `chrome://extensions` → enable **Developer mode** (top-right).
2. **Load unpacked** → pick the `extension/` folder in this project.
3. Reload the portal. It stays installed and enabled for the portal only.

Already loaded an older copy? Press the **reload** arrow on its card in `chrome://extensions`, then reload the portal.

`extension/content.js` is a generated copy of the userscript (the userscript is the source of truth): after editing the
userscript, regenerate it with
`{ echo "// Generated from ../umt-login-helper.user.js — keep both copies in step (same code, no changes)."; tail -n +11 umt-login-helper.user.js; } > extension/content.js`.
The manifest runs it with `"world": "MAIN"` (Chrome 111+), i.e. in the page's own JavaScript context, exactly like
Tampermonkey's `@grant none`; without that the paste fix does not apply. Chrome 158 ignores the `--load-extension`
command-line switch, so `tools/extension-check.mjs` installs the extension through Puppeteer's `enableExtensions` (CDP)
instead; it prints `EXTENSION ROUTE OK` when everything works.

No restart needed; disable or remove any of the three the same way you installed it.

---

## Using it

* Open the login page: the **code field is already filled**. Type your ID and password, glance at the captcha to
  confirm the code, and sign in as usual (button or Enter).
* Code looks wrong? **Click the captcha** (the portal's own refresh) — the new code is filled in automatically. You can
  also just correct the field; paste works too (the portal blocks it with `onPaste="return false"`).
* After a wrong code the portal clears the **password** field itself; the helper does not store passwords, so type it
  again — the fresh code is already filled.
* Your student ID is remembered in `localStorage` (only the ID).
* There is no panel and nothing to configure. Version 1.1 had a "Captcha helper" box with zoom, toggles and an unsure
  flag; it was removed in 1.2.

### Why it does not make the guard worse

`portal-guard.js` flags (a) one blacklisted Chrome extension id, (b) body classes `umt-redesigned` / `umt-skinned` and
element ids `_umt_badge` / `umt-profile-panel`, (c) synthetic `input`/`change` events on `#SecurityCode`
(`isTrusted === false`).

The script adds no body classes and no elements at all, and **assigns `.value` directly instead of dispatching
events** — so it produces no synthetic event and trips none of the three checks. If something else already tripped the
guard, the overlay is removed and the button re-enabled.

---

## How the reader works

Every character of this captcha is drawn in **one solid colour** (with ClearType colour fringes), about 3 px thick and
13–21 × 19–24 px in size. The interference curves span the whole width, the straight lines are pale or one stroke
wide, the speckle is tiny. So, in `extractGlyphs()`:

1. Histogram the exact pixel colours; colours with ≥ 25 pixels that are not pale seed candidate glyphs.
2. For each seed colour, join its pixels into pieces (pieces overlapping in x are one glyph cut by a curve), add a
   1-px rim of anti-aliased pixels, and keep glyph-sized pieces. Straight-line pieces (thin along their minor axis)
   are kept aside and only used to fill a slot that is still empty.
3. Take the 5 strongest, left to right, and close the 1–3 px gaps where a curve crossed a character.

Then `recognise()` compares each glyph (normalised to 32 × 32) with the 32 allowed characters drawn in Arial at
−35…35° in 5° steps, using a two-way chamfer distance plus an aspect-ratio term, and takes the closest. Each character
also gets a score; above 1.5 means unsure (shown by `preview.html` and `tools/accuracy.mjs`).

The character set is `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no `I`, `O`, `0`, `1`): not one of those four appeared in 190
live glyphs, while every other character did.

## Accuracy, honestly

Measured on 23 Nov 2026:

| Test | Result |
|------|--------|
| Offline, 38 hand-labelled live captchas (`node tools/accuracy.mjs`) — 22 used for tuning, 16 held out | **29 / 38 whole codes (76 %)**, **177 / 190 characters (93 %)**; held-out alone 12 / 16 and 74 / 80 |
| Real login with a real account, through the extension | **accepted at the first attempt** |
| The previous Tesseract pipeline, same real account | 0 / 3 accepted ("Invalid Code"); offline 0 / 6 whole codes |
| Tesseract on the new clean glyphs (tried, not shipped) | 1 / 22 whole codes, 53 / 110 characters |

The "unsure" flag catches about half of the wrong characters (6 of 13) and wrongly flags about 1 % of right ones
(2 of 177). Typical failures: a curve of nearly the same colour running through a character (`E`→`F`, `U`→`L`), or
`A`↔`4`. So glance at the captcha before you sign in; if a character looks off, click the captcha for a new code
(costs no attempt). A wrong code costs one attempt, after which the helper fills a fresh one.

**Correction of earlier numbers.** Older versions of this README reported "9 / 10 accepted" and "the portal accepts
`qqqqq`". Those runs (`tools/impl-bench.mjs`, `tools/bench.mjs`, `tools/collect.mjs`) posted a **fake student ID** and
counted any reply without "Invalid Code" as a correct read — but for an unknown ID the portal evidently answers before
checking the code. With a real account it rejects wrong codes (3 / 3 rejected in the test above). Treat acceptance
measured with fake credentials as meaningless.

## Can the code be predicted instead of read?

Checked on 23 Nov 2026. Short version: **no**.

* The image is a GDI+/`System.Drawing` PNG (`RGBA`, `sRGB`/`gAMA`/`pHYs` before `IDAT`, no `tEXt`) — the code is drawn
  server-side into pixels and nowhere else.
* The code exists only in the ASP.NET session (`Set-Cookie: ASP.NET_SessionId=…` on the captcha GET), `no-store`,
  and **every GET issues a new code** (5/5 distinct hashes). No audio endpoint, no code in the filename, headers, `alt`
  or a hidden field.

So the remaining option is reading the pixels, which is what the script does. (An earlier experiment concluded that
template matching loses to Tesseract; that was with masks from the old two-colour cleaner, where characters were split
across groups. With per-colour glyph extraction and rotated templates it is far ahead, see above.)

## Files

| File | Purpose |
|------|---------|
| `umt-login-helper.user.js` | The userscript (self-contained, source of truth) |
| `extension/` | Same code as an unpacked MV3 extension (`manifest.json` + generated `content.js` + icons) |
| `preview.html` | Offline viewer: runs the userscript's recogniser on labelled samples or your own images (serve the folder over HTTP for the bundled samples) |
| `samples/labelled/*.png` | 38 live captchas, each named after the code it shows (23 Nov 2026) |
| `samples/c1…c5.png` | Older unlabelled captchas |
| `tools/accuracy.mjs` | Offline accuracy of the shipped recogniser on `samples/labelled/` (no network, no login) |
| `tools/smoke.mjs` | Puppeteer smoke test on the live page (11 checks: guard fix, no added elements, auto-fill, refresh refill, paste, auto-retry after one submit with a fake ID) |
| `tools/extension-check.mjs` | Loads `extension/` into real Chrome and checks MAIN world, auto-filled code, no added elements, paste, button (no submit) |
| `tools/real-submit.mjs` | Diagnostic of the portal's submit behaviour |
| `tools/bench.mjs`, `tools/impl-bench.mjs`, `tools/collect.mjs`, `tools/probe.mjs`, `tools/labelled.json` | **Legacy** Tesseract-era experiments. They call functions the script no longer has and rely on fake-ID acceptance (see the correction above); kept only for reference |

Run them with `cd tools && npm i && node accuracy.mjs` (Chrome must be at the default install path; `node_modules/` is
git-ignored and safe to delete).

## Notes / limits

* No network access is needed by the helper itself; it works offline once the portal page has loaded.
* The script only acts on the login view (`/` and `/Account/Login*`); nothing else on the portal is touched.
* Purely client-side: the password field is only read at submit time by the portal itself, never stored; only the
  student ID is optionally remembered in `localStorage`.
* The reader is tuned to *this* captcha (170×56, one solid colour per character, Arial-like font). If UMT changes the
  style, retune the `RP` constants and `CHARSET` in the userscript, add newly labelled samples to
  `samples/labelled/`, and check with `node tools/accuracy.mjs`. A different challenge type would need a new reader.
