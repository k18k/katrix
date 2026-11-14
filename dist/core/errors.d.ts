export declare class MatrixError extends Error {
  readonly status: number;
  readonly errcode: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, errcode: string, message: string, extra?: Record<string, unknown>);
  toJSON(): {
    errcode: string;
    error: string;
  };
}
//# sourceMappingURL=errors.d.ts.map