import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BridgeSessionStatus, Prisma, SignalFrom, SignalKind } from '@prisma/client';
import * as crypto from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { AccessToken, IngressClient, IngressInput } from 'livekit-server-sdk';
import { PrismaService } from '../prisma.service';
import { InputActionDto } from './dto/input-action.dto';

interface StartWorkerResponse {
  workerSessionId: string;
  startedAt: string;
}

interface LiveKitJoinToken {
  url: string;
  room: string;
  identity: string;
  token: string;
  expiresAt: string;
}

interface LiveKitWhipIngress {
  room: string;
  ingressId: string;
  ingressUrl: string;
  streamKey: string;
}

interface WorkerNetworkLogEntry {
  id: number;
  url: string;
  method: string;
  status: number;
  resourceType: string;
  contentType: string;
  capturedAt: string;
  bodySnippet?: string;
}

@Injectable()
export class BridgeService {
  private readonly logger = new Logger(BridgeService.name);

  public constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  public async startBridgeSession(
    userId: string,
    provider = 'calibet',
    requestedStreamMode: 'livekit' | 'frame' = 'livekit',
  ): Promise<{
    bridgeSessionId: string;
    workerSessionId: string;
    streamMode: 'livekit' | 'frame';
    viewToken: string;
    expiresAt: string;
  }> {
    const ttlSeconds = Number(this.configService.get<string>('BRIDGE_TOKEN_TTL_SECONDS') || 900);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    await this.closeExistingBridgeSessions(userId, provider);

    const viewToken = await this.jwtService.signAsync(
      {
        sub: userId,
        scope: 'bridge:view',
      },
      {
        secret: this.configService.get<string>('VIEW_TOKEN_SECRET') || 'unsafe-view-secret',
        expiresIn: `${ttlSeconds}s`,
      },
    );

    const viewTokenHash = crypto.createHash('sha256').update(viewToken).digest('hex');

    const bridgeSession = await this.prismaService.bridgeSession.create({
      data: {
        userId,
        provider,
        viewTokenHash,
        expiresAt,
        status: BridgeSessionStatus.PENDING,
      },
      select: {
        id: true,
      },
    });

    let streamMode: 'livekit' | 'frame' = requestedStreamMode;
    let liveKitIngress: LiveKitWhipIngress | undefined;
    if (requestedStreamMode === 'livekit') {
      try {
        liveKitIngress = await this.ensureLiveKitWhipIngress(bridgeSession.id);
        if (!liveKitIngress) {
          streamMode = 'frame';
        }
      } catch (error) {
        const message = this.getErrorMessage(error);
        if (!/ingress minutes exceeded/i.test(message)) {
          throw error;
        }

        this.logger.warn(`LiveKit ingress quota exceeded; starting bridge ${bridgeSession.id} in frame mode`);
        streamMode = 'frame';
      }
    }
    const workerResponse = await this.startWorkerSession(bridgeSession.id, userId, liveKitIngress);

    const updated = await this.prismaService.bridgeSession.update({
      where: { id: bridgeSession.id },
      data: {
        workerSessionId: workerResponse.workerSessionId,
        status: BridgeSessionStatus.ACTIVE,
        startedAt: new Date(workerResponse.startedAt),
      },
      select: {
        id: true,
        workerSessionId: true,
      },
    });

    return {
      bridgeSessionId: updated.id,
      workerSessionId: updated.workerSessionId || '',
      streamMode,
      viewToken,
      expiresAt: expiresAt.toISOString(),
    };
  }

  public async getSessionStatus(userId: string, bridgeSessionId: string): Promise<{
    id: string;
    provider: string;
    status: BridgeSessionStatus;
    workerSessionId: string | null;
    startedAt: Date | null;
    expiresAt: Date;
  }> {
    const session = await this.prismaService.bridgeSession.findUnique({
      where: { id: bridgeSessionId },
      select: {
        id: true,
        userId: true,
        provider: true,
        status: true,
        workerSessionId: true,
        startedAt: true,
        expiresAt: true,
      },
    });

    if (!session) {
      throw new NotFoundException('BRIDGE_SESSION_NOT_FOUND');
    }

    if (session.userId !== userId) {
      throw new ForbiddenException('BRIDGE_SESSION_FORBIDDEN');
    }

    return {
      id: session.id,
      provider: session.provider,
      status: session.status,
      workerSessionId: session.workerSessionId,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
    };
  }

