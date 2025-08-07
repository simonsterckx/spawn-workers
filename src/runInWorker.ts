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
    started: 0,
    completed: 0,
    failed: 0,
    pending: 0,
  };

  const sendStatusUpdate = () => {
    processSend({
      type: "status",
      status: status,
    });
  };

  const queue: string[] = [];
  let isProcessing = false;

  const batchSize = Number(process.env.MAX_CONCURRENCY);
  if (!batchSize) {
    throw new Error("MAX_CONCURRENCY environment variable is not set.");
  }

  async function processQueue() {
    if (isProcessing) {
      return;
    }
    isProcessing = true;

    while (queue.length > 0) {
      const batch = queue.splice(0, batchSize);
      status.pending = queue.length;

      const promises = batch.map((jobEntry) => {
        status.started++;
        return handler({
          message: jobEntry,
          status,
        })
          .then((result) => {
            status.completed++;
            return result;
          })
          .catch((error: Error | null) => {
            status.failed++;
            const errorDetails = error || new Error("Unknown error");
            if (error instanceof AggregateError) {
              errorDetails.name +=
                ".\n" + error.errors.map((e) => e.name).join(", ");
              errorDetails.message +=
                ".\n" + error.errors.map((e) => e.message).join(", ");
            }
            processSend({
              type: "error",
              error: errorDetails,
            });
          });
      });

      const results = await Promise.allSettled(promises);
      const fulfilledResults = results.reduce((acc, res) => {
        if (res.status === "fulfilled" && res.value != undefined) {
          acc.push(res.value);
        }
        return acc;
      }, [] as string[]);
      if (fulfilledResults.length > 0) {
        processSend({
          type: "completed",
          results: fulfilledResults,
        });
      }
    }

    isProcessing = false;

    // Check if new entries were added while processing
    if (queue.length > 0) {
      processQueue();
    } else {
      sendStatusUpdate();
    }
  }

  process.on("message", (message: IpcMessageRequest) => {
    if (message.type === "entries") {
      queue.push(...message.entries);
      status.pending = queue.length;
      processQueue();
      sendStatusUpdate();
    } else if (message.type === "close") {
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
    }
  });

  // send status updates at regular intervals
  const intervalId = setInterval(sendStatusUpdate, tickDuration);
}
