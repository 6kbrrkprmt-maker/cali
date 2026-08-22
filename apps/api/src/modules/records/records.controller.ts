import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PrismaService } from '../prisma.service';
import { CreateSiteRecordAdjustmentDto } from './dto/create-site-record-adjustment.dto';
import {
  BetRecordRow,
  CreditRecordRow,
  EGameRecordRow,
  RecordQuery,
  RecordQueryResult,
  RecordsService,
} from './records.service';

interface RequestUser {
  sub: string;
}

@Controller('records')
export class RecordsController {
  public constructor(
    private readonly recordsService: RecordsService,
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
  ) {}

  @Get('bet')
  public async getBetRecords(
    @Req() req: Request,
    @Query() query: RecordQuery,
  ): Promise<RecordQueryResult<BetRecordRow>> {
    return this.recordsService.getBetRecords(await this.getUserId(req), query);
  }

  @Get('credit')
  public async getCreditRecords(
    @Req() req: Request,
    @Query() query: RecordQuery,
  ): Promise<RecordQueryResult<CreditRecordRow>> {
    return this.recordsService.getCreditRecords(await this.getUserId(req), query);
  }

  @Get('egame')
  public async getEGameRecords(
    @Req() req: Request,
    @Query() query: RecordQuery,
  ): Promise<RecordQueryResult<EGameRecordRow>> {
    return this.recordsService.getEGameRecords(await this.getUserId(req), query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.ADMIN)
  @Post('adjustments')
  public async createAdjustment(
    @Req() req: Request,
    @Body() body: CreateSiteRecordAdjustmentDto,
  ): Promise<{ id: string; versionNo: number; recordKind: string; recordId: string }> {
    return this.recordsService.createAdjustment({
      adjustedByUserId: await this.getUserId(req),
      recordKind: body.recordKind,
      recordId: body.recordId,
      reason: body.reason,
      nextValue: body.nextValue,
      changeNote: body.changeNote,
    });
  }

  private async getUserId(req: Request): Promise<string> {
    const requestUser = req.user as RequestUser | undefined;

    if (requestUser?.sub) {
      return requestUser.sub;
    }

    const account = this.configService.get<string>('PUBLIC_OPERATOR_ACCOUNT') || 'public-operator';
    const user = await this.prismaService.user.upsert({
      where: { account },
      update: {},
      create: {
        account,
        passwordHash: 'public-bridge-login-disabled',
        role: UserRole.OPERATOR,
      },
      select: { id: true },
    });

    return user.id;
  }
}
