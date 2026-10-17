import { chromium } from "playwright";
const [out, ...pairs] = process.argv.slice(2);
const routes = (process.env.ROUTES || "today,patients,p-x-L2,p-c3-P03000").split(",");
const b = await chromium.launch();
for (const pair of pairs) {
  const [tag, base] = pair.split("=");
  for (const w of [1440, 390]) {
    const pg = await b.newPage({ viewport: { width: w, height: 900 }, colorScheme: "light" });
    for (const r of routes) {
      await pg.goto(`${base}/#${r}`, { waitUntil: "networkidle" }).catch(() => {});
      await pg.waitForTimeout(2500);
      await pg.screenshot({ path: `${out}/${tag}_${r}_${w}.png`, fullPage: true });
    }
    await pg.close();
  }
}
await b.close();
