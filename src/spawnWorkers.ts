import fs from "fs/promises";
import { ChildProcess, fork } from "node:child_process";
import { createWriteStream, WriteStream } from "node:fs";
import process from "node:process";
import type {
  ErrorLike,
  IpcMessage,
  IpcMessageRequest,
  WorkerStatus,
} from "./types";

export interface SpawnWorkersConfig<
  CustomStatus extends Record<string, number>
> {
  /** Path to the worker file to spawn */
  workerFilePath: string;

  /** Path to the data file containing entries to process */
  dataFilePath: string;

  /** Number of worker processes to spawn */
  processCount: number;

  /** The amount of entries sent to each worker in one batch */
  batchSize: number;

  /** Maximum number of concurrent entries per worker */
  maxConcurrency: number;

  /** Maximum number of pending jobs per worker */
  maxPendingJobs: number;

  /** Duration of each tick in milliseconds */
  tickDuration?: number;

  /** Initial index to start processing from */
  initialIndex?: number;

  /** Total number of entries to process (from initialIndex) */
  totalEntries?: number;

  /** Path to log file */
  logFilePath?: string;

  /** Called when all workers complete */
  onComplete?: () => void;

  /** Called on each status update with all worker statuses */
  onStatusUpdate?: (statuses: readonly WorkerStatus<CustomStatus>[]) => void;

  /** Called when an error occurs in a worker */
  onError?: (error: ErrorLike, worker: { index: number; pid?: number }) => void;

  /** Additional environment variables to pass to workers */
  env?: Record<string, string>;
}

type WorkerInfo = {
  process: ChildProcess;
  status: WorkerStatus<any>;
  isCompleted: boolean;
};

export class WorkerManager<CustomStatus extends Record<string, number>> {
  private workers: WorkerInfo[] = [];
  private config: Omit<
    Required<SpawnWorkersConfig<CustomStatus>>,
    "logFilePath"
  > &
    Pick<SpawnWorkersConfig<CustomStatus>, "logFilePath">;
  private logFile?: WriteStream;
  private startedAt: number = 0;
  private currentIndex: number = 0;
  private dataEntries: string[] = [];
  private workerIntervalId?: NodeJS.Timeout;
  private isShuttingDown = false;

  constructor(config: SpawnWorkersConfig<CustomStatus>) {
    // Validate required config
    this.validateConfig(config);

    // Resolve file paths (convert relative to absolute)

    this.config = {
      tickDuration: 500,
      initialIndex: 0,
      totalEntries: 0,
      env: {},
      ...config,
      onComplete: config.onComplete ?? (() => {}),
      onStatusUpdate: config.onStatusUpdate ?? (() => {}),
      onError: config.onError ?? (() => {}),
    };
  }

  private validateConfig(config: SpawnWorkersConfig<CustomStatus>): void {
    if (config.processCount <= 0) {
      throw new Error("processCount must be greater than 0");
    }
    if (config.batchSize <= 0) {
      throw new Error("batchSize must be greater than 0");
    }
    if (config.maxConcurrency <= 0) {
      throw new Error("maxConcurrency must be greater than 0");
    }
    if (config.maxPendingJobs <= 0) {
      throw new Error("maxPendingJobs must be greater than 0");
    }
  }

