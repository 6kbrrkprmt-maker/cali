import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { Roles } from './decorators/roles.decorator';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';

interface RequestUser {
  sub: string;
  account: string;
  role: UserRole;
}

@Controller('auth')
export class AuthController {
  public constructor(private readonly authService: AuthService) {}

  @Post('register')
  public async register(@Body() registerDto: RegisterDto): Promise<{ id: string; account: string; role: UserRole }> {
    return this.authService.register(registerDto);
  }

  @Post('login')
  public async login(
    @Body() loginDto: LoginDto,
  ): Promise<{ accessToken: string; user: { id: string; account: string; role: UserRole } }> {
    return this.authService.login(loginDto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  public async me(@Req() req: Request): Promise<{ id: string; account: string; role: UserRole; createdAt: Date }> {
    const requestUser = req.user as RequestUser | undefined;

    if (!requestUser?.sub) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    return this.authService.getProfile(requestUser.sub);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.ADMIN)
  @Get('operator-area')
  public operatorArea(@Req() req: Request): { ok: boolean; account: string; role: UserRole } {
    const requestUser = req.user as RequestUser;

    return {
      ok: true,
      account: requestUser.account,
      role: requestUser.role,
    };
  }
}