  public async closeBridgeSession(
    userId: string,
    bridgeSessionId: string,
  ): Promise<{ closed: boolean; closedAt: string }> {
    const session = await this.assertOwnedSession(userId, bridgeSessionId);

    if (session.workerSessionId) {
      await this.stopWorkerSession(session.workerSessionId).catch((error: unknown) => {
        this.logger.warn(`Failed to stop worker session ${session.workerSessionId}: ${this.getErrorMessage(error)}`);
      });
    }

    await this.deleteLiveKitIngressesForBridgeSession(session.id).catch((error: unknown) => {
      this.logger.warn(`Failed to delete LiveKit ingress for bridge session ${session.id}: ${this.getErrorMessage(error)}`);
    });

    const closedAt = new Date();
    await this.prismaService.bridgeSession.update({
      where: { id: session.id },
      data: {
        status: BridgeSessionStatus.CLOSED,
        closedAt,
      },
    });

    return { closed: true, closedAt: closedAt.toISOString() };
  }

  public async pushSignal(
    userId: string,
    bridgeSessionId: string,
    kind: SignalKind,
    payload: Record<string, unknown>,
  ): Promise<{ signalId: number; queuedAt: string }> {
    const session = await this.assertOwnedSession(userId, bridgeSessionId);

    const jsonPayload = JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;

    const signal = await this.prismaService.bridgeSignal.create({
      data: {
        bridgeSessionId: session.id,
        from: SignalFrom.CLIENT,
        kind,
        payload: jsonPayload,
      },
      select: {
        id: true,
        createdAt: true,
      },
    });

    if (session.workerSessionId) {
      await this.forwardSignalToWorker(session.workerSessionId, kind, payload);
    }

    return {
      signalId: signal.id,
      queuedAt: signal.createdAt.toISOString(),
    };
  }

  public async pullSignals(
    userId: string,
    bridgeSessionId: string,
    afterId: number,
  ): Promise<{ signals: Array<{ id: number; from: SignalFrom; kind: SignalKind; payload: unknown; createdAt: string }> }> {
    await this.assertOwnedSession(userId, bridgeSessionId);

    const signals = await this.prismaService.bridgeSignal.findMany({
      where: {
        bridgeSessionId,
        id: {
          gt: afterId,
        },
      },
      orderBy: {
        id: 'asc',
      },
      take: 100,
      select: {
        id: true,
        from: true,
        kind: true,
        payload: true,
        createdAt: true,
      },
    });

    return {
      signals: signals.map((signal) => ({
        id: signal.id,
        from: signal.from,
        kind: signal.kind,
        payload: signal.payload,
        createdAt: signal.createdAt.toISOString(),
      })),
    };
  }

  public async getFrame(
    userId: string,
    bridgeSessionId: string,
  ): Promise<{ workerSessionId: string; mimeType?: string; imageBase64: string; capturedAt: string }> {
    const session = await this.assertOwnedSession(userId, bridgeSessionId);

    if (!session.workerSessionId) {
      throw new BadGatewayException('WORKER_SESSION_NOT_READY');
    }

    const workerUrl = this.configService.get<string>('WORKER_INTERNAL_URL') || 'http://localhost:4300';
    const workerKey = this.configService.get<string>('WORKER_SHARED_KEY') || 'unsafe-worker-key';

    const response = await fetch(
      `${workerUrl}/internal/session/${session.workerSessionId}/frame?type=jpeg&quality=45`,
      {
        method: 'GET',
        headers: {
          'x-worker-key': workerKey,
        },
      },
    );

    if (!response.ok) {
      throw new BadGatewayException('WORKER_FRAME_FETCH_FAILED');
    }

    const payload = (await response.json()) as {
      workerSessionId: string;
      mimeType?: string;
      imageBase64: string;
      capturedAt: string;
    };

    if (!payload.imageBase64) {
      throw new BadGatewayException('WORKER_FRAME_INVALID_RESPONSE');
    }

    return payload;
  }

