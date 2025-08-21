import { exec } from "node:child_process";
import path from "node:path";

const filePath = new URL(import.meta.url).pathname;
const dirname = path.dirname(filePath);
process.chdir(dirname);

const sever = exec("tsx server.ts");
sever.on("exit", (code) => {
  console.log(`Server exited with code ${code}`);
  process.exit(code);
});

const spawn = exec("tsx spawn.ts");
spawn.stdout?.on("data", (data) => {
  console.log(data.toString());
});
spawn.stderr?.on("data", (data) => {
  console.error(data.toString());
});

spawn.on("exit", (code) => {
  console.log(`Spawn process exited with code ${code}`);
  sever.kill();
  process.exit(code);
});

process.on("SIGINT", () => {
  console.log("\nReceived SIGINT, shutting down...");
  sever.kill();
  spawn.kill();
  process.exit(0);
});
