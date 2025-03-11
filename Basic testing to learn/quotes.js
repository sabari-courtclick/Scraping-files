import puppeteer from "puppeteer";

(async () =>{
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    await page.goto('https://quotes.toscrape.com');

    const quotes = await page.evaluate(()=>{
        const quoteNodes = document.querySelectorAll('.quote');
        const quotes = [];
        quoteNodes.forEach(quote => {
            const text = quote.querySelector('.text').innerText;
            const author = quote.querySelector('.author').innerText;
            quotes.push({text, author});
        })
        return quotes;
    })
    console.log(quotes);
    await browser.close();
})();