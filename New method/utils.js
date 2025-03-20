import * as cheerio from 'cheerio'; // Use named import

export function parseCaseDetails(html) {
  const $ = cheerio.load(html);
  const caseDetails = {};

  // Extract court name
  caseDetails.courtName = $('#chHeading').text().trim();

  // Extract case details table
  caseDetails.caseDetails = [];
  $('.case_details_table tr').each((i, row) => {
    const cols = $(row).find('td');
    if (cols.length >= 2) {
      caseDetails.caseDetails.push({
        label: $(cols[0]).text().trim(),
        value: $(cols[1]).text().trim(),
      });
    }
  });

  // Extract case status table
  caseDetails.caseStatus = [];
  $('.case_status_table tr').each((i, row) => {
    const cols = $(row).find('td');
    if (cols.length >= 2) {
      caseDetails.caseStatus.push({
        label: $(cols[0]).text().trim(),
        value: $(cols[1]).text().trim(),
      }); 
    }
  });

  // Extract petitioner and respondent details
  caseDetails.petitioner = $('.Petitioner_Advocate_table td').text().trim();
  caseDetails.respondent = $('.Respondent_Advocate_table td').text().trim();

  return caseDetails;
}