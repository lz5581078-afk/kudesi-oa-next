import { useEffect, useState } from 'react';
import { durationSuffix, durationText } from './liveFormat';

function ElapsedDuration({ start }: { start: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const duration = durationText(start, now, true);
  return duration ? <> · 已播 {duration}</> : null;
}

export function SessionDuration({ start, end, live }: {
  start: string;
  end: string | null | undefined;
  live: boolean;
}) {
  if (!end && live) return <ElapsedDuration start={start}/>;
  return <>{durationSuffix(start, end)}</>;
}
