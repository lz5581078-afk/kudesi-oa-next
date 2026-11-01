import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthenticatedOnly, AuthUser, CurrentUser } from '../common/auth.decorators';
import { CollectorIdentityService } from './collector-identity.service';
import { CollectorTextService, TEXT_MODES, TextMode } from './collector-text.service';

export class CollectorTextDto {
  @IsIn(TEXT_MODES) mode!: TextMode;
  @IsString() @MinLength(1) @MaxLength(20000) text!: string;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
}

@Controller('collector/text')
export class CollectorTextController {
  constructor(private readonly identity: CollectorIdentityService, private readonly text: CollectorTextService) {}
  @AuthenticatedOnly() @Get()
  async overview(@CurrentUser() user: AuthUser) {
    await this.identity.session(user);
    return this.text.overview(user.companyId);
  }
  @AuthenticatedOnly() @Post()
  async organize(@CurrentUser() user: AuthUser, @Body() dto: CollectorTextDto) {
    await this.identity.session(user);
    return this.text.organize(user.companyId, user.id, dto.mode, dto.text, dto.title ?? '');
  }
}
