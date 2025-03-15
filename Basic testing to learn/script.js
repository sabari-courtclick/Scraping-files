import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const writeFileAsync = promisify(fs.writeFile);
const mkdirAsync = promisify(fs.mkdir);

import TwoCaptcha from "2captcha";
const solver = new TwoCaptcha.Solver("f048fd937e44bef6e0689899680cd105"); // Replace with your API key

async function solveCaptcha(page) {
  try {
    // Look for captcha element
    const captchaExists = await page.evaluate(() => {
      return document.querySelector('img[id*="captcha"]') !== null;
    });

    if (!captchaExists) {
      console.log("No captcha found");
      return true;
    }

    // Get captcha image
    const captchaImg = await page.evaluate(() => {
      const img = document.querySelector('img[id*="captcha"]');
      return img ? img.src : null;
    });

    if (!captchaImg) {
      console.log("Captcha image not found");
      return false;
    }

    // Get base64 image data
    const base64Image = await page.evaluate(async (src) => {
      const response = await fetch(src);
      const blob = await response.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(",")[1]);
        reader.readAsDataURL(blob);
      });
    }, captchaImg);

    // Solve captcha
    const { data } = await solver.imageCaptcha(base64Image);
    console.log("Captcha solved:", data);

    // Find captcha input field
    const captchaInput = await page.$('input[id*="captcha"]');
    if (!captchaInput) {
      console.log("Captcha input field not found");
      return false;
    }

    // Enter captcha solution
    await captchaInput.type(data);

    // Find and click submit button
    const submitButton = await page.$(
      'button[type="submit"], input[type="submit"]'
    );
    if (submitButton) {
      await submitButton.click();
      await page.waitForNavigation({ waitUntil: "networkidle2" });
      return true;
    } else {
      console.log("Submit button not found");
      return false;
    }
  } catch (error) {
    console.error("Error solving captcha:", error);
    return false;
  }
}

