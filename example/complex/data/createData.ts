import fs from "fs";
import path from "path";

const outputFile = path.resolve("./data.txt");
const requestCount = 10000;

const file = fs.createWriteStream(outputFile, { flags: "w" });

for (let i = 0; i < requestCount; i++) {
  const requestString = `{"id": ${i}, "name": "Entry ${i}", "value": ${Math.random()}}`;
  file.write(requestString + "\n");
}

file.end();
console.log(`Data file created at ${outputFile}`);
