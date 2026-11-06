import { createTrialPerson } from './create-trial-person';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { WorkforceLoginService } from './workforce-login.service';
import { Body, Controller, Query, Get, Header, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser, CurrentUser, RequirePermission } from '../common/auth.decorators';
import { unfiledWorkforce } from './workforce-contract';

class DisplayDto { @IsArray() @ArrayMaxSize(200) @IsInt({each:true}) @Min(1,{each:true}) ids!:number[]; }
class TrialNameDto { @IsString() @IsNotEmpty() @MaxLength(50) name!: string; }
class LoginDto {
  @IsString() @Matches(/^[A-Za-z0-9_.-]{2,64}$/) account!:string;
  @IsOptional() @IsString() @MinLength(8) @MaxLength(72) password?:string;
}
class CreateLoginDto extends LoginDto {
  @IsString() @IsNotEmpty() @MaxLength(50) name!:string;
  @IsIn(['part_time','temp']) employmentType!:'part_time'|'temp';
  @IsOptional() @IsInt() @Min(1) departmentId?:number|null;
  @IsOptional() @IsInt() @Min(1) positionId?:number|null;
}

/** 兼职与临时工的辅助接口（档案本身走通用的 /api/resources/workforce）。公司只取自令牌。 */
@Controller('workforce')
export class WorkforceController {
  constructor(@InjectDataSource() private readonly ds: DataSource, private readonly login:WorkforceLoginService) {}

  @RequirePermission('resource.workforce.view')
  @Post('login-display')
  @Header('Cache-Control','no-store')
  display(@CurrentUser() user:AuthUser,@Body() input:DisplayDto){return this.login.display(user,input.ids);}

  @RequirePermission('resource.workforce.edit','org.staff.edit')
  @Put('users/:id/login')
  updateUnfiled(@CurrentUser() user:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() input:LoginDto){return this.login.update(user,id,input,true);}

  @RequirePermission('resource.workforce.create','org.staff.create')
  @Post('trial-people')
  createTrial(@CurrentUser() user: AuthUser, @Body() input: TrialNameDto) {
    return createTrialPerson(this.ds, user, input);
  }

  @RequirePermission('resource.workforce.create','org.staff.create')
  @Post('accounts')
  createAccount(@CurrentUser() user:AuthUser,@Body() input:CreateLoginDto){return this.login.create(user,input);}

  @RequirePermission('resource.workforce.edit','org.staff.edit')
  @Put(':id/login')
  updateLogin(@CurrentUser() user:AuthUser,@Param('id',ParseIntPipe) id:number,@Body() input:LoginDto){return this.login.update(user,id,input);}

  /** 用工类型是兼职/临时工、账号在用但还没建档案的人：这些人的合作期不受登录控制，档案页顶部提示补档案。 */
  @RequirePermission('resource.workforce.view')
  @Get('unfiled')
  unfiled(@CurrentUser() user: AuthUser, @Query('showDisabled') showDisabled?: string) {
    return unfiledWorkforce(this.ds.manager, user.companyId, showDisabled === 'true');
  }
}
