import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/** 统一响应体：{ code, message, data } */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((data) => {
        if (data && typeof data === 'object' && 'code' in data && 'message' in data && Object.keys(data).length <= 3) {
          return data;
        }
        return { code: 0, message: 'ok', data: data === undefined ? null : data };
      })
    );
  }
}
