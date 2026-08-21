import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SiteRecordKind } from '@prisma/client';
import { PrismaService } from '../prisma.service';

export interface RecordQuery {
  keyword?: string;
  recordType?: string;
  startAt?: string;
  endAt?: string;
  page?: string;
  pageSize?: string;
}

export interface RecordQueryResult<T> {
  page: number;
  pageSize: number;
  totalPages: number;
  totalItems: number;
  subtotal: Record<string, string>;
  total: Record<string, string>;
  rows: T[];
}

export interface BetRecordRow {
  id: string;
  orderNo: string;
  gameType: string;
  tableNo: string;
  roundNo: string;
  betTime: string;
  betType: string;
  betAmount: string;
  validAmount: string;
  winLoss: string;
  status: string;
  replayPath: string;
}

export interface CreditRecordRow {
  id: string;
  transactionNo: string;
  accountNo: string;
  operationTime: string;
  transactionType: string;
  balanceBefore: string;
  income: string;
  expense: string;
  balanceAfter: string;
}

export interface EGameRecordRow {
  id: string;
  orderNo: string;
  platformCode: string;
  gameCode: string;
  betTime: string;
  gameType: string;
  betAmount: string;
  winLoss: string;
  validAmount: string;
}

@Injectable()
export class RecordsService {
  public constructor(private readonly prismaService: PrismaService) {}

  public async getBetRecords(userId: string, query: RecordQuery = {}): Promise<RecordQueryResult<BetRecordRow>> {
    await this.cleanupLegacySeedData(userId);

    const records = await this.prismaService.siteBetRecord.findMany({
      where: { userId },
      orderBy: { betTime: 'desc' },
    });
    const adjustments = await this.getAdjustmentMap(SiteRecordKind.BET, records.map((record) => record.id));

    return this.buildResult({
      rows: records.map((record) => this.applyAdjustment({
        id: record.id,
        orderNo: record.orderNo,
        gameType: record.gameType,
        tableNo: record.tableNo,
        roundNo: record.roundNo,
        betTime: this.formatDate(record.betTime),
        betType: record.betType,
        betAmount: record.betAmount.toFixed(2),
        validAmount: record.validAmount.toFixed(2),
        winLoss: record.winLoss.toFixed(2),
        status: record.status,
        replayPath: record.replayPath || '',
      }, adjustments.get(record.id))),
      query,
      timeKey: 'betTime',
      typeKey: 'gameType',
      sumKeys: ['betAmount', 'validAmount', 'winLoss'],
    });
  }

  public async getCreditRecords(userId: string, query: RecordQuery = {}): Promise<RecordQueryResult<CreditRecordRow>> {
    await this.cleanupLegacySeedData(userId);

    const records = await this.prismaService.siteCreditRecord.findMany({
      where: { userId },
      orderBy: { operationTime: 'desc' },
    });
    const adjustments = await this.getAdjustmentMap(SiteRecordKind.CREDIT, records.map((record) => record.id));

    return this.buildResult({
      rows: records.map((record) => this.applyAdjustment({
        id: record.id,
        transactionNo: record.transactionNo,
        accountNo: record.accountNo,
        operationTime: this.formatDate(record.operationTime),
        transactionType: record.transactionType,
        balanceBefore: record.balanceBefore.toFixed(2),
        income: record.income.toFixed(2),
        expense: record.expense.toFixed(2),
        balanceAfter: record.balanceAfter.toFixed(2),
      }, adjustments.get(record.id))),
      query,
      timeKey: 'operationTime',
      typeKey: 'transactionType',
      sumKeys: ['income', 'expense'],
    });
  }

  public async getEGameRecords(userId: string, query: RecordQuery = {}): Promise<RecordQueryResult<EGameRecordRow>> {
    await this.cleanupLegacySeedData(userId);

    const records = await this.prismaService.siteEGameRecord.findMany({
      where: { userId },
      orderBy: { betTime: 'desc' },
    });
    const adjustments = await this.getAdjustmentMap(SiteRecordKind.EGAME, records.map((record) => record.id));

    return this.buildResult({
      rows: records.map((record) => this.applyAdjustment({
        id: record.id,
        orderNo: record.orderNo,
        platformCode: record.platformCode,
        gameCode: record.gameCode,
        betTime: this.formatDate(record.betTime),
        gameType: record.gameType,
        betAmount: record.betAmount.toFixed(2),
        winLoss: record.winLoss.toFixed(2),
        validAmount: record.validAmount.toFixed(2),
      }, adjustments.get(record.id))),
      query,
      timeKey: 'betTime',
      typeKey: 'gameType',
      sumKeys: ['betAmount', 'winLoss', 'validAmount'],
    });
  }

