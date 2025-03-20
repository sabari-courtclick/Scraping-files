import Scraper from './apiscraper.js';
import fs from 'fs';

// Rate limiting configuration
const MAX_REQUESTS_PER_MINUTE = 30;
const MIN_DELAY_BETWEEN_REQUESTS = 2000; // 2 seconds

// Track request counts and timestamps
let requestCount = 0;
let requestTimestamps = [];

async function waitForRateLimit() {
  const now = Date.now();
  
  // Remove timestamps older than 1 minute
  requestTimestamps = requestTimestamps.filter(timestamp => now - timestamp < 60000);
  
  // If we've hit the rate limit, wait until we can make more requests
  if (requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    const oldestTimestamp = requestTimestamps[0];
    const waitTime = 60000 - (now - oldestTimestamp);
    console.log(`Rate limit reached. Waiting ${Math.ceil(waitTime / 1000)} seconds...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  // Add current timestamp
  requestTimestamps.push(now);
}

async function runScraper(cnrNumbers) {
  const scraper = new Scraper();
  const results = [];
  const totalCases = cnrNumbers.length;
  let successfulCases = 0;
  
  console.log(`\nStarting to scrape ${totalCases} cases...`);
  
  try {
    await scraper.initializeSession();
    
    for (let idx = 0; idx < totalCases; idx++) {
      const cnr = cnrNumbers[idx];
      console.log(`\nProcessing case ${idx + 1}/${totalCases}: ${cnr}`);
      
      try {
        // Wait for rate limit before making request
        await waitForRateLimit();
        
        // Add minimum delay between requests
        if (idx > 0) {
          await new Promise(resolve => setTimeout(resolve, MIN_DELAY_BETWEEN_REQUESTS));
        }
        
        const caseDetails = await scraper.fetchCaseDetails(cnr);
        
        if (caseDetails) {
          successfulCases++;
          results.push(caseDetails);
          
          // Save case details to file
          const filename = `case_${cnr}.json`;
          fs.writeFileSync(filename, JSON.stringify(caseDetails, null, 2));
          console.log(`Case details saved to ${filename}`);
        } else {
          console.error(`Failed to fetch case details for ${cnr}`);
        }
      } catch (error) {
        console.error(`Error processing case ${cnr}:`, error.message);
        
        // Handle specific error cases
        if (error.message.includes('Invalid request')) {
          console.log('Invalid request error detected. Waiting before retry...');
          await new Promise(resolve => setTimeout(resolve, 5000));
        } else if (error.message.includes('Session expired')) {
          console.log('Session expired. Reinitializing session...');
          await scraper.initializeSession();
        }
      }
    }
    
    // Print final report
    console.log('\n=== Scraping Complete ===');
    console.log(`Total cases attempted: ${totalCases}`);
    console.log(`Successfully scraped: ${successfulCases}`);
    console.log(`Failed to scrape: ${totalCases - successfulCases}`);
    console.log(`Success rate: ${((successfulCases / totalCases) * 100).toFixed(2)}%`);
    
    // Save all results to a single file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const summaryFile = `scraping_results_${timestamp}.json`;
    fs.writeFileSync(summaryFile, JSON.stringify(results, null, 2));
    console.log(`\nAll results saved to ${summaryFile}`);
    
    return results;
  } catch (error) {
    console.error('Fatal error:', error.message);
    throw error;
  } finally {
    await scraper.close();
  }
}

// Example usage
const cnrNumbers = [
  'KLWD030000802019',
  // Add more CNR numbers here
];

runScraper(cnrNumbers).catch(console.error);