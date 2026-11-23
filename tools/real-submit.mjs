// Real form submit with a deliberately wrong captcha: is the captcha even enforced today?
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new', args: ['--no-sandbox'], protocolTimeout: 300000
});
for (let i = 0; i < 3; i++) {
    const page = await browser.newPage();
    let postBody = '';
    page.on('response', async r => {
        if (r.request().method() === 'POST') {
            try { postBody = await r.text(); } catch (e) { /* ignore */ }
        }
    });
    await page.goto('https://online.umt.edu.pk/', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.type('#student_id', 'S2025000000');
    await page.type('#Password', 'NotARealPassword1');
    await page.type('#SecurityCode', 'ZZZZZ');
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
        page.click('#loginbtn')
    ]);
    await new Promise(r => setTimeout(r, 500));
    const marks = (postBody.match(/(Invalid[\w ]{0,20}|Please Enter Code|swal[\s\S]{0,60})/g) || []).slice(0, 4);
    console.log(`#${i + 1} postBody ${postBody.length}B marks=${JSON.stringify(marks)} url=${page.url()}`);
    await page.close();
}
await browser.close();

