import { chromium } from "playwright";
const D = "/Users/master/projects/emerge-hackathon/coach-console/runs/feedback-2026-10-17T15-50/coach";
const b = await chromium.launch();
try {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto("https://patient-360.raava.dev/#p-c5-P0002.c5", { waitUntil: "networkidle" });
  await p.waitForTimeout(1000);
  await p.getByText("More detail · Lines that need a person").click();
  await p.waitForTimeout(800);
  await p.screenshot({ path: `${D}/05-more-detail.png`, fullPage: true });
  const det = await p.locator("details").first().innerText().catch(() => "");
  console.log("DETAILS:\n", det.slice(0, 2500));
  const card = p.getByText("Call 5 · week 8").first();
  const tag = await card.evaluate(e => { let n = e; while (n && !["A","BUTTON"].includes(n.tagName)) n = n.parentElement; return n ? n.tagName + " " + (n.getAttribute("href")||"") : "none"; });
  console.log("CARD clickable:", tag);
  await card.click();
  await p.waitForTimeout(2500);
  console.log("URL after card click", p.url());
  await p.screenshot({ path: `${D}/06-call-card-click.png`, fullPage: true });
  console.log((await p.innerText("body")).slice(0, 4000));
} finally { await b.close(); }