  public async sendInputAction(
    userId: string,
    bridgeSessionId: string,
    action: InputActionDto,
  ): Promise<{ accepted: boolean; traceId: string; sentAt: string }> {
    const session = await this.assertOwnedSession(userId, bridgeSessionId);

    if (!session.workerSessionId) {
      throw new BadGatewayException('WORKER_SESSION_NOT_READY');
    }

    const traceId = crypto.randomUUID();
    const sentAt = new Date();
    const jsonActionPayload = JSON.parse(JSON.stringify(action)) as Prisma.InputJsonValue;

    await this.forwardInputToWorker(session.workerSessionId, action);

    await this.prismaService.rawActionLog.create({
      data: {
        userId,
        provider: session.provider,
        sourceTraceId: traceId,
        actionType: 'UI_INPUT',
        actionPayload: jsonActionPayload,
        sourceCreatedAt: sentAt,
      },
    });

    return {
      accepted: true,
      traceId,
      sentAt: sentAt.toISOString(),
    };
  }

  public async getSessionNetworkLogs(
    userId: string,
    bridgeSessionId: string,
    options?: { contains?: string; afterId?: number; limit?: number },
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
    const session = await this.assertOwnedSession(userId, bridgeSessionId);
    if (!session.workerSessionId) {
      throw new BadGatewayException('WORKER_SESSION_NOT_READY');
    }

    const workerUrl = this.configService.get<string>('WORKER_INTERNAL_URL') || 'http://localhost:4300';
    const workerKey = this.configService.get<string>('WORKER_SHARED_KEY') || 'unsafe-worker-key';
    const params = new URLSearchParams();
    if (options?.contains) {
      params.set('contains', options.contains);
    }
    if (typeof options?.afterId === 'number' && options.afterId > 0) {
      params.set('afterId', String(options.afterId));
    }
    if (typeof options?.limit === 'number' && options.limit > 0) {
      params.set('limit', String(options.limit));
    }

    const query = params.toString() ? `?${params.toString()}` : '';
    const response = await fetch(
      `${workerUrl}/internal/session/${session.workerSessionId}/network${query}`,
      {
        method: 'GET',
        headers: {
          'x-worker-key': workerKey,
        },
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new BadGatewayException(`WORKER_NETWORK_FETCH_FAILED: ${detail}`);
    }

    return response.json() as Promise<{
      workerSessionId: string;
      count: number;
      logs: WorkerNetworkLogEntry[];
    }>;
  }

  public async syncSessionRecords(
    userId: string,
    bridgeSessionId: string,
  ): Promise<{
    bridgeSessionId: string;
    processed: { bet: number; credit: number; egame: number };
    inserted: { bet: number; credit: number; egame: number; total: number };
    parseErrors: number;
  }> {
    const session = await this.assertOwnedSession(userId, bridgeSessionId);
    if (!session.workerSessionId) {
      throw new BadGatewayException('WORKER_SESSION_NOT_READY');
    }

    const networkLogs = await this.getSessionNetworkLogs(userId, bridgeSessionId, {
      contains: '/api-gw/webapi/',
      limit: 800,
    });

    const dedup = new Set<string>();
    const betRows: Array<Record<string, unknown>> = [];
    const creditRows: Array<Record<string, unknown>> = [];
    const egameRows: Array<Record<string, unknown>> = [];
    let parseErrors = 0;

    for (const log of networkLogs.logs) {
      if (!log.bodySnippet || log.method !== 'POST' || log.status < 200 || log.status >= 400) {
        continue;
      }

      const endpoint = this.resolveApiGwEndpoint(log.url);
      if (!endpoint) {
        continue;
      }

      const dedupKey = `${endpoint}:${log.bodySnippet}`;
      if (dedup.has(dedupKey)) {
        continue;
      }
      dedup.add(dedupKey);

      const parsed = this.parseJsonObject(log.bodySnippet);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        parseErrors += 1;
        continue;
      }

      const rows = this.extractApiGwRows(parsed);
      if (endpoint === 'bet') {
        betRows.push(...rows);
      } else if (endpoint === 'credit') {
        creditRows.push(...rows);
      } else {
        egameRows.push(...rows);
      }
    }

    const betCreateData = this.uniqueBy(
      betRows
        .map((row) => this.mapBetRecordRow(userId, row))
        .filter((row): row is NonNullable<typeof row> => Boolean(row)),
      (row) => row.orderNo,
    );
    const creditCreateData = this.uniqueBy(
      creditRows
        .map((row) => this.mapCreditRecordRow(userId, row))
        .filter((row): row is NonNullable<typeof row> => Boolean(row)),
      (row) => row.transactionNo,
    );
    const egameCreateData = this.uniqueBy(
      egameRows
        .map((row) => this.mapEgameRecordRow(userId, row))
        .filter((row): row is NonNullable<typeof row> => Boolean(row)),
      (row) => row.orderNo,
    );

    const betInserted = betCreateData.length > 0
      ? await this.prismaService.siteBetRecord.createMany({ data: betCreateData, skipDuplicates: true })
      : { count: 0 };
    const creditInserted = creditCreateData.length > 0
      ? await this.prismaService.siteCreditRecord.createMany({ data: creditCreateData, skipDuplicates: true })
      : { count: 0 };
    const egameInserted = egameCreateData.length > 0
      ? await this.prismaService.siteEGameRecord.createMany({ data: egameCreateData, skipDuplicates: true })
      : { count: 0 };

    return {
      bridgeSessionId,
      processed: {
        bet: betCreateData.length,
        credit: creditCreateData.length,
        egame: egameCreateData.length,
      },
      inserted: {
        bet: betInserted.count,
        credit: creditInserted.count,
        egame: egameInserted.count,
        total: betInserted.count + creditInserted.count + egameInserted.count,
      },
      parseErrors,
    };
  }

