import { Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '../../common/decorators';
import { MAX_UPLOAD_BYTES, UploadsService } from './uploads.service';

@Controller('api/uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /** 上传图片（商品主图/详情图、内容配图、头像）：返回 { url } 供表单保存。 */
  @Roles('admin', 'leader')
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  upload(@UploadedFile() file: any) {
    return this.uploads.save(file);
  }
}
