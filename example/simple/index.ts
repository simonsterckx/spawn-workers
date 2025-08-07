import path from "node:path";
import { spawnWorkers } from "../../src";

const dirName = path.dirname(new URL(import.meta.url).pathname);

await spawnWorkers({
  workerFilePath: path.resolve(dirName, "./worker.ts"),
  dataFilePath: path.resolve(dirName, "./data.txt"),
  outputFilePath: path.resolve(dirName, "./output.txt"),
  overwriteOutputFile: true,
  processCount: 2,
  batchSize: 2,
  maxConcurrency: 2,
  maxPendingJobs: 100,
  tickDuration: 500,
  logFilePath: "worker.log",
  onStatusUpdate: (statuses) => {
    console.clear();
    console.table(
      statuses.map((status, index) => ({
        started: status.started,
        completed: status.completed,
        failed: status.failed,
        pending: status.pending,
      }))
    );
  },
  onError: (error, worker) => {
    console.error(`Worker ${worker.index} error:`, error.message);
  },
  onComplete: () => {
    console.log("All tasks completed!");
  },
});
