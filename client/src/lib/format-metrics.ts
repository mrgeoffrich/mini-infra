export function formatCpu(value: number): string {
  if (value < 0.01) return `${(value * 1000).toFixed(1)}m`;
  return `${(value * 100).toFixed(1)}%`;
}

export function formatBytes(value: number): string {
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1
  );
  return `${(value / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function formatBytesPerSec(value: number): string {
  return `${formatBytes(value)}/s`;
}