async function scrapeEcourts(cnrNumber) {
  // Create output directory
  const outputDir = path.join(__dirname, "scraped_data", cnrNumber);
  await mkdirAsync(outputDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ["--start-maximized"],
  });

  try {
    const page = await browser.newPage();

    // Configure downloads
    const client = await page.target().createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: outputDir,
    });

    // Set up console logging
    page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));

    // Navigate to the URL with app token
    await page.goto(
      "https://services.ecourts.gov.in/ecourtindia_v6/?p=home/index&app_token=87e735d7ebd3ce1bedb54ccff4d1e9211ec776c1d0312f1c91e322579a1bb39e",
      {
        waitUntil: "networkidle2",
        timeout: 60000,
      }
    );

    console.log("Navigated to main page");

    // Handle any initial captcha
    await solveCaptcha(page);

    // Navigate to case status
    await page.waitForSelector('a[href*="case_status"]', { timeout: 30000 });
    await page.click('a[href*="case_status"]');
    await page.waitForNavigation({ waitUntil: "networkidle2" });

    console.log("Navigated to case status page");

    // Handle any captcha on case status page
    await solveCaptcha(page);

    // Select search by CNR
    await page.waitForSelector("#radCNR", { timeout: 30000 });
    await page.click("#radCNR");

    // Enter CNR number
    await page.waitForSelector("#cn_number", { timeout: 30000 });
    await page.type("#cn_number", cnrNumber);

    // Click search button
    await page.click("#searchbtn");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 });

    // Handle any captcha after search
    await solveCaptcha(page);

    console.log("Search completed");

    // Wait for case details to load
    await page.waitForSelector("#history_cnr", { timeout: 60000 });

    // Extract case details
    const caseDetails = await page.evaluate(() => {
      const result = {};

      // Get court name
      const courtName = document.querySelector("#chHeading");
      if (courtName) result.courtName = courtName.textContent.trim();

      // Get case details
      const caseDetailsTable = document.querySelector(".case_details_table");
      if (caseDetailsTable) {
        const rows = caseDetailsTable.querySelectorAll("tr");
        rows.forEach((row) => {
          const cells = row.querySelectorAll("td");
          for (let i = 0; i < cells.length; i += 2) {
            if (cells[i] && cells[i + 1]) {
              const key = cells[i].textContent.trim().replace(/\s+/g, " ");
              const value = cells[i + 1].textContent
                .trim()
                .replace(/\s+/g, " ");
              result[key] = value;
            }
          }
        });
      }

      // Get case status
      const caseStatusTable = document.querySelector(".case_status_table");
      if (caseStatusTable) {
        result.caseStatus = {};
        const rows = caseStatusTable.querySelectorAll("tr");
        rows.forEach((row) => {
          const cells = row.querySelectorAll("td");
          if (cells.length >= 2) {
            const key = cells[0].textContent.trim().replace(/\s+/g, " ");
            const value = cells[1].textContent.trim().replace(/\s+/g, " ");
            result.caseStatus[key] = value;
          }
        });
      }

      // Get petitioner details
      const petitionerTable = document.querySelector(
        ".Petitioner_Advocate_table"
      );
      if (petitionerTable) {
        result.petitioners = [];
        const rows = petitionerTable.querySelectorAll("tr");
        rows.forEach((row) => {
          const cells = row.querySelectorAll("td");
          cells.forEach((cell) => {
            result.petitioners.push(cell.textContent.trim());
          });
        });
      }

      // Get respondent details
      const respondentTable = document.querySelector(
        ".Respondent_Advocate_table"
      );
      if (respondentTable) {
        result.respondents = [];
        const rows = respondentTable.querySelectorAll("tr");
        rows.forEach((row) => {
          const cells = row.querySelectorAll("td");
          cells.forEach((cell) => {
            result.respondents.push(cell.textContent.trim());
          });
        });
      }

      // Get acts
      const actsTable = document.querySelector(".acts_table");
      if (actsTable) {
        result.acts = [];
        const rows = actsTable.querySelectorAll("tr");
        for (let i = 1; i < rows.length; i++) {
          // Skip header
          const cells = rows[i].querySelectorAll("td");
          if (cells.length >= 2) {
            result.acts.push({
              act: cells[0].textContent.trim(),
              section: cells[1].textContent.trim(),
            });
          }
        }
      }

      return result;
    });

    console.log("Case details extracted");

    // Save case details to file
    await writeFileAsync(
      path.join(outputDir, "case_details.json"),
      JSON.stringify(caseDetails, null, 2)
    );

    // Get case history
    const caseHistoryData = await page.evaluate(() => {
      const result = [];
      const historyTable = document.querySelector(".history_table");
      if (!historyTable) return result;

      const rows = historyTable.querySelectorAll("tbody tr");
      rows.forEach((row) => {
        const cells = row.querySelectorAll("td");
        if (cells.length >= 4) {
          const rowData = {
            judge: cells[0].textContent.trim(),
            businessDate: cells[1].textContent.trim(),
            hearingDate: cells[2].textContent.trim(),
            purpose: cells[3].textContent.trim(),
            businessOnDateLink: cells[1].querySelector("a")
              ? cells[1].querySelector("a").getAttribute("onclick")
              : null,
          };
          result.push(rowData);
        }
      });

      return result;
    });

    console.log(`Found ${caseHistoryData.length} case history entries`);

    // Extract business on date details for each entry
    const caseHistoryWithDetails = [];
    for (let i = 0; i < caseHistoryData.length; i++) {
      const entry = caseHistoryData[i];
      console.log(
        `Processing history entry ${i + 1}/${caseHistoryData.length}`
      );

      if (entry.businessOnDateLink) {
        // Click on the business on date link
        await page.evaluate((onclick) => {
          // Create a function from the onclick attribute and execute it
          const fn = new Function(
            onclick.replace('onclick="', "").replace('"', "")
          );
          fn();
        }, entry.businessOnDateLink);

        // Wait for the details to load
        await page.waitForSelector("#caseBusinessDiv_cnr", {
          visible: true,
          timeout: 30000,
        });

        // Extract business details
        const businessDetails = await page.evaluate(() => {
          const details = {};
          const businessDiv = document.querySelector("#caseBusinessDiv_cnr");

          // Get court name
          const courtName = businessDiv.querySelector(
            "center span:nth-child(1)"
          );
          if (courtName) details.courtName = courtName.textContent.trim();

          // Get CNR number
          const cnrElement = businessDiv.querySelector(
            'center span:contains("CNR Number")'
          );
          if (cnrElement) {
            details.cnrNumber = cnrElement.textContent
              .trim()
              .replace(/CNR Number\s*:\s*/, "");
          }

          // Get case number
          const caseNumberElement = businessDiv.querySelector(
            'center span:contains("Case Number")'
          );
          if (caseNumberElement) {
            details.caseNumber = caseNumberElement.textContent
              .trim()
              .replace(/Case Number\s*:\s*/, "");
          }

          // Get parties
          const partiesElement = businessDiv.querySelector(
            'center span:contains("versus")'
          );
          if (partiesElement) {
            details.parties = partiesElement.textContent.trim();
          }

          // Get date
          const dateElement = businessDiv.querySelector(
            'center span:contains("Date")'
          );
          if (dateElement) {
            details.date = dateElement.textContent
              .trim()
              .replace(/Date\s*:\s*/, "");
          }

          // Get business, next purpose, next hearing date
          const table = businessDiv.querySelector("table");
          if (table) {
            const rows = table.querySelectorAll("tr");
            rows.forEach((row) => {
              const cells = row.querySelectorAll("td");
              if (cells.length >= 3) {
                const key = cells[0].textContent.trim().replace(/\s+/g, " ");
                const value = cells[2].textContent.trim().replace(/\s+/g, " ");
                if (key.includes("Business")) {
                  details.business = value;
                } else if (key.includes("Next Purpose")) {
                  details.nextPurpose = value;
                } else if (key.includes("Next Hearing Date")) {
                  details.nextHearingDate = value;
                }
              }
            });
          }

          return details;
        });

        entry.businessDetails = businessDetails;

        // Click back button
        await page.evaluate(() => {
          document.querySelector("#caseBusinessDiv_back").click();
        });

        // Wait for the details to be hidden
        await page.waitForSelector("#caseBusinessDiv_cnr", {
          hidden: true,
          timeout: 30000,
        });
      }

      caseHistoryWithDetails.push(entry);
    }

    // Save case history to file
    await writeFileAsync(
      path.join(outputDir, "case_history.json"),
      JSON.stringify(caseHistoryWithDetails, null, 2)
    );

    console.log("Case history extracted");

    // Check for and download interim orders
    const interimOrdersExist = await page.evaluate(() => {
      return document.querySelector(".order_table") !== null;
    });

    if (interimOrdersExist) {
      console.log("Interim orders found");

      const interimOrders = await page.evaluate(() => {
        const result = [];
        const orderTable = document.querySelector(".order_table");
        if (!orderTable) return result;

        const rows = orderTable.querySelectorAll("tbody tr");
        // Skip header row
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll("td");
          if (cells.length >= 3) {
            const orderData = {
              orderNumber: cells[0].textContent.trim(),
              orderDate: cells[1].textContent.trim(),
              orderDetails: cells[2].textContent.trim(),
              orderLink: cells[2].querySelector("a")
                ? cells[2].querySelector("a").getAttribute("onclick")
                : null,
            };
            result.push(orderData);
          }
        }

        return result;
      });

      // Save interim orders to file
      await writeFileAsync(
        path.join(outputDir, "interim_orders.json"),
        JSON.stringify(interimOrders, null, 2)
      );

      // Download PDF for each interim order
      for (let i = 0; i < interimOrders.length; i++) {
        const order = interimOrders[i];
        if (order.orderLink) {
          console.log(
            `Downloading PDF for order ${i + 1}/${interimOrders.length}`
          );

          try {
            // Create a new page for PDF download
            const pdfPage = await browser.newPage();

            // Configure downloads
            const pdfClient = await pdfPage.target().createCDPSession();
            await pdfClient.send("Page.setDownloadBehavior", {
              behavior: "allow",
              downloadPath: outputDir,
            });

            // Navigate to the main page first
            await pdfPage.goto(
              "https://services.ecourts.gov.in/ecourtindia_v6/?p=home/index&app_token=87e735d7ebd3ce1bedb54ccff4d1e9211ec776c1d0312f1c91e322579a1bb39e",
              {
                waitUntil: "networkidle2",
                timeout: 60000,
              }
            );

            // Handle any captcha
            await solveCaptcha(pdfPage);

            // Execute the onclick function to open the PDF
            await pdfPage.evaluate((onclick) => {
              const fn = new Function(
                onclick.replace('onclick="', "").replace('"', "")
              );
              fn();
            }, order.orderLink);

            // Wait for download to complete (this is approximate)
            await new Promise((resolve) => setTimeout(resolve, 5000));

            // Close the PDF page
            await pdfPage.close();
          } catch (error) {
            console.error(`Error downloading PDF for order ${i + 1}:`, error);
          }
        }
      }

      console.log("Interim orders downloaded");
    } else {
      console.log("No interim orders found");
    }

    // Check for and handle final orders/judgments
    const finalOrdersExist = await page.evaluate(() => {
      return document.querySelector(".judgment_table") !== null;
    });

    if (finalOrdersExist) {
      console.log("Final orders/judgments found");

      const finalOrders = await page.evaluate(() => {
        const result = [];
        const orderTable = document.querySelector(".judgment_table");
        if (!orderTable) return result;

        const rows = orderTable.querySelectorAll("tbody tr");
        // Skip header row
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll("td");
          if (cells.length >= 3) {
            const orderData = {
              orderNumber: cells[0].textContent.trim(),
              orderDate: cells[1].textContent.trim(),
              orderDetails: cells[2].textContent.trim(),
              orderLink: cells[2].querySelector("a")
                ? cells[2].querySelector("a").getAttribute("onclick")
                : null,
            };
            result.push(orderData);
          }
        }

        return result;
      });

      // Save final orders to file
      await writeFileAsync(
        path.join(outputDir, "final_orders.json"),
        JSON.stringify(finalOrders, null, 2)
      );

      // Download PDF for each final order
      for (let i = 0; i < finalOrders.length; i++) {
        const order = finalOrders[i];
        if (order.orderLink) {
          console.log(
            `Downloading PDF for final order ${i + 1}/${finalOrders.length}`
          );

          try {
            // Create a new page for PDF download
            const pdfPage = await browser.newPage();

            // Configure downloads
            const pdfClient = await pdfPage.target().createCDPSession();
            await pdfClient.send("Page.setDownloadBehavior", {
              behavior: "allow",
              downloadPath: outputDir,
            });

            // Navigate to the main page first
            await pdfPage.goto(
              "https://services.ecourts.gov.in/ecourtindia_v6/?p=home/index&app_token=87e735d7ebd3ce1bedb54ccff4d1e9211ec776c1d0312f1c91e322579a1bb39e",
              {
                waitUntil: "networkidle2",
                timeout: 60000,
              }
            );

            // Handle any captcha
            await solveCaptcha(pdfPage);

            // Execute the onclick function to open the PDF
            await pdfPage.evaluate((onclick) => {
              const fn = new Function(
                onclick.replace('onclick="', "").replace('"', "")
              );
              fn();
            }, order.orderLink);

            // Wait for download to complete (this is approximate)
            await new Promise((resolve) => setTimeout(resolve, 5000));

            // Close the PDF page
            await pdfPage.close();
          } catch (error) {
            console.error(
              `Error downloading PDF for final order ${i + 1}:`,
              error
            );
          }
        }
      }

      console.log("Final orders downloaded");
    } else {
      console.log("No final orders found");
    }

    // Take screenshots of important sections
    console.log("Taking screenshots");

    // Screenshot of case details
    await page.screenshot({
      path: path.join(outputDir, "case_details.png"),
      fullPage: false,
    });

    // Screenshot of case history
    const historyElement = await page.$(".history_table");
    if (historyElement) {
      await historyElement.screenshot({
        path: path.join(outputDir, "case_history.png"),
      });
    }

    // Screenshot of interim orders if exists
    const interimElement = await page.$(".order_table");
    if (interimElement) {
      await interimElement.screenshot({
        path: path.join(outputDir, "interim_orders.png"),
      });
    }

    // Screenshot of final orders if exists
    const finalElement = await page.$(".judgment_table");
    if (finalElement) {
      await finalElement.screenshot({
        path: path.join(outputDir, "final_orders.png"),
      });
    }

    console.log("Scraping completed successfully");

    return {
      success: true,
      outputDir,
    };
  } catch (error) {
    console.error("Error during scraping:", error);

    // Take screenshot of error state
    try {
      await page.screenshot({
        path: path.join(outputDir, "error_state.png"),
        fullPage: true,
      });
    } catch (screenshotError) {
      console.error("Error taking error screenshot:", screenshotError);
    }

    return {
      success: false,
      error: error.message,
      outputDir,
    };
  } finally {
    // Close browser
    await browser.close();
  }
}


// Main function to process command line arguments
async function main() {
  // Get CNR number from command line argument
  const cnrNumber = 'KLWD030000802019';

  if (!cnrNumber) {
    console.error("Please provide a CNR number as a command line argument");
    process.exit(1);
  }

  console.log(`Starting scraping for CNR: ${cnrNumber}`);

  const result = await scrapeEcourts(cnrNumber);

  if (result.success) {
    console.log(
      `Scraping completed successfully. Data saved to: ${result.outputDir}`
    );
  } else {
    console.error(`Scraping failed: ${result.error}`);
    console.log(`Partial data may be available in: ${result.outputDir}`);
  }
}

// Execute main function
main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
