import puppeteer from "puppeteer";

(async () =>{
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    await page.goto('https://en.wikipedia.org/wiki/Web_scraping');

    const summary = await page.evaluate(()=>{
        return document.querySelector('p').innerText;
    });
    console.log(summary);
    await browser.close();
})();