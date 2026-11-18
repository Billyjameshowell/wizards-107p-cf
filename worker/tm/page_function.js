// Runs inside apify/playwright-scraper. Loads the TM event page through a
// residential proxy, then pulls TM's own inventory JSON (quickpicks, which
// carries section/row/seats + embedded offers with listPrice/totalPrice and
// inventoryType primary|resale) from the same browser session.
async function pageFunction(context) {
    const { page, request, log } = context;
    const eventId = request.userData.eventId;
    const qty = request.userData.qty || 2;
    const maxPages = request.userData.maxPages || 6;
    await page.waitForTimeout(4000);
    const html = await page.content();
    const title = await page.title();
    const challenge = /captcha|px-captcha|Pardon the Interruption|access denied|Your browsing activity has been paused|queue-it|verify you are a human/i.test(html + ' ' + title);
    const captured = (page.__tmCaptured || []).slice(0, 20);
    const pages = [];
    const errors = [];
    if (!challenge) {
        const base = 'https://services.ticketmaster.com/api/ismds/event/' + eventId + '/quickpicks';
        for (let i = 0; i < maxPages; i++) {
            const qs = new URLSearchParams({
                show: 'places+maxQuantity+sections',
                mode: 'primary:ppsectionrow+resale:ga_areas+primary:ga_areas',
                qty: String(qty),
                includeStandard: 'true', includeResale: 'true', includePrice: 'true',
                embed: 'offer', sort: 'listprice', limit: '100', offset: String(i * 100),
                resaleChannelId: 'internal.ecommerce.consumer.desktop.web.browser.ticketmaster.us',
                apikey: request.userData.tmApiKey, apisecret: request.userData.tmApiSecret,
            });
            const res = await page.evaluate(async (url) => {
                try {
                    const r = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
                    return { status: r.status, body: await r.text() };
                } catch (e) { return { status: 0, body: String(e) }; }
            }, base + '?' + qs.toString().replace(/%2B/g, '+'));
            let json = null;
            try { json = JSON.parse(res.body); } catch (e) { errors.push({ page: i, status: res.status, snippet: res.body.slice(0, 300) }); break; }
            pages.push({ page: i, status: res.status, json });
            const picks = (json && json.picks) || [];
            if (res.status !== 200 || picks.length < 100) break;
        }
    }
    log.info(`challenge=${challenge} pages=${pages.length} captured=${captured.length}`);
    return { eventId, url: request.url, title, challenge, httpStatus: context.response ? context.response.status() : null,
             htmlLength: html.length, quickpicks: pages, captured, errors };
}
