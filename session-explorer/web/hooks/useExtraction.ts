import { useState, useCallback, useRef } from "react";

export function useExtraction(onComplete?: () => void, endpoint = "/api/extract-insights") {
  const [extracting, setExtracting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startExtraction = useCallback(() => {
    setExtracting(true);
    fetch(endpoint, { method: "POST" })
      .then(() => {
        pollRef.current = setInterval(() => {
          fetch(`${endpoint}/status`)
            .then((r) => r.json())
            .then((d) => {
              if (!d.running) {
                if (pollRef.current) clearInterval(pollRef.current);
                pollRef.current = null;
                setExtracting(false);
                onComplete?.();
              }
            })
            .catch(() => {
              if (pollRef.current) clearInterval(pollRef.current);
              pollRef.current = null;
              setExtracting(false);
            });
        }, 2000);
      })
      .catch(() => setExtracting(false));
  }, [onComplete, endpoint]);

  return { extracting, startExtraction };
}
