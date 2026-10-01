import { useState } from "react";

/** Monospace block with a copy button. */
export function CodeBlock({ children, label }: { children: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      {label && <span className="code-label">{label}</span>}
      <pre>{children}</pre>
      <button
        type="button"
        className="code-copy"
        onClick={() => {
          void navigator.clipboard.writeText(children);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
