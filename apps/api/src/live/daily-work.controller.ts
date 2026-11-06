import {
  ForbiddenException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IsIn, IsInt, IsString, MaxLength, Min } from 'class-validator';
import {
  AuthenticatedOnly,
  AuthUser,
  CurrentUser,
} from '../common/auth.decorators';
import { DailyWorkService } from './daily-work.service';
import { LiveQrService } from './live-qr.service';
class DailyScheduleDto {
  @IsInt() @Min(1) userId!: number;
  @IsIn(['anchor', 'control']) role!: 'anchor' | 'control';
  @IsString() @MaxLength(19) startAt!: string;
  @IsString() @MaxLength(19) endAt!: string;
  @IsString() @MaxLength(500) content!: string;
}
class DailyReportDto {
  @IsString() @MaxLength(1000) report!: string;
}
class DailyCancelDto {
  @IsString() @MaxLength(500) reason!: string;
}
@Controller('live/daily-work')
export class DailyWorkController {
  constructor(
    private readonly work: DailyWorkService,
    private readonly qr: LiveQrService,
  ) {}
  @AuthenticatedOnly() @Get('review') review(@CurrentUser() u: AuthUser, @Query('page') page?: string) {
    return this.work.ledger(u, 'review', undefined, page);
  }
  @AuthenticatedOnly() @Get('wages') wages(@CurrentUser() u: AuthUser, @Query('month') month?: string, @Query('page') page?: string) {
    return this.work.ledger(u, 'wages', month, page);
  }
  @AuthenticatedOnly() @Get('options') options(@CurrentUser() u: AuthUser) {
    return this.work.options(u);
  }
  @AuthenticatedOnly() @Get() list(
    @CurrentUser() u: AuthUser,
    @Query('date') date?: string,
  ) {
    return this.work.list(u, date);
  }
  @AuthenticatedOnly() @Get('mine') async mine(
    @CurrentUser() u: AuthUser,
    @Query('date') date?: string,
    @Query('token') token?: string,
    @Query('company') company?: string,
  ) {
    if (token !== undefined) {
      if (Number(company) !== u.companyId)
        throw new ForbiddenException('二维码不属于当前公司');
      await this.qr.assert(u, token);
    }
    return this.work.list(u, date, true);
  }
  @AuthenticatedOnly() @Post() schedule(
    @CurrentUser() u: AuthUser,
    @Body() d: DailyScheduleDto,
  ) {
    return this.work.schedule(u, d);
  }
  @AuthenticatedOnly() @Post(':id/start') start(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.work.start(u, id);
  }
  @AuthenticatedOnly() @Post(':id/finish') finish(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() d: DailyReportDto,
  ) {
    return this.work.finish(u, id, d.report);
  }
  @AuthenticatedOnly() @Patch(':id/report') report(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() d: DailyReportDto,
  ) {
    return this.work.updateReport(u, id, d.report);
  }
  @AuthenticatedOnly() @Post(':id/submit') submit(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.work.submit(u, id);
  }
  @AuthenticatedOnly() @Post(':id/cancel') cancel(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() d: DailyCancelDto,
  ) {
    return this.work.cancel(u, id, d.reason);
  }
}
