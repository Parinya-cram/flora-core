// Screenshots for the Leaf / Canopy user guide (headless Chrome, demo data only).
const puppeteer = require("puppeteer-core");
const path = require("path");
const OUT = process.argv[2];
const which = process.argv[3] || "leaf";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function clickText(page, text, selector = "button") {
  const ok = await page.evaluate((text, selector) => {
    const el = [...document.querySelectorAll(selector)].find(e => e.textContent.trim() === text || e.getAttribute("aria-label") === text) || [...document.querySelectorAll(selector)].find(e => e.textContent.trim().startsWith(text));
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.click();
    return true;
  }, text, selector);
  if (!ok) throw new Error(`not found: ${selector} "${text}"`);
  await sleep(900);
}
async function shot(page, name, clip) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip ? { clip } : {}) });
  console.log("shot", name);
}
async function login(page, base, api) {
  await page.goto(base, { waitUntil: "networkidle2" });
  await page.evaluate(async api => {
    const d = await (await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) })).json();
    localStorage.setItem("flora_auth_token", d.session_token || d.token);
  }, api);
  await page.goto(base, { waitUntil: "networkidle2" });
  await sleep(2500);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--ignore-certificate-errors", "--lang=en-US"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  try {
    if (which === "leaf" || which === "leaf2") {
      await login(page, "http://127.0.0.1:7320/", "/api/auth/login");
      // Billing: template with preselected items and I/O hints
      await clickText(page, "Billing"); await sleep(2500);
      if (which === "leaf") {
      await shot(page, "L01-billing-template");
      await clickText(page, "Fill from chart"); await sleep(2500);
      await shot(page, "L02-billing-filled");
      }
      // Print sheet (rendered in a page of its own)
      const sheet = await page.evaluate(async () => {
        const m = await import("/src/components/billing/billingSheet.ts");
        const st = await (await fetch("/api/case/status")).json();
        const cat = await (await fetch("/api/case/billing/catalog")).json();
        const b = await (await fetch(`/api/case/${st.case_id}/billing`)).json();
        const o = b.order;
        return m.buildBillingSheetHtml({ catalog: cat, lines: b.items, signers: o.signers, dischargeLocation: o.discharge_location || "PACU",
          anesthesia: [o.anesthesia_start, o.anesthesia_end], surgery: [o.surgery_start, o.surgery_end], status: o.status,
          layout: b.template ? (() => {
            const groups = b.template.groups.map(g => ({ code: g.key, name: g.name, items: g.items.map(i => cat.items.find(x => x.code === i.code)).filter(Boolean) }));
            const shown = new Set(groups.flatMap(g => g.items.map(i => i.code)));
            const others = b.items.filter(l => l.item_code && !shown.has(l.item_code)).map(l => cat.items.find(x => x.code === l.item_code)).filter(Boolean);
            if (others.length) groups.push({ code: "_additional", name: "Additional items", items: others });
            return groups;
          })() : undefined,
          header: { patientName: "Suda Prasertsuk (demo)", hn: "D-HL7-001", an: "AN-DEMO-01", age: "52 Y", gender: "Female", bloodType: "O+", weight: "58 kg", height: "158 cm",
            postOpDx: "Spondylolisthesis L4-L5", operation: "Lumbar interbody fusion L4-L5", allergy: "NONE", asa: "2", caseType: "Neuro" } });
      });
      const printPage = await browser.newPage();
      await printPage.setViewport({ width: 1100, height: 1500, deviceScaleFactor: 2 });
      await printPage.setContent(sheet.replace("<body>", '<body style="background:#fff;padding:24px">'), { waitUntil: "load" });
      const height = await printPage.evaluate(() => Math.ceil(document.querySelector(".meta").getBoundingClientRect().bottom + 24));
      await printPage.screenshot({ path: path.join(OUT, "L04-billing-print.png"), clip: { x: 0, y: 0, width: 1100, height } }); console.log("shot L04-billing-print");
      await printPage.close();
      // Submit → locked banner
      await page.evaluate(() => window.scrollTo(0, 0)); await page.evaluate(() => [...document.querySelectorAll("h1")].find(h => h.textContent.includes("Anesthesia Check List"))?.scrollIntoView({ block: "start" })); await sleep(500);
      if (which === "leaf") {
      await clickText(page, "Submit"); await sleep(2000);
      await shot(page, "L05-billing-submitted", { x: 0, y: 0, width: 1440, height: 420 });
      await clickText(page, "Reopen"); await sleep(1500);
      }
      // Chart: masked values, toolbar, undo
      await clickText(page, "Chart"); await sleep(3500);
      const scale = await page.$('#case-timeline-scale');
      if (scale) {
        await page.evaluate(() => {
          const input = document.querySelector("#case-timeline-scale");
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "5");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        });
        await sleep(3500);
      }
      const cell = await page.evaluate(() => {
        const td = document.querySelector("td.timegrid-masked-cell");
        if (!td) return null;
        td.scrollIntoView({ block: "center", inline: "center" });
        const input = td.querySelector("input"); input?.focus(); input?.click();
        return true;
      });
      await sleep(1500);
      await shot(page, "L06-chart-masked");
      if (!cell) console.log("no masked cell found");
      // Event note with Speak
      await page.keyboard.press("Escape");
      await page.evaluate(() => { const row = [...document.querySelectorAll("td")].find(td => td.closest("tr")?.textContent?.startsWith("EVENT")); });
      await page.evaluate(() => window.scrollTo(0, 0)); await sleep(500);
      const opened = await page.evaluate(() => {
        const label = [...document.querySelectorAll("td, th, div")].find(e => e.textContent.trim() === "EVENT" || e.textContent.trim() === "Event");
        const row = label?.closest("tr");
        const cells = row ? [...row.querySelectorAll("td")] : [];
        const target = cells[Math.floor(cells.length / 2)];
        target?.click(); target?.querySelector("button, div")?.click();
        return Boolean(target);
      });
      await sleep(1200);
      await clickText(page, "Note").catch(() => undefined);
      await page.evaluate(() => { const t = document.querySelector('textarea[placeholder="Optional detail"]'); if (t) { t.focus(); } });
      await shot(page, "L07-event-speak");
      console.log("event modal", opened);
      await clickText(page, "Cancel").catch(() => undefined);
      // Forms: dictation modal (fake microphone)
      await clickText(page, "Forms"); await sleep(3500);
      await clickText(page, "Dictation").catch(async () => clickText(page, " Dictation"));
      await sleep(3000);
      await shot(page, "L08-form-dictation");
    } else {
      await login(page, "http://127.0.0.1:7200/", "/api/auth/login");
      await clickText(page, "Billing"); await sleep(3000);
      const search = await page.$('input[placeholder="HN, AN, name, case"]');
      await search.type("D-HL7"); await sleep(2500);
      await page.evaluate(() => [...document.querySelectorAll("tr")].find(tr => tr.textContent.includes("D-HL7-001"))?.click()); await sleep(2000);
      await shot(page, "C01-orders");
      await clickText(page, "Item master"); await sleep(2000);
      await shot(page, "C02-item-master");
      await clickText(page, "Workflow Studio"); await sleep(3000);
      await clickText(page, "Itemize templates"); await sleep(2000);
      await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.includes("OR general anesthesia items"))?.click()); await sleep(2000);
      await shot(page, "C03-template-editor");
      await clickText(page, "Workflows"); await sleep(2500);
      await page.evaluate(() => [...document.querySelectorAll("button")].find(b => b.textContent.includes("OR general (manual demo)"))?.click()); await sleep(2000);
      await page.evaluate(() => [...document.querySelectorAll("h3")].find(h => h.textContent.trim() === "Billing")?.scrollIntoView({ block: "center" })); await sleep(800);
      await shot(page, "C04-workflow-billing");
    }
  } catch (error) {
    console.error("FAILED", error.message);
    await shot(page, `zz-error-${which}`);
  } finally {
    await browser.close();
  }
})();
