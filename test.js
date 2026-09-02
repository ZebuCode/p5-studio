const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log(msg.text()));
  await page.setContent(\<html><script>
    window.onerror = function(m, s, l, c, e) {
      console.log('STACK:', e ? e.stack : 'no stack');
    };
    const code = 'function foo() { throw new Error(123) }; foo(); //# sourceURL=sketch.js';
    const script = document.createElement('script');
    script.textContent = code;
    document.head.appendChild(script);
  </script></html>\);
  await browser.close();
})();
