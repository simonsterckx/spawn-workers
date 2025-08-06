import path from "node:path";
import { type WorkerStatus, spawnWorkers, throttle } from "../lib";
import type { CustomStatus } from "./worker";

const dirName = path.dirname(new URL(import.meta.url).pathname);

const logStatus = throttle(
  (statuses: readonly WorkerStatus<CustomStatus>[]) => {
    console.clear();
    console.log(`\n📊 Worker Status (${new Date().toLocaleTimeString()})`);
    console.table(
      statuses.map((status, index) => ({
        started: status.started,
        completed: status.completed,
        failed: status.failed,

        pending: status.pending,
      }))
    );
  },
  500
);

spawnWorkers<CustomStatus>({
  workerFilePath: path.resolve(dirName, "./worker.ts"),
  dataFilePath: path.resolve(dirName, "./data/data.txt"),
  processCount: 4,
  batchSize: 50,
  maxConcurrency: 100,
  maxPendingJobs: 200,
  tickDuration: 100,
  logFilePath: "spawn-workers.log",
  onComplete: () => {
    console.log("\n✅ All workers completed successfully!");
    process.exit(0);
  },
  onStatusUpdate: logStatus,
}).catch((error) => {
  console.error("Failed to start workers:", error);
  process.exit(1);
});
