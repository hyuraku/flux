import { useRef, useState, KeyboardEvent, ClipboardEvent, ChangeEvent } from 'react';

interface CodeInputProps {
  onCodeComplete: (code: string) => void;
}

export function CodeInput({ onCodeComplete }: CodeInputProps) {
  const [digits, setDigits] = useState<string[]>(['', '', '', '']);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const handleChange = (index: number, value: string) => {
    // 数字のみ許可
    if (value && !/^\d$/.test(value)) {
      return;
    }

    const newDigits = [...digits];
    newDigits[index] = value;
    setDigits(newDigits);

    // 次のフィールドに自動フォーカス
    if (value && index < 3) {
      inputRefs.current[index + 1]?.focus();
    }

    // 4桁すべて入力されたらコールバック
    if (newDigits.every((d) => d !== '')) {
      onCodeComplete(newDigits.join(''));
    }
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasteData = e.clipboardData.getData('text');

    // 4桁の数字のみ許可
    if (!/^\d{4}$/.test(pasteData)) {
      return;
    }

    const newDigits = pasteData.split('');
    setDigits(newDigits);

    // 最後のフィールドにフォーカス
    inputRefs.current[3]?.focus();

    // コールバック呼び出し
    onCodeComplete(pasteData);
  };

  return (
    <div className="flex gap-3 justify-center">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(el) => { inputRefs.current[index] = el; }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]"
          maxLength={1}
          value={digit}
          onChange={(e: ChangeEvent<HTMLInputElement>) => handleChange(index, e.target.value)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          onPaste={index === 0 ? handlePaste : undefined}
          aria-label={`Code digit ${index + 1}`}
          className="w-14 h-16 text-center text-3xl font-bold font-mono
                     border-2 border-neutral-300 rounded-xl
                     focus:border-primary-500 focus:ring-2 focus:ring-primary-200 focus:outline-none
                     transition-all duration-200
                     dark:bg-neutral-800 dark:border-neutral-600 dark:text-white
                     dark:focus:border-primary-400 dark:focus:ring-primary-800"
        />
      ))}
    </div>
  );
}
