// Печатает CSV «a,b,c,d,score» по формуле из script.js — для сверки с формулой в базе.
const fs = require("fs");
const path = require("path");
const source = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");
const match = source.match(/function calculateScore\([\s\S]*?\n}\n/);
if (!match) { console.error("calculateScore не найдена в script.js"); process.exit(1); }
const calculateScore = new Function(`${match[0]}; return calculateScore;`)();
const rows = [];
for (let a = 1; a <= 9; a++) for (let b = 1; b <= 9; b++) for (let c = 1; c <= 9; c++) for (let d = 1; d <= 10; d++) {
  rows.push(`${a},${b},${c},${d},${calculateScore(a, b, c, d)}`);
}
process.stdout.write(rows.join("\n") + "\n");
