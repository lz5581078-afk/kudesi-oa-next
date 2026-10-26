import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { IsString, Matches } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { RevenueService } from './revenue.service';

class RangeDto {
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) from!: string;
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) to!: string;
}

@Controller('revenue')
export class RevenueController {
  constructor(private readonly revenue: RevenueService) {}

  // 营收是财务数据：既要能看营业执照，也要能看店铺经营数据
  @RequirePermission('resource.licenses.view', 'resource.store-daily-metrics.view')
  @Get('licenses/:id')
  license(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Query() q: RangeDto) {
    return this.revenue.licenseSummary(user, id, q.from, q.to);
  }
}