  async initialize(): Promise<void> {
    try {
      const dataContent = await fs.readFile(this.config.dataFilePath, "utf8");
      this.dataEntries = dataContent.trim().split("\n");

      // Set up total entries if not specified
      if (this.config.totalEntries === 0) {
        this.config.totalEntries = Math.max(
          0,
          this.dataEntries.length - this.config.initialIndex
        );
      }

      // Validate indices
      if (this.config.initialIndex >= this.dataEntries.length) {
        throw new Error(
          `initialIndex (${this.config.initialIndex}) is greater than or equal to data length (${this.dataEntries.length})`
        );
      }

      this.currentIndex = this.config.initialIndex;

      // Set up logging
      if (this.config.logFilePath) {
        this.logFile = createWriteStream(this.config.logFilePath, {
          flags: "a",
          encoding: "utf8",
        });
      }

      // Set up signal handlers
      process.on("SIGINT", this.handleShutdown.bind(this));
      process.on("SIGTERM", this.handleShutdown.bind(this));
    } catch (error) {
      throw new Error(
        `Failed to initialize: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private handleShutdown(): void {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log("Shutting down workers...");
    this.cleanup();
    process.exit(0);
  }

  private cleanup(): void {
    if (this.workerIntervalId) {
      clearInterval(this.workerIntervalId);
    }

    this.workers.forEach(({ process: proc }) => {
      if (!proc.killed) {
        proc.kill("SIGTERM");
      }
    });

    if (this.logFile && !this.logFile.destroyed) {
      this.logFile.end();
    }
  }

  private handleIpcMessage(
    message: IpcMessage<CustomStatus>,
    workerIndex: number
  ): void {
    const workerInfo = this.workers[workerIndex];
    if (!workerInfo) return;

    if (message.type === "error") {
      const error = message.error;
      if (error && this.config.onError) {
        this.config.onError(error, {
          index: workerIndex,
          pid: workerInfo.process.pid,
        });
        this.logError(workerIndex, error);
      }
    } else if (message.type === "status" || message.type === "completed") {
      workerInfo.status = message.status;
      const statuses = this.workers.map((w) => w.status);
      this.config.onStatusUpdate(statuses);
    }
  }

  private logError(workerIndex: number, error: ErrorLike): void {
    if (this.logFile && !this.logFile.destroyed) {
      const logMessage = `[${new Date().toISOString()}][Worker ${workerIndex}] Error: ${
        error.name
      } - ${error.message}`;
      this.logFile.write(logMessage + "\n");
    }
  }

  private startChildProcesses(): void {
    let exitCount = 0;
    console.log(`Starting ${this.config.processCount} worker processes...`);

    const handleExit = (): void => {
      const duration = Date.now() - this.startedAt;

      if (this.logFile && !this.logFile.destroyed) {
        this.logFile.write(
          `[${new Date().toISOString()}] Job completed. Duration: ${duration}ms\n`
        );
      }

      this.cleanup();

      this.config.onComplete();
    };

    for (let i = 0; i < this.config.processCount; i++) {
      const child = fork(this.config.workerFilePath, {
        env: {
          ...process.env,
          ...this.config.env,
          MAX_CONCURRENCY: String(this.config.maxConcurrency),
        },
      });

      const workerInfo: WorkerInfo = {
        process: child,
        status: {
          custom: {} as CustomStatus,
          started: 0,
          completed: 0,
          failed: 0,
          pending: 0,
        },
        isCompleted: false,
      };

      child.on("error", (err) => {
        console.error(`Worker ${i} error:`, err.message);
        this.config.onError(
          {
            name: err.name,
            message: err.message,
            stack: err.stack,
          },
          { index: i, pid: child.pid }
        );
      });

      child.on("exit", (code, signal) => {
        if (code !== 0 && signal !== "SIGTERM") {
          console.warn(
            `Worker ${i} exited with code ${code}, signal ${signal}`
          );
        }

        exitCount++;
        if (exitCount === this.config.processCount) {
          handleExit();
        }
      });

      child.on("message", (message: IpcMessage<CustomStatus>) => {
        this.handleIpcMessage(message, i);
      });

      this.workers.push(workerInfo);
    }
  }

  async start(): Promise<void> {
    await this.initialize();

    if (this.logFile) {
      this.logFile.write(`\n[${new Date().toISOString()}] Workers started\n`);
    }

    this.startedAt = Date.now();
    this.startChildProcesses();

    const stopIndex = this.config.initialIndex + this.config.totalEntries - 1;

    if (this.logFile) {
      this.logFile.write(
        `[${new Date().toISOString()}] Processing entries ${
          this.config.initialIndex
        } to ${stopIndex}. Total: ${this.config.totalEntries}\n`
      );
    }

    // Start the distribution loop
    this.workerIntervalId = setInterval(() => {
      this.distributeWork(stopIndex);
    }, this.config.tickDuration);
  }

  private distributeWork(stopIndex: number): void {
    if (this.isShuttingDown) return;

    // Check if all work is distributed
    if (this.currentIndex >= stopIndex) {
      this.checkForCompletion();
      return;
    }

    // Distribute work to available workers
    this.workers.forEach((workerInfo) => {
      if (workerInfo.process.exitCode !== null) {
        return;
      }

      const workerPending = workerInfo.status.pending;

      // Skip if worker is busy
      if (workerPending >= this.config.maxPendingJobs) {
        return;
      }

      // Calculate batch size for this worker
      const remainingEntries = stopIndex + 1 - this.currentIndex;
      const batchSize = Math.min(this.config.batchSize, remainingEntries);

      if (batchSize <= 0) return;

      const entriesBatch = this.dataEntries.slice(
        this.currentIndex,
        this.currentIndex + batchSize
      );

      this.currentIndex += batchSize;

      this.sendToWorker(workerInfo.process, {
        type: "entries",
        entries: entriesBatch,
      });
    });
  }

  private checkForCompletion(): void {
    // Close workers that have finished processing
    this.workers.forEach((workerInfo, index) => {
      if (workerInfo.status.pending <= 0 && !workerInfo.isCompleted) {
        this.sendToWorker(workerInfo.process, { type: "close" });
        workerInfo.isCompleted = true;

        if (this.logFile && !this.logFile.destroyed) {
          this.logFile.write(
            `[${new Date().toISOString()}] Worker ${index} completed\n`
          );
        }
      }
    });
  }

  private sendToWorker(worker: ChildProcess, message: IpcMessageRequest): void {
    if (worker.connected && !worker.killed) {
      worker.send(message);
    }
  }
}

/**
 * Spawns worker processes to process data entries
 */
export async function spawnWorkers<CustomStatus extends Record<string, number>>(
  config: SpawnWorkersConfig<CustomStatus>
): Promise<void> {
  const manager = new WorkerManager(config);
  await manager.start();
}
