import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma.service';

type BaccaratSide = 'player' | 'banker' | 'tie';
type BaccaratOutcome = BaccaratSide;
type BetStatus = 'PENDING' | 'WON' | 'LOST' | 'PUSH';

interface BaccaratBet {
  id: string;
  userId: string;
  roundId: string;
  side: BaccaratSide;
  amount: number;
  status: BetStatus;
  payout: number;
  createdAt: string;
  settledAt?: string;
}

interface BaccaratRound {
  id: string;
  status: 'BETTING' | 'CLOSED' | 'SETTLED';
  openedAt: string;
  outcome?: BaccaratOutcome;
  settledAt?: string;
}

@Injectable()
export class BaccaratService {
  private readonly rounds = new Map<string, BaccaratRound>();
  private readonly bets = new Map<string, BaccaratBet>();
  private readonly balances = new Map<string, number>();
  private roundSequence = 0;

  public constructor(
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
  ) {}

  public async getPublicUserId(): Promise<string> {
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

  public async getStatus(): Promise<{
    balance: number;
    round: BaccaratRound;
    bets: BaccaratBet[];
    totals: Record<BaccaratSide, number>;
  }> {
    const userId = await this.getPublicUserId();
    const round = this.getCurrentRound();
    const bets = this.getRoundBets(userId, round.id);

    return {
      balance: this.getBalance(userId),
      round,
      bets,
      totals: this.getTotals(bets),
    };
  }

  public async placeBet(side: BaccaratSide, amount: number): Promise<{
    balance: number;
    bet: BaccaratBet;
    round: BaccaratRound;
    totals: Record<BaccaratSide, number>;
  }> {
    if (!['player', 'banker', 'tie'].includes(side)) {
      throw new BadRequestException('INVALID_BACCARAT_SIDE');
    }

    if (!Number.isFinite(amount) || amount <= 0 || amount > 500000) {
      throw new BadRequestException('INVALID_BET_AMOUNT');
    }

    const userId = await this.getPublicUserId();
    const round = this.getCurrentRound();
    const balance = this.getBalance(userId);

    if (balance < amount) {
      throw new BadRequestException('INSUFFICIENT_BALANCE');
    }

    this.balances.set(userId, Number((balance - amount).toFixed(2)));

    const bet: BaccaratBet = {
      id: `bet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      roundId: round.id,
      side,
      amount: Number(amount.toFixed(2)),
      status: 'PENDING',
      payout: 0,
      createdAt: new Date().toISOString(),
    };
    this.bets.set(bet.id, bet);

    const bets = this.getRoundBets(userId, round.id);
    return {
      balance: this.getBalance(userId),
      bet,
      round,
      totals: this.getTotals(bets),
    };
  }

  public async settleRound(outcome: BaccaratOutcome): Promise<{
    balance: number;
    round: BaccaratRound;
    bets: BaccaratBet[];
    totals: Record<BaccaratSide, number>;
  }> {
    if (!['player', 'banker', 'tie'].includes(outcome)) {
      throw new BadRequestException('INVALID_BACCARAT_OUTCOME');
    }

    const userId = await this.getPublicUserId();
    const round = this.getCurrentRound();
    const settledAt = new Date().toISOString();
    const bets = this.getRoundBets(userId, round.id);
    let balance = this.getBalance(userId);

    for (const bet of bets) {
      const payout = this.calculateReturn(bet.side, bet.amount, outcome);
      bet.payout = payout;
      bet.status = payout > 0 ? 'WON' : 'LOST';
      bet.settledAt = settledAt;
      balance = Number((balance + payout).toFixed(2));
    }

    round.status = 'SETTLED';
    round.outcome = outcome;
    round.settledAt = settledAt;
    this.balances.set(userId, balance);

    const nextRound = this.createRound();
    this.rounds.set(nextRound.id, nextRound);

    return {
      balance,
      round,
      bets,
      totals: this.getTotals(bets),
    };
  }

  public async reset(): Promise<{ balance: number; round: BaccaratRound }> {
    const userId = await this.getPublicUserId();
    this.balances.set(userId, 100000);
    for (const bet of Array.from(this.bets.values())) {
      if (bet.userId === userId) {
        this.bets.delete(bet.id);
      }
    }
    this.rounds.clear();
    const round = this.createRound();
    this.rounds.set(round.id, round);

    return { balance: this.getBalance(userId), round };
  }

  private calculateReturn(side: BaccaratSide, amount: number, outcome: BaccaratOutcome): number {
    if (side !== outcome) {
      return 0;
    }

    if (side === 'player') {
      return Number((amount * 2).toFixed(2));
    }

    if (side === 'banker') {
      return Number((amount * 1.95).toFixed(2));
    }

    return Number((amount * 9).toFixed(2));
  }

  private getBalance(userId: string): number {
    if (!this.balances.has(userId)) {
      this.balances.set(userId, 100000);
    }
    return this.balances.get(userId) || 0;
  }

  private getCurrentRound(): BaccaratRound {
    const active = Array.from(this.rounds.values()).find((round) => round.status === 'BETTING');
    if (active) {
      return active;
    }

    const round = this.createRound();
    this.rounds.set(round.id, round);
    return round;
  }

  private createRound(): BaccaratRound {
    this.roundSequence += 1;
    return {
      id: `B${Date.now()}${String(this.roundSequence).padStart(3, '0')}`,
      status: 'BETTING',
      openedAt: new Date().toISOString(),
    };
  }

  private getRoundBets(userId: string, roundId: string): BaccaratBet[] {
    return Array.from(this.bets.values()).filter((bet) => bet.userId === userId && bet.roundId === roundId);
  }

  private getTotals(bets: BaccaratBet[]): Record<BaccaratSide, number> {
    return bets.reduce<Record<BaccaratSide, number>>(
      (totals, bet) => {
        totals[bet.side] = Number((totals[bet.side] + bet.amount).toFixed(2));
        return totals;
      },
      { player: 0, banker: 0, tie: 0 },
    );
  }
}
