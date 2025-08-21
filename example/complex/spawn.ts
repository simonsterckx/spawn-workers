import path from "node:path";
import { type WorkerStatus, spawnWorkers, throttle } from "../../lib";
import type { CustomStatus } from "./worker";

const dirName = path.dirname(new URL(import.meta.url).pathname);

const logStatus = (statuses: readonly WorkerStatus<CustomStatus>[]) => {
  console.clear();
  console.log(`\n📊 Worker Status (${new Date().toLocaleTimeString()})`);
  console.table(
    statuses.map((status) => ({
      total: status.received,
      inProgress: status.inProgress,
      completed: status.completed,
      failed: status.failed,
    }))
  );
};

spawnWorkers<CustomStatus>({
  workerFilePath: path.resolve(dirName, "./worker.ts"),
  dataFilePath: path.resolve(dirName, "./data/data.txt"),
  outputFilePath: path.resolve(dirName, "./data/output.txt"),
  overwriteOutputFile: true,
  processCount: 4,
  maxConcurrency: 100,
  tickDuration: 100,
  logFilePath: path.resolve(dirName, "./spawn-workers.log"),
  onComplete: (status) => {
    logStatus(status);
    console.log("\n✅ All workers completed successfully!");
    process.exit(0);
  },
  onStatusUpdate: throttle(logStatus, 500),
}).catch((error) => {
  console.error("Failed to start workers:", error);
  process.exit(1);
});
