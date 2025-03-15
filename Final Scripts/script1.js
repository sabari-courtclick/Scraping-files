import puppeteer from "puppeteer";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const baseUrl = process.env.baseUrl;
const cnrNumbers = [
  "KLER150000052020",
];
const API_KEY = process.env.apiKey;

// Variable to store successfully scraped CNR numbers
const successfulCNRs = [];

async function solveCaptcha(base64Image) {
  const url = "http://2captcha.com/in.php";
  const formData = new FormData();
  formData.append("key", API_KEY);
  formData.append("method", "base64");
  formData.append("body", base64Image);
  formData.append("json", "1");

  try {
    const response = await axios.post(url, formData, {
      headers: {
        "Content-Type": "multipart/form-data",
      },
    });

    const captchaId = response.data.request;
    console.log("[INFO] CAPTCHA submitted to 2captcha. ID:", captchaId);

    const resultUrl = `http://2captcha.com/res.php?key=${API_KEY}&action=get&id=${captchaId}&json=1`;
    let captchaResult;

    do {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait 5 seconds before checking
      captchaResult = await axios.get(resultUrl);
    } while (captchaResult.data.status === 0); // Keep checking until CAPTCHA is solved

    console.log("[INFO] CAPTCHA solved:", captchaResult.data.request);
    return captchaResult.data.request;
  } catch (error) {
    console.error("[ERROR] CAPTCHA solving error:", error);
    return null;
  }
}

