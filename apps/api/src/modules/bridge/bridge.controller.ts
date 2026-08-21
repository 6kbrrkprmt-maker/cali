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
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { SignalKind } from '@prisma/client';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { InputActionDto } from './dto/input-action.dto';
import { PushAnswerDto } from './dto/push-answer.dto';
import { PushCandidateDto } from './dto/push-candidate.dto';
import { PushOfferDto } from './dto/push-offer.dto';
import { StartBridgeSessionDto } from './dto/start-bridge-session.dto';
import { BridgeService } from './bridge.service';

interface RequestUser {
  sub: string;
}

@UseGuards(JwtAuthGuard)
@Controller('bridge')
export class BridgeController {
  public constructor(private readonly bridgeService: BridgeService) {}

  @Post('sessions/start')
  public async startSession(@Req() req: Request, @Body() body: StartBridgeSessionDto): Promise<{
    bridgeSessionId: string;
    workerSessionId: string;
    streamMode: 'livekit' | 'frame';
    viewToken: string;
    expiresAt: string;
  }> {
    const requestUser = req.user as RequestUser | undefined;

    if (!requestUser?.sub) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    return this.bridgeService.startBridgeSession(requestUser.sub, body.provider || 'calibet', body.streamMode || 'livekit');
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
    const requestUser = req.user as RequestUser | undefined;

    if (!requestUser?.sub) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    return this.bridgeService.getSessionStatus(requestUser.sub, bridgeSessionId);
  }

  @Delete('sessions/:bridgeSessionId')
  public async closeSession(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
  ): Promise<{ closed: boolean; closedAt: string }> {
    const requestUser = req.user as RequestUser | undefined;

    if (!requestUser?.sub) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    return this.bridgeService.closeBridgeSession(requestUser.sub, bridgeSessionId);
  }

  @Post('sessions/:bridgeSessionId/signal/offer')
  public async pushOffer(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
    @Body() body: PushOfferDto,
  ): Promise<{ signalId: number; queuedAt: string }> {
    const requestUser = req.user as RequestUser | undefined;

    if (!requestUser?.sub) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    return this.bridgeService.pushSignal(requestUser.sub, bridgeSessionId, SignalKind.OFFER, {
      sdp: body.sdp,
    });
  }

  @Post('sessions/:bridgeSessionId/signal/answer')
  public async pushAnswer(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
    @Body() body: PushAnswerDto,
  ): Promise<{ signalId: number; queuedAt: string }> {
    const requestUser = req.user as RequestUser | undefined;

    if (!requestUser?.sub) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    return this.bridgeService.pushSignal(requestUser.sub, bridgeSessionId, SignalKind.ANSWER, {
      sdp: body.sdp,
    });
  }

  @Post('sessions/:bridgeSessionId/signal/candidate')
  public async pushCandidate(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
    @Body() body: PushCandidateDto,
  ): Promise<{ signalId: number; queuedAt: string }> {
    const requestUser = req.user as RequestUser | undefined;

    if (!requestUser?.sub) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    return this.bridgeService.pushSignal(requestUser.sub, bridgeSessionId, SignalKind.ICE_CANDIDATE, {
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
    const requestUser = req.user as RequestUser | undefined;

    if (!requestUser?.sub) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    return this.bridgeService.pullSignals(requestUser.sub, bridgeSessionId, afterId);
  }

  @Get('sessions/:bridgeSessionId/frame')
  public async getFrame(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
  ): Promise<{ workerSessionId: string; mimeType?: string; imageBase64: string; capturedAt: string }> {
    const requestUser = req.user as RequestUser | undefined;

    if (!requestUser?.sub) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    return this.bridgeService.getFrame(requestUser.sub, bridgeSessionId);
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
    const requestUser = req.user as RequestUser | undefined;

    if (!requestUser?.sub) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    return this.bridgeService.createLiveKitViewerToken(requestUser.sub, bridgeSessionId);
  }

  @Post('sessions/:bridgeSessionId/input')
  public async sendInput(
    @Req() req: Request,
    @Param('bridgeSessionId') bridgeSessionId: string,
    @Body() body: InputActionDto,
  ): Promise<{ accepted: boolean; traceId: string; sentAt: string }> {
    const requestUser = req.user as RequestUser | undefined;

    if (!requestUser?.sub) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    return this.bridgeService.sendInputAction(requestUser.sub, bridgeSessionId, body);
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
    const requestUser = req.user as RequestUser | undefined;

    if (!requestUser?.sub) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    return this.bridgeService.syncSessionRecords(requestUser.sub, bridgeSessionId);
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
    const requestUser = req.user as RequestUser | undefined;

    if (!requestUser?.sub) {
      throw new UnauthorizedException('UNAUTHORIZED');
    }

    return this.bridgeService.getSessionNetworkLogs(requestUser.sub, bridgeSessionId, {
      contains,
      afterId,
      limit,
    });
  }
}
