import { useState } from 'react';

interface CodeDisplayProps {
  code: string;
}

export function CodeDisplay({ code }: CodeDisplayProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy code:', error);
    }
  };

  return (
    <div className="flex flex-col items-center gap-6">
      <div
        className="text-5xl font-bold tracking-[0.3em] font-mono text-neutral-900 dark:text-white"
        aria-label="Transfer code"
      >
        {code}
      </div>
      <button
        onClick={handleCopy}
        className="px-6 py-3 bg-primary-500 text-white rounded-xl font-medium
                   hover:bg-primary-600 active:bg-primary-700
                   transition-all duration-200 transform hover:scale-105
                   focus:outline-none focus:ring-2 focus:ring-primary-300
                   dark:bg-primary-600 dark:hover:bg-primary-500"
        aria-label="Copy code"
      >
        {copied ? 'Copied!' : 'Copy Code'}
      </button>
    </div>
  );
}
