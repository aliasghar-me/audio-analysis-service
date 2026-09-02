import UploadPanel from './upload-panel';

/** Seven hexagons, coral, echoing the brand mark. Decorative only. */
function Mark() {
  const hexes: Array<[number, number, number]> = [
    [12, 4, 1],
    [21, 9, 0.55],
    [21, 19, 0.85],
    [12, 24, 0.4],
    [3, 19, 0.7],
    [3, 9, 0.3],
    [12, 14, 1],
  ];
  return (
    <svg width="26" height="30" viewBox="0 0 26 30" aria-hidden="true" focusable="false">
      {hexes.map(([x, y, opacity], i) => (
        <polygon
          key={i}
          points="4,0 8,2.3 8,6.9 4,9.2 0,6.9 0,2.3"
          transform={`translate(${x - 4} ${y - 4.6})`}
          fill="#e8663c"
          opacity={opacity}
        />
      ))}
    </svg>
  );
}

export default function Page() {
  return (
    <main className="shell">
      <div className="topbar">
        <span className="wordmark">
          <Mark />
          Audio Analysis
        </span>
        <span className="health">Service online</span>
      </div>

      <section className="card">
        <div className="hero">
          <h1>
            Know what an MP3 <span className="marked">actually is</span>
          </h1>
          <p>
            Upload a file to get its duration, an encoding-quality score out of ten, and whether
            these exact bytes have been stored before. Upload the same file under a different name
            to see duplicate detection work — the name is never what identifies it.
          </p>
        </div>
        <UploadPanel />
      </section>
    </main>
  );
}
