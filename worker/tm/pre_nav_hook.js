[
  async ({ page }) => {
    page.__tmCaptured = [];
    page.on('response', async (resp) => {
      const u = resp.url();
      if (/ismds\/event\/.+\/(quickpicks|facets)/.test(u)) {
        try { page.__tmCaptured.push({ url: u, status: resp.status(), json: await resp.json() }); } catch (e) {}
      }
    });
  }
]
