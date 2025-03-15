import axios from "axios";
import * as cheerio from "cheerio";
import connectDB from "./utils/connect-db.js";
import CaseDetails from "./models/case-details.js";
import toSnakeCase from "./utils/snackcase.js";
import FailedCases from "./models/failed-cases.js";
import dotenv from "dotenv";

dotenv.config();

let cnrMisMatchCount = 0;
const processedFailedCases = [];
// Custom function to extract petitioner name and advocates
function extractPetitionerAndAdvocate(tableElement, $) {
  const petitionerAndAdvocate = {};

  const petitionerInfoRow = tableElement.find("tr").eq(1);
  const petitionerInfo = petitionerInfoRow.text().trim();

  // Extract petitioner's name and age
  petitionerAndAdvocate["petitioner_name"] = petitionerInfo.replace(
    /^\d+\)\s*/,
    ""
  );

  // Extract petitioner advocates from the next row
  const advocateInfoRow = tableElement.find("tr").eq(3);
  const advocateInfo = advocateInfoRow.html();

  const advocateRegex = /\d+\s*\)\s*([^<]+?\s*\(.*?\))/g;
  const advocates = [];
  let match;
  while ((match = advocateRegex.exec(advocateInfo)) !== null) {
    advocates.push(match[1].trim());
  }

  petitionerAndAdvocate["petitioner_advocates"] = advocates;

  return petitionerAndAdvocate;
}

// Custom function to extract respondent name and advocates
function extractRespondentAndAdvocate(tableElement, $) {
  const respondents = [];

  // Find each respondent row in the table and extract the names
  const rows = tableElement.find("tr");

  // Iterate through rows to find the respondent names
  rows.each((index, row) => {
    const cells = $(row).find("td");
    if (cells.length > 0) {
      const firstCellText = $(cells[0]).text().trim();
      if (firstCellText) {
        const respondentRegex = /^\d+\)\s*(.*)$/;
        const match = firstCellText.match(respondentRegex);
        if (match) {
          respondents.push(match[1].trim());
        }
      }
    }
  });
  return respondents;
}

