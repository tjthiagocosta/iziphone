'use client';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#121212',
            color: '#f2f2f2',
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ fontSize: '4rem', marginBottom: '1rem' }}>500</h1>
            <p
              style={{
                fontSize: '1.25rem',
                marginBottom: '2rem',
                color: '#888',
              }}
            >
              Something went wrong
            </p>
            <button
              type="button"
              onClick={reset}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: '#f2f2f2',
                color: '#121212',
                border: 'none',
                borderRadius: '0.375rem',
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
