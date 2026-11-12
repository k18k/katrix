export declare class MatrixError extends Error {
  readonly status: number;
  readonly errcode: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, errcode: string, message: string, extra?: Record<string, unknown>);
  toJSON(): Record<string, unknown>;
}
//# sourceMappingURL=errors.d.ts.map