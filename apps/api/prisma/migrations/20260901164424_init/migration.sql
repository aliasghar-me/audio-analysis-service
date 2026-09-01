-- CreateTable
CREATE TABLE "uploads" (
    "id" UUID NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "declared_mime" VARCHAR(127) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_path" VARCHAR(255) NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "is_outlier" BOOLEAN NOT NULL,
    "quality_score" SMALLINT NOT NULL,
    "quality_breakdown" JSONB NOT NULL,
    "bitrate_bps" INTEGER,
    "sample_rate_hz" INTEGER,
    "channels" SMALLINT,
    "codec" VARCHAR(64),
    "encoding_mode" VARCHAR(8),
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uploads_content_hash_key" ON "uploads"("content_hash");

-- CreateIndex
CREATE INDEX "uploads_created_at_id_idx" ON "uploads"("created_at" DESC, "id" DESC);
