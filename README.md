# spawn-workers

A high-performance worker pool library for Node.js that spawns worker processes to handle tasks in parallel.

Can be used for load testing, processing large datasets, running background jobs, or any task that can benefit from concurrent execution.

## Features

- **Parallel Processing**: Spawn multiple worker processes to handle tasks concurrently
- **Type-Safe**: Full TypeScript support with generic custom status tracking
- **Configurable**: Flexible configuration for batch sizes, concurrency limits, and more
- **Error Handling**: Comprehensive error handling with custom error handlers
- **Progress Tracking**: Real-time status updates and logging
- **Resource Management**: Automatic cleanup and graceful shutdown

## Installation

```bash
npm install spawn-workers
# or
bun install spawn-workers
```

## Quick Start

### 1. Create a Worker

Create a worker file that defines how to process each task:

```typescript
import { runInWorker } from "spawn-workers";

runInWorker({
  handler: async ({ message }) => {

    // Process your task here
    const data = JSON.parse(message);
    
    // Simulate work
    await new Promise(resolve => setTimeout(resolve, 100));

  },
});
```

### 2. Spawn Workers

Create a main file to spawn and manage workers:

```typescript
import { spawnWorkers } from "spawn-workers";
import path from "node:path";

const dirName = path.dirname(new URL(import.meta.url).pathname);

await spawnWorkers({
  workerFilePath: path.resolve(dirName, "./worker.ts"),
  dataFilePath: path.resolve(dirName, "./data/data.txt"),
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

```

### 3. Prepare Data

Create a data file with one task per line:

```txt
{"id": 1, "name": "Task 1"}
{"id": 2, "name": "Task 2"}
{"id": 3, "name": "Task 3"}
```

## Example Usage

Run the included example:

```bash
# Start the test server
npm run server

# In another terminal, run the worker pool
npm run spawn

# Or run both with a single command
npm run example
```

## API Reference

### `runInWorker(config)`

Configures a worker process to handle tasks.

**Parameters:**
- `handler`: Function to process each task
- `customStatus`: Initial custom status object

### `spawnWorkers(config)`

Spawns worker processes to handle a pool of tasks.

**Configuration:**
- `workerFilePath`: Path to the worker script
- `dataFilePath`: Path to the data file
- `processCount`: Number of worker processes
- `batchSize`: Tasks sent per batch
- `maxConcurrency`: Max concurrent tasks per worker
- `maxPendingJobs`: Max pending jobs per worker
- `tickDuration`: Interval that distributes workload to workers
- `onStatusUpdate`: Status update callback
- `onError`: Error handler callback
- `onComplete`: Completion callback

## Utilities

The library also exports a simple throttle function:

```typescript
import { throttle } from "spawn-workers";


// Throttle function calls
const throttledUpdate = throttle(updateUI, 100);

```

## License

MIT

