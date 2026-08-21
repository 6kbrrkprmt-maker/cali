import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

export interface JwtPayload {
  sub: string;
  account: string;
  role: UserRole;
}

@Injectable()
export class AuthService {
  public constructor(
    private readonly prismaService: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  public async register(registerDto: RegisterDto): Promise<{ id: string; account: string; role: UserRole }> {
    const existing = await this.prismaService.user.findUnique({
      where: { account: registerDto.account },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('ACCOUNT_ALREADY_EXISTS');
    }

    const passwordHash = await bcrypt.hash(registerDto.password, 12);

    const user = await this.prismaService.user.create({
      data: {
        account: registerDto.account,
        passwordHash,
        role: registerDto.role ?? UserRole.USER,
      },
      select: {
        id: true,
        account: true,
        role: true,
      },
    });

    return user;
  }

  public async login(loginDto: LoginDto): Promise<{ accessToken: string; user: { id: string; account: string; role: UserRole } }> {
    const user = await this.prismaService.user.findUnique({
      where: { account: loginDto.account },
      select: {
        id: true,
        account: true,
        role: true,
        passwordHash: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }

    const isValid = await bcrypt.compare(loginDto.password, user.passwordHash);

    if (!isValid) {
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }

    const payload: JwtPayload = {
      sub: user.id,
      account: user.account,
      role: user.role,
    };

    const accessToken = await this.jwtService.signAsync(payload);

    return {
      accessToken,
      user: {
        id: user.id,
        account: user.account,
        role: user.role,
      },
    };
  }

  public async getProfile(userId: string): Promise<{ id: string; account: string; role: UserRole; createdAt: Date }> {
    const user = await this.prismaService.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        account: true,
        role: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('USER_NOT_FOUND');
    }

    return user;
  }
}
