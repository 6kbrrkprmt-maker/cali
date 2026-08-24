import { Body, Controller, Get, Post } from '@nestjs/common';
import { BaccaratService } from './baccarat.service';

@Controller('baccarat')
export class BaccaratController {
  public constructor(private readonly baccaratService: BaccaratService) {}

  @Get('status')
  public async getStatus(): ReturnType<BaccaratService['getStatus']> {
    return this.baccaratService.getStatus();
  }

  @Post('bet')
  public async placeBet(@Body() body: { side: 'player' | 'banker' | 'tie'; amount: number }): ReturnType<BaccaratService['placeBet']> {
    return this.baccaratService.placeBet(body.side, Number(body.amount));
  }

  @Post('settle')
  public async settleRound(@Body() body: { outcome: 'player' | 'banker' | 'tie' }): ReturnType<BaccaratService['settleRound']> {
    return this.baccaratService.settleRound(body.outcome);
  }

  @Post('detected-result')
  public async applyDetectedOutcome(@Body() body: {
    outcome: 'player' | 'banker' | 'tie';
    detectionKey: string;
    source?: string;
    confidence?: number;
    externalRoundId?: string;
  }): ReturnType<BaccaratService['applyDetectedOutcome']> {
    return this.baccaratService.applyDetectedOutcome(body);
  }

  @Post('reset')
  public async reset(): ReturnType<BaccaratService['reset']> {
    return this.baccaratService.reset();
  }
}
