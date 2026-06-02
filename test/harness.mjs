// Feedback-loop harness: drives the real page in headless Chromium,
// runs detection on the sample image, and reports what came out.
import puppeteer from "puppeteer";

const URL = "http://localhost:8085/";
const SHOT = process.argv[2] || "shot.png";

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 1000 });

const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });

// Wait for OpenCV ready (status flips to "ready" class)
await page.waitForFunction(
  () => document.getElementById("status")?.classList.contains("ready"),
  { timeout: 60000 }
).catch(() => logs.push("[harness] OpenCV never became ready"));

// Load sample, wait for detect button enabled
await page.click("#sampleBtn");
await page.waitForFunction(
  () => !document.getElementById("detectBtn")?.disabled,
  { timeout: 30000 }
).catch(() => logs.push("[harness] detect button never enabled"));

await page.click("#detectBtn");

// Wait until detection done (status text changes away from "Detecting")
await page.waitForFunction(
  () => {
    const s = document.getElementById("status")?.textContent || "";
    return /complete|error/i.test(s);
  },
  { timeout: 30000 }
).catch(() => logs.push("[harness] detection did not finish"));

await new Promise((r) => setTimeout(r, 400));

const result = await page.evaluate(() => {
  const status = document.getElementById("status")?.textContent;
  const diag = document.getElementById("diag")?.textContent;
  const cards = [...document.querySelectorAll(".face-card")].map((card) => {
    const title = card.querySelector("h3")?.textContent;
    const cells = [...card.querySelectorAll(".cell")].map((c) => ({
      code: c.querySelector(".lbl")?.textContent,
      title: c.title,
    }));
    return { title, cells };
  });
  return { status, diag, cards };
});

await page.screenshot({ path: SHOT, fullPage: true });

console.log("=== STATUS ===\n" + result.status);
console.log("\n=== DIAGNOSTICS ===\n" + result.diag);
console.log("\n=== FACES ===");
for (const c of result.cards) {
  console.log(c.title);
  for (let i = 0; i < 9; i += 3) {
    console.log("  " + c.cells.slice(i, i + 3).map((x) => x.code).join(" "));
  }
}
console.log("\n=== CONSOLE/ERRORS ===\n" + (logs.join("\n") || "(none)"));
console.log("\nscreenshot: " + SHOT);

await browser.close();
