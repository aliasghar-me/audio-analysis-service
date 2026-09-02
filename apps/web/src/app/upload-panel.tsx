'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  formatBytes,
  formatDate,
  listUploads,
  uploadFile,
  type UploadResult,
  type UploadView,
} from '@/lib/api';

const BREAKDOWN_LABELS: Record<string, string> = {
  bitrate: 'Bitrate',
  sampleRate: 'Sample rate',
  channels: 'Channels',
  encodingMode: 'Encoding mode',
  consistency: 'Size consistency',
};

export default function UploadPanel() {
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [history, setHistory] = useState<UploadView[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const refreshHistory = useCallback(async () => {
    try {
      setHistory((await listUploads()).items);
    } catch {
      // The history list is a convenience; a failure here should not replace
      // the analysis the user just asked for with an error banner.
    }
  }, []);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  const submit = useCallback(
    async (file: File) => {
      setPending(true);
      setError(null);
      try {
        setResult(await uploadFile(file));
        await refreshHistory();
      } catch (caught) {
        setResult(null);
        setError(
          caught instanceof ApiError ? caught : new ApiError('NETWORK', 'Could not reach the API.'),
        );
      } finally {
        setPending(false);
      }
    },
    [refreshHistory],
  );

  return (
    <>
      {/* A button, not a div: it has to be reachable and operable by keyboard,
          and it needs a real focus ring. */}
      <button
        type="button"
        className={`dropzone${dragging ? ' over' : ''}`}
        disabled={pending}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (file) void submit(file);
        }}
      >
        <span className="cta">
          {pending ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Analysing…
            </>
          ) : (
            'Drop an MP3 here, or click to choose one'
          )}
        </span>
        <span className="hint">
          Up to 50 MB. The file is identified by its contents, not its name.
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="audio/mpeg,.mp3"
        className="sr-only"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void submit(file);
          event.target.value = '';
        }}
      />

      {/* Announced to screen readers as soon as the answer arrives, rather than
          only being visible. */}
      <div aria-live="polite">
        {error && (
          <div className="banner error" role="alert">
            {error.message} <code>{error.code}</code>
          </div>
        )}

        {result && (
          <>
            {result.duplicate && (
              <div className="banner duplicate">
                {result.submittedFilename === result.upload.filename ? (
                  <>
                    You already uploaded <strong>{result.upload.filename}</strong>, first seen{' '}
                    {formatDate(result.upload.createdAt)}.
                  </>
                ) : (
                  <>
                    {/* The whole point of the feature, in one sentence: two
                        different names, one set of bytes, one stored file. */}
                    You uploaded <strong>{result.submittedFilename}</strong> — these exact bytes are
                    already on record as <strong>{result.upload.filename}</strong>, first seen{' '}
                    {formatDate(result.upload.createdAt)}.
                  </>
                )}{' '}
                Nothing was stored a second time; this file has now been submitted{' '}
                {result.upload.duplicateCount + 1} times.
              </div>
            )}

            <div className="result">
              <h2>{result.upload.filename}</h2>
              <div className="sub">
                {formatBytes(result.upload.sizeBytes)} · {result.analysis.format.codec ?? 'MP3'} ·{' '}
                <span title={result.upload.contentHash}>
                  sha256 {result.upload.contentHash.slice(0, 12)}…
                </span>
              </div>

              <div className="stats">
                <div className="stat">
                  <div className="label">Duration</div>
                  <div className="value">
                    {result.analysis.duration.formatted}
                    <span
                      className={`pill ${result.analysis.duration.isOutlier ? 'outlier' : 'normal'}`}
                    >
                      {result.analysis.duration.isOutlier ? 'outlier' : 'typical'}
                    </span>
                  </div>
                </div>

                <div className="stat">
                  <div className="label">Quality (encoding)</div>
                  <div className="value">
                    {result.analysis.quality.score} / {result.analysis.quality.max}
                  </div>
                  <div
                    className="meter"
                    role="meter"
                    aria-valuenow={result.analysis.quality.score}
                    aria-valuemin={1}
                    aria-valuemax={result.analysis.quality.max}
                    aria-label="Encoding quality score"
                  >
                    <i
                      style={{
                        width: `${(result.analysis.quality.score / result.analysis.quality.max) * 100}%`,
                      }}
                    />
                  </div>
                </div>

                <div className="stat">
                  <div className="label">Bitrate</div>
                  <div className="value">
                    {result.analysis.format.bitrateBps
                      ? `${Math.round(result.analysis.format.bitrateBps / 1000)}k`
                      : '—'}
                  </div>
                </div>

                <div className="stat">
                  <div className="label">Sample rate</div>
                  <div className="value">
                    {result.analysis.format.sampleRateHz
                      ? `${(result.analysis.format.sampleRateHz / 1000).toFixed(1)} kHz`
                      : '—'}
                  </div>
                </div>
              </div>

              {/* Collapsed by default: the score is the answer, the arithmetic
                  behind it is for anyone who doubts the score. */}
              <details className="breakdown">
                <summary>How this score was reached</summary>
                <table className="breakdown-table">
                  <tbody>
                    {Object.entries(BREAKDOWN_LABELS).map(([key, label]) => (
                      <tr key={key}>
                        <td>{label}</td>
                        <td>
                          {String(
                            result.analysis.quality.breakdown[
                              key as keyof typeof result.analysis.quality.breakdown
                            ],
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td>Total</td>
                      <td>{result.analysis.quality.breakdown.total}</td>
                    </tr>
                  </tbody>
                </table>
              </details>

              <audio controls preload="metadata" src={`/api/uploads/${result.upload.id}/file`} />
            </div>
          </>
        )}
      </div>

      <section className="history">
        <h3>Recent uploads</h3>
        {history.length === 0 ? (
          <p className="muted">Nothing uploaded yet.</p>
        ) : (
          <ul className="history-list">
            {history.map(({ upload, analysis }) => (
              <li key={upload.id}>
                <span className="name">{upload.filename}</span>
                <span className="meta">
                  {analysis.duration.formatted} · {analysis.quality.score}/10
                  {upload.duplicateCount > 0 && ` · ${upload.duplicateCount}× re-uploaded`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
