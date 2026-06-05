interface StatusMessageProps {
  type: "success" | "error" | "info";
  message: string;
}

const STYLES: Record<StatusMessageProps["type"], string> = {
  success: "bg-[#00e5cc]/10 text-[#00e5cc] border border-green-500/20",
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
