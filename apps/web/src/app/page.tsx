import UploadPanel from './upload-panel';

export default function Page() {
  return (
    <main>
      <header>
        <h1>Audio Analysis Service</h1>
        <p>
          Upload an MP3 to get its duration, an encoding-quality score, and whether these exact
          bytes have been seen before. Upload the same file under a different name to see duplicate
          detection work.
        </p>
      </header>
      <UploadPanel />
    </main>
  );
}