async function processCNR(cnrNumber, browser) {
  const startTime = Date.now(); // Start timer
  const page = await browser.newPage();

  try {
    await page.goto(baseUrl);

    const hasError = await page.evaluate(() => {
      return (
        document.body.innerText.includes("Oops") &&
        document.body.innerText.includes("Invalid Request")
      );
    });

    if (hasError) {
      console.log(
        "[WARN] 'Oops! Invalid Request' page detected. Clicking the refresh link..."
      );
      const refreshLink = await page.$("div#msg-danger a");

      if (refreshLink) {
        await refreshLink.click();
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        console.log("[ERROR] Refresh link not found! Reloading manually...");
        await page.reload({ waitUntil: "networkidle2" });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    await page.waitForSelector("#captcha_image");
    const captchaElement = await page.$("#captcha_image");
    const base64Image = await captchaElement.screenshot({
      encoding: "base64",
      omitBackground: true,
    });

    console.log("[INFO] Sending CAPTCHA to 2captcha service...");
    const captchaText = await solveCaptcha(base64Image);

    if (!captchaText) {
      console.error("[ERROR] Failed to solve CAPTCHA");
      return;
    }

    console.log("[INFO] 2captcha solution received:", captchaText);

    await page.type("#fcaptcha_code", captchaText);
    console.log("[INFO] CAPTCHA text entered");
    await page.type("#cino", cnrNumber);
    console.log("[INFO] CNR number entered:", cnrNumber);

    console.log("[INFO] Clicking search button...");
    await page.click("#searchbtn");

    let caseDetailsExists = await page.waitForSelector(
      "table.case_details_table"
    );

    if (!caseDetailsExists) {
      console.log("[WARN] Case details not found, retrying...");
    } else {
      console.log(
        "[INFO] Case details loaded successfully. Scraping table data..."
      );

      const allTableData = await page.evaluate(() => {
        const result = {
          caseDetails: [],
          caseStatus: [],
          petitionerAdvocate: [],
          respondentAdvocate: [],
          actsAndSections: [],
          iaStatus: [],
          subCourtDetails: [],
          firDetails: [],
          caseHistory: [],
        };

        document
          .querySelectorAll("table.case_details_table tr")
          .forEach((row) => {
            const rowData = Array.from(row.querySelectorAll("td")).map((td) =>
              td.innerText.trim()
            );
            if (rowData.length) result.caseDetails.push(rowData);
          });

        document
          .querySelectorAll("table.case_status_table tr")
          .forEach((row) => {
            const rowData = Array.from(row.querySelectorAll("td")).map((td) =>
              td.innerText.trim()
            );
            if (rowData.length) result.caseStatus.push(rowData);
          });

        document
          .querySelectorAll("table.Petitioner_Advocate_table tr")
          .forEach((row) => {
            const rowData = Array.from(row.querySelectorAll("td")).map((td) =>
              td.innerText.trim()
            );
            if (rowData.length) result.petitionerAdvocate.push(rowData);
          });

        document
          .querySelectorAll("table.Respondent_Advocate_table tr")
          .forEach((row) => {
            const rowData = Array.from(row.querySelectorAll("td")).map((td) =>
              td.innerText.trim()
            );
            if (rowData.length) result.respondentAdvocate.push(rowData);
          });

        document.querySelectorAll("table.acts_table tr").forEach((row) => {
          const rowData = Array.from(row.querySelectorAll("th, td")).map(
            (cell) => cell.innerText.trim()
          );
          if (rowData.length) result.actsAndSections.push(rowData);
        });

        document.querySelectorAll("table.IAheading tr").forEach((row) => {
          const rowData = Array.from(row.querySelectorAll("th, td")).map(
            (cell) => cell.innerText.trim()
          );
          if (rowData.length) result.iaStatus.push(rowData);
        });

        document
          .querySelectorAll("table.Lower_court_table  tr")
          .forEach((row) => {
            const rowData = Array.from(row.querySelectorAll("th, td")).map(
              (cell) => cell.innerText.trim()
            );
            if (rowData.length) result.subCourtDetails.push(rowData);
          });

        document
          .querySelectorAll("table.FIR_details_table tr")
          .forEach((row) => {
            const rowData = Array.from(row.querySelectorAll("th, td")).map(
              (cell) => cell.innerText.trim()
            );
            if (rowData.length) result.firDetails.push(rowData);
          });

        document.querySelectorAll("table.history_table tr").forEach((row) => {
          const rowData = Array.from(row.querySelectorAll("th, td")).map(
            (cell) => cell.innerText.trim()
          );
          if (rowData.length) result.caseHistory.push(rowData);
        });
        return result;
      });

      console.log("[INFO] Data formatted successfully", allTableData);
      await page.click("#main_back_cnr");

      // Add CNR number to successfulCNRs array
      successfulCNRs.push(cnrNumber);
    }
  } catch (error) {
    console.log("[ERROR]", error);
  } finally {
    try {
      await page.close();
    } catch (error) {
      console.log("[WARN] Error closing page:", error.message);
    }
  }

  const endTime = Date.now(); // End timer
  const timeTaken = (endTime - startTime) / 1000; // Calculate time taken in seconds
  console.log(`[INFO] Time taken for CNR ${cnrNumber}: ${timeTaken} seconds`);
}

async function main() {
  let browser = null;

  try {
    console.log("[INFO] Starting browser...");
    browser = await puppeteer.launch({
      headless: false,
      ignoreHTTPSErrors: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-features=VizDisplayCompositor",
        "--disable-extensions",
        "--disable-component-extensions-with-background-pages",
        "--disable-default-apps",
        "--mute-audio",
        "--no-zygote",
        "--no-first-run",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-breakpad",
        "--disable-site-isolation-trials",
        "--disable-translate",
        "--disable-blink-features=AutomationControlled",
      ],
      defaultViewport: { width: 800, height: 600 },
    });

    for (const cnrNumber of cnrNumbers) {
      await processCNR(cnrNumber, browser);
    }
  } catch (error) {
    console.error("[ERROR] Main process error:", error);
  } finally {
    if (browser) {
      try {
        await browser.close();
        console.log("[INFO] Browser closed");
      } catch (error) {
        console.error("[ERROR] Error closing browser:", error);
      }
    }
  }

  // Log successfully scraped CNR numbers
  console.log("[INFO] Successfully scraped CNR numbers:", successfulCNRs);
}

main();