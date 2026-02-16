import Image from "next/image";

interface ClawIconProps {
  size?: number;
  className?: string;
  animated?: boolean;
}

export default function ClawIcon({ size = 48, className = "", animated = true }: ClawIconProps) {
  return (
    <div className={`${animated ? "claw-icon" : ""} ${className}`} style={{ width: size, height: size }}>
      <Image
        src="/clawbox-icon.png"
        alt="ClawBox"
        width={size}
        height={size}
        className="w-full h-full object-contain"
        priority
      />
    </div>
  );
}
