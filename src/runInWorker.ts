import type {
  IpcMessage,
  IpcMessageRequest,
  JobExecutionConfig,
  WorkerStatus,
} from "./types";

export function runInWorker<T extends Record<string, number>>({
  handler,
  onExit,
  customStatus,
  tickDuration = 500,
}: JobExecutionConfig<T>): void {
  if (typeof process === "undefined" || !process.send) {
    throw new Error("This function must be run in a worker context.");
  }
  const processSend: (message: IpcMessage<T>) => void =
    process.send.bind(process);

  const status: WorkerStatus<T> = {
    custom: customStatus || ({} as T),
    received: 0,
    started: 0,
    completed: 0,
    failed: 0,
    pending: 0,
    inProgress: 0,
  };

  const sendStatusUpdate = () => {
    processSend({
      type: "status",
      status: {
        ...status,
        inProgress: runningPromises.size,
      },
    });
  };

  const queue: string[] = [];
  const runningPromises = new Set<Promise<void>>();

  const maxConcurrency = Number(process.env.MAX_CONCURRENCY);
  if (!maxConcurrency) {
    throw new Error("MAX_CONCURRENCY environment variable is not set.");
  }

  async function processJob(jobEntry: string): Promise<void> {
    status.started++;

    try {
      const result = await handler({
        message: jobEntry,
        status: status,
      });

      status.completed++;
      if (result != null) {
        processSend({
          type: "completed",
          result: result,
        });
      }
    } catch (error: any) {
      status.failed++;
      const errorDetails = error || new Error("Unknown error");
      if (error instanceof AggregateError) {
        errorDetails.name += ".\n" + error.errors.map((e) => e.name).join(", ");
        errorDetails.message +=
          ".\n" + error.errors.map((e) => e.message).join(", ");
      }

      processSend({
        type: "error",
        error: errorDetails,
      });
    }
  }

  function startNewJobs() {
    while (queue.length > 0 && runningPromises.size < maxConcurrency) {
      const jobEntry = queue.shift()!;
      status.pending = queue.length;

      const jobPromise = processJob(jobEntry).finally(() => {
        runningPromises.delete(jobPromise);
        // Try to start more jobs after this one completes
        startNewJobs();
      });

      runningPromises.add(jobPromise);
    }
  }

  process.on("message", (message: IpcMessageRequest) => {
    if (message.type === "entries") {
      queue.push(...message.entries);
      status.pending = queue.length;
      status.received += message.entries.length;
      startNewJobs();
      sendStatusUpdate();
    } else if (message.type === "close-request") {
      // Only respond with close-response if we truly have no pending work
      if (queue.length === 0 && runningPromises.size === 0) {
        processSend({
          type: "close-response",
        });
        sendStatusUpdate();
        clearInterval(intervalId);
        const exitPromise = onExit?.();
        if (exitPromise instanceof Promise) {
          exitPromise.then(() => {
            process.exit(0);
          });
        } else {
          process.exit(0);
        }
      } else {
        // If we still have work, we'll respond later when we're truly done
        // Check again after current processing completes
        const checkForClose = () => {
          if (queue.length === 0 && runningPromises.size === 0) {
            processSend({
              type: "close-response",
            });
            sendStatusUpdate();
            clearInterval(intervalId);
            const exitPromise = onExit?.();
            if (exitPromise instanceof Promise) {
              exitPromise.then(() => {
                process.exit(0);
              });
            } else {
              process.exit(0);
            }
          } else {
            // Check again in a short interval
            setTimeout(checkForClose, 100);
          }
        };
        setTimeout(checkForClose, 100);
      }
    }
  });

  // send status updates at regular intervals
  const intervalId = setInterval(sendStatusUpdate, tickDuration);
}
