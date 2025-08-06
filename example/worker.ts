import axios from "axios";
import { runInWorker } from "../lib";

export type CustomStatus = {};

const SERVER_URL = "http://localhost:9090";

const initialStatus: CustomStatus = {};

runInWorker({
  handler: async ({ message }) => {
    const response = await axios.post(SERVER_URL, message, {
      headers: {
        "Content-Type": "application/json",
      },
    });
    if (response.status !== 200) {
      throw new Error(`Api request failed: ${response.status}`);
    }
  },
  customStatus: initialStatus,
});
