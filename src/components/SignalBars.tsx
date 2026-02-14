interface SignalBarsProps {
  level: number;
}

export default function SignalBars({ level }: SignalBarsProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0" role="img" aria-label={`Signal strength: ${level} of 4`}>
      {[0, 1, 2, 3].map((i) => {
        const h = 4 + i * 3;
        const y = 16 - h;
        return (
          <rect
            key={i}
            x={i * 4}
            y={y}
            width={3}
            height={h}
            rx={1}
            fill={i < level ? "#f97316" : "#374151"}
          />
        );
      })}
    </svg>
  );
}
