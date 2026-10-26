import { Controller, Get, Header, Param, Query, ForbiddenException, StreamableFile } from '@nestjs/common';
import { Public } from '../common/auth.decorators';
import { configuredLocalStorage } from './local-storage';
import { sniffFile } from './files.service';

@Controller('files/local')
export class LocalFilesController {
  @Public()
  @Get(':token')
  @Header('Cache-Control','private, no-store')
  @Header('X-Content-Type-Options','nosniff')
  async read(@Param('token') token: string, @Query('expires') expires: string, @Query('signature') signature: string) {
    try {
      const storage = configuredLocalStorage();
      if (!storage) throw new Error();
      const data = await storage.readSigned(token, expires ?? '', signature ?? '');
      const kind = sniffFile(data);
      if (!kind) throw new Error();
      return new StreamableFile(data, { type: kind.mime, disposition: 'inline', length: data.length });
    } catch { throw new ForbiddenException('文件链接无效或已过期'); }
  }
}