// Scarpe Table Data
async function scrapeTableData(url) {
  const cnr_number = url.split("/").pop();

  try {
    console.log("started :" + cnr_number);

    let isCnrMatched = true;
    const getCase = await CaseDetails.findOne({ cnr_number: cnr_number });

    if (getCase) {
      processedFailedCases.push(cnr_number);
      console.log(`Already completed ${cnr_number}`);
    } else {
      const { data } = await axios.get(url);

      const $ = cheerio.load(data);

      const tablesData = [];

      await $(".table-header").each((index, element) => {
        const tableHeader = $(element).text().trim();

        // Case Details
        if (tableHeader === "CASE DETAILS") {
          let caseDetailsCnrNumber = null;
          const caseDetails = {};
          const detailsRow = $(element).closest("tr").nextAll("tr");
          detailsRow.each((i, rowEl) => {
            const cells = $(rowEl).find("td");
            if (cells.length === 4) {
              const key1 = toSnakeCase($(cells[0]).text().trim());
              const value1 = $(cells[1]).text().trim();
              const key2 = toSnakeCase($(cells[2]).text().trim());
              const value2 = $(cells[3]).text().trim();

              if (key1 && value1) caseDetails[key1] = value1;
              if (key2 && value2) caseDetails[key2] = value2;
            }
          });
          caseDetailsCnrNumber = caseDetails["cnr_number"] || "";

          // check is cnr number is valid or not
          if (caseDetailsCnrNumber && caseDetailsCnrNumber != cnr_number) {
            isCnrMatched = false;
            console.log(
              `CNR number mismatch. Skipping scraping. URL CNR: ${cnr_number}, Extracted CNR: ${caseDetailsCnrNumber}`
            );
            cnrMisMatchCount++;
            return false; // Stop scraping if CNR numbers do not match
          }

          tablesData.push({
            tableHeader: "CASE DETAILS",
            details: caseDetails,
          });
        }
        // Case Status
        else if (tableHeader === "CASE STATUS") {
          const caseStatus = {};
          const statusRow = $(element).closest("tr").nextAll("tr");
          statusRow.each((i, rowEl) => {
            const cells = $(rowEl).find("td");
            const firstCellText = $(cells[0]).text().trim();

            if (firstCellText === "Last listed Details") {
              const lastListedDetails = {
                date: $(cells[1]).text().replace("Date : ", "").trim(),
                bench: $(cells[2]).text().replace("Bench: ", "").trim(),
                list: $(cells[3]).text().replace("List : ", "").trim(),
                item: $(cells[4]).text().replace("Item : ", "").trim(),
              };
              caseStatus["last_listed_details"] = lastListedDetails;
            } else if (cells.length >= 2) {
              const key = toSnakeCase(firstCellText);
              const value = $(cells[1]).text().trim();
              if (key && value) {
                caseStatus[key] = value;
              }
            }
          });
          tablesData.push({
            tableHeader: "CASE STATUS",
            details: caseStatus,
          });
        }
        // PETITIONER AND ADVOCATE
        else if (tableHeader === "PETITIONER AND ADVOCATE") {
          const tableElement = $(element).closest("table");
          const petitionerAndAdvocate = extractPetitionerAndAdvocate(
            tableElement,
            $
          );

          tablesData.push({
            tableHeader: "PETITIONER AND ADVOCATE",
            details: petitionerAndAdvocate,
          });
        }
        // RESPONDENT AND ADVOCATES
        else if (tableHeader === "RESPONDENT AND ADVOCATES") {
          const tableElement = $(element).closest("table");
          const respondentAndAdvocate = extractRespondentAndAdvocate(
            tableElement,
            $
          );

          tablesData.push({
            tableHeader: "RESPONDENT AND ADVOCATES",
            details: respondentAndAdvocate,
          });
        } else if (tableHeader === "SERVED ON") {
          const servedOnText = $(element)
            .closest("tr")
            .next("tr")
            .find("td")
            .text()
            .trim();

          tablesData.push({
            tableHeader: "SERVED ON",
            details: { served_on: servedOnText },
          });
        }
        // ACTS
        else if (tableHeader === "ACTS") {
          const actDetailsRow = $(element).closest("tr").nextAll("tr").eq(1);
          const underAct = actDetailsRow.find("td").eq(0).text().trim();
          const underSection = actDetailsRow.find("td").eq(1).text().trim();

          tablesData.push({
            tableHeader: "ACTS",
            details: { under_act: underAct, under_section: underSection },
          });
        }
        // TRIAL COURT INFORMATION
        else if (tableHeader === "TRIAL COURT INFORMATION") {
          const courtInfoRows = $(element).closest("tr").nextAll("tr");

          const courtNameRow = courtInfoRows.eq(1);

          const courtName = courtNameRow
            .text()
            .replace("Court Number and Name :", "")
            .trim();

          const caseNumberRow = courtInfoRows.eq(2);
          const caseNumber = caseNumberRow
            .text()
            .replace("Case Number and Year  :", "")
            .trim();

          tablesData.push({
            tableHeader: "TRIAL COURT INFORMATION",
            details: { court_name: courtName, case_number: caseNumber },
          });
        }
        // FIR DETAILS
        else if (tableHeader === "FIR DETAILS") {
          const firDetailsRows = $(element).closest("tr").nextAll("tr");

          // Extract "Police Station"
          const policeStationRow = firDetailsRows.eq(0);
          const policeStation = policeStationRow
            .text()
            .replace("Police Station :", "")
            .trim();

          // Extract "FIR No / Year"
          const firNumberRow = firDetailsRows.eq(1);
          const firNumber = firNumberRow
            .text()
            .replace("FIR No / Year  :", "")
            .trim();

          // Add the scraped data to the result
          tablesData.push({
            tableHeader: "FIR DETAILS",
            details: { police_station: policeStation, fir_number: firNumber },
          });
        }
        // IA DETAILS
        else if (tableHeader === "IA DETAILS") {
          const iaDetails = [];
          $(element)
            .closest("table")
            .find("tbody tr")
            .each((rowIndex, rowElement) => {
              // Extract relevant columns from each row
              const iaNumber = $(rowElement).find("td").eq(1).text().trim();
              const dateOfFiling = $(rowElement).find("td").eq(2).text().trim();
              const dateOfReg = $(rowElement).find("td").eq(3).text().trim();
              const status = $(rowElement)
                .find("td")
                .eq(4)
                .text()
                .trim()
                .split("\n")[0];
              const classification = $(rowElement)
                .find("td")
                .eq(5)
                .text()
                .trim();
              const party = $(rowElement)
                .find("td")
                .eq(6)
                .text()
                .trim()
                .replace(/,$/, ""); // Remove trailing comma

              iaDetails.push({
                ia_number: iaNumber,
                date_of_filing: dateOfFiling,
                date_of_reg: dateOfReg,
                status: status,
                classification: classification,
                party: party,
              });
            });
          tablesData.push({
            tableHeader: "IA DETAILS",
            details: iaDetails,
          });
        }
        // DOCUMENTS
        else if (tableHeader === "DOCUMENTS") {
          const documentDetails = [];
          $(element)
            .closest("table")
            .find("tbody tr")
            .each((rowIndex, rowElement) => {
              const documentNumber = $(rowElement)
                .find("td")
                .eq(1)
                .text()
                .trim()
                .split("\n")[0]; // Split to remove 'Online' label
              const date = $(rowElement).find("td").eq(2).text().trim();
              const fileType = $(rowElement).find("td").eq(3).text().trim();
              const description = $(rowElement).find("td").eq(4).text().trim();
              const partyName = $(rowElement)
                .find("td")
                .eq(5)
                .text()
                .trim()
                .replace(/,$/, ""); // Remove trailing comma
              const advocateName = $(rowElement).find("td").eq(6).text().trim();

              documentDetails.push({
                document_number: documentNumber,
                date: date,
                file_type: fileType,
                description: description,
                party_name: partyName,
                advocate_name: advocateName,
              });
            });
          tablesData.push({
            tableHeader: "DOCUMENTS",
            details: documentDetails,
          });
        }
        // HISTORY OF CASE HEARING
        else if (tableHeader === "HISTORY OF CASE HEARING") {
          const hearingHistory = [];
          $(element)
            .closest("table")
            .find("tbody tr")
            .each((rowIndex, rowElement) => {
              // Extract relevant columns from each row
              const causeListType = $(rowElement)
                .find("td")
                .eq(1)
                .text()
                .trim();
              const judgeName = $(rowElement).find("td").eq(2).text().trim();
              const businessDate = $(rowElement).find("td").eq(3).text().trim();
              const nextDate = $(rowElement).find("td").eq(4).text().trim();
              const purposeOfHearing = $(rowElement)
                .find("td")
                .eq(5)
                .text()
                .trim();
              const order = $(rowElement).find("td").eq(6).text().trim();

              // Push the scraped data as an object into the hearingHistory array
              hearingHistory.push({
                cause_list_type: causeListType,
                judge_name: judgeName,
                business_date: businessDate,
                next_date: nextDate,
                purpose_of_hearing: purposeOfHearing,
                order: order,
              });
            });
          tablesData.push({
            tableHeader: "HISTORY OF CASE HEARING",
            details: hearingHistory,
          });
        }
        // INTERIM ORDERS
        else if (tableHeader === "INTERIM ORDERS") {
          const interimOrders = [];
          $(element)
            .closest("table")
            .find("tbody tr")
            .each((rowIndex, rowElement) => {
              // Extract relevant columns from each row
              const businessDate = $(rowElement).find("td").eq(0).text().trim();
              const judgeName = $(rowElement).find("td").eq(1).text().trim();
              const application = $(rowElement).find("td").eq(2).text().trim();
              const orderLink = $(rowElement).find("td").eq(3).find("a");

              // Extract the onclick attribute to get parameters for vieworder function
              const onclickAttr = orderLink.attr("onclick");
              let token = "";
              let lookup = "";

              // Extract token and lookup from onclick attribute
              if (onclickAttr) {
                const matches = onclickAttr.match(
                  /vieworder\('([^']+)','([^']+)','[^']*'\)/
                );
                if (matches) {
                  token = matches[1];
                  lookup = matches[2];
                }
              }

              // Push the scraped data as an object into the interimOrders array
              interimOrders.push({
                business_date: businessDate,
                judge_name: judgeName,
                application: application,
                order: {
                  token: token,
                  lookup: lookup,
                },
              });
            });

          tablesData.push({
            tableHeader: "INTERIM ORDERS",
            details: interimOrders,
          });
        }
        // JUDGMENT
        else if (tableHeader === "JUDGMENT") {
          const judgmentData = [];
          $(element)
            .closest("table")
            .find("tbody tr")
            .each((rowIndex, rowElement) => {
              // Skip the first two rows which are the header and sub-header
              if (rowIndex < 2) {
                return; // Skip header and sub-header rows
              }

              // Extract relevant columns from each row
              const orderNumber = $(rowElement).find("td").eq(0).text().trim();
              const judgeName = $(rowElement).find("td").eq(1).text().trim();
              const orderDate = $(rowElement).find("td").eq(2).text().trim();
              const viewLink = $(rowElement).find("td").eq(3).find("a");

              // Extract the onclick attribute to get parameters for viewordercitation function
              const onclickAttr = viewLink.attr("onclick");
              let citationToken = "";
              let lookup = "";
              let token = "";
              let isqr = "";

              // Extract citation parameters from onclick attribute
              if (onclickAttr) {
                const matches = onclickAttr.match(
                  /viewordercitation\('([^']+)','([^']+)','([^']+)','[^']*'\)/
                );
                if (matches) {
                  token = matches[1];
                  lookup = matches[2];
                  citationToken = matches[3];
                  isqr = matches[4]; // Get the last parameter if it exists
                }
              }

              // Extract the Neutral Citation Number correctly from the cell's text nodes
              let neutralCitationNumber = $(rowElement)
                .find("td")
                .eq(3)
                .contents()
                .filter(function () {
                  return this.nodeType === 3; // Filter to get text nodes
                })
                .text()
                .trim();

              // If the extracted text does not match the expected format, check the structure
              if (!/^\d{4}:\w{3}:\d{4}$/.test(neutralCitationNumber)) {
                // If the number is not formatted as expected, adjust extraction
                const additionalText = $(rowElement)
                  .find("td")
                  .eq(3)
                  .find("font")
                  .text()
                  .trim();
                neutralCitationNumber = additionalText; // Get from <font> tag if necessary
              }

              // Push the scraped data as an object into the judgmentData array
              judgmentData.push({
                order_number: orderNumber,
                judge_name: judgeName,
                order_date: orderDate,
                neutral_citation_number: neutralCitationNumber, // Add neutral citation number
                view_order: {
                  token: token,
                  citation_token: citationToken,
                  lookup: lookup,
                  isqr: isqr,
                },
              });
            });

          tablesData.push({
            tableHeader: "JUDGMENT",
            details: judgmentData,
          });
        }
        // CATEGORY DETAILS
        else if (tableHeader === "CATEGORY DETAILS") {
          let categoryData = {};

          // Loop through each row of the CATEGORY DETAILS table
          $(element)
            .closest("table")
            .find("tbody tr")
            .each((rowIndex, rowElement) => {
              const categoryLabel = $(rowElement)
                .find("td")
                .eq(0)
                .text()
                .trim();
              const categoryValue = $(rowElement)
                .find("td")
                .eq(1)
                .text()
                .trim();

              // Check for Category and Sub Sub Category
              if (categoryLabel === "Category") {
                categoryData.category = categoryValue;
              } else if (categoryLabel === "Sub Sub Category") {
                categoryData.sub_sub_category = categoryValue; // This will be empty based on provided HTML
              }
            });

          tablesData.push({
            tableHeader: "CATEGORY DETAILS",
            details: categoryData,
          });
        }
        // OBJECTION
        else if (tableHeader === "OBJECTION") {
          const objections = [];

          // Loop through each row of the OBJECTION table, starting from the first row in the tbody
          $(element)
            .closest("table")
            .find("tbody tr")
            .each((rowIndex, rowElement) => {
              // Extract the objection from the second cell (td)
              const objectionText = $(rowElement)
                .find("td")
                .eq(1)
                .text()
                .trim();

              // Check if objectionText is not empty
              if (objectionText) {
                objections.push(objectionText);
              }
            });

          tablesData.push({
            tableHeader: "OBJECTION",
            details: objections,
          });
        }
      });

      if (isCnrMatched) {
        cnrMisMatchCount = 0;
        const caseData = new CaseDetails({
          data: tablesData,
          cnr_number: cnr_number,
        });
        await caseData.save();
        processedFailedCases.push(cnr_number);
        console.log("Completed " + cnr_number);
      }
    }
  } catch (error) {
    const failedCase = new FailedCases({ cnr_number: cnr_number });
    await failedCase.save();
    console.error(`Error fetching data: ${error.message}`);
  }
}

