import { useEffect, useRef, useState } from 'react';

type Props = {
  onSubmit: (input: string) => void;
};

export function AnswerInput({ onSubmit }: Props) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // 早押し直後にそのまま入力できるようフォーカスを当てる
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (value.trim() === '') return;
    onSubmit(value);
  };

  return (
    <form className="answer-input" onSubmit={handleSubmit}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="答えを入力"
        aria-label="答え"
        autoComplete="off"
      />
      <button type="submit" disabled={value.trim() === ''}>
        回答
      </button>
    </form>
  );
}
