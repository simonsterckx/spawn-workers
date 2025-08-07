import { runInWorker } from "../../src";

runInWorker({
  handler: async ({ message }) => {
    // Process your task here
    const data = JSON.parse(message) as {
      id: string;
      name: string;
    };

    // Simulate work
    await new Promise((resolve) => setTimeout(resolve, 100));

    return JSON.stringify({
      id: data.id,
      name: "Task " + data.id + " completed.",
    });
  },
});