// Generate urls
async function generateUrls() {
  await connectDB();

  console.time("Execution Time");
  let dynamicNumber = process.env.DYNAMIC_NUMBER;
  let url;

  while (true) {
    let formattedNumber = dynamicNumber.toString().padStart(6, "0");
    url = `https://hckinfo.kerala.gov.in/digicourt/Casedetailssearch/Viewcasestatusnewtab/KLHC01${formattedNumber}${process.env.YEAR}`;
    dynamicNumber++;
    await scrapeTableData(url);
    if (dynamicNumber > 200000) {
      console.log("Target completed");
      break;
    }
    if (cnrMisMatchCount > 500) {
      console.log("500 cnr mismatched");
      break;
    }
  }
  console.timeEnd("Execution Time");
}

async function processFailedCases() {
  try {
    await connectDB();

    // Retrieve all failed cases
    const failedCases = await FailedCases.find({
      isProcessed: { $ne: true },
    });

    for (const failedCase of failedCases) {
      try {
        console.log(`Processing failed case: ${failedCase.cnr_number}`);

        // Construct the URL for scraping
        const url = `https://hckinfo.kerala.gov.in/digicourt/Casedetailssearch/Viewcasestatusnewtab/${failedCase.cnr_number}`;

        await scrapeTableData(url);
      } catch (caseError) {
        console.error(
          `Error processing case ${failedCase.cnr_number}:`,
          caseError
        );
      }
    }

    if (processedFailedCases.length > 0) {
      await FailedCases.updateMany(
        { cnr_number: { $in: processedFailedCases } },
        { $set: { isProcessed: true } } // Set isProcessed to true
      );
    }
    // Log the processed cases
    console.log("Processed failed cases:", processedFailedCases);
  } catch (error) {
    console.error("Error processing failed cases:", error);
  }
}

if (process.env.TYPE == "FAILED") {
  processFailedCases();
} else {
  generateUrls();
}