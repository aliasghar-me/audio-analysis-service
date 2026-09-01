'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  formatBytes,
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
      <div
        className={`dropzone${dragging ? ' over' : ''}`}
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
        <strong>{pending ? 'Analysing…' : 'Drop an MP3 here, or click to choose one'}</strong>
        <span>Up to 50 MB. The file is identified by its contents, not its name.</span>
        <input
          ref={inputRef}
          type="file"
          accept="audio/mpeg,.mp3"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void submit(file);
            event.target.value = '';
          }}
        />
      </div>

      {error && (
        <div className="banner error">
          {error.message} <code>{error.code}</code>
        </div>
      )}

      {result && (
        <>
          {result.duplicate && (
            <div className="banner duplicate">
              Already uploaded as <strong>{result.upload.filename}</strong> on{' '}
              {new Date(result.upload.createdAt).toLocaleDateString()}. Nothing was stored a second
              time — this file has now been submitted {result.upload.duplicateCount + 1} times.
            </div>
          )}

          <div className="panel result">
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
                <div className="meter">
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

            <table className="breakdown">
              <thead>
                <tr>
                  <th>Score component</th>
                  <th />
                </tr>
              </thead>
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

            <audio controls src={`/api/uploads/${result.upload.id}/file`} />
          </div>
        </>
      )}

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
