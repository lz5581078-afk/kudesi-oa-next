import {Body,Controller,Get,Param,Put} from '@nestjs/common';
import {IsObject} from 'class-validator';
import {AuthenticatedOnly,AuthUser,CurrentUser} from '../common/auth.decorators';
import {UserPreferencesService} from './user-preferences.service';
class PreferenceDto{@IsObject() value!:Record<string,unknown>}
@Controller('user-preferences')
export class UserPreferencesController{
 constructor(private readonly preferences:UserPreferencesService){}
 @AuthenticatedOnly() @Get(':key') get(@CurrentUser() user:AuthUser,@Param('key') key:string){return this.preferences.get(user,key);}
 @AuthenticatedOnly() @Put(':key') put(@CurrentUser() user:AuthUser,@Param('key') key:string,@Body() dto:PreferenceDto){return this.preferences.put(user,key,dto.value);}
}
