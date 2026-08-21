import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma.module';
import { BridgeController } from './bridge.controller';
import { BridgeService } from './bridge.service';

@Module({
  imports: [ConfigModule, PrismaModule, JwtModule],
  controllers: [BridgeController],
  providers: [BridgeService],
  exports: [BridgeService],
})
export class BridgeModule {}
