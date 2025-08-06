export type JobHandlerArgs<CustomStatus extends Record<string, number>> = {
  message: string;
  status: WorkerStatus<CustomStatus>;
  onError: (error: Error) => void;
};

export type JobHandler<CustomStatus extends Record<string, number>> = (
  args: JobHandlerArgs<CustomStatus>
) => Promise<void>;

export type ErrorHandler = (error: ErrorLike) => void;

export interface WorkerStatus<CustomStatus extends Record<string, number>> {
  custom: CustomStatus;

  started: number;
  completed: number;
  failed: number;
  pending: number;
}

export type IpcMessageRequest =
  | {
      type: "close";
    }
  | {
      type: "entries";
      entries: string[];
    };

export type ErrorLike = {
  name: string;
  message: string;
  stack?: string;
};

export type IpcMessage<CustomStatus extends Record<string, number>> =
  | {
      type: "status" | "completed";
      status: WorkerStatus<CustomStatus>;
    }
  | {
      type: "error";
      error: ErrorLike | undefined;
    };
