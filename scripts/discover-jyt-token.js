// Diagnostic: navigate JYT H5 WITHOUT injecting any token. Log every request/response
// to see if JYT auto-issues a token via some init/guest/anonymous endpoint.
// Run: node scripts/discover-jyt-token.js [car_code]

const puppeteer = require('puppeteer');

(async () => {
    const carCode = process.argv[2] || 'abc123';
    const targetUrl = `https://h5.jytche.com/car-detail?car_code=${carCode}`;

    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1');

    const requestLog = [];
    const responseLog = [];

    page.on('request', (req) => {
        const url = req.url();
        if (url.startsWith('data:')) return;
        if (/\.(png|jpe?g|svg|css|woff2?|ttf|ico|webp|gif)(\?|$)/i.test(url)) return;
        if (/google|baidu|analytics/.test(url)) return;
        requestLog.push({
            method: req.method(),
            url,
            headers: req.headers(),
            postData: req.postData() || null
        });
    });

    page.on('response', async (resp) => {
        const url = resp.url();
        if (url.startsWith('data:')) return;
        if (/\.(png|jpe?g|svg|css|woff2?|ttf|ico|webp|gif)(\?|$)/i.test(url)) return;
        if (/google|baidu|analytics/.test(url)) return;
        const status = resp.status();
        let body = null;
        try {
            const ct = (resp.headers()['content-type'] || '').toLowerCase();
            if (ct.includes('json') || ct.includes('text')) {
                body = (await resp.text()).slice(0, 500);
            }
        } catch (_) {}
        responseLog.push({ status, url, body });
    });

    console.log(`Navigating to: ${targetUrl}`);
    try {
        await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    } catch (e) {
        console.log('Nav error (expected if token missing):', e.message);
    }

    await new Promise((r) => setTimeout(r, 5000));

    // Dump localStorage
    const storage = await page.evaluate(() => {
        const items = {};
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                items[k] = localStorage.getItem(k);
            }
        } catch (_) {}
        return items;
    });

    console.log('\n=== localStorage after load ===');
    console.log(JSON.stringify(storage, null, 2));

    console.log(`\n=== ALL REQUESTS (total ${requestLog.length}) ===`);
    requestLog.forEach(r => {
        console.log(`[${r.method}] ${r.url}`);
        const tokenHdr = r.headers['access-token'] || r.headers['Access-Token'];
        if (tokenHdr) console.log(`  Access-Token: ${tokenHdr}`);
        if (r.postData) console.log(`  body: ${r.postData.slice(0, 300)}`);
    });

    console.log(`\n=== API RESPONSES (total ${responseLog.length}) ===`);
    responseLog.forEach(r => {
        console.log(`[${r.status}] ${r.url}`);
        if (r.body) console.log(`  body: ${r.body.slice(0, 300)}`);
    });

    await browser.close();
})().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
