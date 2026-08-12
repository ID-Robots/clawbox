interface StatusMessageProps {
  type: "success" | "error" | "info";
  message: string;
}

const STYLES: Record<StatusMessageProps["type"], string> = {
  // Cyan is the product's "done" colour, and the fill and text always were —
  // only the border was green, so a success message was outlined in a hue it
  // used nowhere else. error and info each keep to a single hue; this now does
  // too.
  success: "bg-[#00e5cc]/10 text-[#00e5cc] border border-[#00e5cc]/20",
  error: "bg-red-500/10 text-red-400 border border-red-500/20",
  info: "bg-amber-400/10 text-amber-300 border border-amber-400/20",
};

export default function StatusMessage({ type, message }: StatusMessageProps) {
  return (
    <output
      aria-live={type === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      className={`mt-3 px-3.5 py-2.5 rounded-lg text-xs leading-relaxed block ${STYLES[type]}`}
    >
      {message}
    </output>
  );
}
