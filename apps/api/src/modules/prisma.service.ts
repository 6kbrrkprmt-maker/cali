import { INestApplication, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private shutdownHookBound = false;

  public async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  public async enableShutdownHooks(app: INestApplication): Promise<void> {
    if (this.shutdownHookBound) {
      return;
    }

    this.shutdownHookBound = true;
    process.on('beforeExit', async () => {
      await app.close();
    });
  }
}