  public async createLiveKitViewerToken(userId: string, bridgeSessionId: string): Promise<LiveKitJoinToken> {
    await this.assertOwnedSession(userId, bridgeSessionId);

    const liveKitUrl = this.configService.get<string>('LIVEKIT_URL');
    const liveKitApiKey = this.configService.get<string>('LIVEKIT_API_KEY');
    const liveKitApiSecret = this.configService.get<string>('LIVEKIT_API_SECRET');
    const ttlSeconds = Number(this.configService.get<string>('LIVEKIT_TOKEN_TTL_SECONDS') || 900);

    if (!liveKitUrl || !liveKitApiKey || !liveKitApiSecret) {
      throw new BadGatewayException('LIVEKIT_NOT_CONFIGURED');
    }

    const room = this.getLiveKitRoomName(bridgeSessionId);
    const identity = `viewer:${userId}:${bridgeSessionId}`;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const accessToken = new AccessToken(liveKitApiKey, liveKitApiSecret, {
      identity,
      ttl: `${ttlSeconds}s`,
    });

    accessToken.addGrant({
      room,
      roomJoin: true,
      canPublish: false,
      canSubscribe: true,
      canPublishData: true,
    });

    return {
      url: liveKitUrl,
      room,
      identity,
      token: await accessToken.toJwt(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  private getLiveKitRoomName(bridgeSessionId: string): string {
    return `bridge-${bridgeSessionId}`;
  }

  private async closeExistingBridgeSessions(userId: string, provider: string): Promise<void> {
    const sessions = await this.prismaService.bridgeSession.findMany({
      where: {
        userId,
        provider,
        status: { in: [BridgeSessionStatus.PENDING, BridgeSessionStatus.ACTIVE] },
      },
      select: {
        id: true,
        workerSessionId: true,
      },
    });

    if (sessions.length === 0) {
      return;
    }

    for (const session of sessions) {
      if (session.workerSessionId) {
        await this.stopWorkerSession(session.workerSessionId).catch((error: unknown) => {
          this.logger.warn(`Failed to stop worker session ${session.workerSessionId}: ${this.getErrorMessage(error)}`);
        });
      }

      await this.deleteLiveKitIngressesForBridgeSession(session.id).catch((error: unknown) => {
        this.logger.warn(`Failed to delete LiveKit ingress for bridge session ${session.id}: ${this.getErrorMessage(error)}`);
      });
    }

    await this.prismaService.bridgeSession.updateMany({
      where: { id: { in: sessions.map((session) => session.id) } },
      data: {
        status: BridgeSessionStatus.CLOSED,
        closedAt: new Date(),
      },
    });
  }

  private async stopWorkerSession(workerSessionId: string): Promise<void> {
    const workerUrl = this.configService.get<string>('WORKER_INTERNAL_URL') || 'http://localhost:4300';
    const workerKey = this.configService.get<string>('WORKER_SHARED_KEY') || 'unsafe-worker-key';

    const response = await fetch(`${workerUrl}/internal/session/${workerSessionId}`, {
      method: 'DELETE',
      headers: {
        'x-worker-key': workerKey,
      },
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(await response.text());
    }
  }

  private async deleteLiveKitIngressesForBridgeSession(bridgeSessionId: string): Promise<void> {
    const liveKitUrl = this.configService.get<string>('LIVEKIT_URL');
    const liveKitApiKey = this.configService.get<string>('LIVEKIT_API_KEY');
    const liveKitApiSecret = this.configService.get<string>('LIVEKIT_API_SECRET');

    if (!liveKitUrl || !liveKitApiKey || !liveKitApiSecret) {
      return;
    }

    const ingressClient = new IngressClient(
      this.getLiveKitHttpUrl(liveKitUrl),
      liveKitApiKey,
      liveKitApiSecret,
    );
    const ingresses = await ingressClient.listIngress({ roomName: this.getLiveKitRoomName(bridgeSessionId) });

    for (const ingress of ingresses) {
      await ingressClient.deleteIngress(ingress.ingressId);
    }
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async ensureLiveKitWhipIngress(bridgeSessionId: string): Promise<LiveKitWhipIngress | undefined> {
    const liveKitUrl = this.configService.get<string>('LIVEKIT_URL');
    const liveKitApiKey = this.configService.get<string>('LIVEKIT_API_KEY');
    const liveKitApiSecret = this.configService.get<string>('LIVEKIT_API_SECRET');

    if (!liveKitUrl || !liveKitApiKey || !liveKitApiSecret) {
      return undefined;
    }

    const room = this.getLiveKitRoomName(bridgeSessionId);
    const participantIdentity = `publisher:${bridgeSessionId}`;
    const ingressClient = new IngressClient(
      this.getLiveKitHttpUrl(liveKitUrl),
      liveKitApiKey,
      liveKitApiSecret,
    );
    const existing = (await ingressClient.listIngress({ roomName: room }))
      .find((item) => item.participantIdentity === participantIdentity && item.url && item.streamKey);
    const ingress = existing || await this.createLiveKitWhipIngressWithCleanup(
      ingressClient,
      bridgeSessionId,
      room,
      participantIdentity,
    );

    return {
      room,
      ingressId: ingress.ingressId,
      ingressUrl: ingress.url,
      streamKey: ingress.streamKey,
    };
  }

  private async createLiveKitWhipIngressWithCleanup(
    ingressClient: IngressClient,
    bridgeSessionId: string,
    room: string,
    participantIdentity: string,
  ): Promise<{ ingressId: string; url: string; streamKey: string }> {
    await this.cleanupInactiveLiveKitIngresses(ingressClient);
    const inputType = this.getLiveKitIngressInputType();

    try {
      return await ingressClient.createIngress(inputType, {
        name: `bridge-${bridgeSessionId}`,
        roomName: room,
        participantIdentity,
        participantName: 'Cali Stream Worker',
        enableTranscoding: inputType !== IngressInput.WHIP_INPUT,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ingress object limit exceeded|resource_exhausted|too many requests/i.test(message)) {
        await this.cleanupInactiveLiveKitIngresses(ingressClient);
        return await ingressClient.createIngress(inputType, {
          name: `bridge-${bridgeSessionId}`,
          roomName: room,
          participantIdentity,
          participantName: 'Cali Stream Worker',
          enableTranscoding: inputType !== IngressInput.WHIP_INPUT,
        });
      }

      throw new BadGatewayException(`LIVEKIT_INGRESS_CREATE_FAILED: ${message}`);
    }
  }

  private getLiveKitIngressInputType(): IngressInput {
    const configured = (this.configService.get<string>('LIVEKIT_INGRESS_INPUT') || 'RTMP').toUpperCase();

    return configured === 'WHIP' ? IngressInput.WHIP_INPUT : IngressInput.RTMP_INPUT;
  }

  private async cleanupInactiveLiveKitIngresses(ingressClient: IngressClient): Promise<void> {
    const ingresses = await ingressClient.listIngress();
    const inactiveBridgeIngresses = ingresses.filter((item) => {
      const status = item.state?.status;
      const isInactive = status === 0;
      const isManagedByPoc = item.name?.startsWith('bridge-') || item.name?.startsWith('debug-');

      return isInactive && isManagedByPoc;
    });

    for (const ingress of inactiveBridgeIngresses) {
      await ingressClient.deleteIngress(ingress.ingressId);
    }
  }

  private getLiveKitHttpUrl(liveKitUrl: string): string {
    const url = new URL(liveKitUrl);
    if (url.protocol === 'wss:') {
      url.protocol = 'https:';
    }
    if (url.protocol === 'ws:') {
      url.protocol = 'http:';
    }
    return url.toString().replace(/\/$/, '');
  }

  private async startWorkerSession(
    bridgeSessionId: string,
    userId: string,
    liveKitIngress?: LiveKitWhipIngress,
  ): Promise<StartWorkerResponse> {
    const workerUrl = this.configService.get<string>('WORKER_INTERNAL_URL') || 'http://localhost:4300';
    const workerKey = this.configService.get<string>('WORKER_SHARED_KEY') || 'unsafe-worker-key';
    const externalBaseUrl = this.configService.get<string>('EXTERNAL_BASE_URL') || 'https://ams.calibet.com';

    const response = await fetch(`${workerUrl}/internal/session/start`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-key': workerKey,
      },
      body: JSON.stringify({
        bridgeSessionId,
        platformUserId: userId,
        launchUrl: externalBaseUrl,
        liveKit: liveKitIngress,
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new BadGatewayException(`WORKER_START_FAILED: ${detail}`);
    }

    const payload = (await response.json()) as StartWorkerResponse;

    if (!payload.workerSessionId) {
      throw new BadGatewayException('WORKER_INVALID_RESPONSE');
    }

    return payload;
  }

  private async forwardSignalToWorker(
    workerSessionId: string,
    kind: SignalKind,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const workerUrl = this.configService.get<string>('WORKER_INTERNAL_URL') || 'http://localhost:4300';
    const workerKey = this.configService.get<string>('WORKER_SHARED_KEY') || 'unsafe-worker-key';

    const response = await fetch(`${workerUrl}/internal/session/${workerSessionId}/signal`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-key': workerKey,
      },
      body: JSON.stringify({
        from: 'CLIENT',
        kind,
        payload,
      }),
    });

    if (!response.ok) {
      throw new BadGatewayException('WORKER_SIGNAL_FORWARD_FAILED');
    }
  }

  private async forwardInputToWorker(
    workerSessionId: string,
    action: InputActionDto,
  ): Promise<void> {
    const workerUrl = this.configService.get<string>('WORKER_INTERNAL_URL') || 'http://localhost:4300';
    const workerKey = this.configService.get<string>('WORKER_SHARED_KEY') || 'unsafe-worker-key';

    const response = await fetch(`${workerUrl}/internal/session/${workerSessionId}/input`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-key': workerKey,
      },
      body: JSON.stringify(action),
    });

    if (!response.ok) {
      throw new BadGatewayException('WORKER_INPUT_FORWARD_FAILED');
    }
  }

  private async assertOwnedSession(
    userId: string,
    bridgeSessionId: string,
  ): Promise<{ id: string; userId: string; workerSessionId: string | null; provider: string }> {
    const session = await this.prismaService.bridgeSession.findUnique({
      where: { id: bridgeSessionId },
      select: {
        id: true,
        userId: true,
        workerSessionId: true,
        provider: true,
      },
    });

    if (!session) {
      throw new NotFoundException('BRIDGE_SESSION_NOT_FOUND');
    }

    if (session.userId !== userId) {
      throw new ForbiddenException('BRIDGE_SESSION_FORBIDDEN');
    }

    return session;
  }

  private resolveApiGwEndpoint(url: string): 'bet' | 'credit' | 'egame' | null {
    if (/\/api-gw\/webapi\/betLog\/records/i.test(url)) {
      return 'bet';
    }
    if (/\/api-gw\/webapi\/client\/creditLog/i.test(url)) {
      return 'credit';
    }
    if (/\/api-gw\/webapi\/betLog\/eGameRecords/i.test(url)) {
      return 'egame';
    }
    return null;
  }

  private parseJsonObject(value: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch (_error) {
      return null;
    }
  }

  private extractApiGwRows(payload: Record<string, unknown>): Array<Record<string, unknown>> {
    const data = payload.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return [];
    }

    const rows = (data as Record<string, unknown>).C;
    if (!Array.isArray(rows)) {
      return [];
    }

    return rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
  }

  private mapBetRecordRow(userId: string, row: Record<string, unknown>): {
    userId: string;
    provider: string;
    orderNo: string;
    gameType: string;
    tableNo: string;
    roundNo: string;
    betTime: Date;
    betType: string;
    betAmount: string;
    validAmount: string;
    winLoss: string;
    status: string;
    replayPath?: string;
  } | null {
    const orderNo = this.toSafeString(row.AA);
    const betTime = this.parseApiGwDate(row.GG);
    if (!orderNo || !betTime) {
      return null;
    }

    const replayPath = this.toSafeString(row.NN);
    return {
      userId,
      provider: 'calibet',
      orderNo,
      gameType: this.toSafeString(row.HH) || this.toSafeString(row.BB) || 'UNKNOWN',
      tableNo: this.toSafeString(row.CC) || '-',
      roundNo: this.toSafeString(row.DD) || '-',
      betTime,
      betType: this.stringifyCompact(row.VV) || this.stringifyCompact(row.WW) || this.toSafeString(row.OO) || 'UNKNOWN',
      betAmount: this.toDecimalString(row.II),
      validAmount: this.toDecimalString(row.JJ, row.II),
      winLoss: this.toDecimalString(row.LL),
      status: this.toSafeString(row.MM) || this.toSafeString(row.EE) || 'UNKNOWN',
      replayPath: replayPath || undefined,
    };
  }

  private mapCreditRecordRow(userId: string, row: Record<string, unknown>): {
    userId: string;
    provider: string;
    transactionNo: string;
    accountNo: string;
    operationTime: Date;
    transactionType: string;
    balanceBefore: string;
    income: string;
    expense: string;
    balanceAfter: string;
  } | null {
    const transactionNo = this.toSafeString(row.AA);
    const operationTime = this.parseApiGwDate(row.CC);
    if (!transactionNo || !operationTime) {
      return null;
    }

    const typeCode = this.toSafeString(row.DD);
    return {
      userId,
      provider: 'calibet',
      transactionNo,
      accountNo: this.toSafeString(row.BB) || '-',
      operationTime,
      transactionType: this.mapCreditType(typeCode),
      balanceBefore: this.toDecimalString(row.EE),
      income: this.toDecimalString(row.GG),
      expense: this.toDecimalString(row.HH),
      balanceAfter: this.toDecimalString(row.FF),
    };
  }

  private mapEgameRecordRow(userId: string, row: Record<string, unknown>): {
    userId: string;
    provider: string;
    orderNo: string;
    platformCode: string;
    gameCode: string;
    betTime: Date;
    gameType: string;
    betAmount: string;
    winLoss: string;
    validAmount: string;
  } | null {
    const orderNo = this.toSafeString(row.AA);
    const betTime = this.parseApiGwDate(row.DD);
    if (!orderNo || !betTime) {
      return null;
    }

    return {
      userId,
      provider: 'calibet',
      orderNo,
      platformCode: this.toSafeString(row.BB) || '-',
      gameCode: this.toSafeString(row.CC) || '-',
      betTime,
      gameType: this.toSafeString(row.EE) || '電子遊戲',
      betAmount: this.toDecimalString(row.FF),
      winLoss: this.toDecimalString(row.GG),
      validAmount: this.toDecimalString(row.HH, row.FF),
    };
  }

  private toSafeString(value: unknown): string {
    if (value == null) {
      return '';
    }
    if (typeof value === 'string') {
      return value.trim();
    }
    return String(value);
  }

  private toDecimalString(primary: unknown, fallback?: unknown): string {
    const raw = this.toSafeString(primary) || this.toSafeString(fallback);
    const numeric = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(numeric)) {
      return '0.00';
    }
    return numeric.toFixed(2);
  }

  private parseApiGwDate(value: unknown): Date | null {
    const text = this.toSafeString(value);
    if (!text) {
      return null;
    }

    const date = new Date(text.replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return date;
  }

  private stringifyCompact(value: unknown): string {
    if (value == null) {
      return '';
    }

    if (typeof value === 'string') {
      return value;
    }

    try {
      return JSON.stringify(value).slice(0, 300);
    } catch (_error) {
      return this.toSafeString(value);
    }
  }

  private mapCreditType(typeCode: string): string {
    if (typeCode === '104') {
      return '轉入';
    }
    if (typeCode === '105') {
      return '轉出';
    }
    return typeCode || '未知';
  }

  private uniqueBy<T>(items: T[], keyResolver: (item: T) => string): T[] {
    const map = new Map<string, T>();
    for (const item of items) {
      const key = keyResolver(item);
      if (!key || map.has(key)) {
        continue;
      }
      map.set(key, item);
    }
    return [...map.values()];
  }
}
