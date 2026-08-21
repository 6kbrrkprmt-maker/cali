-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'OPERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "ExternalSessionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'FAILED', 'LOGGED_OUT');

-- CreateEnum
CREATE TYPE "BridgeSessionStatus" AS ENUM ('PENDING', 'ACTIVE', 'CLOSED', 'FAILED');

-- CreateEnum
CREATE TYPE "SignalKind" AS ENUM ('OFFER', 'ANSWER', 'ICE_CANDIDATE');

-- CreateEnum
CREATE TYPE "SignalFrom" AS ENUM ('CLIENT', 'WORKER', 'SYSTEM');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalAccount" TEXT NOT NULL,
    "sessionTokenHash" TEXT NOT NULL,
    "status" "ExternalSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BridgeSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalSessionId" TEXT,
    "workerSessionId" TEXT,
    "viewTokenHash" TEXT NOT NULL,
    "status" "BridgeSessionStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BridgeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BridgeSignal" (
    "id" SERIAL NOT NULL,
    "bridgeSessionId" TEXT NOT NULL,
    "from" "SignalFrom" NOT NULL,
    "kind" "SignalKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BridgeSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawActionLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "sourceTraceId" TEXT,
    "actionType" TEXT NOT NULL,
    "actionPayload" JSONB NOT NULL,
    "sourceCreatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawActionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdjustmentLog" (
    "id" TEXT NOT NULL,
    "rawActionLogId" TEXT NOT NULL,
    "adjustedByUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "currentValue" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdjustmentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdjustmentVersion" (
    "id" TEXT NOT NULL,
    "adjustmentLogId" TEXT NOT NULL,
    "editedByUserId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "previousValue" JSONB NOT NULL,
    "nextValue" JSONB NOT NULL,
    "changeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdjustmentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_account_key" ON "User"("account");

-- CreateIndex
CREATE INDEX "ExternalSession_userId_provider_idx" ON "ExternalSession"("userId", "provider");

-- CreateIndex
CREATE INDEX "ExternalSession_status_idx" ON "ExternalSession"("status");

-- CreateIndex
CREATE INDEX "BridgeSession_userId_createdAt_idx" ON "BridgeSession"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BridgeSession_status_expiresAt_idx" ON "BridgeSession"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "BridgeSignal_bridgeSessionId_id_idx" ON "BridgeSignal"("bridgeSessionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RawActionLog_sourceTraceId_key" ON "RawActionLog"("sourceTraceId");

-- CreateIndex
CREATE INDEX "RawActionLog_userId_sourceCreatedAt_idx" ON "RawActionLog"("userId", "sourceCreatedAt");

-- CreateIndex
CREATE INDEX "RawActionLog_provider_sourceCreatedAt_idx" ON "RawActionLog"("provider", "sourceCreatedAt");

-- CreateIndex
CREATE INDEX "AdjustmentLog_rawActionLogId_idx" ON "AdjustmentLog"("rawActionLogId");

-- CreateIndex
CREATE INDEX "AdjustmentLog_adjustedByUserId_createdAt_idx" ON "AdjustmentLog"("adjustedByUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AdjustmentVersion_editedByUserId_createdAt_idx" ON "AdjustmentVersion"("editedByUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdjustmentVersion_adjustmentLogId_versionNo_key" ON "AdjustmentVersion"("adjustmentLogId", "versionNo");

-- AddForeignKey
ALTER TABLE "ExternalSession" ADD CONSTRAINT "ExternalSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BridgeSession" ADD CONSTRAINT "BridgeSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BridgeSession" ADD CONSTRAINT "BridgeSession_externalSessionId_fkey" FOREIGN KEY ("externalSessionId") REFERENCES "ExternalSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BridgeSignal" ADD CONSTRAINT "BridgeSignal_bridgeSessionId_fkey" FOREIGN KEY ("bridgeSessionId") REFERENCES "BridgeSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawActionLog" ADD CONSTRAINT "RawActionLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdjustmentLog" ADD CONSTRAINT "AdjustmentLog_rawActionLogId_fkey" FOREIGN KEY ("rawActionLogId") REFERENCES "RawActionLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdjustmentLog" ADD CONSTRAINT "AdjustmentLog_adjustedByUserId_fkey" FOREIGN KEY ("adjustedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdjustmentVersion" ADD CONSTRAINT "AdjustmentVersion_adjustmentLogId_fkey" FOREIGN KEY ("adjustmentLogId") REFERENCES "AdjustmentLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdjustmentVersion" ADD CONSTRAINT "AdjustmentVersion_editedByUserId_fkey" FOREIGN KEY ("editedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
