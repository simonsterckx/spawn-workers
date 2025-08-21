export type JobHandlerArgs<CustomStatus extends Record<string, number>> = {
  message: string;
  status: WorkerStatus<CustomStatus>;
};

export type JobHandler<CustomStatus extends Record<string, number>> = (
  args: JobHandlerArgs<CustomStatus>
) => Promise<string | undefined | void>;

export type JobExecutionConfig<T extends Record<string, number>> = {
  handler: JobHandler<T>;
  onExit?: () => void | Promise<void>;
  customStatus?: T;
  tickDuration?: number;
};

export interface WorkerStatus<CustomStatus extends Record<string, number>> {
  custom: CustomStatus;

  received: number;
  started: number;
  pending: number;
  completed: number;
  failed: number;
  inProgress: number;
}

export type IpcMessageRequest =
  | {
      type: "close-request";
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
      type: "status";
      status: WorkerStatus<CustomStatus>;
    }
  | {
      type: "completed";
      result: string;
    }
  | {
      type: "error";
      error: ErrorLike | undefined;
    }
  | {
      type: "close-response";
    };
