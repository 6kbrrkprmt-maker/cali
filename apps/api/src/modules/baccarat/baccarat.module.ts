import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma.module';
import { BaccaratController } from './baccarat.controller';
import { BaccaratService } from './baccarat.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [BaccaratController],
  providers: [BaccaratService],
})
export class BaccaratModule {}
