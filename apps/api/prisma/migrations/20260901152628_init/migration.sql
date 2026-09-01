-- CreateTable
CREATE TABLE "uploads" (
    "id" UUID NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "originalName" VARCHAR(255) NOT NULL,
    "declaredMime" VARCHAR(127) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" VARCHAR(255) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "isOutlier" BOOLEAN NOT NULL,
    "qualityScore" SMALLINT NOT NULL,
    "qualityBreakdown" JSONB NOT NULL,
    "bitrateBps" INTEGER,
    "sampleRateHz" INTEGER,
    "channels" SMALLINT,
    "codec" VARCHAR(64),
    "encodingMode" VARCHAR(8),
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUploadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uploads_contentHash_key" ON "uploads"("contentHash");

-- CreateIndex
CREATE INDEX "uploads_createdAt_id_idx" ON "uploads"("createdAt" DESC, "id" DESC);
