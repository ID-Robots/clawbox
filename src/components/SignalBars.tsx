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
            // Roles, not hexes: the inactive bar used to be a navy-grey that
            // read as a smudge on a Hermes ground. `--set-outline-variant` is
            // the divider weight, which is exactly what an unlit bar is.
            fill={i < level ? "var(--set-primary)" : "var(--set-outline-variant)"}
          />
        );
      })}
    </svg>
  );
}
