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

  /** Path to the output file where worker results will be written */
  outputFilePath?: string;

  /** Path to the failure output file where worker errors will be written */
  failureOutputFilePath?: string;

  /** Whether to overwrite the output file if it exists @default false */
  overwriteOutputFile?: boolean;

  /** Number of worker processes to spawn */
  processCount: number;

  /** Maximum number of concurrent entries per worker */
  maxConcurrency: number;

  /**
   * The amount of entries sent to each worker in one batch.
   * @default data.length / processCount
   */
  batchSize?: number;

  /**
   * Maximum number of pending jobs per worker
   * @default batchSize * 2
   */
  maxPendingJobs?: number;

  /**
   * Duration of each tick in milliseconds
   * @default 500
   */
  tickDuration?: number;

  /** Initial index to start processing from */
  initialIndex?: number;

  /** Total number of entries to process (from initialIndex) */
  totalEntries?: number;

  /** Path to log file */
  logFilePath?: string;

  /** Called when all workers complete */
  onComplete?: (statuses: readonly WorkerStatus<CustomStatus>[]) => void;

  /** Called on each status update with all worker statuses */
  onStatusUpdate?: (statuses: readonly WorkerStatus<CustomStatus>[]) => void;

  /** Called when an error occurs in a worker */
  onError?: (error: ErrorLike, worker: { index: number; pid?: number }) => void;

  /** Additional environment variables to pass to workers */
  env?: Record<string, string>;
}

type OptionalConfig = Pick<
  SpawnWorkersConfig<any>,
  | "logFilePath"
  | "outputFilePath"
  | "failureOutputFilePath"
  | "overwriteOutputFile"
>;

type WorkerInfo = {
  process: ChildProcess;
  status: WorkerStatus<any>;
  isCompleted: boolean;
  closeRequested: boolean;
};

export class WorkerManager<CustomStatus extends Record<string, number>> {
  private workers: WorkerInfo[] = [];
  private config: Omit<
    Required<SpawnWorkersConfig<CustomStatus>>,
    | "logFilePath"
    | "outputFilePath"
    | "failureOutputFilePath"
    | "overwriteOutputFile"
  >;

