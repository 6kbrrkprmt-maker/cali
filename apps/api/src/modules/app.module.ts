import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { BaccaratModule } from './baccarat/baccarat.module';
import { BridgeModule } from './bridge/bridge.module';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma.module';
import { RecordsModule } from './records/records.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    AuthModule,
    BaccaratModule,
    BridgeModule,
    RecordsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