  public async createAdjustment(options: {
    adjustedByUserId: string;
    recordKind: SiteRecordKind;
    recordId: string;
    reason: string;
    nextValue: Record<string, string>;
    changeNote?: string;
  }): Promise<{ id: string; versionNo: number; recordKind: SiteRecordKind; recordId: string }> {
    await this.assertRecordExists(options.recordKind, options.recordId);

    const nextValue = JSON.parse(JSON.stringify(options.nextValue)) as Prisma.InputJsonObject;
    const existing = await this.prismaService.siteRecordAdjustment.findUnique({
      where: {
        recordKind_recordId: {
          recordKind: options.recordKind,
          recordId: options.recordId,
        },
      },
      include: {
        versions: {
          orderBy: { versionNo: 'desc' },
          take: 1,
        },
      },
    });

    if (!existing) {
      const adjustment = await this.prismaService.siteRecordAdjustment.create({
        data: {
          recordKind: options.recordKind,
          recordId: options.recordId,
          adjustedByUserId: options.adjustedByUserId,
          reason: options.reason,
          currentValue: nextValue,
          versions: {
            create: {
              editedByUserId: options.adjustedByUserId,
              versionNo: 1,
              previousValue: {},
              nextValue,
              changeNote: options.changeNote,
            },
          },
        },
        select: { id: true },
      });

      return {
        id: adjustment.id,
        versionNo: 1,
        recordKind: options.recordKind,
        recordId: options.recordId,
      };
    }

    const versionNo = (existing.versions[0]?.versionNo || 0) + 1;
    const previousValue = JSON.parse(JSON.stringify(existing.currentValue)) as Prisma.InputJsonObject;
    const adjustment = await this.prismaService.siteRecordAdjustment.update({
      where: { id: existing.id },
      data: {
        adjustedByUserId: options.adjustedByUserId,
        reason: options.reason,
        currentValue: nextValue,
        versions: {
          create: {
            editedByUserId: options.adjustedByUserId,
            versionNo,
            previousValue,
            nextValue,
            changeNote: options.changeNote,
          },
        },
      },
      select: { id: true },
    });

    return {
      id: adjustment.id,
      versionNo,
      recordKind: options.recordKind,
      recordId: options.recordId,
    };
  }

  private buildResult<T extends Record<string, string>>(options: {
    rows: T[];
    query: RecordQuery;
    timeKey: keyof T;
    typeKey: keyof T;
    sumKeys: Array<keyof T>;
  }): RecordQueryResult<T> {
    const pageSize = this.toPositiveInt(options.query.pageSize, 10);
    const page = this.toPositiveInt(options.query.page, 1);
    const keyword = options.query.keyword?.trim().toLowerCase();
    const recordType = options.query.recordType?.trim();
    const startAt = this.parseRecordTime(options.query.startAt);
    const endAt = this.parseRecordTime(options.query.endAt);

    const filteredRows = options.rows.filter((row) => {
      if (keyword && !Object.values(row).some((value) => value.toLowerCase().includes(keyword))) {
        return false;
      }

      if (recordType && recordType !== '全部' && row[options.typeKey] !== recordType) {
        return false;
      }

      const rowTime = this.parseRecordTime(row[options.timeKey]);
      if (startAt && rowTime && rowTime < startAt) {
        return false;
      }
      if (endAt && rowTime && rowTime > endAt) {
        return false;
      }

      return true;
    });

    const totalItems = filteredRows.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * pageSize;
    const pageRows = filteredRows.slice(start, start + pageSize);

    return {
      page: currentPage,
      pageSize,
      totalPages,
      totalItems,
      subtotal: this.sumRows(pageRows, options.sumKeys),
      total: this.sumRows(filteredRows, options.sumKeys),
      rows: pageRows,
    };
  }