  private optionalConfig: OptionalConfig;
  private logFile?: WriteStream;
  private outputFile?: WriteStream;
  private failureOutputFile?: WriteStream;
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
      batchSize: 0,
      maxPendingJobs: 0,
      env: {},
      ...config,
      onComplete: config.onComplete ?? (() => {}),
      onStatusUpdate: config.onStatusUpdate ?? (() => {}),
      onError: config.onError ?? (() => {}),
    };
    this.optionalConfig = {
      logFilePath: config.logFilePath,
      outputFilePath: config.outputFilePath,
      failureOutputFilePath: config.failureOutputFilePath,
      overwriteOutputFile: config.overwriteOutputFile || false,
    };
  }

  private validateConfig(config: SpawnWorkersConfig<CustomStatus>): void {
    if (config.processCount <= 0) {
      throw new Error("processCount must be greater than 0");
    }
    if (config.maxConcurrency <= 0) {
      throw new Error("maxConcurrency must be greater than 0");
    }
  }

  async initialize(): Promise<void> {
    try {
      const dataContent = await fs.readFile(this.config.dataFilePath, "utf8");
      this.dataEntries = dataContent.trim().split("\n");

      // Set up total entries if not specified
      if (!this.config.totalEntries) {
        this.config.totalEntries = Math.max(
          0,
          this.dataEntries.length - this.config.initialIndex
        );
      }
      // Set up batch size if not specified (defaults to data length / process count)
      if (!this.config.batchSize) {
        this.config.batchSize = Math.ceil(
          this.dataEntries.length / this.config.processCount
        );
      }
      // Set up max pending jobs if not specified
      if (!this.config.maxPendingJobs) {
        this.config.maxPendingJobs = this.config.batchSize * 2;
      }

      // Validate indices
      if (this.config.initialIndex >= this.dataEntries.length) {
        throw new Error(
          `initialIndex (${this.config.initialIndex}) is greater than or equal to data length (${this.dataEntries.length})`
        );
      }

      this.currentIndex = this.config.initialIndex;

      // Set up logging
      if (this.optionalConfig.logFilePath) {
        this.logFile = createWriteStream(this.optionalConfig.logFilePath, {
          flags: "a",
          encoding: "utf8",
        });
      }
      // Set up output file
      if (this.optionalConfig.outputFilePath) {
        // Ensure file is empty before writing
        const outputFileSize = await fs
          .stat(this.optionalConfig.outputFilePath)
          .then((stats) => stats.size)
          .catch(() => 0);
        if (outputFileSize > 0) {
          if (!this.optionalConfig.overwriteOutputFile) {
            console.error(
              `Output file ${this.optionalConfig.outputFilePath} already exists and overwriteOutputFile is false`
            );
            process.exit(1);
          }
          await fs.truncate(this.optionalConfig.outputFilePath, 0);
        }
        this.outputFile = createWriteStream(
          this.optionalConfig.outputFilePath,
          {
            flags: "a",
            encoding: "utf8",
          }
        );
      }
      // Set up failure output file
      if (this.optionalConfig.failureOutputFilePath) {
        // Ensure file is empty before writing
        const failureFileSize = await fs
          .stat(this.optionalConfig.failureOutputFilePath)
          .then((stats) => stats.size)
          .catch(() => 0);
        if (failureFileSize > 0) {
          if (!this.optionalConfig.overwriteOutputFile) {
            console.error(
              `Failure output file ${this.optionalConfig.failureOutputFilePath} already exists and overwriteOutputFile is false`
            );
            process.exit(1);
          }
          await fs.truncate(this.optionalConfig.failureOutputFilePath, 0);
        }
        this.failureOutputFile = createWriteStream(
          this.optionalConfig.failureOutputFilePath,
          {
            flags: "a",
            encoding: "utf8",
          }
        );
      }

      // Set up signal handlers
      process.on("SIGINT", this.handleShutdown.bind(this));
      process.on("SIGTERM", this.handleShutdown.bind(this));
    } catch (error) {
      const errorString =
        error instanceof Error ? error.message : String(error);
      console.error(`Error initializing worker manager: ${errorString}`);
      process.exit(1);
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

    if (this.logFile?.writable) {
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
    } else if (message.type === "status") {
      workerInfo.status = message.status;
      const statuses = this.workers.map((w) => w.status);
      this.config.onStatusUpdate(statuses);
    } else if (message.type === "completed-batch") {
      if (this.outputFile?.writable) {
        const results = message.results.filter(Boolean);
        if (results.length > 0) {
          this.outputFile.write(results.join("\n") + "\n");
        }
      }
      if (this.failureOutputFile?.writable) {
        const failures = message.failures.filter(Boolean);
        if (failures.length > 0) {
          this.failureOutputFile.write(
            failures.map((e) => `${e.name}: ${e.message}`).join("\n") + "\n"
          );
        }
      }
    } else if (message.type === "close-response") {
      // Worker confirmed it's ready to close
      workerInfo.isCompleted = true;

      if (this.logFile?.writable) {
        this.logFile.write(
          `[${new Date().toISOString()}] Worker ${workerIndex} confirmed completion\n`
        );
      }
    }
  }

  private logError(workerIndex: number, error: ErrorLike): void {
    if (this.logFile?.writable) {
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

      if (this.logFile?.writable) {
        this.logFile.write(
          `[${new Date().toISOString()}] Job completed. Duration: ${duration}ms\n`
        );
      }

      this.cleanup();

      const statuses = this.workers.map((w) => w.status);
      this.config.onComplete(statuses);
    };

    for (let i = 0; i < this.config.processCount; i++) {
      const child = fork(this.config.workerFilePath, {
        env: {
          ...process.env,
          ...this.config.env,
          MAX_CONCURRENCY: String(this.config.maxConcurrency),
        },
        silent: false,
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
        closeRequested: false,
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

    if (this.logFile?.writable) {
      this.logFile.write(`\n[${new Date().toISOString()}] Workers started\n`);
    }

    this.startedAt = Date.now();
    this.startChildProcesses();

    const stopIndex = this.config.initialIndex + this.config.totalEntries - 1;

    if (this.logFile?.writable) {
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
    // Send close requests to workers that appear to be idle
    this.workers.forEach((workerInfo, index) => {
      if (workerInfo.process.exitCode !== null) {
        return; // Worker already exited
      }

      // Only send close request if we haven't already and worker appears idle
      if (
        !workerInfo.closeRequested &&
        !workerInfo.isCompleted &&
        workerInfo.status.pending <= 0
      ) {
        this.sendToWorker(workerInfo.process, { type: "close-request" });
        workerInfo.closeRequested = true;

        if (this.logFile?.writable) {
          this.logFile.write(
            `[${new Date().toISOString()}] Sent close request to Worker ${index}\n`
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
