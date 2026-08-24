import {
  Body,
  Controller,
  Delete,
  Get,
  ParseIntPipe,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignalKind, UserRole } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../prisma.service';
import { InputActionDto } from './dto/input-action.dto';
import { PushAnswerDto } from './dto/push-answer.dto';
import { PushCandidateDto } from './dto/push-candidate.dto';
import { PushOfferDto } from './dto/push-offer.dto';
import { StartBridgeSessionDto } from './dto/start-bridge-session.dto';
import { BridgeService } from './bridge.service';

interface RequestUser {
  sub: string;
}

@Controller('bridge')
export class BridgeController {
  public constructor(
    private readonly bridgeService: BridgeService,
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
  ) {}

  private async getBridgeUserId(req: Request): Promise<string> {
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

  @Post('sessions/start')
  public async startSession(@Req() req: Request, @Body() body: StartBridgeSessionDto): Promise<{
    bridgeSessionId: string;
    workerSessionId: string;
    streamMode: 'livekit' | 'frame';
    viewToken: string;
    expiresAt: string;
  }> {
    const userId = await this.getBridgeUserId(req);
    return this.bridgeService.startBridgeSession(userId, body.provider || 'calibet', body.streamMode || 'livekit');
  }

  @Get('sessions/:bridgeSessionId')
  public async getStatus(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
  ): Promise<{
    id: string;
    provider: string;
    status: string;
    workerSessionId: string | null;
    startedAt: Date | null;
    expiresAt: Date;
  }> {
    const userId = await this.getBridgeUserId(req);
    return this.bridgeService.getSessionStatus(userId, bridgeSessionId);
  }

  @Delete('sessions/:bridgeSessionId')
  public async closeSession(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
  ): Promise<{ closed: boolean; closedAt: string }> {
    const userId = await this.getBridgeUserId(req);
    return this.bridgeService.closeBridgeSession(userId, bridgeSessionId);
  }

  @Post('sessions/:bridgeSessionId/signal/offer')
  public async pushOffer(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
    @Body() body: PushOfferDto,
  ): Promise<{ signalId: number; queuedAt: string }> {
    const userId = await this.getBridgeUserId(req);
    return this.bridgeService.pushSignal(userId, bridgeSessionId, SignalKind.OFFER, {
      sdp: body.sdp,
    });
  }

  @Post('sessions/:bridgeSessionId/signal/answer')
  public async pushAnswer(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
    @Body() body: PushAnswerDto,
  ): Promise<{ signalId: number; queuedAt: string }> {
    const userId = await this.getBridgeUserId(req);
    return this.bridgeService.pushSignal(userId, bridgeSessionId, SignalKind.ANSWER, {
      sdp: body.sdp,
    });
  }

  @Post('sessions/:bridgeSessionId/signal/candidate')
  public async pushCandidate(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
    @Body() body: PushCandidateDto,
  ): Promise<{ signalId: number; queuedAt: string }> {
    const userId = await this.getBridgeUserId(req);
    return this.bridgeService.pushSignal(userId, bridgeSessionId, SignalKind.ICE_CANDIDATE, {
      candidate: body.candidate,
      sdpMid: body.sdpMid,
      sdpMLineIndex: body.sdpMLineIndex,
    });
  }

  @Get('sessions/:bridgeSessionId/signal/poll')
  public async pollSignals(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
    @Query('afterId', new ParseIntPipe({ optional: true })) afterId = 0,
  ): Promise<{ signals: Array<{ id: number; from: string; kind: string; payload: unknown; createdAt: string }> }> {
    const userId = await this.getBridgeUserId(req);
    return this.bridgeService.pullSignals(userId, bridgeSessionId, afterId);
  }

  @Get('sessions/:bridgeSessionId/frame')
  public async getFrame(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
  ): Promise<{ workerSessionId: string; mimeType?: string; imageBase64: string; capturedAt: string }> {
    const userId = await this.getBridgeUserId(req);
    return this.bridgeService.getFrame(userId, bridgeSessionId);
  }

  @Get('sessions/:bridgeSessionId/livekit-token')
  public async getLiveKitToken(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
  ): Promise<{
    url: string;
    room: string;
    identity: string;
    token: string;
    expiresAt: string;
  }> {
    const userId = await this.getBridgeUserId(req);
    return this.bridgeService.createLiveKitViewerToken(userId, bridgeSessionId);
  }

  @Post('sessions/:bridgeSessionId/input')
  public async sendInput(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
    @Body() body: InputActionDto,
  ): Promise<{ accepted: boolean; traceId: string; sentAt: string }> {
    const userId = await this.getBridgeUserId(req);
    return this.bridgeService.sendInputAction(userId, bridgeSessionId, body);
  }

  @Post('sessions/:bridgeSessionId/sync-records')
  public async syncRecords(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
  ): Promise<{
    bridgeSessionId: string;
    processed: { bet: number; credit: number; egame: number };
    inserted: { bet: number; credit: number; egame: number; total: number };
    parseErrors: number;
  }> {
    const userId = await this.getBridgeUserId(req);
    return this.bridgeService.syncSessionRecords(userId, bridgeSessionId);
  }

  @Get('sessions/:bridgeSessionId/network')
  public async getNetworkLogs(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
    @Query('contains') contains?: string,
    @Query('afterId', new ParseIntPipe({ optional: true })) afterId?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ): Promise<{
    workerSessionId: string;
    count: number;
    logs: Array<{
      id: number;
      url: string;
      method: string;
      status: number;
      resourceType: string;
      contentType: string;
      capturedAt: string;
      bodySnippet?: string;
    }>;
  }> {
    const userId = await this.getBridgeUserId(req);
    return this.bridgeService.getSessionNetworkLogs(userId, bridgeSessionId, {
      contains,
      afterId,
      limit,
    });
  }

  @Get('sessions/:bridgeSessionId/baccarat-outcome')
  public async detectBaccaratOutcome(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
    @Query('afterId', new ParseIntPipe({ optional: true })) afterId = 0,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 300,
  ): Promise<{
    bridgeSessionId: string;
    scanned: number;
    lastLogId: number;
    detection: {
      outcome: 'player' | 'banker' | 'tie';
      confidence: number;
      source: string;
      detectionKey: string;
      evidence: string;
      externalRoundId?: string;
      logId: number;
      detectedAt: string;
    } | null;
  }> {
    const userId = await this.getBridgeUserId(req);
    return this.bridgeService.detectBaccaratOutcome(userId, bridgeSessionId, { afterId, limit });
  }
}
