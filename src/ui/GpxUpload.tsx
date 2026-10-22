import { UploadSimple } from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import { parseGpx, type GpxPoint } from "../gpx/pipeline";

interface GpxUploadProps {
  onLoaded: (points: GpxPoint[], fileName: string) => void;
}

export function GpxUpload({ onLoaded }: GpxUploadProps) {
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const text = await file.text();
        const points = parseGpx(text);
        if (points.length === 0) {
          setError("No track points found in this GPX file.");
          return;
        }
        onLoaded(points, file.name);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to parse GPX file.");
      }
    },
    [onLoaded],
  );

  return (
    <>
      <label className="button-ghost gpx-upload">
        <UploadSimple size={20} aria-hidden="true" />
        Choose a GPX file
        <input
          type="file"
          accept=".gpx"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
      </label>
      {error && <p className="help danger">{error}</p>}
    </>
  );
}
