/** 业务错误码（与方案 7.4 错误码表一致）。 */
export const ERR = {
  PARAM: 1001,
  UNAUTHORIZED: 1002,
  FORBIDDEN: 1003,
  RECEPTION_RUNNING: 2001,
  RECEPTION_FINISHED: 2002,
  SESSION_STATE: 2003,
  MATERIAL_REFERENCED: 3001,
  STYLE_RATIO: 3002,
  IMPORT_FORMAT: 4001,
  IMPORT_VALIDATE: 4002,
  NOT_FOUND: 1404,
} as const;

export class BizError extends Error {
  constructor(
    public readonly code: number,
    message: string
  ) {
    super(message);
  }
}

export const bizError = (code: number, message: string) => new BizError(code, message);
