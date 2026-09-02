require('ts-node/register/transpile-only');
const { instrumentRuntimeLineTracking } = require('../src/processing/instrumentation');
const src = `
let x = 0;
let y = 0;
let xSpeed = 4;
let ySpeed = 4;
let size = 50;
let h = 0;

function setup() {
    createCanvas(windowWidth, windowHeight);
    colorMode(HSB);
    noStroke();
    x = width / 2;
    y = height / 2;
}

function draw() {
    background();
    fill(h % 360, 100, 200);
    circle(x, y, size);
    if (x > width - size / 2 || x < size / 2) {
        xSpeed *= -1;
    }
    if (y > height - size / 2 || y < size / 2) {
        ySpeed *= -1;
    }
    x += xSpeed;
    y += ySpeed;
    h++;
}
`;
const out = instrumentRuntimeLineTracking(src);
console.log('LEN', out.length);
console.log(out.slice(0, 600));
