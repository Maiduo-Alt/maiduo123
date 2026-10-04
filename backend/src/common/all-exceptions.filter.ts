import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { BizError } from './errors';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();

    let code = 5000;
    let message = '服务器内部错误';
    let status = 200;

    if (exception instanceof BizError) {
      code = exception.code;
      message = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as any;
      message = typeof body === 'string' ? body : body?.message || exception.message;
      if (Array.isArray(message)) message = message.join('；');
      code = status === 401 ? 1002 : status === 403 ? 1003 : 1001;
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(exception.stack);
    }

    res.status(status).json({ code, message, data: null });
  }
}