  private sumRows<T extends Record<string, string>>(rows: T[], keys: Array<keyof T>): Record<string, string> {
    return Object.fromEntries(
      keys.map((key) => {
        const total = rows.reduce((sum, row) => sum + Number(row[key] || 0), 0);
        return [String(key), total.toFixed(2)];
      }),
    );
  }

  private toPositiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return fallback;
    }
    return parsed;
  }

  private parseRecordTime(value: string | undefined): Date | null {
    if (!value) {
      return null;
    }

    const date = new Date(value.replace(' ', 'T'));
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date;
  }

  private async cleanupLegacySeedData(userId: string): Promise<void> {
    const legacyBetOrderNos = ['5247608296117794', '5247607930566342'];
    const legacyCreditNos = ['1787076259057136756', '1787076257290179684', '1787076250208962317'];
    const legacyEgameOrderNos = ['AL003_161375023_AL003000105386178707625680', 'AB-SLOT-003-23mzf-30001913'];

    const [betCount, creditCount, egameCount] = await this.prismaService.$transaction([
      this.prismaService.siteBetRecord.count({ where: { userId } }),
      this.prismaService.siteCreditRecord.count({ where: { userId } }),
      this.prismaService.siteEGameRecord.count({ where: { userId } }),
    ]);

    const operations: Array<Prisma.PrismaPromise<unknown>> = [];
    if (betCount > 0 && betCount <= legacyBetOrderNos.length) {
      operations.push(this.prismaService.siteBetRecord.deleteMany({
        where: {
          userId,
          orderNo: { in: legacyBetOrderNos },
        },
      }));
    }

    if (creditCount > 0 && creditCount <= legacyCreditNos.length) {
      operations.push(this.prismaService.siteCreditRecord.deleteMany({
        where: {
          userId,
          transactionNo: { in: legacyCreditNos },
        },
      }));
    }

    if (egameCount > 0 && egameCount <= legacyEgameOrderNos.length) {
      operations.push(this.prismaService.siteEGameRecord.deleteMany({
        where: {
          userId,
          orderNo: { in: legacyEgameOrderNos },
        },
      }));
    }

    if (operations.length > 0) {
      await this.prismaService.$transaction(operations);
    }
  }

  private async getAdjustmentMap(
    recordKind: SiteRecordKind,
    recordIds: string[],
  ): Promise<Map<string, Record<string, string>>> {
    if (recordIds.length === 0) {
      return new Map();
    }

    const adjustments = await this.prismaService.siteRecordAdjustment.findMany({
      where: {
        recordKind,
        recordId: { in: recordIds },
      },
      select: {
        recordId: true,
        currentValue: true,
      },
    });

    return new Map(
      adjustments.map((adjustment) => [
        adjustment.recordId,
        this.jsonToStringRecord(adjustment.currentValue),
      ]),
    );
  }

  private applyAdjustment<T extends Record<string, string>>(row: T, adjustment: Record<string, string> | undefined): T {
    if (!adjustment) {
      return row;
    }
    return { ...row, ...adjustment };
  }

  private async assertRecordExists(recordKind: SiteRecordKind, recordId: string): Promise<void> {
    const exists = await this.findRecordOwner(recordKind, recordId);
    if (!exists) {
      throw new NotFoundException('SITE_RECORD_NOT_FOUND');
    }
  }

  private async findRecordOwner(recordKind: SiteRecordKind, recordId: string): Promise<string | null> {
    if (recordKind === SiteRecordKind.BET) {
      const record = await this.prismaService.siteBetRecord.findUnique({ where: { id: recordId }, select: { userId: true } });
      return record?.userId || null;
    }
    if (recordKind === SiteRecordKind.CREDIT) {
      const record = await this.prismaService.siteCreditRecord.findUnique({ where: { id: recordId }, select: { userId: true } });
      return record?.userId || null;
    }
    const record = await this.prismaService.siteEGameRecord.findUnique({ where: { id: recordId }, select: { userId: true } });
    return record?.userId || null;
  }

  private jsonToStringRecord(value: Prisma.JsonValue): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, nextValue]) => [key, String(nextValue)]),
    );
  }

  private formatDate(value: Date): string {
    const pad = (part: number) => String(part).padStart(2, '0');
    return [
      value.getFullYear(),
      pad(value.getMonth() + 1),
      pad(value.getDate()),
    ].join('-') + ` ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }

}
