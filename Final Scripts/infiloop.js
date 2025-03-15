import puppeteer from "puppeteer";
import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
dotenv.config();

const baseUrl = process.env.baseUrl;
const cnrNumber = "KLWD030000802019"; // Single CNR number to scrape
const API_KEY = process.env.apiKey;

// Variables to track metrics
let totalScrapes = 0; // Total number of scrapes attempted
let successfulScrapes = 0; // Total number of successful scrapes
let failedScrapes = 0; // Total number of failed scrapes
let totalTime = 0; // Total time taken for all scrapes (in milliseconds)

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

async function downloadPdf(pdfUrl, outputPath) {
  try {
    const response = await axios.get(pdfUrl, { responseType: "arraybuffer" });
    fs.writeFileSync(outputPath, response.data);
    console.log(`[INFO] PDF saved to ${outputPath}`);
  } catch (error) {
    console.error("[ERROR] Failed to download PDF:", error);
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

    // Ensure the CAPTCHA image is fully loaded
    const isCaptchaLoaded = await page.evaluate((element) => {
      return element.complete && element.naturalWidth > 0;
    }, captchaElement);

    if (!isCaptchaLoaded) {
      console.log("[WARN] CAPTCHA image not fully loaded. Retrying...");
      await page.waitForSelector("#captcha_image", { visible: true });
    }

    const base64Image = await captchaElement.screenshot({
      encoding: "base64",
      omitBackground: true,
    });

    console.log("[INFO] Sending CAPTCHA to 2captcha service...");
    let captchaText = await solveCaptcha(base64Image);

    // Retry CAPTCHA submission if it fails
    if (!captchaText) {
      console.log("[WARN] CAPTCHA submission failed. Retrying...");
      await page.waitForSelector("#captcha_image", { visible: true });
      const retryBase64Image = await captchaElement.screenshot({
        encoding: "base64",
        omitBackground: true,
      });
      captchaText = await solveCaptcha(retryBase64Image);
    }

    if (!captchaText) {
      console.error("[ERROR] Failed to solve CAPTCHA after retry");

      // Handle CAPTCHA error by closing the modal and clicking the back button
      const closeModalButton = await page.$(
        "button.btn-close[data-bs-dismiss='modal']"
      );
      if (closeModalButton) {
        console.log("[INFO] Closing the modal...");
        await closeModalButton.click();
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for modal to close
      }

      const backButton = await page.$("#main_back_cnr");
      if (backButton) {
        console.log("[INFO] Clicking the back button...");
        await backButton.click();
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait for page to reload
      }

      return false; // Indicate failure
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
      return false; // Indicate failure
    } else {
      console.log(
        "[INFO] Case details loaded successfully. Scraping table data..."
      );

      // Scrape the main case details
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
          businessDetails: [],
          interimOrders: [],
        };

        // Scrape main case details (existing logic)
        document
          .querySelectorAll("table.case_details_table tr")
          .forEach((row) => {
            const rowData = Array.from(row.querySelectorAll("td")).map((td) =>
              td.innerText.trim()
            );
            if (rowData.length) result.caseDetails.push(rowData);
          });

        // Scrape business details
        const businessDiv = document.querySelector("#caseBusinessDiv_cnr");
        if (businessDiv) {
          const businessData = {
            courtName: businessDiv.querySelector("center > span:nth-child(3)")
              .innerText,
            cnrNumber: businessDiv.querySelector("center > span:nth-child(4)")
              .innerText,
            caseNumber: businessDiv.querySelector("center > span:nth-child(5)")
              .innerText,
            parties: businessDiv.querySelector("center > span:nth-child(6)")
              .innerText,
            date: businessDiv.querySelector("center > span:nth-child(7)")
              .innerText,
            business: businessDiv.querySelector("td:nth-child(3)").innerText,
            nextPurpose: businessDiv.querySelector(
              "tr:nth-child(2) > td:nth-child(3)"
            ).innerText,
            nextHearingDate: businessDiv.querySelector(
              "tr:nth-child(3) > td:nth-child(3)"
            ).innerText,
          };
          result.businessDetails.push(businessData);
        }

        // Scrape interim orders (if any)
        const interimOrderLinks = document.querySelectorAll(
          "a.interim-order-link"
        );
        for (const link of interimOrderLinks) {
          const orderDetails = {
            orderText: link.innerText.trim(),
            pdfUrl: link.href,
          };
          result.interimOrders.push(orderDetails);
        }

        return result;
      });

      console.log("[INFO] Data formatted successfully", allTableData);

      // Download interim order PDFs
      for (const order of allTableData.interimOrders) {
        const pdfUrl = order.pdfUrl;
        const pdfFileName = path.basename(pdfUrl);
        const outputPath = path.join(__dirname, "pdfs", pdfFileName);

        console.log(`[INFO] Downloading PDF from ${pdfUrl}...`);
        await downloadPdf(pdfUrl, outputPath);
      }

      await page.click("#main_back_cnr");

      return true; // Indicate success
    }
  } catch (error) {
    console.log("[ERROR]", error);
    return false; // Indicate failure
  } finally {
    try {
      await page.close();
    } catch (error) {
      console.log("[WARN] Error closing page:", error.message);
    }
  }
}

async function main() {
  let browser = null;

  try {
    console.log("[INFO] Starting browser...");
    browser = await puppeteer.launch({
      headless: true,
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

    const startTime = Date.now(); // Start time of the loop
    const oneHour = 60 * 60 * 1000; // One hour in milliseconds

    while (Date.now() - startTime < oneHour) {
      totalScrapes++; // Increment total scrapes counter
      const scrapeStartTime = Date.now(); // Start time of the current scrape

      const success = await processCNR(cnrNumber, browser);

      if (success) {
        successfulScrapes++; // Increment successful scrapes counter
      } else {
        failedScrapes++; // Increment failed scrapes counter
      }

      const scrapeEndTime = Date.now(); // End time of the current scrape
      const scrapeTime = scrapeEndTime - scrapeStartTime; // Time taken for the current scrape
      totalTime += scrapeTime; // Add to total time

      console.log(`[INFO] Time taken for this scrape: ${scrapeTime / 1000} seconds`);
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

  // Log metrics
  console.log("[INFO] Total scrapes attempted:", totalScrapes);
  console.log("[INFO] Total successful scrapes:", successfulScrapes);
  console.log("[INFO] Total failed scrapes:", failedScrapes);
  console.log("[INFO] Average time per scrape:", totalTime / totalScrapes / 1000, "seconds");
}

main();