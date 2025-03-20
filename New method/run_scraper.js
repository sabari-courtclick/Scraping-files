import Scraper from './scraper.js';
import fs from 'fs';

async function runScraperForOneHour() {
    const startTime = Date.now();
    const duration = 60 * 60 * 1000; // 1 hour in milliseconds
    
    // Array of CNR numbers to process
    const cnrNumbers = [
        'KLWD030000802019',
        // Add more CNR numbers here
    ];
    
    const results = [];
    const errors = [];
    let currentIndex = 0;
    
    console.log('Starting scraper for 1 hour...');
    
    while (Date.now() - startTime < duration) {
        try {
            const scraper = new Scraper();
            await scraper.initializeSession();
            
            // Process each CNR number
            for (const cnr of cnrNumbers) {
                try {
                    console.log(`Processing CNR: ${cnr}`);
                    const caseDetails = await scraper.fetchCaseDetails(cnr);
                    results.push({
                        timestamp: new Date().toISOString(),
                        cnr: cnr,
                        details: caseDetails
                    });
                    
                    // Save results periodically
                    fs.writeFileSync('scraping_results.json', JSON.stringify(results, null, 2));
                    
                    // Add a delay between requests
                    await new Promise(resolve => setTimeout(resolve, 5000));
                } catch (error) {
                    console.error(`Error processing CNR ${cnr}:`, error.message);
                    errors.push({
                        timestamp: new Date().toISOString(),
                        cnr: cnr,
                        error: error.message
                    });
                    
                    // Save errors periodically
                    fs.writeFileSync('scraping_errors.json', JSON.stringify(errors, null, 2));
                }
            }
            
            // Close the browser after processing all CNR numbers
            await scraper.close();
            
            // Add a delay before starting the next cycle
            await new Promise(resolve => setTimeout(resolve, 10000));
            
        } catch (error) {
            console.error('Error in main loop:', error.message);
            errors.push({
                timestamp: new Date().toISOString(),
                error: error.message
            });
            fs.writeFileSync('scraping_errors.json', JSON.stringify(errors, null, 2));
            
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 30000));
        }
    }
    
    console.log('Scraping completed after 1 hour');
    console.log(`Total results: ${results.length}`);
    console.log(`Total errors: ${errors.length}`);
}

// Run the scraper
runScraperForOneHour().catch(console.error); 