import { Body, Controller, Get, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
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

@UseGuards(JwtAuthGuard)
@Controller('records')
export class RecordsController {
  public constructor(private readonly recordsService: RecordsService) {}

  @Get('bet')
  public async getBetRecords(
    @Req() req: Request,
    @Query() query: RecordQuery,
  ): Promise<RecordQueryResult<BetRecordRow>> {
    return this.recordsService.getBetRecords(this.getUserId(req), query);
  }

  @Get('credit')
  public async getCreditRecords(
    @Req() req: Request,
    @Query() query: RecordQuery,
  ): Promise<RecordQueryResult<CreditRecordRow>> {
    return this.recordsService.getCreditRecords(this.getUserId(req), query);
  }

  @Get('egame')
  public async getEGameRecords(
    @Req() req: Request,
    @Query() query: RecordQuery,
  ): Promise<RecordQueryResult<EGameRecordRow>> {
    return this.recordsService.getEGameRecords(this.getUserId(req), query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.OPERATOR, UserRole.ADMIN)
  @Post('adjustments')
  public async createAdjustment(
    @Req() req: Request,
    @Body() body: CreateSiteRecordAdjustmentDto,
  ): Promise<{ id: string; versionNo: number; recordKind: string; recordId: string }> {
    return this.recordsService.createAdjustment({
      adjustedByUserId: this.getUserId(req),
      recordKind: body.recordKind,
      recordId: body.recordId,
      reason: body.reason,
      nextValue: body.nextValue,
      changeNote: body.changeNote,
    });
  }

  private getUserId(req: Request): string {
    const requestUser = req.user as RequestUser | undefined;

    if (!requestUser?.sub) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    return requestUser.sub;
  }
}
