// Verify that both samples (sample.jpg flat-sticker, algorithms.png angled
// 3-face) produce a sensible detection in the real browser app. Loads each,
// clicks Detect, asserts >=3 distinct colours in the face.
//
//   python3 server.py &
//   node test/verify-samples.mjs
import puppeteer from "puppeteer";

const URL = "http://localhost:8085/";
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

async function runOne(page, sample) {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(
    () => document.getElementById("status")?.classList.contains("ready"),
    { timeout: 60000 }
  );
  // Load the sample via the chip
  await page.evaluate((s) => {
    const chip = document.querySelector(`.sample-chip[data-sample="${s}"]`);
    if (!chip) throw new Error("chip missing: " + s);
    chip.click();
  }, sample);
  // Wait for image to load — detectBtn becomes enabled
  await page.waitForFunction(
    () => !document.getElementById("detectBtn").disabled,
    { timeout: 30000 }
  );
  // Click detect
  await page.click("#detectBtn");
  // Wait until progress hides (renderSummary populates faces)
  await page.waitForFunction(
    () => {
      const wrap = document.getElementById("progressWrap");
      return wrap && !wrap.classList.contains("active");
    },
    { timeout: 90000 }
  );
  // Give the renderer a frame to flush
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: `tmp/verify-${sample.replace(/\W/g, "_")}.png`, fullPage: true });
  const result = await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll("#faces .cell .lbl"));
    const codes = cells.map((c) => c.textContent.trim()).filter(Boolean);
    const faceCount = document.querySelectorAll("#faces .face-card, #faces .grid3").length;
    const diag = document.getElementById("diag")?.textContent || "";
    const summary = document.getElementById("summary")?.textContent || "";
    const facesHtml = document.getElementById("faces")?.innerHTML?.slice(0, 200) || "";
    return { codes, faceCount, diag, summary, facesHtml };
  });
  return result;
}

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
page.on("console", (m) => { if (m.type() === "error") console.error("[page]", m.text()); });
page.on("pageerror", (e) => console.error("[pageerror]", e.message));

let failed = 0;
for (const s of ["sample.jpg", "algorithms.png"]) {
  try {
    const r = await runOne(page, s);
    const distinct = new Set(r.codes).size;
    console.log(`\n=== ${s} ===`);
    console.log("codes:", r.codes.join(" "));
    console.log("distinct:", distinct);
    console.log("summary:", r.summary.replace(/\s+/g, " ").trim().slice(0, 200));
    console.log("diag:", r.diag.split("\n").slice(0, 6).join(" | "));
    if (distinct < 3) { console.error(`FAIL ${s}: only ${distinct} distinct colour(s)`); failed++; }
    else { console.log(`OK ${s}: ${distinct} distinct colours`); }
  } catch (e) {
    console.error(`FAIL ${s}: ${e.message}`);
    failed++;
  }
}

await browser.close();
process.exit(failed ? 1 : 0);
